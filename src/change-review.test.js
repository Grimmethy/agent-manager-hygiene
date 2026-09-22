'use strict';

// Tests for change_review / change_review_fix. A real temp git repo (init + bare origin +
// commits) exercises the commit-walk, the cursor, the skip rules and dedup; hand-built
// implement-response strings exercise applyChangeReview and the prompt builders.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

function freshPlugin(repoRoot) {
  process.env.AGENT_MANAGER_REPO_ROOT = repoRoot;
  process.env.AGENT_MANAGER_PIPELINE_DIR = repoRoot;
  process.env.AGENT_MANAGER_MAIN_BRANCH = 'main';
  delete process.env.AGENT_MANAGER_CHANGE_REVIEW_BACKFILL;
  delete process.env.AGENT_MANAGER_CHANGE_REVIEW_FETCH;
  const registry = require('agent-manager/src/task-source-registry.js');
  registry.clearRegistry();
  require('agent-manager/src/model-profile-registry.js').clearModelProfileRegistry();
  delete require.cache[require.resolve('agent-manager/src/task-sources.js')];
  delete require.cache[require.resolve('./change-review.js')];
  const { getConfig } = require('agent-manager/src/config.js');
  const { nextCandidateFulfillmentTask, taskIdExistsInQueue, taskPriority } = require('agent-manager/src/task-sources.js');
  const deps = { getConfig, nextCandidateFulfillmentTask, taskIdExistsInQueue, taskPriority };
  const mod = require('./change-review.js');
  mod.register(deps);
  return { ...deps, mod, getRegisteredSource: registry.getRegisteredSource };
}

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

// A working repo on `main` whose `origin` is a bare sibling. Returns { dir, commit }.
function makeGitRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'change-review-test-'));
  const bare = path.join(root, 'origin.git');
  const dir = path.join(root, 'work');
  fs.mkdirSync(dir);
  git(root, ['init', '-q', '--bare', '-b', 'main', bare]);
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 't@t.t']);
  git(dir, ['config', 'user.name', 'T']);
  git(dir, ['remote', 'add', 'origin', bare]);
  const commit = (files, msg) => {
    for (const [rel, content] of Object.entries(files)) {
      const full = path.join(dir, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content);
    }
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-q', '-m', msg]);
    git(dir, ['push', '-q', 'origin', 'main']);
    return git(dir, ['rev-parse', 'HEAD']);
  };
  const mergeBranch = (branchCommits, msg) => {
    git(dir, ['checkout', '-q', '-b', 'feature']);
    for (const [i, files] of branchCommits.entries()) {
      for (const [rel, content] of Object.entries(files)) {
        fs.writeFileSync(path.join(dir, rel), content);
      }
      git(dir, ['add', '-A']);
      git(dir, ['commit', '-q', '-m', `feature ${i}`]);
    }
    git(dir, ['checkout', '-q', 'main']);
    git(dir, ['merge', '-q', '--no-ff', '-m', msg, 'feature']);
    git(dir, ['branch', '-q', '-D', 'feature']);
    git(dir, ['push', '-q', 'origin', 'main']);
    return git(dir, ['rev-parse', 'HEAD']);
  };
  return { dir, root, commit, mergeBranch };
}

function writeCursor(dir, sha) {
  fs.writeFileSync(path.join(dir, 'change-review-cursor.json'), JSON.stringify({ lastReviewedSha: sha }));
}
function readCursor(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, 'change-review-cursor.json'), 'utf8')).lastReviewedSha;
}
function seedQueue(dir, state, id) {
  const d = path.join(dir, 'queue', state);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, `${id}.json`), JSON.stringify({ id }));
}

// --- generator -------------------------------------------------------------------

test('not a git repo -> null, no throw', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'change-review-nogit-'));
  const { mod, getConfig, taskIdExistsInQueue } = freshPlugin(dir);
  assert.equal(mod.nextChangeReviewTask({ getConfig, taskIdExistsInQueue }), null);
});

test('first run, BACKFILL=0, no new commits -> null; cursor seeded at HEAD', () => {
  const repo = makeGitRepo();
  repo.commit({ 'a.js': 'x\n' }, 'c1');
  process.env.AGENT_MANAGER_CHANGE_REVIEW_BACKFILL = '0';
  const { mod, getConfig, taskIdExistsInQueue } = freshPlugin(repo.dir);
  process.env.AGENT_MANAGER_CHANGE_REVIEW_BACKFILL = '0';
  assert.equal(mod.nextChangeReviewTask({ getConfig, taskIdExistsInQueue }), null);
  assert.equal(readCursor(repo.dir), git(repo.dir, ['rev-parse', 'origin/main']));
});

test('BACKFILL past N commits -> task covers the OLDEST unreviewed commits first, batched (both are small); cursor NOT advanced', () => {
  const repo = makeGitRepo();
  repo.commit({ 'a.js': 'v0\n' }, 'c1');
  const c2 = repo.commit({ 'a.js': 'v1\nSECOND\n' }, 'c2');
  const c3 = repo.commit({ 'a.js': 'v1\nSECOND\nTHIRD\n' }, 'c3');
  writeCursor(repo.dir, git(repo.dir, ['rev-parse', `${c2}^`])); // review c2 and c3
  const { mod, getConfig, taskIdExistsInQueue } = freshPlugin(repo.dir);
  const task = mod.nextChangeReviewTask({ getConfig, taskIdExistsInQueue });
  assert.ok(task);
  // c2 and c3 are both tiny, consecutive commits -- they batch into one task rather than
  // each paying for their own dedicated review pass (2026-09-23 batching).
  assert.equal(task.id, `change-review-batch-${c2.slice(0, 7)}-${c3.slice(0, 7)}`);
  assert.equal(task.source, 'change_review');
  assert.equal(task.promptContext.units.length, 2);
  assert.match(task.promptContext.units[0].unitDiff, /SECOND/);
  assert.match(task.promptContext.units[1].unitDiff, /THIRD/);
  assert.equal(readCursor(repo.dir), git(repo.dir, ['rev-parse', `${c2}^`]), 'cursor holds before the batch -- neither member is queued yet');
});

