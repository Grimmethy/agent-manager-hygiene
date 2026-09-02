'use strict';

// Unit tests for scan-utils.js -- the shared toolkit observability-scan.js,
// performance-scan.js, and function-length-scan.js all depend on. extractBraceBody's
// tests moved here verbatim from observability-scan.test.js (2026-08-23) when the shared
// functions were extracted out of that file; the rest are new, direct coverage the
// individual scanners never had before (each only ever exercised these indirectly).

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { extractBraceBody, extractIndentedBlock, leadingWhitespace, listSourceFiles, isLikelyMinified, lineOfIndex } = require('./scan-utils.js');

test('extractBraceBody returns the body between matching braces', () => {
  const text = 'function f() { return 1; }';
  const body = extractBraceBody(text, text.indexOf('{'));
  assert.equal(body, ' return 1; ');
});

test('extractBraceBody ignores braces inside string and comment content', () => {
  const text = 'function f() { const s = "{ not a brace }"; /* { also not } */ return 1; }';
  const body = extractBraceBody(text, text.indexOf('{'));
  assert.equal(body.trim().startsWith('const s ='), true);
  assert.equal(body.includes('return 1;'), true);
});

test('extractBraceBody returns null for an unbalanced (truncated) body', () => {
  const text = 'function f() { return 1;';
  assert.equal(extractBraceBody(text, text.indexOf('{')), null);
});

test('extractIndentedBlock returns the header + indented body, trimming trailing blanks', () => {
  const text = [
    'def f(a):',        // 0
    '    x = 1',         // 1
    '    if x:',         // 2
    '        y = 2',     // 3
    '',                  // 4  blank inside block
    '    return x',      // 5
    '',                  // 6  trailing blank -- trimmed
    'def g():',          // 7  dedent -- stops the block
    '    pass',
  ].join('\n');
  const block = extractIndentedBlock(text, text.indexOf('def f'));
  assert.equal(block.lineCount, 6);
  assert.equal(block.body, 'def f(a):\n    x = 1\n    if x:\n        y = 2\n\n    return x');
  assert.equal(block.body.includes('def g'), false);
  assert.equal(text.slice(block.endIndex).trimStart().startsWith('def g'), true);
});

test('extractIndentedBlock follows a multi-line (parenthesised) header to the line ending with ":"', () => {
  const text = 'def wrapper(a,\n            b):\n    return a\n\nx = 1\n';
  const block = extractIndentedBlock(text, 0);
  assert.equal(block.lineCount, 3); // 2 header lines + 1 body line
  assert.equal(block.body, 'def wrapper(a,\n            b):\n    return a');
});

test('extractIndentedBlock returns null when no header terminator (":") is found', () => {
  assert.equal(extractIndentedBlock('def f(): return 1\nx = 2\n', 0), null);
});

test('extractIndentedBlock stops at a same-indent sibling, not a deeper nested block', () => {
  const text = [
    'for item in items:',
    '    handle(item)',
    '    for sub in item:',
    '        deeper(sub)',
    'after = 1',
  ].join('\n');
  const block = extractIndentedBlock(text, 0);
  assert.equal(block.lineCount, 4); // header + 3 nested lines, stops before `after`
  assert.equal(block.body.includes('deeper(sub)'), true);
  assert.equal(block.body.includes('after = 1'), false);
});

test('leadingWhitespace returns the exact leading run of spaces/tabs', () => {
  assert.equal(leadingWhitespace('    x'), '    ');
  assert.equal(leadingWhitespace('\t\tx'), '\t\t');
  assert.equal(leadingWhitespace('x'), '');
});

test('lineOfIndex counts real newlines up to the given index, 1-indexed', () => {
  const text = 'a\nb\nc\nd';
  assert.equal(lineOfIndex(text, 0), 1);
  assert.equal(lineOfIndex(text, 2), 2);
  assert.equal(lineOfIndex(text, text.indexOf('d')), 4);
});

test('isLikelyMinified flags a file with one absurdly long line', () => {
  assert.equal(isLikelyMinified(`function x(){${'a'.repeat(3000)}}`), true);
});

test('isLikelyMinified does not flag normal, multi-line source', () => {
  assert.equal(isLikelyMinified('function x() {\n  return 1;\n}\n'), false);
});

test('listSourceFiles walks nested directories, skips dot-dirs and known build/tooling dirs', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-utils-test-'));
  fs.mkdirSync(path.join(dir, 'src', 'nested'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'node_modules'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'vendor', 'tokenfold'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'a.js'), 'a');
  fs.writeFileSync(path.join(dir, 'src', 'nested', 'b.js'), 'b');
  fs.writeFileSync(path.join(dir, 'src', 'c.md'), 'not scanned -- wrong extension');
  fs.writeFileSync(path.join(dir, 'node_modules', 'skip.js'), 'skip');
  fs.writeFileSync(path.join(dir, '.git', 'skip.js'), 'skip');
  fs.writeFileSync(path.join(dir, 'vendor', 'tokenfold', 'skip.js'), 'vendored -- not our code');

  const files = listSourceFiles(dir, ['.js']).map((f) => path.relative(dir, f)).sort();
  assert.deepEqual(files, [path.join('src', 'a.js'), path.join('src', 'nested', 'b.js')]);
});

