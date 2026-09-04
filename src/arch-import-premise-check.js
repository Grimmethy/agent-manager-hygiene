'use strict';

// Premise-verification gate for arch_import candidates (2026-09-04). AC-8 claimed
// review-task.js "each decide their own field names for the verdict" -- false, all of
// its `return` statements draw from the same small vocabulary of field names. Nothing
// checked that before `arch_import_review` split it into 3 children (AC-9/10/11); AC-9
// then burned 2 draft retries against a premise that was never true (once hallucinating
// fake shell variables to satisfy an instruction whose premise didn't hold, once giving
// up with an empty plan) before landing in queue/blocked/. Corpus check shows this isn't
// unique to AC-8: other arch_import candidates cite source-code locations for symbols
// that aren't there.
//
// Same deterministic-first / cheap-model-fallback shape plan-critique.js (agent-manager
// core) already established for adhoc plans: two cheap, deterministic checks against
// content the candidate already fetched (no fresh grep, no I/O) settle the common case
// with zero model calls; a qwen2.5:3b call on its own GPU lock key is the fallback only
// for a claim that's checkable but not settled deterministically. Wired into
// finalizeCandidateFulfillment (agent-manager core, PR #96) via the generic, source-
// agnostic `premiseCheck` registry field -- runs once, right before a `{"mode":"split"}`
// response is honored, so a false premise never fans out into child candidates.
//
// Kill switch: AGENT_MANAGER_ARCH_IMPORT_PREMISE_CHECK=false.

const { call: localCall } = require('agent-manager/src/local-client.js');

const PREMISE_CHECK_MODEL = process.env.AGENT_MANAGER_ARCH_IMPORT_PREMISE_MODEL || 'qwen2.5:3b';
const PREMISE_CHECK_NUM_CTX = 8192;

function isEnabled() {
  return process.env.AGENT_MANAGER_ARCH_IMPORT_PREMISE_CHECK !== 'false';
}

function clip(s, n) {
  const str = String(s || '');
  return str.length > n ? `${str.slice(0, n)}\n...[truncated]` : str;
}

function fetchedFilesOf(task) {
  return (task.promptContext && task.promptContext.fetchedFiles) || [];
}

function fetchedContentFor(task, relPath) {
  const hit = fetchedFilesOf(task).find((f) => f && f.path === relPath);
  return hit ? String(hit.content || '') : null;
}

// --- Check 1: citation existence ---------------------------------------------------------
// "cites `src/local-agentic-draft.js:63` as a location referencing `INFRA_FAILURE_PATTERN`,
// but--" (arch-import-omnigent-ai-omnigent-28). A path citation followed, within the same
// sentence, by a backtick-quoted symbol -- check the symbol actually appears in that file's
// real fetched content. Cheap, high-confidence: a cited symbol absent from its own cited
// file is fabricated, not a judgment call.
const CITED_PATH_RE = /`((?:src|python|scripts|lib|docs)\/[\w./-]+\.\w{1,5})(?::\d+)?`/g;
const CITATION_WINDOW_CHARS = 220;
const CITED_SYMBOL_RE = /`([A-Za-z_][A-Za-z0-9_]{3,}\(?)`/g;

