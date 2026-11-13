'use strict';

// test_health_review: the judge stage for test-health findings (the scanner is
// src/test-health-scan.js). Deterministic, with no model calls and no polling. Shaped like
// src/function-length-review.js: for each flag it decides whether the flag becomes a review
// task (create_task) or is dismissed because a prior review already ruled it a false positive.
//
// The suppression ledger API is the REAL one in suppression-store.js:
//   isSuppressed(pipelineDir, rule, snippet)
//   recordSuppression(pipelineDir, { rule, file, snippet, taskId, at, cause })
// The object-style names from the task contract (isSuppressed / recordDismissal) are local
// adapters below. suppression-store.js itself is not modified.

const { isSuppressed: storeIsSuppressed, recordSuppression } = require('./suppression-store.js');

const SOURCE = 'test-health';

// Hazards are never dismissed: an unsandboxed reference to a real external resource must
// always surface as a task. The scanner emits reason 'unsandboxed-resource' and hazard
// 'unsandboxed-resource-access'; 'unsandboxed-import' is the contract's name and is accepted too.
const HAZARD_REASONS = new Set(['unsandboxed-resource', 'unsandboxed-import']);
const HAZARD_HAZARDS = new Set(['unsandboxed-resource-access']);

function flagPath(flag) {
  return flag.filePath || flag.file || '';
}

// The store keys on a snippet hash. Folding the file path into the snippet means a dismissal
// in one file can never suppress the same snippet in another file.
function suppressionSnippet(filePath, snippet) {
  return `${filePath} :: ${snippet}`;
}

// Adapter with the contract shape. Snippet is needed because the store keys on it.
function isSuppressed({ pipelineDir, filePath, line, source, snippet }) {
  if (!pipelineDir) return false;
  return storeIsSuppressed(pipelineDir, source || SOURCE, suppressionSnippet(filePath, snippet));
}

// Adapter with the contract shape, over recordSuppression.
function recordDismissal({ pipelineDir, source, filePath, line, reason, timestamp, snippet }) {
  return recordSuppression(pipelineDir, {
    rule: source || SOURCE,
    file: filePath,
    snippet: suppressionSnippet(filePath, snippet),
    taskId: undefined,
    at: timestamp,
    cause: reason || 'false-positive',
  });
}

function isUnsandboxedHazard(flag) {
  const meta = flag.meta || {};
  return HAZARD_REASONS.has(meta.reason) || HAZARD_HAZARDS.has(meta.hazard);
}

const CLASS_LABELS = {
  'skipped-no-reason': {
    label: 'skipped test without a reason',
    scope: 'add a reason to the skip, or un-skip the test and make it pass',
  },
  'assertion-free': {
    label: 'assertion-free test body',
    scope: 'add real assertions that check behavior, or delete the test',
  },
  'unsandboxed-resource': {
    label: 'unsandboxed reference to a real external resource',
    scope: 'route the test through a sandbox or mock so it cannot reach the real resource',
  },
};

function describeFlag(flag, filePath) {
  const meta = flag.meta || {};
  const cls = meta.reason || meta.hazard || 'unknown';
  const info = CLASS_LABELS[cls] || { label: `violation class ${cls}`, scope: 'review manually and fix only this test' };
  const snippet = flag.snippet == null ? '' : String(flag.snippet);
  return `Test-health ${info.label} at ${filePath}:${flag.line}: ${snippet}. Fix scope: ${info.scope}. Change only the test at this location.`;
}

// review({ flags, project }) -> [{ filePath, line, action, taskId?, reason? }]
// action is 'create_task' or 'dismiss'.
function review({ flags, project } = {}) {
  const pipelineDir = project && project.pipelineDir;
  const list = Array.isArray(flags) ? flags : [];
  const seen = new Set();
  const results = [];

  for (const flag of list) {
    if (!flag || typeof flag !== 'object') continue;
    const filePath = flagPath(flag);
    const line = flag.line;
    const snippet = flag.snippet == null ? '' : String(flag.snippet);

    // (1) Dedupe on (filePath, line, snippet) within this batch.
    const dedupeKey = `${filePath}\u0000${line}\u0000${snippet}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    // (2) Unsandboxed hazard: always a task, checked before any suppression lookup.
    if (isUnsandboxedHazard(flag)) {
      results.push({ filePath, line, action: 'create_task', reason: describeFlag(flag, filePath) });
      continue;
    }

    // (3) Suppression: a prior review already ruled this a false positive.
    if (isSuppressed({ pipelineDir, filePath, line, source: SOURCE, snippet })) {
      const reason = 'previously dismissed as a false positive';
      recordDismissal({
        pipelineDir,
        source: SOURCE,
        filePath,
        line,
        reason,
        timestamp: new Date().toISOString(),
        snippet,
      });
      results.push({ filePath, line, action: 'dismiss', reason });
      continue;
    }

    // (4) Skip and assertion-free flags (and any other class) become a review task.
    results.push({ filePath, line, action: 'create_task', reason: describeFlag(flag, filePath) });
  }

  return results;
}

module.exports = { review };
