'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildFlagInventory } = require('./flag-inventory.js');

function repoWith(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flaginv-'));
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body);
  }
  return dir;
}
const flag = (o) => ({ rule: 'silent-catch-block', file: 'src/a.ts', line: 3, confidence: 'high', projectSlug: 'proj', scannedAt: '2026-09-01T00:00:00Z', ...o });

test('buildFlagInventory: classifies every flag in the same order the review loops do', () => {
  const repo = repoWith({ 'src/a.ts': 'x\ny\nz\n', 'src/b.ts': 'x\ny\nz\n', 'src/c.ts': 'x\ny\nz\n', 'src/d.ts': 'x\ny\nz\n', 'src/e.ts': 'x\ny\nz\n' });
  const states = {
    'id-src/a.ts': { state: 'pending' },
    'id-src/b.ts': { state: 'needs-clarification' },
    'id-src/c.ts': { state: 'done', disposition: 'dismissed' },
  };
  const inv = buildFlagInventory({
    projectTag: 'proj', repoRoot: repo,
    flags: [
      flag({ file: 'src/a.ts' }), flag({ file: 'src/b.ts' }), flag({ file: 'src/c.ts' }),
      flag({ file: 'src/gone.ts' }),                                        // file missing -> stale
      flag({ file: 'src/d.ts', confidence: 'low' }),                        // digest-batched
      flag({ file: 'src/e.ts', rule: 'exact-suppressed' }),                 // exact suppression
      flag({ file: 'src/e.ts', rule: 'cluster-suppressed', line: 9 }),      // cluster suppression
      flag({ file: 'src/e.ts', rule: 'real-one', scannedAt: '2026-08-20T00:00:00Z' }),  // waiting (oldest)
      flag({ file: 'src/e.ts', rule: 'real-two', scannedAt: '2026-09-05T00:00:00Z', confidence: 'med' }),
      flag({ projectSlug: 'other-project', file: 'src/a.ts' }),             // another project's flag: not counted
    ],
    idFor: (f) => `id-${f.file}`,
    taskState: (id) => states[id] || null,
    snippetFor: (f) => `snippet-${f.rule}`,
    isSuppressed: (rule, snippet) => snippet === 'snippet-exact-suppressed',
    isClusterSuppressed: (rule) => rule === 'cluster-suppressed',
    isDigestBatched: (f) => f.confidence === 'low',
  });
  assert.equal(inv.total, 9, "the other project's flag is excluded");
  assert.deepEqual(inv.counts, { waiting: 2, queued: 1, blocked: 1, done: 1, digest: 1, suppressed: 2, stale: 1 });
  assert.equal(inv.counts.queued, 1);
  assert.equal(inv.counts.blocked, 1);
  assert.equal(inv.counts.done, 1);
  assert.equal(inv.counts.stale, 1);
  assert.equal(inv.counts.digest, 1);
  assert.equal(inv.counts.suppressed, 2);
  assert.equal(inv.counts.waiting, 2, 'exactly real-one and real-two');
  assert.deepEqual(inv.doneByDisposition, { dismissed: 1 });
  assert.equal(inv.oldestWaitingAt, '2026-08-20T00:00:00Z');
  assert.equal(inv.approximate, true);
});

test('buildFlagInventory: items list waiting first, oldest first; every item carries status and its task state', () => {
  const repo = repoWith({ 'src/a.ts': 'x\ny\nz\n', 'src/b.ts': 'x\ny\nz\n' });
  const inv = buildFlagInventory({
    projectTag: 'proj', repoRoot: repo,
    flags: [flag({ file: 'src/a.ts', scannedAt: '2026-09-09T00:00:00Z' }), flag({ file: 'src/b.ts', scannedAt: '2026-09-01T00:00:00Z' }), flag({ file: 'src/a.ts', line: 7, scannedAt: '2026-09-02T00:00:00Z' })],
    idFor: (f) => `id-${f.file}-${f.line}`,
    taskState: (id) => (id === 'id-src/a.ts-3' ? { state: 'done', disposition: 'merged' } : null),
  });
  assert.deepEqual(inv.items.map((i) => [i.file, i.line, i.status]), [['src/b.ts', 3, 'waiting'], ['src/a.ts', 7, 'waiting'], ['src/a.ts', 3, 'done']]);
  assert.equal(inv.items[2].taskState, 'done');
  assert.equal(inv.items[2].disposition, 'merged');
});

test('buildFlagInventory: waitingByConfidence, itemCap truncation, and a repo-wide flag (no file) is never stale', () => {
  const repo = repoWith({ 'src/a.ts': 'x\n' });
  const flags = [flag({ confidence: 'high' }), flag({ line: 4, confidence: 'high' }), flag({ line: 5, confidence: 'low' }), flag({ file: null, rule: 'repo-wide', line: 0, confidence: null })];
  const inv = buildFlagInventory({ projectTag: 'proj', repoRoot: repo, flags, idFor: (f) => `id-${f.rule}-${f.file}-${f.line}`, taskState: () => null, itemCap: 2 });
  assert.deepEqual(inv.waitingByConfidence, { high: 2, low: 1, 'n/a': 1 });
  assert.equal(inv.counts.stale, 0);
  assert.equal(inv.items.length, 2);
  assert.equal(inv.truncated, true);
  assert.equal(inv.total, 4, 'counts always cover every flag, not just the capped items');
});

test('buildFlagInventory: tolerates garbage input (non-array flags, null entries) and never throws', () => {
  assert.equal(buildFlagInventory({ projectTag: 'p', repoRoot: '/nonexistent', flags: null, idFor: () => 'x', taskState: () => null }).total, 0);
  assert.equal(buildFlagInventory({ projectTag: 'p', repoRoot: '/nonexistent', flags: [null, undefined, flag({ projectSlug: 'p', file: null })], idFor: () => 'x', taskState: () => null }).total, 1);
});

