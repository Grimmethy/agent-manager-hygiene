'use strict';

// unused_export / deadcode_fix -- two-stage shape (2026-09-24, mirroring
// function_length_review/function_length_fix and arch_discovery/arch_review). Extracted
// from agent-manager's src/task-sources.js (2026-08-27, Phase 2). unused_export reads
// <pipelineDir>/queue/dead-code-flags.json (written by the sibling unused-export-scan.js
// CLI) and turns the oldest not-yet-in-flight entry into a judgment-verdict task --
// "genuine dead code vs. false positive (barrel re-export, factory pattern, ...)". A
// GENUINE verdict now writes a real, vetted `### AC-NNN` candidate to
// Docs/DEAD_CODE_CANDIDATES.md (directToMain: additive doc append, low-risk); deadcode_fix
// (the generic candidateFulfillment consumer) turns that candidate into a real removal
// diff on an agent/<id> branch a human merges. Before this, the verdict text was thrown
// away entirely by applyVerdictOnly -- even a confident "safe to remove" call had nowhere
// to go (see git history for the prior applyVerdictOnly-only shape).
//
// The task stamps source: 'deadcode_triage'; agent-manager's task-source-registry.js
// resolveSourceName() maps that back to the 'unused_export' registry key.

const { hygieneFamily } = require('./hygiene-family.js');
const path = require('path');
const fs = require('fs');
const { registerTaskSource, updateTaskSource, registerSourceAlias } = require('agent-manager/src/task-source-registry.js');
const { applyArchDiscoveryCandidates } = require('agent-manager/src/candidate-docs.js');
const { unusedExportPlanPrompt, unusedExportImplementPrompt, archReviewPlanPrompt, archReviewImplementPrompt } = require('agent-manager/src/prompts.js');
const { buildFlagInventory } = require('./flag-inventory.js');
const { countSameFileUses, buildFileCorpus, fileImporters, FILE_FLAG_SYMBOL } = require('./unused-export-scan.js');

function deadCodeCandidatesPath(repoRoot) {
  return process.env.AGENT_MANAGER_DEAD_CODE_CANDIDATES_PATH || path.join(repoRoot, 'Docs', 'DEAD_CODE_CANDIDATES.md');
}

const DEAD_CODE_REVIEW_GUIDANCE = 'This is a dead-code triage verdict for a low-usage export in OUR OWN project, NOT itself a code change. The task shows the defining file\'s source (SOURCE EXCERPT) and the call sites found. A valid draft is EXACTLY ONE of: (a) "GENUINE" + a correctly-formatted `### AC-NNN` candidate block (Strength: Strong / Files / Problem / Solution / Benefits) describing exactly what to remove; or (b) "FALSE POSITIVE" / "UNCERTAIN" + one short paragraph (2-4 sentences) explaining why, grounded in the source or call sites shown. A grounded UNCERTAIN -- one that names a concrete observation about the SHOWN source or call sites (for example a dynamic lookup, a re-export or a convention the shown material hints at) and says what would settle it -- is a valid, decisive verdict; do NOT reject it as hedging or refusal. There is deliberately NO diff, no code, and no "steps" here -- do NOT reject the draft for lacking them. REJECT only if: the draft gives no verdict at all (it only says "a human should look"); a GENUINE verdict\'s candidate block is malformed or missing a required section; a GENUINE verdict\'s Solution proposes removing something broader than this one symbol (or, for a WHOLE-FILE task, broader than this one file); or the stated reason is speculation not tied to the shown material, or actually contradicts it (e.g. claims a barrel re-export exists when none of the shown sites or the shown source is one).';
const DEAD_CODE_REVIEW_COMPLETENESS_QUESTION = 'Does the draft reach a decisive verdict -- GENUINE, FALSE POSITIVE, or a grounded UNCERTAIN that cites something concrete in the shown source or call sites -- and, if GENUINE, is it followed by a well-formed `### AC-NNN` candidate block whose Solution is scoped to removing exactly this one symbol (and its real call sites, if any) -- or, for a whole-file task, deleting exactly this one file?';

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

