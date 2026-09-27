'use strict';

// function_length_review / function_length_fix -- first member of the "maintenance"
// task-source family (2026-08-23, Grimmethy: "Let's start with the modular approach with
// the intent to further separate it into a fully separate npm later"). That extraction
// happened 2026-08-27: this module now lives in the out-of-tree agent-manager-hygiene
// plugin. Same two-stage shape observability_review/observability_fix proved out: a
// deterministic scanner (function-length-scan.js, staying in agent-manager core) flags
// candidates, this review stage judges genuine vs. false positive and writes a vetted
// candidate, and a generic consumer (agent-manager's nextCandidateFulfillmentTask, reused
// as-is) turns a vetted candidate into a real decomposition diff.
//
// The only cross-package dependencies are the already-PUBLIC extension points, now imported
// from the agent-manager package: task-source-registry.js's registerTaskSource/
// updateTaskSource, task-sources.js's nextCandidateFulfillmentTask/taskIdExistsInQueue
// (+ taskPriority) injected via register(deps), candidate-docs.js's
// applyArchDiscoveryCandidates, prompts.js's groupBJsonInstructions/formatFileContents.
// slugifyForId/readIfExists are tiny and duplicated locally rather than reached for.

const { hygieneFamily } = require('./hygiene-family.js');
const fs = require('fs');
const path = require('path');
const { scanProject } = require('./function-length-scan.js');
const { reconcileFlags } = require('./flag-store.js');
const { windowFromContent } = require('./scan-utils.js');
const { isSuppressed, recordFalsePositiveIfVerdict, recordInconclusiveReview } = require('./suppression-store.js');
const { buildFlagInventory } = require('./flag-inventory.js');
const { runGroundingCheck } = require('./function-length-grounding-check.js');

// Judging a function's real shape needs its WHOLE body, not just its start line. A fixed
// +30-line window (the old value) cut off mid-body on any function meaningfully over the
// 100-line threshold, and the reviewer then hallucinated everything past the cutoff --
// 2026-09-02, two blocked function_length_review tasks on src/local-draft.js root-caused
// to exactly this ("the draft contradicts the grounding source" when the grounding source
// was 30 of 143 lines). SNIPPET_BEFORE lines of lead-in for context; the whole function
// body after that, capped at SNIPPET_MAX_LINES so a pathological 900-line function can't
// blow the review prompt (with an explicit truncation marker when the cap bites, so the
// reviewer knows it is not seeing all of it). Used verbatim as promptContext.snippet AND
// the suppression key -- both sides call functionSnippet, so they cannot drift.
const SNIPPET_BEFORE = 2;
const SNIPPET_AFTER = 30; // legacy fallback window only (flags recorded before the scanner emitted lengthLines)
const SNIPPET_MAX_LINES = 200;

// (content, 1-based declaration line, measured body span) -> the flagged function's full
// text with a couple of lines of lead-in. Falls back to the old fixed window when the
// scanner did not report a span (an old flags-file entry that predates lengthLines).
function functionSnippet(content, line, lengthLines) {
  if (!Number.isFinite(lengthLines) || lengthLines <= 0) {
    return windowFromContent(content, line, SNIPPET_BEFORE, SNIPPET_AFTER);
  }
  const lines = String(content == null ? '' : content).split('\n');
  const start = Math.max(0, (line || 1) - 1 - SNIPPET_BEFORE);
  const fnEndExclusive = (line || 1) - 1 + lengthLines;
  const cappedEndExclusive = Math.min(lines.length, start + SNIPPET_BEFORE + SNIPPET_MAX_LINES);
  const end = Math.min(fnEndExclusive, cappedEndExclusive);
  const body = lines.slice(start, end).join('\n');
  if (end < fnEndExclusive) {
    return `${body}\n// ... [truncated for review: this function continues for ${fnEndExclusive - end} more line(s) not shown]`;
  }
  return body;
}

