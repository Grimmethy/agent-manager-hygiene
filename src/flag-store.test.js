'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { reconcileFlags, flagKey } = require('./flag-store.js');

function flag(file, line, extra = {}) {
  return { rule: 'function-too-long', file, line, projectSlug: 'proj', scannedAt: '2026-01-01T00:00:00.000Z', ...extra };
}

test('a successful scan prunes a flag it no longer reproduces (function shrank / moved / line-shifted)', () => {
  const stale = flag('a.js', 1552, { detail: 'nextArchImportTask ...' });
  const still = flag('b.js', 10);
  const { flags, changed } = reconcileFlags({
    flags: [stale, still],
    freshFindings: [flag('b.js', 10)], // only b.js:10 is still over threshold
    scanOk: true,
    projectTag: 'proj',
    repoRoot: '/nope',
  });
  assert.equal(changed, true);
  assert.deepEqual(flags.map(flagKey), ['function-too-long::b.js::10']);
});

test('a surviving flag keeps its ORIGINAL object (scannedAt / FIFO position preserved)', () => {
  const original = flag('b.js', 10, { scannedAt: '2025-06-01T00:00:00.000Z' });
  const { flags } = reconcileFlags({
    flags: [original],
    freshFindings: [flag('b.js', 10, { scannedAt: '2026-09-09T00:00:00.000Z' })],
    scanOk: true,
    projectTag: 'proj',
    repoRoot: '/nope',
  });
  assert.equal(flags.length, 1);
  assert.equal(flags[0].scannedAt, '2025-06-01T00:00:00.000Z', 'kept flag must not be replaced by the fresh finding');
});

test('a genuinely new finding is appended', () => {
  const { flags, changed } = reconcileFlags({
    flags: [flag('b.js', 10)],
    freshFindings: [flag('b.js', 10), flag('c.js', 20)],
    scanOk: true,
    projectTag: 'proj',
    repoRoot: '/nope',
  });
  assert.equal(changed, true);
  assert.deepEqual(flags.map(flagKey).sort(), ['function-too-long::b.js::10', 'function-too-long::c.js::20']);
});

test('prune-one + append-one is reported as changed even though the length is unchanged', () => {
  const { flags, changed } = reconcileFlags({
    flags: [flag('old.js', 1)],
    freshFindings: [flag('new.js', 2)],
    scanOk: true,
    projectTag: 'proj',
    repoRoot: '/nope',
  });
  assert.equal(flags.length, 1);
  assert.equal(changed, true);
  assert.deepEqual(flags.map(flagKey), ['function-too-long::new.js::2']);
});

test('flags for OTHER projects are never touched by a scan of one project', () => {
  const other = flag('x.js', 5, { projectSlug: 'other-repo' });
  const { flags, changed } = reconcileFlags({
    flags: [other, flag('a.js', 1)],
    freshFindings: [], // nothing in 'proj' is over threshold anymore
    scanOk: true,
    projectTag: 'proj',
    repoRoot: '/nope',
  });
  assert.equal(changed, true);
  assert.deepEqual(flags.map(flagKey), ['function-too-long::x.js::5']);
  assert.equal(flags[0].projectSlug, 'other-repo');
});

test('no real change -> changed:false (caller can skip rewriting the file)', () => {
  const same = [flag('b.js', 10)];
  const { changed } = reconcileFlags({
    flags: same,
    freshFindings: [flag('b.js', 10)],
    scanOk: true,
    projectTag: 'proj',
    repoRoot: '/nope',
  });
  assert.equal(changed, false);
});

test('a FAILED scan does not wipe the backlog -- only flags whose file is gone are pruned', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flag-store-test-'));
  fs.writeFileSync(path.join(dir, 'present.js'), '// still here\n');
  const { flags, changed } = reconcileFlags({
    flags: [flag('present.js', 10), flag('deleted.js', 20), flag('x.js', 5, { projectSlug: 'other' })],
    freshFindings: [], // scan threw, caller passes []
    scanOk: false,
    projectTag: 'proj',
    repoRoot: dir,
  });
  assert.equal(changed, true);
  assert.deepEqual(
    flags.map(flagKey).sort(),
    ['function-too-long::present.js::10', 'function-too-long::x.js::5'],
    'present.js flag and the other-project flag survive; deleted.js flag is pruned',
  );
});

