'use strict';

// change-review-quote-check.js -- deterministic "does the code this finding quotes actually exist?".
//
// Incident (2026-09-19, PropertyForager): change_review filed a Strong, high-severity finding against a
// just-merged refactor claiming onScopeChange calls `loadBox(mode.box, mode.scope, 1)` and should call
// `loadBox(mode.box, next, 1)`. The merged file had no such line: it already passed `next`; the model had
// conflated onScopeChange with onPage (`loadBox(mode.box, mode.scope, p)`, correct there). The finding
// sailed through review (2 of 3 votes), was pushed for merge, and would have spawned a fix task whose
// `replace X` could never match. A finding that quotes code as "what the file says today" is checkable by
// a plain substring test -- no model needed.
//
// Scope, deliberately narrow so it cannot suppress a real finding for the wrong reason:
//  - only the FIX SKETCH is checked, and only spans in an existing-code position: `replace|change|swap|... \`X\``
//    (X must be in the file). The replacement after "with"/"to" is a PROPOSAL and is never checked. The
//    Regression/Failure text is NOT checked: there the model describes what the diff CHANGED ("the diff
//    changes `old(a)` to `new(a)`"), and the old code is supposed to be absent from the post-change file.
//  - only spans that look like code (a call / member access / operator, >= MIN_QUOTE_CHARS, no placeholder
//    like `...` or `<thing>`) -- so `<`, `foo`, `next` are ignored.
//  - the corpus is the post-change file at the reviewed commit; when that is unreadable, the post-change lines
//    of the diff; when neither exists nothing is checked (fail open).
// The caller downgrades an unverified finding (Strength: Unverified) rather than dropping it.

const MIN_QUOTE_CHARS = 12;

// Verb + the FIRST backticked span after it: "replace `X` with `Y`" -> X. Optional filler words between.
const EXISTING_CODE_RE = /\b(?:replace|change|swap|rename|remove|delete|revert|update|modify)s?\s+(?:the\s+)?(?:(?:call|line|expression|statement|code)\s+)?`([^`\n]+)`/gi;

function norm(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

function looksLikeCode(q) {
  if (q.length < MIN_QUOTE_CHARS) return false;
  if (/\.\.\.|…|<[A-Za-z][^>]*>/.test(q)) return false; // placeholder / elision / <type> hole
  return /[()=\[\]{}]|=>|\w\.\w/.test(q);
}

// Unique code-looking spans in an existing-code position across the given texts.
function extractExistingCodeQuotes(...texts) {
  const out = [];
  for (const text of texts) {
    for (const m of String(text || '').matchAll(EXISTING_CODE_RE)) {
      const q = m[1].trim();
      if (looksLikeCode(q) && !out.includes(q)) out.push(q);
    }
  }
  return out;
}

// Post-change lines of a unified diff (context + added), prefix stripped.
function postChangeLines(unitDiff) {
  return String(unitDiff || '').split('\n')
    .filter((l) => !/^(?:diff --git |index |--- |\+\+\+ |@@)/.test(l) && !l.startsWith('-'))
    .map((l) => (l.startsWith('+') || l.startsWith(' ') ? l.slice(1) : l))
    .join('\n');
}

// The line of `corpus` sharing the most identifier tokens with the quote -- shown to a human so they can see
// what the file really says. '' when nothing overlaps.
function closestLine(quote, corpus) {
  const toks = [...new Set(String(quote).split(/\W+/).filter((t) => t.length > 2))];
  if (!toks.length) return '';
  let best = ''; let bestScore = 0;
  for (const line of String(corpus).split('\n')) {
    const score = toks.reduce((n, t) => n + (line.includes(t) ? 1 : 0), 0);
    if (score > bestScore) { bestScore = score; best = line; }
  }
  return bestScore >= Math.max(2, Math.ceil(toks.length / 2)) ? best.trim().slice(0, 160) : '';
}

// finding: { fix }. ctx: { fileText?, unitDiff? }.
// -> { checked: string[], unverified: [{ quote, closest }], skipped: boolean }
function verifyQuotedCode(finding, { fileText = '', unitDiff = '' } = {}) {
  const quotes = extractExistingCodeQuotes(finding && finding.fix);
  const corpus = String(fileText || '').trim() ? String(fileText) : postChangeLines(unitDiff);
  if (!quotes.length || !norm(corpus)) return { checked: [], unverified: [], skipped: true };
  const haystack = norm(corpus);
  const unverified = quotes
    .filter((q) => !haystack.includes(norm(q)))
    .map((q) => ({ quote: q, closest: closestLine(q, corpus) }));
  return { checked: quotes, unverified, skipped: false };
}

// One human-readable line for a candidate's Problem text / a review warning.
function describeUnverified(unverified, { file, sha } = {}) {
  const where = `${file || 'the file'}${sha ? ` @ ${sha}` : ''}`;
  return unverified.map((u) => `\`${u.quote}\` (quoted as existing code) does not appear verbatim in ${where}`
    + (u.closest ? `; closest real line: \`${u.closest}\`` : '')).join('; ');
}

module.exports = { extractExistingCodeQuotes, verifyQuotedCode, describeUnverified, postChangeLines, closestLine, looksLikeCode };
