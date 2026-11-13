'use strict';

// plugins.json dead-entry scanner. Reads plugins.json and flags entries whose
// registerPath does not exist on disk, and entries whose register.js file registers
// nothing (no registerTaskSource calls). Uses listSourceFiles from scan-utils.js to
// verify existence. Does NOT modify plugins.json — only reports.

const fs = require('fs');
const path = require('path');
const { listSourceFiles, extractBraceBody, stripNonCode } = require('./scan-utils.js');

const PLUGINS_JSON_PATH = path.join(__dirname, '..', 'plugins.json');
const REGISTER_TASK_SOURCE_RE = /registerTaskSource\s*\(\s*['"]([^'"]+)['"]/g;

// Scan plugins.json for dead entries.
// Returns an array of { entry, reason, detail } objects.
function scanPlugins() {
  const findings = [];
  const scannedAt = new Date().toISOString();

  // Read plugins.json
  let plugins;
  try {
    const content = fs.readFileSync(PLUGINS_JSON_PATH, 'utf8');
    plugins = JSON.parse(content);
  } catch (err) {
    // File doesn't exist or is invalid JSON - nothing to scan
    return findings;
  }

  if (!Array.isArray(plugins)) {
    return findings;
  }

  for (const entry of plugins) {
    if (!entry.name || !entry.registerPath) {
      findings.push({
        entry,
        reason: 'missing_fields',
        detail: `Plugin entry missing 'name' or 'registerPath'`,
        scannedAt,
      });
      continue;
    }

    // Check if registerPath exists on disk
    const registerPath = path.resolve(__dirname, '..', entry.registerPath);
    const sourceFiles = listSourceFiles(path.dirname(registerPath), ['.js']);
    const fileExists = sourceFiles.some((f) => f === registerPath);

    if (!fileExists) {
      findings.push({
        entry,
        reason: 'missing_register_path',
        detail: `registerPath "${entry.registerPath}" does not exist on disk`,
        scannedAt,
      });
      continue;
    }

    // Check if the register.js file actually registers something
    let text;
    try {
      text = fs.readFileSync(registerPath, 'utf8');
    } catch (err) {
      findings.push({
        entry,
        reason: 'unreadable_register_file',
        detail: `Cannot read register file: ${err.message}`,
        scannedAt,
      });
      continue;
    }

    // Strip non-code to avoid matching registerTaskSource in strings/comments
    const stripped = stripNonCode(text);
    REGISTER_TASK_SOURCE_RE.lastIndex = 0;
    let hasRegistration = false;
    let m;
    while ((m = REGISTER_TASK_SOURCE_RE.exec(stripped))) {
      hasRegistration = true;
      break;
    }

    if (!hasRegistration) {
      findings.push({
        entry,
        reason: 'empty_registration',
        detail: `register file does not call registerTaskSource`,
        scannedAt,
      });
    }
  }

  return findings;
}

// Register this scanner with the task-source-registry.
function register(deps) {
  const { registerTaskSource, updateTaskSource } = require('agent-manager/src/task-source-registry.js');

  registerTaskSource('plugins_dead_entry_review', {
    scan: scanPlugins,
    repoRoot: __dirname + '/../..',
    rule: 'plugins-dead-entry',
    hygieneFamily: 'plugins',
    candidateDoc: true,
    directToMain: true,
    reviewGuidance:
      'plugins-dead-entry task: review each dead-entry finding and propose a fix (remove the plugins.json entry, restore the register file, or correct the registerPath).',
  });

  updateTaskSource('plugins_dead_entry_review', {
    buildPlanPrompt: function buildPlanPrompt({ task, context }) {
      return `Review the plugins.json dead-entry findings and propose fixes:\n\n${context.findings.map((f) => `- ${f.entry.name}: ${f.reason} - ${f.detail}`).join('\n')}`;
    },
  });
}

module.exports = { scanPlugins, register };
