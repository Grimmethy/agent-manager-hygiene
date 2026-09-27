'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  normalizeSnippet, suppressionKey, isSuppressed, isClusterSuppressed, recordSuppression, recordFalsePositiveIfVerdict, readRows, suppressionsPath,
  recordInconclusiveReview, readAttemptRows, attemptsPath, MAX_INCONCLUSIVE_REVIEW_ATTEMPTS,
} = require('./suppression-store.js');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'suppression-store-test-'));
}

test('record -> isSuppressed round-trips for the same construct', () => {
  const dir = tmpDir();
  const snippet = 'for (const file of files) {\n  fs.readFileSync(file);\n}';
  assert.equal(isSuppressed(dir, 'sync-io-in-loop', snippet), false);
  const r = recordSuppression(dir, { rule: 'sync-io-in-loop', file: 'src/x.js', snippet, taskId: 't1' });
  assert.equal(r.recorded, true);
  assert.equal(isSuppressed(dir, 'sync-io-in-loop', snippet), true);
});

// isClusterSuppressed: coarser sibling of isSuppressed (2026-09-15, bd-1788764340728) --
// catches a DIFFERENT finding, same rule, same directory as one already dismissed, which
// isSuppressed's exact-snippet keying can never match.
test('isClusterSuppressed is true for a different snippet in the same rule+directory once one sibling is suppressed', () => {
  const dir = tmpDir();
  recordSuppression(dir, { rule: 'silent-catch-block', file: 'src/a.js', snippet: 'try { x() } catch (e) {}', taskId: 't1' });

  assert.equal(isClusterSuppressed(dir, 'silent-catch-block', 'src'), true);
  // The individual finding is NOT suppressed by exact-snippet matching -- proves this is a
  // genuinely different, additional signal, not a duplicate of isSuppressed.
  assert.equal(isSuppressed(dir, 'silent-catch-block', 'try { y() } catch (e) {}'), false);
});

test('isClusterSuppressed is false for a different rule in the same directory', () => {
  const dir = tmpDir();
  recordSuppression(dir, { rule: 'silent-catch-block', file: 'src/a.js', snippet: 'try { x() } catch (e) {}', taskId: 't1' });
  assert.equal(isClusterSuppressed(dir, 'sync-io-in-loop', 'src'), false);
});

test('isClusterSuppressed is false for the same rule in a different directory', () => {
  const dir = tmpDir();
  recordSuppression(dir, { rule: 'silent-catch-block', file: 'src/a.js', snippet: 'try { x() } catch (e) {}', taskId: 't1' });
  assert.equal(isClusterSuppressed(dir, 'silent-catch-block', 'lib'), false);
});

test('isClusterSuppressed returns false (not throw) with no rule, no directory, or no suppression file yet', () => {
  const dir = tmpDir();
  assert.equal(isClusterSuppressed(dir, '', 'src'), false);
  assert.equal(isClusterSuppressed(dir, 'silent-catch-block', ''), false);
  assert.equal(isClusterSuppressed(dir, 'silent-catch-block', 'src'), false, 'no suppressions recorded yet');
});

test('suppression survives line-number drift and reindentation (key is content-hashed, not file:line)', () => {
  const dir = tmpDir();
  const atLine100 = '    for (const item of items) {\n      await fetch(item.url);\n    }';
  const sameConstructMovedAndReindented = '\tfor (const item of items) {\n\t  await fetch(item.url);\n\t}';
  recordSuppression(dir, { rule: 'sequential-await-in-loop', file: 'src/worker.js', snippet: atLine100 });
  assert.equal(isSuppressed(dir, 'sequential-await-in-loop', sameConstructMovedAndReindented), true);
});

test('a different rule or a different construct is NOT suppressed', () => {
  const dir = tmpDir();
  const snippet = 'for (const x of xs) { await fetch(x); }';
  recordSuppression(dir, { rule: 'sequential-await-in-loop', snippet });
  assert.equal(isSuppressed(dir, 'sync-io-in-loop', snippet), false, 'different rule');
  assert.equal(isSuppressed(dir, 'sequential-await-in-loop', 'for (const y of ys) { await g(y); }'), false, 'different construct');
});

test('recordSuppression is idempotent -- a repeat write adds no row', () => {
  const dir = tmpDir();
  const snippet = 'while (true) { tick(); }';
  const a = recordSuppression(dir, { rule: 'unguarded-long-running-loop', snippet });
  const b = recordSuppression(dir, { rule: 'unguarded-long-running-loop', snippet });
  assert.equal(a.recorded, true);
  assert.equal(b.recorded, false);
  assert.equal(readRows(dir).length, 1);
});

