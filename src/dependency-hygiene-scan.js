'use strict';

// Deterministic, dependency-free dependency-hygiene scanner -- same family and split as
// function-length-scan.js: this module ONLY detects and flags candidates (declared but
// unused, used but not declared, declared in more than one manifest place); a downstream
// review task judges genuine issue vs. false positive (an internal helper that happens to
// share a name with a package, an optional dependency loaded via try/except, is not
// automatically a problem).
//
// Three passes:
//   Pass A -- walk the dependency manifests (package.json, requirements.txt,
//             pyproject.toml) and build the declared set. NO file-skip predicates here:
//             manifests are manifest files, not source, so minified/vendored/node_modules
//             skips do not apply.
//   Pass B -- walk listSourceFiles and, per file, apply the three file-scoped skips
//             (minified / vendored / an installed-module tree the repo happens to carry),
//             EACH writing a history event through reconcileFlags so a wrongly-dismissed
//             file is recoverable later. Files that survive the skips have their JS
//             require/import and Python import/from-import package names extracted.
//   Pass C -- emit findings. Exactly three findingKind values: 'unused', 'missing',
//             'duplicate'. Dedup key is the 4-tuple
//             (sourceId, filePath, packageName, findingKind); a collision is recorded as
//             a 'dedup-suppressed' history event and the second copy is not emitted.
//
// Narrow dependency on scan-utils.js only (listSourceFiles, isLikelyMinified -- the same
// generic, rule-agnostic utilities function-length-scan.js uses). The module is
// read-only over the filesystem: it never spawns a process, never runs a package
// installer, and never reads lockfiles (lockfiles are generated state, not declared
// intent -- declaring in a manifest is the hygiene this scanner measures).

const fs = require('fs');
const path = require('path');
const { listSourceFiles, isLikelyMinified } = require('./scan-utils.js');
const { reconcileFlags } = require('./flag-store.js');

const SOURCE_ID = 'dependency_hygiene_review';

const SCAN_EXTENSIONS = ['.js', '.jsx', '.ts', '.tsx', '.py'];

// ---- history events ----------------------------------------------------------

// Every dismissal (a skip, or a dedup suppression) is a history event, written through
// reconcileFlags with the exact reason literal the shared contract names, so a wrongly
// dismissed case is findable later. Kept per-file inside scanProject and reconciled once
// at the end (reconcileFlags is the persistent-flag reconciler; one call per scan, not
// one per file, keeps its write path cheap and the history deterministic).
function recordEvent(history, reason, filePath, packageName) {
  history.push({ sourceId: SOURCE_ID, reason, filePath: filePath || null, packageName: packageName || null });
}

// ---- Pass A: declared set ----------------------------------------------------

// Canonicalize a name for cross-manifest comparison: lowercase, hyphen -> underscore
// (Python PEP 503 style; harmless for JS names, which never contain either in practice
// outside of scoped packages, where both '/' and case ARE significant, so JS names are
// compared case-sensitively and only Python names get this normalization).
function canonicalPyName(name) {
  return String(name).trim().toLowerCase().replace(/-/g, '_');
}

