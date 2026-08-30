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
// Only an explicit "false positive" is recorded. An "uncertain" verdict stays
// re-examinable (nothing written).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function suppressionsPath(pipelineDir) {
  return path.join(pipelineDir, 'scanner-suppressions.json');
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

function recordSuppression(pipelineDir, { rule, file, snippet, taskId, at } = {}) {
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
    at: new Date().toISOString(),
  });
}

module.exports = {
  suppressionsPath,
  normalizeSnippet,
  suppressionKey,
  readRows,
  readSuppressionKeys,
  isSuppressed,
  recordSuppression,
  recordFalsePositiveIfVerdict,
};