test('a failed scan on an all-present, single-project backlog changes nothing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flag-store-test-'));
  fs.writeFileSync(path.join(dir, 'present.js'), '// still here\n');
  const { changed } = reconcileFlags({
    flags: [flag('present.js', 10)],
    freshFindings: [],
    scanOk: false,
    projectTag: 'proj',
    repoRoot: dir,
  });
  assert.equal(changed, false);
});

// --- isSuppressed pruning (2026-08-30) -------------------------------------------------
test('reconcileFlags with isSuppressed drops a matching flag for the scanned project (from kept AND fresh)', () => {
  const a = flag('a.js', 10);                    // will be suppressed
  const b = flag('b.js', 20);                    // survives
  const other = flag('c.js', 5, { projectSlug: 'other-proj' }); // different project -- never touched
  const { flags, changed } = reconcileFlags({
    flags: [a, b, other],
    freshFindings: [flag('a.js', 10), flag('b.js', 20), flag('d.js', 99)], // scan still sees a.js:10 and a new d.js:99
    scanOk: true,
    projectTag: 'proj',
    repoRoot: '/nope',
    isSuppressed: (f) => f.file === 'a.js' || f.file === 'd.js',
  });
  const keys = flags.map(flagKey).sort();
  assert.deepEqual(keys, ['function-too-long::b.js::20', 'function-too-long::c.js::5'].sort());
  assert.equal(changed, true);
});

test('reconcileFlags without isSuppressed is unchanged (back-compat)', () => {
  const { flags } = reconcileFlags({
    flags: [flag('a.js', 1)], freshFindings: [flag('a.js', 1)], scanOk: true, projectTag: 'proj', repoRoot: '/nope',
  });
  assert.equal(flags.length, 1);
});

test('reconcileFlags fails open: a throwing isSuppressed does not wipe the backlog', () => {
  const { flags } = reconcileFlags({
    flags: [flag('a.js', 1)], freshFindings: [flag('a.js', 1)], scanOk: true, projectTag: 'proj', repoRoot: '/nope',
    isSuppressed: () => { throw new Error('boom'); },
  });
  assert.equal(flags.length, 1);
});

test('reconcileFlags refreshes confidence + detail onto a surviving flag from the fresh scan', () => {
  // a pre-tier flag with no `confidence` at all
  const old = flag('a.js', 5, { rule: 'silent-catch-block', detail: 'old detail' });
  delete old.confidence;
  const { flags, changed } = reconcileFlags({
    flags: [old],
    freshFindings: [{ ...flag('a.js', 5), rule: 'silent-catch-block', confidence: 'low', detail: 'new detail (low confidence: ...)' }],
    scanOk: true, projectTag: 'proj', repoRoot: '/nope',
  });
  assert.equal(flags[0].confidence, 'low');
  assert.equal(flags[0].detail, 'new detail (low confidence: ...)');
  assert.equal(flags[0].scannedAt, '2026-01-01T00:00:00.000Z', 'FIFO position (scannedAt) is preserved');
  assert.equal(changed, true);
});

test('reconcileFlags does not touch confidence when the scan threw (fresh is not ground truth)', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'flag-store-scanfail-'));
  fs.writeFileSync(path.join(repo, 'a.js'), 'x');
  const old = flag('a.js', 5, { rule: 'silent-catch-block', confidence: 'high' });
  const { flags } = reconcileFlags({
    flags: [old],
    freshFindings: [{ ...flag('a.js', 5), rule: 'silent-catch-block', confidence: 'low' }], // ignored: scanOk false
    scanOk: false, projectTag: 'proj', repoRoot: repo,
  });
  assert.equal(flags.length, 1);
  assert.equal(flags[0].confidence, 'high');
});