// package.json: dependencies + devDependencies. Track per-name origins so Pass C can
// tell a same-name collision inside one manifest (dependencies vs devDependencies)
// apart from a cross-manifest collision.
function declaredFromPackageJson(rootDir) {
  const declared = new Map(); // canonical name -> { set: Set, origins: Set, manifestPath }
  let text;
  try { text = fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'); } catch { return declared; }
  let pkg;
  try { pkg = JSON.parse(text); } catch { return declared; }
  const manifestPath = 'package.json';
  for (const section of ['dependencies', 'devDependencies']) {
    const sectionObj = pkg && pkg[section];
    if (!sectionObj || typeof sectionObj !== 'object') continue;
    for (const name of Object.keys(sectionObj)) {
      // Scoped packages keep both segments ('@scope/pkg'); unscoped, the full name.
      const canonical = name;
      if (!declared.has(canonical)) {
        declared.set(canonical, { set: new Set([canonical]), origins: new Set(), manifestPath });
      }
      const entry = declared.get(canonical);
      entry.set.add(canonical);
      entry.origins.add(`${manifestPath}:${section}`);
    }
  }
  return declared;
}

// requirements.txt: one requirement per line, name before any version specifier.
// Comments (# ...) and blank lines ignored; inline comments stripped conservatively.
function declaredFromRequirementsTxt(rootDir) {
  const declared = new Map();
  let text;
  try { text = fs.readFileSync(path.join(rootDir, 'requirements.txt'), 'utf8'); } catch { return declared; }
  const manifestPath = 'requirements.txt';
  for (const rawLine of text.split('\n')) {
    let line = rawLine.split('#')[0].trim();
    if (!line) continue;
    // Name ends at the first operator/comparator/environment-marker char.
    const m = line.match(/^[A-Za-z0-9][A-Za-z0-9._-]*/);
    if (!m) continue;
    const canonical = canonicalPyName(m[0]);
    if (!declared.has(canonical)) {
      declared.set(canonical, { set: new Set([m[0], canonical]), origins: new Set(), manifestPath });
    }
    declared.get(canonical).origins.add(`${manifestPath}`);
  }
  return declared;
}

// pyproject.toml: no TOML library is available here (the package has none installed),
// so take the simple, well-known shape -- a `dependencies = [ "name", ... ]` list inside
// [project] -- with a line-oriented scan of quoted strings in any list assignment whose
// key is `dependencies`. This deliberately covers only the standard PEP 621 shape; an
// exotic layout simply contributes nothing to the declared set (a false negative the
// review stage can catch, never a false positive).
function declaredFromPyproject(rootDir) {
  const declared = new Map();
  let text;
  try { text = fs.readFileSync(path.join(rootDir, 'pyproject.toml'), 'utf8'); } catch { return declared; }
  const manifestPath = 'pyproject.toml';
  const inListRe = /^\s*dependencies\s*=\s*\[([\s\S]*?)\]\s*$/;
  for (const block of text.split(/\]\s*\n/)) {
    const m = block.match(inListRe);
    if (!m) continue;
    const body = m[1];
    const nameRe = /["']([A-Za-z0-9][A-Za-z0-9._-]*)["']/g;
    let nm;
    while ((nm = nameRe.exec(body))) {
      const canonical = canonicalPyName(nm[1]);
      if (!declared.has(canonical)) {
        declared.set(canonical, { set: new Set([nm[1], canonical]), origins: new Set(), manifestPath });
      }
      declared.get(canonical).origins.add(`${manifestPath}:dependencies`);
    }
  }
  return declared;
}

function mergeDeclared(target, source) {
  for (const [name, entry] of source) {
    if (!target.has(name)) {
      target.set(name, entry);
    } else {
      const existing = target.get(name);
      for (const alt of entry.set) existing.set.add(alt);
      for (const o of entry.origins) existing.origins.add(o);
    }
  }
}

// ---- Pass B: usage extraction ------------------------------------------------

// Vendored third-party code: a `vendor/` directory anywhere, or under static/.
const VENDOR_PATH_RE = /(^|\/)vendor\/|(^|\/)static\/vendor\//;

// A `node_modules` DIRECTORY SEGMENT in the path -- i.e. an installed-module tree the
// repo happens to carry (not a repo-internal directory that merely has the string in
// its name): the segment must be a full path component, or the file's DIRECT parent.
// Repo-internal code under src/vendor/... or test/fixtures/... does not match this,
// because those are caught by the (earlier) vendored rule and everything else stays
// scannable.
function isInstalledModulesRepoPath(relPath) {
  const segments = relPath.split('/');
  return segments.includes('node_modules') ||
    (segments.length >= 2 && segments[segments.length - 2] === 'node_modules');
}

// JS module specifier -> package root: '@scope/pkg/sub' -> '@scope/pkg';
// 'pkg/sub' -> 'pkg'. Relative specifiers ('./x', '../x') are not package usage.
function jsPackageRoot(spec) {
  const s = String(spec).trim();
  if (!s || s.startsWith('.') || s.startsWith('/') || s.startsWith('node:')) return null;
  const parts = s.split('/');
  if (s.startsWith('@') && parts.length >= 2) return parts.slice(0, 2).join('/');
  if (parts.length >= 1) return parts[0];
  return null;
}

const JS_REQUIRE_RE = /\brequire\s*\(\s*(['"])([^'"]+)\1\s*\)/g;
const JS_IMPORT_FROM_RE = /\bimport\s+(?:[\w${},*\s]+?\s+from\s+)?(['"])([^'"]+)\1/g;
const PY_IMPORT_RE = /^\s*import\s+([A-Za-z_][A-Za-z0-9_.]*)/gm;
const PY_FROM_RE = /^\s*from\s+([A-Za-z_][A-Za-z0-9_.]*)\s+import\b/gm;

// Extract package names one file's text uses. JS names are kept as-is (case-sensitive);
// Python top-level module names are canonicalized to PEP 503 form so `from My_Pkg import
// x` matches a manifest entry written `my-pkg`.
function extractPackageUsages(text, relPath) {
  const usages = new Set();
  if (relPath.endsWith('.py')) {
    let m;
    PY_IMPORT_RE.lastIndex = 0;
    while ((m = PY_IMPORT_RE.exec(text))) {
      const top = m[1].split('.')[0];
      usages.add(canonicalPyName(top));
      usages.add(top);
    }
    PY_FROM_RE.lastIndex = 0;
    while ((m = PY_FROM_RE.exec(text))) {
      const top = m[1].split('.')[0];
      usages.add(canonicalPyName(top));
      usages.add(top);
    }
  } else {
    let m;
    JS_REQUIRE_RE.lastIndex = 0;
    while ((m = JS_REQUIRE_RE.exec(text))) {
      const root = jsPackageRoot(m[2]);
      if (root) usages.add(root);
    }
    JS_IMPORT_FROM_RE.lastIndex = 0;
    while ((m = JS_IMPORT_FROM_RE.exec(text))) {
      const root = jsPackageRoot(m[2]);
      if (root) usages.add(root);
    }
  }
  return usages;
}

// ---- Pass C + scan entry point ------------------------------------------------

// scanProject mirrors function-length-scan.js's entry point: (clonePath, projectSlug),
// returns findings ready for the flags store. Findings carry the shared-contract fields
// exactly: sourceId, filePath, packageName, findingKind, detail.
function scanProject(clonePath, projectSlug) {
  const scannedAt = new Date().toISOString();
  const history = [];

  // Pass A -- declared set, NO file-skip predicates (manifests are not source files).
  const declared = new Map();
  mergeDeclared(declared, declaredFromPackageJson(clonePath));
  mergeDeclared(declared, declaredFromRequirementsTxt(clonePath));
  mergeDeclared(declared, declaredFromPyproject(clonePath));

  // Pass B -- walk source files, apply the three file-scoped skips (each one a history
  // event), and collect package usage per surviving file.
  const allFiles = listSourceFiles(clonePath, SCAN_EXTENSIONS);
  const usagesByFile = new Map(); // relPath -> Set of package names
  const usedNames = new Set();
  for (const file of allFiles) {
    const relPath = path.relative(clonePath, file).replace(/\\/g, '/');
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    if (isLikelyMinified(text)) {
      recordEvent(history, 'skipped-minified', relPath, null);
      continue;
    }
    if (VENDOR_PATH_RE.test(relPath)) {
      recordEvent(history, 'skipped-vendored', relPath, null);
      continue;
    }
    if (isInstalledModulesRepoPath(relPath)) {
      recordEvent(history, 'skipped-node-modules-repo', relPath, null);
      continue;
    }
    const usages = extractPackageUsages(text, relPath);
    if (usages.size === 0) continue;
    usagesByFile.set(relPath, usages);
    for (const u of usages) usedNames.add(u);
  }

  // Pass C -- emit exactly three finding kinds, deduped on the 4-tuple.
  const findings = [];
  const emitted = new Set();
  function emit(filePath, packageName, findingKind, detail) {
    const key = [SOURCE_ID, filePath, packageName, findingKind].join('|');
    if (emitted.has(key)) {
      recordEvent(history, 'dedup-suppressed', filePath, packageName);
      return;
    }
    emitted.add(key);
    findings.push({
      sourceId: SOURCE_ID,
      filePath,
      packageName,
      findingKind,
      detail,
    });
  }

  // missing: used in source but absent from the declared set (checked against every
  // declared name spelling, so a case/hyphen variant still counts as declared).
  for (const [filePath, usages] of usagesByFile) {
    for (const pkg of usages) {
      const isDeclared = [...declared.values()].some((e) => e.set.has(pkg));
      if (!isDeclared) {
        emit(filePath, pkg, 'missing', `Package "${pkg}" is required/imported in this file but is not declared in any dependency manifest (package.json, requirements.txt, pyproject.toml)`);
      }
    }
  }

  // unused: declared in a manifest but never used by any surviving scanned file.
  for (const [name, entry] of declared) {
    const used = [...entry.set].some((spelling) => usedNames.has(spelling));
    if (!used) {
      emit(entry.manifestPath, name, 'unused', `Declared in ${entry.manifestPath} but not required/imported by any scanned source file`);
    }
  }

  // duplicate: the same dependency declared in more than one distinct origin
  // (dependencies vs devDependencies, or across manifest files).
  for (const [name, entry] of declared) {
    if (entry.origins.size > 1) {
      emit(entry.manifestPath, name, 'duplicate', `Declared in more than one place: ${[...entry.origins].join(', ')}`);
    }
  }

  // One reconciliation pass for the whole scan: fresh findings in, skip/dedup history
  // out, so the flags store's history section records every dismissal by reason.
  reconcileFlags({
    flags: [],
    freshFindings: findings,
    scanOk: true,
    projectTag: projectSlug,
    repoRoot: clonePath,
    isSuppressed: () => false,
    history: { sourceId: SOURCE_ID, events: history },
  });

  return findings.map((f) => ({ ...f, projectSlug, scannedAt }));
}

module.exports = {
  scanProject,
};
