'use strict';

// unused_export task source. Extracted from agent-manager's src/task-sources.js (2026-08-27,
// Phase 2). Reads <pipelineDir>/queue/dead-code-flags.json (written by the sibling
// unused-export-scan.js CLI) and turns the oldest not-yet-in-flight entry into a
// judgment-verdict-only triage task -- "genuine dead code vs. false positive (barrel
// re-export, factory pattern, ...)", decided by majority vote, not a single verdict.
//
// The task stamps source: 'deadcode_triage'; agent-manager's task-source-registry.js
// resolveSourceName() maps that back to the 'unused_export' registry key.
//
// apply is agent-manager core's applyVerdictOnly (shared with staleness_audit -- a plain
// prose verdict is a documented no-op once it reaches apply). No buildImplementPrompt:
// deliberate fallthrough (see agent-manager's prompts.js).

const path = require('path');
const fs = require('fs');
const { registerTaskSource, updateTaskSource } = require('agent-manager/src/task-source-registry.js');
const { applyVerdictOnly } = require('agent-manager/src/apply-group-a.js');
const { unusedExportPlanPrompt } = require('agent-manager/src/prompts.js');

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

function nextUnusedExportTask({ getConfig, taskIdExistsInQueue }) {
  const { pipelineDir, defaultDomain } = getConfig();
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
    const taskId = `deadcode-${slugifyForId(entry.symbol)}-${slugifyForId(entry.definedIn)}`;
    if (taskIdExistsInQueue(taskId)) continue;

    return {
      id: taskId,
      domain: defaultDomain,
      source: 'deadcode_triage',
      title: `Triage dead-code candidate: ${entry.symbol} (defined in ${entry.definedIn}) — ${entry.callSites.length} call site(s) found`,
      promptContext: {
        symbol: entry.symbol,
        definedIn: entry.definedIn,
        callSites: entry.callSites,
        note: 'Judge genuine-dead vs false-positive (barrel/re-export, factory pattern, etc.). Use a majority-vote judgment, not a single verdict.',
      },
    };
  }

  return null;
}

function register({ getConfig, taskIdExistsInQueue, taskPriority }) {
  registerTaskSource('unused_export', {
    priority: taskPriority('unused_export', 90),
    next: () => nextUnusedExportTask({ getConfig, taskIdExistsInQueue }),
    apply: applyVerdictOnly,
  });
  updateTaskSource('unused_export', { buildPlanPrompt: unusedExportPlanPrompt });
}

module.exports = { register, nextUnusedExportTask };