test('id already in queue -> cursor advances, returns the next commit', () => {
  const repo = makeGitRepo();
  repo.commit({ 'a.js': 'v0\n' }, 'c1');
  const c2 = repo.commit({ 'a.js': 'v0\nB\n' }, 'c2');
  const c3 = repo.commit({ 'a.js': 'v0\nB\nC\n' }, 'c3');
  writeCursor(repo.dir, git(repo.dir, ['rev-parse', `${c2}^`]));
  seedQueue(repo.dir, 'approved', `change-review-${c2.slice(0, 7)}`);
  const { mod, getConfig, taskIdExistsInQueue } = freshPlugin(repo.dir);
  const task = mod.nextChangeReviewTask({ getConfig, taskIdExistsInQueue });
  assert.equal(task.id, `change-review-${c3.slice(0, 7)}`);
  assert.equal(readCursor(repo.dir), c2, 'cursor advanced past the already-queued c2');
});

test('id in done/ -> skipped, cursor advanced', () => {
  const repo = makeGitRepo();
  repo.commit({ 'a.js': 'v0\n' }, 'c1');
  const c2 = repo.commit({ 'a.js': 'v0\nB\n' }, 'c2');
  writeCursor(repo.dir, git(repo.dir, ['rev-parse', `${c2}^`]));
  seedQueue(repo.dir, 'done', `change-review-${c2.slice(0, 7)}`);
  const { mod, getConfig, taskIdExistsInQueue } = freshPlugin(repo.dir);
  assert.equal(mod.nextChangeReviewTask({ getConfig, taskIdExistsInQueue }), null);
  assert.equal(readCursor(repo.dir), c2);
});

test('doc-only commit -> skipped + recorded; cursor advanced', () => {
  const repo = makeGitRepo();
  repo.commit({ 'a.js': 'v0\n' }, 'c1');
  const c2 = repo.commit({ 'README.md': '# hi\nmore\n' }, 'docs');
  writeCursor(repo.dir, git(repo.dir, ['rev-parse', `${c2}^`]));
  const { mod, getConfig, taskIdExistsInQueue } = freshPlugin(repo.dir);
  assert.equal(mod.nextChangeReviewTask({ getConfig, taskIdExistsInQueue }), null);
  assert.equal(readCursor(repo.dir), c2);
  const skipped = JSON.parse(fs.readFileSync(path.join(repo.dir, 'change-review-skipped.json'), 'utf8'));
  assert.equal(skipped[0].reason, 'doc-only');
  assert.equal(skipped[0].sha, c2);
});

test('generated-only commit (package-lock.json) -> skipped', () => {
  const repo = makeGitRepo();
  repo.commit({ 'a.js': 'v0\n' }, 'c1');
  const c2 = repo.commit({ 'package-lock.json': '{"a":1}\n' }, 'deps');
  writeCursor(repo.dir, git(repo.dir, ['rev-parse', `${c2}^`]));
  const { mod, getConfig, taskIdExistsInQueue } = freshPlugin(repo.dir);
  assert.equal(mod.nextChangeReviewTask({ getConfig, taskIdExistsInQueue }), null);
  const skipped = JSON.parse(fs.readFileSync(path.join(repo.dir, 'change-review-skipped.json'), 'utf8'));
  assert.equal(skipped[0].reason, 'generated');
});

test('test-only commit -> NOT skipped, task returned', () => {
  const repo = makeGitRepo();
  repo.commit({ 'a.js': 'v0\n' }, 'c1');
  const c2 = repo.commit({ 'a.test.js': 'assert(1)\nassert(2)\n' }, 'tests');
  writeCursor(repo.dir, git(repo.dir, ['rev-parse', `${c2}^`]));
  const { mod, getConfig, taskIdExistsInQueue } = freshPlugin(repo.dir);
  const task = mod.nextChangeReviewTask({ getConfig, taskIdExistsInQueue });
  assert.equal(task.id, `change-review-${c2.slice(0, 7)}`);
});

test('oversized commit -> skipped, reason too-large, recorded', () => {
  const repo = makeGitRepo();
  repo.commit({ 'a.js': 'v0\n' }, 'c1');
  const big = Array.from({ length: 2000 }, (_, i) => `line ${i}`).join('\n');
  const c2 = repo.commit({ 'a.js': big }, 'huge');
  writeCursor(repo.dir, git(repo.dir, ['rev-parse', `${c2}^`]));
  const { mod, getConfig, taskIdExistsInQueue } = freshPlugin(repo.dir);
  assert.equal(mod.nextChangeReviewTask({ getConfig, taskIdExistsInQueue }), null);
  const skipped = JSON.parse(fs.readFileSync(path.join(repo.dir, 'change-review-skipped.json'), 'utf8'));
  assert.equal(skipped[0].reason, 'too-large');
});

