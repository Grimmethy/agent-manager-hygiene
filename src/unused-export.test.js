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

test('unused_export declares its own dead-code review guidance, directToMain, and groundingFields on callSites', () => {
  const dir = makeRepo();
  const { getRegisteredSource } = freshPlugin(dir);
  const src = getRegisteredSource('unused_export');
  assert.equal(src.directToMain, true);
  assert.deepEqual(src.groundingFields, ['callSites']);
  assert.match(src.reviewGuidance, /NOT itself a code change/);
  assert.match(src.reviewCompletenessQuestion, /decisive GENUINE-or-FALSE-POSITIVE-or-UNCERTAIN verdict/);
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
