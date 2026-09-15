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
const {
  isSuppressed, isClusterSuppressed, recordSuppression, recordFalsePositiveIfVerdict, recordInconclusiveReview, classifyReviewOutcome,
} = require('./suppression-store.js');
const { selectLowConfidenceBatch, parseDigestVerdicts, LOW_CONFIDENCE_CAP, LOW_CONFIDENCE_MODE } = require('./low-confidence-digest.js');

const STAMP_REVIEW_DISPOSITION = process.env.AGENT_MANAGER_OBSERVABILITY_REVIEW_DISPOSITION !== 'false';

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

// --- Prompts: low-confidence digest (batch triage of the recovery/fallback bucket) -------

function digestItemsBlock(items) {
  return (items || []).map((it) => [
    `--- ${it.n}. ${it.file}:${it.line} ---`,
    `Scanner detail: ${it.detail}`,
    it.enclosingCode || it.snippet || '(no source)',
  ].join('\n')).join('\n\n');
}

function observabilityReviewDigestPlanPrompt(task) {
  const items = (task.promptContext && task.promptContext.items) || [];
  const stable = [
    'A deterministic scanner flagged the catch/except blocks below as possibly swallowing an error silently. Each was already tiered LOW confidence -- the body does deliberate control flow (returns a fallback, continues a loop) or sits in a best-effort context, so most of these are intentional graceful-recovery, NOT a vanished error. Your job is a fast batch triage.',
    'For EACH numbered block, decide GENUINE (a real error is being lost with zero operator visibility and it matters) or FALSE POSITIVE (deliberate, documented, or harmless recovery). Lean FALSE POSITIVE unless the block clearly drops a meaningful error on the floor.',
    'Write a numbered PLAN: one line per block -- "<n>. GENUINE|FALSE POSITIVE — <one clause citing the block>".',
    '',
    capabilityProfileBlock(),
  ];
  return assemblePrompt(stable, [
    `Project: ${task.promptContext && task.promptContext.projectSlug}`,
    `${items.length} block(s):`,
    '',
    digestItemsBlock(items),
  ]);
}

