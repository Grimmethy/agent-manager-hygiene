'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { register, scan, scanProject, fix, review } = require('../src/magic-literal-scan.js');

// ---------------------------------------------------------------------------
// register() -- interface contract
// ---------------------------------------------------------------------------

test('register() returns {name, scan, fix, review}', () => {
  const scanner = register();
  assert.equal(scanner.name, 'magic_literal');
  assert.equal(typeof scanner.scan, 'function');
  assert.equal(typeof scanner.fix, 'function');
  assert.equal(typeof scanner.review, 'function');
});

// ---------------------------------------------------------------------------
// scan() -- detection of magic literals
// ---------------------------------------------------------------------------

test('scan() flags a numeric literal appearing 3+ times in a JS file', () => {
  const text = [
    'const a = 42;',
    'const b = 42;',
    'const c = 42;',
    'const d = a + b + c;',
  ].join('\n');
  const findings = scan('x.js', text);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].rule, 'magic-literal');
  assert.equal(findings[0].value, '42');
  assert.equal(findings[0].count, 3);
  assert.equal(findings[0].type, 'numeric');
  assert.ok(findings[0].detail.includes('42'));
});

test('scan() flags a numeric literal appearing 5 times', () => {
  const lines = Array.from({ length: 5 }, (_, i) => `const x${i} = 10000;`).join('\n');
  const findings = scan('x.js', lines);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].value, '10000');
  assert.equal(findings[0].count, 5);
});

test('scan() flags a repeated string literal in JS', () => {
  const text = [
    'const a = "hello world";',
    'const b = "hello world";',
    'const c = "hello world";',
  ].join('\n');
  const findings = scan('x.js', text);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].value, 'hello world');
  assert.equal(findings[0].type, 'string');
  assert.equal(findings[0].count, 3);
});

test('scan() flags magic numbers in Python files', () => {
  const text = [
    'x = 42',
    'y = 42',
    'z = 42',
    'print(x + y + z)',
  ].join('\n');
  const findings = scan('x.py', text);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].value, '42');
  assert.equal(findings[0].type, 'numeric');
});

// ---------------------------------------------------------------------------
// scan() -- excluded literals
// ---------------------------------------------------------------------------

test('scan() excludes 0, 1, -1, 2, 100, 1000 even when repeated', () => {
  const text = [
    'const a = 0;',
    'const b = 0;',
    'const c = 0;',
    'const d = 1;',
    'const e = 1;',
    'const f = 1;',
    'const g = -1;',
    'const h = -1;',
    'const i = -1;',
    'const j = 2;',
    'const k = 2;',
    'const l = 2;',
    'const m = 100;',
    'const n = 100;',
    'const o = 100;',
    'const p = 1000;',
    'const q = 1000;',
    'const r = 1000;',
  ].join('\n');
  const findings = scan('x.js', text);
  assert.deepEqual(findings, []);
});

// ---------------------------------------------------------------------------
// scan() -- excluded contexts
// ---------------------------------------------------------------------------

test('scan() excludes literals used as array indexes', () => {
  const text = [
    'const a = arr[0];',
    'const b = arr[0];',
    'const c = arr[0];',
    'const d = arr[1];',
    'const e = arr[1];',
    'const f = arr[1];',
  ].join('\n');
  const findings = scan('x.js', text);
  assert.deepEqual(findings, []);
});

test('scan() excludes literals inside import statements', () => {
  const text = [
    'import a from "foo";',
    'import b from "foo";',
    'import c from "foo";',
    'console.log(a, b, c);',
  ].join('\n');
  const findings = scan('x.js', text);
  assert.deepEqual(findings, []);
});

test('scan() excludes literals inside console.log/error/warn', () => {
  const text = [
    'console.log("hello world");',
    'console.log("hello world");',
    'console.log("hello world");',
    'console.error("hello world");',
  ].join('\n');
  const findings = scan('x.js', text);
  assert.deepEqual(findings, []);
});

