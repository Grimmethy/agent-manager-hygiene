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

test('BACKFILL past N commits -> task for the OLDEST unreviewed commit; cursor NOT advanced', () => {
  const repo = makeGitRepo();
  repo.commit({ 'a.js': 'v0\n' }, 'c1');
  const c2 = repo.commit({ 'a.js': 'v1\nSECOND\n' }, 'c2');
  const c3 = repo.commit({ 'a.js': 'v1\nSECOND\nTHIRD\n' }, 'c3');
  writeCursor(repo.dir, git(repo.dir, ['rev-parse', `${c2}^`])); // review c2 and c3
  const { mod, getConfig, taskIdExistsInQueue } = freshPlugin(repo.dir);
  const task = mod.nextChangeReviewTask({ getConfig, taskIdExistsInQueue });
  assert.ok(task);
  assert.equal(task.id, `change-review-${c2.slice(0, 7)}`);
  assert.equal(task.source, 'change_review');
  assert.match(task.promptContext.unitDiff, /SECOND/);
  assert.equal(readCursor(repo.dir), git(repo.dir, ['rev-parse', `${c2}^`]), 'cursor holds at the pre-c2 sha');
  assert.ok(c3);
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

test('cursor safety: a returned-but-unqueued commit does not lose later commits', () => {
  const repo = makeGitRepo();
  repo.commit({ 'a.js': 'v0\n' }, 'c1');
  const c2 = repo.commit({ 'a.js': 'v0\nB\n' }, 'c2');
  const c3 = repo.commit({ 'a.js': 'v0\nB\nC\n' }, 'c3');
  const c4 = repo.commit({ 'a.js': 'v0\nB\nC\nD\n' }, 'c4');
  writeCursor(repo.dir, git(repo.dir, ['rev-parse', `${c2}^`]));
  const p1 = freshPlugin(repo.dir);
  const t1 = p1.mod.nextChangeReviewTask({ getConfig: p1.getConfig, taskIdExistsInQueue: p1.taskIdExistsInQueue });
  assert.equal(t1.id, `change-review-${c2.slice(0, 7)}`);
  assert.equal(readCursor(repo.dir), git(repo.dir, ['rev-parse', `${c2}^`]));
  // c2's task now lands in the queue; next tick must reach c3, then c4.
  seedQueue(repo.dir, 'approved', `change-review-${c2.slice(0, 7)}`);
  const p2 = freshPlugin(repo.dir);
  const t2 = p2.mod.nextChangeReviewTask({ getConfig: p2.getConfig, taskIdExistsInQueue: p2.taskIdExistsInQueue });
  assert.equal(t2.id, `change-review-${c3.slice(0, 7)}`);
  assert.ok(c4);
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