// --- through the registered hooks, with real flag files -------------------------------------------------------

function freshPlugin(repoRoot, pipelineDir) {
  process.env.AGENT_MANAGER_REPO_ROOT = repoRoot;
  process.env.AGENT_MANAGER_PIPELINE_DIR = pipelineDir;
  const registry = require('agent-manager/src/task-source-registry.js');
  registry.clearRegistry();
  require('agent-manager/src/model-profile-registry.js').clearModelProfileRegistry();
  delete require.cache[require.resolve('agent-manager/src/task-sources.js')];
  for (const m of ['./observability-review.js', './performance-review.js', './function-length-review.js', './unused-export.js']) delete require.cache[require.resolve(m)];
  const { getConfig } = require('agent-manager/src/config.js');
  const { nextCandidateFulfillmentTask, taskIdExistsInQueue, taskPriority } = require('agent-manager/src/task-sources.js');
  const deps = { getConfig, nextCandidateFulfillmentTask, taskIdExistsInQueue, taskPriority };
  for (const m of ['./observability-review.js', './performance-review.js', './function-length-review.js', './unused-export.js']) require(m).register(deps);
  return registry.getRegisteredSource;
}

test('registered inventory hooks use each source\'s own task-id formula (observability, performance, function-length, unused-export)', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'flaginv-repo-'));
  const proj = path.basename(repo);
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'src', 'Big File.ts'), 'a\nb\nc\nd\ne\n');
  const pipe = fs.mkdtempSync(path.join(os.tmpdir(), 'flaginv-pipe-'));
  fs.mkdirSync(path.join(pipe, 'queue'), { recursive: true });
  const w = (n, v) => fs.writeFileSync(path.join(pipe, 'queue', n), JSON.stringify(v));
  const base = { file: 'src/Big File.ts', line: 2, projectSlug: proj, scannedAt: '2026-09-01T00:00:00Z' };
  w('observability-flags.json', [{ ...base, rule: 'silent-catch-block', confidence: 'high' }, { ...base, line: 4, rule: 'silent-catch-block', confidence: 'low' }]);
  w('performance-flags.json', [{ ...base, rule: 'await-in-loop' }]);
  w('function-length-flags.json', [{ ...base, rule: 'function-too-long', lengthLines: 120 }]);
  w('dead-code-flags.json', [{ symbol: 'oldHelper', definedIn: 'src/Big File.ts', callSites: [], scannedAt: '2026-09-01T00:00:00Z' }]);
  const get = freshPlugin(repo, pipe);

  const seen = [];
  const taskState = (id) => { seen.push(id); return id === `observability-${proj.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-silent-catch-block-src-big-file-ts-2` ? { state: 'done', disposition: 'dismissed' } : null; };
  const obs = get('observability_review').inventory({ taskState });
  assert.equal(obs.total, 2);
  assert.equal(obs.counts.done, 1, 'the high-confidence flag has a task, found by the observability id formula');
  assert.equal(obs.counts.digest, 1, 'the low-confidence flag is digest-batched, not waiting');
  assert.equal(obs.counts.waiting, 0);

  assert.equal(get('performance_review').inventory({ taskState }).counts.waiting, 1);
  assert.equal(get('function_length_review').inventory({ taskState }).counts.waiting, 1);
  const dead = get('unused_export').inventory({ taskState });
  assert.equal(dead.counts.waiting, 1);
  assert.ok(seen.some((id) => id.startsWith('function-length-')), 'function-length uses its own id shape');
  assert.ok(seen.some((id) => id.startsWith('performance-')));
  assert.ok(seen.some((id) => id === 'deadcode-oldhelper-src-big-file-ts'), seen.join(','));
});

test('inventory hooks are PURE READS: they never rewrite the flags files or create coverage files', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'flaginv-repo2-'));
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'src', 'a.ts'), 'try { x() } catch {}\n');
  const pipe = fs.mkdtempSync(path.join(os.tmpdir(), 'flaginv-pipe2-'));
  fs.mkdirSync(path.join(pipe, 'queue'), { recursive: true });
  const flagsFile = path.join(pipe, 'queue', 'observability-flags.json');
  fs.writeFileSync(flagsFile, JSON.stringify([{ rule: 'silent-catch-block', file: 'src/a.ts', line: 1, projectSlug: path.basename(repo), scannedAt: '2020-01-01T00:00:00Z' }]));
  const before = fs.readFileSync(flagsFile, 'utf8');
  const beforeStat = fs.statSync(flagsFile).mtimeMs;
  const get = freshPlugin(repo, pipe);
  get('observability_review').inventory({ taskState: () => null });
  assert.equal(fs.readFileSync(flagsFile, 'utf8'), before);
  assert.equal(fs.statSync(flagsFile).mtimeMs, beforeStat);
  assert.deepEqual(fs.readdirSync(pipe).sort(), ['queue'], 'no coverage/scan side-effect files appeared');
});

// A decomposed task becomes a coordinating hub while workers implement its pieces -- that is in flight, not "needs you".
test('buildFlagInventory: a flag whose task is a coordinating hub counts as queued (in flight), not blocked', () => {
  const repo = repoWith({ 'src/a.ts': 'x\ny\nz\n' });
  const inv = buildFlagInventory({
    projectTag: 'proj', repoRoot: repo, flags: [flag({ file: 'src/a.ts' })],
    idFor: (f) => `id-${f.file}`, taskState: () => ({ state: 'coordinating' }),
  });
  assert.equal(inv.items[0].status, 'queued');
  assert.equal(inv.counts.queued, 1);
  assert.equal(inv.counts.blocked, 0);
});
