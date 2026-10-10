'use strict';

// Pre-filter + re-admission for unused_export symbol flags. Pure-function tests plus generator-level tests that drive the real nextUnusedExportTask against a temp
// pipeline dir (same freshPlugin shape as unused-export.test.js).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const pf = require('./deadcode-prefilter.js');

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
  return { ...deps, nextUnusedExportTask: mod.nextUnusedExportTask };
}

function withMode(mode, fn) {
  const prev = process.env.AGENT_MANAGER_DEADCODE_PREFILTER;
  if (mode === undefined) delete process.env.AGENT_MANAGER_DEADCODE_PREFILTER; else process.env.AGENT_MANAGER_DEADCODE_PREFILTER = mode;
  try { return fn(); } finally { if (prev === undefined) delete process.env.AGENT_MANAGER_DEADCODE_PREFILTER; else process.env.AGENT_MANAGER_DEADCODE_PREFILTER = prev; }
}

const PROD = [{ file: 'src/App.tsx', line: 3 }, { file: 'src/App.tsx', line: 90 }];
function makeWorld(entries) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deadcode-prefilter-'));
  fs.mkdirSync(path.join(dir, 'queue', 'done'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'lib.js'), 'function widget() {}\nmodule.exports = { widget };\n');
  fs.writeFileSync(path.join(dir, 'queue', 'dead-code-flags.json'), JSON.stringify(entries));
  return dir;
}
const flag = (callSites, extra = {}) => ({ symbol: 'widget', definedIn: 'src/lib.js', callSites, scannedAt: '2026-10-01T00:00:00.000Z', ...extra });
const next = (dir) => { const p = freshPlugin(dir); return p.nextUnusedExportTask({ getConfig: p.getConfig, taskIdExistsInQueue: p.taskIdExistsInQueue }); };
const ledgerOf = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'queue', pf.LEDGER_NAME), 'utf8'));
const markDone = (dir, id) => fs.writeFileSync(path.join(dir, 'queue', 'done', `${id}.json`), JSON.stringify({ id }));

// ---- classification and fingerprint -------------------------------------------------------------------------------------------------------------

test('classifyCaller: self, test-ish, dead-file and production', () => {
  const dead = new Set(['src/orphan.tsx']);
  assert.equal(classify('src/lib.js'), 'self');
  for (const f of ['src/a.test.tsx', 'src/__tests__/a.ts', 'src/b.spec.js', 'src/c.stories.tsx', 'src/mocks/x.ts', 'test/y.js', 'src/types.d.ts']) assert.equal(classify(f), 'test', f);
  assert.equal(classify('src/orphan.tsx'), 'dead-file');
  assert.equal(classify('src/App.tsx'), 'production');
  function classify(f) { return pf.classifyCaller(f, 'src/lib.js', dead); }
});

test('fingerprint ignores line numbers and duplicate lines but changes when a caller file is added, removed or reclassified', () => {
  const dead = new Set();
  const fp = (cs) => pf.fingerprint(pf.callerKinds({ definedIn: 'src/lib.js', callSites: cs }, dead));
  const base = fp(PROD);
  assert.equal(fp([{ file: 'src/App.tsx', line: 11 }, { file: 'src/App.tsx', line: 12 }]), base);
  assert.equal(fp([{ file: 'src/App.tsx', line: 11 }]), base);
  assert.notEqual(fp([{ file: 'src/App.tsx', line: 1 }, { file: 'src/Other.tsx', line: 1 }]), base);
  assert.notEqual(fp([]), base);
  assert.notEqual(pf.fingerprint(pf.callerKinds({ definedIn: 'src/lib.js', callSites: PROD }, new Set(['src/App.tsx']))), base);   // the caller became dead
});

test('hasProductionCaller: only test/self/dead callers do not count', () => {
  assert.equal(pf.hasProductionCaller([{ file: 'a.test.js', kind: 'test' }, { file: 'x', kind: 'dead-file' }]), false);
  assert.equal(pf.hasProductionCaller([{ file: 'a.test.js', kind: 'test' }, { file: 'src/App.tsx', kind: 'production' }]), true);
});

test('prefilterMode: default shadow, off/on honoured', () => {
  assert.equal(withMode(undefined, () => pf.prefilterMode()), 'shadow');
  assert.equal(withMode('off', () => pf.prefilterMode()), 'off');
  assert.equal(withMode('on', () => pf.prefilterMode()), 'on');
  assert.equal(withMode('nonsense', () => pf.prefilterMode()), 'shadow');
});

// ---- generator-level -----------------------------------------------------------------------------------------------------------------------------