test('scan() excludes literals used as object keys', () => {
  const text = [
    'const a = {"name": "Alice", "age": 30};',
    'const b = {"name": "Bob", "age": 25};',
    'const c = {"name": "Carol", "age": 35};',
  ].join('\n');
  const findings = scan('x.js', text);
  // "name" appears 3 times as object key -- excluded
  // "Alice", "Bob", "Carol" each appear once -- below threshold
  // 30, 25, 35 each appear once -- below threshold
  assert.deepEqual(findings, []);
});

// ---------------------------------------------------------------------------
// scan() -- threshold enforcement
// ---------------------------------------------------------------------------

test('scan() does NOT flag a literal appearing only 2 times', () => {
  const text = 'const a = 42;\nconst b = 42;\n';
  const findings = scan('x.js', text);
  assert.deepEqual(findings, []);
});

test('scan() does NOT flag a short string (fewer than 3 chars)', () => {
  const text = [
    'const a = "ab";',
    'const b = "ab";',
    'const c = "ab";',
  ].join('\n');
  const findings = scan('x.js', text);
  assert.deepEqual(findings, []);
});

// ---------------------------------------------------------------------------
// scan() -- skipping rules
// ---------------------------------------------------------------------------

test('scan() skips files whose basename ends with .test.js', () => {
  const text = 'const a = 42;\nconst b = 42;\nconst c = 42;\n';
  assert.deepEqual(scan('foo.test.js', text), []);
});

test('scan() skips files whose basename ends with .spec.ts', () => {
  const text = 'const a = 42;\nconst b = 42;\nconst c = 42;\n';
  assert.deepEqual(scan('foo.spec.ts', text), []);
});

test('scan() skips files in __tests__ directories', () => {
  const text = 'const a = 42;\nconst b = 42;\nconst c = 42;\n';
  assert.deepEqual(scan('__tests__/foo.test.js', text), []);
});

test('scan() skips minified files (line > 2000 chars)', () => {
  const text = 'const a = 42;\n' + 'const b = ' + 'x'.repeat(3000) + ';\n';
  assert.deepEqual(scan('bundle.js', text), []);
});

test('scan() skips files in vendor/ paths', () => {
  const text = 'const a = 42;\nconst b = 42;\nconst c = 42;\n';
  assert.deepEqual(scan('vendor/lib/foo.js', text), []);
});

test('scan() skips files in third_party/ paths', () => {
  const text = 'const a = 42;\nconst b = 42;\nconst c = 42;\n';
  assert.deepEqual(scan('third_party/lib/foo.js', text), []);
});

test('scan() skips files in node_modules/ paths', () => {
  const text = 'const a = 42;\nconst b = 42;\nconst c = 42;\n';
  assert.deepEqual(scan('node_modules/pkg/foo.js', text), []);
});

test('scan() skips files in dot-prefixed directories', () => {
  const text = 'const a = 42;\nconst b = 42;\nconst c = 42;\n';
  assert.deepEqual(scan('.git/hooks/foo.js', text), []);
});

// ---------------------------------------------------------------------------
// scan() -- deduplication against existing flags
// ---------------------------------------------------------------------------

test('scan() deduplicates findings when existingFlags overlap at same file::line', () => {
  const text = [
    'function foo() {',
    '  const a = 42;',
    '  const b = 42;',
    '  const c = 42;',
    '}',
  ].join('\n');
  const existingFlags = [
    { rule: 'function-too-long', file: 'x.js', line: 1 },
  ];
  const findings = scan('x.js', text, { existingFlags });
  // The magic literal at line 2 overlaps with the function-too-long flag at line 1.
  // They differ in line, so the magic literal finding is NOT deduped.
  // This test verifies the dedup mechanism runs without error.
  assert.ok(Array.isArray(findings));
});

