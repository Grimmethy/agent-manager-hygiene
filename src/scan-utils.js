'use strict';

// Shared, rule-agnostic toolkit every deterministic maintenance scanner needs:
// walking a project's real source tree, recognizing minified/bundled output that's not
// worth flagging, converting a string index to a line number, and extracting one
// balanced brace body (a best-effort brace-matcher, not a real parser -- string/comment-
// aware so a brace inside either doesn't miscount depth). Extracted 2026-08-23 (Grimmethy:
// "Move the observability/performance scanners into src/maintenance/ next") from
// observability-scan.js, which performance-scan.js and function-length-scan.js were both
// already reaching into just for these four functions -- a genuinely shared toolkit, not
// observability-specific logic borrowed by two unrelated scanners.

const fs = require('fs');
const path = require('path');

const SKIP_DIRS = new Set(['node_modules', '.git', 'queue', 'instances', 'dist', 'build', 'coverage', 'venv', '.venv', '__pycache__']);

function listSourceFiles(dir, extensions) {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const result = [];
    for (const entry of entries) {
      if (entry.isDirectory()) {
        // Dot-directories (.git, .claude/worktrees, .venv, etc.) are tooling/session
        // state, never a project's own reviewable source -- confirmed live scanning
        // this repo itself, which picked up stray .claude/worktrees/*/*.js copies
        // before this check existed.
        if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
        result.push(...listSourceFiles(path.join(dir, entry.name), extensions));
      } else if (entry.isFile() && extensions.some((e) => entry.name.endsWith(e))) {
        result.push(path.resolve(dir, entry.name));
      }
    }
    return result;
  } catch (err) {
    console.error('[scan-utils] scan failed:', err.message, err.stack);
    return [];
  }
}

// Minified/bundled build output (index-BoHO2STY.js-style hashed bundler filenames under
// static/assets/, dist/, etc.) has no meaningful line structure to reason about, but
// SKIP_DIRS above only catches known BUILD DIRECTORY names -- a bundler that outputs into
// static/assets/ (a real, common convention, not something worth guessing every variant
// of into an ever-growing SKIP_DIRS list) sails right through undetected. Confirmed live,
// 2026-08-18: queue/blocked/ had 100+ repeat-offender observability_review tasks against
// exactly this shape -- captain-claw/flight_deck/static/assets/index-BoHO2STY.js, a
// React production bundle (single-letter minified identifiers, zero whitespace) -- every
// one blocked in review because no drafting model can meaningfully fix (or even parse) a
// "silent catch block" inside minified third-party runtime code that was never meant to
// be hand-edited in the first place; even if it could, the fix belongs in the pre-bundle
// source, not the bundle. A minifier collapsing an entire module into one line routinely
// produces lines in the tens or hundreds of thousands of characters -- real hand-written
// source, however dense, essentially never does. Checked once per file, not per rule, so
// every rule in every scanner using this benefits without each needing its own guard.
const MINIFIED_LINE_LENGTH_THRESHOLD = 2000;
function isLikelyMinified(text) {
  let lineStart = 0;
  for (let i = 0; i <= text.length; i++) {
    if (i === text.length || text[i] === '\n') {
      if (i - lineStart > MINIFIED_LINE_LENGTH_THRESHOLD) return true;
      lineStart = i + 1;
    }
  }
  return false;
}

function lineOfIndex(text, index) {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) {
    if (text[i] === '\n') line++;
  }
  return line;
}

