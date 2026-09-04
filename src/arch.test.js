'use strict';

// Tests for the arch task sources -- nextArchImportTask (scans deep_dive's analysis docs
// for promotable items), applyArchImportCandidate, and a register()/nextArchDiscoveryTask
// smoke check. Moved here (2026-08-27, Phase 2) from agent-manager's task-sources.test.js
// and apply-group-a.test.js when arch_* moved into this plugin; fixtures and assertions are
// otherwise unchanged. Setup registers the sources through arch.js's own register() with
// the injected-deps bag pulled from the agent-manager package.

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');

function analysisItem({ id, title = 'Some Pattern', community = 'shared', rating = 'Adapt', files = 'Foo.ts', rationale = 'Some rationale text.' } = {}) {
  const lines = [`## ${title}`, ''];
  if (id) lines.push(`**ID:** ${id}`);
  lines.push(`**Community:** ${community}`, `**Rating:** ${rating}`, `**Files:** ${files}`, '', rationale);
  return lines.join('\n');
}

function candidateBlock({ id = 'AC-1', title = 'Some Title', strength = 'Strong', source = null, files = 'a.js, b.js', body = 'Problem:\nSomething.\n\nSolution:\nFix it.\n\nBenefits:\nBetter.' } = {}) {
  const lines = [`### ${id} · ${title}`, `Strength: ${strength}`];
  if (source) lines.push(`Source: ${source}`);
  lines.push(`Files: ${files}`, '', body);
  return lines.join('\n');
}

function freshPlugin(repoRoot) {
  process.env.AGENT_MANAGER_REPO_ROOT = repoRoot;
  process.env.AGENT_MANAGER_PIPELINE_DIR = repoRoot;
  const registry = require('agent-manager/src/task-source-registry.js');
  registry.clearRegistry();
  const { clearModelProfileRegistry } = require('agent-manager/src/model-profile-registry.js');
  clearModelProfileRegistry();
  delete require.cache[require.resolve('agent-manager/src/task-sources.js')];
  delete require.cache[require.resolve('./arch.js')];
  const { getConfig } = require('agent-manager/src/config.js');
  const { nextCandidateFulfillmentTask, taskIdExistsInQueue, taskPriority } = require('agent-manager/src/task-sources.js');
  const deps = { getConfig, nextCandidateFulfillmentTask, taskIdExistsInQueue, taskPriority };
  const mod = require('./arch.js');
  mod.register(deps);
  return {
    getRegisteredSource: registry.getRegisteredSource,
    applyArchImportCandidate: mod.applyArchImportCandidate,
    nextArchImportTask: () => mod.nextArchImportTask({ getConfig, taskIdExistsInQueue }),
    nextArchDiscoveryTask: () => mod.nextArchDiscoveryTask({ getConfig, taskIdExistsInQueue }),
  };
}

function makeFixtureRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arch-test-'));
  fs.mkdirSync(path.join(dir, 'analysis'), { recursive: true });
  process.env.AGENT_MANAGER_DEEP_DIVE_ANALYSIS_DIR = path.join(dir, 'analysis');
  process.env.AGENT_MANAGER_DEEP_DIVE_COVERAGE_PATH = path.join(dir, 'deep-dive-coverage.json');
  process.env.AGENT_MANAGER_IMPORT_COVERAGE_PATH = path.join(dir, 'import-coverage.json');
  process.env.AGENT_MANAGER_ARCH_IMPORT_CANDIDATES_PATH = path.join(dir, 'ARCH_IMPORT_CANDIDATES.md');
  return dir;
}

// nextArchImportTask (2026-07-27 scoping fix) only offers candidates from an analysis doc
// whose deep-dive-coverage.json entry records relevantToProject matching the CURRENT
// repoRoot's project tag (path.basename(repoRoot)).
function markRelevantToCurrentProject(dir, ...slugs) {
  const coveragePath = path.join(dir, 'deep-dive-coverage.json');
  let coverage;
  try {
    coverage = JSON.parse(fs.readFileSync(coveragePath, 'utf8'));
  } catch {
    coverage = { projects: {} };
  }
  if (!coverage.projects) coverage.projects = {};
  const projectTag = path.basename(dir);
  for (const slug of slugs) {
    coverage.projects[slug] = { ...(coverage.projects[slug] || {}), relevantToProject: projectTag };
  }
  fs.writeFileSync(coveragePath, JSON.stringify(coverage, null, 2));
}