test('merge commit -> unit = merge SHA, unitDiff is the first-parent net delta', () => {
  const repo = makeGitRepo();
  const c1 = repo.commit({ 'a.js': 'base\n' }, 'c1');
  const m = repo.mergeBranch([{ 'a.js': 'base\nONE\n' }, { 'a.js': 'base\nONE\nTWO\n' }], 'merge feature');
  writeCursor(repo.dir, c1);
  const { mod, getConfig, taskIdExistsInQueue } = freshPlugin(repo.dir);
  const task = mod.nextChangeReviewTask({ getConfig, taskIdExistsInQueue });
  assert.equal(task.id, `change-review-${m.slice(0, 7)}`);
  assert.match(task.promptContext.unitDiff, /ONE/);
  assert.match(task.promptContext.unitDiff, /TWO/);
});

test('cursor safety: a returned-but-unqueued BATCH does not lose commits, and is skipped whole once queued', () => {
  const repo = makeGitRepo();
  repo.commit({ 'a.js': 'v0\n' }, 'c1');
  const c2 = repo.commit({ 'a.js': 'v0\nB\n' }, 'c2');
  const c3 = repo.commit({ 'a.js': 'v0\nB\nC\n' }, 'c3');
  const c4 = repo.commit({ 'a.js': 'v0\nB\nC\nD\n' }, 'c4');
  writeCursor(repo.dir, git(repo.dir, ['rev-parse', `${c2}^`]));
  const p1 = freshPlugin(repo.dir);
  const t1 = p1.mod.nextChangeReviewTask({ getConfig: p1.getConfig, taskIdExistsInQueue: p1.taskIdExistsInQueue });
  // c2, c3, c4 are all tiny and consecutive -- one batch covers all three.
  const batchId = `change-review-batch-${c2.slice(0, 7)}-${c4.slice(0, 7)}`;
  assert.equal(t1.id, batchId);
  assert.equal(t1.promptContext.units.length, 3);
  assert.equal(readCursor(repo.dir), git(repo.dir, ['rev-parse', `${c2}^`]), 'nothing in the batch is queued yet -- cursor holds before it');
  // The batch task now lands in the queue; the next tick must recognize the WHOLE batch
  // as already covered (not re-split it back into c2/c3/c4) and find nothing left.
  seedQueue(repo.dir, 'approved', batchId);
  const p2 = freshPlugin(repo.dir);
  const t2 = p2.mod.nextChangeReviewTask({ getConfig: p2.getConfig, taskIdExistsInQueue: p2.taskIdExistsInQueue });
  assert.equal(t2, null);
  assert.equal(readCursor(repo.dir), c4, 'cursor advances past every member of the now-queued batch');
});

test('cursor safety: an individually-already-queued commit (pre-batching legacy task) breaks the batch there, not lost', () => {
  const repo = makeGitRepo();
  repo.commit({ 'a.js': 'v0\n' }, 'c1');
  const c2 = repo.commit({ 'a.js': 'v0\nB\n' }, 'c2');
  const c3 = repo.commit({ 'a.js': 'v0\nB\nC\n' }, 'c3');
  const c4 = repo.commit({ 'a.js': 'v0\nB\nC\nD\n' }, 'c4');
  writeCursor(repo.dir, git(repo.dir, ['rev-parse', `${c2}^`]));
  // c3 already has its OWN legacy single-commit task queued (e.g. from before this batch
  // was ever generated, or from before this feature existed) -- it must not be silently
  // swept into a new batch alongside c2/c4.
  seedQueue(repo.dir, 'approved', `change-review-${c3.slice(0, 7)}`);
  const { mod, getConfig, taskIdExistsInQueue } = freshPlugin(repo.dir);
  const task = mod.nextChangeReviewTask({ getConfig, taskIdExistsInQueue });
  // c2 alone forms the first batch (c3 ends it); c3 itself gets skipped/advanced past.
  assert.equal(task.id, `change-review-${c2.slice(0, 7)}`);
  assert.equal(task.promptContext.unitDiff !== undefined, true, 'a batch of exactly one member keeps the legacy flat shape');
});

// --- batching mechanics (2026-09-23) ---------------------------------------------
// See change-review.js's own header comment on CHANGE_REVIEW_BATCH_MAX_UNITS for why:
// generation was outpacing consumption because every commit, however tiny, paid the
// full per-task overhead. These prove the size/count caps and the large-commit-stays-
// solo behavior a pure "does it batch at all" test wouldn't catch.

test('batching: a run longer than CHANGE_REVIEW_BATCH_MAX_UNITS splits into multiple batch tasks', () => {
  const repo = makeGitRepo();
  repo.commit({ 'a.js': 'v0\n' }, 'c1');
  const shas = [];
  for (let i = 0; i < 7; i += 1) {
    shas.push(repo.commit({ 'a.js': `v0\n${'x'.repeat(i + 1)}\n` }, `c${i + 2}`));
  }
  writeCursor(repo.dir, git(repo.dir, ['rev-parse', `${shas[0]}^`]));
  process.env.AGENT_MANAGER_CHANGE_REVIEW_BATCH_SIZE = '3';
  const { mod, getConfig, taskIdExistsInQueue } = freshPlugin(repo.dir);
  delete process.env.AGENT_MANAGER_CHANGE_REVIEW_BATCH_SIZE;
  const t1 = mod.nextChangeReviewTask({ getConfig, taskIdExistsInQueue });
  assert.equal(t1.promptContext.units.length, 3, 'first batch stops at the configured cap, not the whole run of 7');
  assert.equal(t1.id, `change-review-batch-${shas[0].slice(0, 7)}-${shas[2].slice(0, 7)}`);
});

