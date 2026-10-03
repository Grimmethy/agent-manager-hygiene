'use strict';

// Tests for unused-export-scan.js's ES/TS export-definition support (2026-09-19). Before it,
// only CommonJS exports in .js/.jsx were detected, so an all-TypeScript project produced zero
// candidates.

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { extractEsExports, extractExports, countSameFileUses, scan, isDue, markChecked, fileImporters, buildFileCorpus, isWholeFileDead } = require('./unused-export-scan.js');

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

// --- brain-dump #1742 (2026-10-03): a symbol used inside its own file is not dead code ----------------------------------
// 10 of 10 TaxHarvest triage candidates were used only by a sibling function or a require.main CLI block in their own
// file; countCallSites never looks at the defining file, so each looked unused and "remove the function" was proposed.

test('countSameFileUses: a call from another function, a require.main block, and recursion are real uses', () => {
  assert.equal(countSameFileUses('function a(){ return b(); }\nfunction b(){ return 1; }\nmodule.exports = { a, b };', 'b'), 1);
  assert.equal(countSameFileUses('function c(){}\nif (require.main === module) { c(); }\nmodule.exports = { c };', 'c'), 1);
  assert.equal(countSameFileUses('function k(n){ return n ? k(n - 1) : 0; }\nmodule.exports = { k };', 'k'), 1);
});

test('countSameFileUses: comments, strings, the definition and the export surface are not uses', () => {
  assert.equal(countSameFileUses('// d is never called\nfunction d(){}\nmodule.exports = { d };', 'd'), 0);
  assert.equal(countSameFileUses('function e(){}\nconst s = "e";\nconst t = `e`;\nmodule.exports = { e };', 'e'), 0);
  assert.equal(countSameFileUses('function f(){}\nmodule.exports = { f, g };', 'f'), 0);
  assert.equal(countSameFileUses('exports.h = function h(){};', 'h'), 0);
  assert.equal(countSameFileUses('function i(){}\nexport { i };', 'i'), 0);
  assert.equal(countSameFileUses('function j(){}\nexport default j;', 'j'), 0);
  assert.equal(countSameFileUses('export function dead() {}\nexport function alive() {}\n', 'dead'), 0);
  assert.equal(countSameFileUses('anything', 'not-an-identifier'), 0, 'a non-identifier symbol is never suppressed');
});

test('scan: an export used only inside its own file is skipped and counted; a genuinely unused export is still flagged', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'unused-export-internal-'));
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'src', 'lib.js'), [
    'function used() { return 1; }',
    'function caller() { return used(); }',
    'function unused() { return 2; }',
    'module.exports = { caller, used, unused };',
    '',
  ].join('\n'));
  process.env.AGENT_MANAGER_REPO_ROOT = repo;
  process.env.AGENT_MANAGER_PIPELINE_DIR = repo;
  process.env.AGENT_MANAGER_UNUSED_SCAN_DIRS = 'src';
  process.env.AGENT_MANAGER_UNUSED_SEARCH_DIRS = 'src';
  const flagged = scan();
  assert.ok(Array.isArray(flagged), 'scan() must still return a plain array');
  assert.deepEqual(flagged.map((c) => c.symbol).sort(), ['caller', 'unused']);
  assert.equal(flagged.skippedInternal, 1, '`used` is called by `caller` in its own file');
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

// --- brain-dump #1752 (2026-10-03): a wholly dead FILE is flagged once, not once per export --------------------------------
// shadcn's accordion.tsx became four independent removal candidates (AccordionTrigger, AccordionContent, ...) that could be
// applied separately and leave a half-component; 162 of 183 TaxHarvest components/ui flags sat in 29 files nothing imports.

function wholeFileRepo(files) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'unused-export-wholefile-'));
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
    fs.writeFileSync(path.join(repo, rel), text);
  }
  process.env.AGENT_MANAGER_REPO_ROOT = repo;
  process.env.AGENT_MANAGER_PIPELINE_DIR = repo;
  process.env.AGENT_MANAGER_UNUSED_SCAN_DIRS = 'src';
  process.env.AGENT_MANAGER_UNUSED_SEARCH_DIRS = 'src';
  return repo;
}
const ACCORDION = 'function Accordion() {}\nfunction AccordionItem() {}\nfunction AccordionTrigger() {}\nfunction AccordionContent() {}\nexport { Accordion, AccordionItem, AccordionTrigger, AccordionContent };\n';

test('scan: a fully dead 4-export compound file with no importer is ONE file-level flag and no per-export flags', () => {
  wholeFileRepo({ 'src/components/ui/accordion.tsx': ACCORDION, 'src/App.tsx': 'export function App() { return null; }\n', 'src/main.ts': "import { App } from './App';\nApp();\nApp();\nApp();\n" });
  const flagged = scan();
  const forAccordion = flagged.filter((c) => c.definedIn === 'src/components/ui/accordion.tsx');
  assert.equal(forAccordion.length, 1);
  assert.equal(forAccordion[0].kind, 'file');
  assert.equal(forAccordion[0].symbol, '(file)');
  assert.deepEqual(forAccordion[0].exports.sort(), ['Accordion', 'AccordionContent', 'AccordionItem', 'AccordionTrigger']);
  assert.equal(flagged.fileLevel, 1);
});

