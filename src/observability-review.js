'use strict';

// observability_review / observability_fix -- first moved into agent-manager's
// src/maintenance/ 2026-08-23, then extracted into this out-of-tree agent-manager-hygiene
// plugin 2026-08-27 (the "fully separate npm later" that move was staging for). Wired via
// register(deps) from ../register.js with the injected-deps bag; the pure detector
// (observability-scan.js) stays in agent-manager core (staleness-fastpath.js re-runs its
// rules), imported here as ./observability-scan.js.
//
// REDIRECTED 2026-08-20 (Grimmethy: "What tangible benefits are we getting from the huge
// number of observability review tasks?" -> real numbers showed 2,025 real Ollama calls /
// ~5.6h wall-clock over 5 days scanning deep_dive's cloned EXTERNAL repos, 313 "genuine"
// verdicts, ZERO fixes ever shipped -- there was no follow-up mechanism at all, and even
// a fix would have landed in someone else's unmaintained clone, not this project. "Make
// sure it's fixing our project": now scans repoRoot directly, and a genuine verdict
// becomes a real candidate consumed by observability_fix into an actual code fix.
//
// Unlike a frozen external clone (scan once, coverage done forever), repoRoot changes
// constantly as real commits land, so this tracks a single lastScannedAt and re-scans
// every RESCAN_INTERVAL_MS instead. Findings accumulate in a flags file and are handed to
// the model one at a time, oldest first -- each rescan dedupes against what's already
// flagged (else the SAME unfixed line would get re-flagged every single rescan) and
// prunes any flag whose file no longer exists (deleted/renamed since it was flagged).

const fs = require('fs');
const path = require('path');
const { scanProject, findSilentCatchBlocks } = require('./observability-scan.js');
const { isLikelyMinified, windowFromContent } = require('./scan-utils.js');
const { reconcileFlags } = require('./flag-store.js');
const { isSuppressed, recordFalsePositiveIfVerdict } = require('./suppression-store.js');

// The -before / +after window that becomes promptContext.snippet AND the suppression key.
const SNIPPET_BEFORE = 4;
const SNIPPET_AFTER = 3;
// The wider window handed to the review/fix model (and the reviewer, via groundingFields)
// as promptContext.enclosingCode -- the whole flagged block PLUS enough surrounding code
// (the enclosing function, usually) to judge intent. This is what fixes "the model was
// asked to rule on a catch block it was never shown".
const ENCLOSING_BEFORE = 12;
const ENCLOSING_AFTER = 6;
const ENCLOSING_MAX_LINES = 140;

// Per-poll cache of "read + re-scan this file once" -- a busy repo can have dozens of
// silent-catch flags in the same large file (app.py etc.), and without this every one of
// them re-read and re-scanned the whole file (O(flags x filesize) per nextObservability
// ReviewTask call). Keyed by repo-relative path; value is { content, silentCatch } (both
// null-safe). Rebuilt fresh each call -- the file can change between polls.
function makeFileCache(repoRoot) {
  const cache = new Map();
  return (relPath) => {
    if (cache.has(relPath)) return cache.get(relPath);
    const content = readIfExists(path.join(repoRoot, relPath));
    const minified = !!content && isLikelyMinified(content);
    let silentCatch = [];
    if (content && !minified) {
      try {
        silentCatch = findSilentCatchBlocks(content, relPath).filter((f) => f.rule === 'silent-catch-block');
      } catch { silentCatch = []; }
    }
    const entry = { content, minified, silentCatch };
    cache.set(relPath, entry);
    return entry;
  };
}

// Given a persisted flag and the fresh silent-catch findings for its file, find the one
// that corresponds to it -- so a task is never built from a stale line number (the flags
// file only reconciles every RESCAN_INTERVAL_MS, but repoRoot changes many times a day).
// Match priority: same body fingerprint (survives line drift + reindentation) -> exact
// line -> the only silent-catch finding in the file. Returns the fresh finding, or null
// when the construct is gone / can't be disambiguated (the caller then drops the flag).
function relocateSilentCatchFlag(flag, fresh) {
  if (!Array.isArray(fresh) || fresh.length === 0) return null;
  if (flag.bodyFingerprint) {
    const byBody = fresh.filter((f) => f.bodyFingerprint === flag.bodyFingerprint);
    if (byBody.length === 1) return byBody[0];
    if (byBody.length > 1) {
      const exact = byBody.find((f) => f.line === flag.line);
      return exact || null; // several identical bodies -- only trust an exact-line hit
    }
  }
  const exact = fresh.find((f) => f.line === flag.line);
  if (exact) return exact;
  return fresh.length === 1 ? fresh[0] : null;
}