test('batching: a unit whose own diff exceeds the per-unit batch cap reviews alone, even mid-run', () => {
  const repo = makeGitRepo();
  repo.commit({ 'a.js': 'v0\n' }, 'c1');
  const c2 = repo.commit({ 'a.js': 'v0\nsmall\n' }, 'c2');
  const bigContent = Array.from({ length: 400 }, (_, i) => `line ${i} of a real change`).join('\n');
  const c3 = repo.commit({ 'a.js': bigContent }, 'c3-big');
  const c4 = repo.commit({ 'a.js': `${bigContent}\nsmall too\n` }, 'c4');
  writeCursor(repo.dir, git(repo.dir, ['rev-parse', `${c2}^`]));
  const { mod, getConfig, taskIdExistsInQueue } = freshPlugin(repo.dir);
  const t1 = mod.nextChangeReviewTask({ getConfig, taskIdExistsInQueue });
  // c2 alone: c3's oversized diff ends the batch before c3 joins it.
  assert.equal(t1.id, `change-review-${c2.slice(0, 7)}`);
  assert.equal(t1.promptContext.unitDiff !== undefined, true);
  assert.ok(c4);
});

test('batching: combined size cap ends a batch even when each member individually fits', () => {
  const repo = makeGitRepo();
  repo.commit({ 'a.js': 'v0\n' }, 'c1');
  // Each commit's diff is a few hundred chars (under the per-unit cap) but five of them
  // together exceed the combined cap -- the batch must close before absorbing all of them.
  const chunk = Array.from({ length: 80 }, (_, i) => `line ${i}`).join('\n');
  const shas = [];
  for (let i = 0; i < 6; i += 1) {
    shas.push(repo.commit({ [`f${i}.js`]: `${chunk}\nmarker ${i}\n` }, `c${i + 2}`));
  }
  writeCursor(repo.dir, git(repo.dir, ['rev-parse', `${shas[0]}^`]));
  const { mod, getConfig, taskIdExistsInQueue } = freshPlugin(repo.dir);
  const t1 = mod.nextChangeReviewTask({ getConfig, taskIdExistsInQueue });
  assert.ok(t1.promptContext.units.length < 6, 'the combined-size cap must close the batch before every commit joins it');
  assert.ok(t1.promptContext.units.length >= 1);
});

test('unitsOf: normalizes the legacy flat shape and the new multi-unit shape identically', () => {
  const { mod } = freshPlugin(fs.mkdtempSync(path.join(os.tmpdir(), 'cr-unitsof-')));
  const legacy = mod.unitsOf({ sha: 'abc1234', subject: 's', unitDiff: 'd' });
  assert.equal(legacy.length, 1);
  assert.equal(legacy[0].sha, 'abc1234');
  const batch = mod.unitsOf({ units: [{ sha: 'aaa1111' }, { sha: 'bbb2222' }] });
  assert.equal(batch.length, 2);
  assert.equal(mod.unitsOf({}).length, 0);
});

test('unitForFinding: a solo task always resolves to its one unit, Commit: field or not', () => {
  const { mod } = freshPlugin(fs.mkdtempSync(path.join(os.tmpdir(), 'cr-uff-solo-')));
  const units = mod.unitsOf({ sha: 'abc1234', subject: 's', unitDiff: 'd' });
  assert.equal(mod.unitForFinding(units, {}).sha, 'abc1234');
  assert.equal(mod.unitForFinding(units, { commit: 'zzzzzzz' }).sha, 'abc1234');
});

test('unitForFinding: a batch resolves by exact or prefix sha match, and falls back to the first unit when unmatched/missing', () => {
  const { mod } = freshPlugin(fs.mkdtempSync(path.join(os.tmpdir(), 'cr-uff-batch-')));
  const units = mod.unitsOf({ units: [{ sha: 'aaa1111' }, { sha: 'bbb2222' }] });
  assert.equal(mod.unitForFinding(units, { commit: 'bbb2222' }).sha, 'bbb2222');
  assert.equal(mod.unitForFinding(units, { commit: 'bbb' }).sha, 'bbb2222', 'a short prefix still matches');
  assert.equal(mod.unitForFinding(units, { commit: '' }).sha, 'aaa1111', 'missing Commit: falls back to the first unit');
  assert.equal(mod.unitForFinding(units, { commit: 'nope0000' }).sha, 'aaa1111', 'unmatched Commit: falls back to the first unit');
});

test('applyChangeReview: a batch task files each finding under the RIGHT commit, via Commit:', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-apply-batch-'));
  const { mod } = freshPlugin(dir);
  const batchCtx = {
    mainBranch: 'main',
    units: [
      { sha: 'aaa1111', subject: 'first small fix', unitDiff: 'diff --git a/src/a.js b/src/a.js\n@@ -1 +1 @@\n-old a\n+new a\n' },
      { sha: 'bbb2222', subject: 'second small fix', unitDiff: 'diff --git a/src/b.js b/src/b.js\n@@ -1 +1 @@\n-old b\n+new b\n' },
    ],
  };
  const resp = [
    'FINDING',
    'Commit: bbb2222',
    'File: src/b.js',
    'Line: 1',
    'Severity: med',
    'Regression: b regressed',
    'Failure scenario: calling g() on src/b.js now returns the wrong value',
    'Fix sketch: revert the b.js change',
  ].join('\n');
  const res = mod.applyChangeReview({ implementResponse: resp, task: { promptContext: batchCtx } });
  assert.equal(res.succeeded, true);
  const doc = fs.readFileSync(path.join(dir, 'Docs', 'CHANGE_REVIEW_CANDIDATES.md'), 'utf8');
  assert.match(doc, /Source: change_review of bbb2222 "second small fix"/, 'the finding is attributed to bbb2222, the commit its own Commit: line named -- not aaa1111');
  assert.match(doc, /Files: src\/b\.js/);
});

