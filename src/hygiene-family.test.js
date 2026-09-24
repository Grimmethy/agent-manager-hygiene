'use strict';

// Every hygiene source declares its own dashboard family (core names none of them -- ADR-0022), and core's Hygiene tab can
// rebuild the six families from the registrations alone.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { hygieneFamily, FAMILIES } = require('./hygiene-family.js');

const EXPECTED = {
  observability_review: 'observability', observability_review_digest: 'observability', observability_fix: 'observability',
  performance_review: 'performance', performance_fix: 'performance',
  function_length_review: 'function_length', function_length_fix: 'function_length',
  unused_export: 'unused_export',
  arch_discovery: 'arch', arch_review: 'arch', arch_import: 'arch', arch_import_review: 'arch',
  change_review: 'change_review', change_review_fix: 'change_review',
};

let registered = null; // registering twice re-requires core's task-sources.js, whose model-profile registrations are not idempotent
function registerAll() {
  if (registered) return registered;
  process.env.AGENT_MANAGER_REPO_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'hygfam-'));
  process.env.AGENT_MANAGER_PIPELINE_DIR = process.env.AGENT_MANAGER_REPO_ROOT;
  const registry = require('agent-manager/src/task-source-registry.js');
  registry.clearRegistry();
  for (const p of ['agent-manager/src/task-sources.js', 'agent-manager/src/prompts.js', './function-length-review.js', './observability-review.js',
    './performance-review.js', './arch.js', './unused-export.js', './change-review.js', '../register.js']) {
    try { delete require.cache[require.resolve(p)]; } catch { /* not loaded yet */ }
  }
  require('../register.js');
  registered = registry;
  return registry;
}

test('hygieneFamily(): known keys only; candidateDoc is opt-in', () => {
  assert.equal(hygieneFamily('arch').candidateDoc, undefined);
  assert.equal(hygieneFamily('arch', { candidateDoc: true }).candidateDoc, true);
  assert.throws(() => hygieneFamily('nope'), /unknown hygiene family/);
  assert.equal(new Set(Object.values(FAMILIES).map((f) => f.order)).size, Object.keys(FAMILIES).length, 'family orders are distinct');
});

test('every hygiene source registers with its family; core groups them from the registrations alone', () => {
  const registry = registerAll();
  for (const [name, family] of Object.entries(EXPECTED)) {
    const s = registry.getRegisteredSource(name);
    assert.ok(s, `${name} is registered`);
    assert.equal(s.hygieneFamily && s.hygieneFamily.key, family, `${name} declares family ${family}`);
  }
  // Only the four flag-based review sources plus change_review (2026-09-24: its "flags" are the commits not yet turned into
  // tasks, and the ones aged out of the review window) carry an inventory hook, one per family.
  const withHook = registry.getRegisteredSources().filter((s) => s.hygieneFamily && typeof s.inventory === 'function').map((s) => s.name).sort();
  assert.deepEqual(withHook, ['change_review', 'function_length_review', 'observability_review', 'performance_review', 'unused_export']);

  let collectFamilies;
  try { ({ collectFamilies } = require('agent-manager/src/hygiene-inventory.js')); } catch { /* core without the Hygiene tab */ }
  if (typeof collectFamilies !== 'function') return; // older core: nothing to cross-check
  const fams = collectFamilies(registry.getRegisteredSources());
  assert.deepEqual(fams.map((f) => f.key), ['observability', 'performance', 'function_length', 'unused_export', 'arch', 'change_review']);
  const by = Object.fromEntries(fams.map((f) => [f.key, f]));
  assert.deepEqual(by.arch.docSources.sort(), ['arch_import_review', 'arch_review']);
  assert.deepEqual(by.observability.docSources, ['observability_fix']);
  assert.equal(by.observability.flagSource, 'observability_review');
  assert.equal(by.arch.flagSource, null);
  assert.equal(by.change_review.flagSource, 'change_review', 'the Hygiene tab reads change review\'s untasked/aged-out backlog from its hook');
  assert.deepEqual(by.unused_export.prefixes, ['deadcode-']);
  assert.equal(by.unused_export.docSources.length, 0);
});

// Core's review gates are driven by these registration flags (ADR-0022: core names no plugin source). If a flag is dropped the
// gate silently turns off in production, so pin them here.
test('registration flags core reads: groundedPromptFiles, preValidateCitedPaths, requireCodeShapeInCandidate', () => {
  const registry = registerAll();
  assert.equal(registry.getRegisteredSource('arch_discovery').groundedPromptFiles, true, 'needs-clarification-triage bucket L');
  assert.equal(registry.getRegisteredSource('arch_import').preValidateCitedPaths, true, 'review-task cited-path pre-validation');
  assert.equal(registry.getRegisteredSource('function_length_review').requireCodeShapeInCandidate, true, 'review-task code-shape gate');
  for (const name of ['arch_review', 'arch_import_review', 'observability_review', 'performance_review', 'function_length_fix', 'change_review']) {
    const s = registry.getRegisteredSource(name);
    assert.ok(!s.groundedPromptFiles && !s.preValidateCitedPaths && !s.requireCodeShapeInCandidate, `${name} opts into none of them`);
  }
});
