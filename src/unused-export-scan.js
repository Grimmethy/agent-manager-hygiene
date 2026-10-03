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
const FILE_FLAG_SYMBOL = '(file)'; // `symbol` of a whole-file flag (entry.kind === 'file'); not an identifier, so symbol-level checks never apply to it
const LOW_USAGE_THRESHOLD = 2; // flag exports with this many or fewer external call sites

// Throttle (2026-09-24, wiring this scanner into queue-watcher.sh for the first time):
// unlike a cheap sibling scan (file-length-scan.js is one pass over the tree), this one is
// O(exports x repo size) -- for every exported symbol it re-walks the whole search tree
// counting call sites. Running it every watchdog tick (~30-60s) would be real, wasted
// cost on a repo this size. Same isDue()/markChecked() shape
// proactive-file-decompose-sweep.js already uses (a JSON schedule file under instances/),
// default 24h, overridable via AGENT_MANAGER_UNUSED_EXPORT_SCAN_INTERVAL_MS.
const CHECK_INTERVAL_MS = Number(process.env.AGENT_MANAGER_UNUSED_EXPORT_SCAN_INTERVAL_MS) || 24 * 60 * 60 * 1000;

function schedulePath(instancesDir) {
  return path.join(instancesDir, '.unused-export-scan-schedule.json');
}

function isDue(instancesDir, now = new Date()) {
  let schedule;
  try {
    schedule = JSON.parse(fs.readFileSync(schedulePath(instancesDir), 'utf8'));
  } catch {
    return true; // never run before -- due immediately.
  }
  const last = schedule.lastCheckedAt;
  if (!last) return true;
  return now.getTime() - new Date(last).getTime() >= CHECK_INTERVAL_MS;
}

function markChecked(instancesDir, now = new Date()) {
  fs.mkdirSync(instancesDir, { recursive: true });
  fs.writeFileSync(schedulePath(instancesDir), JSON.stringify({ lastCheckedAt: now.toISOString() }, null, 2));
}

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

  // Comments/strings blanked first (2026-09-24 fix, found during a hand-verification
  // sweep of the first real scan): `[^}]*` happily spans a trailing `// comment` line
  // inside a multi-line `module.exports = { a, b, // some prose\n c }` list, and the
  // comma-split then added fragments of that COMMENT TEXT as if they were export names
  // (confirmed live: 13 of 251 real candidates from the first scan were comment prose,
  // not identifiers -- e.g. "// exported for direct unit testing"). Same treatment
  // extractEsExports already gives its own text. The identifier-shape check below is
  // belt-and-suspenders in case a comment survives stripping in some edge case.
  const codeForCjs = stripNonCode(text);
  for (const m of codeForCjs.matchAll(/module\.exports\s*=\s*\{([^}]*)\}/g)) {
    const inner = m[1];
    for (const part of inner.split(',')) {
      const trimmed = part.trim();
      if (!trimmed || trimmed.includes(':')) continue; // skip computed/renamed exports
      if (!new RegExp('^' + IDENT + '$').test(trimmed)) continue; // not a bare identifier -- skip
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

// ---- whole-file dead code (brain-dump #1752) ----------------------------------------------------------------------------
// Per-export flags turn one dead FILE into N independent candidates; applied together they can leave a half-component
// (shadcn's accordion.tsx: AccordionTrigger and AccordionContent were separate removal tasks, 162 of 183 TaxHarvest
// components/ui flags sat in 29 files nothing imports). A file is flagged ONCE, as a whole, only when every guard below
// holds; any doubt falls back to today's per-export behavior.
const FILE_CORPUS_EXTENSIONS = ['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.json', '.html', '.sh', '.yml', '.yaml', '.css'];
const FILE_CORPUS_SKIP_DIRS = new Set([...SKIP_DIRS, 'Docs']);
const FILE_CORPUS_SKIP_NAMES = new Set(['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml']);
const FILE_CORPUS_MAX_BYTES = 2 * 1024 * 1024;
// Never a whole-file candidate: tests, config files, directory entry points, ambient declarations.
// Whole-file flags are limited to ES-module files (.ts/.tsx/.jsx). CommonJS .js files are routinely loaded by directory loaders,
// CLIs and shell scripts that no static scan can see, so they keep today's per-export behavior.
const WHOLE_FILE_EXTENSIONS = ['.ts', '.tsx', '.jsx'];
const NEVER_WHOLE_FILE_RE = /(\.(test|spec)\.[^./]+$)|(__tests__\/)|(\.config\.[^./]+$)|((^|\/)index\.[^./]+$)|(\.d\.ts$)/;

function fileStem(file) {
  return path.basename(file).replace(/\.[^.]+$/, '');
}

// Every text file under repoRoot, read once (RAW text: import specifiers live in strings, which stripNonCode blanks).
// Build ONE per scan() call; fileImporters takes it as an argument. Unreadable files are skipped (errs toward "no importer
// seen", but isWholeFileDead has its own guards, and an unreadable corpus entry can only be a file we could not have parsed).
function buildFileCorpus(repoRoot) {
  const out = [];
  (function walk(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (FILE_CORPUS_SKIP_DIRS.has(entry.name)) continue;
        walk(full);
      } else if (entry.isFile() && FILE_CORPUS_EXTENSIONS.some((e) => entry.name.endsWith(e)) && !FILE_CORPUS_SKIP_NAMES.has(entry.name) && !entry.name.endsWith('.min.js')) {
        try {
          if (fs.statSync(full).size > FILE_CORPUS_MAX_BYTES) continue;
          out.push({ file: path.resolve(full), text: fs.readFileSync(full, 'utf8') });
        } catch { /* unreadable: skip */ }
      }
    }
  })(repoRoot);
  return out;
}

