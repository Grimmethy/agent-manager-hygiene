'use strict';

// Deterministic, dependency-free function-length scanner -- first member of the
// "maintenance" task-source family (2026-08-23, Grimmethy: "Let's start with the modular
// approach with the intent to further separate it into a fully separate npm later" --
// following the NASA/JPL "Power of 10" discussion: "No function should be longer than
// what can be printed on a single sheet of paper... typically ~60 lines"). Same split as
// observability-scan.js/performance-scan.js: this module ONLY detects and flags
// candidates; a downstream review task judges genuine issue vs. false positive (a long
// but linear, single-purpose sequence -- a big switch, a prompt-builder -- is not
// automatically a problem) and proposes a decomposition, exactly the same division of
// labor that keeps performance_review calibrated well rather than noisy.
//
// Narrowest possible dependency on the rest of this plugin (only scan-utils.js's generic,
// rule-agnostic utilities: extractBraceBody, listSourceFiles, isLikelyMinified,
// lineOfIndex, shared with observability-scan.js/performance-scan.js) -- everything else
// here is self-contained. Moved from agent-manager's src/maintenance/ in ADR-0022 Stage C.
//
// Regex-based function-boundary detection, not a real parser -- same accepted tradeoff
// as every other rule in observability-scan.js/performance-scan.js: false positives and
// false negatives are both expected and are the review stage's job to filter, not this
// script's. JS/TS only for this first version (brace-delimited); Python's indentation-
// delimited functions would need a different boundary detector and are an explicit
// future extension, not silently pretended to be covered here.

const fs = require('fs');
const path = require('path');
const { extractBraceBody, extractIndentedBlock, listSourceFiles, isLikelyMinified, lineOfIndex, isFindingInChangedRanges } = require('./scan-utils.js');

const SCAN_EXTENSIONS = ['.js', '.jsx', '.ts', '.tsx', '.py'];

// Starting calibration, not a strict NASA-60 mandate -- this codebase's own real style
// (heavily commented, verbose identifiers) runs longer than typical C, and the review
// stage's own genuine-vs-false-positive judgment is what actually calibrates this, the
// same way performance_review's heuristics stay useful despite firing on plenty of
// eventual false positives. Override via env var per-deployment, same convention
// staleness-audit.js's own AGENT_MANAGER_STALENESS_THRESHOLD_DAYS uses.
const DEFAULT_MAX_FUNCTION_LINES = 100;
function maxFunctionLines() {
  const raw = process.env.AGENT_MANAGER_MAX_FUNCTION_LINES;
  const parsed = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed >= 10 ? parsed : DEFAULT_MAX_FUNCTION_LINES;
}

// Three separate, narrow patterns rather than one broad one -- same "one regex per real
// shape, not a single clever catch-all" style observability-scan.js's own rules use, so
// each shape's match position is unambiguous. `name` capture groups exist for the two
// assignment forms so a finding can report a real identifier instead of "(anonymous)".
const NAMED_FUNCTION_RE = /\bfunction\s*\*?\s*[A-Za-z_$][\w$]*\s*\([^)]*\)\s*\{/g;
const ARROW_ASSIGNMENT_RE = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?\([^)]*\)\s*=>\s*\{/g;
const FUNCTION_EXPRESSION_ASSIGNMENT_RE = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?function\s*\*?\s*\([^)]*\)\s*\{/g;

function countLines(text) {
  if (!text) return 0;
  let n = 1;
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') n++;
  return n;
}

// Scans one already-read file's text for over-length functions, deduping by the opening
// brace's own position so a construct matched by more than one pattern (shouldn't happen
// given how narrow each is, but cheap to guard) is never reported twice.
function findLongFunctions(text, relPath, threshold = maxFunctionLines()) {
  const findings = [];
  const seenBraceIndex = new Set();

  const patterns = [
    { re: NAMED_FUNCTION_RE, nameGroup: null },
    { re: ARROW_ASSIGNMENT_RE, nameGroup: 1 },
    { re: FUNCTION_EXPRESSION_ASSIGNMENT_RE, nameGroup: 1 },
  ];

  for (const { re, nameGroup } of patterns) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text))) {
      const openIndex = m.index + m[0].length - 1;
      if (seenBraceIndex.has(openIndex)) continue;
      seenBraceIndex.add(openIndex);

      const body = extractBraceBody(text, openIndex);
      if (body === null) continue;
      const lines = countLines(body);
      if (lines <= threshold) continue;

      const name = nameGroup ? m[nameGroup] : (m[0].match(/function\s*\*?\s*([A-Za-z_$][\w$]*)/) || [])[1];
      findings.push({
        rule: 'function-too-long',
        file: relPath,
        line: lineOfIndex(text, m.index),
        // The measured body span, so the review stage can put the WHOLE flagged function
        // into its grounding snippet rather than a fixed +N-line window that cuts off
        // mid-body and makes the reviewer hallucinate the rest.
        lengthLines: lines,
        detail: `${name ? `function "${name}"` : 'this function'} is ${lines} lines long (threshold ${threshold}) -- consider decomposing into smaller, single-purpose functions`,
      });
    }
  }

  return findings;
}

