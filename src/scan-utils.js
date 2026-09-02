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

const SKIP_DIRS = new Set(['node_modules', '.git', 'queue', 'instances', 'dist', 'build', 'coverage', 'venv', '.venv', '__pycache__', 'vendor']);

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

// Returns a copy of `text` with the SAME length and line breaks, but the *interior* of
// every string literal ('...', "...", `...`), regex literal, line comment and block
// comment replaced by spaces (delimiter chars and newlines are kept). A rule regex run
// against the result can only match REAL code -- it will never match a `for (...) {` or an
// `await` that is actually string data (a test fixture seeding a known-bad snippet), a
// comment, or the contents of a `/.../ ` pattern.
//
// Extends the string/comment state machine extractBraceBody uses with a heuristic regex-
// literal detector: a `/` starts a regex when the previous significant code token is one
// that cannot end an expression (an operator, `(`, `[`, `{`, `,`, `;`, `:`, `=>`, or a
// keyword like `return` / `typeof` / `case`). This is the standard "is this `/` a regex
// or a divide" rule; getting it wrong only costs a missed finding, never a false one --
// but NOT handling regex at all was a real bug (a `\"` inside `/.../ ` sent the scanner
// into a never-closing false string and blanked the rest of the file).
//
// A template literal is blanked wholesale, `${...}` interpolation included (an `await`
// inside `${}` in a loop body is rare; missing it is only a false negative). Indices are
// preserved, so a match position in the stripped text maps 1:1 onto the original.
const REGEX_PREV_KEYWORDS = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw',
  'case', 'do', 'else', 'yield', 'await',
]);

const IDENT_CHAR_RE = /[A-Za-z0-9_$]/;

function stripNonCode(text) {
  const out = text.split('');
  let inString = null; // "'", '"', '`', or null
  let inLineComment = false;
  let inBlockComment = false;
  let escapeNext = false;
  let prevCodeChar = ''; // last non-whitespace char processed as real code
  let word = '';         // identifier run ending at prevCodeChar (for keyword detection)
  let wordOpen = false;  // is the current run contiguous with the last code char?

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];

    if (inLineComment) {
      if (ch === '\n') inLineComment = false;
      else out[i] = ' ';
      continue;
    }
    if (inBlockComment) {
      if (ch === '*' && next === '/') { out[i] = ' '; out[i + 1] = ' '; i++; inBlockComment = false; }
      else if (ch !== '\n') out[i] = ' ';
      continue;
    }
    if (inString) {
      if (escapeNext) { escapeNext = false; if (ch !== '\n') out[i] = ' '; continue; }
      if (ch === '\\') { escapeNext = true; out[i] = ' '; continue; }
      if (ch === inString) { inString = null; prevCodeChar = ch; word = ''; wordOpen = false; continue; }
      if (ch !== '\n') out[i] = ' ';
      continue;
    }
    if (ch === '/' && next === '/') { inLineComment = true; out[i] = ' '; continue; }
    if (ch === '/' && next === '*') { inBlockComment = true; out[i] = ' '; continue; }

    if (ch === '/' && regexAllowedAfter(prevCodeChar, word)) {
      // Scan a regex body: /.../ with \ escapes and [...] char classes (a / inside a
      // class is literal). Blank the interior, keep both delimiters and trailing flags.
      let j = i + 1;
      let inClass = false;
      let esc = false;
      let closed = false;
      for (; j < text.length; j++) {
        const c = text[j];
        if (c === '\n') break; // unterminated on this line -- not a regex, bail
        if (esc) { esc = false; out[j] = ' '; continue; }
        if (c === '\\') { esc = true; out[j] = ' '; continue; }
        if (c === '[') { inClass = true; out[j] = ' '; continue; }
        if (c === ']') { inClass = false; out[j] = ' '; continue; }
        if (c === '/' && !inClass) { closed = true; break; } // keep the closing '/'
        out[j] = ' ';
      }
      if (closed) {
        i = j; // resume at the closing '/'; the loop's i++ steps past it
        prevCodeChar = '/';
        word = '';
        wordOpen = false;
        continue;
      }
      // fall through: treat this '/' as an ordinary code char
    }

    if (ch === '"' || ch === "'" || ch === '`') { inString = ch; word = ''; wordOpen = false; continue; }

    if (/\s/.test(ch)) { wordOpen = false; continue; } // whitespace: keep prevCodeChar & word, just break the run

    if (IDENT_CHAR_RE.test(ch)) {
      word = wordOpen ? word + ch : ch;
      wordOpen = true;
    } else {
      word = '';
      wordOpen = false;
    }
    prevCodeChar = ch;
  }
  return out.join('');
}

// True when a `/` at this position begins a regex literal rather than a division: the
// previous significant token cannot end an expression.
function regexAllowedAfter(prevCodeChar, word) {
  if (word && REGEX_PREV_KEYWORDS.has(word)) return true;
  if (!prevCodeChar) return true; // start of input
  return '([{,;:=!&|?+-*%^~<>'.includes(prevCodeChar);
}

// A path (repo-relative, forward slashes) that is test/fixture code, not production
// source. Hot-path perf rules (sync I/O in a loop, sequential await in a loop) are about
// per-request/per-tick cost and simply do not apply to a fixture loop that runs a
// handful of times once per suite -- every such finding to date has been a false
// positive the review stage had to hand-clear.
function isTestFile(relPath) {
  const p = String(relPath || '');
  return /\.(test|spec)\.[cm]?[jt]sx?$/i.test(p)                       // foo.test.js / foo.spec.ts
    || /(^|\/)(?:tests?|__tests__|__mocks__|fixtures?|__fixtures__)\//i.test(p) // in a tests/ or fixtures/ dir
    || /(^|\/)(?:test_[^/]+|conftest)\.py$/i.test(p)                   // pytest: test_foo.py / conftest.py
    || /_test\.py$/i.test(p);                                         // pytest: foo_test.py
}

// The -before / +after line window around a finding's line, used verbatim as the review
// task's promptContext.snippet AND (normalized) as the false-positive suppression key.
// One definition so the read-side window and the suppression-store write-side window can
// never drift apart.
function windowFromContent(content, line, before = 4, after = 3) {
  const lines = String(content == null ? '' : content).split('\n');
  const start = Math.max(0, (line || 1) - before);
  const end = Math.min(lines.length, (line || 1) + after);
  return lines.slice(start, end).join('\n');
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
  stripNonCode,
  isTestFile,
  windowFromContent,
  MINIFIED_LINE_LENGTH_THRESHOLD,
  SKIP_DIRS,
};
