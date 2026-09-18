'use strict';

// Post-implement grounding check for arch_discovery candidate write-ups
// (concept-candidate-grounding-gate-3e9bec). arch_discovery had NO postImplementCheck at
// all -- its AC-NNN write-up's `Files:` line was unverified until a full review round.
//
// This is Check 0 only: the shared deterministic fabricated-path check
// (agent-manager/src/candidate-path-grounding.js). arch_discovery cites agent-manager's
// OWN files (the community file-set it was handed in the prompt is this repo's code), so
// getConfig().repoRoot is the correct target. A cited path that resolves nowhere is a
// fabrication a blind redraft only re-invents -- blocked-task-classifiers.js's
// `fabricated-file-path` classifier makes the resulting block NON-retryable.
//
// Deliberately no qwen2.5:3b semantic fallback (unlike arch_import / deep_dive): the plan
// pass already had the full community file content, so a fabricated destination path is
// the dominant real failure and the only one worth a dedicated gate here for now. A
// semantic contradiction still gets caught at review.
//
// Kill switch: AGENT_MANAGER_ARCH_DISCOVERY_GROUNDING_CHECK=false.

const { getConfig } = require('agent-manager/src/config.js');
const {
  extractFilesLine, checkCitedPaths, formatFabricatedReason,
  checkCitedSymbols, formatFabricatedSymbolsReason,
} = require('agent-manager/src/candidate-path-grounding.js');

function isEnabled() {
  return process.env.AGENT_MANAGER_ARCH_DISCOVERY_GROUNDING_CHECK !== 'false';
}

// task, implementResponse, {} -> { verdict: 'ok' | 'ungrounded', reason? }
// Signature matches the generic postImplementCheck hook (local-draft.js).
async function runGroundingCheck(task, implementResponse) {
  if (!isEnabled()) return { verdict: 'ok' };
  const text = String(implementResponse || '');
  if (!text.trim()) return { verdict: 'ok' }; // a legitimate "no friction found" empty draft

  try {
    const { repoRoot, grepAllowedDirs } = getConfig();
    const { fabricated, checked } = checkCitedPaths(extractFilesLine(text), repoRoot, grepAllowedDirs || []);
    if (fabricated.length) return { verdict: 'ungrounded', reason: formatFabricatedReason(fabricated) };
    // Check 0b -- see arch-import-grounding-check.js's own comment / candidate-path-
    // grounding.js's checkCitedSymbols header for the full rationale.
    const { fabricated: badSymbols } = checkCitedSymbols(text, checked);
    if (badSymbols.length) return { verdict: 'ungrounded', reason: formatFabricatedSymbolsReason(badSymbols) };
  } catch { /* can't resolve the repo -- advisory, skip */ }

  return { verdict: 'ok' };
}

module.exports = { runGroundingCheck };
