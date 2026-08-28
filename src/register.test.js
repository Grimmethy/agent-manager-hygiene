'use strict';

// Integration guard for register.js -- the file AGENT_MANAGER_REGISTER_PATH points at.
// Two things that, if broken, make the plugin silently do nothing in production:
//   1. requiring register.js must register every hygiene source with the SHARED registry
//      singleton (the same module object agent-manager's own entry points load), and
//   2. that only holds if node_modules/agent-manager resolves, via realpath, to the exact
//      checkout core runs from (a copied dep = a second, private registry).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

test('node_modules/agent-manager is a symlink (a real copy would fork the registry singleton)', () => {
  const linkPath = path.join(__dirname, '..', 'node_modules', 'agent-manager');
  const st = fs.lstatSync(linkPath);
  assert.ok(st.isSymbolicLink(), 'node_modules/agent-manager must be a symlink, not a copied directory');
});

test('requiring register.js registers all six hygiene sources on the shared registry', () => {
  process.env.AGENT_MANAGER_REPO_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'register-test-'));
  process.env.AGENT_MANAGER_PIPELINE_DIR = process.env.AGENT_MANAGER_REPO_ROOT;

  const registry = require('agent-manager/src/task-source-registry.js');
  registry.clearRegistry();
  for (const p of ['agent-manager/src/task-sources.js', 'agent-manager/src/prompts.js',
    './function-length-review.js', './observability-review.js', './performance-review.js', '../register.js']) {
    delete require.cache[require.resolve(p)];
  }

  require('../register.js');

  const names = new Set(registry.getRegisteredSources().map((s) => s.name));
  for (const expected of ['observability_review', 'observability_fix', 'performance_review', 'performance_fix', 'function_length_review', 'function_length_fix']) {
    assert.ok(names.has(expected), `register.js must register ${expected}`);
  }
  // The prompt builders must be attached too (register() does its own updateTaskSource).
  assert.equal(typeof registry.getRegisteredSource('observability_fix').buildPlanPrompt, 'function');

  // If the review modules had resolved a *different* task-source-registry.js (a forked
  // singleton), the six names above would not be visible on the object we hold here.
  // Seeing them is the proof the symlink kept it a singleton.
});

// Fresh registry with the whole plugin loaded via register.js. Returns the shared
// agent-manager task-source-registry module.
function loadPluginFresh() {
  process.env.AGENT_MANAGER_REPO_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'register-test-'));
  process.env.AGENT_MANAGER_PIPELINE_DIR = process.env.AGENT_MANAGER_REPO_ROOT;
  const registry = require('agent-manager/src/task-source-registry.js');
  registry.clearRegistry();
  require('agent-manager/src/model-profile-registry.js').clearModelProfileRegistry();
  for (const p of ['agent-manager/src/task-sources.js', 'agent-manager/src/prompts.js',
    './function-length-review.js', './observability-review.js', './performance-review.js',
    './arch.js', './unused-export.js', '../register.js']) {
    delete require.cache[require.resolve(p)];
  }
  require('../register.js');
  return registry;
}

// 2026-08-28: a candidate-fulfillment source must NOT carry emptyApproval -- an empty
// fulfillment draft means "couldn't produce this fix", not "nothing to do", and
// emptyApproval was silently auto-closing those with no branch and no human (see
// agent-manager's retired candidate AC-25). emptyApproval stays on the arch_discovery /
// arch_import GENERATORS, where "found zero real issues" is a valid, common outcome.
test('no candidate-fulfillment source carries emptyApproval; the arch generators still do', () => {
  const registry = loadPluginFresh();
  for (const name of ['arch_review', 'arch_import_review', 'observability_fix', 'performance_fix', 'function_length_fix']) {
    const s = registry.getRegisteredSource(name);
    assert.ok(s && s.candidateFulfillment === true, `${name} should still be a candidateFulfillment source`);
    assert.notEqual(s.emptyApproval, true, `${name} (a fulfillment source) must not auto-approve an empty draft`);
  }
  for (const name of ['arch_discovery', 'arch_import']) {
    assert.equal(registry.getRegisteredSource(name).emptyApproval, true, `${name} (a generator) keeps emptyApproval`);
  }
});

// Stage A1 (2026-08-28): the 4 "candidate-doc append" sources declare directToMain: true so
// apply-task.js routes them straight to main without an agent-manager code change; and
// unused_export declares its 'deadcode_triage' source-field alias via registerSourceAlias()
// instead of relying on agent-manager's legacy hardcoded fallback.
test('directToMain is set on the 4 candidate-doc-append sources; deadcode_triage resolves via a registered alias', () => {
  const registry = loadPluginFresh();
  for (const name of ['arch_discovery', 'arch_import', 'observability_review', 'performance_review']) {
    assert.equal(registry.getRegisteredSource(name).directToMain, true, `${name} must declare directToMain: true`);
  }
  for (const name of ['arch_review', 'arch_import_review', 'observability_fix', 'performance_fix', 'function_length_fix', 'unused_export']) {
    assert.notEqual(registry.getRegisteredSource(name).directToMain, true, `${name} must NOT be direct-to-main`);
  }
  assert.equal(registry.resolveSourceName({ source: 'deadcode_triage' }), 'unused_export');
});

// Stage A2 (2026-08-28): the two arch GENERATORS carry their own review-gate guidance so
// agent-manager's review-task.js buildVerdictPrompt reads it off the registry instead of a
// hardcoded `if (task.source === 'arch_discovery')` chain. agent-manager keeps a byte-identical
// fallback for when this plugin isn't loaded; this test pins the plugin side of that pair.
test('arch_discovery / arch_import declare reviewGuidance; the review/fix consumers do not', () => {
  const registry = loadPluginFresh();
  const disc = registry.getRegisteredSource('arch_discovery').reviewGuidance;
  const imp = registry.getRegisteredSource('arch_import').reviewGuidance;
  assert.equal(typeof disc, 'string');
  assert.match(disc, /architecture-discovery task: finding ZERO real issues/);
  assert.equal(typeof imp, 'string');
  assert.match(imp, /architecture-import task \(an idea from an external project/);
  for (const name of ['arch_review', 'arch_import_review', 'observability_fix', 'performance_fix', 'function_length_fix']) {
    assert.equal(registry.getRegisteredSource(name).reviewGuidance, undefined, `${name} must not set reviewGuidance`);
  }
});