test('nextArchImportTask returns null when the analysis dir does not exist', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arch-test-'));
  process.env.AGENT_MANAGER_DEEP_DIVE_ANALYSIS_DIR = path.join(dir, 'nonexistent');
  process.env.AGENT_MANAGER_IMPORT_COVERAGE_PATH = path.join(dir, 'import-coverage.json');
  const { nextArchImportTask } = freshPlugin(dir);
  assert.equal(nextArchImportTask(), null);
});

test('nextArchImportTask ignores items with no **ID:** at all (pre-existing, never considered)', () => {
  const dir = makeFixtureRepo();
  fs.writeFileSync(path.join(dir, 'analysis', 'proj.md'), '# proj — Deep Dive\n\n' + analysisItem({ id: null, rating: 'Use' }));
  markRelevantToCurrentProject(dir, 'proj');
  const { nextArchImportTask } = freshPlugin(dir);
  assert.equal(nextArchImportTask(), null);
});

test('nextArchImportTask ignores Ignore-rated items -- nothing to promote from an honest negative', () => {
  const dir = makeFixtureRepo();
  fs.writeFileSync(path.join(dir, 'analysis', 'proj.md'), '# proj — Deep Dive\n\n' + analysisItem({ id: 'proj-1', rating: 'Ignore' }));
  markRelevantToCurrentProject(dir, 'proj');
  const { nextArchImportTask } = freshPlugin(dir);
  assert.equal(nextArchImportTask(), null);
});

test('nextArchImportTask picks up a real Use-rated item and builds correct promptContext', () => {
  const dir = makeFixtureRepo();
  fs.writeFileSync(
    path.join(dir, 'analysis', 'crewai.md'),
    '# crewai — Deep Dive\n\n' + analysisItem({ id: 'crewai-14', title: 'Per-project settings store', rating: 'Use', files: 'settings.py', rationale: 'A validated settings pattern worth taking.' })
  );
  markRelevantToCurrentProject(dir, 'crewai');
  const { nextArchImportTask } = freshPlugin(dir);
  const task = nextArchImportTask();
  assert.ok(task, 'expected a task, got null');
  assert.equal(task.id, 'arch-import-crewai-14');
  assert.equal(task.source, 'arch_import');
  assert.equal(task.promptContext.itemId, 'crewai-14');
  assert.equal(task.promptContext.sourceProject, 'crewai');
  assert.equal(task.promptContext.itemTitle, 'Per-project settings store');
  assert.equal(task.promptContext.rating, 'Use');
  assert.equal(task.promptContext.itemFiles, 'settings.py');
  assert.match(task.promptContext.itemRationale, /validated settings pattern/);
});

test('nextArchImportTask registers newly-seen items in import-coverage.json even ones it does not return', () => {
  const dir = makeFixtureRepo();
  fs.writeFileSync(
    path.join(dir, 'analysis', 'proj.md'),
    '# proj — Deep Dive\n\n' + [analysisItem({ id: 'proj-1', rating: 'Ignore' }), analysisItem({ id: 'proj-2', rating: 'Use' })].join('\n\n')
  );
  markRelevantToCurrentProject(dir, 'proj');
  const { nextArchImportTask } = freshPlugin(dir);
  nextArchImportTask();
  const coverage = JSON.parse(fs.readFileSync(process.env.AGENT_MANAGER_IMPORT_COVERAGE_PATH, 'utf8'));
  assert.ok('proj-1' in coverage.items, 'Ignore-rated item should still be registered, just never promoted');
  assert.equal(coverage.items['proj-1'].promotedAt, null);
  assert.ok('proj-2' in coverage.items);
});

test('nextArchImportTask never re-offers an already-promoted item', () => {
  const dir = makeFixtureRepo();
  fs.writeFileSync(path.join(dir, 'analysis', 'proj.md'), '# proj — Deep Dive\n\n' + analysisItem({ id: 'proj-1', rating: 'Use' }));
  fs.writeFileSync(process.env.AGENT_MANAGER_IMPORT_COVERAGE_PATH, JSON.stringify({ items: { 'proj-1': { promotedAt: '2026-01-01T00:00:00.000Z', candidateId: 'AC-1', projectSlug: 'proj' } } }));
  markRelevantToCurrentProject(dir, 'proj');
  const { nextArchImportTask } = freshPlugin(dir);
  assert.equal(nextArchImportTask(), null);
});

