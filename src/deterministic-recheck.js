'use strict';

// Deterministic staleness-recheck rules for observability_review / performance_review,
// registered into agent-manager's deterministic-recheck-registry (ADR-0022 Stage B).
//
// agent-manager's staleness-fastpath.js re-runs the ORIGINAL scanner rule against a file's
// CURRENT content to answer "is this finding still live" without an LLM round-trip. Before
// Stage B it hardcoded the rule -> detector map and require()d the scanners directly; now
// the source that owns the scanner registers it. The detector FUNCTIONS still live in
// agent-manager core (src/maintenance/*-scan.js -- see docs/PLUGIN_API.md); this module
// just wraps them into the { perFileRules, repoWideRules } shape the registry expects.
//
// Moved verbatim from agent-manager's src/staleness-fastpath.js (RULE_DETECTORS /
// REPO_WIDE_RULE_DETECTORS / missingReservedAttribute).

const fs = require('fs');
const obsScan = require('agent-manager/src/maintenance/observability-scan.js');
const perfScan = require('agent-manager/src/maintenance/performance-scan.js');
const { listSourceFiles, isLikelyMinified } = require('agent-manager/src/maintenance/scan-utils.js');
const { registerDeterministicRecheck } = require('agent-manager/src/deterministic-recheck-registry.js');

// function_length_review's length-not-pattern shape is deliberately absent -- a single-file
// (text, relPath) recheck isn't the right shape for it; a staleness_audit of one of its
// findings falls back to the LLM path, same as any unregistered rule.
const OBSERVABILITY_PER_FILE_RULES = {
  'silent-catch-block': (text, relPath) => obsScan.findSilentCatchBlocks(text, relPath),
  'unguarded-long-running-loop': (text, relPath) => obsScan.findUnguardedLoops(text, relPath),
  'otel-naming-convention': (text, relPath) => obsScan.findOtelNamingViolations(text, relPath),
};

const PERFORMANCE_PER_FILE_RULES = {
  'sync-io-in-loop': (text, relPath) => perfScan.findLoopBodyIssues(text, relPath).filter((f) => f.rule === 'sync-io-in-loop'),
  'sequential-await-in-loop': (text, relPath) => perfScan.findLoopBodyIssues(text, relPath).filter((f) => f.rule === 'sequential-await-in-loop'),
  'json-deep-clone-antipattern': (text, relPath) => perfScan.findJsonDeepCloneAntipattern(text, relPath),
};

// missing-reserved-attribute is REPO-WIDE (a project either has service.name/error.type
// somewhere in its source or it doesn't -- there's no single file/line to re-check). This
// re-derives the exact scan scanProject() runs for the rule: same extension list, same
// isLikelyMinified filter, same hasOtelDependency gate (no OTel SDK -> the rule never
// really applied -> "resolved").
const REPO_WIDE_SCAN_EXTENSIONS = ['.js', '.jsx', '.ts', '.tsx', '.py', '.go'];

function missingReservedAttribute(repoRoot) {
  if (!obsScan.hasOtelDependency(repoRoot)) return [];
  const files = listSourceFiles(repoRoot, REPO_WIDE_SCAN_EXTENSIONS).filter((file) => {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { return false; }
    return !isLikelyMinified(text);
  });
  return obsScan.findMissingReservedAttributes(repoRoot, files);
}

function register() {
  registerDeterministicRecheck('observability_review', {
    perFileRules: OBSERVABILITY_PER_FILE_RULES,
    repoWideRules: { 'missing-reserved-attribute': missingReservedAttribute },
  });
  registerDeterministicRecheck('performance_review', {
    perFileRules: PERFORMANCE_PER_FILE_RULES,
  });
}

module.exports = {
  register,
  OBSERVABILITY_PER_FILE_RULES,
  PERFORMANCE_PER_FILE_RULES,
  missingReservedAttribute,
};
