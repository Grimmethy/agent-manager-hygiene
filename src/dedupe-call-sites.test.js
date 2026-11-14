'use strict';
// Guards the finding-driven applyArchDiscoveryCandidates call sites: each must pass `dedupe: true`,
// so a re-drafted or requeued finding (same file + function) is skipped instead of appended again.
// See observability-review.js's apply step (AC-187 vs AC-51) for the reason.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SRC = __dirname;
const NAME = 'applyArchDiscoveryCandidates';
// arch.js is deliberately excluded: hand-authored arch entries must keep appending as before.
const FINDING_DRIVEN = ['observability-review.js', 'performance-review.js', 'function-length-review.js'];

// Return the argument text of every NAME(...) call in `text`, matching parentheses.
function callBodies(text) {
  const out = [];
  let i = 0;
  while ((i = text.indexOf(NAME + '(', i)) !== -1) {
    const open = i + NAME.length;
    let depth = 0;
    let j = open;
    for (; j < text.length; j++) {
      if (text[j] === '(') depth++;
      else if (text[j] === ')') { depth--; if (depth === 0) break; }
    }
    // Strip // comments so a comment mentioning dedupe cannot satisfy the check.
    const body = text.slice(open, j + 1).replace(/\/\/.*$/gm, '');
    out.push({ offset: i, body });
    i = j;
  }
  return out;
}

for (const f of FINDING_DRIVEN) {
  test(`${f}: every ${NAME} call passes dedupe: true`, () => {
    const calls = callBodies(fs.readFileSync(path.join(SRC, f), 'utf8'));
    assert.ok(calls.length > 0, `${f} has no ${NAME} call (test would be vacuous)`);
    for (const c of calls) {
      assert.match(c.body, /\bdedupe:\s*true\b/,
        `${f} offset ${c.offset}: ${NAME} call without dedupe: true`);
    }
  });
}

test('observability-review.js has a dedupe-true call in the per-item digest loop (the line-667 gap)', () => {
  const text = fs.readFileSync(path.join(SRC, 'observability-review.js'), 'utf8');
  const calls = callBodies(text).filter((c) => /snippet:\s*item\.snippet/.test(c.body));
  assert.ok(calls.length >= 1, 'per-item loop call not found');
  for (const c of calls) {
    assert.match(c.body, /\bdedupe:\s*true\b/, 'per-item loop call must pass dedupe: true');
  }
});
