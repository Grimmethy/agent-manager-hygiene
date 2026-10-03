'use strict';

// unused_export / deadcode_fix -- direct coverage for the register()/apply candidate-doc
// path added 2026-09-24 (before this, a GENUINE verdict was thrown away entirely by
// applyVerdictOnly; see this file's own header for the full history). Mirrors
// function-length-review.test.js's own apply-level test, same shape.

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
  delete require.cache[require.resolve('./unused-export.js')];
  const { getConfig } = require('agent-manager/src/config.js');
  const { nextCandidateFulfillmentTask, taskIdExistsInQueue, taskPriority } = require('agent-manager/src/task-sources.js');
  const deps = { getConfig, nextCandidateFulfillmentTask, taskIdExistsInQueue, taskPriority };
  const mod = require('./unused-export.js');
  mod.register(deps);
  return { ...deps, nextUnusedExportTask: mod.nextUnusedExportTask, getRegisteredSource: registry.getRegisteredSource };
}

function makeRepo() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'unused-export-test-'));
}

test('nextUnusedExportTask returns null when queue/dead-code-flags.json does not exist', () => {
  const dir = makeRepo();
  const { nextUnusedExportTask, getConfig, taskIdExistsInQueue } = freshPlugin(dir);
  assert.equal(nextUnusedExportTask({ getConfig, taskIdExistsInQueue }), null);
});

test('nextUnusedExportTask turns the oldest not-yet-queued flag entry into a task', () => {
  const dir = makeRepo();
  fs.mkdirSync(path.join(dir, 'queue'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'queue', 'dead-code-flags.json'), JSON.stringify([
    { symbol: 'newer', definedIn: 'src/b.js', callSites: [], scannedAt: '2026-09-24T00:00:00.000Z' },
    { symbol: 'older', definedIn: 'src/a.js', callSites: [{ file: 'src/c.js', line: 3 }], scannedAt: '2026-09-01T00:00:00.000Z' },
  ]));
  const { nextUnusedExportTask, getConfig, taskIdExistsInQueue } = freshPlugin(dir);
  const task = nextUnusedExportTask({ getConfig, taskIdExistsInQueue });
  assert.equal(task.source, 'deadcode_triage');
  assert.equal(task.id, 'deadcode-older-src-a-js');
  assert.equal(task.promptContext.symbol, 'older');
  assert.deepEqual(task.promptContext.callSites, [{ file: 'src/c.js', line: 3 }]);
});

test('nextUnusedExportTask skips a STALE flag whose defining file shows a same-file use and takes the next one (brain-dump #1742)', () => {
  const dir = makeRepo();
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'queue'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'a.js'), 'function helper() {}\nfunction main() { return helper(); }\nmodule.exports = { main, helper };\n');
  fs.writeFileSync(path.join(dir, 'src', 'b.js'), 'function lone() {}\nmodule.exports = { lone };\n');
  fs.writeFileSync(path.join(dir, 'queue', 'dead-code-flags.json'), JSON.stringify([
    { symbol: 'helper', definedIn: 'src/a.js', callSites: [], scannedAt: '2026-09-01T00:00:00.000Z' }, // oldest, but used by main() in its own file
    { symbol: 'lone', definedIn: 'src/b.js', callSites: [], scannedAt: '2026-09-02T00:00:00.000Z' },
  ]));
  const { nextUnusedExportTask, getConfig, taskIdExistsInQueue } = freshPlugin(dir);
  const task = nextUnusedExportTask({ getConfig, taskIdExistsInQueue });
  assert.equal(task.promptContext.symbol, 'lone');
});

test('nextUnusedExportTask is fail-open: a flag whose defining file cannot be read is still turned into a task', () => {
  const dir = makeRepo();
  fs.mkdirSync(path.join(dir, 'queue'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'queue', 'dead-code-flags.json'), JSON.stringify([
    { symbol: 'ghost', definedIn: 'src/does-not-exist.js', callSites: [], scannedAt: '2026-09-01T00:00:00.000Z' },
  ]));
  const { nextUnusedExportTask, getConfig, taskIdExistsInQueue } = freshPlugin(dir);
  const task = nextUnusedExportTask({ getConfig, taskIdExistsInQueue });
  assert.equal(task.promptContext.symbol, 'ghost');
});

