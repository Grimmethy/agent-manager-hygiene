'use strict';

// Post-implement grounding check for function_length_review candidates (2026-09-05).
// Investigating a 9-item blocked backlog: 8 of the 9 shared one shape -- "The draft's
// Solution proposes extracting `X`, but the grounding source shows [contradiction]" -- the
// model's GENUINE verdict invents a helper name, signature, or call relationship that does
// not match the real flagged-function snippet it was given verbatim. Traced one in full
// (function-length-agent-manager-src-local-draft-js-801): the snippet was complete and
// untruncated, yet the Solution claimed a proposed `finalizePlanPass(plan,
// researchPlanTools)` wraps `runHarnessSearch`, when the real call site is
// `runHarnessSearch(harnessKind, task, { projectSearchFetch, archImportFetch })` -- a
// plausible-sounding but factually wrong description, not a truncation artifact. Blind
// redraft-with-feedback (reject-retry-check.js's existing priorRejectionFeedback loop)
// already gets 3 attempts at this and still exhausts into queue/blocked/, so the fix has
// to catch the SAME failure mode earlier, before it burns a real local review vote round.
//
// Same deterministic-first / cheap-model-fallback shape arch-import-premise-check.js
// already established: one free, deterministic check for a checkable false-negative shape
// (a FALSE POSITIVE/UNCERTAIN verdict claiming it had no grounding when it plainly did --
// function-length-agent-manager-src-local-draft-js-431's own failure shape); a qwen2.5:3b
// call as the semantic fallback for a GENUINE verdict's free-form Solution prose, which no
// deterministic regex can reliably verify.
//
// Wired into local-draft.js's runImplementPass via the generic, source-agnostic
// `postImplementCheck(task, implementResponse, {call, maybeLockedOn})` hook (PR/commit
// alongside this file) -- same convention as `premiseCheck`, just for the implement pass's
// own output rather than a candidate-fulfillment split decision. An 'ungrounded' verdict
// routes into the EXACT SAME blockedStage:'review' path a real review rejection takes, so
// redraft/exhaustion reuse existing, already-proven machinery -- this module only decides
// whether a rejection happens, never how it is handled afterward.
//
// Kill switch: AGENT_MANAGER_FUNCTION_LENGTH_GROUNDING_CHECK=false.

const { call: localCall } = require('agent-manager/src/local-client.js');

const GROUNDING_CHECK_MODEL = process.env.AGENT_MANAGER_FUNCTION_LENGTH_GROUNDING_MODEL || 'qwen2.5:3b';
const GROUNDING_CHECK_NUM_CTX = 8192;

function isEnabled() {
  return process.env.AGENT_MANAGER_FUNCTION_LENGTH_GROUNDING_CHECK !== 'false';
}

function clip(s, n) {
  const str = String(s || '');
  return str.length > n ? `${str.slice(0, n)}\n...[truncated]` : str;
}

// A GENUINE verdict's candidate block (functionLengthReviewImplementPrompt's own required
// format: "### AC-NNN · Title" then Strength/Files/Problem/Solution/Benefits).
const CANDIDATE_HEADER_RE = /^###\s*AC-/m;
const SOLUTION_SECTION_RE = /Solution:\s*\n([\s\S]*?)(?:\n\s*Benefits:|\s*$)/;

function extractSolution(text) {
  const m = SOLUTION_SECTION_RE.exec(String(text || ''));
  return m ? m[1].trim() : '';
}

// --- Check 1: a FALSE POSITIVE/UNCERTAIN verdict falsely claiming no grounding was given -
// (function-length-agent-manager-src-local-draft-js-431's real shape.) Free, deterministic,
// zero model calls: the snippet is right there in promptContext -- either it was given or
// it wasn't, no judgment call needed.
const NO_GROUNDING_CLAIM_RE = /\bno\s+(?:grounding\s+)?(?:snippet|line-range evidence|grounding evidence)\b/i;