test('nextArchImportTask retries a previously-skipped (zero-harness-grounding) item once its retry cooldown has elapsed', () => {
  const dir = makeFixtureRepo();
  fs.writeFileSync(path.join(dir, 'analysis', 'proj.md'), '# proj — Deep Dive\n\n' + analysisItem({ id: 'proj-1', rating: 'Use' }));
  fs.writeFileSync(process.env.AGENT_MANAGER_IMPORT_COVERAGE_PATH, JSON.stringify({
    items: { 'proj-1': { promotedAt: null, candidateId: null, lastAttemptedAt: '2020-01-01T00:00:00.000Z', projectSlug: 'proj' } },
  }));
  markRelevantToCurrentProject(dir, 'proj');
  const { nextArchImportTask } = freshPlugin(dir);
  const task = nextArchImportTask();
  assert.ok(task, 'expected the skipped item to be retryable once its cooldown elapsed');
  assert.equal(task.id, 'arch-import-proj-1');
});

test('nextArchImportTask does not re-offer a skipped item still inside its retry cooldown', () => {
  const dir = makeFixtureRepo();
  fs.writeFileSync(path.join(dir, 'analysis', 'proj.md'), '# proj — Deep Dive\n\n' + analysisItem({ id: 'proj-1', rating: 'Use' }));
  fs.writeFileSync(process.env.AGENT_MANAGER_IMPORT_COVERAGE_PATH, JSON.stringify({
    items: { 'proj-1': { promotedAt: null, candidateId: null, lastAttemptedAt: new Date().toISOString(), projectSlug: 'proj' } },
  }));
  markRelevantToCurrentProject(dir, 'proj');
  const { nextArchImportTask } = freshPlugin(dir);
  assert.equal(nextArchImportTask(), null);
});

test('nextArchImportTask skips an item already sitting in the queue', () => {
  const dir = makeFixtureRepo();
  fs.writeFileSync(path.join(dir, 'analysis', 'proj.md'), '# proj — Deep Dive\n\n' + analysisItem({ id: 'proj-1', rating: 'Use' }));
  fs.mkdirSync(path.join(dir, 'queue', 'pending'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'queue', 'pending', 'arch-import-proj-1.json'), '{}');
  markRelevantToCurrentProject(dir, 'proj');
  const { nextArchImportTask } = freshPlugin(dir);
  assert.equal(nextArchImportTask(), null);
});

test('nextArchImportTask excludes an analysis doc whose deep-dive-coverage entry belongs to a DIFFERENT project (2026-07-27 scoping fix)', () => {
  const dir = makeFixtureRepo();
  fs.writeFileSync(path.join(dir, 'analysis', 'proj.md'), '# proj — Deep Dive\n\n' + analysisItem({ id: 'proj-1', rating: 'Use' }));
  fs.writeFileSync(path.join(dir, 'deep-dive-coverage.json'), JSON.stringify({
    projects: { proj: { relevantToProject: 'some-totally-different-project' } },
  }));
  const { nextArchImportTask } = freshPlugin(dir);
  assert.equal(nextArchImportTask(), null, 'a candidate tagged for a different project must never be offered here');
});

test('nextArchImportTask excludes an analysis doc with NO deep-dive-coverage entry at all (legacy, predates the scoping fix)', () => {
  const dir = makeFixtureRepo();
  fs.writeFileSync(path.join(dir, 'analysis', 'proj.md'), '# proj — Deep Dive\n\n' + analysisItem({ id: 'proj-1', rating: 'Use' }));
  const { nextArchImportTask } = freshPlugin(dir);
  assert.equal(nextArchImportTask(), null, 'an untagged legacy doc must fail closed, not be silently offered');
});

