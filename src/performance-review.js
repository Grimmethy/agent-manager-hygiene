'use strict';

// performance_review / performance_fix -- first moved into agent-manager's src/maintenance/
// 2026-08-23, then extracted into this out-of-tree agent-manager-hygiene plugin 2026-08-27.
// Exact structural mirror of observability-review.js (see its header) -- same lastScannedAt/
// rescan-interval/dedupe/prune shape, swapped to performance-scan.js's scanner (which stays
// in agent-manager core) and its own coverage/flags files.
//
// Brain Dump #94 (2026-08-18): "our pretty little cpu is getting overloaded... we need to
// develop a performance review job for projects anyways". REDIRECTED 2026-08-20 (same
// treatment observability_review got): real numbers showed the identical pattern -- 355
// done tasks, 297 (84%) false positive, 56 (16%) genuine, scanning deep_dive's cloned
// EXTERNAL repos with no follow-up mechanism, zero fixes ever shipped.

const { hygieneFamily } = require('./hygiene-family.js');
const fs = require('fs');
const path = require('path');
const { scanProject } = require('./performance-scan.js');
const { isLikelyMinified, windowFromContent } = require('./scan-utils.js');
const { reconcileFlags } = require('./flag-store.js');
const { isSuppressed, recordFalsePositiveIfVerdict, recordInconclusiveReview, classifyReviewOutcome } = require('./suppression-store.js');
const { buildFlagInventory } = require('./flag-inventory.js');

// 2026-09-17 (agent-manager needs-clarification bd-1788740326297, defensive hardening):
// mirrors observability_review's own STAMP_REVIEW_DISPOSITION pattern -- performance_review
// never stamped task.reviewDisposition at all, so task-disposition.js's structured step 0
// (dismissed/inconclusive) could never fire for it; a false-positive dismissal only ever
// got caught by that file's older, regex-based verdict-text fallback (step 4b). No live
// incident of a genuine fix actually mis-showing as noop was found investigating this (git-
// state fall-through already handles a real, unmerged fix correctly via pending-merge) --
// this closes the gap for parity/precision with observability_review, not an active bug.
const STAMP_REVIEW_DISPOSITION = process.env.AGENT_MANAGER_PERFORMANCE_REVIEW_DISPOSITION !== 'false';

// The -before / +after window that becomes promptContext.snippet AND the suppression key.
const SNIPPET_BEFORE = 4;
const SNIPPET_AFTER = 3;

// A flag whose current on-disk window was already ruled a false positive (any line) --
// used both to prune the persistent backlog and to skip at task-emit time.
function findingIsSuppressed(pipelineDir, repoRoot, finding) {
  if (!finding.file) return false;
  const content = readIfExists(path.join(repoRoot, finding.file));
  if (!content) return false;
  return isSuppressed(pipelineDir, finding.rule, windowFromContent(content, finding.line, SNIPPET_BEFORE, SNIPPET_AFTER));
}
const { registerTaskSource, updateTaskSource } = require('agent-manager/src/task-source-registry.js');
const { applyArchDiscoveryCandidates } = require('agent-manager/src/candidate-docs.js');
const { projectCapabilityProfile } = require('./project-capabilities.js');

// See observability-review.js's identical helper: a factual "what this project has"
// block so a *_fix draft doesn't invent a caching/profiling/metrics primitive the
// project can't support. Lazy getConfig(); safe no-repo fallback on any failure.
function capabilityProfileBlock() {
  try {
    return projectCapabilityProfile(require('agent-manager/src/config.js').getConfig().repoRoot, { kind: 'performance' });
  } catch {
    return projectCapabilityProfile(null, { kind: 'performance' });
  }
}

const RESCAN_INTERVAL_MS = 24 * 60 * 60 * 1000;

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

