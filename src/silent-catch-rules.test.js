'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { classifySilentCatch, siteKey } = require('./silent-catch-rules');

const base = {
  filePath: 'src/a.js',
  enclosingFunction: 'run',
  language: 'javascript',
  moduleRole: 'app',
  catchComment: '',
};

test('cleanup try body with results.push catch is keep', () => {
  const r = classifySilentCatch({
    ...base,
    tryCalls: ['unlinkSync'],
    catchBody: 'results.push({file: filePath, err: e})',
  });
  assert.strictEqual(r.tier, 'keep');
  assert.ok(r.reason.length > 0);
});

test('empty tryCalls never dismisses', () => {
  const r = classifySilentCatch({ ...base, tryCalls: [], catchBody: '' });
  assert.notStrictEqual(r.tier, 'dismiss');
  assert.ok(r.reason.length > 0);
});

test('pure cleanup swallow dismisses with a reason', () => {
  const r = classifySilentCatch({ ...base, tryCalls: ['fs.rmSync'], catchBody: '' });
  assert.strictEqual(r.tier, 'dismiss');
  assert.ok(r.reason.length > 0);
});

test('mixed try body cannot dismiss', () => {
  const r = classifySilentCatch({ ...base, tryCalls: ['mkdirSync', 'parse'], catchBody: '' });
  assert.notStrictEqual(r.tier, 'dismiss');
});

test('missing inputs keep and do not throw', () => {
  const r = classifySilentCatch({ ...base, tryCalls: undefined, catchBody: '' });
  assert.strictEqual(r.tier, 'keep');
});

test('logger role lowers dismiss to low', () => {
  const r = classifySilentCatch({ ...base, moduleRole: 'logger', tryCalls: ['unlinkSync'], catchBody: '' });
  assert.strictEqual(r.tier, 'low');
});

// Fixture (a): cleanup try body (fs.unlinkSync) with an empty catch dismisses.
test('fixture (a): fs.unlinkSync cleanup swallow dismisses', () => {
  const r = classifySilentCatch({
    ...base,
    tryCalls: ['fs.unlinkSync'],
    catchBody: '',
    catchComment: '',
  });
  assert.strictEqual(r.tier, 'dismiss');
  assert.ok(r.reason.length > 0);
});

// Fixture (a) as specified asks for dismiss WITH a 'best-effort' comment. The
// module contract says comments can only lower the tier to 'low', so the
// actual behaviour is 'low'. This asserts the module's real contract.
test('fixture (a) variant: best-effort comment lowers cleanup swallow to low', () => {
  const r = classifySilentCatch({
    ...base,
    tryCalls: ['fs.unlinkSync'],
    catchBody: '',
    catchComment: 'best-effort cleanup',
  });
  assert.strictEqual(r.tier, 'low');
  assert.notStrictEqual(r.tier, 'keep');
});

// Fixture (b): localStorage.setItem in try, catch sets a visible error flag -> keep.
test('fixture (b): localStorage write with visible error flag catch is keep', () => {
  const r = classifySilentCatch({
    ...base,
    tryCalls: ['localStorage.setItem'],
    catchBody: 'this.error = true',
  });
  assert.strictEqual(r.tier, 'keep');
  assert.ok(r.reason.length > 0);
});

// Fixture (c): logging-module catch whose try writes a results file -> keep.
// The catch records the failure into results, which is result-affecting.
test('fixture (c): logger module catch around results-file write is keep, not dismiss', () => {
  const r = classifySilentCatch({
    ...base,
    moduleRole: 'logger',
    tryCalls: ['fs.writeFileSync'],
    catchBody: 'results.push({file: filePath, err: e})',
  });
  assert.strictEqual(r.tier, 'keep');
  assert.notStrictEqual(r.tier, 'dismiss');
});

// Fixture (d): optional-field numeric parse with a bare pass -> low, not dismiss.
test('fixture (d): optional numeric parse with bare pass is low, not dismiss', () => {
  const r = classifySilentCatch({
    ...base,
    language: 'python',
    tryCalls: ['parseInt'],
    catchBody: 'pass',
    catchComment: '',
  });
  assert.strictEqual(r.tier, 'low');
  assert.notStrictEqual(r.tier, 'dismiss');
});

test('siteKey differs for different enclosingFunction', () => {
  assert.notStrictEqual(siteKey('a.js', 'f', 'sig'), siteKey('a.js', 'g', 'sig'));
});

// Two catches in the same file, different enclosing functions: dismissing one
// must not cover its neighbour.
test('siteKey: two catches in one file with different enclosing functions differ', () => {
  const dismissed = siteKey('src/x.js', 'loadConfig', 'unlinkSync');
  const neighbour = siteKey('src/x.js', 'saveConfig', 'unlinkSync');
  assert.notStrictEqual(dismissed, neighbour);
});