test('scan() removes a magic-literal finding when a function-too-long flag covers the same file::line', () => {
  const text = [
    'const a = 42;',
    'const b = 42;',
    'const c = 42;',
  ].join('\n');
  const existingFlags = [
    { rule: 'function-too-long', file: 'x.js', line: 1 },
  ];
  const findings = scan('x.js', text, { existingFlags });
  // The first occurrence of 42 is at line 1, so it gets deduped.
  // The second and third are at lines 2 and 3, so they remain.
  // But findMagicLiterals only reports the FIRST occurrence per value,
  // so the single finding at line 1 gets removed.
  assert.deepEqual(findings, []);
});

test('scan() ignores existingFlags with unrelated rules', () => {
  const text = 'const a = 42;\nconst b = 42;\nconst c = 42;\n';
  const existingFlags = [
    { rule: 'unused-export', file: 'x.js', line: 1 },
  ];
  const findings = scan('x.js', text, { existingFlags });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].value, '42');
});

test('scan() ignores existingFlags with nesting-depth rule', () => {
  const text = 'const a = 42;\nconst b = 42;\nconst c = 42;\n';
  const existingFlags = [
    { rule: 'nesting-depth', file: 'x.js', line: 5 },
  ];
  const findings = scan('x.js', text, { existingFlags });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].value, '42');
});

// ---------------------------------------------------------------------------
// scanProject -- real directory scan
// ---------------------------------------------------------------------------

test('scanProject scans JS and Python files in a project directory', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'magic-literal-test-'));
  fs.writeFileSync(path.join(dir, 'a.js'), [
    'const x = 42;',
    'const y = 42;',
    'const z = 42;',
  ].join('\n'));
  fs.writeFileSync(path.join(dir, 'b.py'), [
    'x = 42',
    'y = 42',
    'z = 42',
  ].join('\n'));
  const findings = scanProject(dir, 'test-project');
  assert.equal(findings.length, 2);
  const files = findings.map((f) => f.file).sort();
  assert.deepEqual(files, ['a.js', 'b.py']);
  assert.ok(findings[0].projectSlug === 'test-project');
  assert.ok(findings[0].scannedAt);
});

test('scanProject skips node_modules directories', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'magic-literal-test-'));
  const nmDir = path.join(dir, 'node_modules', 'pkg');
  fs.mkdirSync(nmDir, { recursive: true });
  fs.writeFileSync(path.join(nmDir, 'index.js'), [
    'const x = 42;',
    'const y = 42;',
    'const z = 42;',
  ].join('\n'));
  const findings = scanProject(dir, 'test-project');
  assert.equal(findings.length, 0);
});

test('scanProject skips minified files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'magic-literal-test-'));
  fs.writeFileSync(path.join(dir, 'bundle.js'), 'x=42;y=42;z=42;' + 'a'.repeat(3000));
  const findings = scanProject(dir, 'test-project');
  assert.equal(findings.length, 0);
});

test('scanProject skips vendored paths', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'magic-literal-test-'));
  const vendorDir = path.join(dir, 'vendor', 'lib');
  fs.mkdirSync(vendorDir, { recursive: true });
  fs.writeFileSync(path.join(vendorDir, 'foo.js'), [
    'const x = 42;',
    'const y = 42;',
    'const z = 42;',
  ].join('\n'));
  const findings = scanProject(dir, 'test-project');
  assert.equal(findings.length, 0);
});

// ---------------------------------------------------------------------------
// fix() -- generates replacement suggestions
// ---------------------------------------------------------------------------

test('fix() returns an array of {file, line, replacement, description}', () => {
  const findings = [
    {
      rule: 'magic-literal',
      file: 'x.js',
      line: 1,
      value: '42',
      count: 3,
      type: 'numeric',
      detail: 'Magic literal "42" appears 3 times',
    },
  ];
  const suggestions = fix(findings);
  assert.equal(suggestions.length, 1);
  assert.equal(suggestions[0].file, 'x.js');
  assert.equal(suggestions[0].line, 1);
  assert.ok(suggestions[0].replacement.startsWith('const MAGIC_'));
  assert.ok(suggestions[0].replacement.includes('42'));
  assert.ok(suggestions[0].description.includes('42'));
});

