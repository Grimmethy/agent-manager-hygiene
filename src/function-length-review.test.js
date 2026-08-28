'use strict';

// function-length-review had no dedicated test file while it lived in agent-manager
// (src/maintenance/) -- it was covered indirectly by task-sources.test.js and the
// observability/performance review suites. This adds direct coverage now that it lives in
// the plugin: the scanner-fed review task, and the register()/apply candidate-doc path.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

function freshPlugin(repoRoot) {
  process.env.AGENT_MANAGER_REPO_ROOT = repoRoot;
  process.env.AGENT_MANAGER_PIPELINE_DIR = repoRoot;
  const registry = require('agent-manager/src/task-source-registry.js');
  registry.clearRegistry();
  const { clearModelProfileRegistry } = require('agent-manager/src/model-profile-registry.js');
  clearModelProfileRegistry();
  delete require.cache[require.resolve('agent-manager/src/task-sources.js')];
  delete require.cache[require.resolve('./function-length-review.js')];
  const { getConfig } = require('agent-manager/src/config.js');
  const { nextCandidateFulfillmentTask, taskIdExistsInQueue, taskPriority } = require('agent-manager/src/task-sources.js');
  const deps = { getConfig, nextCandidateFulfillmentTask, taskIdExistsInQueue, taskPriority };
  const mod = require('./function-length-review.js');
  mod.register(deps);
  return { ...deps, nextFunctionLengthReviewTask: mod.nextFunctionLengthReviewTask, getRegisteredSource: registry.getRegisteredSource };
}

function makeRepo() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'function-length-review-test-'));
}

// A function comfortably over the default 100-line threshold (DEFAULT_MAX_FUNCTION_LINES
// in function-length-scan.js).
function longFunctionSource(name = 'bloated') {
  const body = Array.from({ length: 140 }, (_, i) => `  const x${i} = ${i};`).join('\n');
  return `function ${name}() {\n${body}\n  return 0;\n}\n`;
}

test('nextFunctionLengthReviewTask returns null and records lastScannedAt when nothing is over the threshold', () => {
  const dir = makeRepo();
  const deps = freshPlugin(dir);
  fs.writeFileSync(path.join(dir, 'small.js'), 'function tiny() { return 1; }\n');
  const coveragePath = path.join(dir, 'function-length-coverage.json');
  const result = deps.nextFunctionLengthReviewTask({ repoRoot: dir, pipelineDir: dir, defaultDomain: 'default', taskIdExistsInQueue: deps.taskIdExistsInQueue });
  assert.equal(result, null);
  assert.ok(JSON.parse(fs.readFileSync(coveragePath, 'utf8')).lastScannedAt);
});

test('nextFunctionLengthReviewTask emits a review task for an over-threshold function', () => {
  const dir = makeRepo();
  const deps = freshPlugin(dir);
  fs.writeFileSync(path.join(dir, 'big.js'), longFunctionSource('bloated'));
  const task = deps.nextFunctionLengthReviewTask({ repoRoot: dir, pipelineDir: dir, defaultDomain: 'default', taskIdExistsInQueue: deps.taskIdExistsInQueue });
  assert.ok(task, 'expected a review task for the long function');
  assert.equal(task.source, 'function_length_review');
  assert.equal(task.promptContext.file, 'big.js');
});

test('register() wires function_length_review (advisoryProse) + function_length_fix (candidateFulfillment)', () => {
  const dir = makeRepo();
  const { getRegisteredSource } = freshPlugin(dir);
  const review = getRegisteredSource('function_length_review');
  const fix = getRegisteredSource('function_length_fix');
  assert.ok(review && typeof review.apply === 'function');
  assert.equal(review.advisoryProse, true);
  assert.ok(fix && fix.candidateFulfillment === true);
  assert.notEqual(fix.emptyApproval, true, 'a fulfillment source must NOT auto-approve an empty draft (2026-08-28)');
  assert.equal(typeof review.buildPlanPrompt, 'function');
});

test('function_length_review apply appends a candidate (and threads the snippet) to the decomposition doc', () => {
  const dir = makeRepo();
  const candidatesPath = path.join(dir, 'Docs', 'FUNCTION_LENGTH_CANDIDATES.md');
  process.env.AGENT_MANAGER_FUNCTION_LENGTH_CANDIDATES_PATH = candidatesPath;
  const { getRegisteredSource } = freshPlugin(dir);

  const result = getRegisteredSource('function_length_review').apply({
    implementResponse: [
      '### AC-001 · Decompose bloated()',
      'Strength: Strong',
      'Files: big.js',
      '',
      'Problem:',
      'bloated() is 82 lines and does three unrelated things.',
      '',
      'Solution:',
      'Split into parse/compute/render helpers.',
      '',
      'Benefits:',
      'Each piece is independently testable.',
    ].join('\n'),
    task: { promptContext: { snippet: 'function bloated() {\n  // ...\n}' } },
  });
  assert.equal(result.candidateCount, 1);
  const text = fs.readFileSync(candidatesPath, 'utf8');
  assert.match(text, /### AC-1 · Decompose bloated\(\)/);
  assert.match(text, /Snippet:\n```\nfunction bloated\(\) \{/);
});
