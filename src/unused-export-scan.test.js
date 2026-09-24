'use strict';

// Tests for unused-export-scan.js's ES/TS export-definition support (2026-09-19). Before it,
// only CommonJS exports in .js/.jsx were detected, so an all-TypeScript project produced zero
// candidates.

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { extractEsExports, extractExports, scan, isDue, markChecked } = require('./unused-export-scan.js');

test('extractEsExports: declarations, defaults, and export lists', () => {
  const names = extractEsExports([
    'export const A = 1;',
    'export async function B() {}',
    'export function* Gen() {}',
    'export default function C() {}',
    'export interface D {}',
    'export type E = string;',
    'export const enum F { a }',
    'export abstract class G {}',
    'export { h, i as j, type K };',
    'export default Main;',
  ].join('\n'));
  assert.deepEqual(names.sort(), ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'Gen', 'K', 'Main', 'h', 'j'].sort());
});

test('extractEsExports: ignores re-exports, anonymous defaults, destructures, comments and strings', () => {
  const names = extractEsExports([
    '// export const inComment = 1',
    '/* export function inBlock() {} */',
    "const s = 'export const inString = 1';",
    "export { z } from './z';",
    "export type { T } from './t';",
    "export * from './q';",
    'export default () => 1;',
    'export const { p, q } = obj;',
    'export const real = 1;',
  ].join('\n'));
  assert.deepEqual(names, ['real']);
});

test('extractEsExports: `export { a as default }` yields the local name', () => {
  assert.deepEqual(extractEsExports('export { widget as default };'), ['widget']);
});

// Regression (2026-09-24, found during a hand-verification sweep of the first real live
// scan): a comment inside a multi-line `module.exports = {...}` list was being comma-split
// and added as if it were an export name -- 13 of 251 real candidates from that first scan
// were comment prose, not identifiers.
test('extractExports: a comment inside module.exports = {...} is never mistaken for an export name', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unused-export-'));
  fs.writeFileSync(path.join(dir, 'a.js'), [
    'function foo() {}',
    'function bar() {}',
    'module.exports = {',
    '  foo,',
    '  // exported for direct unit testing',
    '  bar,',
    '};',
  ].join('\n'));
  assert.deepEqual(extractExports(path.join(dir, 'a.js')).sort(), ['bar', 'foo']);
});

test('extractExports: ES detection applies to .ts/.tsx only; CommonJS still works for .js', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unused-export-'));
  fs.writeFileSync(path.join(dir, 'a.tsx'), 'export const FromTsx = 1;\n');
  fs.writeFileSync(path.join(dir, 'b.js'), 'export const FromEsmJs = 1;\nmodule.exports = { cjsOne };\n');
  assert.deepEqual(extractExports(path.join(dir, 'a.tsx')), ['FromTsx']);
  assert.deepEqual(extractExports(path.join(dir, 'b.js')), ['cjsOne']); // ESM in .js deliberately unchanged
});

test('scan: flags an unused TS export with its (empty) call sites, skips .d.ts, counts TSX usage', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'unused-export-repo-'));
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'src', 'lib.ts'), 'export function dead() {}\nexport function alive() {}\n');
  const usage = Array.from({ length: 5 }, (_, i) => `alive(); // use ${i}`).join('\n');
  fs.writeFileSync(path.join(repo, 'src', 'view.tsx'), `import { alive } from './lib';\n${usage}\n`);
  fs.writeFileSync(path.join(repo, 'src', 'env.d.ts'), 'export declare const ambient: string;\n');
  process.env.AGENT_MANAGER_REPO_ROOT = repo;
  process.env.AGENT_MANAGER_PIPELINE_DIR = repo;
  process.env.AGENT_MANAGER_UNUSED_SCAN_DIRS = 'src';
  process.env.AGENT_MANAGER_UNUSED_SEARCH_DIRS = 'src';
  const flagged = scan();
  assert.deepEqual(flagged.map((c) => c.symbol), ['dead']);
  assert.equal(flagged[0].definedIn, 'src/lib.ts');
  assert.deepEqual(flagged[0].callSites, []);
});

// Throttle (2026-09-24): this scanner is O(exports x repo size), unlike its cheap siblings
// wired into queue-watcher.sh -- it must not be run every watchdog tick.
test('isDue: true when never checked before, false right after markChecked, true again once the interval elapses', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unused-export-throttle-'));
  const instancesDir = path.join(dir, 'instances');
  assert.equal(isDue(instancesDir), true, 'never checked before -- due immediately');

  const now = new Date('2026-09-24T00:00:00.000Z');
  markChecked(instancesDir, now);
  assert.equal(isDue(instancesDir, now), false, 'just checked -- not due yet');
  assert.equal(isDue(instancesDir, new Date(now.getTime() + 60 * 1000)), false, 'still well inside the interval');

  const oneDayLater = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  assert.equal(isDue(instancesDir, oneDayLater), true, 'interval elapsed -- due again');
});