function checkFalseNoGroundingClaim(task, implementResponse) {
  if (CANDIDATE_HEADER_RE.test(implementResponse)) return null; // a GENUINE verdict, not this check's shape
  if (!NO_GROUNDING_CLAIM_RE.test(implementResponse)) return null;
  const snippet = String((task.promptContext && task.promptContext.snippet) || '');
  if (!snippet.trim()) return null; // the claim is actually true -- nothing to flag
  return {
    verdict: 'ungrounded',
    reason: "the draft's stated verdict claims no grounding snippet/evidence was given, but a real, non-empty function snippet was provided in promptContext.snippet -- contradicts the draft's own stated reasoning",
  };
}

// --- Check 2: a GENUINE verdict's free-form Solution prose, cheap-model fallback --------
function buildGroundingCheckPrompt(task, solution) {
  const snippet = String((task.promptContext && task.promptContext.snippet) || '');
  return [
    'A code reviewer proposed decomposing a function into smaller helpers. You are given the REAL, complete text of the function (or its full body if long) and the reviewer\'s Solution paragraph describing the proposed decomposition. Judge ONLY whether the Solution accurately describes the REAL function -- do not judge whether decomposing it is a good idea.',
    '',
    '--- REAL FUNCTION SNIPPET ---',
    clip(snippet, 6000) || '(no snippet available)',
    '',
    '--- PROPOSED SOLUTION ---',
    clip(solution, 2000),
    '',
    'Does the Solution correctly describe function/variable names, call signatures, arguments, and control flow that actually appear in the real snippet above, without inventing a name, argument, or relationship that contradicts it? A solution proposing a genuinely NEW helper name is fine as long as what it says that new helper WRAPS or CALLS matches the real snippet exactly.',
    '',
    'Output EXACTLY one of:',
    '  GROUNDED',
    'or:',
    '  NOT_GROUNDED -- <one sentence citing the real snippet detail that contradicts the Solution>',
    'Nothing else.',
  ].join('\n');
}

function parseGroundingVerdict(text) {
  const firstLine = (String(text || '').split('\n').find((l) => l.trim()) || '').trim();
  if (/^GROUNDED\b/i.test(firstLine)) return { verdict: 'ok' };
  const m = firstLine.match(/^NOT_GROUNDED\b\s*[-:]*\s*(.*)$/i);
  if (m) return { verdict: 'ungrounded', reason: m[1].trim().slice(0, 300) || '(no detail given)' };
  return { verdict: 'ok' }; // non-conforming 3b output -- same "0 survivors -> ok" rule as plan-critique.js/premiseCheck
}

// task, implementResponse, { call?, maybeLockedOn } -> { verdict: 'ok'|'ungrounded', reason? }
async function runGroundingCheck(task, implementResponse, { call = localCall, maybeLockedOn } = {}) {
  if (!isEnabled()) return { verdict: 'ok' };

  const det = checkFalseNoGroundingClaim(task, implementResponse);
  if (det) return det;

  if (!CANDIDATE_HEADER_RE.test(String(implementResponse || ''))) return { verdict: 'ok' }; // FALSE POSITIVE/UNCERTAIN prose, nothing left to check
  const solution = extractSolution(implementResponse);
  if (!solution) return { verdict: 'ok' }; // malformed candidate -- review's own format check catches this, not this module's job
  const snippet = String((task.promptContext && task.promptContext.snippet) || '');
  if (!snippet.trim()) return { verdict: 'ok' }; // nothing real to ground against

  const prompt = buildGroundingCheckPrompt(task, solution);
  const fn = () => call({
    prompt, model: GROUNDING_CHECK_MODEL, numCtx: GROUNDING_CHECK_NUM_CTX,
    think: false, temperature: 0.2, numPredict: 300, source: task.source,
  });
  let result;
  try {
    result = maybeLockedOn ? await maybeLockedOn(GROUNDING_CHECK_MODEL, fn, 'function-length-grounding') : await fn();
  } catch (e) {
    return { verdict: 'ok', error: String((e && e.message) || e).slice(0, 160) }; // advisory -- never blocks on a model-call failure
  }
  if (result && result.degenerate) return { verdict: 'ok' };
  return parseGroundingVerdict(result && result.response);
}

module.exports = {
  runGroundingCheck,
  checkFalseNoGroundingClaim,
  extractSolution,
  buildGroundingCheckPrompt,
  parseGroundingVerdict,
};
