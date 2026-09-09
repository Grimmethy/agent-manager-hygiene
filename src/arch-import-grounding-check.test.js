'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  runGroundingCheck, checkFabricatedCitations, parseGroundingVerdict,
} = require('./arch-import-grounding-check.js');

// A throwaway repo + env so Check 0's getConfig()/checkFilePaths runs deterministically
// regardless of how the suite was invoked. getConfig() reads process.env fresh each call.
function withTmpRepo(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigc-'));
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src', 'task-sources.js'), '// real\n');
  const saved = {
    root: process.env.AGENT_MANAGER_REPO_ROOT,
    dirs: process.env.AGENT_MANAGER_GREP_DIRS,
  };
  process.env.AGENT_MANAGER_REPO_ROOT = dir;
  process.env.AGENT_MANAGER_GREP_DIRS = 'src';
  return Promise.resolve(fn(dir)).finally(() => {
    if (saved.root === undefined) delete process.env.AGENT_MANAGER_REPO_ROOT; else process.env.AGENT_MANAGER_REPO_ROOT = saved.root;
    if (saved.dirs === undefined) delete process.env.AGENT_MANAGER_GREP_DIRS; else process.env.AGENT_MANAGER_GREP_DIRS = saved.dirs;
    fs.rmSync(dir, { recursive: true, force: true });
  });
}

const REAL_FILE = {
  path: 'docs/adr/0019-deep-dive-pipeline.md',
  content: [
    '# ADR-0019: Deep Dive Pipeline',
    '',
    'Review requires a majority of 2 out of 3 votes to approve.',
    'Each reviewer casts exactly one vote per task.',
  ].join('\n'),
};

const task = (over = {}) => ({
  source: 'arch_import',
  promptContext: {
    sourceProject: 'some/repo', itemTitle: 'x', rating: 'Adapt',
    harnessFiles: [REAL_FILE],
    ...over.promptContext,
  },
  ...over,
});

// --- checkFabricatedCitations (free, deterministic) -------------------------------------

test('checkFabricatedCitations flags a fabricated file path not among the real harness-matched files', () => {
  const r = checkFabricatedCitations(task(), 'The draft targets `src/agent-manager/task-queue.js`, which does not exist.');
  assert.equal(r.length, 1);
  assert.equal(r[0].kind, 'fabricated-citation');
  assert.match(r[0].detail, /task-queue\.js/);
});

test('checkFabricatedCitations does not flag a real path that genuinely was fetched', () => {
  const r = checkFabricatedCitations(task(), 'See `docs/adr/0019-deep-dive-pipeline.md` for the gate rules.');
  assert.deepEqual(r, []);
});

test('checkFabricatedCitations flags a class-shaped symbol absent from every real file', () => {
  const r = checkFabricatedCitations(task(), 'It uses a `TotallyMadeUpClass` internally.');
  assert.equal(r.length, 1);
  assert.match(r[0].detail, /TotallyMadeUpClass/);
});

test('checkFabricatedCitations does not flag a real symbol that genuinely appears in the file content', () => {
  const r = checkFabricatedCitations(task(), 'ADR-0019 describes the gate.');
  assert.deepEqual(r, []);
});

test('checkFabricatedCitations returns nothing when the task has no real harness files to check against', () => {
  const r = checkFabricatedCitations(task({ promptContext: { harnessFiles: [] } }), 'References `TotallyMadeUp`.');
  assert.deepEqual(r, []);
});

// --- parseGroundingVerdict ----------------------------------------------------------------

test('parseGroundingVerdict parses GROUNDED and NOT_GROUNDED, treats noise as ok', () => {
  assert.deepEqual(parseGroundingVerdict('GROUNDED'), { verdict: 'ok' });
  assert.deepEqual(parseGroundingVerdict('NOT_GROUNDED -- ADR-0019 requires 2 of 3 votes, not a single vote per reviewer'),
    { verdict: 'ungrounded', reason: 'ADR-0019 requires 2 of 3 votes, not a single vote per reviewer' });
  assert.deepEqual(parseGroundingVerdict('unrelated 3b noise'), { verdict: 'ok' });
});

// --- runGroundingCheck end-to-end (mocked model call) ------------------------------------

