'use strict';

// Deterministic, dependency-free TODO/FIXME/HACK/XXX aging scanner. Same detect-only
// contract as the other hygiene scanners in this plugin: this script flags stale
// inline comments (queue/todo-aging-flags.json); a downstream Ornith triage task judges
// genuine issue vs. false positive and proposes a fix. That split matters here more than
// usual -- every rule below is a heuristic (regex over stripped text, git blame date
// comparison), not a real parser, so false positives are expected and are Ornith's job
// to filter, not this script's.
//
// The rule is simple: a TODO/FIXME/HACK/XXX comment that has sat in the codebase longer
// than TODO_AGE_THRESHOLD_DAYS (default 60) is "stale" -- it's been there long enough
// that either it should have been acted on, or it should have been removed. Stale hints
// are noise that hide the ones worth acting on.
//
// References:
//   - agent-manager core's task-sources.js warns about non-persistent audit sources
//     ("a persistent flags file can outlive the bug it was flagging") -- same pattern
//     here, the flags file must be pruned on each rescan.
//   - scan-utils' listSourceFiles + isLikelyMinified + isTestFile + SKIP_DIRS are the
//     same pre-filter every deterministic scanner in this plugin uses.
//   - flag-store's reconcileFlags is the downstream consumer that keeps the flags file
//     honest across rescans.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { listSourceFiles, stripNonCode, isLikelyMinified, isTestFile, SKIP_DIRS } = require('./scan-utils.js');

const SCAN_EXTENSIONS = ['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.py', '.go', '.rb', '.java', '.c', '.cpp', '.h', '.hpp', '.rs', '.swift', '.kt', '.scala', '.sh', '.bash', '.zsh'];

// Default threshold in days. Override per-deployment via TODO_AGE_THRESHOLD_DAYS env.
// Same convention as function-length-scan.js's AGENT_MANAGER_MAX_FUNCTION_LINES.
const DEFAULT_TODO_AGE_THRESHOLD_DAYS = 60;
function todoAgeThresholdDays() {
  const raw = process.env.TODO_AGE_THRESHOLD_DAYS;
  const parsed = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : DEFAULT_TODO_AGE_THRESHOLD_DAYS;
}

// Regex matches inline TODO/FIXME/HACK/XXX markers in comments. Covers JS/TS/C-style
// (// and /* */), Python/Shell (#), and Ruby (#) comment styles. The marker itself is
// captured in group 1 (the keyword), group 2 is the rest of the line after the keyword
// on the same line (the actual hint text). A finding is a stale comment when the
// referencedIssue is non-empty and the comment is older than the threshold.
const TODO_MARKER_RE = /\b(TODO|FIXME|HACK|XXX)\b/i;
const TODO_COMMENT_LINE_RE = /^(?:\s*(?:\/\/|\/\*|#!|#|::))(?:.*\b(TODO|FIXME|HACK|XXX)\b)(.*)/i;
const TODO_BLOCK_COMMENT_RE = /\/\*[\s\S]*?\b(TODO|FIXME|HACK|XXX)\b[\s\S]*?\*\//i;

// Strip the surrounding comment delimiters and whitespace from a TODO hint to get just
// the referenced issue. e.g. "TODO: fix this later" -> "fix this later".
function extractReferencedIssue(comment) {
  const m = String(comment || '').match(/(?:TODO|FIXME|HACK|XXX)\s*[:.]?\s*(.+)/i);
  if (!m) return null;
  return m[1].trim() || null;
}

// Run `git blame -L <start>,<end> --porcelain <file>` and parse the commit timestamp
// from the output. Returns the commit date as a Date, or null on failure (no git repo,
// file not tracked, blame unavailable, ...). Pure string work, no AST.
//
// Porcelain format (relevant lines):
//   0: "<hash> <orig> <final> <num-parents> [<mailmap>]"
//   1: "author <name>"
//   2: "author-mail <mail>"
//   3: "author-time <unix>"
//   4: "author-tz <tz>"
//   5: "committer <name>"
//   6: "committer-mail <mail>"
//   7: "committer-time <unix>"
//   8: "committer-tz <tz>"
// We use committer-time (when the change was applied) as the aging anchor -- a
// rebase/ amend preserves author-time but moves committer-time, and what matters for
// "how long has this hint been in the codebase" is when it landed, not when it was
// originally written.
function getBlameDate(repoRoot, absPath, lineNum) {
  try {
    const rel = path.relative(repoRoot, absPath);
    if (!rel || rel.startsWith('..')) return null; // not inside the repo
    const out = execFileSync('git', ['blame', '-L', `${lineNum},${lineNum}`, '--porcelain', rel], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 5000,
    });
    const lines = out.split('\n');
    // Look for committer-time (line index 7 in standard porcelain output).
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/^committer-time\s+(\d+)/);
      if (m) return new Date(parseInt(m[1], 10) * 1000);
    }
    // Fallback: author-time (line index 3).
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/^author-time\s+(\d+)/);
      if (m) return new Date(parseInt(m[1], 10) * 1000);
    }
    return null;
  } catch {
    return null;
  }
}