// --- classifyUnit ---------------------------------------------------------------

test('classifyUnit: doc / generated / mixed / reviewable', () => {
  const { mod } = freshPlugin(fs.mkdtempSync(path.join(os.tmpdir(), 'cr-c-')));
  assert.equal(mod.classifyUnit([{ status: 'M', path: 'Docs/x.md' }, { status: 'M', path: 'notes.txt' }]), 'doc-only');
  assert.equal(mod.classifyUnit([{ status: 'M', path: 'a/dist/x.min.js' }, { status: 'M', path: 'package-lock.json' }]), 'generated');
  assert.equal(mod.classifyUnit([{ status: 'M', path: 'README.md' }, { status: 'M', path: 'src/a.js' }]), 'reviewable');
  assert.equal(mod.classifyUnit([{ status: 'M', path: 'src/a.js' }]), 'reviewable');
});

// --- applyChangeReview ---------------------------------------------------------

function applyCtx() {
  return { sha: 'abc1234', subject: 'some merge', unitDiff: 'diff --git a/src/a.js b/src/a.js\n@@ -1 +1 @@\n-old\n+new bad line\n' };
}

test('applyChangeReview: NO CORRECTNESS ISSUES -> skipped, no doc', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-apply-'));
  const { mod } = freshPlugin(dir);
  const res = mod.applyChangeReview({ implementResponse: 'NO CORRECTNESS ISSUES', task: { promptContext: applyCtx() } });
  assert.equal(res.skipped, true);
  assert.ok(!fs.existsSync(path.join(dir, 'Docs', 'CHANGE_REVIEW_CANDIDATES.md')));
});

test('applyChangeReview: empty / whitespace -> skipped', () => {
  const { mod } = freshPlugin(fs.mkdtempSync(path.join(os.tmpdir(), 'cr-apply2-')));
  assert.equal(mod.applyChangeReview({ implementResponse: '   \n  ', task: { promptContext: applyCtx() } }).skipped, true);
});

test('applyChangeReview: two FINDING blocks -> CHANGE_REVIEW_CANDIDATES.md with AC-1 + AC-2', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-apply3-'));
  const { mod } = freshPlugin(dir);
  const resp = [
    'FINDING',
    'File: src/a.js',
    'Line: 12',
    'Severity: high',
    'Regression: the loop now skips the last element',
    'Failure scenario: call f([1,2,3]) -> returns [1,2] instead of [1,2,3]',
    'Fix sketch: change < to <= on line 12',
    '',
    'FINDING',
    'File: src/b.js',
    'Line: 40',
    'Severity: med',
    'Regression: error path removed',
    'Failure scenario: f(null) now throws TypeError instead of returning {error:...}',
    'Fix sketch: restore the null guard',
  ].join('\n');
  const res = mod.applyChangeReview({ implementResponse: resp, task: { promptContext: applyCtx() } });
  assert.equal(res.succeeded, true);
  const doc = fs.readFileSync(path.join(dir, 'Docs', 'CHANGE_REVIEW_CANDIDATES.md'), 'utf8');
  assert.match(doc, /### AC-1 /);
  assert.match(doc, /### AC-2 /);
  assert.match(doc, /Strength: Strong/);
  assert.match(doc, /severity: high/);
  assert.match(doc, /Source: change_review of abc1234/);
  assert.match(doc, /the loop now skips the last element/);
});

// --- quote check (2026-09-19): a finding that quotes non-existent code as "existing" is downgraded -----------

function repoWithFile(rel, content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-quote-'));
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 't@t']); git(dir, ['config', 'user.name', 't']);
  fs.mkdirSync(path.join(dir, path.dirname(rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), content);
  git(dir, ['add', '.']); git(dir, ['commit', '-qm', 'the reviewed change']);
  return { dir, sha: git(dir, ['rev-parse', '--short', 'HEAD']) };
}
const FILE_BODY = "const onPage = (p) => {\n  loadBox(mode.box, mode.scope, p);\n};\nconst onScope = (next) => {\n  loadBox(mode.box, next, 1);\n};\n";
const findingResp = (fix) => ['FINDING', 'File: src/View.tsx', 'Line: 5', 'Severity: high', 'Regression: scope change re-queries with the old scope',
  'Failure scenario: onScope("SF") calls loadBox(box, "MF", 1) instead of "SF"', `Fix sketch: ${fix}`].join('\n');

