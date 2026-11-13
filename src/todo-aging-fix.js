'use strict';

// todo_aging_fix -- fix stage of the TODO/FIXME/HACK/XXX aging hygiene family.
// Mirrors function-length-review.js's split of review vs. fix: the review stage
// (todo-aging-review.js) classifies stale comments as resolved/valid/ambiguous,
// and this fix stage resolves the 'resolved' findings by deleting the stale
// TODO/FIXME/HACK comment line from the source file.
//
// The fix logic is intentionally minimal: for each resolved finding, read the
// file, delete the line containing the stale comment, write the file back. No
// other code changes. Uses nextCandidateFulfillmentTask for task processing.
//
// Uses reconcileFlags from flag-store.js for deduplication and isSuppressed from
// suppression-store.js for user suppressions.

const path = require('path');
const fs = require('fs');
const { reconcileFlags } = require('./flag-store.js');
const { isSuppressed } = require('./suppression-store.js');
const { hygieneFamily } = require('./hygiene-family.js');

// Candidate doc path for todo-aging-fix. Mirrors function-length-review's
// functionLengthCandidatesPath pattern: env-var override, then default under
// Docs/ directory.
function todoAgingCandidatesPath(getConfig) {
  if (process.env.AGENT_MANAGER_TODO_AGING_CANDIDATES_PATH) {
    return process.env.AGENT_MANAGER_TODO_AGING_CANDIDATES_PATH;
  }
  const cfg = getConfig();
  return path.join(cfg.applyRepoRoot || cfg.repoRoot, 'Docs', 'TODO_AGING_CANDIDATES.md');
}

// Read a file if it exists, return null on error.
function readIfExists(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

// Fix function: processes resolved findings by deleting the stale comment line.
// Returns { fixed: number, errors: number, results: [...] }
function fix(flags, options = {}) {
  if (!Array.isArray(flags)) {
    return { fixed: 0, errors: 0, results: [] };
  }

  const { repoRoot, pipelineDir } = options;
  if (!repoRoot) {
    return { fixed: 0, errors: 0, results: [] };
  }

  // Filter for resolved findings from todo-aging-review
  const resolvedFindings = flags.filter(f =>
    f.source === 'todo-aging-review' && f.classification === 'resolved'
  );

  if (resolvedFindings.length === 0) {
    return { fixed: 0, errors: 0, results: [] };
  }

  let fixed = 0;
  let errors = 0;
  const results = [];

  for (const finding of resolvedFindings) {
    try {
      // Skip if suppressed
      if (pipelineDir && isSuppressed(pipelineDir, 'todo-aging-fix', finding.comment)) {
        results.push({
          file: finding.file,
          line: finding.line,
          status: 'suppressed',
        });
        continue;
      }

      const filePath = path.join(repoRoot, finding.file);
      const content = readIfExists(filePath);
      if (!content) {
        results.push({
          file: finding.file,
          line: finding.line,
          status: 'error',
          reason: 'file not readable',
        });
        errors++;
        continue;
      }

      const lines = content.split('\n');
      const lineNumber = finding.line - 1; // Convert to 0-based index

      if (lineNumber < 0 || lineNumber >= lines.length) {
        results.push({
          file: finding.file,
          line: finding.line,
          status: 'error',
          reason: 'line number out of range',
        });
        errors++;
        continue;
      }

      // Delete the comment line
      lines.splice(lineNumber, 1);

      // Write the file back
      const newContent = lines.join('\n');
      fs.writeFileSync(filePath, newContent, 'utf8');

      fixed++;
      results.push({
        file: finding.file,
        line: finding.line,
        status: 'fixed',
      });
    } catch (e) {
      errors++;
      results.push({
        file: finding.file,
        line: finding.line,
        status: 'error',
        reason: e.message,
      });
    }
  }

  return { fixed, errors, results };
}

// Register the todo_aging_fix task source
function register({ getConfig, nextCandidateFulfillmentTask, taskIdExistsInQueue, taskPriority }) {
  const { registerTaskSource } = require('agent-manager/src/task-source-registry.js');

  registerTaskSource('todo_aging_fix', {
    hygieneFamily: hygieneFamily('todo_aging', { candidateDoc: true }),
    priority: taskPriority('todo_aging_fix', 72),
    next: () => {
      return nextCandidateFulfillmentTask(todoAgingCandidatesPath(getConfig), 'todo_aging_fix');
    },
    candidateFulfillment: true,
    noCandidateSplit: true,
    candidatesPath: () => todoAgingCandidatesPath(getConfig),
    candidateDocTitle: '# TODO Aging Candidates',
  });
}

module.exports = {
  register,
  fix,
  todoAgingCandidatesPath,
  readIfExists,
};
