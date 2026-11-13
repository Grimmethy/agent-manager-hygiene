'use strict';

// Unit tests for src/todo-aging-scan.js. Each test exercises a specific aspect of the
// scanner's contract: comment detection, git-blame aging, vendor/minified/test skipping,
// and the TODO_AGE_THRESHOLD_DAYS env override. Tests run against throwaway fixture
// repos in os.tmpdir() so they never touch this repo's own source.
//
// Run: node --test src/todo-aging-scan.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const {
  scan,
  findStaleTodos,
  todoAgeThresholdDays,
  extractReferencedIssue,
  isVendorPath,
  ageInDays,
  getBlameDate,
} = require('./todo-aging-scan.js');

// --- Fixture helpers ------------------------------------------------------------------

function makeTempDir(prefix = 'todo-aging-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function write(repoRoot, relPath, content) {
  const full = path.join(repoRoot, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf8');
  return full;
}

// Initialize a fresh git repo in `dir` with `git config` for the committer identity
// (git blame requires a configured user). Returns the dir path unchanged.
function initGitRepo(dir) {
  execFileSync('git', ['init'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: dir, stdio: 'ignore' });
  return dir;
}

// Commit `relPath` (already written) with a fixed committer date so blame returns a
// deterministic age. Uses `GIT_COMMITTER_DATE` env to pin the timestamp.
function gitCommit(dir, relPath, dateStr, message = 'test commit') {
  execFileSync('git', ['add', relPath], { cwd: dir, stdio: 'ignore' });
  const env = { ...process.env, GIT_COMMITTER_DATE: dateStr };
  execFileSync('git', ['commit', '-m', message, '--allow-empty'], { cwd: dir, env, stdio: 'ignore' });
}

// --- Test: extractReferencedIssue -----------------------------------------------------

test('extractReferencedIssue strips TODO/FIXME/HACK/XXX and surrounding whitespace', () => {
  assert.equal(extractReferencedIssue('TODO: fix this'), 'fix this');
  assert.equal(extractReferencedIssue('FIXME: resolve race'), 'resolve race');
  assert.equal(extractReferencedIssue('HACK: workaround for bug'), 'workaround for bug');
  assert.equal(extractReferencedIssue('XXX: revisit after refactor'), 'revisit after refactor');
  // Case-insensitive.
  assert.equal(extractReferencedIssue('todo: lowercase marker'), 'lowercase marker');
  // No colon separator.
  assert.equal(extractReferencedIssue('TODO fix this'), 'fix this');
  // Trailing whitespace trimmed.
  assert.equal(extractReferencedIssue('TODO: fix this   '), 'fix this');
  // No marker -> null.
  assert.equal(extractReferencedIssue('just a regular comment'), null);
  // Empty input -> null.
  assert.equal(extractReferencedIssue(''), null);
  assert.equal(extractReferencedIssue(null), null);
});

// --- Test: isVendorPath ---------------------------------------------------------------

test('isVendorPath returns true for vendor/static/third_party/external/generated paths', () => {
  assert.equal(isVendorPath('vendor/lib/foo.js'), true);
  assert.equal(isVendorPath('src/vendor/lib/foo.js'), true);
  assert.equal(isVendorPath('node_modules/pkg/static/bundle.js'), true);
  assert.equal(isVendorPath('third_party/external/generated/out.js'), true);
  assert.equal(isVendorPath('src/generated/code.js'), true);
  assert.equal(isVendorPath('external/deps/lib.go'), true);
});

test('isVendorPath returns false for normal source paths', () => {
  assert.equal(isVendorPath('src/foo.js'), false);
  assert.equal(isVendorPath('lib/bar.py'), false);
  assert.equal(isVendorPath('README.md'), false);
  assert.equal(isVendorPath(''), false);
});

// --- Test: ageInDays ------------------------------------------------------------------

test('ageInDays computes floor of (now - commitDate) in days, non-negative', () => {
  const now = new Date('2026-07-01T00:00:00Z');
  // Exactly 30 days ago.
  const thirtyDaysAgo = new Date(now - 30 * 24 * 60 * 60 * 1000);
  assert.equal(ageInDays(thirtyDaysAgo, now), 30);
  // More than 60 days ago.
  const sixtyOneDaysAgo = new Date(now - 61 * 24 * 60 * 60 * 1000);
  assert.equal(ageInDays(sixtyOneDaysAgo, now), 61);
  // Future date -> 0 (non-negative floor).
  const futureDate = new Date(now.getTime() + 1000);
  assert.equal(ageInDays(futureDate, now), 0);
  // Same moment -> 0.
  assert.equal(ageInDays(now, now), 0);
});

// --- Test: todoAgeThresholdDays (env override) -----------------------------------------

test('todoAgeThresholdDays returns DEFAULT (60) when env is unset', () => {
  const prev = process.env.TODO_AGE_THRESHOLD_DAYS;
  delete process.env.TODO_AGE_THRESHOLD_DAYS;
  // Re-clear require cache so the module re-reads env.
  delete require.cache[require.resolve('./todo-aging-scan.js')];
  const mod = require('./todo-aging-scan.js');
  try {
    assert.equal(mod.todoAgeThresholdDays(), 60);
  } finally {
    if (prev !== undefined) process.env.TODO_AGE_THRESHOLD_DAYS = prev;
    delete require.cache[require.resolve('./todo-aging-scan.js')];
  }
});

test('todoAgeThresholdDays respects TODO_AGE_THRESHOLD_DAYS env (positive integer)', () => {
  const prev = process.env.TODO_AGE_THRESHOLD_DAYS;
  process.env.TODO_AGE_THRESHOLD_DAYS = '7';
  delete require.cache[require.resolve('./todo-aging-scan.js')];
  const mod = require('./todo-aging-scan.js');
  try {
    assert.equal(mod.todoAgeThresholdDays(), 7);
  } finally {
    if (prev !== undefined) process.env.TODO_AGE_THRESHOLD_DAYS = prev;
    else delete process.env.TODO_AGE_THRESHOLD_DAYS;
    delete require.cache[require.resolve('./todo-aging-scan.js')];
  }
});

test('todoAgeThresholdDays falls back to 60 for non-numeric env values', () => {
  const prev = process.env.TODO_AGE_THRESHOLD_DAYS;
  process.env.TODO_AGE_THRESHOLD_DAYS = 'not-a-number';
  delete require.cache[require.resolve('./todo-aging-scan.js')];
  const mod = require('./todo-aging-scan.js');
  try {
    assert.equal(mod.todoAgeThresholdDays(), 60);
  } finally {
    if (prev !== undefined) process.env.TODO_AGE_THRESHOLD_DAYS = prev;
    else delete process.env.TODO_AGE_THRESHOLD_DAYS;
    delete require.cache[require.resolve('./todo-aging-scan.js')];
  }
});

test('todoAgeThresholdDays falls back to 60 for zero/negative env values', () => {
  const prev = process.env.TODO_AGE_THRESHOLD_DAYS;
  process.env.TODO_AGE_THRESHOLD_DAYS = '0';
  delete require.cache[require.resolve('./todo-aging-scan.js')];
  const mod = require('./todo-aging-scan.js');
  try {
    assert.equal(mod.todoAgeThresholdDays(), 60);
  } finally {
    if (prev !== undefined) process.env.TODO_AGE_THRESHOLD_DAYS = prev;
    else delete process.env.TODO_AGE_THRESHOLD_DAYS;
    delete require.cache[require.resolve('./todo-aging-scan.js')];
  }
});

// --- Test: getBlameDate (real git blame) ----------------------------------------------

test('getBlameDate returns a Date for a file tracked in git', () => {
  const dir = makeTempDir('todo-aging-blame-');
  initGitRepo(dir);
  const file = write(dir, 'hello.js', '// hello\n');
  gitCommit(dir, 'hello.js', '2025-01-01T00:00:00Z');
  const date = getBlameDate(dir, file, 1);
  assert.ok(date instanceof Date, 'should return a Date');
  assert.ok(!Number.isNaN(date.getTime()), 'date should be valid');
});

test('getBlameDate returns null for a file not tracked in git', () => {
  const dir = makeTempDir('todo-aging-blame-untracked-');
  initGitRepo(dir);
  // Write a file but do NOT commit it.
  const file = write(dir, 'untracked.js', '// never committed\n');
  const date = getBlameDate(dir, file, 1);
  assert.equal(date, null);
});

test('getBlameDate returns null for a file outside the repo root', () => {
  const dir = makeTempDir('todo-aging-blame-outside-');
  initGitRepo(dir);
  const outside = '/tmp/outside-file-that-is-not-in-this-repo.js';
  fs.writeFileSync(outside, '// nope\n');
  const date = getBlameDate(dir, outside, 1);
  assert.equal(date, null);
  fs.rmSync(outside, { force: true });
});

// --- Test: scan finds TODO/FIXME/HACK/XXX in comments ---------------------------------

test('scan returns findings with rule=todo-aging for tracked TODO comments', () => {
  const dir = makeTempDir('todo-aging-find-');
  initGitRepo(dir);
  const content = [
    '// TODO: fix the login bug',
    'function f() { return 1; }',
    '// FIXME: this crashes on edge case',
    'const x = 1;',
    '/* HACK: temporary workaround */',
    '// XXX: revisit after refactor',
    '// not a todo, should be ignored',
  ].join('\n');
  const file = write(dir, 'app.js', content);
  // Use a date 90 days in the past so the comment is stale under the default 60d threshold.
  const pastDate = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
  gitCommit(dir, 'app.js', pastDate);
  const findings = scan([{ repoRoot: dir, projectSlug: 'test' }]);
  assert.ok(findings.length >= 4, `expected at least 4 findings, got ${findings.length}`);
  for (const f of findings) {
    assert.equal(f.rule, 'todo-aging');
    assert.equal(f.projectSlug, 'test');
    assert.ok(f.scannedAt);
    assert.ok(f.ageDays >= 90);
    assert.equal(f.isStale, true);
  }
});

test('scan does NOT flag TODO/FIXME/HACK/XXX inside strings (only comments)', () => {
  const dir = makeTempDir('todo-aging-strings-');
  initGitRepo(dir);
  const content = [
    'const s = "TODO: not a real comment";',
    'const t = \'FIXME: also not a comment\';',
    '// TODO: this IS a real comment',
  ].join('\n');
  const file = write(dir, 'app.js', content);
  const pastDate = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
  gitCommit(dir, 'app.js', pastDate);
  const findings = scan([{ repoRoot: dir, projectSlug: 'test' }]);
  // Only the real comment should be flagged.
  assert.equal(findings.length, 1);
  assert.ok(findings[0].comment.includes('IS a real comment'));
});

// --- Test: scan skips test files ------------------------------------------------------

test('scan skips files whose path matches isTestFile patterns', () => {
  const dir = makeTempDir('todo-aging-skip-test-');
  initGitRepo(dir);
  const content = '// TODO: this is in a test file, should be skipped\n';
  // Various test-file path shapes.
  const testPaths = [
    'src/foo.test.js',
    'src/foo.spec.ts',
    'tests/unit/foo.py',
    '__tests__/helpers.js',
    'fixtures/seed.js',
    'test_foo.py',
  ];
  for (const rel of testPaths) {
    write(dir, rel, content);
  }
  const pastDate = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
  for (const rel of testPaths) {
    execFileSync('git', ['add', rel], { cwd: dir, stdio: 'ignore' });
  }
  execFileSync('git', ['commit', '-m', 'add test files', '--allow-empty'], {
    cwd: dir,
    env: { ...process.env, GIT_COMMITTER_DATE: pastDate },
    stdio: 'ignore',
  });
  const findings = scan([{ repoRoot: dir, projectSlug: 'test' }]);
  assert.equal(findings.length, 0, 'no findings in test/fixture paths');
});

// --- Test: scan skips vendor paths ----------------------------------------------------

test('scan skips files under vendor/static/third_party/external/generated paths', () => {
  const dir = makeTempDir('todo-aging-vendor-');
  initGitRepo(dir);
  const content = '// TODO: inside a vendor file, should be skipped\n';
  const vendorPaths = [
    'vendor/lib/foo.js',
    'node_modules/pkg/static/bundle.js',
    'third_party/external/gen/code.go',
    'src/generated/out.rs',
    'external/deps/lib.rb',
  ];
  for (const rel of vendorPaths) {
    write(dir, rel, content);
  }
  const pastDate = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
  for (const rel of vendorPaths) {
    execFileSync('git', ['add', rel], { cwd: dir, stdio: 'ignore' });
  }
  execFileSync('git', ['commit', '-m', 'add vendor files', '--allow-empty'], {
    cwd: dir,
    env: { ...process.env, GIT_COMMITTER_DATE: pastDate },
    stdio: 'ignore',
  });
  const findings = scan([{ repoRoot: dir, projectSlug: 'test' }]);
  assert.equal(findings.length, 0, 'no findings in vendor paths');
});

// --- Test: scan skips minified files --------------------------------------------------

test('scan skips files with a single line longer than 2000 chars (minified heuristic)', () => {
  const dir = makeTempDir('todo-aging-minified-');
  initGitRepo(dir);
  // Build a "minified" file: one enormous line (well over 2000 chars) containing a TODO.
  const padding = 'x'.repeat(2500);
  const content = `const a = ${JSON.stringify(padding)}; // TODO: in a minified-looking file\n`;
  const file = write(dir, 'bundle.js', content);
  const pastDate = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
  execFileSync('git', ['add', 'bundle.js'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'add minified', '--allow-empty'], {
    cwd: dir,
    env: { ...process.env, GIT_COMMITTER_DATE: pastDate },
    stdio: 'ignore',
  });
  const findings = scan([{ repoRoot: dir, projectSlug: 'test' }]);
  assert.equal(findings.length, 0, 'minified file should be skipped');
});

test('scan does NOT skip a normal file with multiple short lines', () => {
  const dir = makeTempDir('todo-aging-normal-file-');
  initGitRepo(dir);
  // A normal file with several short lines, each under the 2000-char minified threshold.
  const content = [
    '// TODO: first real comment',
    'function a() { return 1; }',
    '// FIXME: second real comment',
    'const b = 2;',
    '// HACK: third real comment',
    'export { a, b };',
  ].join('\n');
  write(dir, 'normal.js', content);
  const pastDate = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
  execFileSync('git', ['add', 'normal.js'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'add normal file', '--allow-empty'], {
    cwd: dir,
    env: { ...process.env, GIT_COMMITTER_DATE: pastDate },
    stdio: 'ignore',
  });
  const findings = scan([{ repoRoot: dir, projectSlug: 'test' }]);
  assert.ok(findings.length >= 3, `normal file should produce at least 3 findings, got ${findings.length}`);
  assert.ok(findings.some((f) => f.comment.includes('first real comment')));
  assert.ok(findings.some((f) => f.comment.includes('second real comment')));
  assert.ok(findings.some((f) => f.comment.includes('third real comment')));
  // All should be stale (90 days > 60 day default threshold).
  assert.ok(findings.every((f) => f.isStale === true));
});

// --- Test: thresholdDays option overrides env ------------------------------------------

test('scan options.thresholdDays overrides the env and default', () => {
  const dir = makeTempDir('todo-aging-threshold-opt-');
  initGitRepo(dir);
  const content = '// TODO: just 5 days old\n';
  write(dir, 'app.js', content);
  // Commit 10 days ago -- stale under default 60d, but NOT stale under 5d threshold.
  const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
  execFileSync('git', ['add', 'app.js'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'add', '--allow-empty'], {
    cwd: dir,
    env: { ...process.env, GIT_COMMITTER_DATE: tenDaysAgo },
    stdio: 'ignore',
  });
  // With thresholdDays=5, the 10-day-old comment is stale.
  const stale = scan([{ repoRoot: dir, projectSlug: 'test' }], { thresholdDays: 5 });
  assert.ok(stale.length >= 1, 'should be stale under 5d threshold');
  assert.ok(stale.every((f) => f.isStale === true));
  // With thresholdDays=30, the 10-day-old comment is NOT stale.
  const notStale = scan([{ repoRoot: dir, projectSlug: 'test' }], { thresholdDays: 30 });
  assert.ok(notStale.length >= 1, 'should still find the comment');
  assert.ok(notStale.every((f) => f.isStale === false), 'should not be stale under 30d threshold');
});

// --- Test: scan result shape ----------------------------------------------------------

test('scan result includes rule, file, line, comment, ageDays, referencedIssue, isStale', () => {
  const dir = makeTempDir('todo-aging-shape-');
  initGitRepo(dir);
  const content = '// TODO: fix the login bug\n';
  write(dir, 'app.js', content);
  const pastDate = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
  execFileSync('git', ['add', 'app.js'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'add', '--allow-empty'], {
    cwd: dir,
    env: { ...process.env, GIT_COMMITTER_DATE: pastDate },
    stdio: 'ignore',
  });
  const findings = scan([{ repoRoot: dir, projectSlug: 'test' }]);
  assert.equal(findings.length, 1);
  const f = findings[0];
  assert.equal(f.rule, 'todo-aging');
  assert.equal(f.file, 'app.js');
  assert.equal(f.line, 1);
  assert.equal(f.comment, '// TODO: fix the login bug');
  assert.equal(f.referencedIssue, 'fix the login bug');
  assert.equal(f.isStale, true);
  assert.ok(f.ageDays >= 90);
  assert.equal(f.projectSlug, 'test');
  assert.ok(f.scannedAt);
});

// --- Test: scan handles missing repoRoot gracefully -----------------------------------

test('scan returns [] for a repoRoot that does not exist', () => {
  const findings = scan([{ repoRoot: '/definitely/not/a/real/path', projectSlug: 'test' }]);
  assert.deepEqual(findings, []);
});

// --- Test: scan handles files with no git repo ----------------------------------------

test('scan skips files where git blame fails (no git repo) without throwing', () => {
  const dir = makeTempDir('todo-aging-no-git-');
  // Write a file but do NOT init a git repo.
  write(dir, 'app.js', '// TODO: no git here\n');
  // findStaleTodos calls getBlameDate which will fail; the scanner should skip, not throw.
  const findings = findStaleTodos(dir);
  assert.deepEqual(findings, []);
});