test('off: exactly the old behaviour -- a production-caller symbol becomes a task, no ledger written, no stamp', () => {
  const dir = makeWorld([flag(PROD)]);
  const t = withMode('off', () => next(dir));
  assert.equal(t.id, 'deadcode-widget-src-lib-js');
  assert.equal(t.promptContext.prefilter, undefined);
  assert.equal(fs.existsSync(path.join(dir, 'queue', pf.LEDGER_NAME)), false);
});

test('shadow (the default): the task is still created and stamped with the prediction and fingerprint', () => {
  const dir = makeWorld([flag(PROD)]);
  const t = withMode(undefined, () => next(dir));
  assert.equal(t.id, 'deadcode-widget-src-lib-js');
  assert.equal(t.promptContext.prefilter.prediction, 'dismiss');
  assert.match(t.promptContext.prefilter.fp, /^[0-9a-f]{12}$/);
  assert.equal(ledgerOf(dir).seen['deadcode-widget-src-lib-js'].fp, t.promptContext.prefilter.fp);
});

test('shadow: a symbol with no production caller is predicted for the model, not dismissed', () => {
  const dir = makeWorld([flag([{ file: 'src/a.test.js', line: 1 }])]);
  assert.equal(withMode('shadow', () => next(dir)).promptContext.prefilter.prediction, 'llm');
});

// spot-check share: find a fingerprint-producing caller set that is / is not in the 1-in-10 share
function callersWhere(spot) {
  for (let i = 0; i < 500; i++) {
    const cs = [{ file: `src/Caller${i}.tsx`, line: 1 }];
    const fp = pf.fingerprint(pf.callerKinds({ definedIn: 'src/lib.js', callSites: cs }, new Set()));
    if (pf.isSpotCheck(fp) === spot) return cs;
  }
  throw new Error('no caller set found');
}

test('on: a symbol with a production caller is skipped and recorded in the ledger with its evidence; nothing is returned', () => {
  const dir = makeWorld([flag(callersWhere(false))]);
  assert.equal(withMode('on', () => next(dir)), null);
  const l = ledgerOf(dir);
  assert.equal(Object.keys(l.dismissed).length, 1);
  assert.equal(l.dismissed['deadcode-widget-src-lib-js'].callers[0].kind, 'production');
});

test('on: the spot-check share is still drafted and stamped spotCheck', () => {
  const dir = makeWorld([flag(callersWhere(true))]);
  const t = withMode('on', () => next(dir));
  assert.equal(t.promptContext.prefilter.spotCheck, true);
});

test('on: a symbol with NO production caller always goes to the model', () => {
  const dir = makeWorld([flag([])]);
  assert.equal(withMode('on', () => next(dir)).id, 'deadcode-widget-src-lib-js');
});

test('on: a dismissal does not block the next flag in the same tick', () => {
  const dir = makeWorld([flag(callersWhere(false)), flag([], { symbol: 'other', definedIn: 'src/lib.js', scannedAt: '2026-10-02T00:00:00.000Z' })]);
  fs.writeFileSync(path.join(dir, 'src', 'lib.js'), 'function widget() {}\nfunction other() {}\nmodule.exports = { widget, other };\n');
  assert.equal(withMode('on', () => next(dir)).promptContext.symbol, 'other');
});

test('on: a dismissed symbol whose last production caller disappears is picked up on the next scan under the SAME id (no task existed)', () => {
  const dir = makeWorld([flag(callersWhere(false))]);
  withMode('on', () => next(dir));
  fs.writeFileSync(path.join(dir, 'queue', 'dead-code-flags.json'), JSON.stringify([flag([])]));
  const t = withMode('on', () => next(dir));
  assert.equal(t.id, 'deadcode-widget-src-lib-js');
  assert.equal(ledgerOf(dir).dismissed['deadcode-widget-src-lib-js'], undefined);
});

test('an already-triaged symbol with no ledger entry gets a BASELINE fingerprint and is not re-triaged', () => {
  const dir = makeWorld([flag(PROD)]);
  markDone(dir, 'deadcode-widget-src-lib-js');
  assert.equal(withMode('shadow', () => next(dir)), null);
  assert.ok(ledgerOf(dir).seen['deadcode-widget-src-lib-js'].fp);
});

test('re-admission: a triaged symbol whose caller set changes is re-triaged under a new -r<fp8> id, once', () => {
  const dir = makeWorld([flag(PROD)]);
  markDone(dir, 'deadcode-widget-src-lib-js');
  withMode('shadow', () => next(dir));                                   // baseline
  assert.equal(withMode('shadow', () => next(dir)), null);              // unchanged: still skipped
  fs.writeFileSync(path.join(dir, 'queue', 'dead-code-flags.json'), JSON.stringify([flag([{ file: 'src/a.test.js', line: 1 }])]));   // the production caller is gone
  const t = withMode('shadow', () => next(dir));
  assert.match(t.id, /^deadcode-widget-src-lib-js-r[0-9a-f]{8}$/);
  assert.equal(t.promptContext.prefilter.readmitted, true);
  assert.equal(t.promptContext.prefilter.prediction, 'llm');
  markDone(dir, t.id);
  assert.equal(withMode('shadow', () => next(dir)), null);              // once: the new id exists, nothing more until the evidence changes again
});

