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

// 2026-08-28: a candidate-fulfillment source must NOT carry emptyApproval -- an empty
// fulfillment draft means "couldn't produce this fix", not "nothing to do", and
// emptyApproval was silently auto-closing those with no branch and no human (see
// agent-manager's retired candidate AC-25). emptyApproval stays on the arch_discovery /
// arch_import GENERATORS, where "found zero real issues" is a valid, common outcome.
test('no candidate-fulfillment source carries emptyApproval; the arch generators still do', () => {
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

  for (const name of ['arch_review', 'arch_import_review', 'observability_fix', 'performance_fix', 'function_length_fix']) {
    const s = registry.getRegisteredSource(name);
    assert.ok(s && s.candidateFulfillment === true, `${name} should still be a candidateFulfillment source`);
    assert.notEqual(s.emptyApproval, true, `${name} (a fulfillment source) must not auto-approve an empty draft`);
  }
  for (const name of ['arch_discovery', 'arch_import']) {
    assert.equal(registry.getRegisteredSource(name).emptyApproval, true, `${name} (a generator) keeps emptyApproval`);
  }
});
