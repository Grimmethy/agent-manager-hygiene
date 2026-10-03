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
  // The snippet must be the WHOLE function body (143 lines here, under the cap), not a
  // fixed +30-line window that stops mid-body -- see functionSnippet's own comment.
  assert.match(task.promptContext.snippet, /const x0 = 0;/);
  assert.match(task.promptContext.snippet, /const x139 = 139;/);
  assert.match(task.promptContext.snippet, /return 0;/);
  assert.doesNotMatch(task.promptContext.snippet, /\[truncated for review/);
});

test('functionSnippet falls back to the fixed window when lengthLines is missing/invalid', () => {
  const { functionSnippet } = require('./function-length-review.js');
  const content = Array.from({ length: 60 }, (_, i) => `line ${i}`).join('\n');
  const wide = functionSnippet(content, 10, 40);
  const narrow = functionSnippet(content, 10, undefined);
  assert.ok(wide.split('\n').length > narrow.split('\n').length);
  assert.ok(narrow.split('\n').length <= 2 + 30 + 2);
});

test('functionSymbolFromDetail reads the function name off the scanner detail string', () => {
  const { functionSymbolFromDetail } = require('./function-length-review.js');
  assert.equal(functionSymbolFromDetail('function "nextArchImportTask" is 110 lines long (threshold 100) -- consider decomposing into smaller, single-purpose functions'), 'nextArchImportTask');
  assert.equal(functionSymbolFromDetail('function "_start_pipeline" is 108 lines long (threshold 100) -- consider decomposing'), '_start_pipeline');
  assert.equal(functionSymbolFromDetail('function "$el" is 101 lines long (threshold 100)'), '$el');
});

test('functionSymbolFromDetail returns null for the no-name form and for missing, non-string or malformed input', () => {
  const { functionSymbolFromDetail } = require('./function-length-review.js');
  assert.equal(functionSymbolFromDetail('this function is 120 lines long (threshold 100) -- consider decomposing'), null);
  assert.equal(functionSymbolFromDetail('function "   " is 5 lines long'), null);
  assert.equal(functionSymbolFromDetail('function "abc is unterminated'), null);
  assert.equal(functionSymbolFromDetail(undefined), null);
  assert.equal(functionSymbolFromDetail(null), null);
  assert.equal(functionSymbolFromDetail(42), null);
});

test('nextFunctionLengthReviewTask truncates the snippet for a pathologically long function, with an explicit marker', () => {
  const dir = makeRepo();
  const deps = freshPlugin(dir);
  const body = Array.from({ length: 400 }, (_, i) => `  const x${i} = ${i};`).join('\n');
  fs.writeFileSync(path.join(dir, 'huge.js'), `function monster() {\n${body}\n  return 0;\n}\n`);
  const task = deps.nextFunctionLengthReviewTask({ repoRoot: dir, pipelineDir: dir, defaultDomain: 'default', taskIdExistsInQueue: deps.taskIdExistsInQueue });
  assert.ok(task);
  assert.match(task.promptContext.snippet, /const x0 = 0;/);
  assert.match(task.promptContext.snippet, /\[truncated for review: this function continues for \d+ more line\(s\) not shown\]/);
  assert.doesNotMatch(task.promptContext.snippet, /const x399 = 399;/);
});

