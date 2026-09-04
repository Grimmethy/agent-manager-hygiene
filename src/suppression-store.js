'use strict';

// Persistent false-positive suppression ledger for the deterministic maintenance review
// sources (performance_review / observability_review / function_length_review).
//
// The problem it solves: a review verdict of "false positive" was thrown away -- the task
// went to done/, apply was a no-op, and the deterministic scanner kept re-flagging the
// exact same construct on every rescan. If a commit shifted the line number the flag's
// rule::file::line key changed and it was re-emitted as a brand-new review task. Live
// evidence: agent-manager's own performance_review header ("355 done tasks, 297 (84%)
// false positive ... zero fixes ever shipped"), and a fresh 13-task batch on
// agent-manager-hygiene itself where every task was a scanner false positive.
//
// Fix (the isLikelyMinified pattern generalized -- one deterministic pre-filter, checked
// once, every rule benefits): when a review completes with a "false positive" verdict,
// record the flagged construct here keyed by a hash of its NORMALIZED snippet text, not
// its file:line. A later scan whose finding hashes to a recorded key is dropped before it
// can become a task -- surviving reindentation and line drift.
//
// Two ways a construct gets suppressed:
//   1. An explicit "false positive" verdict -> recorded immediately (recordFalsePositive
//      IfVerdict). An "uncertain" verdict stays re-examinable (nothing written).
//   2. A review that reached a verdict but produced NO actionable candidate ("no candidates
//      in implement response", a malformed `### AC-NNN` block, ...) -- the ~78%-of-throughput
//      churn case found 2026-09-03: 55 silent-catch flags on python/dashboard/app.py, each
//      re-emitted as a fresh review task every time a commit shifted its line number,
//      because the "GENUINE but unproducible" outcome wrote nothing and rule::file::line
//      drifted. recordInconclusiveReview() tracks these in a parallel attempts ledger
//      (scanner-review-attempts.json) keyed by the SAME content hash; after
//      MAX_INCONCLUSIVE_REVIEW_ATTEMPTS (default 3) it promotes the construct to a real
//      suppression row with reason "unproducible", so the scanner stops re-asking. Distinct
//      reason so a human auditing the ledger can tell "dismissed as FP" from "pipeline
//      could not act on it after N tries".

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// After this many completed reviews that each reached a verdict but yielded no candidate,
// the construct is promoted to a full suppression. A couple of retries is reasonable (the
// model may do better with improved grounding); an unbounded retry is the bug.
const MAX_INCONCLUSIVE_REVIEW_ATTEMPTS = (() => {
  const n = Number(process.env.SCANNER_REVIEW_MAX_INCONCLUSIVE_ATTEMPTS);
  return Number.isInteger(n) && n >= 1 ? n : 3;
})();

// Attempt rows for constructs that never reach the cap (e.g. the finding gets fixed, or a
// later run does produce a candidate) would otherwise accumulate forever -- age them out.
const ATTEMPT_ROW_MAX_AGE_MS = 45 * 24 * 60 * 60 * 1000;

function suppressionsPath(pipelineDir) {
  return path.join(pipelineDir, 'scanner-suppressions.json');
}

function attemptsPath(pipelineDir) {
  return path.join(pipelineDir, 'scanner-review-attempts.json');
}

// Whitespace-insensitive: kills indentation changes, line-wrap differences and the line
// number itself as sources of key drift, while keeping the construct's actual tokens.
function normalizeSnippet(s) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
}

function suppressionKey(rule, snippet) {
  const hash = crypto.createHash('sha1').update(normalizeSnippet(snippet)).digest('hex');
  return `${rule}::${hash}`;
}