test('listSourceFiles returns an empty array (not a throw) for a directory that does not exist', () => {
  assert.deepEqual(listSourceFiles('/definitely/not/a/real/path', ['.js']), []);
});

// --- stripNonCode / isTestFile / windowFromContent (2026-08-30) -------------------------
const { stripNonCode, isTestFile, windowFromContent } = require('./scan-utils.js');

test('stripNonCode preserves length and line count', () => {
  const src = "const a = 'for (x) {';\n// await here\nconst b = `tpl\nspanning`;\n/* block\ncomment */\ncode();\n";
  const out = stripNonCode(src);
  assert.equal(out.length, src.length);
  assert.equal(out.split('\n').length, src.split('\n').length);
});

test('stripNonCode blanks string interiors and comment bodies, keeps delimiters and newlines', () => {
  const s = "x('for (i) { await y }')";                 // 19-char interior
  assert.equal(stripNonCode(s), "x('" + ' '.repeat(19) + "')");
  assert.equal(stripNonCode(s).length, s.length);
  const lc = stripNonCode('a; // for (i) { await }\nb;');
  assert.equal(lc.length, 'a; // for (i) { await }\nb;'.length);
  assert.match(lc, /^a; +\nb;$/);
  assert.ok(!/for|await/.test(lc));
  const blk = 'a /* await\nfetch */ b';
  const stripped = stripNonCode(blk);
  assert.equal(stripped.length, blk.length);
  assert.equal(stripped.split('\n').length, 2);
  assert.ok(!/await|fetch/.test(stripped), 'comment tokens are blanked');
  assert.match(stripped, /^a +\n + b$/);
});

test('stripNonCode keeps a real loop header + real await intact', () => {
  const src = 'for (const x of xs) {\n  await fetch(x);\n}';
  assert.equal(stripNonCode(src), src);
});

test('isTestFile matches JS test/fixture paths and pytest names, not plain source', () => {
  for (const p of ['src/foo.test.js', 'src/foo.spec.ts', 'src/__tests__/x.js', 'test/fixtures/seed.js', 'tests/util.js', 'pkg/test_thing.py', 'pkg/thing_test.py', 'conftest.py']) {
    assert.equal(isTestFile(p), true, p);
  }
  for (const p of ['src/foo.js', 'src/performance-scan.js', 'lib/test-helpers.js', 'src/latest.js']) {
    assert.equal(isTestFile(p), false, p);
  }
});

test('windowFromContent slices a stable window around the finding line across a line shift', () => {
  const body = 'A\nB\nfor (x) {}\nD\nE';
  const shifted = '// pad\n// pad\n' + body;           // same construct, moved down 2 lines
  const w = windowFromContent(body, 3, 2, 1);          // line 3 is `for (x) {}`
  assert.equal(w, windowFromContent(shifted, 5, 2, 1), 'window text is identical after the shift');
  assert.match(w, /for \(x\) \{\}/);
});

test('stripNonCode: a regex literal (even one containing a quote) does not derail the scan', () => {
  // Real bug (2026-08-30): `re: /\"@opentelemetry\//` in observability-scan.js sent the
  // old stripper into a never-closing false string, blanking every real loop after it.
  const src = [
    "const checks = [",
    "  { file: 'package.json', re: /\\\"@opentelemetry\\// },",
    "];",
    "for (const file of files) {",
    "  fs.readFileSync(file);",
    "}",
  ].join('\n');
  const s = stripNonCode(src);
  assert.equal(s.length, src.length);
  assert.ok(s.includes('for (const file of files) {'), 'the real loop after a regex literal survives');
  assert.ok(s.includes('fs.readFileSync(file)'), 'the real loop body survives');
  assert.ok(!s.includes('@opentelemetry'), 'the regex interior is blanked');
});

test('stripNonCode: `return /re/.test(x)` keeps the divide-vs-regex call sane (regex after a keyword)', () => {
  const s = stripNonCode('function f(x) { return /ab["c]/.test(x); }');
  assert.equal(s.length, 'function f(x) { return /ab["c]/.test(x); }'.length);
  assert.ok(s.includes('return /'), 'keyword-preceded regex is recognized');
  assert.ok(s.includes('.test(x)'));
  assert.ok(!s.includes('ab'), 'regex interior blanked, so a stray quote inside it is inert');
});

test('stripNonCode: real division is left alone', () => {
  const s = stripNonCode('const rate = total / count;\nfor (const x of xs) { await y(x); }');
  assert.ok(s.includes('total / count'), 'a / after an identifier stays as division');
  assert.ok(s.includes('for (const x of xs) { await y(x); }'), 'the following real loop is untouched');
});