test('applyChangeReview: a finding quoting code that is NOT in the file at the reviewed commit is filed as Unverified, not Strong', () => {
  const { dir, sha } = repoWithFile('src/View.tsx', FILE_BODY);
  const { mod } = freshPlugin(dir);
  const res = mod.applyChangeReview({
    implementResponse: findingResp('replace `loadBox(mode.box, mode.scope, 1)` with `loadBox(mode.box, next, 1)`'),
    task: { promptContext: { ...applyCtx(), sha } },
  });
  assert.equal(res.succeeded, true, 'still filed -- a human can see it');
  const doc = fs.readFileSync(path.join(dir, 'Docs', 'CHANGE_REVIEW_CANDIDATES.md'), 'utf8');
  assert.match(doc, /^Strength: Unverified$/m);
  assert.doesNotMatch(doc, /^Strength: Strong$/m);
  assert.match(doc, /\[UNVERIFIED QUOTE: `loadBox\(mode\.box, mode\.scope, 1\)` \(quoted as existing code\) does not appear verbatim in src\/View\.tsx/);
  assert.match(doc, /closest real line: `loadBox\(mode\.box, mode\.scope, p\);`/);
  assert.match(doc, /severity: high/, 'the finding itself is preserved');
});

test('applyChangeReview: a finding whose quoted existing code IS in the file stays Strong (no false downgrade)', () => {
  const { dir, sha } = repoWithFile('src/View.tsx', FILE_BODY);
  const { mod } = freshPlugin(dir);
  mod.applyChangeReview({
    implementResponse: findingResp('replace `loadBox(mode.box, next, 1)` with `loadBox(mode.box, other, 1)`'),
    task: { promptContext: { ...applyCtx(), sha } },
  });
  const doc = fs.readFileSync(path.join(dir, 'Docs', 'CHANGE_REVIEW_CANDIDATES.md'), 'utf8');
  assert.match(doc, /^Strength: Strong$/m);
  assert.doesNotMatch(doc, /UNVERIFIED QUOTE/);
});

test('applyChangeReview: the check fails OPEN -- file unreadable at that commit stays Strong', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-quote-open-')); // not a git repo
  const { mod } = freshPlugin(dir);
  mod.applyChangeReview({
    implementResponse: findingResp('replace `totallyMadeUp(code, here, 1)` with x'),
    task: { promptContext: { sha: 'abc1234', subject: 's', unitDiff: '' } },
  });
  assert.match(fs.readFileSync(path.join(dir, 'Docs', 'CHANGE_REVIEW_CANDIDATES.md'), 'utf8'), /^Strength: Strong$/m);
});

test('applyChangeReview: two findings, one bad quote -> only that one is downgraded', () => {
  const { dir, sha } = repoWithFile('src/View.tsx', FILE_BODY);
  const { mod } = freshPlugin(dir);
  const resp = [findingResp('replace `loadBox(mode.box, mode.scope, 1)` with y'), '', findingResp('replace `loadBox(mode.box, mode.scope, p)` with y').replace('Line: 5', 'Line: 2')].join('\n');
  mod.applyChangeReview({ implementResponse: resp, task: { promptContext: { ...applyCtx(), sha } } });
  const doc = fs.readFileSync(path.join(dir, 'Docs', 'CHANGE_REVIEW_CANDIDATES.md'), 'utf8');
  assert.equal((doc.match(/^Strength: Unverified$/gm) || []).length, 1);
  assert.equal((doc.match(/^Strength: Strong$/gm) || []).length, 1);
});

test('change_review registers an advisory postImplementCheck that WARNS (never blocks) on an unverified quote', async () => {
  const { dir, sha } = repoWithFile('src/View.tsx', FILE_BODY);
  const { mod, getRegisteredSource } = freshPlugin(dir);
  const check = getRegisteredSource('change_review').postImplementCheck;
  assert.equal(typeof check, 'function');
  const bad = await check({ promptContext: { ...applyCtx(), sha } }, findingResp('replace `loadBox(mode.box, mode.scope, 1)` with y'));
  assert.equal(bad.verdict, 'ok');
  assert.equal(bad.warnings.length, 1);
  assert.match(bad.warnings[0], /finding on src\/View\.tsx: `loadBox\(mode\.box, mode\.scope, 1\)`/);
  const good = await check({ promptContext: { ...applyCtx(), sha } }, findingResp('replace `loadBox(mode.box, next, 1)` with y'));
  assert.deepEqual(good, { verdict: 'ok' });
  assert.deepEqual(await check({ promptContext: applyCtx() }, 'NO CORRECTNESS ISSUES'), { verdict: 'ok' });
  assert.equal(typeof mod.changeReviewQuoteCheck, 'function');
});

test('applyChangeReview: malformed block (no Failure scenario) is dropped; all dropped -> skipped', () => {
  const { mod } = freshPlugin(fs.mkdtempSync(path.join(os.tmpdir(), 'cr-apply4-')));
  const resp = 'FINDING\nFile: src/a.js\nRegression: something\nFix sketch: x\n';
  assert.equal(mod.applyChangeReview({ implementResponse: resp, task: { promptContext: applyCtx() } }).skipped, true);
});

test('applyChangeReview: AC block stays under 3500 chars even with a huge hunk', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-apply5-'));
  const { mod } = freshPlugin(dir);
  const hugeHunk = `diff --git a/src/a.js b/src/a.js\n@@ -1 +1 @@\n${'+x'.repeat(3000)}\n`;
  const resp = [
    'FINDING', 'File: src/a.js', 'Line: 1', 'Severity: low',
    'Regression: r', 'Failure scenario: f(1) -> 2 not 1', 'Fix sketch: s',
  ].join('\n');
  mod.applyChangeReview({ implementResponse: resp, task: { promptContext: { sha: 'z', subject: 's', unitDiff: hugeHunk } } });
  const doc = fs.readFileSync(path.join(dir, 'Docs', 'CHANGE_REVIEW_CANDIDATES.md'), 'utf8');
  const block = doc.split(/^### /m).find((b) => b.startsWith('AC-1'));
  assert.ok(block.length < 3500, `block was ${block.length} chars`);
});

// --- register + prompts ------------------------------------------------------

