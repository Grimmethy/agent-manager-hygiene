'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  computePremiseEvidence, hasCheckableClaim, runPremiseCheck, parsePremiseVerdict,
  checkCitations, checkUniformityClaim,
} = require('./arch-import-premise-check.js');

// Mirrors the real src/review-task.js shape: many return sites, a small shared
// vocabulary of field names (succeeded/verdict/blockedReason/blockedStage/factCheckVerdict)
// -- more return sites than distinct keys, the signal that contradicts an "ad hoc" claim.
const REVIEW_TASK_FIXTURE = [
  "function f1() { return { succeeded: true, verdict: 'approved', factCheckVerdict: 'skipped' }; }",
  "function f2() { return { succeeded: true, verdict: 'blocked', blockedReason: 'x', blockedStage: 'review', factCheckVerdict: 'skipped' }; }",
  "function f3() { return { succeeded: true, verdict: 'blocked', blockedReason: 'x', blockedStage: 'review', factCheckVerdict: 'y' }; }",
  "function f4() { return { succeeded: true, verdict: 'approved', factCheckVerdict: 'y' }; }",
  "function f5() { return { succeeded: true, verdict: 'blocked', blockedReason: 'z', blockedStage: 'review', factCheckVerdict: 'z' }; }",
  "function f6() { return { succeeded: true, verdict: 'blocked', blockedReason: 'z', blockedStage: 'review', factCheckVerdict: 'z' }; }",
].join('\n');

const task = (over = {}) => ({
  source: 'arch_import_review',
  promptContext: {
    candidateId: 'AC-8', title: 't', files: ['src/review-task.js'],
    fetchedFiles: [{ path: 'src/review-task.js', content: REVIEW_TASK_FIXTURE }],
    body: 'Problem:\nthe shell script and the JS worker each decide their own field names for the verdict.',
    ...over.promptContext,
  },
  ...over,
});

// --- computePremiseEvidence / checkUniformityClaim (the AC-8 shape) --------------------

test('checkUniformityClaim / computePremiseEvidence: AC-8 fixture -- uniform return vocabulary contradicts the "each...own" claim', () => {
  const t = task();
  const ev = computePremiseEvidence(t);
  assert.equal(ev.contradictions.length, 1);
  assert.equal(ev.contradictions[0].kind, 'uniform-return');
  assert.match(ev.contradictions[0].detail, /src\/review-task\.js has 6 `return \{ \.\.\. \}` statements/);
  assert.match(ev.contradictions[0].detail, /shared vocabulary of only 5 field name/);
});

test('checkUniformityClaim: does not flag a genuinely true "each...own" claim (real key-set variety)', () => {
  const t = task({
    promptContext: {
      body: 'Problem: each handler uses its own, totally different field names -- ad hoc.',
      fetchedFiles: [{ path: 'src/bar.js', content: 'function a(){return {status:1}} function b(){return {outcome:2}} function c(){return {decision:3}}' }],
    },
  });
  assert.deepEqual(computePremiseEvidence(t).contradictions, []);
});

test('checkUniformityClaim: no uniformity CLAIM in the body -> never even looks at the returns', () => {
  const t = task({ promptContext: { body: 'Problem: this project lacks a caching layer.', fetchedFiles: [{ path: 'src/review-task.js', content: REVIEW_TASK_FIXTURE }] } });
  assert.deepEqual(checkUniformityClaim(t, t.promptContext.body), []);
});

test('checkUniformityClaim: fewer than MIN_RETURN_SITES sample -> not enough evidence, no flag', () => {
  const t = task({
    promptContext: {
      body: 'Problem: each caller uses its own ad-hoc field names.',
      fetchedFiles: [{ path: 'src/tiny.js', content: 'function a(){return {x:1}}' }],
    },
  });
  assert.deepEqual(computePremiseEvidence(t).contradictions, []);
});

// --- checkCitations (the omnigent-28 shape: a symbol cited in a file that doesn't have it) ---

test('checkCitations: flags a symbol cited in a specific file that does not appear there', () => {
  const t = task({
    promptContext: {
      body: 'The draft cites `src/local-agentic-draft.js:63` as a location referencing `INFRA_FAILURE_PATTERN`, but that pattern is never defined there.',
      fetchedFiles: [{ path: 'src/local-agentic-draft.js', content: 'function foo() { return 1; }\n' }],
    },
  });
  const ev = computePremiseEvidence(t);
  assert.equal(ev.contradictions.length, 1);
  assert.equal(ev.contradictions[0].kind, 'missing-citation');
  assert.match(ev.contradictions[0].detail, /INFRA_FAILURE_PATTERN/);
});