function performanceReviewPlanPrompt(task) {
  const ctx = task.promptContext;
  const stable = [
    'This is a judgment call, NOT a code-change task (yet). A deterministic scanner flagged a possible performance issue in a project this pipeline is reviewing (rule/project/file/snippet given below). Determine whether it is a GENUINE issue or a false positive.',
    'Write a numbered PLAN that is actually a REASONED VERDICT:',
    '- "genuine issue — here\'s the concrete performance cost (e.g. blocking I/O per loop iteration, needless sequential network calls) and a proposed fix"',
    '- "false positive — here\'s why (e.g. the loop only ever runs a handful of times, the sequence is deliberately rate-limited/ordered, the sync call runs once at startup not in a hot path)"',
    '- "uncertain — here\'s what would need to be checked that isn\'t given here (e.g. real call frequency, profiling data)"',
    'Do not assume the scanner is right just because it flagged something -- it is a heuristic, not a profiler, and false positives are expected.',
    '',
    capabilityProfileBlock(),
    'Any fix you propose in your verdict must be implementable with what this project already has (above) -- do not propose adding a caching / profiling / metrics library or an API this project does not expose.',
  ];
  const volatile = [
    `Rule flagged: ${ctx.rule}`,
    `Project: ${ctx.projectSlug}`,
    ctx.file ? `File: ${ctx.file}:${ctx.line}` : '(repo-wide finding, not tied to one file)',
    `Scanner detail: ${ctx.detail}`,
    '',
    'SURROUNDING SOURCE (if available):',
    ctx.snippet || '(no snippet available for this finding)',
  ];
  return assemblePrompt(stable, volatile);
}

function performanceReviewImplementPrompt(task, planText) {
  return [
    'Your plan above is the final REASONED VERDICT for this performance finding in OUR OWN project.',
    '',
    planText,
    '',
    'If the verdict is FALSE POSITIVE or UNCERTAIN: write ONE short paragraph (2-4 sentences) recording why, for a human to read later. Plain prose only -- no JSON, no code fence, no "steps", no candidate block.',
    '',
    capabilityProfileBlock(),
    'Your candidate\'s "Solution" must be achievable with this project\'s existing dependencies -- do not write "add a cache library / profiler / metrics histogram" if none is listed above.',
    '',
    'If the verdict is GENUINE: write ONE fix candidate for it, in EXACTLY this format (must match this parser exactly or it cannot be consumed downstream):',
    '',
    '### AC-NNN · Title',
    'Strength: Strong',
    `Files: ${task.promptContext.file || '(the file from the finding above)'}`,
    '',
    'Problem:',
    'A paragraph describing the concrete performance cost, grounded in the snippet you were given.',
    '',
    'Solution:',
    'A paragraph describing the specific fix (e.g. batch the I/O, parallelize, cache the result) -- scoped to exactly this finding, nothing broader.',
    '',
    'Benefits:',
    'A paragraph describing what improves once fixed.',
    '',
    '(Pick an AC-NNN number that looks reasonable; the harness re-derives the real one deterministically regardless of what you write here.)',
  ].join('\n');
}

// --- Prompts: fix stage (candidate already vetted -- implement the real diff) ----------

function performanceFixPlanPrompt(task) {
  const ctx = task.promptContext;
  return [
    'You are drafting a plan for a narrow performance fix to this project.',
    '',
    `CANDIDATE: ${ctx.candidateId} -- ${ctx.title}`,
    '',
    'Full candidate write-up (Problem / Solution / Benefits). It is already vetted for WHETHER it is ' +
      'worth doing -- do not re-litigate that. But it was written WITHOUT checking this project\'s actual ' +
      'capabilities (see PROJECT CAPABILITIES below): if its Solution needs a library or API this project ' +
      'does not have, plan the simplest approach that IS available instead.',
    ctx.body,
    '',
    capabilityProfileBlock(),
    '',
    `Files involved: ${ctx.files.join(', ') || '(not specified -- infer from the write-up)'}`,
    '',
    'Write a numbered PLAN (no code) for EXACTLY this fix and nothing broader -- do not expand ' +
      'scope to adjacent cleanup even if you notice something else that looks wrong nearby. State ' +
      'assumptions explicitly; say UNKNOWN rather than inventing facts not given above.',
  ].join('\n');
}

function performanceFixImplementPrompt(task, planText) {
  const ctx = task.promptContext;
  const fetched = ctx.fetchedFiles || [];
  const namedButMissing = (ctx.files || []).filter((f) => !fetched.some((ff) => ff.path === f));
  const { formatFileContents, groupBJsonInstructions, candidateSplitInstructions } = require('agent-manager/src/prompts.js');
  return [
    'Earlier you wrote this PLAN for a narrow performance fix:',
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
      ? `NOTE: ${namedButMissing.join(', ')} named by this candidate could not be read (does not exist at that path, or is outside the repo). If your plan calls for creating this file, use mode "create". If your plan assumed this file already exists and you cannot proceed without seeing its real content, output the empty string instead of guessing at content you were never shown.`
      : '',
    '',
    'Ground every "find" value in the real file content shown above, character for character -- never in your own memory of the plan or candidate write-up.',
    '',
    capabilityProfileBlock(),
    '',
    candidateSplitInstructions,
    '',
    groupBJsonInstructions,
  ].join('\n');
}

