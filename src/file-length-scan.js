'use strict';

// Deterministic, dependency-free FILE-length scanner (2026-09-03, Grimmethy: "The 500 line
// code limit needs to be enforced" -- root-caused from jsg0, a task that failed 5x purely
// because its target file, python/dashboard/templates/index.html at 5,807 lines, is too big
// for the local model to orient in and edit reliably). The file-level counterpart to
// function-length-scan.js: that one flags functions over ~100 lines, this flags whole
// files over ~500. Same "detect + flag only" contract -- there is no review/fix source
// wired to this yet; a human authors the decomposition plan (queue/file-decompose-requests/,
// consumed by agent-manager's file-decompose-to-hub.js), because deciding module boundaries
// is a judgement call the local model can't make. This scanner just keeps the list of
// oversized files current and visible.
//
// Advisory only: nothing in the apply path rejects a diff for growing a file past the
// threshold (yet -- see the plan's "not in scope"). This writes queue/file-length-flags.json
// and logs a one-line summary on the watchdog tick, that's it.

const fs = require('fs');
const path = require('path');
const { listSourceFiles, isTestFile } = require('./scan-utils.js');

// scan-utils' isLikelyMinified fires on ANY single long line -- too aggressive here, it
// wrongly excludes a hand-written 2.6k-line file that happens to hold one long string
// constant (task-sources.js's review-guidance blob). A real minified bundle is a handful
// of enormous lines; that's what this checks.
function looksMinified(relPath, text, lineCount) {
  if (/(\.min\.|[.-]bundle[.-]|\.pack\.)/i.test(relPath)) return true;
  return lineCount > 0 && lineCount < 15 && text.length > 20000;
}

// index.html (a template with a 5.5k-line inline <script>) and shell scripts count here
// too -- they hit the same "too big to work in" wall as a .js/.py file.
const SCAN_EXTENSIONS = ['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.py', '.sh', '.html'];

// 500 is the starting calibration Grimmethy set. Override per-deployment, same convention
// as function-length-scan.js's AGENT_MANAGER_MAX_FUNCTION_LINES.
const DEFAULT_MAX_FILE_LINES = 500;
function maxFileLines() {
  const raw = process.env.AGENT_MANAGER_MAX_FILE_LINES;
  const parsed = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed >= 50 ? parsed : DEFAULT_MAX_FILE_LINES;
}

function countLines(text) {
  if (!text) return 0;
  let n = 1;
  for (let i = 0; i < text.length; i += 1) if (text[i] === '\n') n += 1;
  // a trailing newline shouldn't inflate the count by one
  return text.endsWith('\n') ? n - 1 : n;
}

// Returns [{ rule, file, lines, threshold, detail }], sorted largest-first. `repoRoot`
// is a real checkout (never cloned/mutated here). Test files, minified bundles, and
// anything under scan-utils' SKIP_DIRS (node_modules, queue, instances, vendor, ...) are
// excluded, same as every other scanner in this plugin.
function findLongFiles(repoRoot, threshold = maxFileLines()) {
  const findings = [];
  for (const abs of listSourceFiles(repoRoot, SCAN_EXTENSIONS)) {
    const rel = path.relative(repoRoot, abs);
    if (isTestFile(rel)) continue;
    let text;
    try { text = fs.readFileSync(abs, 'utf8'); } catch { continue; }
    const lines = countLines(text);
    if (looksMinified(rel, text, lines)) continue;
    if (lines <= threshold) continue;
    findings.push({
      rule: 'file-too-long',
      file: rel,
      lines,
      threshold,
      detail: `${rel} is ${lines} lines long (threshold ${threshold}) -- author a decomposition plan in queue/file-decompose-requests/ so the pipeline can split it into module-sized pieces`,
    });
  }
  findings.sort((a, b) => b.lines - a.lines);
  return findings;
}

// Scans one project, attaches projectSlug/scannedAt -- ready to persist to a flags file,
// same shape function-length-scan.js's scanProject returns.
function scanProject(repoRoot, projectSlug) {
  const scannedAt = new Date().toISOString();
  return findLongFiles(repoRoot).map((f) => ({ ...f, projectSlug, scannedAt }));
}

// Persist to <pipelineDir>/queue/file-length-flags.json (a plain snapshot -- unlike the
// function/observability flag stores this needs no reconcile: a file's line count is
// re-derived from scratch every scan, there is no accumulating backlog). Returns the
// finding count.
function writeFlags(pipelineDir, repoRoot, projectSlug) {
  const findings = scanProject(repoRoot, projectSlug || path.basename(repoRoot));
  const out = path.join(pipelineDir, 'queue', 'file-length-flags.json');
  try {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify({ scannedAt: new Date().toISOString(), threshold: maxFileLines(), findings }, null, 2));
  } catch (err) {
    console.error(`[file-length-scan] could not write ${out}: ${err.message}`);
  }
  return findings;
}

module.exports = {
  DEFAULT_MAX_FILE_LINES,
  maxFileLines,
  countLines,
  findLongFiles,
  scanProject,
  writeFlags,
  SCAN_EXTENSIONS,
};

// CLI: `node src/file-length-scan.js [--json]`. Resolves repoRoot/pipelineDir in order:
// AGENT_MANAGER_REPO_ROOT / AGENT_MANAGER_PIPELINE_DIR env (how the agent-manager watchdog
// invokes it -- `set -a; source agent-manager.env` puts both in the env), then
// agent-manager's own getConfig() if this module can resolve it, then cwd.
if (require.main === module) {
  let cfg = null;
  const envRepo = process.env.AGENT_MANAGER_REPO_ROOT;
  const envPipe = process.env.AGENT_MANAGER_PIPELINE_DIR || envRepo;
  if (envRepo) {
    cfg = { repoRoot: envRepo, pipelineDir: envPipe };
  } else {
    try {
      const { getConfig } = require('agent-manager/src/config.js');
      cfg = getConfig();
    } catch { cfg = { repoRoot: process.cwd(), pipelineDir: process.cwd() }; }
  }
  const findings = writeFlags(cfg.pipelineDir, cfg.repoRoot);
  if (process.argv.includes('--json')) {
    process.stdout.write(JSON.stringify(findings, null, 2));
  } else {
    console.log(`file-length-scan: ${findings.length} file(s) over ${maxFileLines()} lines`);
    for (const f of findings.slice(0, 20)) console.log(`  ${String(f.lines).padStart(5)}  ${f.file}`);
  }
}