test('checkCitations: does not flag a symbol that genuinely appears in its cited file', () => {
  const t = task({
    promptContext: {
      body: 'The draft cites `src/local-agentic-draft.js:63` as defining `runHarnessSearch`.',
      fetchedFiles: [{ path: 'src/local-agentic-draft.js', content: 'function runHarnessSearch() {}\n' }],
    },
  });
  assert.deepEqual(checkCitations(t, t.promptContext.body), []);
});

test('checkCitations: a cited path with no fetchedFiles entry is skipped, not flagged (nothing to check)', () => {
  const t = task({
    promptContext: {
      body: 'See `src/never-fetched.js` and `SOME_SYMBOL`.',
      fetchedFiles: [],
    },
  });
  assert.deepEqual(checkCitations(t, t.promptContext.body), []);
});

// --- hasCheckableClaim -------------------------------------------------------------------

test('hasCheckableClaim: true for a uniformity phrase or a path citation, false for plain prose', () => {
  assert.equal(hasCheckableClaim(task()), true); // "each...own" phrase
  assert.equal(hasCheckableClaim(task({ promptContext: { body: 'See `src/x.js` for details.', fetchedFiles: [] } })), true);
  assert.equal(hasCheckableClaim(task({ promptContext: { body: 'This project lacks a caching layer.', fetchedFiles: [] } })), false);
});

// --- parsePremiseVerdict -----------------------------------------------------------------

test('parsePremiseVerdict: PREMISE_VALID / PREMISE_INVALID / noise', () => {
  assert.deepEqual(parsePremiseVerdict('PREMISE_VALID'), { verdict: 'ok' });
  assert.deepEqual(parsePremiseVerdict('PREMISE_INVALID -- the file shows a shared vocabulary, not ad-hoc names'),
    { verdict: 'invalid-premise', reason: 'the file shows a shared vocabulary, not ad-hoc names' });
  assert.deepEqual(parsePremiseVerdict('Well, this is a nuanced question...'), { verdict: 'ok' }, '3b-noise -> ok, same as plan-critique');
});

// --- runPremiseCheck: deterministic-first / cheap-model-fallback / kill switch ---------

test('runPremiseCheck: a deterministic contradiction blocks with zero model calls', async () => {
  let called = false;
  const r = await runPremiseCheck(task(), { call: async () => { called = true; return { response: 'PREMISE_VALID' }; } });
  assert.equal(r.verdict, 'invalid-premise');
  assert.match(r.reason, /shared vocabulary/);
  assert.equal(called, false);
});

test('runPremiseCheck: no checkable claim -> ok, zero model calls', async () => {
  let called = false;
  const t = task({ promptContext: { body: 'Problem: this project lacks a caching layer.', fetchedFiles: [] } });
  const r = await runPremiseCheck(t, { call: async () => { called = true; return { response: 'PREMISE_VALID' }; } });
  assert.deepEqual(r, { verdict: 'ok' });
  assert.equal(called, false);
});

test('runPremiseCheck: a checkable-but-unsettled claim falls back to one qwen2.5:3b call via maybeLockedOn', async () => {
  const t = task({
    promptContext: {
      body: 'The draft cites `src/x.js:10` as containing `SOME_UNVERIFIABLE_THING` -- wait, actually the shape is ambiguous.',
      fetchedFiles: [{ path: 'src/x.js', content: 'const SOME_UNVERIFIABLE_THING = 1;\n' }], // symbol IS present -> deterministic check finds nothing
    },
  });
  let lockLabel = null; let modelUsed = null;
  const r = await runPremiseCheck(t, {
    call: async ({ model }) => { modelUsed = model; return { response: 'PREMISE_INVALID -- x' }; },
    maybeLockedOn: async (model, fn, label) => { lockLabel = label; return fn(); },
  });
  assert.equal(lockLabel, 'arch-import-premise');
  assert.equal(modelUsed, 'qwen2.5:3b');
  assert.equal(r.verdict, 'invalid-premise');
});

test('runPremiseCheck: a model-call throw is advisory -- never blocks', async () => {
  const t = task({
    promptContext: {
      body: 'See `src/x.js:1` for `THING`.',
      fetchedFiles: [{ path: 'src/x.js', content: 'const THING = 1;\n' }],
    },
  });
  const r = await runPremiseCheck(t, { call: async () => { throw new Error('model timed out'); } });
  assert.equal(r.verdict, 'ok');
});

