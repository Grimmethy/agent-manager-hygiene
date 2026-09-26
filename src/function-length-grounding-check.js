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

// 2026-09-25: no longer defaults to a dedicated small model or a non-standard numCtx --
// see agent-manager/src/task-sources.js's 2026-09-18 brain_dump_sort comment for the full
// incident this mirrors (forcing a specific small model on a lane sharing a GPU with a
// large resident model made Ollama evict+reload it on every lane alternation, routinely
// exceeding call timeouts; the numCtx mismatch alone forces a reload too, independent of
// the model choice). Undefined falls through to local-client.js's own `model: model ||
// MODEL` (the claiming worker's ambient/resident model) and its own default numCtx --
// same "costs nothing in correctness, stops fighting other lanes for GPU residency" fix.
// The env var override still lets an operator force a dedicated model deliberately.
const GROUNDING_CHECK_MODEL = process.env.AGENT_MANAGER_FUNCTION_LENGTH_GROUNDING_MODEL || undefined;
const GROUNDING_CHECK_NUM_CTX = process.env.AGENT_MANAGER_FUNCTION_LENGTH_GROUNDING_NUM_CTX
  ? Number(process.env.AGENT_MANAGER_FUNCTION_LENGTH_GROUNDING_NUM_CTX) : undefined;

function isEnabled() {
  return process.env.AGENT_MANAGER_FUNCTION_LENGTH_GROUNDING_CHECK !== 'false';
}

function clip(s, n) {
  const str = String(s || '');
  return str.length > n ? `${str.slice(0, n)}\n...[truncated]` : str;
}

// The model must see the whole function it is asked to check. function-length-review.js's functionSnippet() already hands the review
// the complete body (2 lines of lead-in + up to SNIPPET_MAX_LINES = 200 lines, ending in a "[truncated for review" marker if it had to cut),
// but this prompt used to clip that again at 6000 chars while telling the model it had "the REAL, complete text": on a long function the
// model then flagged a true claim about the unseen tail ("the function contains no return statement") as NOT_GROUNDED. 2026-09-26: 10 of the
// 12 blocked function_length_review tasks and 66 of 125 recorded function_length_review tasks had snippets over 6000 chars, and two of them
// were blocked on exactly that ("no return" -- the real function ends `return lines.join('\n')`; "no [data-file] binding" -- it is wired further
// down). 200 lines of ~100 chars is ~20000 chars, so this cap covers everything functionSnippet can emit; if a snippet still exceeds it,
// the prompt says so and the model may only judge what it can see.
const GROUNDING_SNIPPET_MAX_CHARS = 24000;
const REVIEW_TRUNCATION_MARKER_RE = /\[truncated for review/;

// -> { text, partial }: partial is true when the function continues past what the model is shown.
function snippetForPrompt(snippet) {
  const str = String(snippet || '');
  const clipped = str.length > GROUNDING_SNIPPET_MAX_CHARS;
  return { text: clipped ? clip(str, GROUNDING_SNIPPET_MAX_CHARS) : str, partial: clipped || REVIEW_TRUNCATION_MARKER_RE.test(str) };
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
  const { text: snippet, partial } = snippetForPrompt(task.promptContext && task.promptContext.snippet);
  return [
    'A code reviewer proposed decomposing a function into smaller helpers. You are given the REAL text of the function and the reviewer\'s Solution paragraph describing the proposed decomposition. Judge ONLY whether the Solution accurately describes the REAL function -- do not judge whether decomposing it is a good idea.',
    '',
    ...(partial ? ['NOTE: the function continues past the end of the snippet below (it was cut for length). Judge ONLY claims about the code that IS shown; a claim about the unseen remainder is NOT a contradiction.', ''] : []),
    '--- REAL FUNCTION SNIPPET ---',
    snippet || '(no snippet available)',
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
  snippetForPrompt,
  GROUNDING_SNIPPET_MAX_CHARS,
  parseGroundingVerdict,
};