// Python's brace-free equivalent: match `def` / `async def` at a line start (nested defs
// included -- flagged separately, same as JS nested functions), take the indented block
// via scan-utils' extractIndentedBlock, and measure its line span. `line` points at the
// `def`. Same regex-not-a-parser tradeoff as findLongFunctions above; a decorator stack
// above the def is not counted toward the length (it belongs to call sites, not the body).
const PY_DEF_RE = /^([ \t]*)(?:async[ \t]+)?def[ \t]+([A-Za-z_]\w*)[ \t]*\(/gm;

function findLongPythonFunctions(text, relPath, threshold = maxFunctionLines()) {
  const findings = [];
  PY_DEF_RE.lastIndex = 0;
  let m;
  while ((m = PY_DEF_RE.exec(text))) {
    const block = extractIndentedBlock(text, m.index);
    if (!block) continue;
    if (block.lineCount <= threshold) continue;
    findings.push({
      rule: 'function-too-long',
      file: relPath,
      line: lineOfIndex(text, m.index),
      lengthLines: block.lineCount,
      detail: `function "${m[2]}" is ${block.lineCount} lines long (threshold ${threshold}) -- consider decomposing into smaller, single-purpose functions`,
    });
  }
  return findings;
}

// Scans one project (a real repoRoot, already checked out -- this module never clones or
// mutates anything). Returns findings with projectSlug/scannedAt attached, ready to
// append to a persistent flags file, same shape observability-scan.js's own scanProject
// returns. JS/TS files go through findLongFunctions (brace-matched), .py files through
// findLongPythonFunctions (indentation-matched). `changedRanges`
// (docs/diff-scoped-scan-proposal.md) is optional and default-off; when passed, a
// finding's whole measured span (`lengthLines`) is checked against the diff, not just its
// declaration line -- a function whose body grew past the threshold because of an edit
// inside it still counts as "in the diff" even if the `function`/`def` line itself
// predates it (see isFindingInChangedRanges's own comment).
function scanProject(clonePath, projectSlug, { changedRanges } = {}) {
  const allFiles = changedRanges
    ? Object.keys(changedRanges)
        .map((rel) => path.join(clonePath, rel))
        .filter((f) => SCAN_EXTENSIONS.some((ext) => f.endsWith(ext)))
    : listSourceFiles(clonePath, SCAN_EXTENSIONS);
  const scannedAt = new Date().toISOString();
  const findings = [];
  const threshold = maxFunctionLines();
  const keep = (f) => isFindingInChangedRanges(f, changedRanges);

  for (const file of allFiles) {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    if (isLikelyMinified(text)) continue;
    const relPath = path.relative(clonePath, file).replace(/\\/g, '/');
    const finder = file.endsWith('.py') ? findLongPythonFunctions : findLongFunctions;
    findings.push(...finder(text, relPath, threshold).filter(keep));
  }

  return findings.map((f) => ({ ...f, projectSlug, scannedAt }));
}

module.exports = {
  scanProject,
  findLongFunctions,
  findLongPythonFunctions,
  countLines,
  maxFunctionLines,
  DEFAULT_MAX_FUNCTION_LINES,
};