test('unused_export declares its own dead-code review guidance, directToMain, and groundingFields on callSites', () => {
  const dir = makeRepo();
  const { getRegisteredSource } = freshPlugin(dir);
  const src = getRegisteredSource('unused_export');
  assert.equal(src.directToMain, true);
  assert.deepEqual(src.groundingFields, ['callSites']);
  assert.match(src.reviewGuidance, /NOT itself a code change/);
  assert.match(src.reviewCompletenessQuestion, /decisive GENUINE-or-FALSE-POSITIVE-or-UNCERTAIN verdict/);
});

test('unused_export apply: a GENUINE verdict appends a real candidate to the dead-code candidates doc', () => {
  const dir = makeRepo();
  const candidatesPath = path.join(dir, 'Docs', 'DEAD_CODE_CANDIDATES.md');
  process.env.AGENT_MANAGER_DEAD_CODE_CANDIDATES_PATH = candidatesPath;
  const { getRegisteredSource } = freshPlugin(dir);

  const result = getRegisteredSource('unused_export').apply({
    implementResponse: [
      '### AC-001 · Remove dead helper oldHelper',
      'Strength: Strong',
      'Files: src/old.js',
      '',
      'Problem:',
      'oldHelper is exported but has zero real call sites anywhere in the repo.',
      '',
      'Solution:',
      'Delete the oldHelper export from src/old.js.',
      '',
      'Benefits:',
      'Less dead surface area for a future reader to puzzle over.',
    ].join('\n'),
  });
  assert.equal(result.candidateCount, 1);
  const text = fs.readFileSync(candidatesPath, 'utf8');
  assert.match(text, /### AC-1 · Remove dead helper oldHelper/);
  assert.match(text, /Files: src\/old\.js/);
});

test('unused_export apply: a FALSE POSITIVE/UNCERTAIN verdict (no candidate block) writes nothing to the doc', () => {
  const dir = makeRepo();
  const candidatesPath = path.join(dir, 'Docs', 'DEAD_CODE_CANDIDATES.md');
  process.env.AGENT_MANAGER_DEAD_CODE_CANDIDATES_PATH = candidatesPath;
  const { getRegisteredSource } = freshPlugin(dir);

  const result = getRegisteredSource('unused_export').apply({
    implementResponse: 'FALSE POSITIVE -- this is a barrel re-export consumed via a wildcard import the grep cannot see.',
  });
  assert.equal(result.skipped, true);
  assert.equal(fs.existsSync(candidatesPath), false);
});

test('deadcode_fix consumes a Strong dead-code candidate via the generic candidate-fulfillment path', () => {
  const dir = makeRepo();
  const candidatesPath = path.join(dir, 'Docs', 'DEAD_CODE_CANDIDATES.md');
  process.env.AGENT_MANAGER_DEAD_CODE_CANDIDATES_PATH = candidatesPath;
  fs.mkdirSync(path.dirname(candidatesPath), { recursive: true });
  fs.writeFileSync(candidatesPath, [
    '# Dead Code Removal Candidates',
    '',
    '### AC-1 · Remove dead helper oldHelper',
    'Strength: Strong',
    'Files: src/old.js',
    '',
    'Problem:',
    'oldHelper is exported but has zero real call sites anywhere in the repo.',
    '',
    'Solution:',
    'Delete the oldHelper export from src/old.js.',
    '',
    'Benefits:',
    'Less dead surface area.',
  ].join('\n'));
  const { getRegisteredSource } = freshPlugin(dir);

  const src = getRegisteredSource('deadcode_fix');
  assert.equal(src.candidateFulfillment, true);
  assert.notEqual(src.directToMain, true, 'a real removal diff must go through the normal branch+merge path');
  const task = src.next();
  assert.ok(task, 'deadcode_fix must pick up the Strong candidate');
  assert.equal(task.id, 'deadcode-fix-ac-1');
  assert.match(task.title, /Remove dead helper oldHelper/);
});