test('full round-trip: nextArchImportTask -> applyArchImportCandidate -> arch_import_review sees it', () => {
  const dir = makeFixtureRepo();
  fs.writeFileSync(
    path.join(dir, 'analysis', 'crewai.md'),
    '# crewai — Deep Dive\n\n' + analysisItem({ id: 'crewai-14', title: 'Per-project settings store', rating: 'Use', files: 'settings.py' })
  );
  markRelevantToCurrentProject(dir, 'crewai');
  const { nextArchImportTask, applyArchImportCandidate, getRegisteredSource } = freshPlugin(dir);

  const task = nextArchImportTask();
  assert.ok(task);

  const implementResponse = [
    '### AC-1 · Per-project config module',
    'Strength: Strong',
    'Source: crewai — "Per-project settings store"',
    'Files: src/config.js',
    '',
    'Problem:\nagent-manager lacks per-project settings.\n\nSolution:\nAdd a settings module.\n\nBenefits:\nConsistent config.',
  ].join('\n');

  const applyResult = applyArchImportCandidate({
    implementResponse,
    candidatesPath: process.env.AGENT_MANAGER_ARCH_IMPORT_CANDIDATES_PATH,
    importCoveragePath: process.env.AGENT_MANAGER_IMPORT_COVERAGE_PATH,
    task,
  });
  assert.equal(applyResult.candidateCount, 1);

  const coverage = JSON.parse(fs.readFileSync(process.env.AGENT_MANAGER_IMPORT_COVERAGE_PATH, 'utf8'));
  assert.ok(coverage.items['crewai-14'].promotedAt, 'should be stamped as promoted now');
  assert.equal(coverage.items['crewai-14'].candidateId, 'AC-1');

  assert.equal(nextArchImportTask(), null);

  const archImportReview = getRegisteredSource('arch_import_review');
  const fulfillmentTask = archImportReview.next();
  assert.ok(fulfillmentTask, 'arch_import_review found nothing -- the written candidate is not being recognized');
  assert.equal(fulfillmentTask.source, 'arch_import_review');
  assert.equal(fulfillmentTask.promptContext.candidateId, 'AC-1');
  assert.deepEqual(fulfillmentTask.promptContext.files, ['src/config.js']);
});

// --- premiseCheck wiring (AC-8 incident, 2026-09-04) ------------------------------------

test('arch_import_review.next() stamps promptContext.premiseEvidence, deterministically, from a checkably-false Problem claim', () => {
  const dir = makeFixtureRepo();
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  // Same shape as the real src/review-task.js: many return sites, a small shared field
  // vocabulary -- contradicts an "each...own" claim.
  fs.writeFileSync(path.join(dir, 'src', 'gate.js'), [
    "function f1(){ return { succeeded: true, verdict: 'a' }; }",
    "function f2(){ return { succeeded: true, verdict: 'b', reason: 'x' }; }",
    "function f3(){ return { succeeded: true, verdict: 'c', reason: 'y' }; }",
    "function f4(){ return { succeeded: true, verdict: 'd' }; }",
    "function f5(){ return { succeeded: true, verdict: 'e', reason: 'z' }; }",
  ].join('\n'));
  fs.writeFileSync(
    path.join(dir, 'analysis', 'ghost.md'),
    '# ghost — Deep Dive\n\n' + analysisItem({ id: 'ghost-1', title: 'Adopt shared verdict vocabulary', rating: 'Use', files: 'src/gate.js' })
  );
  markRelevantToCurrentProject(dir, 'ghost');
  const { nextArchImportTask, applyArchImportCandidate, getRegisteredSource } = freshPlugin(dir);
  const importTask = nextArchImportTask();

  const implementResponse = [
    '### AC-1 · Adopt shared verdict vocabulary',
    'Strength: Strong',
    'Source: ghost — "Adopt shared verdict vocabulary"',
    'Files: src/gate.js',
    '',
    'Problem:\nsrc/gate.js is ad hoc -- each call site decides its own field names for the verdict.\n\nSolution:\nStandardize the fields.\n\nBenefits:\nConsistency.',
  ].join('\n');
  applyArchImportCandidate({
    implementResponse,
    candidatesPath: process.env.AGENT_MANAGER_ARCH_IMPORT_CANDIDATES_PATH,
    importCoveragePath: process.env.AGENT_MANAGER_IMPORT_COVERAGE_PATH,
    task: importTask,
  });

  const fulfillmentTask = getRegisteredSource('arch_import_review').next();
  assert.ok(fulfillmentTask);
  assert.ok(fulfillmentTask.promptContext.premiseEvidence, 'premiseEvidence must be stamped');
  assert.equal(fulfillmentTask.promptContext.premiseEvidence.contradictions.length, 1);
  assert.equal(fulfillmentTask.promptContext.premiseEvidence.contradictions[0].kind, 'uniform-return');
});

test('arch_import_review registration carries groundingFields, reviewGuidance, and premiseCheck', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arch-test-'));
  const { getRegisteredSource } = freshPlugin(dir);
  const s = getRegisteredSource('arch_import_review');
  assert.deepEqual(s.groundingFields, ['premiseEvidence']);
  assert.match(s.reviewGuidance, /premiseEvidence/);
  assert.equal(typeof s.premiseCheck, 'function');
});