function checkCitations(task, body) {
  const contradictions = [];
  if (!fetchedFilesOf(task).length) return contradictions;
  let pm;
  CITED_PATH_RE.lastIndex = 0;
  while ((pm = CITED_PATH_RE.exec(body))) {
    const relPath = pm[1];
    const content = fetchedContentFor(task, relPath);
    if (content === null) continue; // file wasn't fetched -- nothing to check
    const window = body.slice(pm.index, pm.index + CITATION_WINDOW_CHARS);
    CITED_SYMBOL_RE.lastIndex = 0;
    let sm;
    while ((sm = CITED_SYMBOL_RE.exec(window))) {
      const symbol = sm[1].replace(/\($/, '');
      if (symbol === relPath || relPath.endsWith(`/${symbol}`)) continue; // the path token itself
      if (!content.includes(symbol)) {
        contradictions.push({
          kind: 'missing-citation',
          detail: `candidate cites \`${symbol}\` in ${relPath}, but that name does not appear anywhere in the real fetched content of ${relPath}`,
        });
      }
    }
  }
  return contradictions;
}

// --- Check 2: uniformity / "each does it differently" claim -----------------------------
// AC-8's shape: a claim that a file's output is "ad hoc" / inconsistent / different-per-
// caller. Extract every `return { ... }` object literal in the cited file(s) and check
// whether they draw from a small, SHARED vocabulary of field names -- if the count of
// return sites clearly exceeds the number of distinct field names used across all of
// them, that is genuine, cheap evidence of reuse, directly contradicting "each uses its
// own ad-hoc names". Non-nested, one-level object literals only (matches this codebase's
// own style) -- a miss just means the check doesn't fire, never a false contradiction.
const UNIFORMITY_CLAIM_RE = /\beach\b[^.\n]{0,60}\b(?:own|differently|different)\b|\bno shared\b|\bad[- ]?hoc\b|\binconsistent\b/i;
const RETURN_OBJECT_RE = /return\s*\{([^{}]*)\}/g;
const MIN_RETURN_SITES = 3;

function extractReturnKeyUnion(content) {
  const keyUnion = new Set();
  let count = 0;
  RETURN_OBJECT_RE.lastIndex = 0;
  let m;
  while ((m = RETURN_OBJECT_RE.exec(content))) {
    count += 1;
    for (const k of m[1].matchAll(/([A-Za-z_$][\w$]*)\s*:/g)) keyUnion.add(k[1]);
  }
  return { count, keyUnion };
}

function checkUniformityClaim(task, body) {
  if (!UNIFORMITY_CLAIM_RE.test(body)) return [];
  const contradictions = [];
  for (const f of fetchedFilesOf(task)) {
    if (!f || !f.content) continue;
    const { count, keyUnion } = extractReturnKeyUnion(f.content);
    if (count >= MIN_RETURN_SITES && keyUnion.size > 0 && keyUnion.size < count) {
      contradictions.push({
        kind: 'uniform-return',
        detail: `candidate's Problem claims inconsistent/ad-hoc output, but ${f.path} has ${count} \`return { ... }\` statements drawing from a shared vocabulary of only ${keyUnion.size} field name(s) (${[...keyUnion].sort().join(', ')}) -- contradicts the claimed inconsistency`,
      });
    }
  }
  return contradictions;
}

// { contradictions: [{kind, detail}] }. Pure, deterministic, no model, no I/O beyond
// what's already in promptContext.fetchedFiles.
function computePremiseEvidence(task) {
  const body = String((task.promptContext && task.promptContext.body) || '');
  return { contradictions: [...checkCitations(task, body), ...checkUniformityClaim(task, body)] };
}

// Whether the candidate makes ANY claim shape this module knows how to check at all --
// used to skip the model fallback for the common candidate that makes no checkable
// negative/citation claim (most of them).
function hasCheckableClaim(task) {
  const body = String((task.promptContext && task.promptContext.body) || '');
  CITED_PATH_RE.lastIndex = 0;
  return UNIFORMITY_CLAIM_RE.test(body) || CITED_PATH_RE.test(body);
}

function buildPremiseCheckPrompt(task) {
  const body = String((task.promptContext && task.promptContext.body) || '');
  const filesBlock = fetchedFilesOf(task)
    .map((f) => `--- ${f.path} ---\n${clip(f.content, 4000)}`)
    .join('\n\n');
  return [
    'A candidate proposes importing an architectural pattern into agent-manager from another project. Its Problem statement makes a claim about agent-manager\'s CURRENT code. You are given the real fetched content of every file the candidate names. Judge ONLY whether the Problem statement\'s claim about the CURRENT code is true -- do not judge the proposed Solution, and do not judge whether the idea is good.',
    '',
    '--- CANDIDATE ---',
    clip(body, 3000),
    '',
    '--- REAL FETCHED CONTENT ---',
    filesBlock ? clip(filesBlock, 8000) : '(no files fetched)',
    '',
    'Output EXACTLY one of:',
    '  PREMISE_VALID',
    'or:',
    '  PREMISE_INVALID -- <one sentence citing the real content above that contradicts the claim>',
    'Nothing else.',
  ].join('\n');
}

function parsePremiseVerdict(text) {
  const firstLine = (String(text || '').split('\n').find((l) => l.trim()) || '').trim();
  if (/^PREMISE_VALID\b/i.test(firstLine)) return { verdict: 'ok' };
  const m = firstLine.match(/^PREMISE_INVALID\b\s*[-:]*\s*(.*)$/i);
  if (m) return { verdict: 'invalid-premise', reason: m[1].trim().slice(0, 300) || '(no detail given)' };
  return { verdict: 'ok' }; // non-conforming output -- 3b noise, same "0 survivors -> ok" rule as plan-critique.js
}

// task, { call?, maybeLockedOn } -> { verdict: 'ok'|'invalid-premise', reason? }
async function runPremiseCheck(task, { call = localCall, maybeLockedOn } = {}) {
  if (!isEnabled()) return { verdict: 'ok' };
  const pc = task.promptContext || {};
  const evidence = pc.premiseEvidence || computePremiseEvidence(task);
  if (evidence.contradictions.length) {
    return { verdict: 'invalid-premise', reason: evidence.contradictions[0].detail };
  }
  if (!hasCheckableClaim(task)) return { verdict: 'ok' };

  const prompt = buildPremiseCheckPrompt(task);
  const fn = () => call({
    prompt, model: PREMISE_CHECK_MODEL, numCtx: PREMISE_CHECK_NUM_CTX,
    think: false, temperature: 0.2, numPredict: 300, source: task.source,
  });
  let result;
  try {
    result = maybeLockedOn ? await maybeLockedOn(PREMISE_CHECK_MODEL, fn, 'arch-import-premise') : await fn();
  } catch (e) {
    return { verdict: 'ok', error: String((e && e.message) || e).slice(0, 160) }; // advisory -- never blocks on a model-call failure
  }
  if (result && result.degenerate) return { verdict: 'ok' };
  return parsePremiseVerdict(result && result.response);
}

module.exports = {
  computePremiseEvidence,
  hasCheckableClaim,
  runPremiseCheck,
  buildPremiseCheckPrompt,
  parsePremiseVerdict,
  checkCitations,
  checkUniformityClaim,
};