// Best-effort brace-body extractor (not a real parser): given the index of an opening
// '{', returns the substring up to (exclusive of) its matching '}', tracking string
// literals and comments so a brace inside a string/comment doesn't miscount depth.
// Same reasoning as json-fence.js's extractBalancedJson, extended to cover the extra
// string/comment forms real source code has that raw JSON doesn't.
function extractBraceBody(text, openIndex) {
  let depth = 0;
  let inString = null; // one of "'", '"', '`', or null
  let inLineComment = false;
  let inBlockComment = false;
  let escapeNext = false;
  let bodyStart = -1;

  for (let i = openIndex; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];

    if (inLineComment) {
      if (ch === '\n') inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      if (ch === '*' && next === '/') { inBlockComment = false; i++; }
      continue;
    }
    if (inString) {
      if (escapeNext) { escapeNext = false; continue; }
      if (ch === '\\') { escapeNext = true; continue; }
      if (ch === inString) inString = null;
      continue;
    }
    if (ch === '/' && next === '/') { inLineComment = true; i++; continue; }
    if (ch === '/' && next === '*') { inBlockComment = true; i++; continue; }
    if (ch === '"' || ch === "'" || ch === '`') { inString = ch; continue; }

    if (ch === '{') {
      if (depth === 0) bodyStart = i + 1;
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(bodyStart, i);
    }
  }
  return null; // unbalanced -- truncated file or scan artifact, nothing to report
}

function leadingWhitespace(line) {
  return (line.match(/^[ \t]*/) || [''])[0];
}

// The Python equivalent of extractBraceBody: Python compound statements have no closing
// token, so a block's body is every following line indented deeper than its header line,
// up to (not including) the first line dedented back to the header's own indent or less.
// Given the index of any character on the HEADER line (a `def`/`for`/`while`/`try`/`with`/
// `if` line), returns { body, endIndex, lineCount } where:
//   - body      is the header line(s) + block-body text (blank and comment-only lines
//               inside the block belong to it; trailing blank lines are trimmed off)
//   - endIndex  is the char offset just past the last real body line
//   - lineCount is body's line span, the intuitive "this block is N lines long"
// Best-effort, same spirit as extractBraceBody: the header may span several physical
// lines (parenthesised args), so its terminator is taken to be the first physical line
// whose code (># comment stripped) ends with ':'. Returns null if no terminator is found
// within a small runaway window. Indentation is compared by leading-whitespace LENGTH,
// which is correct for any file that is internally consistent (all-spaces or all-tabs per
// level) -- a file that mixes them within one block is a heuristic miss the review stage
// filters, same tolerance every other rule here already accepts.
function extractIndentedBlock(text, headerStartIndex) {
  const lines = text.split('\n');

  let charCount = 0;
  let headerLineIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const lineEnd = charCount + lines[i].length;
    if (headerStartIndex >= charCount && headerStartIndex <= lineEnd) { headerLineIdx = i; break; }
    charCount = lineEnd + 1; // + 1 for the '\n'
  }
  if (headerLineIdx === -1) return null;

  const headerIndentLen = leadingWhitespace(lines[headerLineIdx]).length;

  let headerEndIdx = -1;
  for (let i = headerLineIdx; i < lines.length && i - headerLineIdx <= 40; i++) {
    const code = lines[i].replace(/#.*$/, '').replace(/\s+$/, '');
    if (code.endsWith(':')) { headerEndIdx = i; break; }
  }
  if (headerEndIdx === -1) return null;

  let lastRealLine = headerEndIdx;
  for (let i = headerEndIdx + 1; i < lines.length; i++) {
    if (lines[i].trim() === '') continue; // blank -- only counts if a deeper line follows
    if (leadingWhitespace(lines[i]).length <= headerIndentLen) break; // dedent -> block over
    lastRealLine = i;
  }

  const body = lines.slice(headerLineIdx, lastRealLine + 1).join('\n');
  let endIndex = 0;
  for (let i = 0; i <= lastRealLine; i++) endIndex += lines[i].length + 1;
  return { body, endIndex: endIndex - 1, lineCount: lastRealLine - headerLineIdx + 1 };
}

module.exports = {
  listSourceFiles,
  isLikelyMinified,
  lineOfIndex,
  extractBraceBody,
  extractIndentedBlock,
  leadingWhitespace,
  MINIFIED_LINE_LENGTH_THRESHOLD,
  SKIP_DIRS,
};
