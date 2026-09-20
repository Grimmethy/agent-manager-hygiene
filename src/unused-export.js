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

const { hygieneFamily } = require('./hygiene-family.js');
const path = require('path');
const fs = require('fs');
const { registerTaskSource, updateTaskSource, registerSourceAlias } = require('agent-manager/src/task-source-registry.js');
const { applyVerdictOnly } = require('agent-manager/src/apply-group-a.js');
const { unusedExportPlanPrompt } = require('agent-manager/src/prompts.js');
const { buildFlagInventory } = require('./flag-inventory.js');

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

// Read-only inventory for the dashboard's Hygiene tab (see flag-inventory.js). Same id formula as nextUnusedExportTask.
function unusedExportInventory({ pipelineDir, repoRoot, taskState }) {
  let entries;
  try { entries = JSON.parse(readIfExists(path.join(pipelineDir, 'queue', 'dead-code-flags.json')) || '[]'); } catch { entries = []; }
  const flags = (Array.isArray(entries) ? entries : []).map((e) => ({
    rule: 'unused-export', file: e.definedIn, line: 0, scannedAt: e.scannedAt,
    detail: `${e.symbol} -- ${(e.callSites || []).length} call site(s)`, _symbol: e.symbol,
  }));
  return buildFlagInventory({
    flags, projectTag: null, repoRoot, taskState,
    idFor: (f) => `deadcode-${slugifyForId(f._symbol)}-${slugifyForId(f.file)}`,
  });
}

function register({ getConfig, taskIdExistsInQueue, taskPriority }) {
  registerTaskSource('unused_export', {
    hygieneFamily: hygieneFamily('unused_export'),
    priority: taskPriority('unused_export', 90),
    next: () => nextUnusedExportTask({ getConfig, taskIdExistsInQueue }),
    inventory: ({ taskState }) => {
      const { repoRoot, pipelineDir } = getConfig();
      return unusedExportInventory({ repoRoot, pipelineDir, taskState });
    },
    apply: applyVerdictOnly,
  });
  updateTaskSource('unused_export', { buildPlanPrompt: unusedExportPlanPrompt });
  // Generated tasks stamp source: 'deadcode_triage' (not 'unused_export') -- declare that
  // here rather than relying on agent-manager's legacy hardcoded fallback in
  // resolveSourceName(). Guarded: registerSourceAlias landed in agent-manager Stage A1;
  // an older core still has the hardcoded fallback, so this is belt-and-suspenders.
  if (typeof registerSourceAlias === 'function') registerSourceAlias('deadcode_triage', 'unused_export');
}

module.exports = { register, nextUnusedExportTask };