function observabilityReviewDigestImplementPrompt(task, planText) {
  const items = (task.promptContext && task.promptContext.items) || [];
  return [
    'Your plan above triaged each flagged block. Now emit the machine-readable verdict list.',
    '',
    planText,
    '',
    `Output EXACTLY ${items.length} line(s), nothing else -- no preamble, no summary. Each line:`,
    '`<n>. GENUINE|FALSE POSITIVE — <=20 words citing that block`',
    'Use the block numbers exactly as shown. One line per block, in order.',
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

// The flagged code block, straight from the candidate body (`Snippet:` fence). The
// implement prompt otherwise only had the plan's paraphrase of it -- root cause of 8
// blocked tasks whose `find` matched a DIFFERENT try/except/catch than the flagged one.
function flaggedSnippet(ctx) {
  const m = /(?:^|\n)\s*Snippet:\s*```[\w-]*\n([\s\S]*?)```/i.exec(String((ctx && ctx.body) || ''));
  return m ? m[1].replace(/\s+$/, '') : '';
}

// Per-fetched-file: does `import logging` and a module-level logger already exist? The
// model routinely re-adds them (5 blocked tasks: "duplicate import logging" / import
// inserted inside a function).
function importStatusBlock(fetched) {
  const lines = [];
  for (const f of fetched) {
    if (!/\.py$/.test(f.path)) continue;
    const c = f.content || '';
    const hasImport = /^\s*(?:import logging\b|from logging import)/m.test(c);
    const hasLogger = /^\s*(?:logger|log|_log|LOG|LOGGER)\s*=\s*logging\.getLogger\(/m.test(c);
    if (hasImport || hasLogger) {
      lines.push(`- ${f.path}: ${hasImport ? '`import logging` is ALREADY present' : '`import logging` is NOT present'}; ${hasLogger ? 'a module logger is ALREADY defined -- USE IT, do not create another' : 'no module logger -- if you need one, add exactly ONE `logger = logging.getLogger(__name__)` at module top with the other imports, never inside a function'}.`);
    } else {
      lines.push(`- ${f.path}: no \`import logging\` yet -- add it with the other top-level imports (NOT inside a function), plus one \`logger = logging.getLogger(__name__)\`.`);
    }
  }
  return lines.length ? `IMPORT / LOGGER STATUS (do not blindly re-add what is already there):\n${lines.join('\n')}\n` : '';
}

function observabilityFixImplementPrompt(task, planText) {
  const ctx = task.promptContext;
  const fetched = ctx.fetchedFiles || [];
  const namedButMissing = (ctx.files || []).filter((f) => !fetched.some((ff) => ff.path === f));
  const snippet = flaggedSnippet(ctx);
  const { formatFileContents, groupBJsonInstructions, candidateSplitInstructions } = require('agent-manager/src/prompts.js');
  return [
    'Earlier you wrote this PLAN for a narrow observability-hygiene fix:',
    '',
    planText,
    '',
    `The corrected plan is for: ${ctx.candidateId} -- ${ctx.title}.`,
    '',
    snippet
      ? `THE EXACT BLOCK THIS CANDIDATE FLAGGED (this, and only this, is what you are changing):\n\n\`\`\`\n${snippet}\n\`\`\`\n\nYour "find" value MUST be a verbatim substring of this block, or of the real file text immediately around it (shown below). Do NOT target a different try/except or catch elsewhere in the file even if it looks similar -- there is exactly one flagged block and it is the one above.`
      : '',
    '',
    fetched.length > 0
      ? `Real, current content of the file(s) this candidate named (this is the ONLY source of truth for what the file actually contains right now -- the plan/candidate write-up above may be stale or approximate; this is not):\n\n${formatFileContents(fetched)}`
      : '(none of the file(s) this candidate named could be read -- see the note below before assuming why.)',
    '',
    importStatusBlock(fetched),
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

// Shared setup for both the per-finding review flow and the low-confidence digest: read the
// flags backlog, rescan+reconcile if the 24h window has elapsed, persist, and hand back a
// FIFO-sorted list plus a per-poll file cache. Returns { sorted, getFile, projectTag, flags,
// flagsPath }.
function prepareObservabilityFlags({ repoRoot, pipelineDir, coveragePath }) {
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
    // longer reproduces (issue fixed/moved/line-shifted), append genuinely new ones, refresh
    // `confidence` onto survivors. See flag-store.js.
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
  const getFile = makeFileCache(repoRoot);
  return { sorted, getFile, projectTag, flags, flagsPath };
}

// A persist-stale-flags-then-return closure, per caller (each collects its own staleKeys).
function makePersistStaleAnd(flags, flagsPath, staleKeys) {
  return (result) => {
    if (staleKeys.size > 0) {
      const kept = flags.filter((f) => !staleKeys.has(`${f.rule}::${f.file}::${f.line}`));
      try {
        fs.mkdirSync(path.dirname(flagsPath), { recursive: true });
        fs.writeFileSync(flagsPath, JSON.stringify(kept, null, 2));
      } catch { /* best-effort -- the 24h reconcile is the backstop */ }
    }
    return result;
  };
}

// Relocate a flag against the current file + read its code windows. Returns
// { finding, content } or null (file gone / minified / construct removed). Mutates staleKeys.
function resolveFinding(flag, getFile, staleKeys) {
  if (!flag.file) return { finding: flag, content: null };
  const cached = getFile(flag.file);
  const content = cached.content;
  if (!content) { staleKeys.add(`${flag.rule}::${flag.file}::${flag.line}`); return null; }
  if (cached.minified) return null;

  let finding = flag;
  if (flag.rule === 'silent-catch-block') {
    const fresh = relocateSilentCatchFlag(flag, cached.silentCatch);
    if (!fresh) { staleKeys.add(`${flag.rule}::${flag.file}::${flag.line}`); return null; }
    finding = {
      ...flag,
      line: fresh.line, detail: fresh.detail,
      blockStartLine: fresh.blockStartLine, blockEndLine: fresh.blockEndLine,
      bodyFingerprint: fresh.bodyFingerprint,
      confidence: fresh.confidence || flag.confidence,
    };
  }
  return { finding, content };
}

function nextObservabilityReviewTask({ repoRoot, pipelineDir, defaultDomain, taskIdExistsInQueue, coveragePath }) {
  const { sorted, getFile, projectTag, flags, flagsPath } = prepareObservabilityFlags({ repoRoot, pipelineDir, coveragePath });
  const staleKeys = new Set();
  const persistStaleAnd = makePersistStaleAnd(flags, flagsPath, staleKeys);

  for (const flag of sorted) {
    const resolved = resolveFinding(flag, getFile, staleKeys);
    if (!resolved) continue;
    const { finding, content } = resolved;

    // Low-confidence silent-catch findings are batched into a digest task, not one each.
    if (finding.confidence === 'low' && LOW_CONFIDENCE_MODE !== 'off') continue;

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

    // Coarser sibling (2026-09-15, bd-1788764340728): a prior review already dismissed
    // SOME finding for this same rule in this same directory as a false positive, even
    // though THIS finding's own exact snippet differs (a different catch block, same
    // structural reason it's a non-issue) -- the isSuppressed check above can never catch
    // this since it's keyed on exact snippet text. Skips the finding rather than paying
    // for a full plan+implement+review cycle to re-derive a verdict the cluster has
    // already, very likely, settled.
    if (finding.file && isClusterSuppressed(pipelineDir, finding.rule, path.dirname(finding.file))) continue;

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

// --- Task source: observability_review_digest (batches the low-confidence backlog) --------

function nextObservabilityReviewDigestTask({ repoRoot, pipelineDir, defaultDomain, taskIdExistsInQueue, coveragePath }) {
  if (LOW_CONFIDENCE_MODE === 'off') return null;
  const { sorted, getFile, projectTag, flags, flagsPath } = prepareObservabilityFlags({ repoRoot, pipelineDir, coveragePath });
  const staleKeys = new Set();
  const persistStaleAnd = makePersistStaleAnd(flags, flagsPath, staleKeys);

  // One digest per project per day. Skip the (potentially large) walk if today's exists.
  const digestId = `observability-digest-${slugifyForId(projectTag)}-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}`;
  if (taskIdExistsInQueue(digestId)) return persistStaleAnd(null);

  const low = [];
  for (const flag of sorted) {
    const resolved = resolveFinding(flag, getFile, staleKeys);
    if (!resolved) continue;
    const { finding, content } = resolved;
    if (finding.confidence !== 'low') continue;
    if (!content || !finding.file) continue;

    const snippet = windowFromContent(content, finding.line, SNIPPET_BEFORE, SNIPPET_AFTER);
    if (isSuppressed(pipelineDir, finding.rule, snippet)) continue;
    low.push({
      rule: finding.rule,
      file: finding.file,
      line: finding.line,
      detail: finding.detail,
      bodyFingerprint: finding.bodyFingerprint,
      scannedAt: finding.scannedAt,
      snippet,
      enclosingCode: windowFromContent(content, finding.line, 8, 6),
    });
  }

  if (low.length === 0) return persistStaleAnd(null);

  const batch = selectLowConfidenceBatch(low, LOW_CONFIDENCE_CAP)
    .map((item, i) => ({ n: i + 1, ...item }));

  return persistStaleAnd({
    id: digestId,
    domain: defaultDomain,
    source: 'observability_review_digest',
    title: `Observability triage digest: ${batch.length} low-confidence silent-catch finding(s) — ${projectTag}`,
    promptContext: { projectSlug: projectTag, items: batch },
  });
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
      // A verdict that produced no candidate and is not an explicit false positive:
      // track it, and after a few such tries stop the scanner re-emitting this construct.
      recordInconclusiveReview({ applyResult: res, implementResponse, task, pipelineDir });
      // Structured outcome for task-disposition.js (core): splits `dismissed` (a correct
      // false-positive triage) out of the `noop` grab-bag. Mutating `task` here is
      // persisted by apply-task.js after apply() returns.
      if (STAMP_REVIEW_DISPOSITION && task) {
        task.reviewDisposition = classifyReviewOutcome({ applyResult: res, implementResponse });
      }
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

  registerTaskSource('observability_review_digest', {
    priority: taskPriority('observability_review_digest', 78),
    next: () => {
      const { repoRoot, pipelineDir, defaultDomain, observabilityCoveragePath } = getConfig();
      return nextObservabilityReviewDigestTask({ repoRoot, pipelineDir, defaultDomain, taskIdExistsInQueue, coveragePath: observabilityCoveragePath });
    },
    apply: ({ implementResponse, task }) => {
      const { observabilityFixCandidatesPath, pipelineDir } = getConfig();
      const items = (task && task.promptContext && task.promptContext.items) || [];
      const verdicts = parseDigestVerdicts(implementResponse, items.length);
      let filed = 0;
      let dismissed = 0;
      for (const item of items) {
        const v = verdicts.get(item.n);
        if (!v) continue; // unparsed -- leave it; the finding recurs next cycle
        if (v.verdict === 'genuine') {
          const one = [
            `### AC-000 · silent-catch-block at ${item.file}:${item.line}`,
            'Strength: Moderate',
            `Files: ${item.file}`,
            '', 'Problem:',
            `A caught error is discarded with no operator visibility. ${item.detail} ${v.reason}`.trim(),
            '', 'Solution:',
            'Log the caught error (message + context) before the existing fallback/return; do not change control flow.',
            '', 'Benefits:',
            'An operator can tell a silent recovery from a real failure in the logs.',
          ].join('\n');
          const r = applyArchDiscoveryCandidates({
            implementResponse: one, candidatesPath: observabilityFixCandidatesPath,
            docTitle: '# Observability Fix Candidates', snippet: item.snippet,
          });
          if (r && !r.skipped) filed += 1;
        } else {
          const r = recordSuppression(pipelineDir, {
            rule: item.rule, file: item.file, snippet: item.snippet,
            taskId: task && task.id, cause: 'false-positive',
          });
          if (r && r.recorded) dismissed += 1;
        }
      }
      const aggregate = filed > 0 ? 'genuine' : (dismissed > 0 ? 'dismissed' : 'inconclusive');
      if (STAMP_REVIEW_DISPOSITION && task) task.reviewDisposition = aggregate;
      if (filed > 0) {
        return { skipped: false, reason: `observability digest: filed ${filed} candidate(s), dismissed ${dismissed}` };
      }
      return { skipped: true, reason: `observability digest: ${dismissed} finding(s) dismissed as FALSE POSITIVE, ${items.length - dismissed} unresolved` };
    },
    groundingFields: ['items'],
    advisoryProse: true,
    reviewGuidance: 'This is a BATCH observability triage. A valid draft is a list of exactly N lines, one per numbered block, each "<n>. GENUINE|FALSE POSITIVE — <short reason>". Approve if every block has a decisive verdict with a reason that is consistent with the block shown in the grounding `items`. Reject only if lines are missing, verdicts are absent/"uncertain", or a reason plainly contradicts its block.',
    reviewCompletenessQuestion: 'Does the draft give a decisive GENUINE/FALSE-POSITIVE verdict for every numbered block, each consistent with that block\'s code in the grounding?',
    directToMain: true,
    reportClass: (task) => {
      const text = (task.implementResponse || '').toLowerCase();
      if (text.includes('genuine')) return 'benefit';
      if (text.includes('false positive') || text.includes('false-positive')) return 'filtering';
      return 'unclear';
    },
  });
  updateTaskSource('observability_review_digest', { buildPlanPrompt: observabilityReviewDigestPlanPrompt, buildImplementPrompt: observabilityReviewDigestImplementPrompt });

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
  nextObservabilityReviewDigestTask,
  observabilityReviewPlanPrompt,
  observabilityReviewImplementPrompt,
  observabilityReviewDigestPlanPrompt,
  observabilityReviewDigestImplementPrompt,
  observabilityFixPlanPrompt,
  observabilityFixImplementPrompt,
};