test('an empty / whitespace-only snippet is never recorded and never matches', () => {
  const dir = tmpDir();
  assert.equal(recordSuppression(dir, { rule: 'r', snippet: '   \n\t ' }).recorded, false);
  assert.equal(isSuppressed(dir, 'r', ''), false);
  assert.equal(fs.existsSync(suppressionsPath(dir)), false);
});

test('normalizeSnippet / suppressionKey collapse whitespace so indentation & wrapping do not change the key', () => {
  assert.equal(normalizeSnippet('  a\n\t b   c '), 'a b c');
  assert.equal(
    suppressionKey('r', 'for (x) {\n  y();\n}'),
    suppressionKey('r', '        for (x) {\n            y();\n        }'),
  );
});

test('recordFalsePositiveIfVerdict writes exactly one row for a skipped + "false positive" verdict', () => {
  const dir = tmpDir();
  const task = { id: 'perf-1', promptContext: { rule: 'sync-io-in-loop', file: 'src/scan.js', snippet: 'for (const f of files) { fs.readFileSync(f); }' } };
  const out = recordFalsePositiveIfVerdict({
    applyResult: { skipped: true },
    implementResponse: '## Verdict: False Positive\n\nThis is a one-shot CLI tool ...',
    task,
    pipelineDir: dir,
  });
  assert.equal(out.recorded, true);
  assert.equal(readRows(dir).length, 1);
  assert.equal(isSuppressed(dir, 'sync-io-in-loop', task.promptContext.snippet), true);
});

test('recordFalsePositiveIfVerdict writes nothing for an "uncertain" verdict, or when a candidate WAS written', () => {
  const dir = tmpDir();
  const task = { id: 'perf-2', promptContext: { rule: 'r', file: 'f', snippet: 'for (x) { io(); }' } };

  assert.equal(recordFalsePositiveIfVerdict({ applyResult: { skipped: true }, implementResponse: 'Verdict: uncertain -- would need profiling data', task, pipelineDir: dir }), null);
  assert.equal(recordFalsePositiveIfVerdict({ applyResult: { file: 'Docs/PERFORMANCE_FIX_CANDIDATES.md', candidateIds: ['AC-1'] }, implementResponse: 'genuine issue: false positive is mentioned but a candidate was written', task, pipelineDir: dir }), null);
  assert.equal(readRows(dir).length, 0);
});

test('recordInconclusiveReview promotes a construct to a suppression after MAX attempts', () => {
  const dir = tmpDir();
  const snippet = 'try:\n    do_thing()\nexcept OSError:\n    pass';
  const task = { id: 'obs-1', promptContext: { rule: 'silent-catch-block', file: 'python/dashboard/app.py', snippet } };
  const call = () => recordInconclusiveReview({
    applyResult: { skipped: true, reason: 'no candidates in implement response -- nothing to apply' },
    implementResponse: 'GENUINE issue — the error should be logged.\n(no candidate block produced)',
    task,
    pipelineDir: dir,
  });

  for (let i = 1; i < MAX_INCONCLUSIVE_REVIEW_ATTEMPTS; i += 1) {
    const r = call();
    assert.equal(r.promoted, false);
    assert.equal(r.count, i);
    assert.equal(isSuppressed(dir, 'silent-catch-block', snippet), false);
  }
  const final = call();
  assert.equal(final.promoted, true);
  assert.equal(final.count, MAX_INCONCLUSIVE_REVIEW_ATTEMPTS);
  assert.equal(isSuppressed(dir, 'silent-catch-block', snippet), true);
  assert.equal(readRows(dir)[0].cause, 'unproducible');
  // attempt row is cleared once promoted
  assert.equal(readAttemptRows(dir).length, 0);
});

test('recordInconclusiveReview: the promoted suppression survives line drift + reindentation', () => {
  const dir = tmpDir();
  const atFirst = '    try:\n        connect()\n    except Exception:\n        pass';
  const drifted = '\ttry:\n\t\tconnect()\n\texcept Exception:\n\t\tpass';
  const mk = (snip) => ({ id: 't', promptContext: { rule: 'silent-catch-block', file: 'app.py', snippet: snip } });
  for (let i = 0; i < MAX_INCONCLUSIVE_REVIEW_ATTEMPTS; i += 1) {
    recordInconclusiveReview({ applyResult: { skipped: true }, implementResponse: 'GENUINE', task: mk(atFirst), pipelineDir: dir });
  }
  assert.equal(isSuppressed(dir, 'silent-catch-block', drifted), true);
});

