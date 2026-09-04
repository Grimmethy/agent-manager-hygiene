'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { selectLowConfidenceBatch, parseDigestVerdicts } = require('./low-confidence-digest.js');

test('selectLowConfidenceBatch: oldest-file-first, then file, then line; capped', () => {
  const findings = [
    { file: 'b.js', line: 10, scannedAt: '2026-09-02T00:00:00Z' },
    { file: 'a.js', line: 5, scannedAt: '2026-09-01T00:00:00Z' },
    { file: 'a.js', line: 2, scannedAt: '2026-09-01T00:00:00Z' },
    { file: 'c.js', line: 1, scannedAt: '2026-09-03T00:00:00Z' },
  ];
  const out = selectLowConfidenceBatch(findings, 3);
  assert.deepEqual(out.map((f) => `${f.file}:${f.line}`), ['a.js:2', 'a.js:5', 'b.js:10']);
});

test('parseDigestVerdicts: one line per block, GENUINE / FALSE POSITIVE (any punctuation), out-of-range dropped', () => {
  const resp = [
    'preamble to ignore',
    '1. FALSE POSITIVE - the return is the documented fallback',
    '2. GENUINE — partial result returned with no log line',
    '3) false-positive: best-effort cleanup in finally',
    '9. GENUINE - not a real block, out of range',
    'garbage line',
  ].join('\n');
  const m = parseDigestVerdicts(resp, 3);
  assert.equal(m.size, 3);
  assert.equal(m.get(1).verdict, 'false-positive');
  assert.equal(m.get(2).verdict, 'genuine');
  assert.match(m.get(2).reason, /partial result/);
  assert.equal(m.get(3).verdict, 'false-positive');
  assert.equal(m.has(9), false);
});

test('parseDigestVerdicts: a missing block is simply absent (caller leaves it for next cycle)', () => {
  const m = parseDigestVerdicts('1. GENUINE - x\n3. FALSE POSITIVE - y', 3);
  assert.deepEqual([...m.keys()].sort(), [1, 3]);
  assert.equal(m.has(2), false);
});
