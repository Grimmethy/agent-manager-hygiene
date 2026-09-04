'use strict';

// Low-confidence `silent-catch-block` findings (the ~1,000-item "catch { return fallback }"
// / best-effort bucket that PR #12 explicitly deferred) are pulled out of the one-task-per-
// finding review flow and batched: ONE `observability_review_digest` task per project per
// day carries up to CAP of them, the model returns a one-line GENUINE / FALSE POSITIVE
// verdict for each, and the apply files candidates for the GENUINE ones + suppresses the
// FALSE POSITIVE ones. ~10x fewer tasks, each still productive.
//
// This module is the pure batch selection + verdict parsing; observability-review.js owns
// the task source, prompts and apply.

const LOW_CONFIDENCE_CAP = (() => {
  const n = Number(process.env.AGENT_MANAGER_OBSERVABILITY_LOW_CONFIDENCE_CAP);
  return Number.isInteger(n) && n >= 1 ? n : 12;
})();

// digest-task (default) | off. `off` drops LOW findings entirely (they still self-heal a
// `confidence` onto the flags file, they just never surface until the mode is turned back on).
const LOW_CONFIDENCE_MODE = (() => {
  const m = String(process.env.AGENT_MANAGER_OBSERVABILITY_LOW_CONFIDENCE_MODE || 'digest-task').trim();
  return m === 'off' ? 'off' : 'digest-task';
})();

// Oldest-file-first, deterministic: scannedAt asc, then file, then line. Slice to `cap`.
function selectLowConfidenceBatch(lowFindings, cap = LOW_CONFIDENCE_CAP) {
  return [...(lowFindings || [])]
    .sort((a, b) => (
      String(a.scannedAt || '').localeCompare(String(b.scannedAt || ''))
      || String(a.file || '').localeCompare(String(b.file || ''))
      || (a.line || 0) - (b.line || 0)
    ))
    .slice(0, Math.max(1, cap));
}

// The model is told to emit exactly N lines: `<n>. GENUINE|FALSE POSITIVE - <reason>`.
// Returns a Map<itemNumber, { verdict: 'genuine'|'false-positive', reason }>. Lines that
// don't parse are simply absent from the map -- the caller leaves those items for next
// cycle rather than guessing.
function parseDigestVerdicts(implementResponse, itemCount) {
  const out = new Map();
  const text = String(implementResponse || '');
  const lineRe = /^\s*(\d+)[.):]\s*(GENUINE|FALSE[\s-]*POSITIVE)\b[\s.:-]*(.*)$/i;
  for (const raw of text.split('\n')) {
    const m = raw.match(lineRe);
    if (!m) continue;
    const n = Number(m[1]);
    if (!Number.isInteger(n) || n < 1 || (itemCount && n > itemCount)) continue;
    const verdict = /genuine/i.test(m[2]) ? 'genuine' : 'false-positive';
    if (!out.has(n)) out.set(n, { verdict, reason: (m[3] || '').trim().slice(0, 200) });
  }
  return out;
}

module.exports = {
  LOW_CONFIDENCE_CAP,
  LOW_CONFIDENCE_MODE,
  selectLowConfidenceBatch,
  parseDigestVerdicts,
};
