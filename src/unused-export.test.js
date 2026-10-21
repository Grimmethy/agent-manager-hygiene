'use strict';

// unused_export / deadcode_fix -- direct coverage for the register()/apply candidate-doc
// path added 2026-09-24 (before this, a GENUINE verdict was thrown away entirely by
// applyVerdictOnly; see this file's own header for the full history). Mirrors
// function-length-review.test.js's own apply-level test, same shape.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

function freshPlugin(repoRoot) {
  process.env.AGENT_MANAGER_REPO_ROOT = repoRoot;
  process.env.AGENT_MANAGER_PIPELINE_DIR = repoRoot;
  const registry = require('agent-manager/src/task-source-registry.js');
  registry.clearRegistry();
  const { clearModelProfileRegistry } = require('agent-manager/src/model-profile-registry.js');
  clearModelProfileRegistry();
  delete require.cache[require.resolve('agent-manager/src/task-sources.js')];
  delete require.cache[require.resolve('./unused-export.js')];
  const { getConfig } = require('agent-manager/src/config.js');
  const { nextCandidateFulfillmentTask, taskIdExistsInQueue, taskPriority } = require('agent-manager/src/task-sources.js');
  const deps = { getConfig, nextCandidateFulfillmentTask, taskIdExistsInQueue, taskPriority };
  const mod = require('./unused-export.js');
  mod.register(deps);
  return { ...deps, nextUnusedExportTask: mod.nextUnusedExportTask, getRegisteredSource: registry.getRegisteredSource };
}

function makeRepo() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'unused-export-test-'));
}

test('nextUnusedExportTask returns null when queue/dead-code-flags.json does not exist', () => {
  const dir = makeRepo();
  const { nextUnusedExportTask, getConfig, taskIdExistsInQueue } = freshPlugin(dir);
  assert.equal(nextUnusedExportTask({ getConfig, taskIdExistsInQueue }), null);
});

test('nextUnusedExportTask turns the oldest not-yet-queued flag entry into a task', () => {
  const dir = makeRepo();
  fs.mkdirSync(path.join(dir, 'queue'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'queue', 'dead-code-flags.json'), JSON.stringify([
    { symbol: 'newer', definedIn: 'src/b.js', callSites: [], scannedAt: '2026-09-24T00:00:00.000Z' },
    { symbol: 'older', definedIn: 'src/a.js', callSites: [{ file: 'src/c.js', line: 3 }], scannedAt: '2026-09-01T00:00:00.000Z' },
  ]));
  const { nextUnusedExportTask, getConfig, taskIdExistsInQueue } = freshPlugin(dir);
  const task = nextUnusedExportTask({ getConfig, taskIdExistsInQueue });
  assert.equal(task.source, 'deadcode_triage');
  assert.equal(task.id, 'deadcode-older-src-a-js');
  assert.equal(task.promptContext.symbol, 'older');
  assert.deepEqual(task.promptContext.callSites, [{ file: 'src/c.js', line: 3 }]);
});

test('nextUnusedExportTask skips a STALE flag whose defining file shows a same-file use and takes the next one (brain-dump #1742)', () => {
  const dir = makeRepo();
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'queue'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'a.js'), 'function helper() {}\nfunction main() { return helper(); }\nmodule.exports = { main, helper };\n');
  fs.writeFileSync(path.join(dir, 'src', 'b.js'), 'function lone() {}\nmodule.exports = { lone };\n');
  fs.writeFileSync(path.join(dir, 'queue', 'dead-code-flags.json'), JSON.stringify([
    { symbol: 'helper', definedIn: 'src/a.js', callSites: [], scannedAt: '2026-09-01T00:00:00.000Z' }, // oldest, but used by main() in its own file
    { symbol: 'lone', definedIn: 'src/b.js', callSites: [], scannedAt: '2026-09-02T00:00:00.000Z' },
  ]));
  const { nextUnusedExportTask, getConfig, taskIdExistsInQueue } = freshPlugin(dir);
  const task = nextUnusedExportTask({ getConfig, taskIdExistsInQueue });
  assert.equal(task.promptContext.symbol, 'lone');
});

test('nextUnusedExportTask is fail-open: a flag whose defining file cannot be read is still turned into a task', () => {
  const dir = makeRepo();
  fs.mkdirSync(path.join(dir, 'queue'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'queue', 'dead-code-flags.json'), JSON.stringify([
    { symbol: 'ghost', definedIn: 'src/does-not-exist.js', callSites: [], scannedAt: '2026-09-01T00:00:00.000Z' },
  ]));
  const { nextUnusedExportTask, getConfig, taskIdExistsInQueue } = freshPlugin(dir);
  const task = nextUnusedExportTask({ getConfig, taskIdExistsInQueue });
  assert.equal(task.promptContext.symbol, 'ghost');
});