// Files whose raw text names `file` the way a module, script or config would: a quoted path ending in the stem (any
// extension or none -- relative and alias specifiers, dynamic import(), require(), barrel `export ... from`, side-effect and
// CSS imports, package.json fields), a quoted `stem.ext` filename, or an unquoted `stem.ext` path (shell, yaml, html).
// Deliberately over-inclusive: any file matching the last path segment counts, so no alias resolution is needed.
function fileImporters(file, corpus) {
  const abs = path.resolve(file);
  const stem = fileStem(file).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const quotedPath = new RegExp('[\'"`][^\'"`\\n]*[/@~#]' + stem + '(?:\\.[A-Za-z0-9]+)?[\'"`]');
  const quotedFilename = new RegExp('[\'"`]' + stem + '\\.(?:js|jsx|ts|tsx|mjs|cjs|css|json)[\'"`]');
  const barePath = new RegExp('(?:^|[\\s/=(:,])' + stem + '\\.(?:js|jsx|ts|tsx|mjs|cjs)(?![\\w])', 'm');
  const hits = [];
  for (const entry of corpus) {
    if (entry.file === abs) continue;
    if (quotedPath.test(entry.text) || quotedFilename.test(entry.text) || barePath.test(entry.text)) hits.push(entry.file);
  }
  return hits;
}

