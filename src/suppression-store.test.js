'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  normalizeSnippet, suppressionKey, isSuppressed, recordSuppression, recordFalsePositiveIfVerdict, readRows, suppressionsPath,
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