// --- Task source: performance_review (scans + judges + writes a candidate) -------------

function nextPerformanceReviewTask({ repoRoot, pipelineDir, defaultDomain, taskIdExistsInQueue, coveragePath }) {
  const projectTag = path.basename(repoRoot);

  let coverage;
  try { coverage = JSON.parse(readIfExists(coveragePath) || '{}'); } catch { coverage = {}; }

  const flagsPath = path.join(pipelineDir, 'queue', 'performance-flags.json');
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
      console.error(`performance_review: failed to scan "${projectTag}": ${e.message}`);
    }

    // Reconcile the persistent backlog against this fresh scan -- prune flags the scan no
    // longer reproduces (issue fixed/moved/line-shifted), append genuinely new ones. See
    // flag-store.js for why the old file-exists-only prune was not enough.
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
    const taskId = `performance-${slugifyForId(projectTag)}-${slugifyForId(finding.rule)}-${slugifyForId(finding.file || 'repo')}-${finding.line || 0}`;
    if (taskIdExistsInQueue(taskId)) continue;

    let snippet = null;
    if (finding.file) {
      const content = readIfExists(path.join(repoRoot, finding.file));
      if (content && isLikelyMinified(content)) continue;
      if (!content) continue;
      snippet = windowFromContent(content, finding.line, SNIPPET_BEFORE, SNIPPET_AFTER);
    }

    // A prior review already ruled this exact construct a false positive -- never re-ask.
    if (isSuppressed(pipelineDir, finding.rule, snippet)) continue;

    return {
      id: taskId,
      domain: defaultDomain,
      source: 'performance_review',
      title: `Performance triage: ${finding.rule} — ${projectTag}${finding.file ? ` (${finding.file}:${finding.line})` : ''}`,
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

// Read-only inventory of the flags backlog for the dashboard's Hygiene tab (see flag-inventory.js).
function performanceInventory({ repoRoot, pipelineDir, taskState }) {
  const projectTag = path.basename(repoRoot);
  let flags;
  try { flags = JSON.parse(readIfExists(path.join(pipelineDir, 'queue', 'performance-flags.json')) || '[]'); } catch { flags = []; }
  return buildFlagInventory({
    flags, projectTag, repoRoot, taskState,
    idFor: (f) => `performance-${slugifyForId(projectTag)}-${slugifyForId(f.rule)}-${slugifyForId(f.file || 'repo')}-${f.line || 0}`,
    snippetFor: (f, content) => windowFromContent(content, f.line, SNIPPET_BEFORE, SNIPPET_AFTER),
    isSuppressed: (rule, snippet) => isSuppressed(pipelineDir, rule, snippet),
    isUnreviewable: (content) => isLikelyMinified(content),
  });
}

function register({ getConfig, nextCandidateFulfillmentTask, taskIdExistsInQueue, taskPriority }) {
  registerTaskSource('performance_review', {
    hygieneFamily: hygieneFamily('performance'),
    priority: taskPriority('performance_review', 80),
    next: () => {
      const { repoRoot, pipelineDir, defaultDomain, performanceCoveragePath } = getConfig();
      return nextPerformanceReviewTask({ repoRoot, pipelineDir, defaultDomain, taskIdExistsInQueue, coveragePath: performanceCoveragePath });
    },
    inventory: ({ taskState }) => {
      const { repoRoot, pipelineDir } = getConfig();
      return performanceInventory({ repoRoot, pipelineDir, taskState });
    },
    apply: ({ implementResponse, task }) => {
      const { performanceFixCandidatesPath, pipelineDir } = getConfig();
      // See apply-group-a.js's applyArchDiscoveryCandidates for why this real,
      // review-time-fresh snippet is threaded through deterministically.
      const res = applyArchDiscoveryCandidates({
        implementResponse,
        candidatesPath: performanceFixCandidatesPath,
        docTitle: '# Performance Fix Candidates',
        // Opt-in dedupe (agent-manager candidate-docs.js): a re-drafted/requeued finding whose file + function is already
        // in the doc (master, an unmerged agent/* branch, or this tree) is skipped instead of appended again (2026-09-26, AC-187 vs AC-51).
        dedupe: true,
        snippet: task && task.promptContext && task.promptContext.snippet,
      });
      // A "false positive" verdict wrote no candidate (res.skipped) -- remember the
      // flagged construct so the scanner never re-emits it (suppression-store.js).
      recordFalsePositiveIfVerdict({ applyResult: res, implementResponse, task, pipelineDir });
      // A verdict that produced no candidate and is not an explicit false positive:
      // track it, and after a few such tries stop the scanner re-emitting this construct.
      recordInconclusiveReview({ applyResult: res, implementResponse, task, pipelineDir });
      // Structured outcome for task-disposition.js (see STAMP_REVIEW_DISPOSITION's own
      // header) -- mutating `task` here is persisted by apply-task.js after apply() returns.
      if (STAMP_REVIEW_DISPOSITION && task) {
        task.reviewDisposition = classifyReviewOutcome({ applyResult: res, implementResponse });
      }
      return res;
    },
    // 2026-08-31: thread the flagged code window into review grounding -- see
    // observability_review's own comment. Without this the reviewer never sees the snippet
    // the drafter was told to ground its verdict in, and rejects correct false-positive
    // calls as unverified.
    groundingFields: ['snippet'],
    advisoryProse: true,
    // 2026-09-02: advisoryProse alone left the review vote falling back to the generic
    // "does it contain real, complete code" question, which rejected correct verdicts as
    // "a prose-only plan with no actual code implementation" -- same gap function_length_
    // review just had. This source produces a PROSE verdict or a candidate BLOCK, not code.
    reviewGuidance: 'This is a performance-finding triage verdict for a project this pipeline reviews, NOT a code change (yet). A valid draft is EXACTLY ONE of: (a) "GENUINE" + a correctly-formatted `### AC-NNN` fix-candidate block (Strength: Strong / Files / Problem / Solution / Benefits); or (b) "FALSE POSITIVE" / "UNCERTAIN" + one short paragraph explaining why, grounded in the code snippet shown. There is deliberately NO diff or code here -- do NOT reject the draft for lacking an implementation, and do NOT reject the Solution paragraph for sketching the fix rather than writing it. REJECT only if: the draft refuses to reach a verdict; a GENUINE verdict\'s candidate block is malformed; the Solution proposes an unrelated or much broader change than the flagged construct; or a FALSE POSITIVE verdict\'s stated reason contradicts the snippet shown.',
    reviewCompletenessQuestion: 'Does the draft reach a decisive GENUINE-or-FALSE-POSITIVE verdict (not "uncertain") and, if GENUINE, is it followed by a well-formed `### AC-NNN` candidate block scoped to the flagged construct?',
    directToMain: true, // see observability_review
    reportClass: (task) => { // see observability_review -- same filtering vs benefit split
      const text = (task.implementResponse || '').toLowerCase();
      if (text.includes('false positive') || text.includes('false-positive')) return 'filtering';
      if (text.includes('genuine')) return 'benefit';
      return 'unclear';
    },
  });
  updateTaskSource('performance_review', { buildPlanPrompt: performanceReviewPlanPrompt, buildImplementPrompt: performanceReviewImplementPrompt });

  registerTaskSource('performance_fix', {
    hygieneFamily: hygieneFamily('performance', { candidateDoc: true }),
    priority: taskPriority('performance_fix', 73),
    next: () => {
      const { performanceFixCandidatesPath } = getConfig();
      return nextCandidateFulfillmentTask(performanceFixCandidatesPath, 'performance_fix');
    },
    candidateFulfillment: true, // no emptyApproval -- see observability_fix
    // 2026-09-18: same deterministic FALSE POSITIVE re-validation as observability_fix
    // (see that source's own registration comment) -- performance_fix candidates are
    // sourced from performance_review's own deterministic-recheck rules, registered
    // below via deterministic-recheck.js's own register() call.
    premiseRecheckSource: 'performance_review',
    candidatesPath: () => getConfig().performanceFixCandidatesPath,
    candidateDocTitle: '# Performance Fix Candidates',
  });
  updateTaskSource('performance_fix', { buildPlanPrompt: performanceFixPlanPrompt, buildImplementPrompt: performanceFixImplementPrompt });
}

module.exports = {
  register,
  nextPerformanceReviewTask,
  performanceReviewPlanPrompt,
  performanceReviewImplementPrompt,
  performanceFixPlanPrompt,
  performanceFixImplementPrompt,
};