// A headed line-window: the flagged block plus context, bounded, with a real line-range
// header so the model (and reviewer) know exactly where in the file this is.
function enclosingCodeWindow(content, relPath, startLine, endLine) {
  const lines = String(content == null ? '' : content).split('\n');
  let from = Math.max(1, (startLine || 1) - ENCLOSING_BEFORE);
  let to = Math.min(lines.length, (endLine || startLine || 1) + ENCLOSING_AFTER);
  if (to - from + 1 > ENCLOSING_MAX_LINES) to = from + ENCLOSING_MAX_LINES - 1;
  const body = lines.slice(from - 1, to).join('\n');
  return `--- ${relPath} lines ${from}-${to} (the flagged block + surrounding code, read from the file) ---\n${body}`;
}

function findingIsSuppressed(pipelineDir, repoRoot, finding) {
  if (!finding.file) return false;
  const content = readIfExists(path.join(repoRoot, finding.file));
  if (!content) return false;
  return isSuppressed(pipelineDir, finding.rule, windowFromContent(content, finding.line, SNIPPET_BEFORE, SNIPPET_AFTER));
}
const { registerTaskSource, updateTaskSource } = require('agent-manager/src/task-source-registry.js');
const { applyArchDiscoveryCandidates } = require('agent-manager/src/candidate-docs.js');
const { projectCapabilityProfile } = require('./project-capabilities.js');