test('a rescan prunes a persisted flag the scanner no longer reproduces (function moved / line-shifted) and emits no task for it', () => {
  const dir = makeRepo();
  const deps = freshPlugin(dir);
  // A real over-threshold function -> a legitimate live flag.
  fs.writeFileSync(path.join(dir, 'big.js'), longFunctionSource('bloated'));

  // First pass: creates the flags file and stamps coverage.lastScannedAt.
  const first = deps.nextFunctionLengthReviewTask({ repoRoot: dir, pipelineDir: dir, defaultDomain: 'default', taskIdExistsInQueue: () => false });
  assert.ok(first && first.promptContext.file === 'big.js');

  const flagsPath = path.join(dir, 'queue', 'function-length-flags.json');
  const flags = JSON.parse(fs.readFileSync(flagsPath, 'utf8'));
  // Inject a stale flag: big.js exists, but has no long function at line 999 -- this is
  // the "function was decomposed / moved / relocated to another repo, but src/<file>
  // still exists" case the old file-exists-only prune could never clean up.
  flags.push({ rule: 'function-too-long', file: 'big.js', line: 999, detail: 'function "ghost" is 300 lines long', projectSlug: path.basename(dir), scannedAt: '2020-01-01T00:00:00.000Z' });
  fs.writeFileSync(flagsPath, JSON.stringify(flags));
  // Force the next call to be due for a rescan.
  fs.writeFileSync(path.join(dir, 'function-length-coverage.json'), JSON.stringify({ lastScannedAt: '2020-01-01T00:00:00.000Z' }));

  // Second pass: the stale flag (oldest scannedAt, so it would be tried first) must be
  // gone, and the only task offered is the real big.js one again.
  const second = deps.nextFunctionLengthReviewTask({ repoRoot: dir, pipelineDir: dir, defaultDomain: 'default', taskIdExistsInQueue: () => false });
  const afterFlags = JSON.parse(fs.readFileSync(flagsPath, 'utf8'));
  assert.equal(afterFlags.some((f) => f.line === 999), false, 'the stale flag must be pruned by the reconcile');
  assert.ok(second && second.promptContext.file === 'big.js' && second.promptContext.line !== 999);
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

// 2026-09-04: AC-15..AC-18 (2026-09-01) recursively split instead of ever landing a diff,
// same incident class that got pipeline_forensics_fix this flag the same day.
test('function_length_fix is registered noCandidateSplit -- a fix must produce a diff, never re-split', () => {
  const dir = makeRepo();
  const { getRegisteredSource } = freshPlugin(dir);
  assert.equal(getRegisteredSource('function_length_fix').noCandidateSplit, true);
});

test('function_length_review registers reviewGuidance so a prose verdict / candidate block is not rejected as "not code"', () => {
  const dir = makeRepo();
  const { getRegisteredSource } = freshPlugin(dir);
  const src = getRegisteredSource('function_length_review');
  assert.equal(typeof src.reviewGuidance, 'string');
  assert.match(src.reviewGuidance, /NOT a code change/);
  assert.match(src.reviewGuidance, /describing an extraction refactor rather than the actual code/);
  assert.match(src.reviewCompletenessQuestion, /decisive GENUINE-or-FALSE-POSITIVE verdict/);
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

test('function_length_review apply passes the scanner function name (promptContext.detail) as symbol, and null when there is none', () => {
  // Spies on core's applyArchDiscoveryCandidates instead of reading the written doc: the installed agent-manager core
  // may predate the `symbol` parameter (and so never write a Symbol: line), so this asserts the WIRING, not core.
  const dir = makeRepo();
  process.env.AGENT_MANAGER_FUNCTION_LENGTH_CANDIDATES_PATH = path.join(dir, 'Docs', 'FUNCTION_LENGTH_CANDIDATES.md');
  const core = require('agent-manager/src/candidate-docs.js');
  const original = core.applyArchDiscoveryCandidates;
  const calls = [];
  core.applyArchDiscoveryCandidates = (args) => { calls.push(args); return { skipped: true, reason: 'spy' }; };
  try {
    // freshPlugin() drops function-length-review.js from the require cache and re-requires it, so its top-level
    // destructure of applyArchDiscoveryCandidates picks up the spy installed above.
    const { getRegisteredSource } = freshPlugin(dir);
    const apply = getRegisteredSource('function_length_review').apply;
    apply({
      implementResponse: 'x',
      task: { promptContext: { snippet: 'function bloated() {}', detail: 'function "bloated" is 140 lines long (threshold 100) -- consider decomposing into smaller, single-purpose functions' } },
    });
    apply({ implementResponse: 'x', task: { promptContext: { snippet: 's' } } });
  } finally {
    core.applyArchDiscoveryCandidates = original;
    // Do not leave a module that captured the spy in the require cache.
    delete require.cache[require.resolve('./function-length-review.js')];
  }
  assert.equal(calls.length, 2);
  assert.equal(calls[0].symbol, 'bloated');
  assert.equal(calls[0].dedupe, true);
  assert.equal(calls[0].snippet, 'function bloated() {}');
  assert.equal(calls[1].symbol, null);
});

// --- 2026-09-26: candidate doc must live in the APPLY clone, not the live checkout ---

test('function_length_review apply and function_length_fix read/write the doc under applyRepoRoot, never the live repoRoot', () => {
  const live = makeRepo();
  const applyClone = makeRepo();
  const saved = { path: process.env.AGENT_MANAGER_FUNCTION_LENGTH_CANDIDATES_PATH, apply: process.env.AGENT_MANAGER_APPLY_REPO_ROOT };
  delete process.env.AGENT_MANAGER_FUNCTION_LENGTH_CANDIDATES_PATH;
  process.env.AGENT_MANAGER_APPLY_REPO_ROOT = applyClone;
  try {
    const { getRegisteredSource } = freshPlugin(live);
    const result = getRegisteredSource('function_length_review').apply({
      implementResponse: '### AC-001 · Decompose bloated()\nStrength: Strong\nFiles: big.js\n\nProblem:\nbloated() is long.\n\nSolution:\nSplit into helpers.\n\nBenefits:\nTestable.',
      task: { promptContext: { snippet: 'function bloated() {}' } },
    });
    assert.equal(result.candidateCount, 1);
    assert.ok(fs.existsSync(path.join(applyClone, 'Docs', 'FUNCTION_LENGTH_CANDIDATES.md')), 'entry landed in the apply clone');
    assert.equal(fs.existsSync(path.join(live, 'Docs', 'FUNCTION_LENGTH_CANDIDATES.md')), false, 'the live checkout is not touched');
    assert.equal(getRegisteredSource('function_length_fix').candidatesPath(), path.join(applyClone, 'Docs', 'FUNCTION_LENGTH_CANDIDATES.md'));
  } finally {
    if (saved.path === undefined) delete process.env.AGENT_MANAGER_FUNCTION_LENGTH_CANDIDATES_PATH; else process.env.AGENT_MANAGER_FUNCTION_LENGTH_CANDIDATES_PATH = saved.path;
    if (saved.apply === undefined) delete process.env.AGENT_MANAGER_APPLY_REPO_ROOT; else process.env.AGENT_MANAGER_APPLY_REPO_ROOT = saved.apply;
  }
});

test('function-length candidate path: env override wins; with no dedicated apply clone it falls back to repoRoot', () => {
  const dir = makeRepo();
  const saved = { path: process.env.AGENT_MANAGER_FUNCTION_LENGTH_CANDIDATES_PATH, apply: process.env.AGENT_MANAGER_APPLY_REPO_ROOT };
  delete process.env.AGENT_MANAGER_FUNCTION_LENGTH_CANDIDATES_PATH;
  delete process.env.AGENT_MANAGER_APPLY_REPO_ROOT;
  try {
    const { getRegisteredSource } = freshPlugin(dir);
    assert.equal(getRegisteredSource('function_length_fix').candidatesPath(), path.join(dir, 'Docs', 'FUNCTION_LENGTH_CANDIDATES.md'));
    process.env.AGENT_MANAGER_FUNCTION_LENGTH_CANDIDATES_PATH = '/tmp/explicit.md';
    assert.equal(getRegisteredSource('function_length_fix').candidatesPath(), '/tmp/explicit.md');
  } finally {
    if (saved.path === undefined) delete process.env.AGENT_MANAGER_FUNCTION_LENGTH_CANDIDATES_PATH; else process.env.AGENT_MANAGER_FUNCTION_LENGTH_CANDIDATES_PATH = saved.path;
    if (saved.apply === undefined) delete process.env.AGENT_MANAGER_APPLY_REPO_ROOT; else process.env.AGENT_MANAGER_APPLY_REPO_ROOT = saved.apply;
  }
});

test('function_length_review apply skips a candidate whose file + function is already in the doc (AC-187 vs AC-51), leaving the doc untouched', () => {
  const dir = makeRepo();
  const candidatesPath = path.join(dir, 'Docs', 'FUNCTION_LENGTH_CANDIDATES.md');
  process.env.AGENT_MANAGER_FUNCTION_LENGTH_CANDIDATES_PATH = candidatesPath;
  const { getRegisteredSource } = freshPlugin(dir);
  const block = (n, title) => [`### AC-00${n} · ${title}`, 'Strength: Strong', 'Files: big.js', '', 'Problem:', 'too long.', '', 'Solution:', 'Split it.', '', 'Benefits:', 'Testable.'].join('\n');
  const task = { promptContext: { rule: 'function-too-long', file: 'big.js', snippet: 'function bloated() {\n  // ...\n}' } };
  const apply = (implementResponse) => getRegisteredSource('function_length_review').apply({ implementResponse, task });

  assert.equal(apply(block(1, 'Decompose `bloated` into helpers')).candidateCount, 1);
  const before = fs.readFileSync(candidatesPath, 'utf8');
  const second = apply(block(2, 'Decompose `bloated` into four single-purpose helpers'));
  assert.equal(second.skipped, true);
  assert.equal(second.duplicateOf, 'AC-1');
  assert.equal(fs.readFileSync(candidatesPath, 'utf8'), before);
});