function readRows(pipelineDir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(suppressionsPath(pipelineDir), 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function readSuppressionKeys(pipelineDir) {
  return new Set(readRows(pipelineDir).map((r) => r && r.key).filter(Boolean));
}

// A finding with no snippet text (e.g. a repo-wide rule with no file/line) is never
// suppressed through this path -- an all-whitespace key would match everything.
function isSuppressed(pipelineDir, rule, snippet) {
  if (!rule || !normalizeSnippet(snippet)) return false;
  return readSuppressionKeys(pipelineDir).has(suppressionKey(rule, snippet));
}

function recordSuppression(pipelineDir, { rule, file, snippet, taskId, at, cause } = {}) {
  const norm = normalizeSnippet(snippet);
  if (!rule || !norm) return { recorded: false, reason: 'no rule or empty snippet' };

  const key = suppressionKey(rule, snippet);
  const rows = readRows(pipelineDir);
  if (rows.some((r) => r && r.key === key)) return { recorded: false, reason: 'already present', key };

  rows.push({
    key,
    rule,
    file: file || null,
    snippetHash: key.slice(key.indexOf('::') + 2),
    snippetPreview: norm.slice(0, 200),
    taskId: taskId || null,
    // Why this construct is suppressed: 'false-positive' (a review dismissed it) or
    // 'unproducible' (N reviews reached a verdict but never produced a usable candidate).
    // Older rows predate this field -- absence means 'false-positive'.
    cause: cause || 'false-positive',
    at: at || new Date().toISOString(),
  });
  fs.mkdirSync(pipelineDir, { recursive: true });
  fs.writeFileSync(suppressionsPath(pipelineDir), JSON.stringify(rows, null, 2));
  return { recorded: true, key };
}

// Call from a _review source's apply(): if the verdict produced NO fix candidate
// (applyResult.skipped) AND explicitly reads as "false positive", remember the flagged
// construct. Returns the recordSuppression result, or null if this verdict is not a
// recordable false positive.
function recordFalsePositiveIfVerdict({ applyResult, implementResponse, task, pipelineDir }) {
  if (!applyResult || !applyResult.skipped) return null;            // a candidate was written -> genuine
  if (!/false[\s-]*positive/i.test(implementResponse || '')) return null; // uncertain/other -> leave re-examinable
  const pc = (task && task.promptContext) || {};
  if (!pc.snippet) return null;
  return recordSuppression(pipelineDir, {
    rule: pc.rule,
    file: pc.file,
    snippet: pc.snippet,
    taskId: task && task.id,
    cause: 'false-positive',
    at: new Date().toISOString(),
  });
}

// --- Inconclusive-review attempts ledger ----------------------------------------------

function readAttemptRows(pipelineDir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(attemptsPath(pipelineDir), 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeAttemptRows(pipelineDir, rows) {
  const cutoff = Date.now() - ATTEMPT_ROW_MAX_AGE_MS;
  const pruned = rows.filter((r) => {
    const t = Date.parse((r && (r.lastAt || r.firstAt)) || '');
    return Number.isNaN(t) || t >= cutoff;
  });
  fs.mkdirSync(pipelineDir, { recursive: true });
  if (pruned.length === 0) {
    try { fs.unlinkSync(attemptsPath(pipelineDir)); } catch { /* nothing to remove */ }
    return;
  }
  fs.writeFileSync(attemptsPath(pipelineDir), JSON.stringify(pruned, null, 2));
}

// Did this completed review produce a usable fix candidate? A live apply() hands us its
// real result; a historical replay (backfill) has only the text, so fall back to looking
// for the candidate header the parser requires.
function reviewProducedCandidate({ applyResult, implementResponse }) {
  if (applyResult) return !applyResult.skipped;
  return /^\s*#{2,3}\s*AC-\d+\b/m.test(implementResponse || '');
}

// Call from a _review source's apply(), right after recordFalsePositiveIfVerdict(). When a
// review reached a verdict but produced NO candidate and did NOT explicitly say "false
// positive" (recordFalsePositiveIfVerdict already handled that case), bump this construct's
// attempt count. On hitting MAX_INCONCLUSIVE_REVIEW_ATTEMPTS, promote it to a real
// suppression (cause 'unproducible') and drop the attempt row. Keyed by the same content
// hash the suppression store uses, so it survives line drift and reindentation.
// Returns { promoted, count, ... } or null when this outcome is not an inconclusive review.
function recordInconclusiveReview({ applyResult, implementResponse, task, pipelineDir, at } = {}) {
  // A candidate was written -> the review did its job.
  if (reviewProducedCandidate({ applyResult, implementResponse })) return null;
  // An explicit false positive is recordFalsePositiveIfVerdict's job, not this one.
  if (/false[\s-]*positive/i.test(implementResponse || '')) return null;

  const pc = (task && task.promptContext) || {};
  if (!pc.rule || !normalizeSnippet(pc.snippet)) return null;

  const key = suppressionKey(pc.rule, pc.snippet);

  // Already suppressed (via either path) -- nothing more to track.
  if (readSuppressionKeys(pipelineDir).has(key)) return { promoted: false, alreadySuppressed: true, key };

  const when = at || new Date().toISOString();
  const rows = readAttemptRows(pipelineDir);
  const existing = rows.find((r) => r && r.key === key);
  const count = (existing ? existing.count || 0 : 0) + 1;

  if (count >= MAX_INCONCLUSIVE_REVIEW_ATTEMPTS) {
    const supp = recordSuppression(pipelineDir, {
      rule: pc.rule,
      file: pc.file,
      snippet: pc.snippet,
      taskId: task && task.id,
      cause: 'unproducible',
      at: when,
    });
    writeAttemptRows(pipelineDir, rows.filter((r) => r && r.key !== key));
    return { promoted: true, count, key, suppression: supp };
  }

  if (existing) {
    existing.count = count;
    existing.lastAt = when;
    existing.lastTaskId = (task && task.id) || existing.lastTaskId || null;
  } else {
    rows.push({
      key,
      rule: pc.rule,
      file: pc.file || null,
      snippetPreview: normalizeSnippet(pc.snippet).slice(0, 200),
      count,
      firstAt: when,
      lastAt: when,
      lastTaskId: (task && task.id) || null,
    });
  }
  writeAttemptRows(pipelineDir, rows);
  return { promoted: false, count, key };
}

// Classifies a completed _review's outcome for task-disposition.js (core). The review
// source's apply() stamps the result on `task.reviewDisposition`; the core reconcile reads
// it to split `dismissed` (a correct false-positive triage) out of the `noop` grab-bag.
// Same predicates the two recorders above already use, kept in one place.
//   genuine       -- a fix candidate was written (or, for a backfill with only text, an
//                    `### AC-NNN` header is present)
//   dismissed     -- explicit FALSE POSITIVE verdict, no candidate: the scanner was wrong
//   inconclusive  -- reached a verdict but produced nothing usable
function classifyReviewOutcome({ applyResult, implementResponse } = {}) {
  const txt = implementResponse || '';
  if (applyResult && !applyResult.skipped) return 'genuine';
  if (/^\s*#{2,3}\s*AC-\d+\b/m.test(txt)) return 'genuine';
  if (/false[\s-]*positive/i.test(txt)) return 'dismissed';
  return 'inconclusive';
}

module.exports = {
  MAX_INCONCLUSIVE_REVIEW_ATTEMPTS,
  classifyReviewOutcome,
  suppressionsPath,
  attemptsPath,
  normalizeSnippet,
  suppressionKey,
  readRows,
  readSuppressionKeys,
  readAttemptRows,
  isSuppressed,
  recordSuppression,
  recordFalsePositiveIfVerdict,
  recordInconclusiveReview,
};
