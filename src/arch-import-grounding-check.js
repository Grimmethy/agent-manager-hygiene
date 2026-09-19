'use strict';

// Post-implement grounding check for arch_import candidates (2026-09-05) -- the third
// occurrence this session of the same failure shape function-length-grounding-check.js
// and deep-dive-grounding-check.js already closed for their own sources: "the draft
// fabricates/cites X, but the real grounding source shows Y". Real examples from the
// blocked backlog: "the draft's core premise is fabricated -- it claims ADR-0019 and
// ADR-0022 describe the gate as 'a single vote per reviewer'..."; "the draft targets
// `src/agent-manager/task-queue.js`, which the deterministic fact-check confirms does not
// exist"; "the draft cites specific line numbers (e.g., `src/review-runner.ps1` line 592,
// ...) and specific code content... [that does not match]".
//
// arch_import (the base generator, this file's own register()) is a DIFFERENT source from
// its sibling arch_import_review, which already got a premiseCheck gate after the AC-8
// incident (arch-import-premise-check.js) -- but that gate only runs at arch_import_review's
// candidate-fulfillment split point, never for arch_import's own initial candidate write-up.
// archImportImplementPrompt's real grounding lives in task.promptContext.harnessFiles (the
// harness-searched agent-manager files the plan's QUERY: terms actually matched) -- this
// checks the write-up against THAT, the same way the other two check against their own
// source's real fetched content.
//
// Same deterministic-first / cheap-model-fallback shape as its two siblings. Check 1 is
// free: a class/module-shaped PascalCase or path-shaped backtick citation absent from every
// real harnessFiles content is a fabrication, not a judgment call. Check 2 (cheap
// qwen2.5:3b call) is the semantic fallback for a contradiction Check 1 cannot catch (a
// real file/symbol cited alongside an invented line number, behavior, or relationship).
//
// Wired via the generic, source-agnostic `postImplementCheck` hook (agent-manager core) --
// same convention as premiseCheck; an 'ungrounded' verdict routes into the exact same
// blockedStage:'review' path a real review rejection takes.
//
// Kill switch: AGENT_MANAGER_ARCH_IMPORT_GROUNDING_CHECK=false.

const { call: localCall } = require('agent-manager/src/local-client.js');
const { getConfig } = require('agent-manager/src/config.js');
const {
  extractFilesLine, checkCitedPaths, formatFabricatedReason,
  checkCitedSymbolsPerEntry, formatFabricatedSymbolsReason, symbolCheckBlocks, formatSymbolWarnings,
} = require('agent-manager/src/candidate-path-grounding.js');

const GROUNDING_CHECK_MODEL = process.env.AGENT_MANAGER_ARCH_IMPORT_GROUNDING_MODEL || 'qwen2.5:3b';
const GROUNDING_CHECK_NUM_CTX = 8192;

function isEnabled() {
  return process.env.AGENT_MANAGER_ARCH_IMPORT_GROUNDING_CHECK !== 'false';
}

function clip(s, n) {
  const str = String(s || '');
  return str.length > n ? `${str.slice(0, n)}\n...[truncated]` : str;
}

function realFilesOf(task) {
  const files = (task.promptContext && task.promptContext.harnessFiles) || [];
  return Array.isArray(files) ? files.filter((f) => f && typeof f.content === 'string') : [];
}

// --- Check 1: a backtick-quoted, class/module-shaped identifier absent from every real --
// harness-fetched file. Same PascalCase-or-path shape as deep-dive-grounding-check.js's own
// CLASS_SHAPED_SYMBOL_RE, extended to also catch a cited `src/...` path (the other real
// incident shape: a fabricated file path the fact-check independently confirmed absent).
const CITED_SYMBOL_RE = /`([A-Z][A-Za-z0-9]{3,}|(?:src|python|scripts|lib|docs)\/[\w./-]+\.\w{1,5})`/g;

function checkFabricatedCitations(task, implementResponse) {
  const files = realFilesOf(task);
  if (!files.length) return [];
  const combined = files.map((f) => f.content).join('\n');
  const realPaths = new Set(files.map((f) => f.path));
  const seen = new Set();
  const contradictions = [];
  let m;
  CITED_SYMBOL_RE.lastIndex = 0;
  while ((m = CITED_SYMBOL_RE.exec(implementResponse))) {
    const cited = m[1];
    if (seen.has(cited)) continue;
    seen.add(cited);
    const looksLikePath = cited.includes('/');
    const grounded = looksLikePath ? realPaths.has(cited) : combined.includes(cited);
    if (!grounded) {
      contradictions.push({
        kind: 'fabricated-citation',
        detail: looksLikePath
          ? `the draft cites \`${cited}\` as a real file, but that path is not among the files the harness search actually found`
          : `the draft cites \`${cited}\`, but that name does not appear anywhere in the real fetched content of any harness-matched file`,
      });
    }
  }
  return contradictions;
}

