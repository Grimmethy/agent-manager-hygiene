'use strict';

// Tests for triage-gate.js / triage-sources.js: the narrow-verdict variants performance_triage and observability_triage.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const LOOP = 'for (const item of items) {\n  await fetch(item.url);\n}\n';

function fresh() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'triage-gate-test-'));
  process.env.AGENT_MANAGER_REPO_ROOT = dir;
  process.env.AGENT_MANAGER_PIPELINE_DIR = dir;
  delete process.env.AGENT_MANAGER_TRIAGE_GATE;
  const registry = require('agent-manager/src/task-source-registry.js');
  registry.clearRegistry();
  require('agent-manager/src/model-profile-registry.js').clearModelProfileRegistry();
  delete require.cache[require.resolve('agent-manager/src/task-sources.js')];
  for (const m of ['./performance-review.js', './observability-review.js', './triage-gate.js', './triage-sources.js']) delete require.cache[require.resolve(m)];
  const { getConfig } = require('agent-manager/src/config.js');
  const { nextCandidateFulfillmentTask, taskIdExistsInQueue, taskPriority } = require('agent-manager/src/task-sources.js');
  const deps = { getConfig, nextCandidateFulfillmentTask, taskIdExistsInQueue, taskPriority };
  require('./performance-review.js').register(deps);
  require('./observability-review.js').register(deps);
  require('./triage-sources.js').register(deps);
  fs.writeFileSync(path.join(dir, 'worker.js'), LOOP);
  return { dir, registry, gate: require('./triage-gate.js'), store: require('./suppression-store.js') };
}

const nextOf = (f, name) => f.registry.getRegisteredSource(name).next();

test('both variants are registered with variantOf pointing at their parents, ahead of them in priority', () => {
  const f = fresh();
  for (const [v, p] of [['performance_triage', 'performance_review'], ['observability_triage', 'observability_review']]) {
    const e = f.registry.getRegisteredSource(v);
    assert.equal(e.variantOf, p);
    assert.ok(e.priority < f.registry.getRegisteredSource(p).priority);
    assert.equal(e.advisoryProse, true);
  }
});

test('parseTriageVerdict accepts the strict shape and treats everything else as uncertain, never false_positive', () => {
  const { parseTriageVerdict } = fresh().gate;
  assert.deepEqual(parseTriageVerdict('{"verdict":"false_positive","reason":"runs once at startup"}'), { verdict: 'false_positive', reason: 'runs once at startup', valid: true });
  assert.equal(parseTriageVerdict('```json\n{"verdict":"real","reason":"x"}\n```').verdict, 'real');
  for (const bad of ['', 'false_positive', 'The verdict is false_positive', '{"verdict":"false_positive"}', '{"verdict":"false_positive","reason":"x","extra":1}',
    '{"verdict":"fine","reason":"x"}', '{"verdict":"false_positive","reason":"  "}', '[{"verdict":"false_positive","reason":"x"}]', '{"verdict":"false_positive","reason":"x"} trailing', '{bad json}']) {
    const r = parseTriageVerdict(bad);
    assert.equal(r.verdict, 'uncertain', bad);
    assert.equal(r.valid, false, bad);
  }
});

test('the plan prompt carries only the rule, detail and snippet window, and asks for the JSON answer', () => {
  const f = fresh();
  const task = nextOf(f, 'performance_triage');
  const prompt = f.registry.getRegisteredSource('performance_triage').buildPlanPrompt(task);
  assert.match(prompt, /fetch\(item\.url\)/);
  assert.match(prompt, /"verdict": "real" \| "false_positive" \| "uncertain"/);
  assert.ok(!/numbered PLAN/i.test(prompt));
  assert.ok(!/PROJECT CAPABILITIES/i.test(prompt));
});

test('next() relabels the parent finding: triage id, triage source, original id kept in promptContext', () => {
  const f = fresh();
  const t = nextOf(f, 'performance_triage');
  assert.equal(t.source, 'performance_triage');
  assert.match(t.id, /^performance-triage-/);
  assert.equal(t.promptContext.triageOf, t.id.replace('performance-triage-', 'performance-'));
  assert.ok(t.promptContext.snippet.includes('fetch'));
});