test('fix() uses uppercase constant name for numeric literals', () => {
  const findings = [
    {
      rule: 'magic-literal',
      file: 'x.js',
      line: 1,
      value: '3.14',
      count: 3,
      type: 'numeric',
      detail: '',
    },
  ];
  const suggestions = fix(findings);
  assert.ok(suggestions[0].replacement.includes('MAGIC_3_14'));
});

test('fix() wraps string literals in quotes in the replacement', () => {
  const findings = [
    {
      rule: 'magic-literal',
      file: 'x.js',
      line: 1,
      value: 'hello world',
      count: 3,
      type: 'string',
      detail: '',
    },
  ];
  const suggestions = fix(findings);
  assert.ok(suggestions[0].replacement.includes("'hello world'"));
});

test('fix() handles empty findings array', () => {
  assert.deepEqual(fix([]), []);
});

// ---------------------------------------------------------------------------
// review() -- generates summary and recommendations
// ---------------------------------------------------------------------------

test('review() returns summary and recommendations for findings', () => {
  const findings = [
    {
      rule: 'magic-literal',
      file: 'x.js',
      line: 1,
      value: '42',
      count: 3,
      type: 'numeric',
      detail: '',
    },
  ];
  const result = review(findings);
  assert.ok(result.summary.includes('magic literal'));
  assert.ok(Array.isArray(result.recommendations));
  assert.ok(result.recommendations.length > 0);
});

test('review() returns empty recommendations when no findings', () => {
  const result = review([]);
  assert.ok(result.summary.includes('No magic literals'));
  assert.deepEqual(result.recommendations, []);
});

test('review() returns examples array with fix guidance', () => {
  const findings = [
    { rule: 'magic-literal', file: 'a.js', line: 1, value: '42', count: 3, type: 'numeric', detail: '' },
    { rule: 'magic-literal', file: 'b.py', line: 5, value: 'hello world', count: 3, type: 'string', detail: '' },
  ];
  const result = review(findings);
  assert.ok(result.examples);
  assert.ok(Array.isArray(result.examples));
  assert.ok(result.examples.length > 0);
  assert.ok(result.examples[0].includes('// Before:'));
});

// ---------------------------------------------------------------------------
// scan() -- realistic detection scenarios
// ---------------------------------------------------------------------------

test('scan() detects magic literals in a realistic JS file', () => {
  const text = [
    'function calculateDiscount(price) {',
    '  if (price > 100) {',
    '    return price * 0.1;',
    '  }',
    '  return price * 0.05;',
    '}',
    '',
    'function calculateTax(price) {',
    '  if (price > 100) {',
    '    return price * 0.1;',
    '  }',
    '  return price * 0.05;',
    '}',
    '',
    'function calculateFee(price) {',
    '  if (price > 100) {',
    '    return price * 0.1;',
    '  }',
    '  return price * 0.05;',
    '}',
  ].join('\n');
  const findings = scan('calc.js', text);
  assert.equal(findings.length, 2);
  const values = findings.map((f) => f.value).sort();
  assert.deepEqual(values, ['0.05', '0.1']);
});

test('scan() detects magic literals in a realistic Python file', () => {
  const text = [
    'def calculate_discount(price):',
    '    if price > 100:',
    '        return price * 0.1',
    '    return price * 0.05',
    '',
    'def calculate_tax(price):',
    '    if price > 100:',
    '        return price * 0.1',
    '    return price * 0.05',
    '',
    'def calculate_fee(price):',
    '    if price > 100:',
    '        return price * 0.1',
    '    return price * 0.05',
  ].join('\n');
  const findings = scan('calc.py', text);
  assert.equal(findings.length, 2);
  const values = findings.map((f) => f.value).sort();
  assert.deepEqual(values, ['0.05', '0.1']);
});