// --- Check 2: cheap-model fallback for a contradiction Check 1 cannot catch -------------
function buildGroundingCheckPrompt(task, implementResponse) {
  const files = realFilesOf(task);
  const filesBlock = files.map((f) => `--- ${f.path} ---\n${clip(f.content, 3000)}`).join('\n\n');
  return [
    'A candidate proposes importing an idea into a codebase, grounded in specific real files a search already found. You are given the REAL content of every matched file. Judge ONLY whether the candidate\'s specific factual claims (file names, line numbers, code content, existing behavior) accurately describe the real files -- do not judge whether the idea itself is good.',
    '',
    '--- CANDIDATE ---',
    clip(implementResponse, 4000),
    '',
    '--- REAL FILE CONTENT ---',
    filesBlock ? clip(filesBlock, 8000) : '(no files fetched)',
    '',
    'Output EXACTLY one of:',
    '  GROUNDED',
    'or:',
    '  NOT_GROUNDED -- <one sentence citing the real file content that contradicts a specific claim>',
    'Nothing else.',
  ].join('\n');
}

function parseGroundingVerdict(text) {
  const firstLine = (String(text || '').split('\n').find((l) => l.trim()) || '').trim();
  if (/^GROUNDED\b/i.test(firstLine)) return { verdict: 'ok' };
  const m = firstLine.match(/^NOT_GROUNDED\b\s*[-:]*\s*(.*)$/i);
  if (m) return { verdict: 'ungrounded', reason: m[1].trim().slice(0, 300) || '(no detail given)' };
  return { verdict: 'ok' }; // non-conforming 3b output -- same "0 survivors -> ok" rule as its siblings
}

// task, implementResponse, { call?, maybeLockedOn } -> { verdict: 'ok'|'ungrounded', reason? }
async function runGroundingCheck(task, implementResponse, opts = {}) {
  const warnings = [];
  const verdict = await runChecks(task, implementResponse, opts, warnings);
  // Symbol findings are advisory (see candidate-path-grounding.js symbolCheckBlocks): carried
  // to the review votes on an otherwise-ok draft, never on a blocked one.
  return warnings.length && verdict.verdict === 'ok' ? { ...verdict, warnings } : verdict;
}

async function runChecks(task, implementResponse, { call = localCall, maybeLockedOn } = {}, warnings) {
  if (!isEnabled()) return { verdict: 'ok' };
  const text = String(implementResponse || '');
  if (!text.trim()) return { verdict: 'ok' }; // a legitimate "nothing applies" empty draft -- nothing to check

  // Check 0 (concept-candidate-grounding-gate-3e9bec): the candidate's `Files:` line names
  // a path that resolves NOWHERE in agent-manager (arch_import cites this repo's own files,
  // so getConfig().repoRoot is the right target). Distinct "fabricated file path(s)" reason
  // -> blocked-task-classifiers.js's `fabricated-file-path` classifier makes it
  // NON-retryable (a blind redraft only re-invents it). Advisory: a getConfig() failure
  // just skips it and falls through to the citation/semantic checks below.
  try {
    const { repoRoot, grepAllowedDirs } = getConfig();
    const { fabricated: badPaths } = checkCitedPaths(extractFilesLine(text), repoRoot, grepAllowedDirs || []);
    if (badPaths.length) return { verdict: 'ungrounded', reason: formatFabricatedReason(badPaths) };
    // Check 0b (same needs-clarification bd-1788994211702 as candidate-path-grounding.js's
    // own header): the Files: line resolved to a real file, but does a backtick-quoted
    // symbol the write-up cites actually appear in it? Deterministic grep, same
    // non-retryable treatment as Check 0 above WHEN AGENT_MANAGER_SYMBOL_CHECK_BLOCKING=true; by
    // default it only WARNS (see candidate-path-grounding.js symbolCheckBlocks).
    const { fabricated: badSymbols } = checkCitedSymbolsPerEntry(text, repoRoot, grepAllowedDirs || []);
    if (badSymbols.length) {
      if (symbolCheckBlocks()) return { verdict: 'ungrounded', reason: formatFabricatedSymbolsReason(badSymbols) };
      warnings.push(...formatSymbolWarnings(badSymbols));
    }
  } catch { /* can't resolve the repo -- fall through */ }

  const fabricated = checkFabricatedCitations(task, text);
  if (fabricated.length) return { verdict: 'ungrounded', reason: fabricated[0].detail };

  if (!realFilesOf(task).length) return { verdict: 'ok' }; // nothing real to ground a model check against either

  const prompt = buildGroundingCheckPrompt(task, text);
  const fn = () => call({
    prompt, model: GROUNDING_CHECK_MODEL, numCtx: GROUNDING_CHECK_NUM_CTX,
    think: false, temperature: 0.2, numPredict: 300, source: task.source,
  });
  let result;
  try {
    result = maybeLockedOn ? await maybeLockedOn(GROUNDING_CHECK_MODEL, fn, 'arch-import-grounding') : await fn();
  } catch (e) {
    return { verdict: 'ok', error: String((e && e.message) || e).slice(0, 160) }; // advisory -- never blocks on a model-call failure
  }
  if (result && result.degenerate) return { verdict: 'ok' };
  return parseGroundingVerdict(result && result.response);
}

module.exports = {
  runGroundingCheck,
  checkFabricatedCitations,
  buildGroundingCheckPrompt,
  parseGroundingVerdict,
};