test('re-admission also works in on mode and for a symbol that gained a production caller (fingerprint change either way)', () => {
  const dir = makeWorld([flag([{ file: 'src/a.test.js', line: 1 }])]);
  markDone(dir, 'deadcode-widget-src-lib-js');
  withMode('on', () => next(dir));
  fs.writeFileSync(path.join(dir, 'queue', 'dead-code-flags.json'), JSON.stringify([flag([])]));
  assert.match(withMode('on', () => next(dir)).id, /-r[0-9a-f]{8}$/);
});

test('whole-file entries are untouched by the pre-filter', () => {
  const dir = makeWorld([{ kind: 'file', symbol: '(file)', definedIn: 'src/lib.js', exports: ['widget'], callSites: [], scannedAt: '2026-10-01T00:00:00.000Z' }]);
  const t = withMode('on', () => next(dir));
  assert.equal(t.id, 'deadcode-file-src-lib-js');
  assert.equal(t.promptContext.prefilter, undefined);
});

test('a caller that is itself a flagged dead file does not count as production', () => {
  const dir = makeWorld([
    flag([{ file: 'src/orphan.tsx', line: 1 }]),
    { kind: 'file', symbol: '(file)', definedIn: 'src/orphan.tsx', exports: ['Orphan'], callSites: [], scannedAt: '2026-10-05T00:00:00.000Z' },
  ]);
  fs.writeFileSync(path.join(dir, 'src', 'orphan.tsx'), 'export const Orphan = 1;\n');
  assert.equal(withMode('on', () => next(dir)).id, 'deadcode-widget-src-lib-js');
});

test('fail open: an unwritable ledger location never throws and the task is still produced', () => {
  const dir = makeWorld([flag([])]);
  fs.writeFileSync(path.join(dir, 'queue', pf.LEDGER_NAME), '{ not json');          // corrupt ledger
  assert.equal(withMode('on', () => next(dir)).id, 'deadcode-widget-src-lib-js');
  const dir2 = makeWorld([flag([])]);
  fs.mkdirSync(path.join(dir2, 'queue', pf.LEDGER_NAME));                           // a directory where the file should be: every write fails
  assert.equal(withMode('shadow', () => next(dir2)).id, 'deadcode-widget-src-lib-js');
});

test('a re-admitted symbol that is used inside its own defining file is NOT re-triaged (same-file-use guard still applies)', () => {
  const dir = makeWorld([flag(PROD)]);
  fs.writeFileSync(path.join(dir, 'src', 'lib.js'), 'function widget() {}\nfunction main() { return widget(); }\nmodule.exports = { main, widget };\n');
  markDone(dir, 'deadcode-widget-src-lib-js');
  withMode('shadow', () => next(dir));                                                                                    // baseline
  fs.writeFileSync(path.join(dir, 'queue', 'dead-code-flags.json'), JSON.stringify([flag([{ file: 'src/a.test.js', line: 1 }])]));
  assert.equal(withMode('shadow', () => next(dir)), null);
});

test('compareShadow: counts predictions against outcomes and refuses promotion on any dead-dismissed or too few samples', () => {
  const mk = (id, prediction, disp, strength) => ({ id, promptContext: { prefilter: { prediction } }, terminalDisposition: disp, implementResponse: strength ? `### AC-1\nStrength: ${strength}\n` : '' });
  const ok = Array.from({ length: pf.MIN_SAMPLES }, (_, i) => mk(`a${i}`, 'dismiss', 'noop'));
  const r = pf.compareShadow(ok);
  assert.equal(r.table.dismissAlive, pf.MIN_SAMPLES); assert.equal(r.promote, true);
  assert.equal(pf.compareShadow(ok.slice(0, 5)).promote, false);
  const bad = pf.compareShadow([...ok, mk('d1', 'dismiss', 'merged', 'Strong')]);
  assert.deepEqual(bad.deadDismissed, ['d1']); assert.equal(bad.promote, false);
  assert.equal(pf.compareShadow([mk('x', 'llm', 'merged', 'Not actionable (false positive)')]).table.llmAlive, 1);
  assert.equal(pf.compareShadow([{ id: 'u', promptContext: { prefilter: { prediction: 'llm' } } }]).table.undecided, 1);
});