// Stale-flag guard (brain-dump #1742). queue/dead-code-flags.json is only rewritten by the next scan (24h throttle), so it
// can still hold entries written before the scanner learned to skip symbols that are used inside their own file. Such an
// entry is not dead code and must never become a triage task. FAIL OPEN: an unreadable file, a definedIn recorded
// relative to a different root, or anything unexpected keeps the entry. No cache: the generator runs as a fresh
// `node task-sources.js` on every worker tick, so a module-level memo would never survive between ticks.
function usedInsideOwnFile(repoRoot, entry) {
  try {
    const text = fs.readFileSync(path.join(repoRoot, entry.definedIn), 'utf8');
    return countSameFileUses(text, entry.symbol) > 0;
  } catch {
    return false;
  }
}

// ---- source excerpt for the triage prompts and the reviewers' grounding ----------------------------------------------------
// The drafter and the reviewers used to see only a symbol name and call-site lines, never the file the symbol lives in, so
// they could not tell a used-in-file helper or a dynamic lookup from dead code. buildSourceContext renders a bounded,
// line-numbered excerpt plus the files that name the module. Pure and FAIL OPEN: any failure returns '' (the task is then
// created exactly as before); a failing importer walk drops only the importer line.
const SOURCE_CONTEXT_MAX_CHARS = 6000;
const SOURCE_WINDOW_LINES = 40;
const FILE_EXCERPT_HEAD_LINES = 60;
const IMPORTER_LIST_MAX = 8;
const EXPORT_LINE_RE = /^\s*(?:export\b|module\.exports\b|exports\.[A-Za-z_$])/;

function numberLines(lines, from) {
  return lines.map((l, i) => `${from + i + 1}: ${l}`);
}