test('unused_export declares its own dead-code review guidance, directToMain, and groundingFields on callSites and sourceContext', () => {
  const dir = makeRepo();
  const { getRegisteredSource } = freshPlugin(dir);
  const src = getRegisteredSource('unused_export');
  assert.equal(src.directToMain, true);
  assert.deepEqual(src.groundingFields, ['callSites', 'sourceContext']);
  assert.match(src.reviewGuidance, /NOT itself a code change/);
  assert.match(src.reviewCompletenessQuestion, /decisive verdict -- GENUINE, FALSE POSITIVE, or a grounded UNCERTAIN/);
});

test('unused_export apply: a GENUINE verdict appends a real candidate to the dead-code candidates doc', () => {
  const dir = makeRepo();
  const candidatesPath = path.join(dir, 'Docs', 'DEAD_CODE_CANDIDATES.md');
  process.env.AGENT_MANAGER_DEAD_CODE_CANDIDATES_PATH = candidatesPath;
  const { getRegisteredSource } = freshPlugin(dir);

  const result = getRegisteredSource('unused_export').apply({
    implementResponse: [
      '### AC-001 · Remove dead helper oldHelper',
      'Strength: Strong',
      'Files: src/old.js',
      '',
      'Problem:',
      'oldHelper is exported but has zero real call sites anywhere in the repo.',
      '',
      'Solution:',
      'Delete the oldHelper export from src/old.js.',
      '',
      'Benefits:',
      'Less dead surface area for a future reader to puzzle over.',
    ].join('\n'),
  });
  assert.equal(result.candidateCount, 1);
  const text = fs.readFileSync(candidatesPath, 'utf8');
  assert.match(text, /### AC-1 · Remove dead helper oldHelper/);
  assert.match(text, /Files: src\/old\.js/);
});

test('unused_export apply: a FALSE POSITIVE/UNCERTAIN verdict (no candidate block) writes nothing to the doc', () => {
  const dir = makeRepo();
  const candidatesPath = path.join(dir, 'Docs', 'DEAD_CODE_CANDIDATES.md');
  process.env.AGENT_MANAGER_DEAD_CODE_CANDIDATES_PATH = candidatesPath;
  const { getRegisteredSource } = freshPlugin(dir);

  const result = getRegisteredSource('unused_export').apply({
    implementResponse: 'FALSE POSITIVE -- this is a barrel re-export consumed via a wildcard import the grep cannot see.',
  });
  assert.equal(result.skipped, true);
  assert.equal(fs.existsSync(candidatesPath), false);
});

// brain-dump #1764: deadcode-getparser answered FALSE POSITIVE but still wrote a block whose Strength was "Not actionable (false positive)"
// and it was filed as a candidate. unused_export's apply now passes requireStrength: 'Strong' (core PR #515).
test('unused_export apply: a block whose Strength is not Strong (a FALSE POSITIVE written as a candidate) is skipped and writes nothing', () => {
  const dir = makeRepo();
  const candidatesPath = path.join(dir, 'Docs', 'DEAD_CODE_CANDIDATES.md');
  process.env.AGENT_MANAGER_DEAD_CODE_CANDIDATES_PATH = candidatesPath;
  const { getRegisteredSource } = freshPlugin(dir);

  const result = getRegisteredSource('unused_export').apply({
    implementResponse: [
      '### AC-001 · getParser factory in parsers/index.js',
      'Strength: Not actionable (false positive)',
      'Files: src/x.js',
      '',
      'Problem:',
      'getParser is live production code.',
      '',
      'Solution:',
      'No code change is warranted.',
      '',
      'Benefits:',
      'None.',
    ].join('\n'),
  });
  assert.equal(result.skipped, true);
  assert.match(result.reason, /not Strength: Strong \(Not actionable \(false positive\)\)/);
  assert.equal(fs.existsSync(candidatesPath), false);
});

test('unused_export apply: a response with one Strong and one non-Strong block appends only the Strong one', () => {
  const dir = makeRepo();
  const candidatesPath = path.join(dir, 'Docs', 'DEAD_CODE_CANDIDATES.md');
  process.env.AGENT_MANAGER_DEAD_CODE_CANDIDATES_PATH = candidatesPath;
  const { getRegisteredSource } = freshPlugin(dir);
  const block = (n, strength, file) => ['### AC-00' + n + ' · Remove ' + file, 'Strength: ' + strength, 'Files: ' + file, '', 'Problem:', 'p', '', 'Solution:', 's', '', 'Benefits:', 'b'].join('\n');

  const result = getRegisteredSource('unused_export').apply({
    implementResponse: block(1, 'Strong', 'src/real.js') + '\n\n' + block(2, 'Uncertain (Plan verdict: UNCERTAIN)', 'src/maybe.js'),
  });
  assert.equal(result.candidateCount, 1);
  assert.equal(result.droppedNonStrong, 1);
  const text = fs.readFileSync(candidatesPath, 'utf8');
  assert.match(text, /Files: src\/real\.js/);
  assert.doesNotMatch(text, /src\/maybe\.js/);
});

test('deadcode_fix consumes a Strong dead-code candidate via the generic candidate-fulfillment path', () => {
  const dir = makeRepo();
  const candidatesPath = path.join(dir, 'Docs', 'DEAD_CODE_CANDIDATES.md');
  process.env.AGENT_MANAGER_DEAD_CODE_CANDIDATES_PATH = candidatesPath;
  fs.mkdirSync(path.dirname(candidatesPath), { recursive: true });
  fs.writeFileSync(candidatesPath, [
    '# Dead Code Removal Candidates',
    '',
    '### AC-1 · Remove dead helper oldHelper',
    'Strength: Strong',
    'Files: src/old.js',
    '',
    'Problem:',
    'oldHelper is exported but has zero real call sites anywhere in the repo.',
    '',
    'Solution:',
    'Delete the oldHelper export from src/old.js.',
    '',
    'Benefits:',
    'Less dead surface area.',
  ].join('\n'));
  const { getRegisteredSource } = freshPlugin(dir);

  const src = getRegisteredSource('deadcode_fix');
  assert.equal(src.candidateFulfillment, true);
  assert.notEqual(src.directToMain, true, 'a real removal diff must go through the normal branch+merge path');
  const task = src.next();
  assert.ok(task, 'deadcode_fix must pick up the Strong candidate');
  assert.equal(task.id, 'deadcode-fix-ac-1');
  assert.match(task.title, /Remove dead helper oldHelper/);
});

// --- brain-dump #1752 (2026-10-03): whole-file flags --------------------------------------------------------------------
const FILE_FLAG = { symbol: '(file)', kind: 'file', definedIn: 'src/ui/accordion.tsx', exports: ['Accordion', 'AccordionItem', 'AccordionTrigger', 'AccordionContent'], callSites: [], scannedAt: '2026-09-01T00:00:00.000Z' };

function writeFlags(dir, entries) {
  fs.mkdirSync(path.join(dir, 'queue'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'queue', 'dead-code-flags.json'), JSON.stringify(entries));
}

test('nextUnusedExportTask turns a whole-file flag into a file-level task with its own id, title and promptContext', () => {
  const dir = makeRepo();
  fs.mkdirSync(path.join(dir, 'src', 'ui'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'ui', 'accordion.tsx'), 'export function Accordion() {}\n');
  writeFlags(dir, [FILE_FLAG]);
  const { nextUnusedExportTask, getConfig, taskIdExistsInQueue } = freshPlugin(dir);
  const task = nextUnusedExportTask({ getConfig, taskIdExistsInQueue });
  assert.equal(task.id, 'deadcode-file-src-ui-accordion-tsx');
  assert.equal(task.source, 'deadcode_triage');
  assert.match(task.title, /whole-file dead-code candidate: src\/ui\/accordion\.tsx \(4 export\(s\), no importer\)/);
  assert.equal(task.promptContext.kind, 'file');
  assert.deepEqual(task.promptContext.exports, FILE_FLAG.exports);
  assert.deepEqual(task.promptContext.callSites, []);
});

test('the inventory id for a whole-file flag equals the id the generator gives the task (one shared formula)', () => {
  const dir = makeRepo();
  fs.mkdirSync(path.join(dir, 'src', 'ui'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'ui', 'accordion.tsx'), 'export function Accordion() {}\n');
  const exportFlag = { symbol: 'lone', definedIn: 'src/b.js', callSites: [], scannedAt: '2026-09-02T00:00:00.000Z' };
  writeFlags(dir, [FILE_FLAG, exportFlag]);
  const mod = require('./unused-export.js');
  freshPlugin(dir);
  assert.equal(mod.taskIdForEntry(FILE_FLAG), 'deadcode-file-src-ui-accordion-tsx');
  assert.equal(mod.taskIdForEntry(exportFlag), 'deadcode-lone-src-b-js', 'per-export ids are unchanged');
  const seen = [];
  mod.unusedExportInventory({ pipelineDir: dir, repoRoot: dir, taskState: (id) => { seen.push(id); return null; } });
  assert.ok(seen.includes('deadcode-file-src-ui-accordion-tsx'), `inventory asked about ${JSON.stringify(seen)}`);
});

test('the stale guard drops a whole-file entry that gained an importer (or whose file is gone) and keeps one that did not', () => {
  const dir = makeRepo();
  fs.mkdirSync(path.join(dir, 'src', 'ui'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'ui', 'accordion.tsx'), 'export function Accordion() {}\n');
  fs.writeFileSync(path.join(dir, 'src', 'ui', 'alert.tsx'), 'export function Alert() {}\n');
  fs.writeFileSync(path.join(dir, 'src', 'page.tsx'), "import { Accordion } from './ui/accordion';\n");
  writeFlags(dir, [
    FILE_FLAG,
    { ...FILE_FLAG, definedIn: 'src/ui/gone.tsx', scannedAt: '2026-09-02T00:00:00.000Z' },
    { ...FILE_FLAG, definedIn: 'src/ui/alert.tsx', exports: ['Alert'], scannedAt: '2026-09-03T00:00:00.000Z' },
  ]);
  const { nextUnusedExportTask, getConfig, taskIdExistsInQueue } = freshPlugin(dir);
  const task = nextUnusedExportTask({ getConfig, taskIdExistsInQueue });
  assert.equal(task.promptContext.definedIn, 'src/ui/alert.tsx', 'accordion gained an importer, gone.tsx no longer exists');
});

test('the whole-file stale guard fails open: an entry it cannot reason about is kept', () => {
  const dir = makeRepo();
  const mod = require('./unused-export.js');
  freshPlugin(dir);
  assert.equal(mod.fileEntryIsStale(dir, { kind: 'file' }), false, 'no definedIn -> keep');
});

test('prompt dispatch: per-export tasks get the core prompts unchanged; kind:file tasks get the whole-file pair', () => {
  const dir = makeRepo();
  const mod = require('./unused-export.js');
  freshPlugin(dir);
  const core = require('agent-manager/src/prompts.js');
  const perExport = { promptContext: { symbol: 'lone', definedIn: 'src/b.js', callSites: [], note: 'n' } };
  assert.equal(mod.buildPlanPromptFor(perExport), core.unusedExportPlanPrompt(perExport));
  assert.equal(mod.buildImplementPromptFor(perExport, 'PLAN'), core.unusedExportImplementPrompt(perExport, 'PLAN'));
  const fileTask = { promptContext: { kind: 'file', symbol: '(file)', definedIn: 'src/ui/accordion.tsx', exports: FILE_FLAG.exports, callSites: [], note: 'n' } };
  const plan = mod.buildPlanPromptFor(fileTask);
  assert.match(plan, /WHOLE FILE/);
  assert.match(plan, /src\/ui\/accordion\.tsx/);
  assert.match(plan, /Accordion, AccordionItem, AccordionTrigger, AccordionContent/);
  const impl = mod.buildImplementPromptFor(fileTask, 'PLAN');
  assert.match(impl, /### AC-NNN · Remove unused file <path>/);
  assert.match(impl, /Files: src\/ui\/accordion\.tsx/);
  assert.match(impl, /DELETE the file src\/ui\/accordion\.tsx entirely with a single delete action/);
  assert.doesNotMatch(impl, /remove the export itself/);
});

test('unused_export is registered with the dispatching prompt builders and review guidance that allows a one-file Solution', () => {
  const dir = makeRepo();
  const { getRegisteredSource } = freshPlugin(dir);
  const src = getRegisteredSource('unused_export');
  const fileTask = { promptContext: { kind: 'file', symbol: '(file)', definedIn: 'src/x.tsx', exports: ['X'], callSites: [], note: '' } };
  assert.match(src.buildPlanPrompt(fileTask), /WHOLE FILE/);
  assert.match(src.reviewGuidance, /broader than this one file/);
  assert.match(src.reviewCompletenessQuestion, /deleting exactly this one file/);
});

// brain-dump #1754: the stale guard uses the same source-only corpus
test('the whole-file stale guard keeps an entry mentioned only in an artifact directory and still drops one with a real importer', () => {
  const dir = makeRepo();
  fs.mkdirSync(path.join(dir, 'src', 'ui'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'task-logs'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.cache'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'ui', 'accordion.tsx'), 'export function Accordion() {}\n');
  fs.writeFileSync(path.join(dir, 'src', 'ui', 'alert.tsx'), 'export function Alert() {}\n');
  fs.writeFileSync(path.join(dir, 'task-logs', 'x.json'), '{"note":"src/ui/accordion.tsx and ./accordion"}\n');
  fs.writeFileSync(path.join(dir, '.cache', 'graph.json'), '{"nodes":["./accordion"]}\n');
  fs.writeFileSync(path.join(dir, 'src', 'page.tsx'), "import { Alert } from './ui/alert';\n");
  const mod = require('./unused-export.js');
  freshPlugin(dir);
  assert.equal(mod.fileEntryIsStale(dir, { kind: 'file', definedIn: 'src/ui/accordion.tsx' }), false, 'artifact mentions are not importers');
  assert.equal(mod.fileEntryIsStale(dir, { kind: 'file', definedIn: 'src/ui/alert.tsx' }), true, 'a real importer makes it stale');
});

// ---- source excerpt + grounded-UNCERTAIN guidance (brain-dump #1762) -------------------------------------------------------
function writeFile(dir, rel, text) {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), text);
}

test('buildSourceContext shows a small file whole, line-numbered, and lists the files that name the module', () => {
  const dir = makeRepo();
  writeFile(dir, 'src/parsers/index.js', 'const a = 1;\nfunction getParser(k) { return a; }\nmodule.exports = { getParser };\n');
  writeFile(dir, 'src/routes/parse.js', "const p = require('../parsers');\nconst x = p.getParser('a');\n");
  const mod = require('./unused-export.js');
  const out = mod.buildSourceContext(dir, { symbol: 'getParser', definedIn: 'src/parsers/index.js' });
  assert.match(out, /^SOURCE EXCERPT of src\/parsers\/index\.js \(the file the symbol is defined in\) --/);
  assert.match(out, /2: function getParser\(k\)/);
  assert.match(out, /3: module\.exports = \{ getParser \};/);
  assert.match(out, /Files that name this module: src\/routes\/parse\.js/);
});

test('buildSourceContext says "none found" when nothing names the module', () => {
  const dir = makeRepo();
  writeFile(dir, 'src/lone.js', 'function lone() {}\nmodule.exports = { lone };\n');
  const mod = require('./unused-export.js');
  assert.match(mod.buildSourceContext(dir, { symbol: 'lone', definedIn: 'src/lone.js' }), /Files that name this module: none found/);
});

test('buildSourceContext windows a large file around the definition, keeps export lines, and caps with a marker', () => {
  const dir = makeRepo();
  const filler = (n, tag) => Array.from({ length: n }, (_, i) => `// ${tag} filler line ${i} ${'x'.repeat(40)}`);
  const lines = [...filler(200, 'top'), 'function target() { return 1; }', ...filler(200, 'bottom'), 'module.exports = { target };'];
  writeFile(dir, 'src/big.js', lines.join('\n'));
  const mod = require('./unused-export.js');
  const out = mod.buildSourceContext(dir, { symbol: 'target', definedIn: 'src/big.js' });
  assert.match(out, /201: function target\(\)/);
  assert.match(out, /module\.exports = \{ target \};/, 'export lines survive the window');
  assert.doesNotMatch(out, /top filler line 0 /, 'far-away lines are cut');
  assert.match(out, /\.\.\./);
  const body = out.split('\nFiles that name')[0];
  assert.ok(body.length <= 6200, `bounded, got ${body.length}`);
  const huge = ['function target() {}', ...Array.from({ length: 400 }, (_, i) => `export const e${i} = ${'y'.repeat(60)};`)].join('\n');
  writeFile(dir, 'src/huge.js', huge);
  assert.match(mod.buildSourceContext(dir, { symbol: 'target', definedIn: 'src/huge.js' }), /\[truncated\]/);
});

test('buildSourceContext for a whole-file entry shows the head and the export list', () => {
  const dir = makeRepo();
  const lines = [...Array.from({ length: 100 }, (_, i) => `// line ${i}`), 'export function Late() {}'];
  writeFile(dir, 'src/ui/late.tsx', lines.join('\n'));
  const mod = require('./unused-export.js');
  const out = mod.buildSourceContext(dir, { kind: 'file', symbol: '(file)', definedIn: 'src/ui/late.tsx', exports: ['Late'] });
  assert.match(out, /1: \/\/ line 0/);
  assert.match(out, /101: export function Late\(\) \{\}/);
  assert.doesNotMatch(out, /80: \/\/ line 79/);
});

test('buildSourceContext fails open: an unreadable file gives an empty string and the task is still created', () => {
  const dir = makeRepo();
  const mod = require('./unused-export.js');
  assert.equal(mod.buildSourceContext(dir, { symbol: 'gone', definedIn: 'src/missing.js' }), '');
  writeFlags(dir, [{ symbol: 'gone', definedIn: 'src/missing.js', callSites: [], scannedAt: '2026-09-01T00:00:00.000Z' }]);
  const { nextUnusedExportTask, getConfig, taskIdExistsInQueue } = freshPlugin(dir);
  const task = nextUnusedExportTask({ getConfig, taskIdExistsInQueue });
  assert.ok(task);
  assert.equal(task.promptContext.sourceContext, '');
});

test('nextUnusedExportTask puts the source excerpt on promptContext for both entry shapes', () => {
  const dir = makeRepo();
  writeFile(dir, 'src/ui/accordion.tsx', 'export function Accordion() {}\n');
  writeFile(dir, 'src/b.js', 'function lone() {}\nmodule.exports = { lone };\n');
  writeFlags(dir, [FILE_FLAG, { symbol: 'lone', definedIn: 'src/b.js', callSites: [], scannedAt: '2026-09-02T00:00:00.000Z' }]);
  const { nextUnusedExportTask, getConfig, taskIdExistsInQueue } = freshPlugin(dir);
  const fileTask = nextUnusedExportTask({ getConfig, taskIdExistsInQueue });
  assert.match(fileTask.promptContext.sourceContext, /SOURCE EXCERPT of src\/ui\/accordion\.tsx/);
  const exists = (id) => id === fileTask.id;
  const exportTask = nextUnusedExportTask({ getConfig, taskIdExistsInQueue: exists });
  assert.match(exportTask.promptContext.sourceContext, /SOURCE EXCERPT of src\/b\.js/);
});

test('prompt wrappers append (per-export) or print (file-level) the source block, and are byte-identical when it is empty', () => {
  const dir = makeRepo();
  const mod = require('./unused-export.js');
  freshPlugin(dir);
  const core = require('agent-manager/src/prompts.js');
  const base = { promptContext: { symbol: 'lone', definedIn: 'src/b.js', callSites: [], note: 'n' } };
  const withCtx = { promptContext: { ...base.promptContext, sourceContext: 'SOURCE EXCERPT of src/b.js (x) --\n1: code' } };
  assert.equal(mod.buildPlanPromptFor(base), core.unusedExportPlanPrompt(base));
  assert.equal(mod.buildImplementPromptFor(base, 'P'), core.unusedExportImplementPrompt(base, 'P'));
  assert.equal(mod.buildPlanPromptFor({ promptContext: { ...base.promptContext, sourceContext: '' } }), core.unusedExportPlanPrompt(base));
  assert.equal(mod.buildPlanPromptFor(withCtx), `${core.unusedExportPlanPrompt(withCtx)}\n\n${withCtx.promptContext.sourceContext}`);
  assert.ok(mod.buildImplementPromptFor(withCtx, 'P').endsWith(withCtx.promptContext.sourceContext));
  const fileTask = { promptContext: { kind: 'file', symbol: '(file)', definedIn: 'src/x.tsx', exports: ['X'], callSites: [], sourceContext: 'SOURCE EXCERPT of src/x.tsx (x) --\n1: code', note: 'NOTE-LINE' } };
  const plan = mod.buildPlanPromptFor(fileTask);
  assert.ok(plan.indexOf('SOURCE EXCERPT') > -1 && plan.indexOf('SOURCE EXCERPT') < plan.indexOf('NOTE-LINE'), 'printed before NOTE');
});

test('review guidance accepts a grounded UNCERTAIN and no longer rejects "cannot determine" as such', () => {
  const dir = makeRepo();
  const { getRegisteredSource } = freshPlugin(dir);
  const src = getRegisteredSource('unused_export');
  assert.match(src.reviewGuidance, /grounded UNCERTAIN/);
  assert.match(src.reviewGuidance, /do NOT reject it as hedging or refusal/);
  assert.match(src.reviewGuidance, /speculation not tied to the shown material/);
  assert.match(src.reviewGuidance, /gives no verdict at all/);
  assert.doesNotMatch(src.reviewGuidance, /cannot determine/);
  assert.match(src.reviewGuidance, /malformed or missing a required section/);
  assert.match(src.reviewGuidance, /broader than this one file/);
});

test('unused_export declares genuineVerdict so core\'s inert-target sweep reads its done/ records (core names no plugin source)', () => {
  const { getRegisteredSource } = freshPlugin(makeRepo());
  assert.deepEqual(getRegisteredSource('unused_export').genuineVerdict, { idPrefix: 'deadcode-' });
  assert.equal(getRegisteredSource('deadcode_fix').genuineVerdict, undefined, 'only the verdict-bearing triage source opts in');
});

test('every id taskIdForEntry mints starts with the declared genuineVerdict idPrefix', () => {
  const { getRegisteredSource } = freshPlugin(makeRepo());
  const { taskIdForEntry } = require('./unused-export.js');
  const { idPrefix } = getRegisteredSource('unused_export').genuineVerdict;
  for (const e of [{ symbol: 'foo', definedIn: 'src/a.js' }, { kind: 'file', definedIn: 'src/b.js' }]) {
    assert.ok(taskIdForEntry(e).startsWith(idPrefix), taskIdForEntry(e));
  }
});

// 2026-10-16: DEAD_CODE_CANDIDATES.md was rooted at the live checkout (getConfig().repoRoot) while the directToMain batch commits in the apply
// clone, so every apply appended to the live file and then failed `git add` ("outside repository"); the task re-ran 304 times and the doc held
// 1459 blocks of 7 distinct titles. These tests pin the rooting and the idempotent re-apply (symbol-keyed: core's title-only key is null for four
// of the real titles below).
const REAL_DUPLICATED_TITLES = [
  ['SOURCE_CONTRACT', 'Remove unused SOURCE_CONTRACT export', 'src/contract-spec.js'],
  ['EXTENDED_NUM_CTX', 'Remove vestigial EXTENDED_NUM_CTX alias constant', 'src/local-client.js'],
  ['LABEL_RE', 'Remove unused LABEL_RE constant from hub-serial.js', 'src/hub-serial.js'],
  ['selectDraftStrategy', 'Remove orphaned selectDraftStrategy extraction', 'src/draft-strategy.js'],
];

function strongBlock(title, file) {
  return [
    `### AC-001 · ${title}`, 'Strength: Strong', `Files: ${file}`, '', 'Problem:', 'Exported but has zero real call sites.', '',
    'Solution:', 'Delete the export.', '', 'Benefits:', 'Less dead surface area.',
  ].join('\n');
}

function withApplyEnv(vars, fn) {
  const keys = ['AGENT_MANAGER_DEAD_CODE_CANDIDATES_PATH', 'AGENT_MANAGER_APPLY_REPO_ROOT'];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  for (const k of keys) delete process.env[k];
  Object.assign(process.env, vars);
  try { return fn(); } finally {
    for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
}

const countBlocks = (file) => (fs.readFileSync(file, 'utf8').match(/^### AC-\d+/gm) || []).length;

test('unused_export apply: with a separate apply clone the doc is written under applyRepoRoot and nothing is written to the live repoRoot', () => {
  const live = makeRepo();
  const clone = makeRepo();
  withApplyEnv({ AGENT_MANAGER_APPLY_REPO_ROOT: clone }, () => {
    const { getRegisteredSource } = freshPlugin(live);
    const result = getRegisteredSource('unused_export').apply({
      implementResponse: strongBlock('Remove dead helper oldHelper', 'src/old.js'),
      task: { promptContext: { symbol: 'oldHelper' } },
    });
    assert.equal(result.candidateCount, 1);
    assert.equal(result.file, path.join(clone, 'Docs', 'DEAD_CODE_CANDIDATES.md'));
    assert.equal(countBlocks(path.join(clone, 'Docs', 'DEAD_CODE_CANDIDATES.md')), 1);
    assert.equal(fs.existsSync(path.join(live, 'Docs', 'DEAD_CODE_CANDIDATES.md')), false, 'the live checkout must stay clean');
  });
});

test('unused_export apply: the env override still wins over applyRepoRoot', () => {
  const live = makeRepo();
  const clone = makeRepo();
  const override = path.join(makeRepo(), 'Docs', 'DEAD_CODE_CANDIDATES.md');
  withApplyEnv({ AGENT_MANAGER_APPLY_REPO_ROOT: clone, AGENT_MANAGER_DEAD_CODE_CANDIDATES_PATH: override }, () => {
    const { getRegisteredSource } = freshPlugin(live);
    const result = getRegisteredSource('unused_export').apply({ implementResponse: strongBlock('Remove dead helper oldHelper', 'src/old.js'), task: { promptContext: { symbol: 'oldHelper' } } });
    assert.equal(result.file, override);
    assert.equal(fs.existsSync(path.join(clone, 'Docs', 'DEAD_CODE_CANDIDATES.md')), false);
  });
});

test('unused_export apply: applying the same approved Strong verdict twice leaves exactly one block and reports the duplicate', () => {
  const clone = makeRepo();
  withApplyEnv({ AGENT_MANAGER_APPLY_REPO_ROOT: clone }, () => {
    const { getRegisteredSource } = freshPlugin(makeRepo());
    const args = { implementResponse: strongBlock('Remove dead `DATE_LINE` constant and its sole import', 'src/doc-accuracy-check.js'), task: { promptContext: { symbol: 'DATE_LINE' } } };
    const first = getRegisteredSource('unused_export').apply(args);
    const second = getRegisteredSource('unused_export').apply(args);
    assert.equal(first.candidateCount, 1);
    assert.equal(second.skipped, true);
    assert.match(second.reason, /already exists/);
    assert.equal(countBlocks(path.join(clone, 'Docs', 'DEAD_CODE_CANDIDATES.md')), 1);
  });
});

for (const [symbol, title, file] of REAL_DUPLICATED_TITLES) {
  test(`unused_export apply: the real title "${title}" (no core title key) stays at one block across retried applies when the task carries its symbol`, () => {
    const clone = makeRepo();
    withApplyEnv({ AGENT_MANAGER_APPLY_REPO_ROOT: clone }, () => {
      const { candidateKey } = require('agent-manager/src/lib/candidate-dedupe.js');
      assert.equal(candidateKey({ title, files: file }), null, 'precondition: core cannot key this title on its own');
      const { getRegisteredSource } = freshPlugin(makeRepo());
      const args = { implementResponse: strongBlock(title, file), task: { promptContext: { symbol, definedIn: file } } };
      for (let i = 0; i < 5; i += 1) getRegisteredSource('unused_export').apply(args);
      assert.equal(countBlocks(path.join(clone, 'Docs', 'DEAD_CODE_CANDIDATES.md')), 1);
    });
  });
}

test('unused_export apply: a different symbol in the same file still appends (dedupe is per symbol, not per file)', () => {
  const clone = makeRepo();
  withApplyEnv({ AGENT_MANAGER_APPLY_REPO_ROOT: clone }, () => {
    const { getRegisteredSource } = freshPlugin(makeRepo());
    const src = getRegisteredSource('unused_export');
    src.apply({ implementResponse: strongBlock('Remove unused SOURCE_CONTRACT export', 'src/contract-spec.js'), task: { promptContext: { symbol: 'SOURCE_CONTRACT' } } });
    const other = src.apply({ implementResponse: strongBlock('Remove unused GATE_TEXT export', 'src/contract-spec.js'), task: { promptContext: { symbol: 'GATE_TEXT' } } });
    assert.equal(other.candidateCount, 1);
    assert.equal(countBlocks(path.join(clone, 'Docs', 'DEAD_CODE_CANDIDATES.md')), 2);
  });
});

test('unused_export apply: a task with no symbol still appends as before and requireStrength still drops a non-Strong block', () => {
  const clone = makeRepo();
  withApplyEnv({ AGENT_MANAGER_APPLY_REPO_ROOT: clone }, () => {
    const { getRegisteredSource } = freshPlugin(makeRepo());
    const src = getRegisteredSource('unused_export');
    const ok = src.apply({ implementResponse: strongBlock('Remove dead helper oldHelper', 'src/old.js') });
    assert.equal(ok.candidateCount, 1);
    const weak = src.apply({ implementResponse: strongBlock('Remove dead helper otherHelper', 'src/other.js').replace('Strength: Strong', 'Strength: Not actionable (false positive)'), task: { promptContext: { symbol: 'otherHelper' } } });
    assert.equal(weak.skipped, true);
    assert.equal(countBlocks(path.join(clone, 'Docs', 'DEAD_CODE_CANDIDATES.md')), 1);
  });
});

test('deadcode_fix reads the same applyRepoRoot-rooted file the unused_export apply hook writes', () => {
  const live = makeRepo();
  const clone = makeRepo();
  withApplyEnv({ AGENT_MANAGER_APPLY_REPO_ROOT: clone }, () => {
    const { getRegisteredSource } = freshPlugin(live);
    assert.equal(getRegisteredSource('deadcode_fix').candidatesPath(), path.join(clone, 'Docs', 'DEAD_CODE_CANDIDATES.md'));
  });
});