test('Check 0: a Files: line naming a path that resolves nowhere -> "fabricated file path(s)" verdict, no model call', async () => {
  await withTmpRepo(async () => {
    let calls = 0;
    const call = async () => { calls += 1; return { response: 'GROUNDED' }; };
    const writeUp = [
      '### AC-001 · Something',
      'Strength: Strong',
      'Files: src/task-sources.js, src/agent-manager/task-queue.js',
      '',
      'Problem: ...',
    ].join('\n');
    const r = await runGroundingCheck(task(), writeUp, { call });
    assert.equal(r.verdict, 'ungrounded');
    assert.match(r.reason, /^fabricated file path\(s\): src\/agent-manager\/task-queue\.js\b/);
    assert.doesNotMatch(r.reason, /task-sources\.js/); // the real one is not named
    assert.equal(calls, 0);
  });
});

test('Check 0: a Files: line naming only real repo files does not fire (falls through)', async () => {
  await withTmpRepo(async () => {
    const call = async () => ({ response: 'GROUNDED' });
    const r = await runGroundingCheck(task(), 'Files: src/task-sources.js\n\nProblem: real.', { call });
    assert.deepEqual(r, { verdict: 'ok' });
  });
});

test('runGroundingCheck catches a fabricated file path deterministically, no model call', async () => {
  let calls = 0;
  const call = async () => { calls += 1; return { response: 'GROUNDED' }; };
  const r = await runGroundingCheck(task(), 'The draft targets `src/agent-manager/task-queue.js`.', { call });
  assert.equal(r.verdict, 'ungrounded');
  assert.equal(calls, 0, 'the deterministic check must short-circuit before any model call');
});

test('runGroundingCheck falls back to the cheap model for a contradiction the deterministic check cannot catch', async () => {
  const call = async () => ({ response: 'NOT_GROUNDED -- ADR-0019 requires a majority of 2 of 3 votes, not a single vote per reviewer' });
  const r = await runGroundingCheck(task(), 'Per `docs/adr/0019-deep-dive-pipeline.md`, the gate is a single vote per reviewer.', { call });
  assert.equal(r.verdict, 'ungrounded');
  assert.match(r.reason, /single vote per reviewer/);
});

test('runGroundingCheck passes through a genuinely well-grounded candidate', async () => {
  const call = async () => ({ response: 'GROUNDED' });
  const r = await runGroundingCheck(task(), 'Per `docs/adr/0019-deep-dive-pipeline.md`, review requires 2 of 3 votes.', { call });
  assert.deepEqual(r, { verdict: 'ok' });
});

test('runGroundingCheck is advisory: a throwing/failing model call never blocks the draft', async () => {
  const call = async () => { throw new Error('model call timed out'); };
  const r = await runGroundingCheck(task(), 'Describes the real ADR correctly.', { call });
  assert.equal(r.verdict, 'ok');
});

test('runGroundingCheck treats a legitimate empty ("nothing applies") draft as ok with no model call', async () => {
  let calls = 0;
  const call = async () => { calls += 1; return { response: 'NOT_GROUNDED -- x' }; };
  const r = await runGroundingCheck(task(), '', { call });
  assert.deepEqual(r, { verdict: 'ok' });
  assert.equal(calls, 0);
});

test('runGroundingCheck is a no-op when AGENT_MANAGER_ARCH_IMPORT_GROUNDING_CHECK=false', async () => {
  process.env.AGENT_MANAGER_ARCH_IMPORT_GROUNDING_CHECK = 'false';
  try {
    const call = async () => ({ response: 'NOT_GROUNDED -- anything' });
    const r = await runGroundingCheck(task(), 'References `src/agent-manager/task-queue.js`.', { call });
    assert.deepEqual(r, { verdict: 'ok' });
  } finally {
    delete process.env.AGENT_MANAGER_ARCH_IMPORT_GROUNDING_CHECK;
  }
});

test('runGroundingCheck skips the model call when the task has no harness files fetched at all', async () => {
  let calls = 0;
  const call = async () => { calls += 1; return { response: 'NOT_GROUNDED -- x' }; };
  const r = await runGroundingCheck(task({ promptContext: { harnessFiles: [] } }), 'Some claim.', { call });
  assert.deepEqual(r, { verdict: 'ok' });
  assert.equal(calls, 0);
});