// The "what observability/logging primitives does this project actually have" grounding
// block, for every review/fix prompt below. Lazy getConfig() (needs env) -- on any failure
// fall back to the no-repo profile, which is the SAFE default ("assume nothing exists,
// don't fabricate"), never a throw that would break prompt assembly.
function capabilityProfileBlock() {
  try {
    return projectCapabilityProfile(require('agent-manager/src/config.js').getConfig().repoRoot, { kind: 'observability' });
  } catch {
    return projectCapabilityProfile(null, { kind: 'observability' });
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

// Prefix-sharing convention (see prompts.js's own assemblePrompt): stable, cacheable
// instructions first, then the '' separator, then per-call volatile content -- so a
// caching-aware backend (Ollama's KV-cache) can reuse the shared prefix's computation
// across repeated calls of the same task type instead of reprocessing it every time.
function assemblePrompt(stableLines, volatileLines) {
  return [...stableLines, '', ...volatileLines].join('\n');
}

// --- Prompts: review stage (judge genuine vs. false positive, write a candidate) -------

function observabilityReviewPlanPrompt(task) {
  const ctx = task.promptContext;
  const stable = [
    'This is a judgment call, NOT a code-change task (yet). A deterministic scanner flagged a possible observability-hygiene issue in a project this pipeline is reviewing (rule/project/file/code given below). Determine whether it is a GENUINE issue or a false positive.',
    'Write a numbered PLAN that is actually a REASONED VERDICT -- ONE of exactly two conclusions:',
    '- "GENUINE issue — here\'s the concrete risk (e.g. a real background-task error swallowed silently) and a proposed fix"',
    '- "FALSE POSITIVE — here\'s why, pointing at the specific lines below (e.g. the except binds the exception and the function\'s contract makes a None return the intended caller-visible outcome, not a swallow; or the error is surfaced a few lines down, outside the scanner\'s window)"',
    'You have been given the flagged block AND its surrounding code (the enclosing function, usually), read straight from the file. That is enough to decide. Do NOT answer "uncertain" or "a human should open the file" -- reach a verdict from the code shown. Only if the code below is genuinely, visibly truncated mid-statement may you say so, and then name the exact missing line.',
    'Do not assume the scanner is right just because it flagged something -- it is a heuristic (a keyword/brace match over a fixed window), not a parser, and false positives are expected and common.',
    '',
    capabilityProfileBlock(),
    'Any fix you propose in your verdict must use only primitives this project has (above). The scanner detail may say the error has "no metric" -- that is NOT a reason to propose adding a metric to a project with no metrics system; there the genuine fix is logging + rethrow.',
  ];
  const volatile = [
    `Rule flagged: ${ctx.rule}`,
    `Project: ${ctx.projectSlug}`,
    ctx.file ? `File: ${ctx.file}:${ctx.line}` : '(repo-wide finding, not tied to one file)',
    `Scanner detail: ${ctx.detail}`,
    '',
    'REAL SOURCE (the flagged block + surrounding code, read from the file):',
    ctx.enclosingCode || ctx.snippet || '(no source available for this finding)',
  ];
  return assemblePrompt(stable, volatile);
}

function observabilityReviewImplementPrompt(task, planText) {
  const ctx = task.promptContext || {};
  return [
    'Your plan above is the final REASONED VERDICT for this observability-hygiene finding in OUR OWN project. It is either GENUINE or FALSE POSITIVE -- there is no third option.',
    '',
    planText,
    '',
    'REAL SOURCE this verdict is about (the flagged block + surrounding code):',
    ctx.enclosingCode || ctx.snippet || '(no source available)',
    '',
    'If the verdict is FALSE POSITIVE: write ONE short paragraph (2-4 sentences) recording why, citing the specific lines above, for a human to read later. Plain prose only -- no JSON, no code fence, no "steps", no candidate block. A decisive, code-grounded "not a swallow because <specific reason from the lines above>" is the whole deliverable -- it is NOT hedging.',
    '',
    capabilityProfileBlock(),
    'Your candidate\'s "Solution" must use only primitives listed above. Do not write "add a metric / counter / health-signal number" for a project with no metrics system -- write the logging + rethrow fix instead.',
    '',
    'If the verdict is GENUINE: write ONE fix candidate for it, in EXACTLY this format (must match this parser exactly or it cannot be consumed downstream):',
    '',
    '### AC-NNN · Title',
    'Strength: Strong',
    `Files: ${task.promptContext.file || '(the file from the finding above)'}`,
    '',
    'Problem:',
    'A paragraph describing the concrete observability gap, grounded in the real source above.',
    '',
    'Solution:',
    'A paragraph describing the specific fix (e.g. what to log, what to rethrow, what health signal to add) -- scoped to exactly this finding, nothing broader.',
    '',
    'Benefits:',
    'A paragraph describing what improves once fixed.',
    '',
    '(Pick an AC-NNN number that looks reasonable; the harness re-derives the real one deterministically regardless of what you write here.)',
  ].join('\n');
}

// --- Prompts: fix stage (candidate already vetted -- implement the real diff) ----------
// Same shape arch_review's own fix-stage prompt uses (prompts.js's archReviewPlanPrompt/
// archReviewImplementPrompt, which stayed in core since arch_review isn't moving) --
// duplicated narrowly rather than reached for across the module boundary, same choice
// function-length-review.js already made for its own fix stage.

function observabilityFixPlanPrompt(task) {
  const ctx = task.promptContext;
  return [
    'You are drafting a plan for a narrow observability-hygiene fix to this project.',
    '',
    `CANDIDATE: ${ctx.candidateId} -- ${ctx.title}`,
    '',
    'Full candidate write-up (Problem / Solution / Benefits). It is already vetted for WHETHER it is ' +
      'worth doing -- do not re-litigate that. But it was written WITHOUT checking this project\'s actual ' +
      'capabilities (see PROJECT CAPABILITIES below): if its Solution names a primitive this project does ' +
      'not have, plan only the parts that ARE available and drop the rest -- do not plan to add the missing one.',
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

function observabilityFixImplementPrompt(task, planText) {
  const ctx = task.promptContext;
  const fetched = ctx.fetchedFiles || [];
  const namedButMissing = (ctx.files || []).filter((f) => !fetched.some((ff) => ff.path === f));
  const { formatFileContents, groupBJsonInstructions, candidateSplitInstructions } = require('agent-manager/src/prompts.js');
  return [
    'Earlier you wrote this PLAN for a narrow observability-hygiene fix:',
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

// --- Task source: observability_review (scans + judges + writes a candidate) -----------

function nextObservabilityReviewTask({ repoRoot, pipelineDir, defaultDomain, taskIdExistsInQueue, coveragePath }) {
  const projectTag = path.basename(repoRoot);

  let coverage;
  try { coverage = JSON.parse(readIfExists(coveragePath) || '{}'); } catch { coverage = {}; }

  const flagsPath = path.join(pipelineDir, 'queue', 'observability-flags.json');
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
      console.error(`observability_review: failed to scan "${projectTag}": ${e.message}`);
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
  const staleKeys = new Set(); // rule::file::line of flags whose construct is gone -- pruned
  const getFile = makeFileCache(repoRoot); // read + re-scan each file at most once per poll

  // Rewrite the flags file without the stale entries this poll discovered, then return.
  const persistStaleAnd = (result) => {
    if (staleKeys.size > 0) {
      const kept = flags.filter((f) => !staleKeys.has(`${f.rule}::${f.file}::${f.line}`));
      try {
        fs.mkdirSync(path.dirname(flagsPath), { recursive: true });
        fs.writeFileSync(flagsPath, JSON.stringify(kept, null, 2));
      } catch { /* best-effort -- the 24h reconcile is the backstop */ }
    }
    return result;
  };

  for (const flag of sorted) {
    let finding = flag;
    let content = null;

    if (flag.file) {
      const cached = getFile(flag.file);
      content = cached.content;
      if (!content) { staleKeys.add(`${flag.rule}::${flag.file}::${flag.line}`); continue; } // file gone
      if (cached.minified) continue;

      // silent-catch-block: re-locate against the CURRENT file so the task is never built
      // from a drifted line (the whole "the model was shown the wrong 8 lines" failure).
      if (flag.rule === 'silent-catch-block') {
        const fresh = relocateSilentCatchFlag(flag, cached.silentCatch);
        if (!fresh) { staleKeys.add(`${flag.rule}::${flag.file}::${flag.line}`); continue; } // construct fixed/removed
        finding = { ...flag, line: fresh.line, detail: fresh.detail, blockStartLine: fresh.blockStartLine, blockEndLine: fresh.blockEndLine, bodyFingerprint: fresh.bodyFingerprint };
      }
    }

    const taskId = `observability-${slugifyForId(projectTag)}-${slugifyForId(finding.rule)}-${slugifyForId(finding.file || 'repo')}-${finding.line || 0}`;
    if (taskIdExistsInQueue(taskId)) continue;

    let snippet = null;
    let enclosingCode = null;
    if (content && finding.file) {
      snippet = windowFromContent(content, finding.line, SNIPPET_BEFORE, SNIPPET_AFTER);
      enclosingCode = enclosingCodeWindow(
        content, finding.file,
        finding.blockStartLine || finding.line,
        finding.blockEndLine || finding.line,
      );
    }

    // A prior review already ruled this exact construct a false positive -- never re-ask.
    if (isSuppressed(pipelineDir, finding.rule, snippet)) continue;

    return persistStaleAnd({
      id: taskId,
      domain: defaultDomain,
      source: 'observability_review',
      title: `Observability triage: ${finding.rule} — ${projectTag}${finding.file ? ` (${finding.file}:${finding.line})` : ''}`,
      promptContext: {
        rule: finding.rule,
        detail: finding.detail,
        file: finding.file,
        line: finding.line,
        projectSlug: projectTag,
        snippet,
        blockStartLine: finding.blockStartLine,
        blockEndLine: finding.blockEndLine,
        enclosingCode,
      },
    });
  }

  return persistStaleAnd(null);
}

function register({ getConfig, nextCandidateFulfillmentTask, taskIdExistsInQueue, taskPriority }) {
  registerTaskSource('observability_review', {
    priority: taskPriority('observability_review', 80),
    next: () => {
      const { repoRoot, pipelineDir, defaultDomain, observabilityCoveragePath } = getConfig();
      return nextObservabilityReviewTask({ repoRoot, pipelineDir, defaultDomain, taskIdExistsInQueue, coveragePath: observabilityCoveragePath });
    },
    apply: ({ implementResponse, task }) => {
      const { observabilityFixCandidatesPath, pipelineDir } = getConfig();
      // task.promptContext.snippet is the real, review-time-fresh code text this
      // finding is about (see nextObservabilityReviewTask below) -- passed through
      // deterministically so it survives into the candidate doc as data, not just
      // however faithfully the model's own prose happened to paraphrase it.
      const res = applyArchDiscoveryCandidates({
        implementResponse,
        candidatesPath: observabilityFixCandidatesPath,
        docTitle: '# Observability Fix Candidates',
        snippet: task && task.promptContext && task.promptContext.snippet,
      });
      // A "false positive" verdict wrote no candidate -- remember the flagged construct
      // so the scanner never re-emits it (suppression-store.js).
      recordFalsePositiveIfVerdict({ applyResult: res, implementResponse, task, pipelineDir });
      return res;
    },
    // 2026-08-31: the reviewer must see the SAME code window the drafter was given.
    // nextObservabilityReviewTask puts the flagged code into promptContext.snippet and the
    // implement prompt tells the model to "ground your verdict in the snippet you were
    // given" -- but get-grounding-source.js only threads a fixed set of promptContext
    // fields into review-task.js's grounding block, and `snippet` wasn't one of them. So
    // the reviewer saw only PLAN + IMPLEMENT + "file exists", was told to treat every
    // claim as UNVERIFIED, and rejected correct verdicts ("there is no try/except in this
    // 5-line handler") as "an unverified assertion based on a snippet not provided in the
    // prompt" -> 2 retries -> blocked. Declaring it here makes get-grounding-source.js's
    // generic source.groundingFields consumer include it. 2026-09-02: also thread
    // `enclosingCode` -- the wider block+context window nextObservabilityReviewTask now
    // builds -- so the reviewer judges the verdict against the same real code the drafter saw.
    groundingFields: ['snippet', 'enclosingCode'],
    advisoryProse: true,
    // The verdict is binary (GENUINE / FALSE POSITIVE) and the drafter had the flagged
    // block + enclosing function as real source -- so an "I can't verify / a human should
    // look" answer IS rejectable, but a decisive, code-grounded false-positive verdict
    // that happens to read cautiously is NOT hedging. Spell that out so the generic
    // hedging rule (review-task.js) doesn't reject correct dismissals.
    reviewGuidance: 'This is an observability_review triage verdict, not a code change. A valid draft is EXACTLY ONE of: (a) "GENUINE" + a correctly-formatted `### AC-NNN` candidate block (Strength/Files/Problem/Solution/Benefits), or (b) "FALSE POSITIVE" + one short paragraph citing the specific lines in the grounding source. The drafter was given the flagged block AND its surrounding code read straight from the file. REJECT the draft if it answers "uncertain", "cannot verify", "a human should open the file", or otherwise refuses to reach a verdict from the code it was shown. But do NOT reject a decisive verdict merely for sounding careful: "not a silent swallow because the except binds `e` and the function\'s documented contract returns None on failure" is a real, complete verdict grounded in the code -- approve it. Reject a FALSE POSITIVE verdict only when its stated reason actually contradicts the grounding source (e.g. it claims the body logs the error but the shown lines are a bare `pass`), and reject a GENUINE verdict whose candidate is malformed or proposes a primitive the project does not have.',
    reviewCompletenessQuestion: 'Does the draft reach a decisive GENUINE-or-FALSE-POSITIVE verdict (not "uncertain"/"needs a human"), and is that verdict consistent with the flagged block + surrounding code in the grounding source?',
    directToMain: true, // the apply is a low-risk candidate-doc append, not real code -- straight to main
    // ADR-0022 Stage A3: how a completed review counts toward system-report.js's
    // junk/filtering/benefit accounting. A review that correctly dismissed a false
    // positive is real triage work ('filtering'); one that confirmed a genuine issue
    // is a 'benefit'. Read off the registry there instead of a hardcoded source check.
    reportClass: (task) => {
      const text = (task.implementResponse || '').toLowerCase();
      if (text.includes('false positive') || text.includes('false-positive')) return 'filtering';
      if (text.includes('genuine')) return 'benefit';
      return 'unclear';
    },
  });
  updateTaskSource('observability_review', { buildPlanPrompt: observabilityReviewPlanPrompt, buildImplementPrompt: observabilityReviewImplementPrompt });

  registerTaskSource('observability_fix', {
    priority: taskPriority('observability_fix', 72),
    next: () => {
      const { observabilityFixCandidatesPath } = getConfig();
      return nextCandidateFulfillmentTask(observabilityFixCandidatesPath, 'observability_fix');
    },
    // No emptyApproval (2026-08-28): an empty fulfillment draft means "couldn't produce
    // this fix", not "nothing to do" -- with it, those silently auto-closed with no branch
    // and no human. Without it, an empty draft is rejected -> retried -> blocked for a
    // human. See agent-manager's retired AC-25.
    candidateFulfillment: true,
    candidatesPath: () => getConfig().observabilityFixCandidatesPath,
    candidateDocTitle: '# Observability Fix Candidates',
  });
  updateTaskSource('observability_fix', { buildPlanPrompt: observabilityFixPlanPrompt, buildImplementPrompt: observabilityFixImplementPrompt });
}

module.exports = {
  register,
  nextObservabilityReviewTask,
  observabilityReviewPlanPrompt,
  observabilityReviewImplementPrompt,
  observabilityFixPlanPrompt,
  observabilityFixImplementPrompt,
};
