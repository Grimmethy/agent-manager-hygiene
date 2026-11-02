'use strict';

// param_count_review -- reviews param-count-scan flags to filter false positives.
// Companion to param-count-scan.js: the scanner flags functions with too many positional
// parameters, this review stage judges genuine vs. false positive (wrapper functions,
// generated code, etc.) and returns vetted results.
//
// Uses flag-store.js for deduplication with key {functionPath, issueType} and maintains
// history log entry {functionPath, originalIssue, suppressedBy, timestamp}.

const path = require('path');
const fs = require('fs');
const { reconcileFlags } = require('./flag-store.js');

const ISSUE_TYPE = 'param-count';
const FLAGS_FILE = 'queue/param-count-flags.json';
const HISTORY_FILE = 'queue/param-count-history.json';

// Patterns that suggest generated code.
const GENERATED_PATTERNS = [
  /^generated/i,
  /^auto/i,
  /_gen$/,
  /_generated$/,
  /_auto$/,
];

// Wrapper function patterns: functions that just call another function.
const WRAPPER_PATTERNS = [
  /wrapper$/i,
  /delegate$/i,
  /forward$/i,
  /proxy$/i,
  /adapter$/i,
];

function isGeneratedCode(functionPath, file) {
  const basename = path.basename(file).toLowerCase();
  return GENERATED_PATTERNS.some((pattern) => pattern.test(basename) || pattern.test(functionPath));
}

function isWrapperFunction(functionPath) {
  return WRAPPER_PATTERNS.some((pattern) => pattern.test(functionPath));
}

function getFunctionSnippet(content, line) {
  if (!content) return null;
  const lines = String(content).split('\n');
  const start = Math.max(0, line - 3);
  const end = Math.min(lines.length, line + 10);
  return lines.slice(start, end).join('\n');
}

function review({ repoRoot, pipelineDir, flags, isSuppressed }) {
  if (!Array.isArray(flags)) {
    return { results: [], history: [], changed: false };
  }

  const projectTag = path.basename(repoRoot);
  const flagsPath = path.join(pipelineDir, FLAGS_FILE);
  const historyPath = path.join(pipelineDir, HISTORY_FILE);

  // Load existing flags and history.
  let existingFlags = [];
  let history = [];
  try {
    existingFlags = JSON.parse(fs.readFileSync(flagsPath, 'utf8') || '[]');
  } catch {
    // Ignore parse errors.
  }
  try {
    history = JSON.parse(fs.readFileSync(historyPath, 'utf8') || '[]');
  } catch {
    // Ignore parse errors.
  }

  // Reconcile flags using flag-store.js.
  const reconciled = reconcileFlags({
    flags: existingFlags,
    freshFindings: flags.map((f) => ({
      ...f,
      rule: ISSUE_TYPE,
      projectSlug: projectTag,
      scannedAt: new Date().toISOString(),
    })),
    scanOk: true,
    projectTag,
    repoRoot,
    isSuppressed,
  });

  // Deduplicate using {functionPath, issueType} key.
  const seen = new Map();
  for (const flag of reconciled.flags) {
    const dedupKey = `${flag.functionPath}::${ISSUE_TYPE}`;
    if (!seen.has(dedupKey)) {
      seen.set(dedupKey, flag);
    }
  }

  // Review each unique flag.
  const results = [];
  for (const flag of seen.values()) {
    let isReal = true;
    let reason = '';

    // Check for false positives.
    if (isGeneratedCode(flag.functionPath, flag.file)) {
      isReal = false;
      reason = 'Function appears to be in generated code';
    } else if (isWrapperFunction(flag.functionPath)) {
      isReal = false;
      reason = 'Function appears to be a wrapper/delegate';
    } else if (flag.paramCount <= 6) {
      // Edge case: paramCount should be > threshold, but just in case.
      isReal = false;
      reason = 'Param count below threshold';
    }

    // Check suppression.
    if (isSuppressed && typeof isSuppressed === 'function') {
      try {
        const content = fs.readFileSync(path.join(repoRoot, flag.file), 'utf8');
        const snippet = getFunctionSnippet(content, flag.line);
        if (isSuppressed(pipelineDir, ISSUE_TYPE, snippet)) {
          isReal = false;
          reason = 'Suppressed by prior review';
          history.push({
            functionPath: flag.functionPath,
            originalIssue: {
              file: flag.file,
              line: flag.line,
              functionPath: flag.functionPath,
              paramCount: flag.paramCount,
            },
            suppressedBy: 'suppression-store',
            timestamp: new Date().toISOString(),
          });
        }
      } catch {
        // File not readable, skip suppression check.
      }
    }

    results.push({
      file: flag.file,
      line: flag.line,
      functionPath: flag.functionPath,
      paramCount: flag.paramCount,
      isReal,
      reason: reason || 'Flagged by param-count-scan',
    });
  }

  // Sort results by functionPath for deterministic output.
  results.sort((a, b) => a.functionPath.localeCompare(b.functionPath));

  return {
    results,
    history,
    changed: reconciled.changed,
  };
}

module.exports = { review };