test('register smoke: both sources with the expected fields', () => {
  const { getRegisteredSource } = freshPlugin(fs.mkdtempSync(path.join(os.tmpdir(), 'cr-reg-')));
  const cr = getRegisteredSource('change_review');
  const fx = getRegisteredSource('change_review_fix');
  assert.equal(cr.priority, 60);
  assert.equal(typeof cr.apply, 'function');
  assert.equal(cr.directToMain, true);
  assert.equal(cr.advisoryProse, true);
  assert.equal(cr.emptyApproval, true);
  assert.equal(cr.harnessSearch, 'archImport');
  assert.ok(cr.reviewGuidance && cr.reviewCompletenessQuestion);
  assert.equal(fx.priority, 58);
  assert.equal(fx.candidateFulfillment, true);
  assert.equal(fx.noCandidateSplit, true);
  assert.equal(fx.buildPlanPrompt, require('agent-manager/src/prompts.js').archReviewPlanPrompt);
});

test('priority override via AGENT_MANAGER_TASK_PRIORITIES', () => {
  process.env.AGENT_MANAGER_TASK_PRIORITIES = 'change_review:40';
  const { getRegisteredSource } = freshPlugin(fs.mkdtempSync(path.join(os.tmpdir(), 'cr-pri-')));
  assert.equal(getRegisteredSource('change_review').priority, 40);
  delete process.env.AGENT_MANAGER_TASK_PRIORITIES;
});

test('prompt builders carry the required scaffolding', () => {
  const { mod } = freshPlugin(fs.mkdtempSync(path.join(os.tmpdir(), 'cr-prompt-')));
  const task = { promptContext: { sha: 'abc1234', subject: 's', author: 'a', dateISO: 'd', mainBranch: 'main', files: ['M\tsrc/a.js'], unitDiff: '@@ -1 +1 @@\n-a\n+b\n', smallFileContents: [] } };
  const plan = mod.changeReviewPlanPrompt(task);
  assert.match(plan, /abc1234/);
  assert.match(plan, /walks EVERY changed hunk/);
  assert.match(plan, /off-by-one/);
  assert.match(plan, /QUERY:/);
  assert.match(plan, /-a\n\+b/);
  const impl = mod.changeReviewImplementPrompt(task, 'PLAN TEXT HERE');
  assert.match(impl, /PLAN TEXT HERE/);
  assert.match(impl, /^FINDING$/m);
  assert.match(impl, /NO CORRECTNESS ISSUES/);
  assert.match(impl, /Failure scenario:/);
});

test('prompt builders: a batch task shows every commit separately and demands a Commit: line on each finding', () => {
  const { mod } = freshPlugin(fs.mkdtempSync(path.join(os.tmpdir(), 'cr-prompt-batch-')));
  const task = {
    promptContext: {
      mainBranch: 'main',
      units: [
        { sha: 'aaa1111', subject: 'first fix', author: 'a', dateISO: 'd1', files: ['M\tsrc/a.js'], unitDiff: '@@ -1 +1 @@\n-old a\n+new a\n', smallFileContents: [] },
        { sha: 'bbb2222', subject: 'second fix', author: 'a', dateISO: 'd2', files: ['M\tsrc/b.js'], unitDiff: '@@ -1 +1 @@\n-old b\n+new b\n', smallFileContents: [] },
      ],
    },
  };
  const plan = mod.changeReviewPlanPrompt(task);
  assert.match(plan, /COMMIT 1\/2: aaa1111/);
  assert.match(plan, /COMMIT 2\/2: bbb2222/);
  assert.match(plan, /-old a\n\+new a/);
  assert.match(plan, /-old b\n\+new b/);
  assert.match(plan, /2 small, separately-authored changes/);

  const impl = mod.changeReviewImplementPrompt(task, 'PLAN TEXT HERE');
  assert.match(impl, /COMMIT 1\/2: aaa1111/);
  assert.match(impl, /COMMIT 2\/2: bbb2222/);
  assert.match(impl, /^Commit: <the exact COMMIT sha shown above/m, 'a batch task must instruct the model to name which commit each finding is about');
  assert.match(impl, /^FINDING$/m);
});

// --- Truncated-diff review-gate exception (2026-09-18, bd-1789601881616) ---------------
// capHunks() (used building task.promptContext.unitDiff when the real diff exceeds
// budget) appends a deterministic "...[diff truncated: showing N of M hunks]" marker.
// changeReviewGuidanceFor/changeReviewCompletenessQuestionFor read that marker straight
// off the SAME unitDiff review-task.js's buildVerdictPrompt feeds the reviewer, and scope
// the "every hunk" coverage bar down to the hunks actually shown.

const {
  changeReviewGuidanceFor, changeReviewCompletenessQuestionFor,
  CHANGE_REVIEW_REVIEW_GUIDANCE, CHANGE_REVIEW_COMPLETENESS_QUESTION,
} = require('./change-review.js');

test('changeReviewGuidanceFor: a normal, non-truncated diff gets the ORIGINAL guidance, unchanged', () => {
  const task = { promptContext: { unitDiff: '@@ -1 +1 @@\n-a\n+b\n' } };
  assert.equal(changeReviewGuidanceFor(task), CHANGE_REVIEW_REVIEW_GUIDANCE);
});

