'use strict';

// Unused-export scanner. A small, dependency-free, purpose-built scanner (no vulture/knip
// needed) that flags low-usage CommonJS exports for downstream local-model triage. It attaches
// each candidate's REAL call sites (not just a bare "unused" claim), because that bare claim
// is exactly the false-positive trap documented in docs/local-delegation.md (barrel
// re-exports, factory patterns, etc. all look "unused" to naive grep but aren't) -- the
// triage task needs the actual call sites to judge; this script only gathers them.
//
// Generalized out of an earlier single-project version: repoRoot and the scan/search dirs come from config.js
// (AGENT_MANAGER_REPO_ROOT, AGENT_MANAGER_UNUSED_SCAN_DIRS / _SEARCH_DIRS, both defaulting
// to AGENT_MANAGER_GREP_DIRS), not hardcoded. Output goes to the same file the built-in
// `unused_export` task source reads: <pipelineDir>/queue/dead-code-flags.json.
//
// Scope note: export DEFINITIONS are detected for CommonJS (module.exports / exports.x) in
// .js/.jsx, and for ES `export` declarations in .ts/.tsx (2026-09-19: PropertyForager is all
// TS/TSX and this scanner previously saw zero candidates in it). ESM in plain .js/.jsx is
// still NOT detected -- deliberately left as-is so a CommonJS project's flags don't change;
// call sites are searched across .js/.jsx/.ts/.tsx so a symbol referenced from either counts.
// TS re-exports (`export { x } from`, `export * from`) are barrels, not definitions, and are
// skipped; `.d.ts` files are ambient declarations and are never scanned for definitions.
//
// Python is deliberately NOT covered here (unlike function-length / observability /
// performance, which gained .py support 2026-08-30). "Unused module-level def/class" in
// Python is a false-positive minefield without a real analyzer: framework-invoked handlers
// (@app.route, pytest fixtures, Django models, click commands), `__all__` re-exports,
// `from .x import *`, and runtime getattr/plugin lookups all look unused to grep but
// aren't -- and this scanner's whole selling point is NOT needing vulture. Point vulture
// at a Python repo for this rule instead.

const fs = require('fs');
const path = require('path');
const { getConfig } = require('agent-manager/src/config.js');
const { stripNonCode } = require('./scan-utils.js');

const CJS_DEFINE_EXTENSIONS = ['.js', '.jsx'];
const ES_DEFINE_EXTENSIONS = ['.ts', '.tsx'];
const DEFINE_EXTENSIONS = [...CJS_DEFINE_EXTENSIONS, ...ES_DEFINE_EXTENSIONS];
const SEARCH_EXTENSIONS = ['.js', '.jsx', '.ts', '.tsx'];
const SKIP_DIRS = new Set(['node_modules', '.git', 'queue', 'instances', 'dist', 'build', 'coverage']);
const MAX_CALL_SITES = 20;
const LOW_USAGE_THRESHOLD = 2; // flag exports with this many or fewer external call sites

function listSourceFiles(dir, extensions) {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const result = [];
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        result.push(...listSourceFiles(path.join(dir, entry.name), extensions));
      } else if (entry.isFile() && extensions.some((e) => entry.name.endsWith(e))) {
        result.push(path.resolve(dir, entry.name));
      }
    }
    return result;
  } catch (err) {
    process.stderr.write(`[unused-export-scan] scan failed: ${err?.message ?? err}\n`);
    return [];
  }
}

const IDENT = '[A-Za-z_$][\\w$]*';
const ES_DECLARATION_RE = new RegExp(
  '^[ \\t]*export\\s+(?:declare\\s+)?(?:async\\s+)?'
  + '(?:abstract\\s+class|class|function\\*?|interface|type|(?:const\\s+)?enum|const|let|var)\\s+(' + IDENT + ')', 'gm');
const ES_DEFAULT_DECLARATION_RE = new RegExp(
  '^[ \\t]*export\\s+default\\s+(?:async\\s+)?(?:abstract\\s+class|class|function\\*?)\\s+(' + IDENT + ')', 'gm');
const ES_DEFAULT_IDENTIFIER_RE = new RegExp('^[ \\t]*export\\s+default\\s+(' + IDENT + ')\\s*;?[ \\t]*$', 'gm');
const ES_EXPORT_LIST_RE = /^[ \t]*export\s+(?:type\s+)?\{([^}]*)\}(\s*from\b)?/gm;