test('recordInconclusiveReview ignores a review that wrote a candidate, and one that is an explicit false positive', () => {
  const dir = tmpDir();
  const task = { id: 'x', promptContext: { rule: 'silent-catch-block', file: 'a.py', snippet: 'except: pass' } };

  // candidate written (live apply result)
  assert.equal(recordInconclusiveReview({ applyResult: { file: 'Docs/OBS.md', candidateIds: ['AC-3'] }, implementResponse: '### AC-3 · Log it', task, pipelineDir: dir }), null);
  // candidate written (historical replay: no applyResult, header present in text)
  assert.equal(recordInconclusiveReview({ implementResponse: '### AC-7 · Something\nStrength: Strong', task, pipelineDir: dir }), null);
  // explicit false positive -> recordFalsePositiveIfVerdict's job
  assert.equal(recordInconclusiveReview({ applyResult: { skipped: true }, implementResponse: 'FALSE POSITIVE — the except binds e and returns None per contract', task, pipelineDir: dir }), null);

  assert.equal(readAttemptRows(dir).length, 0);
  assert.equal(fs.existsSync(attemptsPath(dir)), false);
});

test('recordInconclusiveReview is a no-op once the construct is already suppressed', () => {
  const dir = tmpDir();
  const snippet = 'except OSError:\n    pass';
  recordSuppression(dir, { rule: 'silent-catch-block', snippet, cause: 'false-positive' });
  const r = recordInconclusiveReview({ applyResult: { skipped: true }, implementResponse: 'GENUINE', task: { id: 'q', promptContext: { rule: 'silent-catch-block', snippet } }, pipelineDir: dir });
  assert.equal(r.alreadySuppressed, true);
  assert.equal(readAttemptRows(dir).length, 0);
});

test('recordSuppression defaults cause to false-positive; older rows without the field still suppress', () => {
  const dir = tmpDir();
  recordSuppression(dir, { rule: 'r', snippet: 'a b c' });
  assert.equal(readRows(dir)[0].cause, 'false-positive');
  // simulate a pre-existing row with no cause field
  fs.writeFileSync(suppressionsPath(dir), JSON.stringify([{ key: suppressionKey('r2', 'x y z'), rule: 'r2' }]));
  assert.equal(isSuppressed(dir, 'r2', 'x y z'), true);
});

test('classifyReviewOutcome: genuine / dismissed / inconclusive', () => {
  const { classifyReviewOutcome } = require('./suppression-store.js');
  assert.equal(classifyReviewOutcome({ applyResult: { skipped: false }, implementResponse: '### AC-1 ...' }), 'genuine');
  assert.equal(classifyReviewOutcome({ applyResult: null, implementResponse: '### AC-7 · x\nStrength: Strong' }), 'genuine');
  assert.equal(classifyReviewOutcome({ applyResult: { skipped: true }, implementResponse: 'FALSE POSITIVE. The except binds e and returns None by contract.' }), 'dismissed');
  assert.equal(classifyReviewOutcome({ applyResult: { skipped: true }, implementResponse: 'false-positive: deliberate fallback' }), 'dismissed');
  assert.equal(classifyReviewOutcome({ applyResult: { skipped: true }, implementResponse: 'GENUINE but I could not produce a safe candidate.' }), 'inconclusive');
  assert.equal(classifyReviewOutcome({ applyResult: { skipped: true }, implementResponse: '' }), 'inconclusive');
});

test('a duplicateOf skip (candidate-docs dedupe) counts as produced: no inconclusive-review attempt is recorded', () => {
  const dir = tmpDir();
  const task = { id: 'fl-1', promptContext: { rule: 'function-too-long', file: 'src/a.js', snippet: 'function a() {\n  return 1;\n}' } };
  const dup = { skipped: true, duplicateOf: 'AC-51', reason: 'skipped: candidate already exists as AC-51 (master) -- not appended again' };
  for (let i = 0; i < MAX_INCONCLUSIVE_REVIEW_ATTEMPTS + 1; i += 1) {
    assert.equal(recordInconclusiveReview({ applyResult: dup, implementResponse: 'candidate text', task, pipelineDir: dir }), null);
  }
  assert.equal(readAttemptRows(dir).length, 0);
  assert.equal(isSuppressed(dir, 'function-too-long', task.promptContext.snippet), false);
  // a plain skip (no duplicateOf) is still an inconclusive review
  const plain = recordInconclusiveReview({ applyResult: { skipped: true, reason: 'no candidates' }, implementResponse: 'GENUINE but no block', task, pipelineDir: dir });
  assert.equal(plain.count, 1);
});

test('a duplicateOf skip is never recorded as a false-positive dismissal, even if the text says "false positive"', () => {
  const dir = tmpDir();
  const task = { id: 'fl-2', promptContext: { rule: 'function-too-long', file: 'src/a.js', snippet: 'function a() {\n  return 1;\n}' } };
  const out = recordFalsePositiveIfVerdict({
    applyResult: { skipped: true, duplicateOf: 'AC-51', reason: 'skipped: candidate already exists' },
    implementResponse: 'This is not a false positive; the function is genuinely too long.',
    task, pipelineDir: dir,
  });
  assert.equal(out, null);
  assert.equal(readRows(dir).length, 0);
});