test('runPremiseCheck: kill switch AGENT_MANAGER_ARCH_IMPORT_PREMISE_CHECK=false -> always ok, no grep/model work', async () => {
  process.env.AGENT_MANAGER_ARCH_IMPORT_PREMISE_CHECK = 'false';
  try {
    let called = false;
    const r = await runPremiseCheck(task(), { call: async () => { called = true; return { response: 'PREMISE_INVALID -- x' }; } });
    assert.deepEqual(r, { verdict: 'ok' });
    assert.equal(called, false);
  } finally {
    delete process.env.AGENT_MANAGER_ARCH_IMPORT_PREMISE_CHECK;
  }
});

test('runPremiseCheck: reuses promptContext.premiseEvidence when already computed, does not recompute', async () => {
  const t = task();
  t.promptContext.premiseEvidence = { contradictions: [] }; // pretend a prior computation found nothing
  const r = await runPremiseCheck(t, { call: async () => ({ response: 'PREMISE_VALID' }) });
  assert.equal(r.verdict, 'ok'); // would have been invalid-premise if it recomputed from the AC-8 body
});

// --- full-file verification of a "not found" verdict (AC-13 incident, 2026-09-18) -----------
// fetchedFiles is a WINDOWED, truncated slice of each file. AC-13 cited `arch_discovery` in
// python/dashboard/app.py (4,229 lines, 7 real occurrences); the ~14KB window missed them,
// so this check declared a real citation fabricated, blocked the task, and stamped the false
// verdict into promptContext.premiseEvidence -- which the reviewer prompt then treats as
// "REJECT regardless". A snapshot miss must be re-verified against the real file first.
// (Same fix as agent-manager core's candidate-premise-check.js.)

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function withRepo(files, fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arch-premise-'));
  try {
    for (const [rel, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), content);
    }
    return fn(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const TRUNCATED = '...[truncated]...\nunrelated head of the file\n...[truncated]...\n';
const citing = (over = {}) => task({
  promptContext: {
    body: 'Problem: `src/app.py` cites `arch_discovery` as an existing route but never wires it.',
    fetchedFiles: [{ path: 'src/app.py', content: TRUNCATED }],
    ...over,
  },
});

test('checkCitations: a symbol missing from a TRUNCATED snapshot but present in the real file is NOT a contradiction', () => {
  withRepo({ 'src/app.py': 'def arch_discovery():\n    pass\n' }, (root) => {
    const t = citing();
    assert.deepEqual(checkCitations(t, t.promptContext.body, { repoRoots: [root] }), []);
  });
});

test('checkCitations: a symbol absent from both the snapshot and the real file IS still a contradiction', () => {
  withRepo({ 'src/app.py': 'def something_else():\n    pass\n' }, (root) => {
    const t = citing();
    const c = checkCitations(t, t.promptContext.body, { repoRoots: [root] });
    assert.equal(c.length, 1);
    assert.equal(c[0].kind, 'missing-citation');
  });
});

test('checkCitations: truncated snapshot + real file unreadable -> no verdict (cannot verify, do not guess)', () => {
  withRepo({}, (root) => {
    const t = citing();
    assert.deepEqual(checkCitations(t, t.promptContext.body, { repoRoots: [root] }), []);
  });
});

test('checkCitations: complete (untruncated) snapshot + real file unreadable keeps the original verdict', () => {
  withRepo({}, (root) => {
    const t = citing({ fetchedFiles: [{ path: 'src/app.py', content: 'def other():\n    pass\n' }] });
    assert.equal(checkCitations(t, t.promptContext.body, { repoRoots: [root] }).length, 1);
  });
});

test('runPremiseCheck does not replay a stale persisted contradiction that the real file refutes', async () => {
  await withRepo({ 'src/app.py': 'def arch_discovery():\n    pass\n' }, async (root) => {
    const t = citing({
      premiseEvidence: { contradictions: [{ kind: 'missing-citation', detail: 'candidate cites `arch_discovery` in src/app.py, but that name does not appear anywhere in the real fetched content of src/app.py' }] },
    });
    const r = await runPremiseCheck(t, {
      repoRoots: [root],
      call: async () => ({ response: 'PREMISE_VALID' }),
    });
    assert.equal(r.verdict, 'ok');
  });
});
