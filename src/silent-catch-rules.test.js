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

test('siteKey differs for different enclosingFunction', () => {
  assert.notStrictEqual(siteKey('a.js', 'f', 'sig'), siteKey('a.js', 'g', 'sig'));
});
