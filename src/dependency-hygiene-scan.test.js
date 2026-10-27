'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { scanProject } = require('./dependency-hygiene-scan.js');
const { reconcileFlags } = require('./flag-store.js');

// Fixture helper: mirrors function-length-scan.test.js's mkdtemp pattern.
// Each test gets its own scratch project directory; `w` writes a file at a
// relative path inside it, creating intermediate directories as needed.
function tmpRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dep-hygiene-test-'));
  return {
    dir,
    w(rel, content) {
      const p = path.join(dir, rel);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, content);
    },
    cleanup() {
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

// ---- Test A: a used dependency produces no 'unused' finding -----------------

test('a declared and used dependency does not produce an unused finding', () => {
  const repo = tmpRepo();
  try {
    repo.w('package.json', JSON.stringify({
      name: 'used-dep-project',
      dependencies: { lodash: '^4.17.21' },
    }));
    repo.w('node_modules/lodash/index.js', '// fake lodash');
    repo.w('src/app.js', "const _ = require('lodash');\nconsole.log(_.size({}));\n");
    const findings = scanProject(repo.dir, 'used-dep');
    const unusedLodash = findings.filter(
      (f) => f.packageName === 'lodash' && f.findingKind === 'unused',
    );
    assert.equal(unusedLodash.length, 0, 'lodash should NOT be flagged as unused when it is required');
  } finally {
    repo.cleanup();
  }
});

test('a truly unused declared dependency does produce an unused finding', () => {
  const repo = tmpRepo();
  try {
    repo.w('package.json', JSON.stringify({
      name: 'unused-dep-project',
      dependencies: { lodash: '^4.17.21', 'left-pad': '^1.3.0' },
    }));
    repo.w('node_modules/lodash/index.js', '// fake lodash');
    repo.w('node_modules/left-pad/index.js', '// fake left-pad');
    repo.w('src/app.js', "const _ = require('lodash');\nconsole.log(_.size({}));\n");
    const findings = scanProject(repo.dir, 'unused-dep');
    const unusedLeftPad = findings.filter(
      (f) => f.packageName === 'left-pad' && f.findingKind === 'unused',
    );
    assert.equal(unusedLeftPad.length, 1, 'left-pad should be flagged as unused (declared but never required)');
    assert.equal(unusedLeftPad[0].sourceId, 'dependency_hygiene_review');
  } finally {
    repo.cleanup();
  }
});

// ---- Test B: two files importing the same undeclared package -> two findings

test('two files importing the same undeclared package produce two separate missing findings', () => {
  const repo = tmpRepo();
  try {
    repo.w('package.json', JSON.stringify({ name: 'ghost-pkg-project' }));
    repo.w('src/a.js', "const ghost = require('ghost-pkg');\nconsole.log(ghost);\n");
    repo.w('src/b.js', "import ghost from 'ghost-pkg';\nconsole.log(ghost);\n");
    const findings = scanProject(repo.dir, 'ghost-pkg');
    const missing = findings.filter((f) => f.findingKind === 'missing');
    assert.equal(missing.length, 2, 'exactly two missing findings, one per file');
    const files = missing.map((f) => f.filePath).sort();
    assert.deepEqual(files, ['src/a.js', 'src/b.js']);
    assert.ok(missing.every((f) => f.sourceId === 'dependency_hygiene_review'));
    assert.ok(missing.every((f) => f.packageName === 'ghost-pkg'));
  } finally {
    repo.cleanup();
  }
});

// ---- Test C: minified / vendored / node_modules files -> skip history events

test('minified, vendored, and node_modules files are skipped and produce no findings for those paths', () => {
  const repo = tmpRepo();
  try {
    repo.w('package.json', JSON.stringify({ name: 'skip-test-project' }));
    // A minified file: one absurdly long line (isLikelyMinified threshold is 2000 chars/line).
    repo.w('src/app.min.js', `function x(){${'a'.repeat(3000)}}`);
    // A vendored file inside a vendor/ subdir.
    repo.w('vendor/lib.js', "var lib = require('some-vendored-dep');\n");
    // A file inside a node_modules/ tree.
    repo.w('node_modules/pkg/index.js', "module.exports = require('another-dep');\n");
    // A normal file that survives the skips.
    repo.w('src/real.js', "console.log('hi');\n");

    const findings = scanProject(repo.dir, 'skip-test');

    // None of the skipped files should produce findings.
    const minifiedFinding = findings.find((f) => f.filePath === 'src/app.min.js');
    assert.equal(minifiedFinding, undefined, 'minified file should be skipped and produce no finding');
    const vendoredFinding = findings.find((f) => f.filePath === 'vendor/lib.js');
    assert.equal(vendoredFinding, undefined, 'vendored file should be skipped and produce no finding');
    const nodeModulesFinding = findings.find((f) => f.filePath === 'node_modules/pkg/index.js');
    assert.equal(nodeModulesFinding, undefined, 'node_modules file should be skipped and produce no finding');

    // The scanner should still run without error and return findings for surviving files.
    assert.ok(Array.isArray(findings), 'scanProject must return an array of findings');

    // Verify the 'skipped-minified' literal appears in the reconcileFlags history.
    // Note: 'skipped-vendored' and 'skipped-node-modules-repo' cannot fire here because
    // listSourceFiles (scan-utils.js) already filters out vendor/ and node_modules/
    // directories before the scanner sees those files, so those skip predicates never run.
    const flagStoreCacheKey = require.resolve('./flag-store.js');
    const dependencyHygieneCacheKey = require.resolve('./dependency-hygiene-scan.js');

    // Save a reference to the real reconcileFlags BEFORE clearing the cache.
    const { reconcileFlags: realReconcileFlags } = require('./flag-store.js');

    delete require.cache[flagStoreCacheKey];
    delete require.cache[dependencyHygieneCacheKey];

    const capturedCalls = [];
    const mockReconcileFlags = function (args) {
      capturedCalls.push(args);
      // Delegate to the real function for side effects (using the saved reference).
      return realReconcileFlags(args);
    };

    // Re-load flag-store with the mock.
    require.cache[flagStoreCacheKey] = {
      id: flagStoreCacheKey,
      filename: flagStoreCacheKey,
      loaded: true,
      exports: { reconcileFlags: mockReconcileFlags },
    };

    // Re-load dependency-hygiene-scan, which will now use the mocked flag-store.
    const { scanProject: mockedScanProject } = require('./dependency-hygiene-scan.js');

    // Run the scan again with the mocked version.
    const mockRepo = tmpRepo();
    try {
      mockRepo.w('package.json', JSON.stringify({ name: 'skip-test-mock' }));
      mockRepo.w('src/app.min.js', `function x(){${'a'.repeat(3000)}}`);
      mockRepo.w('vendor/lib.js', "var lib = require('some-vendored-dep');\n");
      mockRepo.w('node_modules/pkg/index.js', "module.exports = require('another-dep');\n");
      mockRepo.w('src/real.js', "console.log('hi');\n");
      mockedScanProject(mockRepo.dir, 'skip-test-mock');
    } finally {
      mockRepo.cleanup();
      // Restore the original cache entries.
      delete require.cache[flagStoreCacheKey];
      delete require.cache[dependencyHygieneCacheKey];
    }

    // Extract all history events from the captured calls.
    const events = [];
    for (const call of capturedCalls) {
      if (call.history && Array.isArray(call.history.events)) {
        events.push(...call.history.events);
      }
    }

    const reasons = events.map((e) => e.reason);
    assert.ok(reasons.includes('skipped-minified'), `expected 'skipped-minified' in skip events, got: ${JSON.stringify(reasons)}`);

    // The 'skipped-minified' event must be paired with the concrete file path.
    const byReason = {};
    for (const e of events) {
      (byReason[e.reason] || (byReason[e.reason] = [])).push(e.filePath);
    }
    assert.ok(byReason['skipped-minified']?.some((f) => f === 'src/app.min.js'), 'skipped-minified must be paired with the minified file path');
  } finally {
    repo.cleanup();
  }
});

// ---- Test D: manifest alongside vendor/ still walks declared packages -------

test('a package.json alongside a vendor/ subdir still walks the manifest and finds declared packages present', () => {
  const repo = tmpRepo();
  try {
    repo.w('package.json', JSON.stringify({
      name: 'vendor-project',
      dependencies: { express: '^4.18.0' },
    }));
    // A vendored copy of express -- it lives inside vendor/, so its contents
    // are skipped by the vendored-file predicate, but the *declaration* in
    // package.json must still be recognized as "present in the project".
    repo.w('vendor/express/index.js', "module.exports = { version: '4.18.0' };\n");
    // A real source file that does NOT require express.
    repo.w('src/app.js', "console.log('no deps here');\n");

    const findings = scanProject(repo.dir, 'vendor-project');
    // The manifest must be walked (no crash, findings returned).
    assert.ok(Array.isArray(findings), 'scanProject must return an array of findings');
    // The vendored package should NOT be flagged as "missing" (it's declared).
    const missingExpress = findings.filter(
      (f) => f.packageName === 'express' && f.findingKind === 'missing',
    );
    assert.equal(missingExpress.length, 0,
      'express should NOT be flagged as missing just because it lives in vendor/ -- the manifest declaration must still count');
    // The scanner may flag it as "unused" because no surviving file requires it,
    // which is correct behavior (the scanner only checks surviving files for usage).
    // This test verifies the manifest is walked, not the usage heuristic.
  } finally {
    repo.cleanup();
  }
});
