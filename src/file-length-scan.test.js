'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { findLongFiles, countLines, maxFileLines, writeFlags, DEFAULT_MAX_FILE_LINES } = require('./file-length-scan.js');

function tmpRepo() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'file-length-scan-'));
}
const w = (dir, rel, lineCount) => {
  const p = path.join(dir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, Array.from({ length: lineCount }, (_, i) => `line ${i}`).join('\n') + '\n');
};

test('countLines ignores a single trailing newline', () => {
  assert.equal(countLines('a\nb\nc\n'), 3);
  assert.equal(countLines('a\nb\nc'), 3);
  assert.equal(countLines(''), 0);
});

test('flags a file over the threshold, not one under, largest first', () => {
  const dir = tmpRepo();
  w(dir, 'src/big.js', 700);
  w(dir, 'src/huge.py', 1200);
  w(dir, 'src/ok.js', 120);
  const findings = findLongFiles(dir, 500);
  assert.deepEqual(findings.map((f) => f.file), ['src/huge.py', 'src/big.js']);
  assert.equal(findings[0].lines, 1200);
  assert.equal(findings[0].rule, 'file-too-long');
  assert.match(findings[0].detail, /1200 lines/);
});

test('excludes test files, minified bundles, and SKIP_DIRS', () => {
  const dir = tmpRepo();
  w(dir, 'src/real.js', 900);
  w(dir, 'src/real.test.js', 900);
  w(dir, 'tests/helper.js', 900);
  w(dir, 'node_modules/pkg/index.js', 5000);
  w(dir, 'queue/adhoc/x.js', 5000);
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'bundle.min.js'), 'a;'.repeat(9000)); // one giant line -> minified
  const files = findLongFiles(dir, 500).map((f) => f.file);
  assert.deepEqual(files, ['src/real.js']);
});

test('picks up .html and .sh, not just code', () => {
  const dir = tmpRepo();
  w(dir, 'templates/index.html', 3000);
  w(dir, 'scripts/deploy.sh', 800);
  const files = findLongFiles(dir, 500).map((f) => f.file).sort();
  assert.deepEqual(files, ['scripts/deploy.sh', 'templates/index.html']);
});

test('AGENT_MANAGER_MAX_FILE_LINES overrides the default; bad values fall back', () => {
  const prev = process.env.AGENT_MANAGER_MAX_FILE_LINES;
  try {
    process.env.AGENT_MANAGER_MAX_FILE_LINES = '800';
    assert.equal(maxFileLines(), 800);
    process.env.AGENT_MANAGER_MAX_FILE_LINES = 'nonsense';
    assert.equal(maxFileLines(), DEFAULT_MAX_FILE_LINES);
    process.env.AGENT_MANAGER_MAX_FILE_LINES = '10'; // below the 50 floor
    assert.equal(maxFileLines(), DEFAULT_MAX_FILE_LINES);
  } finally {
    if (prev === undefined) delete process.env.AGENT_MANAGER_MAX_FILE_LINES;
    else process.env.AGENT_MANAGER_MAX_FILE_LINES = prev;
  }
});

test('writeFlags persists a snapshot with threshold + findings', () => {
  const dir = tmpRepo();
  fs.mkdirSync(path.join(dir, 'queue'), { recursive: true });
  w(dir, 'src/big.js', 700);
  const findings = writeFlags(dir, dir, 'proj');
  assert.equal(findings.length, 1);
  const snap = JSON.parse(fs.readFileSync(path.join(dir, 'queue', 'file-length-flags.json'), 'utf8'));
  assert.equal(snap.threshold, 500);
  assert.equal(snap.findings[0].file, 'src/big.js');
  assert.equal(snap.findings[0].projectSlug, 'proj');
});