test('scan: a partly used file (one export imported elsewhere) stays per-export and never gets a file flag', () => {
  wholeFileRepo({
    'src/components/ui/dialog.tsx': 'export function Dialog() {}\nexport function DialogTrigger() {}\nexport function DialogClose() {}\n',
    'src/Page.tsx': "import { Dialog } from './components/ui/dialog';\nDialog();\nDialog();\nDialog();\nDialog();\n",
  });
  const flagged = scan();
  assert.equal(flagged.fileLevel, 0);
  assert.ok(flagged.every((c) => c.kind === undefined), 'per-export flags carry no kind');
  assert.deepEqual(flagged.filter((c) => c.definedIn.endsWith('dialog.tsx')).map((c) => c.symbol).sort(), ['DialogClose', 'DialogTrigger']);
});

test('scan: a file imported only through a barrel re-export is NOT file-level', () => {
  wholeFileRepo({
    'src/ui/button.tsx': 'export function Button() {}\n',
    'src/ui/barrel.ts': "export { Button } from './button';\n",
  });
  assert.equal(scan().fileLevel, 0);
});

test('fileImporters: relative, alias, dynamic import(), require(), side-effect and quoted-filename references all count', () => {
  const repo = wholeFileRepo({
    'src/x/thing.tsx': 'export function Thing() {}\n',
    'src/rel.ts': "import { Thing } from './x/thing';\n",
    'src/alias.ts': "import { Thing } from '@/components/x/thing';\n",
    'src/dyn.ts': "const m = () => import('./x/thing.tsx');\n",
    'src/req.js': "const t = require('../src/x/thing');\n",
    'src/side.ts': "import './x/thing';\n",
    'src/named.ts': "const f = 'thing.tsx';\n",
    'src/pathalias.ts': "import { Thing } from '@thing';\n",
  });
  const corpus = buildFileCorpus(repo);
  const hits = fileImporters(path.join(repo, 'src/x/thing.tsx'), corpus).map((f) => path.basename(f)).sort();
  assert.deepEqual(hits, ['alias.ts', 'dyn.ts', 'named.ts', 'pathalias.ts', 'rel.ts', 'req.js', 'side.ts']);
});

test('scan: a file imported via a dynamic import() only, or via an alias specifier only, is NOT file-level', () => {
  wholeFileRepo({
    'src/lazy/Page.tsx': 'export default function Page() {}\nexport const meta = {};\n',
    'src/router.ts': "const routes = [() => import('./lazy/Page')];\n",
    'src/aliased/Panel.tsx': 'export function Panel() {}\n',
    'src/use.ts': "import { Panel } from '@/aliased/Panel';\n",
  });
  assert.equal(scan().fileLevel, 0);
});

test('scan: a package.json script string or a shell reference keeps a file from being file-level', () => {
  wholeFileRepo({
    'src/tool.ts': 'export function run() {}\n',
    'src/other.tsx': 'export function Other() {}\n',
    'package.json': '{ "scripts": { "tool": "tsx src/tool.ts" } }\n',
    'scripts/go.sh': 'node build/other.tsx\n',
  });
  assert.equal(scan().fileLevel, 0);
});

test('scan: CLI, test, config and index files are never file-level (and CommonJS .js stays per-export)', () => {
  wholeFileRepo({
    'src/cli.ts': 'export function main() {}\nif (require.main === module) { main(); }\n',
    'src/thing.test.ts': 'export function helperForTest() {}\n',
    'src/vite.config.ts': 'export const cfg = {};\n',
    'src/widgets/index.ts': 'export function Widget() {}\n',
    'src/legacy.js': 'function oldFn() {}\nmodule.exports = { oldFn };\n',
  });
  const flagged = scan();
  assert.equal(flagged.fileLevel, 0);
  assert.ok(flagged.some((c) => c.symbol === 'oldFn'), 'a CommonJS file keeps its per-export flag');
});

test('scan: a same-named symbol in another file does NOT keep an unimported file per-export', () => {
  wholeFileRepo({
    'src/ui/breadcrumb.tsx': 'export function Breadcrumb() {}\nexport function BreadcrumbItem() {}\n',
    'src/Nav.tsx': 'function Breadcrumb() {}\nBreadcrumb();\nBreadcrumb();\nBreadcrumb();\n',
  });
  const flagged = scan();
  assert.equal(flagged.fileLevel, 1);
  assert.equal(flagged.filter((c) => c.definedIn === 'src/ui/breadcrumb.tsx').length, 1);
});

test('scan: when the repo loads files by glob (import.meta.glob / require.context), no file is declared dead as a whole', () => {
  wholeFileRepo({
    'src/ui/card.tsx': 'export function Card() {}\n',
    'src/loader.ts': "const mods = import.meta.glob('./ui/*.tsx');\n",
  });
  assert.equal(scan().fileLevel, 0);
});

test('isWholeFileDead: reports why a file was kept (reason strings are for humans, the boolean is what scan uses)', () => {
  const repo = wholeFileRepo({ 'src/a.tsx': 'export function A() {}\n', 'src/b.ts': "import { A } from './a';\n" });
  const corpus = buildFileCorpus(repo);
  const v = isWholeFileDead({ file: path.join(repo, 'src/a.tsx'), text: 'export function A() {}\n', exportNames: ['A'], corpus, repoRoot: repo });
  assert.equal(v.dead, false);
  assert.match(v.reason, /imported or referenced/);
  assert.equal(isWholeFileDead({ file: path.join(repo, 'src/a.tsx'), text: '', exportNames: [], corpus, repoRoot: repo }).reason, 'no exports');
});
