'use strict';

// Unit tests for change-review-quote-check.js. Incident (2026-09-19, PropertyForager): a Strong, high-severity finding
// quoted `loadBox(mode.box, mode.scope, 1)` as existing code; the file had no such line (it was onPage's
// `loadBox(mode.box, mode.scope, p)`). A quote in an existing-code position is checkable by substring.

const test = require('node:test');
const assert = require('node:assert/strict');
const { extractExistingCodeQuotes, verifyQuotedCode, describeUnverified, looksLikeCode, postChangeLines } = require('./change-review-quote-check.js');

const FILE = [
  'const onPage = (p) => {',
  "  case 'box': loadBox(mode.box, mode.scope, p); break;",
  '};',
  'const onScopeChange = (next) => {',
  "  case 'box': loadBox(mode.box, next, 1); break;",
  '};',
].join('\n');

test('extractExistingCodeQuotes: only the span after an existing-code verb, never the replacement after "with"', () => {
  const fix = "In the `case 'box'` branch of `onScopeChange`, replace `loadBox(mode.box, mode.scope, 1)` with `loadBox(mode.box, next, 1)`.";
  assert.deepEqual(extractExistingCodeQuotes(fix), ['loadBox(mode.box, mode.scope, 1)']);
});

test('extractExistingCodeQuotes: ignores short spans, identifiers, placeholders and spans not after a verb', () => {
  assert.deepEqual(extractExistingCodeQuotes('change `<` to `<=` on line 12'), []);
  assert.deepEqual(extractExistingCodeQuotes('replace `next` with `mode.scope`'), []);
  assert.deepEqual(extractExistingCodeQuotes('replace `foo(<args>, bar)` with x'), [], 'a <type> hole is a placeholder');
  assert.deepEqual(extractExistingCodeQuotes('replace `doThing(a, ...rest)` with x'), [], 'an elision is a placeholder');
  assert.deepEqual(extractExistingCodeQuotes('The call `loadBox(mode.box, mode.scope, 1)` is wrong'), [], 'no verb -> not claimed as a find target');
  assert.deepEqual(extractExistingCodeQuotes('remove `loadBox(a, b, 1)` and delete `loadBox(a, b, 1)`'), ['loadBox(a, b, 1)'], 'de-duplicated');
});

test('looksLikeCode: calls, member access and operators yes; bare words and short spans no', () => {
  for (const q of ['loadBox(mode.box, next, 1)', 'const x = foo.bar', 'items.map(x => x.id)']) assert.equal(looksLikeCode(q), true, q);
  for (const q of ['next', 'onScopeChange', '<', 'a.b', 'a => a.b.c']) assert.equal(looksLikeCode(q), false, q); // the last is under the 12-char minimum
});

test('verifyQuotedCode: a quote missing from the file is unverified, and the closest real line is reported', () => {
  const v = verifyQuotedCode({ fix: 'replace `loadBox(mode.box, mode.scope, 1)` with `loadBox(mode.box, next, 1)`', regression: '' }, { fileText: FILE });
  assert.equal(v.skipped, false);
  assert.equal(v.unverified.length, 1);
  assert.equal(v.unverified[0].quote, 'loadBox(mode.box, mode.scope, 1)');
  assert.match(v.unverified[0].closest, /loadBox\(mode\.box, mode\.scope, p\)/, 'points at the onPage line the model confused');
  assert.match(describeUnverified(v.unverified, { file: 'src/A.tsx', sha: 'abc1234' }), /does not appear verbatim in src\/A\.tsx @ abc1234; closest real line: `case 'box': loadBox\(mode\.box, mode\.scope, p\)/);
});

test('verifyQuotedCode: a quote that IS in the file passes; whitespace differences are normalized', () => {
  assert.equal(verifyQuotedCode({ fix: 'replace `loadBox(mode.box,   next,\n 1)` with y', regression: '' }, { fileText: FILE }).unverified.length, 0);
  assert.equal(verifyQuotedCode({ fix: 'replace `loadBox(mode.box, mode.scope, p)` with y', regression: '' }, { fileText: FILE }).unverified.length, 0);
});

test('verifyQuotedCode: Regression text is NEVER checked (it describes what the diff changed, so the old code is meant to be absent)', () => {
  const v = verifyQuotedCode({ fix: 'restore the old behaviour', regression: 'the diff changes `oldCall(a, b, c)` to `newCall(a, b, c)` and replaces `oldCall(a, b, c)` with it' }, { fileText: FILE });
  assert.deepEqual([v.skipped, v.unverified.length], [true, 0]);
});

test('verifyQuotedCode: fails OPEN when there is no corpus or nothing checkable is quoted', () => {
  const none = verifyQuotedCode({ fix: 'replace `loadBox(a, b, 1)` with y' }, { fileText: '', unitDiff: '' });
  assert.deepEqual([none.skipped, none.unverified.length], [true, 0], 'no file and no diff -> not checked');
  assert.equal(verifyQuotedCode({ fix: 'restore the old behaviour' }, { fileText: FILE }).skipped, true, 'nothing quoted -> nothing to check');
});

test('verifyQuotedCode: falls back to the diff\'s post-change lines when the file is unreadable; removed lines do not count', () => {
  const diff = ['diff --git a/x.js b/x.js', '--- a/x.js', '+++ b/x.js', '@@ -1,2 +1,2 @@', '-removedCall(alpha, beta)', '+addedCall(alpha, beta)', ' contextCall(gamma, delta)'].join('\n');
  assert.match(postChangeLines(diff), /addedCall\(alpha, beta\)/);
  assert.doesNotMatch(postChangeLines(diff), /removedCall/);
  assert.equal(verifyQuotedCode({ fix: 'replace `addedCall(alpha, beta)` with y', regression: '' }, { unitDiff: diff }).unverified.length, 0);
  assert.equal(verifyQuotedCode({ fix: 'replace `removedCall(alpha, beta)` with y', regression: '' }, { unitDiff: diff }).unverified.length, 1, 'code the diff removed is NOT "existing code"');
});