// Check if a file path is inside a vendor/static/vendor directory (excluded per task).
function isVendorPath(relPath) {
  return /(^|\/)(vendor|static|third_party|external|generated)[\/]/i.test(relPath);
}

// Compute the age in days between two dates (floor, non-negative).
function ageInDays(commitDate, now) {
  const diffMs = now - commitDate;
  if (diffMs < 0) return 0;
  return Math.floor(diffMs / (24 * 60 * 60 * 1000));
}

// Check if a trimmed line is a comment. Covers:
//   - // line comments (JS/TS/C/Java/Go/Rust/.../Shell)
//   - # line comments (Python/Shell/Ruby/.../Makefile)
//   - * continuation of a block comment (C-style multi-line)
//   - /* start of a block comment
//   - */ end of a block comment
//   - <!ENTITY ...> XML comments (less common, but caught)
//   - :: comment style (some DSLs)
function isCommentLine(trimmed) {
  if (!trimmed) return false;
  if (/^\/\//.test(trimmed)) return true;
  if (/^#/.test(trimmed)) return true;
  if (/^\*/.test(trimmed)) return true;
  if (/^\/\*/.test(trimmed)) return true;
  if (/^\*\//.test(trimmed)) return true;
  if (/^::/.test(trimmed)) return true;
  if (/^<!\w/.test(trimmed)) return true;
  return false;
}

// Scan one project's source tree for stale TODO/FIXME/HACK/XXX comments. Returns
// [{ rule, file, line, comment, ageDays, referencedIssue, isStale }]. Test files,
// minified bundles, vendor paths, and anything under SKIP_DIRS are excluded.
function findStaleTodos(repoRoot, thresholdDays = todoAgeThresholdDays()) {
  const now = new Date();
  const findings = [];
  for (const abs of listSourceFiles(repoRoot, SCAN_EXTENSIONS)) {
    const rel = path.relative(repoRoot, abs);
    if (isTestFile(rel)) continue;
    if (isVendorPath(rel)) continue;
    let text;
    try { text = fs.readFileSync(abs, 'utf8'); } catch { continue; }
    if (isLikelyMinified(text)) continue;
    const stripped = stripNonCode(text);

    // Search line-by-line in the ORIGINAL text for TODO markers in comment lines.
    // stripNonCode blanks the interior of comments (replacing them with spaces) so it
    // cannot be used to FIND the markers -- only to verify they're in code, not strings.
    // Instead, iterate lines, check if each is a comment, then check for the marker.
    const lines = text.split('\n');
    for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
      const line = lines[lineIdx];
      const lineNum = lineIdx + 1; // 1-indexed
      // Skip non-comment lines. A line is a comment if it starts with //, #, *, or
      // is inside a block comment (starts with /* or is between /* and */).
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (!isCommentLine(trimmed)) continue;

      // Check for TODO/FIXME/HACK/XXX marker (case-insensitive, whole word).
      const markerMatch = trimmed.match(/\b(TODO|FIXME|HACK|XXX)\b/i);
      if (!markerMatch) continue;
      const keyword = markerMatch[1];

      const commitDate = getBlameDate(repoRoot, abs, lineNum);
      if (!commitDate) continue;
      const ageDays = ageInDays(commitDate, now);
      const referencedIssue = extractReferencedIssue(trimmed);
      const isStale = ageDays > thresholdDays;

      findings.push({
        rule: 'todo-aging',
        file: rel,
        line: lineNum,
        comment: trimmed,
        ageDays,
        referencedIssue: referencedIssue || `${keyword} comment`,
        isStale,
      });
    }
  }
  findings.sort((a, b) => b.ageDays - a.ageDays);
  return findings;
}

// Scans one project, attaches projectSlug/scannedAt -- ready to persist to a flags file.
function scanProject(repoRoot, projectSlug) {
  const scannedAt = new Date().toISOString();
  const thresholdDays = todoAgeThresholdDays();
  const findings = findStaleTodos(repoRoot, thresholdDays);
  return findings.map((f) => ({ ...f, projectSlug, scannedAt, thresholdDays }));
}

// The scan(sourceFiles, options) entry point per the shared contract. `sourceFiles` is
// an array of { repoRoot, projectSlug } objects (the standard agent-manager source
// descriptor shape). `options` may carry an explicit thresholdDays override.
function scan(sourceFiles, options = {}) {
  const allFindings = [];
  for (const src of sourceFiles) {
    const repoRoot = src.repoRoot || src.path || src;
    const projectSlug = src.projectSlug || src.slug || path.basename(repoRoot);
    const thresholdDays = options.thresholdDays != null ? options.thresholdDays : todoAgeThresholdDays();
    const findings = findStaleTodos(repoRoot, thresholdDays);
    allFindings.push(...findings.map((f) => ({ ...f, projectSlug, scannedAt: new Date().toISOString() })));
  }
  allFindings.sort((a, b) => b.ageDays - a.ageDays);
  return allFindings;
}

module.exports = {
  DEFAULT_TODO_AGE_THRESHOLD_DAYS,
  todoAgeThresholdDays,
  findStaleTodos,
  scanProject,
  scan,
  getBlameDate,
  extractReferencedIssue,
  isVendorPath,
  ageInDays,
  SCAN_EXTENSIONS,
};

// CLI: `node src/todo-aging-scan.js [--json] [--threshold 30]`. Resolves repoRoot/
// pipelineDir in order: AGENT_MANAGER_REPO_ROOT / AGENT_MANAGER_PIPELINE_DIR env (how
// the agent-manager watchdog invokes it), then cwd.
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
  const threshold = process.argv.includes('--threshold')
    ? parseInt(process.argv[process.argv.indexOf('--threshold') + 1], 10)
    : undefined;
  const opts = threshold ? { thresholdDays: threshold } : {};
  const findings = scan([{ repoRoot: cfg.repoRoot, projectSlug: path.basename(cfg.repoRoot) }], opts);
  if (process.argv.includes('--json')) {
    process.stdout.write(JSON.stringify(findings, null, 2));
  } else {
    const staleCount = findings.filter((f) => f.isStale).length;
    console.log(`todo-aging-scan: ${findings.length} todo(s) found, ${staleCount} stale (threshold ${todoAgeThresholdDays()}d)`);
    for (const f of findings.filter((f) => f.isStale).slice(0, 20)) {
      console.log(`  ${String(f.ageDays).padStart(5)}d  ${f.file}:${f.line}  ${f.referencedIssue}`);
    }
  }
}