test('changeReviewGuidanceFor: a truncated diff appends a scoped exception naming the exact shown/total hunk counts', () => {
  const task = { promptContext: { unitDiff: '@@ -1 +1 @@\n-a\n+b\n...[diff truncated: showing 6 of 13 hunks]' } };
  const g = changeReviewGuidanceFor(task);
  assert.match(g, new RegExp(CHANGE_REVIEW_REVIEW_GUIDANCE.split('\n')[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'original guidance text must still be present, not replaced');
  assert.match(g, /TRUNCATION EXCEPTION/);
  assert.match(g, /hunks?\s*\n?\s*1 through 6/);
  assert.match(g, /hunk 7 through 13/);
  assert.match(g, /must NOT be rejected for failing to walk/i);
});

test('changeReviewGuidanceFor: no promptContext / no unitDiff at all -> falls back to the original guidance, no throw', () => {
  assert.equal(changeReviewGuidanceFor({}), CHANGE_REVIEW_REVIEW_GUIDANCE);
  assert.equal(changeReviewGuidanceFor({ promptContext: {} }), CHANGE_REVIEW_REVIEW_GUIDANCE);
});

test('changeReviewCompletenessQuestionFor: mirrors the same truncation-aware scoping as the guidance', () => {
  const clean = { promptContext: { unitDiff: '@@ -1 +1 @@\n-a\n+b\n' } };
  assert.equal(changeReviewCompletenessQuestionFor(clean), CHANGE_REVIEW_COMPLETENESS_QUESTION);

  const truncated = { promptContext: { unitDiff: '...[diff truncated: showing 2 of 5 hunks]' } };
  const q = changeReviewCompletenessQuestionFor(truncated);
  assert.match(q, /1 through 2/);
  assert.match(q, /truncated\s*\n?\s*to 2 of 5 total hunks/);
  assert.match(q, /must not be required/i);
});

test('register smoke: change_review reviewGuidance/reviewCompletenessQuestion are truncation-aware functions, not static strings', () => {
  const { getRegisteredSource } = freshPlugin(fs.mkdtempSync(path.join(os.tmpdir(), 'cr-trunc-reg-')));
  const cr = getRegisteredSource('change_review');
  assert.equal(typeof cr.reviewGuidance, 'function');
  assert.equal(typeof cr.reviewCompletenessQuestion, 'function');
  const truncatedTask = { promptContext: { unitDiff: '...[diff truncated: showing 1 of 9 hunks]' } };
  assert.match(cr.reviewGuidance(truncatedTask), /TRUNCATION EXCEPTION/);
  assert.match(cr.reviewCompletenessQuestion(truncatedTask), /1 through 1/);
});

// --- sanitizeDiff / capHunks: bulk data must never crowd out the real code hunks -------------------
// 2026-09-19 (PF-Client-Portal a747d62): a 1.8 MB single-line GeoJSON file came first in the diff, was kept
// whole as "hunk 1", consumed the whole budget, and the small PropertyMap.tsx hunks after it were cut --
// every draft said "no hunks visible" and the task escalated to a human after 8 attempts.
{
  const { sanitizeDiff, capHunks, buildPromptContext } = require('./change-review.js');
  const bigJson = `diff --git a/public/geo/us-counties.json b/public/geo/us-counties.json\nnew file mode 100644\n--- /dev/null\n+++ b/public/geo/us-counties.json\n@@ -0,0 +1 @@\n+{"type":"FeatureCollection","features":[${'[-86.497,32.344],'.repeat(120000)}]}\n`;
  const tsx = 'diff --git a/src/components/PropertyMap.tsx b/src/components/PropertyMap.tsx\n--- a/src/components/PropertyMap.tsx\n+++ b/src/components/PropertyMap.tsx\n@@ -10,3 +10,5 @@ function strengthen()\n-  const z = 5;\n+  const z = 6;\n+  addCountyLayer(map, z);\n';

  test('sanitizeDiff stubs a bulk data file and keeps the real code hunks intact', () => {
    const out = sanitizeDiff(bigJson + tsx);
    assert.ok(out.length < 2000, `expected a small diff, got ${out.length}`);
    assert.match(out, /bulk data file elided from review -- not a code change: public\/geo\/us-counties\.json/);
    assert.ok(out.includes('+  addCountyLayer(map, z);'), 'the real TSX hunk survives');
  });

  test('sanitizeDiff leaves a small JSON change alone (only BULK data is elided)', () => {
    const small = 'diff --git a/package.json b/package.json\n--- a/package.json\n+++ b/package.json\n@@ -1,3 +1,3 @@\n-  "version": "1.0.0",\n+  "version": "1.0.1",\n';
    assert.equal(sanitizeDiff(small), small);
  });

  test('sanitizeDiff truncates an absurdly long line in a code file (minified/inline data)', () => {
    const long = `diff --git a/src/a.js b/src/a.js\n--- a/src/a.js\n+++ b/src/a.js\n@@ -1 +1 @@\n+${'x'.repeat(5000)}\n`;
    const out = sanitizeDiff(long);
    assert.ok(out.length < 1200);
    assert.match(out, /\.\.\.\[\+4401 chars cut\]/);
  });

  test('capHunks never lets a single oversized hunk through the budget', () => {
    const one = `diff --git a/x b/x\n@@ -0,0 +1 @@\n+${'y'.repeat(200000)}\n@@ -5,1 +5,1 @@\n-a\n+b\n`;
    const out = capHunks(one, 16000);
    assert.ok(out.length < 16000 * 1.25 + 200, `got ${out.length}`);
    assert.match(out, /\[diff truncated: showing \d+ of \d+ hunks\]/);
  });

  test('buildPromptContext: a commit with a huge data file still shows the code change, within budget', () => {
    const ctx = buildPromptContext('/nonexistent', { sha7: 'a747d62', subject: 's', author: 'a', dateISO: 'd' },
      [{ status: 'A', path: 'public/geo/us-counties.json' }, { status: 'M', path: 'src/components/PropertyMap.tsx' }], bigJson + tsx, 'main');
    assert.ok(ctx.unitDiff.length < 3000, `unitDiff should be small, got ${ctx.unitDiff.length}`);
    assert.ok(ctx.unitDiff.includes('+  addCountyLayer(map, z);'));
    assert.match(ctx.unitDiff, /bulk data file elided/);
  });
}