// Bundler-level directory loading (`import.meta.glob`, `require.context`) anywhere in the repo means files can be loaded with no
// path naming them, so no file is declared dead as a whole.
function corpusHasGlobLoader(corpus) {
  return corpus.some((e) => /import\.meta\.glob|require\.context\s*\(/.test(e.text));
}

// Returns { dead: true } or { dead: false, reason }.
// An export NAME appearing in another file is deliberately NOT a blocker: a file nothing imports cannot have its export used, and a
// same-named local (a `Breadcrumb` or `Avatar` defined elsewhere) is the normal case for scaffolded UI kits.
function isWholeFileDead({ file, text, exportNames, corpus, repoRoot }) {
  const rel = path.relative(repoRoot, file).replace(/\\/g, '/');
  if (NEVER_WHOLE_FILE_RE.test(rel)) return { dead: false, reason: 'test/config/index/declaration file' };
  if (!exportNames || exportNames.length === 0) return { dead: false, reason: 'no exports' };
  if (!WHOLE_FILE_EXTENSIONS.some((e) => file.endsWith(e))) return { dead: false, reason: 'CommonJS file: per-export only' };
  if (corpusHasGlobLoader(corpus)) return { dead: false, reason: 'repo uses a glob/context loader' };
  const raw = String(text || '');
  if (/require\.main\s*===?\s*module/.test(raw) || /^#!/.test(raw) || /import\.meta\.glob/.test(raw)) return { dead: false, reason: 'CLI/entry or glob-loaded file' };
  if (fileImporters(file, corpus).length > 0) return { dead: false, reason: 'imported or referenced' };
  return { dead: true };
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

// How many times `symbol` is really USED inside its own defining file -- the one place countCallSites
// deliberately never looks. A symbol with a same-file use is not dead code: at most its EXPORT is unused (brain-dump
// #1742: 10 of 10 TaxHarvest triage candidates were used only by a sibling function or a require.main CLI block in
// their own file, and acting on "remove the function" would have broken the file).
//
// Counted on stripNonCode(text), so a mention in a comment, string or template text is not a use. Not counted: the
// symbol's own definition token, and the export surface (a `module.exports = { ... }` list, `exports.sym`, an ES
// `export { ... }` list, `export default sym`). Everything else counts -- a call from another function, a use inside a
// `require.main === module` block, recursion, and a member access `x.sym` (errs toward NOT flagging). Known blind spot:
// stripNonCode blanks template-literal text including `${...}` interpolations, so a use only inside one is missed, which
// just leaves the flag in place (no worse than before this check existed).
function countSameFileUses(text, symbol) {
  const sym = String(symbol || '');
  if (!new RegExp('^' + IDENT + '$').test(sym)) return 0; // not an identifier: cannot reason about it, never suppress
  const code = stripNonCode(String(text || ''));
  const esc = sym.replace(/\$/g, '\\$');
  const ignore = [];
  const mark = (re) => { for (const m of code.matchAll(re)) ignore.push([m.index, m.index + m[0].length]); };
  mark(/module\.exports\s*=\s*\{[^}]*\}/g); // same region extractExports read the export names from
  mark(ES_EXPORT_LIST_RE);
  mark(ES_DEFAULT_IDENTIFIER_RE);
  mark(new RegExp('(?<![\\w$.])(?:module\\.)?exports\\.' + esc + '(?![\\w$])', 'g'));
  mark(new RegExp('(?<![\\w$])(?:function\\s*\\*?|abstract\\s+class|class|const\\s+enum|const|let|var|interface|type|enum)\\s+' + esc + '(?![\\w$])', 'g'));
  let uses = 0;
  for (const m of code.matchAll(new RegExp('(?<![\\w$])' + esc + '(?![\\w$])', 'g'))) {
    if (!ignore.some(([a, b]) => m.index >= a && m.index < b)) uses++;
  }
  return uses;
}

function scan() {
  const { repoRoot, unusedScanDirs, unusedSearchDirs } = getConfig();
  const scanRoots = unusedScanDirs.map((d) => path.join(repoRoot, d));
  const searchRoots = unusedSearchDirs.map((d) => path.join(repoRoot, d));

  const candidates = [];
  let skippedInternal = 0;
  let fileLevel = 0;
  let corpus = null; // every text file under repoRoot, read once and only if a file has exports with no external call sites
  const scannedAt = new Date().toISOString();
  for (const dir of scanRoots) {
    for (const file of listSourceFiles(dir, DEFINE_EXTENSIONS)) {
      if (file.endsWith('.d.ts')) continue; // ambient declarations, not definitions
      let fileText = null; // read lazily, once per file
      const readText = () => {
        if (fileText === null) { try { fileText = fs.readFileSync(file, 'utf8'); } catch { fileText = ''; } }
        return fileText;
      };
      const names = extractExports(file);
      const sites = names.map((name) => countCallSites(name, file, searchRoots, repoRoot));
      // Whole file first: when nothing uses any export and nothing imports the file, ONE flag replaces N export flags.
      if (names.length > 0 && WHOLE_FILE_EXTENSIONS.some((e) => file.endsWith(e))) {
        if (corpus === null) corpus = buildFileCorpus(repoRoot);
        const verdict = isWholeFileDead({ file, text: readText(), exportNames: names, corpus, repoRoot });
        if (verdict.dead) {
          fileLevel++;
          candidates.push({
            symbol: FILE_FLAG_SYMBOL,
            kind: 'file',
            definedIn: path.relative(repoRoot, file).replace(/\\/g, '/'),
            exports: names,
            callSites: [],
            scannedAt,
          });
          continue;
        }
      }
      names.forEach((name, i) => {
        const callSites = sites[i];
        if (callSites.length <= LOW_USAGE_THRESHOLD) {
          // Used inside its own file => not dead code (see countSameFileUses). An unreadable file counts as 0 uses: fail open.
          if (countSameFileUses(readText(), name) > 0) { skippedInternal++; return; }
          candidates.push({
            symbol: name,
            definedIn: path.relative(repoRoot, file).replace(/\\/g, '/'),
            callSites,
            scannedAt,
          });
        }
      });
    }
  }
  // Still a plain array (callers and tests deep-equal it, JSON.stringify ignores extra properties); the counts ride along.
  candidates.skippedInternal = skippedInternal;
  candidates.fileLevel = fileLevel;
  return candidates;
}

function main() {
  const { pipelineDir } = getConfig();
  const instancesDir = path.join(pipelineDir, 'instances');
  const force = process.argv.includes('--force');
  if (!force && !isDue(instancesDir)) {
    console.log('not due yet -- skipping (see AGENT_MANAGER_UNUSED_EXPORT_SCAN_INTERVAL_MS, or pass --force)');
    return;
  }

  const resultsPath = path.join(pipelineDir, 'queue', 'dead-code-flags.json');
  const candidates = scan();
  fs.mkdirSync(path.dirname(resultsPath), { recursive: true });
  fs.writeFileSync(resultsPath, JSON.stringify(candidates, null, 2));
  markChecked(instancesDir);
  const skipped = candidates.skippedInternal ? `, ${candidates.skippedInternal} skipped (used inside their own file)` : '';
  const wholeFiles = candidates.fileLevel ? `, ${candidates.fileLevel} of them whole-file` : '';
  console.log(`scanned, found ${candidates.length} low-usage export candidate(s)${wholeFiles}${skipped}, written to ${resultsPath}`);
}

if (require.main === module) { main(); }

module.exports = { scan, extractExports, extractEsExports, countCallSites, countSameFileUses, buildFileCorpus, fileImporters, isWholeFileDead, FILE_FLAG_SYMBOL, isDue, markChecked };
