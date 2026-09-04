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
  require('agent-manager/src/deterministic-recheck-registry.js').clearDeterministicRecheckRegistry();
  for (const p of ['agent-manager/src/task-sources.js', 'agent-manager/src/prompts.js',
    './function-length-review.js', './observability-review.js', './performance-review.js',
    './arch.js', './unused-export.js', './deterministic-recheck.js', '../register.js']) {
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

// Stage A1 (2026-08-28): the "candidate-doc append" sources declare directToMain: true so
// apply-task.js routes them straight to main without an agent-manager code change; and
// unused_export declares its 'deadcode_triage' source-field alias via registerSourceAlias()
// instead of relying on agent-manager's legacy hardcoded fallback. (2026-08-31:
// function_length_review joined the list -- it was the last candidate-generating review
// source still producing a hand-merge branch for a one-line markdown append.)
test('directToMain is set on the candidate-doc-append review sources; deadcode_triage resolves via a registered alias', () => {
  const registry = loadPluginFresh();
  for (const name of ['arch_discovery', 'arch_import', 'observability_review', 'performance_review', 'function_length_review']) {
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
test('arch_discovery / arch_import declare reviewGuidance; arch_review and the fix consumers do not', () => {
  const registry = loadPluginFresh();
  const disc = registry.getRegisteredSource('arch_discovery').reviewGuidance;
  const imp = registry.getRegisteredSource('arch_import').reviewGuidance;
  assert.equal(typeof disc, 'string');
  assert.match(disc, /architecture-discovery task: finding ZERO real issues/);
  assert.equal(typeof imp, 'string');
  assert.match(imp, /architecture-import task \(an idea from an external project/);
  for (const name of ['arch_review', 'observability_fix', 'performance_fix', 'function_length_fix']) {
    assert.equal(registry.getRegisteredSource(name).reviewGuidance, undefined, `${name} must not set reviewGuidance`);
  }
});

// 2026-09-04 (AC-8 incident): arch_import_review is the one candidate-fulfillment consumer
// that DOES carry reviewGuidance + groundingFields -- an idea imported from an external
// project can make a false claim about agent-manager's own code, and premiseEvidence
// (arch-import-premise-check.js) is the deterministic check of that claim. arch_review
// (internally-discovered candidates) has no comparable external-idea risk and stays plain.
test('arch_import_review declares its own premise-check reviewGuidance + groundingFields', () => {
  const registry = loadPluginFresh();
  const s = registry.getRegisteredSource('arch_import_review');
  assert.deepEqual(s.groundingFields, ['premiseEvidence']);
  assert.equal(typeof s.reviewGuidance, 'string');
  assert.match(s.reviewGuidance, /premiseEvidence/);
  assert.equal(typeof s.premiseCheck, 'function');
});

// 2026-08-31: the three scanner-review sources hand the drafter promptContext.snippet (the
// flagged code window) and tell it to ground its verdict there. get-grounding-source.js
// only threads a promptContext field into review-task.js's grounding block if the source
// declares it in groundingFields -- without this the reviewer never saw the snippet and
// rejected correct false-positive verdicts as unverified. The fix/consumer sources have
// their own grounding (fetchedFiles) and must NOT pull the stale creation-time snippet.
test('the scanner-review sources declare groundingFields: ["snippet"]; the fix consumers do not', () => {
  const registry = loadPluginFresh();
  // observability_review also grounds on `enclosingCode` -- the wider block+context window
  // nextObservabilityReviewTask builds so the reviewer sees the same real code the drafter did.
  assert.deepEqual(registry.getRegisteredSource('observability_review').groundingFields, ['snippet', 'enclosingCode'],
    'observability_review must ground review on its snippet AND the enclosing code window');
  for (const name of ['performance_review', 'function_length_review']) {
    assert.deepEqual(registry.getRegisteredSource(name).groundingFields, ['snippet'], `${name} must ground review on its snippet`);
  }
  for (const name of ['observability_fix', 'performance_fix', 'function_length_fix', 'arch_discovery', 'arch_import', 'arch_review']) {
    assert.equal(registry.getRegisteredSource(name).groundingFields, undefined, `${name} must not set groundingFields`);
  }
  // arch_import_review is the one exception -- see the dedicated premise-check test above.
});

// Stage A4 (2026-08-28): arch_import's plan pass proposes QUERY: terms only; agent-manager's
// local-draft.js runs the between-plan-and-implement grep of its own repo, driven by the
// harnessSearch field, and skips the implement call on a genuine zero-hit search
// (skipImplementWhenNoHarnessHits). Neither is set on any other hygiene source.
test('arch_import declares harnessSearch + skipImplementWhenNoHarnessHits; no other hygiene source does', () => {
  const registry = loadPluginFresh();
  const ai = registry.getRegisteredSource('arch_import');
  assert.equal(ai.harnessSearch, 'archImport');
  assert.equal(ai.skipImplementWhenNoHarnessHits, true);
  for (const name of ['arch_discovery', 'arch_review', 'arch_import_review', 'observability_review',
    'observability_fix', 'performance_review', 'performance_fix', 'function_length_review',
    'function_length_fix', 'unused_export']) {
    const s = registry.getRegisteredSource(name);
    assert.notEqual(s.harnessSearch, 'archImport', `${name} must not declare harnessSearch`);
    assert.notEqual(s.skipImplementWhenNoHarnessHits, true, `${name} must not declare skipImplementWhenNoHarnessHits`);
  }
});

// Stage A3 (2026-08-28): sources declare how their completed tasks count toward
// system-report.js's junk/filtering/benefit accounting via reportClass, read off the
// registry there instead of a hardcoded source check. The arch generators are a flat
// 'benefit'; the two _review sources decide filtering vs benefit from the verdict text.
test('reportClass: arch generators are benefit; observability/performance review split filtering vs benefit on verdict text', () => {
  const registry = loadPluginFresh();
  assert.equal(registry.getRegisteredSource('arch_discovery').reportClass, 'benefit');
  assert.equal(registry.getRegisteredSource('arch_import').reportClass, 'benefit');
  for (const name of ['observability_review', 'performance_review']) {
    const fn = registry.getRegisteredSource(name).reportClass;
    assert.equal(typeof fn, 'function', `${name}.reportClass must be a (task) => bucket function`);
    assert.equal(fn({ implementResponse: 'This is a false positive.' }), 'filtering');
    assert.equal(fn({ implementResponse: 'Confirmed genuine issue.' }), 'benefit');
    assert.equal(fn({ implementResponse: 'nothing conclusive' }), 'unclear');
  }
});