// --- applyArchImportCandidate unit tests (moved from apply-group-a.test.js) -------------

test('applyArchImportCandidate leaves promotedAt null (not stamped) on a skipped/empty implement response', () => {
  const dir = makeFixtureRepo();
  const { applyArchImportCandidate } = freshPlugin(dir);
  const candidatesPath = path.join(dir, 'ARCH_IMPORT_CANDIDATES.md');
  const importCoveragePath = path.join(dir, 'import-coverage.json');
  const task = { promptContext: { itemId: 'proj-1', sourceProject: 'proj' } };

  const result = applyArchImportCandidate({ implementResponse: '', candidatesPath, importCoveragePath, task });
  assert.equal(result.skipped, true);
  assert.equal(fs.existsSync(candidatesPath), false, 'no candidates doc should be created on a skip');

  const coverage = JSON.parse(fs.readFileSync(importCoveragePath, 'utf8'));
  assert.equal(coverage.items['proj-1'].promotedAt, null);
  assert.equal(coverage.items['proj-1'].candidateId, null);
  assert.ok(coverage.items['proj-1'].lastAttemptedAt, 'lastAttemptedAt should still be recorded so a retry cooldown can apply');
});

test('applyArchImportCandidate stamps promotedAt/candidateId only when a real candidate was produced', () => {
  const dir = makeFixtureRepo();
  const { applyArchImportCandidate } = freshPlugin(dir);
  const candidatesPath = path.join(dir, 'ARCH_IMPORT_CANDIDATES.md');
  const importCoveragePath = path.join(dir, 'import-coverage.json');
  const task = { promptContext: { itemId: 'proj-1', sourceProject: 'proj' } };

  const result = applyArchImportCandidate({ implementResponse: candidateBlock({ id: 'AC-1', title: 'Real Candidate' }), candidatesPath, importCoveragePath, task });
  assert.equal(result.skipped, undefined);
  assert.equal(result.candidateCount, 1);

  const coverage = JSON.parse(fs.readFileSync(importCoveragePath, 'utf8'));
  assert.ok(coverage.items['proj-1'].promotedAt, 'a real candidate should mark this permanently promoted');
  assert.equal(coverage.items['proj-1'].candidateId, 'AC-1');
});

test('applyArchImportCandidate does not clobber an existing real promotion if somehow re-applied with an empty response', () => {
  const dir = makeFixtureRepo();
  const { applyArchImportCandidate } = freshPlugin(dir);
  const candidatesPath = path.join(dir, 'ARCH_IMPORT_CANDIDATES.md');
  const importCoveragePath = path.join(dir, 'import-coverage.json');
  fs.writeFileSync(importCoveragePath, JSON.stringify({
    items: { 'proj-1': { promotedAt: '2026-01-01T00:00:00.000Z', candidateId: 'AC-1', projectSlug: 'proj' } },
  }));
  const task = { promptContext: { itemId: 'proj-1', sourceProject: 'proj' } };

  applyArchImportCandidate({ implementResponse: '', candidatesPath, importCoveragePath, task });

  const coverage = JSON.parse(fs.readFileSync(importCoveragePath, 'utf8'));
  assert.equal(coverage.items['proj-1'].promotedAt, '2026-01-01T00:00:00.000Z');
  assert.equal(coverage.items['proj-1'].candidateId, 'AC-1');
});

// --- register() + nextArchDiscoveryTask smoke -----------------------------------------

test('register() wires all four arch sources with priorities and prompt builders', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arch-test-'));
  const { getRegisteredSource } = freshPlugin(dir);
  for (const [name, prio] of [['arch_review', 70], ['arch_import_review', 71], ['arch_discovery', 80], ['arch_import', 81]]) {
    const s = getRegisteredSource(name);
    assert.ok(s, `${name} must be registered`);
    assert.equal(s.priority, prio);
    assert.equal(typeof s.buildPlanPrompt, 'function', `${name} needs a plan prompt builder`);
  }
  assert.equal(typeof getRegisteredSource('arch_discovery').apply, 'function');
  assert.equal(typeof getRegisteredSource('arch_import').apply, 'function');
});

test('nextArchDiscoveryTask returns null when there is no community-coverage file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arch-test-'));
  process.env.AGENT_MANAGER_COMMUNITY_COVERAGE_PATH = path.join(dir, 'community-coverage.json');
  const { nextArchDiscoveryTask } = freshPlugin(dir);
  assert.equal(nextArchDiscoveryTask(), null);
});