function findingIsSuppressed(pipelineDir, repoRoot, finding) {
  if (!finding.file) return false;
  const content = readIfExists(path.join(repoRoot, finding.file));
  if (!content) return false;
  return isSuppressed(pipelineDir, finding.rule, functionSnippet(content, finding.line, finding.lengthLines));
}
const { registerTaskSource, updateTaskSource } = require('agent-manager/src/task-source-registry.js');
const { applyArchDiscoveryCandidates } = require('agent-manager/src/candidate-docs.js');
const { groupBJsonInstructions, candidateSplitInstructions, formatFileContents } = require('agent-manager/src/prompts.js');

const RESCAN_INTERVAL_MS = 24 * 60 * 60 * 1000; // same cadence observability_review/performance_review settled on

function slugifyForId(str) {
  return str.toLowerCase().replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '').replace(/[^a-z0-9]+/g, '-');
}

function readIfExists(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

function assemblePrompt(stableLines, volatileLines) {
  return [...stableLines, '', ...volatileLines].join('\n');
}

// --- Prompts: review stage (judge genuine vs. false positive, write a candidate) -------

function functionLengthReviewPlanPrompt(task) {
  const ctx = task.promptContext;
  const stable = [
    'This is a judgment call, NOT a code-change task (yet). A deterministic scanner flagged a function as long in a project this pipeline is reviewing (file/line/length given below). Determine whether decomposing it is a GENUINE improvement or a false positive.',
    'Write a numbered PLAN that is actually a REASONED VERDICT:',
    '- "genuine — here\'s why this length is a real maintainability problem (e.g. it mixes several unrelated responsibilities that could each be a named, independently-testable function) and a rough decomposition sketch"',
    '- "false positive — here\'s why the length itself is not a real problem (e.g. a long but linear, single-purpose sequence like a big switch/case, a config object literal, or a prompt-builder that is just long strings with no real branching complexity)"',
    '- "uncertain — here\'s what would need to be checked that isn\'t given here"',
    'A function being long is not automatically a problem -- the scanner only counts lines, it has no sense of whether the length reflects real complexity. Do not assume the scanner is right just because it flagged something.',
  ];
  const volatile = [
    `File: ${ctx.file}:${ctx.line}`,
    `Scanner detail: ${ctx.detail}`,
    '',
    'THE FULL FLAGGED FUNCTION (its whole body, unless marked truncated at the end for an unusually long one):',
    ctx.snippet || '(no snippet available for this finding)',
  ];
  return assemblePrompt(stable, volatile);
}

function functionLengthReviewImplementPrompt(task, planText) {
  return [
    'Your plan above is the final REASONED VERDICT for this function-length finding in OUR OWN project.',
    '',
    planText,
    '',
    'If the verdict is FALSE POSITIVE or UNCERTAIN: write ONE short paragraph (2-4 sentences) recording why, for a human to read later. Plain prose only -- no JSON, no code fence, no "steps", no candidate block.',
    '',
    'If the verdict is GENUINE: write ONE decomposition candidate for it, in EXACTLY this format (must match this parser exactly or it cannot be consumed downstream):',
    '',
    '### AC-NNN · Title',
    'Strength: Strong',
    `Files: ${task.promptContext.file || '(the file from the finding above)'}`,
    '',
    'Problem:',
    'A paragraph describing why this function\'s length is a real maintainability problem, grounded in the snippet you were given.',
    '',
    'Solution:',
    'A paragraph sketching the decomposition -- what logical pieces to extract into their own, clearly-named functions -- scoped to exactly this function, nothing broader.',
    '',
    'Benefits:',
    'A paragraph describing what improves once decomposed (readability, testability, review-ability).',
    '',
    '(Pick an AC-NNN number that looks reasonable; the harness re-derives the real one deterministically regardless of what you write here.)',
  ].join('\n');
}

// --- Prompts: fix stage (candidate already vetted -- implement the real diff) ----------

function functionLengthFixPlanPrompt(task) {
  const ctx = task.promptContext;
  return [
    'You are drafting a plan for a narrow function-decomposition change to this project.',
    '',
    `CANDIDATE: ${ctx.candidateId} -- ${ctx.title}`,
    '',
    'Full candidate write-up (Problem / Solution / Benefits, already vetted -- do not second-guess ' +
      'whether this is worth doing, only how to do it safely):',
    ctx.body,
    '',
    `Files involved: ${ctx.files.join(', ') || '(not specified -- infer from the write-up)'}`,
    '',
    'Write a numbered PLAN (no code) for EXACTLY this decomposition and nothing broader -- do not expand ' +
      'scope to adjacent cleanup even if you notice something else that looks wrong nearby. Name the ' +
      'specific new function(s) you will extract and what each one will contain. State assumptions ' +
      'explicitly; say UNKNOWN rather than inventing facts not given above.',
  ].join('\n');
}

function functionLengthFixImplementPrompt(task, planText) {
  const ctx = task.promptContext;
  const fetched = ctx.fetchedFiles || [];
  const namedButMissing = (ctx.files || []).filter((f) => !fetched.some((ff) => ff.path === f));
  return [
    'Earlier you wrote this PLAN for a narrow function-decomposition change:',
    '',
    planText,
    '',
    `The corrected plan is for: ${ctx.candidateId} -- ${ctx.title}.`,
    '',
    fetched.length > 0
      ? `Real, current content of the file(s) this candidate named (this is the ONLY source of truth for what the file actually contains right now -- the plan/candidate write-up above may be stale or approximate; this is not):\n\n${formatFileContents(fetched)}`
      : '(none of the file(s) this candidate named could be read -- see the note below before assuming why.)',
    '',
    namedButMissing.length > 0
      ? `NOTE: ${namedButMissing.join(', ')} named by this candidate could not be read (does not exist at that path, or is outside the repo). If your plan assumed this file already exists and you cannot proceed without seeing its real content, output the empty string instead of guessing at content you were never shown.`
      : '',
    '',
    'Ground every "find" value in the real file content shown above, character for character -- never in your own memory of the plan or candidate write-up. Preserve behavior exactly: this is a pure decomposition (extract sub-functions, call them from the original site), not a rewrite -- do not change what the code does, only how it is organized.',
    '',
    candidateSplitInstructions,
    '',
    groupBJsonInstructions,
  ].join('\n');
}

// --- Task source: function_length_review (scans + judges + writes a candidate) ---------

function nextFunctionLengthReviewTask({ repoRoot, pipelineDir, defaultDomain, taskIdExistsInQueue }) {
  const projectTag = path.basename(repoRoot);
  const coveragePath = process.env.AGENT_MANAGER_FUNCTION_LENGTH_COVERAGE_PATH
    || path.join(pipelineDir, 'function-length-coverage.json');
  const flagsPath = path.join(pipelineDir, 'queue', 'function-length-flags.json');

  let coverage;
  try { coverage = JSON.parse(readIfExists(coveragePath) || '{}'); } catch { coverage = {}; }
  let flags;
  try { flags = JSON.parse(readIfExists(flagsPath) || '[]'); } catch { flags = []; }

  const now = Date.now();
  const lastScannedAt = coverage.lastScannedAt ? Date.parse(coverage.lastScannedAt) : NaN;
  const due = Number.isNaN(lastScannedAt) || (now - lastScannedAt) >= RESCAN_INTERVAL_MS;

  let flagsChanged = false;
  if (due && fs.existsSync(repoRoot)) {
    let freshFindings = [];
    let scanOk = false;
    try {
      freshFindings = scanProject(repoRoot, projectTag);
      scanOk = true;
    } catch (e) {
      console.error(`function_length_review: failed to scan "${projectTag}": ${e.message}`);
    }

    // Reconcile the persistent backlog against this fresh scan -- prune flags the scan no
    // longer reproduces (function shrank/moved/renamed/line-shifted), append genuinely
    // new ones. See flag-store.js for why the old file-exists-only prune was not enough.
    const reconciled = reconcileFlags({
      flags, freshFindings, scanOk, projectTag, repoRoot,
      isSuppressed: (f) => findingIsSuppressed(pipelineDir, repoRoot, f),
    });
    flags = reconciled.flags;
    if (reconciled.changed) flagsChanged = true;

    coverage = { lastScannedAt: new Date(now).toISOString() };
    fs.mkdirSync(path.dirname(coveragePath), { recursive: true });
    fs.writeFileSync(coveragePath, JSON.stringify(coverage, null, 2));
  }
  if (flagsChanged) {
    fs.mkdirSync(path.dirname(flagsPath), { recursive: true });
    fs.writeFileSync(flagsPath, JSON.stringify(flags, null, 2));
  }

  const sorted = [...flags].sort((a, b) => new Date(a.scannedAt) - new Date(b.scannedAt));
  for (const finding of sorted) {
    const taskId = `function-length-${slugifyForId(projectTag)}-${slugifyForId(finding.file || 'repo')}-${finding.line || 0}`;
    if (taskIdExistsInQueue(taskId)) continue;

    let snippet = null;
    if (finding.file) {
      const content = readIfExists(path.join(repoRoot, finding.file));
      if (!content) continue;
      snippet = functionSnippet(content, finding.line, finding.lengthLines);
    }

    // A prior review already ruled this exact construct a false positive -- never re-ask.
    if (isSuppressed(pipelineDir, finding.rule, snippet)) continue;

    return {
      id: taskId,
      domain: defaultDomain,
      source: 'function_length_review',
      title: `Function-length triage: ${finding.file}:${finding.line} — ${projectTag}`,
      promptContext: {
        rule: finding.rule,
        detail: finding.detail,
        file: finding.file,
        line: finding.line,
        projectSlug: projectTag,
        snippet,
      },
    };
  }

  return null;
}

// Registers both task sources against the shared registry -- called once from wherever
// the consumer wires up its task sources (task-sources.js, a single line: see that
// file's own require of this module). getConfig/nextCandidateFulfillmentTask/
// taskIdExistsInQueue are passed in by the caller rather than required directly here, so
// this module never depends on task-sources.js itself -- only on the registry it's
// registering into, keeping the dependency direction one-way for a future extraction.
// Read-only inventory of the flags backlog for the dashboard's Hygiene tab (see flag-inventory.js).
function functionLengthInventory({ repoRoot, pipelineDir, taskState }) {
  const projectTag = path.basename(repoRoot);
  let flags;
  try { flags = JSON.parse(readIfExists(path.join(pipelineDir, 'queue', 'function-length-flags.json')) || '[]'); } catch { flags = []; }
  return buildFlagInventory({
    flags, projectTag, repoRoot, taskState,
    idFor: (f) => `function-length-${slugifyForId(projectTag)}-${slugifyForId(f.file || 'repo')}-${f.line || 0}`,
    snippetFor: (f, content) => functionSnippet(content, f.line, f.lengthLines),
    isSuppressed: (rule, snippet) => isSuppressed(pipelineDir, rule, snippet),
  });
}

// Where FUNCTION_LENGTH_CANDIDATES.md lives. It must be rooted at getConfig().applyRepoRoot -- the clone the apply loop's `git add`/commit
// runs in -- not repoRoot (the live checkout), exactly like every candidate doc config.js defines (see the comment there: an absolute path
// outside the apply clone makes `git add` fail with "is outside repository", the task exhausts its apply retries, and meanwhile the entry has
// already been appended to the LIVE checkout's doc, where it stays uncommitted and blocks the dashboard's live sync). The initial extraction
// (ae689b8) hard-coded repoRoot in three places; on 2026-09-26 the live doc held 25 uncommitted candidates (~7000 lines) and three approved
// function_length_review tasks were stuck at apply. applyRepoRoot defaults to repoRoot, so this is a no-op without a dedicated apply clone.
function functionLengthCandidatesPath(getConfig) {
  if (process.env.AGENT_MANAGER_FUNCTION_LENGTH_CANDIDATES_PATH) return process.env.AGENT_MANAGER_FUNCTION_LENGTH_CANDIDATES_PATH;
  const cfg = getConfig();
  return path.join(cfg.applyRepoRoot || cfg.repoRoot, 'Docs', 'FUNCTION_LENGTH_CANDIDATES.md');
}

function register({ getConfig, nextCandidateFulfillmentTask, taskIdExistsInQueue, taskPriority }) {
  registerTaskSource('function_length_review', {
    requireCodeShapeInCandidate: true,
    hygieneFamily: hygieneFamily('function_length'),
    priority: taskPriority('function_length_review', 80),
    next: () => {
      const { repoRoot, pipelineDir, defaultDomain } = getConfig();
      return nextFunctionLengthReviewTask({ repoRoot, pipelineDir, defaultDomain, taskIdExistsInQueue });
    },
    inventory: ({ taskState }) => {
      const { repoRoot, pipelineDir } = getConfig();
      return functionLengthInventory({ repoRoot, pipelineDir, taskState });
    },
    apply: ({ implementResponse, task }) => {
      const { pipelineDir } = getConfig();
      const candidatesPath = functionLengthCandidatesPath(getConfig);
      // See apply-group-a.js's applyArchDiscoveryCandidates for why this real,
      // review-time-fresh snippet is threaded through deterministically.
      const res = applyArchDiscoveryCandidates({
        implementResponse,
        candidatesPath,
        docTitle: '# Function Length Decomposition Candidates',
        // Opt-in dedupe (agent-manager candidate-docs.js): a re-drafted/requeued finding whose file + function is already
        // in the doc (master, an unmerged agent/* branch, or this tree) is skipped instead of appended again (2026-09-26, AC-187 vs AC-51).
        dedupe: true,
        snippet: task && task.promptContext && task.promptContext.snippet,
      });
      // A "false positive" verdict wrote no candidate -- remember the flagged construct
      // so the scanner never re-emits it (suppression-store.js).
      recordFalsePositiveIfVerdict({ applyResult: res, implementResponse, task, pipelineDir });
      // A verdict that produced no candidate and is not an explicit false positive:
      // track it, and after a few such tries stop the scanner re-emitting this construct.
      recordInconclusiveReview({ applyResult: res, implementResponse, task, pipelineDir });
      return res;
    },
    // 2026-08-31: thread the flagged function window into review grounding -- see
    // observability_review's own comment. Without this the reviewer never sees the snippet
    // the drafter was told to ground its verdict in, and rejects correct calls as
    // unverified speculation.
    groundingFields: ['snippet'],
    // 2026-08-23: review-task.js/local-draft.js now read these two flags directly off
    // the registry entry instead of a hardcoded array a plugin author would otherwise
    // have to go edit inside those files -- the actual prerequisite this family's
    // extraction needed. advisoryProse: a short prose false-positive verdict is the
    // EXPECTED deliverable here, not a refusal. See review-task.js's own ADVISORY_PROSE_
    // SOURCES-turned-flag comment for the full history.
    advisoryProse: true,
    // 2026-09-02: advisoryProse alone was not enough -- the review vote still fell back to
    // the GENERIC "does it contain real, complete code" completeness question and rejected
    // every correct output ("a meta-plan describing an extraction refactor rather than the
    // actual code changes", "meta-commentary rather than the actual code implementation")
    // -- 5 real function_length_review tasks blocked+exhausted that way. This source's
    // deliverable is a PROSE verdict or a candidate BLOCK, never code; spell that out for
    // the reviewer exactly as observability_review already does.
    reviewGuidance: 'This is a function-length triage verdict for a function in OUR OWN project, NOT a code change. A valid draft is EXACTLY ONE of: (a) "GENUINE" + a correctly-formatted `### AC-NNN` candidate block (Strength: Strong / Files / Problem / Solution / Benefits) sketching which logical pieces to extract, scoped to exactly this one function; or (b) "FALSE POSITIVE" / "UNCERTAIN" + one short paragraph (2-4 sentences) explaining why, grounded in the function snippet shown. There is deliberately NO diff, no code, and no "steps" here -- do NOT reject the draft for lacking them, and do NOT reject a Solution paragraph for "describing an extraction refactor rather than the actual code" (describing the decomposition IS the deliverable). REJECT only if: the draft refuses to reach a verdict ("a human should look", "cannot determine"); a GENUINE verdict\'s candidate block is malformed or missing a required section; a GENUINE verdict\'s Solution proposes something broader than this one function; or a FALSE POSITIVE verdict\'s stated reason actually contradicts the snippet shown (e.g. claims the function is short when the snippet clearly runs past the threshold).',
    reviewCompletenessQuestion: 'Does the draft reach a decisive GENUINE-or-FALSE-POSITIVE verdict (not "uncertain"/"needs a human") and, if GENUINE, is it followed by a well-formed `### AC-NNN` candidate block whose Solution is a decomposition scoped to exactly this one function?',
    // 2026-09-05: catches a Solution paragraph that invents a helper name/signature/call
    // relationship contradicting the real flagged-function snippet -- see
    // function-length-grounding-check.js's own header for the incident (8 of 9 blocked
    // tasks shared this exact shape). Routes into the same blockedStage:'review' path a
    // real review rejection takes, before a doomed draft burns a full vote round.
    postImplementCheck: runGroundingCheck,
    // 2026-08-31: the apply is a low-risk additive candidate-doc append, not real code --
    // commit straight to main, no throwaway agent/<id> branch to hand-merge. Matches the
    // sibling candidate-generating review sources (observability_review, performance_review,
    // arch_discovery); function_length_review was the only one still missing it, which meant
    // every function_length_fix hand-off needed a human to merge the review branch before
    // function_length_fix (which reads FUNCTION_LENGTH_CANDIDATES.md from the working copy)
    // could even see the candidate.
    directToMain: true,
  });
  updateTaskSource('function_length_review', { buildPlanPrompt: functionLengthReviewPlanPrompt, buildImplementPrompt: functionLengthReviewImplementPrompt });

  registerTaskSource('function_length_fix', {
    hygieneFamily: hygieneFamily('function_length', { candidateDoc: true }),
    priority: taskPriority('function_length_fix', 72),
    next: () => {
      return nextCandidateFulfillmentTask(functionLengthCandidatesPath(getConfig), 'function_length_fix');
    },
    // No emptyApproval (2026-08-28): a Strong candidate legitimately resolving to "no real
    // decomposition after all" is rare, and it was letting the common case -- an empty
    // draft because the model gave up or the code moved -- silently auto-close with no
    // branch and no human (agent-manager's retired AC-25). An empty fulfillment draft is
    // now rejected -> retried -> blocked for a human to look at. A genuine false-positive
    // still surfaces that way, just visibly.
    // candidateFulfillment: opts into local-draft.js's find-verification retry for free.
    candidateFulfillment: true,
    // A function_length_fix candidate is already the review stage's decomposed, Strong-
    // rated extraction target -- re-splitting it just files more decomposition candidates
    // that get re-split forever instead of ever landing a diff. Confirmed live 2026-09-01:
    // AC-15 -> AC-15a/b, AC-16 -> AC-16a/b, AC-17 -> AC-17a/b, AC-18 -- four branches
    // pushed, each touching only the candidates doc, zero real code, each parent marked
    // done/succeeded for producing nothing. The generic splitDepth>=1 recursion cap
    // (local-draft.js's finalizeCandidateFulfillment) bounds this to one wasted split, but
    // never fully stops it -- same class of incident that got pipeline_forensics_fix this
    // exact flag the same day (task-sources.js). This pass must produce a real diff or
    // output empty (-> blocked for a human).
    noCandidateSplit: true,
    // candidatesPath/candidateDocTitle: still used to file THIS fix's own candidate (from
    // function_length_review) -- unrelated to the disabled re-split path above. Same
    // env-var-or-default resolution as this source's own `next` above, duplicated rather
    // than shared per this file's own stated convention for tiny same-file helpers.
    candidatesPath: () => functionLengthCandidatesPath(getConfig),
    candidateDocTitle: '# Function Length Decomposition Candidates',
  });
  updateTaskSource('function_length_fix', { buildPlanPrompt: functionLengthFixPlanPrompt, buildImplementPrompt: functionLengthFixImplementPrompt });
}

module.exports = {
  register,
  nextFunctionLengthReviewTask,
  functionSnippet,
  functionLengthReviewPlanPrompt,
  functionLengthReviewImplementPrompt,
  functionLengthFixPlanPrompt,
  functionLengthFixImplementPrompt,
};