function excerptLines(text, entry) {
  const lines = text.replace(/\s+$/, '').split('\n');
  if (isFileEntry(entry)) {
    const head = lines.slice(0, FILE_EXCERPT_HEAD_LINES);
    const out = numberLines(head, 0);
    const exportLines = [];
    lines.forEach((l, i) => { if (i >= FILE_EXCERPT_HEAD_LINES && EXPORT_LINE_RE.test(l)) exportLines.push(`${i + 1}: ${l}`); });
    if (lines.length > FILE_EXCERPT_HEAD_LINES) out.push('...', ...exportLines);
    return out;
  }
  if (text.length <= SOURCE_CONTEXT_MAX_CHARS) return numberLines(lines, 0);
  const re = new RegExp(`\\b${String(entry.symbol).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
  let def = lines.findIndex((l) => re.test(l));
  if (def < 0) def = 0;
  const from = Math.max(0, def - SOURCE_WINDOW_LINES);
  const to = Math.min(lines.length, def + SOURCE_WINDOW_LINES + 1);
  const keep = new Set();
  for (let i = from; i < to; i++) keep.add(i);
  lines.forEach((l, i) => { if (EXPORT_LINE_RE.test(l)) keep.add(i); });
  const out = [];
  let prev = -2;
  for (const i of [...keep].sort((a, b) => a - b)) {
    if (i !== prev + 1) out.push('...');
    out.push(`${i + 1}: ${lines[i]}`);
    prev = i;
  }
  return out;
}

// fileImporters matches on the file stem, so `require('../parsers')` never names `parsers/index.js`. For an index file also match
// on the directory name (a directory import), via a pseudo path whose stem is the directory.
function modulePathImporters(abs, corpus) {
  const hits = new Set(fileImporters(abs, corpus));
  if (/^index\.[^.]+$/.test(path.basename(abs))) {
    const dir = path.dirname(abs);
    for (const f of fileImporters(path.join(dir, path.basename(dir) + path.extname(abs)), corpus)) if (f !== abs) hits.add(f);
  }
  return [...hits];
}

function buildSourceContext(repoRoot, entry, { pipelineDir = null } = {}) {
  try {
    const abs = path.join(repoRoot, entry.definedIn);
    const text = fs.readFileSync(abs, 'utf8');
    let body = excerptLines(text, entry).join('\n');
    if (body.length > SOURCE_CONTEXT_MAX_CHARS) body = body.slice(0, SOURCE_CONTEXT_MAX_CHARS) + '\n[truncated]';
    const out = [`SOURCE EXCERPT of ${entry.definedIn} (the file the symbol is defined in) --`, body];
    try {
      const names = modulePathImporters(abs, buildFileCorpus(repoRoot, { pipelineDir }))
        .map((f) => path.relative(repoRoot, f)).sort();
      const shown = names.slice(0, IMPORTER_LIST_MAX).join(', ');
      out.push(names.length
        ? `Files that name this module: ${shown}${names.length > IMPORTER_LIST_MAX ? ` (+${names.length - IMPORTER_LIST_MAX} more)` : ''}`
        : 'Files that name this module: none found');
    } catch { /* corpus walk failed: omit only this line */ }
    return out.join('\n');
  } catch {
    return '';
  }
}

function nextUnusedExportTask({ getConfig, taskIdExistsInQueue }) {
  const { pipelineDir, defaultDomain, repoRoot } = getConfig();
  const flagsPath = path.join(pipelineDir, 'queue', 'dead-code-flags.json');
  let entries;
  try {
    const raw = readIfExists(flagsPath);
    if (!raw) return null;
    entries = JSON.parse(raw);
  } catch {
    return null;
  }

  entries.sort((a, b) => new Date(a.scannedAt) - new Date(b.scannedAt));

  for (const entry of entries) {
    const taskId = taskIdForEntry(entry);
    if (taskIdExistsInQueue(taskId)) continue;
    if (isFileEntry(entry)) {
      if (fileEntryIsStale(repoRoot, entry)) continue;
      return {
        id: taskId,
        domain: defaultDomain,
        source: 'deadcode_triage',
        title: `Triage whole-file dead-code candidate: ${entry.definedIn} (${(entry.exports || []).length} export(s), no importer)`,
        promptContext: {
          kind: 'file',
          symbol: FILE_FLAG_SYMBOL,
          definedIn: entry.definedIn,
          exports: entry.exports || [],
          callSites: [],
          sourceContext: buildSourceContext(repoRoot, entry, { pipelineDir }),
          note: 'Judge genuine-dead vs false-positive for the WHOLE FILE (loaded by a convention, glob or loader the search cannot see, or deliberately kept). Use a majority-vote judgment, not a single verdict.',
        },
      };
    }
    if (usedInsideOwnFile(repoRoot, entry)) continue;

    return {
      id: taskId,
      domain: defaultDomain,
      source: 'deadcode_triage',
      title: `Triage dead-code candidate: ${entry.symbol} (defined in ${entry.definedIn}) — ${entry.callSites.length} call site(s) found`,
      promptContext: {
        symbol: entry.symbol,
        definedIn: entry.definedIn,
        callSites: entry.callSites,
        sourceContext: buildSourceContext(repoRoot, entry, { pipelineDir }),
        note: 'Judge genuine-dead vs false-positive (barrel/re-export, factory pattern, etc.). Use a majority-vote judgment, not a single verdict.',
      },
    };
  }

  return null;
}

// A flag entry is either one export (the original shape) or, since brain-dump #1752, a WHOLE FILE: { kind: 'file', symbol: '(file)',
// exports: [...] }. ONE id formula for the generator and the inventory so they cannot drift.
function isFileEntry(entry) {
  return Boolean(entry) && entry.kind === 'file';
}
function taskIdForEntry(entry) {
  return isFileEntry(entry)
    ? `deadcode-file-${slugifyForId(entry.definedIn)}`
    : `deadcode-${slugifyForId(entry.symbol)}-${slugifyForId(entry.definedIn)}`;
}

// Stale-flag guard for a whole-file entry (same fail-open rule as usedInsideOwnFile): stale when the file is gone or something now
// imports it. Anything unexpected keeps the entry. Builds a fresh corpus on purpose -- the generator is a fresh `node` per tick and
// only reaches this for a file entry.
function fileEntryIsStale(repoRoot, entry) {
  try {
    const abs = path.join(repoRoot, entry.definedIn);
    if (!fs.existsSync(abs)) return true;
    return fileImporters(abs, buildFileCorpus(repoRoot)).length > 0;
  } catch {
    return false;
  }
}

// ---- whole-file triage prompts (brain-dump #1752) ------------------------------------------------------------------------
// The per-export prompts (agent-manager core prompts.js) say "remove the export itself", which is the wrong ask for a dead file.
// These are used only for kind:'file' tasks; everything else is delegated to core unchanged.
function fileLevelPlanPrompt(task) {
  const ctx = task.promptContext;
  return [
    'This is a judgment call, NOT a code-change task (yet). Determine whether the WHOLE FILE shown below is genuinely dead code or a false positive.',
    'The scanner found NO module specifier, script or config anywhere in the project that names this file, and NO call site for any of its exports. Judge what that search cannot see: a framework convention that loads the file by location (routes/pages), a directory loader, a bundler glob, a documented public entry point, or an intentionally kept UI-kit/scaffold file you would want to keep for later.',
    'Write a numbered PLAN that is actually a REASONED VERDICT:',
    '- "GENUINE -- here\'s why this whole file is really unused and safe to delete"',
    '- "FALSE POSITIVE -- here\'s why it is loaded some way the search cannot see"',
    '- "UNCERTAIN -- here\'s what would need to be checked that isn\'t given here"',
    'A file that holds several exports is judged as ONE unit: the verdict is for the file, never for one export of it.',
    '',
    `File: ${ctx.definedIn}`,
    `Exports in this file (all unused): ${(ctx.exports || []).join(', ') || '(none listed)'}`,
    '',
    ...(ctx.sourceContext ? [ctx.sourceContext, ''] : []),
    'NOTE (verbatim from task source):',
    ctx.note || '',
  ].join('\n');
}

function fileLevelImplementPrompt(task, planText) {
  const ctx = task.promptContext;
  return [
    'Your plan above is the final REASONED VERDICT for this WHOLE-FILE dead-code candidate in OUR OWN project.',
    '',
    planText,
    '',
    'If the verdict is FALSE POSITIVE or UNCERTAIN: write ONE short paragraph (2-4 sentences) recording why, for a human to read later. Plain prose only -- no JSON, no code fence, no "steps", no candidate block.',
    '',
    'If the verdict is GENUINE: write ONE removal candidate for the whole file, in EXACTLY this format (must match this parser exactly or it cannot be consumed downstream):',
    '',
    '### AC-NNN · Remove unused file <path>',
    'Strength: Strong',
    `Files: ${ctx.definedIn}`,
    '',
    'Problem:',
    'A paragraph describing why this whole file is genuinely dead, grounded in the fact that no import, script or config names it and none of its exports is used.',
    '',
    'Solution:',
    `A paragraph saying to DELETE the file ${ctx.definedIn} entirely with a single delete action, and to change nothing else (no other file references it).`,
    '',
    'Benefits:',
    'A paragraph describing what improves once removed (no unused scaffold for a future reader to puzzle over, no half-removed component).',
    '',
    '(Pick an AC-NNN number that looks reasonable; the harness re-derives the real one deterministically regardless of what you write here.)',
  ].join('\n');
}

// Per-export tasks keep the core prompts byte for byte and only gain the source block appended (core's prompt says "both shown
// below" but prints no source); kind:'file' tasks get the file-level pair, which prints the block itself.
function withSourceContext(prompt, task) {
  const block = task && task.promptContext && task.promptContext.sourceContext;
  return block ? `${prompt}\n\n${block}` : prompt;
}
function buildPlanPromptFor(task) {
  return isFileEntry(task && task.promptContext) ? fileLevelPlanPrompt(task) : withSourceContext(unusedExportPlanPrompt(task), task);
}
function buildImplementPromptFor(task, planText) {
  return isFileEntry(task && task.promptContext) ? fileLevelImplementPrompt(task, planText) : withSourceContext(unusedExportImplementPrompt(task, planText), task);
}

// Read-only inventory for the dashboard's Hygiene tab (see flag-inventory.js). Same id formula as nextUnusedExportTask.
function unusedExportInventory({ pipelineDir, repoRoot, taskState }) {
  let entries;
  try { entries = JSON.parse(readIfExists(path.join(pipelineDir, 'queue', 'dead-code-flags.json')) || '[]'); } catch { entries = []; }
  const flags = (Array.isArray(entries) ? entries : []).map((e) => ({
    rule: 'unused-export', file: e.definedIn, line: 0, scannedAt: e.scannedAt,
    detail: isFileEntry(e) ? `whole file -- ${(e.exports || []).length} export(s), no importer` : `${e.symbol} -- ${(e.callSites || []).length} call site(s)`,
    _entry: e,
  }));
  return buildFlagInventory({
    flags, projectTag: null, repoRoot, taskState,
    idFor: (f) => taskIdForEntry(f._entry),
  });
}

function register({ getConfig, nextCandidateFulfillmentTask, taskIdExistsInQueue, taskPriority }) {
  registerTaskSource('unused_export', {
    hygieneFamily: hygieneFamily('unused_export'),
    priority: taskPriority('unused_export', 90),
    next: () => nextUnusedExportTask({ getConfig, taskIdExistsInQueue }),
    inventory: ({ taskState }) => {
      const { repoRoot, pipelineDir } = getConfig();
      return unusedExportInventory({ repoRoot, pipelineDir, taskState });
    },
    apply: ({ implementResponse }) => {
      const { repoRoot } = getConfig();
      return applyArchDiscoveryCandidates({
        implementResponse,
        candidatesPath: deadCodeCandidatesPath(repoRoot),
        docTitle: '# Dead Code Removal Candidates',
      });
    },
    // No emptyApproval (same reasoning as function_length_fix's own candidate-doc source):
    // a FALSE POSITIVE/UNCERTAIN verdict legitimately writes no candidate -- that's a real,
    // expected outcome here (applyArchDiscoveryCandidates returns {skipped:true} for it),
    // not something that needs an auto-approve exemption.
    directToMain: true, // additive candidate-doc append, same reasoning as arch_discovery/function_length_review
    reviewGuidance: DEAD_CODE_REVIEW_GUIDANCE,
    reviewCompletenessQuestion: DEAD_CODE_REVIEW_COMPLETENESS_QUESTION,
    // Grounds the reviewer in the same real call-site data and source excerpt the drafter saw -- same
    // reasoning as function_length_review's `groundingFields: ['snippet']`.
    groundingFields: ['callSites', 'sourceContext'],
    reportClass: 'benefit', // a surfaced, human-reviewed dead-code candidate is a real outcome (system-report.js)
  });
  updateTaskSource('unused_export', { buildPlanPrompt: buildPlanPromptFor, buildImplementPrompt: buildImplementPromptFor });
  // Generated tasks stamp source: 'deadcode_triage' (not 'unused_export') -- declare that
  // here rather than relying on agent-manager's legacy hardcoded fallback in
  // resolveSourceName(). Guarded: registerSourceAlias landed in agent-manager Stage A1;
  // an older core still has the hardcoded fallback, so this is belt-and-suspenders.
  if (typeof registerSourceAlias === 'function') registerSourceAlias('deadcode_triage', 'unused_export');

  // deadcode_fix -- consumer of unused_export's vetted candidates, generic
  // nextCandidateFulfillmentTask (same shared consumer arch_review/function_length_fix/
  // performance_fix all reuse). Priority higher (lower number) than unused_export's own
  // 90, same "consumer outranks its own generator" convention as every other review/fix
  // pair in this file (e.g. function_length_fix:72 vs function_length_review:80).
  registerTaskSource('deadcode_fix', {
    hygieneFamily: hygieneFamily('unused_export', { candidateDoc: true }),
    priority: taskPriority('deadcode_fix', 82),
    next: () => {
      const { repoRoot } = getConfig();
      return nextCandidateFulfillmentTask(deadCodeCandidatesPath(repoRoot), 'deadcode_fix');
    },
    // A vetted "safe to remove" candidate legitimately resolving to "nothing to change
    // after all" is rare -- an empty draft here is far more likely the model giving up or
    // the code having moved since triage. Reject -> retry -> block for a human, same
    // reasoning as function_length_fix's own no-emptyApproval comment.
    candidateFulfillment: true,
    // A single-symbol removal is already maximally scoped -- no reason to let it
    // recursively re-split (same reasoning/incident class as function_length_fix's
    // noCandidateSplit).
    noCandidateSplit: true,
    candidatesPath: () => deadCodeCandidatesPath(getConfig().repoRoot),
    candidateDocTitle: '# Dead Code Removal Candidates',
    reasoningTier: 'high',
    // NOT directToMain -- this is a real code deletion (the export and, potentially, its
    // call sites), so it gets the normal agent/<id> branch + human-merge path every other
    // actual code-editing fix source uses.
  });
  updateTaskSource('deadcode_fix', { buildPlanPrompt: archReviewPlanPrompt, buildImplementPrompt: archReviewImplementPrompt });
}

module.exports = { register, nextUnusedExportTask, unusedExportInventory, taskIdForEntry, fileEntryIsStale, buildPlanPromptFor, buildImplementPromptFor, buildSourceContext };