test('next() skips a finding whose parent task or triage task already exists, including a finished triage task', () => {
  const f = fresh();
  const t = nextOf(f, 'performance_triage');
  const mk = (stage, id) => { fs.mkdirSync(path.join(f.dir, 'queue', stage), { recursive: true }); fs.writeFileSync(path.join(f.dir, 'queue', stage, `${id}.json`), '{}'); };
  mk('done', t.id);
  assert.equal(nextOf(f, 'performance_triage'), null, 'a finished triage task is one verdict per finding');
  const g = fresh();
  const t2 = nextOf(g, 'performance_triage');
  const mk2 = (stage, id) => { fs.mkdirSync(path.join(g.dir, 'queue', stage), { recursive: true }); fs.writeFileSync(path.join(g.dir, 'queue', stage, `${id}.json`), '{}'); };
  mk2('pending', t2.promptContext.triageOf);
  assert.equal(nextOf(g, 'performance_triage'), null, 'the parent already queued this finding');
});

test('the parent defers to a fresh in-flight triage task, resumes when it is done or stale', () => {
  const f = fresh();
  const t = nextOf(f, 'performance_triage');
  const stageDir = path.join(f.dir, 'queue', 'drafting', 'worker-rx580');
  fs.mkdirSync(stageDir, { recursive: true });
  const file = path.join(stageDir, `${t.id}.json`);
  fs.writeFileSync(file, '{}');
  assert.equal(nextOf(f, 'performance_review'), null, 'fresh in-flight triage holds the parent back');
  const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
  fs.utimesSync(file, old, old);
  assert.ok(nextOf(f, 'performance_review'), 'a stale triage task must not strand the finding');
  fs.rmSync(file);
  fs.mkdirSync(path.join(f.dir, 'queue', 'done'), { recursive: true });
  fs.writeFileSync(path.join(f.dir, 'queue', 'done', `${t.id}.json`), '{}');
  assert.ok(nextOf(f, 'performance_review'), 'once the triage task is done the parent reviews the finding');
});

test('mode defaults to shadow; off emits no triage task and stops deferring', () => {
  const f = fresh();
  assert.equal(f.gate.triageMode(), 'shadow');
  process.env.AGENT_MANAGER_TRIAGE_GATE = 'off';
  try {
    assert.equal(nextOf(f, 'performance_triage'), null);
    assert.equal(f.gate.triageMode(), 'off');
  } finally { delete process.env.AGENT_MANAGER_TRIAGE_GATE; }
});

function applyWith(f, mode, verdictText) {
  const task = { id: 'performance-triage-x', promptContext: nextOf(f, 'performance_triage').promptContext };
  const res = f.gate.applyTriage({ implementResponse: verdictText, task, pipelineDir: f.dir, mode });
  return { task, res, ctx: task.promptContext };
}
const FP = '{"verdict":"false_positive","reason":"bounded"}';

test('shadow mode records the verdict on the task and writes no suppression', () => {
  const f = fresh();
  const { task, res, ctx } = applyWith(f, 'shadow', FP);
  assert.equal(task.triageVerdict.verdict, 'false_positive');
  assert.equal(task.triageVerdict.suppressed, false);
  assert.equal(task.reviewDisposition, 'inconclusive');
  assert.equal(res.skipped, true);
  assert.equal(f.store.isSuppressed(f.dir, ctx.rule, ctx.snippet), false);
  assert.deepEqual(f.store.readRows(f.dir), []);
});

test('enforce mode writes exactly one suppression with cause triage-gate, keyed like the parent', () => {
  const f = fresh();
  const { task, ctx } = applyWith(f, 'enforce', FP);
  const rows = f.store.readRows(f.dir);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].cause, 'triage-gate');
  assert.equal(f.store.isSuppressed(f.dir, ctx.rule, ctx.snippet), true);
  assert.equal(task.reviewDisposition, 'dismissed');
  assert.equal(nextOf(f, 'performance_review'), null, 'the parent no longer emits the suppressed construct');
});

test('real, uncertain and unparseable answers never write a suppression, even in enforce mode', () => {
  for (const text of ['{"verdict":"real","reason":"blocking"}', '{"verdict":"uncertain","reason":"unknown"}', 'false_positive', '{"verdict":"false_positive"}']) {
    const f = fresh();
    const { task } = applyWith(f, 'enforce', text);
    assert.deepEqual(f.store.readRows(f.dir), [], text);
    assert.equal(task.reviewDisposition, 'inconclusive', text);
  }
});

test('a verdict that is only valid in the plan response is still read (the implement pass echoes it)', () => {
  const f = fresh();
  const task = { id: 'x', planResponse: FP, promptContext: nextOf(f, 'performance_triage').promptContext };
  f.gate.applyTriage({ implementResponse: 'Sure, here you go', task, pipelineDir: f.dir, mode: 'enforce' });
  assert.equal(f.store.readRows(f.dir).length, 1);
});
