'use strict';

// End-to-end coverage for the deterministic staleness recheck (ADR-0022 Stage B): this
// plugin registers the observability_review / performance_review rule detectors into
// agent-manager's deterministic-recheck-registry, and agent-manager's staleness-fastpath.js
// consumes them. These tests are the real-detector cases that used to live in
// agent-manager's src/staleness-fastpath.test.js, relocated here with the wiring.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { clearDeterministicRecheckRegistry, getRecheckSources } =
  require('agent-manager/src/deterministic-recheck-registry.js');
clearDeterministicRecheckRegistry();
require('./deterministic-recheck.js').register();

const { deterministicRecheck } = require('agent-manager/src/staleness-fastpath.js');

function makeFixtureRepo() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hygiene-recheck-test-'));
}

function stalenessTask(overrides) {
  return {
    id: 'staleness-audit-x-1',
    source: 'staleness_audit',
    promptContext: {
      originalTaskId: 'observability-x-silent-catch-block-worker-js-3',
      originalSource: 'observability_review',
      originalRule: 'silent-catch-block',
      originalFile: 'worker.js',
      ...overrides,
    },
  };
}

test('register() wired both review sources into the recheck registry', () => {
  assert.deepEqual(getRecheckSources().sort(), ['observability_review', 'performance_review']);
});

test('silent-catch-block: archive when the file no longer exists', () => {
  const verdict = deterministicRecheck(stalenessTask(), makeFixtureRepo());
  assert.equal(verdict.recommendation, 'archive');
  assert.match(verdict.reportText, /no longer exists/);
});

test('silent-catch-block: archive when the rule no longer fires anywhere in the file', () => {
  const dir = makeFixtureRepo();
  fs.writeFileSync(path.join(dir, 'worker.js'), 'try {\n  risky();\n} catch (e) {\n  logger.error(e);\n}\n');
  const verdict = deterministicRecheck(stalenessTask(), dir);
  assert.equal(verdict.recommendation, 'archive');
  assert.match(verdict.reportText, /no longer fires anywhere/);
});

test('silent-catch-block: investigate when the rule still fires (and survives line drift)', () => {
  const dir = makeFixtureRepo();
  const padding = Array.from({ length: 30 }, (_, i) => `const unrelated${i} = ${i};`).join('\n');
  fs.writeFileSync(path.join(dir, 'worker.js'), `${padding}\ntry {\n  risky();\n} catch {}\n`);
  const verdict = deterministicRecheck(stalenessTask(), dir);
  assert.equal(verdict.recommendation, 'investigate');
  assert.equal(verdict.hits.length, 1);
  assert.equal(verdict.hits[0].file, 'worker.js');
  assert.match(verdict.reportText, /RECOMMENDATION: worth a fresh investigation/);
});

test('staleness-fastpath refuses to read outside repoRoot', () => {
  const dir = makeFixtureRepo();
  assert.equal(deterministicRecheck(stalenessTask({ originalFile: '../../../../etc/passwd' }), dir), null);
});

test('performance_review rules dispatch through this plugin (sequential-await-in-loop)', () => {
  const dir = makeFixtureRepo();
  fs.writeFileSync(path.join(dir, 'worker.js'), 'for (const x of xs) {\n  await fetch(x);\n}\n');
  const verdict = deterministicRecheck(stalenessTask({
    originalTaskId: 'performance-x-sequential-await-in-loop-worker-js-1',
    originalSource: 'performance_review',
    originalRule: 'sequential-await-in-loop',
  }), dir);
  assert.equal(verdict.recommendation, 'investigate');
  assert.equal(verdict.hits.length, 1);
});

test('an unregistered rule (function_length_review, or a typo) returns null', () => {
  const dir = makeFixtureRepo();
  fs.writeFileSync(path.join(dir, 'worker.js'), 'x();\n');
  assert.equal(deterministicRecheck(stalenessTask({ originalRule: 'nope' }), dir), null);
  assert.equal(deterministicRecheck(stalenessTask({ originalSource: 'function_length_review', originalRule: 'over-long-function' }), dir), null);
});

// missing-reserved-attribute is REPO-WIDE (originalFile is null).
function mraTask(overrides) {
  return stalenessTask({
    originalTaskId: 'observability-x-missing-reserved-attribute-repo-0',
    originalRule: 'missing-reserved-attribute',
    originalFile: null,
    ...overrides,
  });
}

test('missing-reserved-attribute: archive when the project has no OpenTelemetry dependency', () => {
  const dir = makeFixtureRepo();
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', dependencies: {} }));
  assert.equal(deterministicRecheck(mraTask(), dir).recommendation, 'archive');
});

test('missing-reserved-attribute: archive once both reserved attributes appear in source', () => {
  const dir = makeFixtureRepo();
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', dependencies: { '@opentelemetry/api': '^1.0.0' } }));
  fs.writeFileSync(path.join(dir, 'tracing.js'), "resource.setAttribute('service.name', 'x');\nspan.setAttribute('error.type', e.name);\n");
  assert.equal(deterministicRecheck(mraTask(), dir).recommendation, 'archive');
});

test('missing-reserved-attribute: investigate when a reserved attribute is still missing', () => {
  const dir = makeFixtureRepo();
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', dependencies: { '@opentelemetry/api': '^1.0.0' } }));
  fs.writeFileSync(path.join(dir, 'tracing.js'), "resource.setAttribute('service.name', 'x');\n");
  const verdict = deterministicRecheck(mraTask(), dir);
  assert.equal(verdict.recommendation, 'investigate');
  assert.ok(verdict.hits.length > 0);
});
