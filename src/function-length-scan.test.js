'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { scanProject, findLongFunctions, findLongPythonFunctions, countLines, maxFunctionLines, DEFAULT_MAX_FUNCTION_LINES } = require('./function-length-scan.js');

function makeBody(lines) {
  return Array.from({ length: lines }, (_, i) => `  const x${i} = ${i};`).join('\n');
}

test('countLines counts real newlines, not statements', () => {
  assert.equal(countLines(''), 0);
  assert.equal(countLines('a'), 1);
  assert.equal(countLines('a\nb\nc'), 3);
});

test('maxFunctionLines falls back to DEFAULT_MAX_FUNCTION_LINES when the env override is unset/invalid', () => {
  const prev = process.env.AGENT_MANAGER_MAX_FUNCTION_LINES;
  delete process.env.AGENT_MANAGER_MAX_FUNCTION_LINES;
  assert.equal(maxFunctionLines(), DEFAULT_MAX_FUNCTION_LINES);
  process.env.AGENT_MANAGER_MAX_FUNCTION_LINES = 'not-a-number';
  assert.equal(maxFunctionLines(), DEFAULT_MAX_FUNCTION_LINES);
  process.env.AGENT_MANAGER_MAX_FUNCTION_LINES = '40';
  assert.equal(maxFunctionLines(), 40);
  if (prev == null) delete process.env.AGENT_MANAGER_MAX_FUNCTION_LINES;
  else process.env.AGENT_MANAGER_MAX_FUNCTION_LINES = prev;
});

test('findLongFunctions flags a named function declaration over the threshold', () => {
  const text = `function tooLong() {\n${makeBody(12)}\n}\n`;
  const findings = findLongFunctions(text, 'x.js', 10);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].rule, 'function-too-long');
  assert.equal(findings[0].file, 'x.js');
  assert.match(findings[0].detail, /function "tooLong"/);
});

test('findLongFunctions flags an arrow-function assignment and a function-expression assignment, with real names', () => {
  const text = [
    `const arrowLong = (a, b) => {`,
    makeBody(12),
    `};`,
    ``,
    `const exprLong = function (a) {`,
    makeBody(12),
    `};`,
  ].join('\n');
  const findings = findLongFunctions(text, 'x.js', 10);
  assert.equal(findings.length, 2);
  const names = findings.map((f) => f.detail);
  assert.ok(names.some((d) => d.includes('"arrowLong"')));
  assert.ok(names.some((d) => d.includes('"exprLong"')));
});

test('findLongFunctions does NOT flag a short function', () => {
  const text = `function short() {\n${makeBody(3)}\n}\n`;
  assert.deepEqual(findLongFunctions(text, 'x.js', 10), []);
});

test('findLongFunctions never double-counts the same function across overlapping pattern matches', () => {
  // An async arrow function assignment could plausibly be matched by more than one
  // pattern if they weren't kept narrow -- this proves the seenBraceIndex dedup holds.
  const text = `const longAsync = async (a) => {\n${makeBody(12)}\n};\n`;
  const findings = findLongFunctions(text, 'x.js', 10);
  assert.equal(findings.length, 1);
});

function pyBody(lines, indent = '    ') {
  return Array.from({ length: lines }, (_, i) => `${indent}x${i} = ${i}`).join('\n');
}

test('findLongPythonFunctions flags an over-threshold def (and reports its name and line span)', () => {
  const text = `import os\n\ndef bloated(a, b):\n${pyBody(12)}\n    return a\n`;
  const findings = findLongPythonFunctions(text, 'x.py', 10);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].rule, 'function-too-long');
  assert.equal(findings[0].file, 'x.py');
  assert.equal(findings[0].line, 3);
  assert.match(findings[0].detail, /function "bloated" is 14 lines long/);
});

test('findLongPythonFunctions handles a multi-line def header and stops the block at the next dedent', () => {
  const text = [
    'def wrapper(a,',
    '            b,',
    '            c):',
    pyBody(12),
    '    return a',
    '',
    'def next_fn():',       // must NOT be counted toward wrapper
    '    return 1',
  ].join('\n');
  const findings = findLongPythonFunctions(text, 'x.py', 10);
  assert.equal(findings.length, 1);
  assert.match(findings[0].detail, /function "wrapper"/);
  // 3 header lines + 12 body + 1 return = 16, trailing blank + next def excluded
  assert.match(findings[0].detail, /is 16 lines long/);
});

test('findLongPythonFunctions does NOT flag a short def or a one-liner', () => {
  assert.deepEqual(findLongPythonFunctions('def short():\n    return 1\n', 'x.py', 10), []);
  assert.deepEqual(findLongPythonFunctions('def oneliner(): return 1\n', 'x.py', 10), []);
});

test('findLongPythonFunctions flags a nested def separately from its enclosing def', () => {
  const text = [
    'def outer():',
    pyBody(12, '    '),
    '    def inner():',
    pyBody(12, '        '),
    '        return 1',
    '    return inner',
  ].join('\n');
  const findings = findLongPythonFunctions(text, 'x.py', 10);
  assert.equal(findings.length, 2);
  assert.ok(findings.some((f) => f.detail.includes('"outer"')));
  assert.ok(findings.some((f) => f.detail.includes('"inner"')));
});

test('scanProject routes .py files through the indentation-based detector', () => {
  const prev = process.env.AGENT_MANAGER_MAX_FUNCTION_LINES;
  process.env.AGENT_MANAGER_MAX_FUNCTION_LINES = '10';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'function-length-scan-py-test-'));
  fs.writeFileSync(path.join(dir, 'mod.py'), `def bloated():\n${pyBody(14)}\n    return 0\n`);
  fs.writeFileSync(path.join(dir, 'tiny.py'), `def ok():\n    return 1\n`);
  const findings = scanProject(dir, 'py-project');
  if (prev == null) delete process.env.AGENT_MANAGER_MAX_FUNCTION_LINES;
  else process.env.AGENT_MANAGER_MAX_FUNCTION_LINES = prev;
  assert.equal(findings.length, 1);
  assert.equal(findings[0].file, 'mod.py');
  assert.match(findings[0].detail, /function "bloated"/);
  assert.equal(findings[0].projectSlug, 'py-project');
});

test('scanProject walks real files, skips minified ones, and attaches projectSlug/scannedAt', () => {
  const prevThreshold = process.env.AGENT_MANAGER_MAX_FUNCTION_LINES;
  process.env.AGENT_MANAGER_MAX_FUNCTION_LINES = '10'; // scanProject always uses maxFunctionLines() -- override so a 12-line fixture body actually trips it
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'function-length-scan-test-'));
  fs.writeFileSync(path.join(dir, 'real.js'), `function tooLong() {\n${makeBody(12)}\n}\n`);
  // A single absurdly long line -- observability-scan.js's own isLikelyMinified
  // threshold (2000 chars/line) should exclude this file entirely.
  fs.writeFileSync(path.join(dir, 'bundle.js'), `function x(){${'a'.repeat(3000)}}`);
  fs.writeFileSync(path.join(dir, 'short.js'), `function short() {\n${makeBody(2)}\n}\n`);

  const findings = scanProject(dir, 'test-project');
  if (prevThreshold == null) delete process.env.AGENT_MANAGER_MAX_FUNCTION_LINES;
  else process.env.AGENT_MANAGER_MAX_FUNCTION_LINES = prevThreshold;

  assert.equal(findings.length, 1);
  assert.equal(findings[0].file, 'real.js');
  assert.equal(findings[0].projectSlug, 'test-project');
  assert.ok(findings[0].scannedAt);
});