// ES/TS `export` definitions in one file's text. Comments/strings are blanked first so an
// `export` in prose or a string never matches. A `export { x } from '...'` list is a
// re-export (barrel) and contributes nothing; a local `export { a, b as c }` list contributes
// the name consumers import (`c`). Anonymous defaults (`export default () => ...`) have no
// searchable name and are skipped.
function extractEsExports(text) {
  const code = stripNonCode(String(text || ''));
  const set = new Set();
  for (const re of [ES_DECLARATION_RE, ES_DEFAULT_DECLARATION_RE, ES_DEFAULT_IDENTIFIER_RE]) {
    for (const m of code.matchAll(re)) set.add(m[1]);
  }
  for (const m of code.matchAll(ES_EXPORT_LIST_RE)) {
    if (m[2]) continue; // re-export from another module
    for (const part of m[1].split(',')) {
      const bits = part.trim().replace(/^type\s+/, '').split(/\s+as\s+/);
      const local = bits[0].trim();
      const exported = (bits[1] || bits[0]).trim();
      const name = exported === 'default' ? local : exported;
      if (new RegExp('^' + IDENT + '$').test(name)) set.add(name);
    }
  }
  return Array.from(set);
}

function extractExports(filePath) {
  const text = fs.readFileSync(filePath, 'utf8');
  const set = new Set();

  if (ES_DEFINE_EXTENSIONS.some((e) => filePath.endsWith(e))) {
    for (const name of extractEsExports(text)) set.add(name);
  }

  for (const m of text.matchAll(/module\.exports\s*=\s*\{([^}]*)\}/g)) {
    const inner = m[1];
    for (const part of inner.split(',')) {
      const trimmed = part.trim();
      if (!trimmed || trimmed.includes(':')) continue; // skip computed/renamed exports
      set.add(trimmed);
    }
  }

  for (const m of text.matchAll(/module\.exports\.(\w+)\s*=/g)) {
    const name = m[1];
    if (name.length > 0 && !set.has(name)) set.add(name);
  }

  for (const m of text.matchAll(/(?<!module\.)exports\.(\w+)\s*=/g)) {
    const name = m[1];
    if (name.length > 0 && !set.has(name)) set.add(name);
  }

  return Array.from(set).filter((n) => n.trim().length > 0);
}

function countCallSites(symbol, definingFile, searchRoots, repoRoot) {
  const escapedSymbol = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const wordBoundaryRe = new RegExp('\\b' + escapedSymbol + '\\b', 'm');
  const absDefiningFile = path.resolve(definingFile);
  const hits = [];

  function walk(dir) {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (hits.length >= MAX_CALL_SITES) return;
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (SKIP_DIRS.has(entry.name)) continue;
          walk(fullPath);
        } else if (entry.isFile() && SEARCH_EXTENSIONS.some((e) => entry.name.endsWith(e))) {
          if (fullPath === absDefiningFile) continue; // never count the definition itself
          try {
            const text = fs.readFileSync(fullPath, 'utf8');
            let lineNum = 0;
            for (const line of text.split('\n')) {
              lineNum++;
              if (hits.length >= MAX_CALL_SITES) return;
              if (wordBoundaryRe.test(line)) {
                hits.push({ file: path.relative(repoRoot, fullPath).replace(/\\/g, '/'), line: lineNum });
              }
            }
          } catch {}
        }
      }
    } catch {}
  }

  for (const root of searchRoots) {
    if (hits.length >= MAX_CALL_SITES) break;
    walk(root);
  }
  return hits.slice(0, MAX_CALL_SITES);
}

function scan() {
  const { repoRoot, unusedScanDirs, unusedSearchDirs } = getConfig();
  const scanRoots = unusedScanDirs.map((d) => path.join(repoRoot, d));
  const searchRoots = unusedSearchDirs.map((d) => path.join(repoRoot, d));

  const candidates = [];
  const scannedAt = new Date().toISOString();
  for (const dir of scanRoots) {
    for (const file of listSourceFiles(dir, DEFINE_EXTENSIONS)) {
      if (file.endsWith('.d.ts')) continue; // ambient declarations, not definitions
      for (const name of extractExports(file)) {
        const callSites = countCallSites(name, file, searchRoots, repoRoot);
        if (callSites.length <= LOW_USAGE_THRESHOLD) {
          candidates.push({
            symbol: name,
            definedIn: path.relative(repoRoot, file).replace(/\\/g, '/'),
            callSites,
            scannedAt,
          });
        }
      }
    }
  }
  return candidates;
}

function main() {
  const { pipelineDir } = getConfig();
  const resultsPath = path.join(pipelineDir, 'queue', 'dead-code-flags.json');
  const candidates = scan();
  fs.mkdirSync(path.dirname(resultsPath), { recursive: true });
  fs.writeFileSync(resultsPath, JSON.stringify(candidates, null, 2));
  console.log(`scanned, found ${candidates.length} low-usage export candidate(s), written to ${resultsPath}`);
}

if (require.main === module) { main(); }

module.exports = { scan, extractExports, extractEsExports, countCallSites };
