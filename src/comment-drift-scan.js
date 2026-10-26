'use strict';

// Deterministic comment-drift scanner (HUB0002 sub-task 1 of 4) -- same family and same
// division of labor as function-length-scan.js: this module ONLY detects candidate drift
// and emits flags; the comment-drift review stage (a later HUB0002 sub-task) judges genuine
// issue vs. false positive. A comment is "drift" when it names a path or identifier that
// no longer exists anywhere in the repo (or its sibling repos): the code moved, was
// renamed, or was decomposed, and the sentence in the comment is now wrong.
//
// SHARED CONTRACT (fixed by the HUB0002 coordinator, all sub-tasks must use exactly these):
//   sourceId     : 'comment_drift'
//   flag shape   : { path, line, token, claimType, sentence, sourceId }
//   claimType    : 'path_missing' | 'symbol_missing' | 'core_claim_wrong'
//   dismissal    : { path, line, token, reason, timestamp }
//   reason values: 'vendor_skip' | 'historical_ref' | 'dedup_suppressed' | 'review_false_positive'
//   dedup key    : the (path, line, token) triple
// This module emits the 'vendor_skip', 'historical_ref' AND 'dedup_suppressed' dismissal
// reasons (every dropped candidate is recorded in the returned dismissalLog before it is
// discarded, so a wrongly-dropped case is always recoverable). 'review_false_positive' is
// reserved for the human-review stage, which alone gets to rule a flag a false positive.
//
// Narrowest possible dependency: only scan-utils.js's generic rule-agnostic helpers
// (listSourceFiles, isLikelyMinified, isTestFile, lineOfIndex) -- same import surface as
// function-length-scan.js. Everything else here is self-contained.
//
// Regex/comment-scanner based, not a real parser -- the same accepted tradeoff as every
// rule in function-length-scan.js: a `#` inside a Python string or a `//` inside a JS
// string can be misread as a comment start (a false positive the review stage filters),
// and a token can be missed (a false negative). Neither is silently hidden: both are
// visible in the flags/dismissalLog this module returns.

const fs = require('fs');
const path = require('path');
const { listSourceFiles, isLikelyMinified, isTestFile, lineOfIndex, stripNonCode } = require('./scan-utils.js');

const SOURCE_ID = 'comment_drift';
const SCAN_EXTENSIONS = ['.js', '.jsx', '.ts', '.tsx', '.py'];

// A vendor/third-party PATH TOKEN (not the scanned file -- listSourceFiles already never
// walks vendor/node_modules directories) legitimately is not expected to resolve inside
// this repo: it ships with the dependency. Flagging "vendor/thing does not exist here"
// would be pure noise, so such tokens are dismissed with reason 'vendor_skip' instead of
// being existence-checked or flagged.
const VENDOR_TOKEN_RE = /(^|\/)(?:vendor|node_modules|third[_-]?party)\//i;

// A sentence in the past tense about this code (was / used to / previously / formerly /
// moved from) or a dated note (a bare 4-digit year, "(2021)", "2019-03") is a historical
// reference: the path/symbol it names is EXPECTED to be gone, and naming where something
// used to live is the comment being accurate, not drifted. Dismissed with reason
// 'historical_ref' before the existence check runs, so the "moved from src/old.js" half
// of a move note never spawns a flag.
const HISTORICAL_REF_RE = /\b(?:was|were|used to|previously|formerly|moved from|renamed from)\b/i;
const DATED_NOTE_RE = /\b(?:19|20)\d{2}\b/; // 2021, 2019-03, "since (2018)" -- any 4-digit year

// The "stays in core" claim (see src/arch.js's own header comment and
// decompose-loop-autoroute.js: "hub KERNEL code, stays in core"): a comment asserting a
// symbol's home ("X stays in core, see src/x.js") is the strongest drift signal of all --
// if the named path/symbol is missing, the claim itself is wrong, which is more
// specific than a generic missing-symbol note. Detected by the phrasing, not by the
// token, so it applies to whichever token in the sentence is the missing one.
const CORE_CLAIM_RE = /\b(?:stays?|kept?|lives?|remains?|is kept|is staying)\s+in\s+(?:the\s+)?core\b/i;

// A path-like token: one or more segments separated by '/', ending in a filename with a
// dot extension (src/foo.js, agent-manager/src/task-sources.js, Docs/NOTES.md). URLs are
// stripped from the comment text before extraction, so example.com/foo.js never matches.
const PATH_TOKEN_RE = /(?:[A-Za-z_$][A-Za-z0-9_.-]*\/)+[A-Za-z0-9_$.-]+\.[A-Za-z0-9]{1,8}/g;
const URL_RE = /\bhttps?:\/\/\S+/g;
// Quoted identifiers: backticked `FooBar`, single- or double-quoted 'FooBar' -- the two
// ways this codebase's own comments name functions (see function-length-scan.js's own
// detail strings and the function-length-review tests).
const BACKTICK_TOKEN_RE = /`([^`\n]+)`/g;
const QUOTE_TOKEN_RE = /["']([^"'\n]+)["']/g;
const IDENTIFIER_RE = /^[A-Za-z_$][A-Za-z0-9_]*$/;
// A bare "foo.js" token (no slash): treated as a path-like candidate, resolved
// repo-relative first, then by basename anywhere in the tree.
const SOURCE_FILE_TOKEN_RE = /\.[A-Za-z0-9]{1,8}$/;

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isPathLikeToken(token) {
  const t = String(token || '');
  if (/\//.test(t) && /\.[A-Za-z0-9]{1,8}$/.test(t)) return true;
  return SOURCE_FILE_TOKEN_RE.test(t); // bare filename.js
}

// --- sentence + token extraction (regex-based, not a parser -- see module header) ---

// Split a comment's text into sentences: on line breaks, semicolons, and sentence-final
// punctuation followed by whitespace. The returned pieces are used for (a) the flag's
// `sentence` field, (b) the historical-reference filter, and (c) the "stays in core"
// claim detection -- all sentence-scoped, so one historical clause doesn't suppress a
// live clause in the same comment block.
function splitSentences(commentText) {
  return String(commentText || '')
    .split(/\n+|;\s*|\s+(?<=\.)\s+|\s+(?<=[!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// Pull candidate tokens out of ONE sentence: path-like tokens plus backtick/quoted
// identifiers. Intentionally NOT deduped here -- a repeated token is still a candidate,
// and the SHARED CONTRACT's (path, line, token) triple (dedup reason: 'dedup_suppressed')
// is what decides whether its second occurrence becomes a duplicate flag suppression or
// a genuinely separate hit on another line.
function extractCandidateTokens(sentence) {
  const tokens = [];
  const push = (raw) => {
    const t = String(raw || '').trim();
    if (!t || t.length < 2 || /\s/.test(t)) return;
    tokens.push(t);
  };
  const s = sentence.replace(URL_RE, ' ');
  for (const m of s.matchAll(PATH_TOKEN_RE)) push(m[0]);
  for (const m of s.matchAll(BACKTICK_TOKEN_RE)) push(m[1]);
  for (const m of s.matchAll(QUOTE_TOKEN_RE)) push(m[1]);
  return tokens;
}

// Collect a file's comments/docstrings as plain text (line-number mapping is done on the
// original comment position, not the extracted text, so flag lines stay correct).
function extractCommentTexts(text, isPython) {
  const out = [];
  if (isPython) {
    // Triple-quoted docstrings first, then # line comments (a # inside a docstring is
    // harmless: the docstring is already captured whole, and the # match just starts
    // inside it -- same regex-not-a-parser tradeoff as function-length-scan.js).
    const docRe = /("""|''')([\s\S]*?)\1/g;
    let m;
    while ((m = docRe.exec(text))) out.push(m[2]);
    const lineRe = /^\s*#[^\n]*/gm;
    while ((m = lineRe.exec(text))) out.push(m[0].replace(/^\s*#\s?/, ''));
  } else {
    const blockRe = /\/\*([\s\S]*?)\*\//g;
    let m;
    while ((m = blockRe.exec(text))) out.push(m[1]);
    const lineRe = /\/\/[^\n]*/g;
    while ((m = lineRe.exec(text))) out.push(m[0].replace(/^\/\/\s?/, ''));
  }
  return out;
}

// --- the two dismissal predicates (sentence-scoped) ---

function isHistoricalRef(sentence) {
  return HISTORICAL_REF_RE.test(sentence) || DATED_NOTE_RE.test(sentence);
}

function isCoreClaim(sentence) {
  return CORE_CLAIM_RE.test(sentence);
}

// --- file-level skips: test files, minified output, vendor/build trees ---

// A scanned file in a vendor/build tree, or a test/fixture file, never gets flags:
// vendored third-party source and test fixtures routinely name paths that intentionally
// don't exist in this repo (mock trees, examples). listSourceFiles already prunes
// node_modules/vendor/dist-style DIRECTORY names while walking; this re-checks the
// relative path so a symlinked or renamed vendor tree can't leak through, and adds the
// test/fixture rule function-length-scan.js gets for free from its rules never firing
// meaningfully on test noise.
function isSkippedFile(relPath, text) {
  const p = String(relPath || '').replace(/\\/g, '/');
  if (isTestFile(p)) return true;
  if (/(^|\/)(?:vendor|node_modules|third[_-]?party|dist|build|static\/assets)\/|\.min\.[cm]?[jt]sx?$/.test(p)) return true;
  return typeof text === 'string' && isLikelyMinified(text);
}

// --- existence checks (repo first, then sibling repos) ---

// Sibling repos this repo's comments may legitimately point at (a plugin extraction moves
// code OUT of the core repo; a comment in core that says "now lives in
// agent-manager-plugins/foo/src/bar.js" is drift-free once the plugin exists). Pass
// explicitly via `options.siblingRoots`, or as a path.delimiter-separated list of
// absolute roots in AGENT_MANAGER_SIBLING_REPOS.
function siblingRoots(options) {
  const explicit = Array.isArray(options.siblingRoots) ? options.siblingRoots : [];
  const envRaw = process.env.AGENT_MANAGER_SIBLING_REPOS || '';
  const fromEnv = envRaw.split(path.delimiter).map((s) => s.trim()).filter(Boolean);
  const seen = new Set();
  const roots = [];
  for (const r of [...explicit, ...fromEnv]) {
    const abs = path.resolve(r);
    if (!fs.existsSync(abs) || seen.has(abs)) continue;
    seen.add(abs);
    roots.push(abs);
  }
  return roots;
}

// A path-like token resolves if it exists under ANY root, at any suffix of its segments:
// "agent-manager/src/task-sources.js" resolves when "<root>/src/task-sources.js" exists
// (the leading repo-name segment is just the repo's directory name).
function pathTokenExists(roots, token) {
  const segments = String(token).split('/');
  for (let start = segments.length - 1; start >= 0; start--) {
    const rel = segments.slice(start).join('/');
    for (const root of roots) {
      if (fs.existsSync(path.join(root, rel))) return true;
    }
  }
  return false;
}

// An identifier "exists" if a whole-identifier (identifier-boundary, not substring)
// occurrence appears in REAL CODE of any source file of any root. stripNonCode
// (scan-utils.js) is what makes the check meaningful: a symbol that is only NAMED in
// comments or strings -- exactly the drift case this scanner looks for -- is not the
// same as a symbol the code actually references. Indices are preserved by stripNonCode,
// so a boundary match in the stripped text is a real code occurrence. Cached per scan:
// the tree is walked once per unique missing symbol, never once per token.
function symbolExists(roots, symbol, cache) {
  if (cache.has(symbol)) return cache.get(symbol);
  const re = new RegExp(`(^|[^A-Za-z0-9_$])${escapeRegExp(symbol)}($|[^A-Za-z0-9_$])`);
  let found = false;
  for (const root of roots) {
    for (const file of listSourceFiles(root, SCAN_EXTENSIONS)) {
      if (found) break;
      let text;
      try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
      if (re.test(stripNonCode(text))) { found = true; break; }
    }
    if (found) break;
  }
  cache.set(symbol, found);
  return found;
}

// Bare-filename tokens (no slash): exist if the relative path resolves or the basename
// appears anywhere in any root's source tree.
function basenameExists(roots, token, indexCache) {
  if (indexCache.has('built')) {
    return indexCache.get('index').some((names) => names.has(path.basename(token)));
  }
  const index = roots.map((root) => new Set(listSourceFiles(root, SCAN_EXTENSIONS).map((f) => path.basename(f))));
  indexCache.set('built', true);
  indexCache.set('index', index);
  return index.some((names) => names.has(path.basename(token)));
}

// --- the scan ---

// Scans one checked-out repo for comment drift. NEVER clones, mutates, or writes
// anything (the caller persists flags/dismissals). Returns:
//   { flags, dismissalLog, projectSlug, scannedAt }
// flags        -- the SHARED CONTRACT array: { path, line, token, claimType, sentence, sourceId }
// dismissalLog -- one { path, line, token, reason, timestamp } per dropped candidate,
//                 reason in { 'vendor_skip', 'historical_ref', 'dedup_suppressed' }
//                 (this module never emits 'review_false_positive' -- that reason belongs
//                 to the human-review stage alone, so the audit trail can tell a
//                 machine-dismissal from a human ruling).
function scanCommentDrift(repoRoot, projectSlug, options = {}) {
  const roots = [path.resolve(repoRoot), ...siblingRoots(options)];
  const allFiles = listSourceFiles(repoRoot, SCAN_EXTENSIONS);
  const flags = [];
  const dismissalLog = [];
  const seen = new Set(); // the (path, line, token) dedup triple, as "path::line::token"
  const symbolCache = new Map();
  const basenameCache = new Map();

  const dismiss = (relPath, line, token, reason) => {
    dismissalLog.push({ path: relPath, line, token, reason, timestamp: Date.now() });
  };

  for (const file of allFiles) {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    const relPath = path.relative(repoRoot, file).replace(/\\/g, '/');
    if (isSkippedFile(relPath, text)) continue; // test / minified / vendor files: no flags at all
    const isPython = file.endsWith('.py');

    // Map each comment occurrence back to its real line via its index in the file text.
    const commentRe = isPython
      ? /("""|''')([\s\S]*?)\1|^\s*#[^\n]*/gm
      : /\/\*([\s\S]*?)\*\/|\/\/[^\n]*/g;
    commentRe.lastIndex = 0;
    let cm;
    while ((cm = commentRe.exec(text))) {
      const commentText = (cm[2] !== undefined ? cm[2] : cm[1]) || cm[0].replace(/^\s*#\s?|^\s*(?:\/\/\s?|\/\*\s?)/, '');
      // cm.index is the comment start (or the line start for # comments, including
      // indent) -- either way the right line for lineOfIndex.
      const commentLine = lineOfIndex(text, cm.index);

      for (const sentence of splitSentences(commentText)) {
        const sentenceLine = commentLine; // sentence positions map within this comment
        for (const token of extractCandidateTokens(sentence)) {
          // Check order is load-bearing (the drop-risk ordering the contract pins):
          // 1. vendor path token -> 'vendor_skip'  (never even existence-checked)
          // 2. historical sentence -> 'historical_ref'  (the token IS expected to be gone)
          // 3. token exists (repo, then siblings) -> normal "it exists" path: no flag, no log
          // 4. missing + "stays in core" claim -> the MORE SPECIFIC 'core_claim_wrong' wins
          // 5. missing, no claim -> 'path_missing' (path-like) or 'symbol_missing' (identifier)
          // 6. a second candidate on the same (path, line, token) triple is NOT a second
          //    flag -- it is a 'dedup_suppressed' dismissal, recorded like every other drop.
          if (isPathLikeToken(token) && VENDOR_TOKEN_RE.test(token)) {
            dismiss(relPath, sentenceLine, token, 'vendor_skip');
            continue;
          }
          if (isHistoricalRef(sentence)) {
            dismiss(relPath, sentenceLine, token, 'historical_ref');
            continue;
          }

          let exists;
          if (isPathLikeToken(token)) {
            exists = pathTokenExists(roots, token)
              || (!String(token).includes('/') && basenameExists(roots, token, basenameCache));
          } else if (IDENTIFIER_RE.test(token) && token.length >= 4) {
            exists = symbolExists(roots, token, symbolCache);
          } else {
            continue; // not a path and not a plausible identifier -- not a candidate
          }
          if (exists) continue; // resolves somewhere real: the comment is accurate

          const key = `${relPath}::${sentenceLine}::${token}`;
          if (seen.has(key)) {
            dismiss(relPath, sentenceLine, token, 'dedup_suppressed');
            continue;
          }
          seen.add(key);

          const claimType = isCoreClaim(sentence)
            ? 'core_claim_wrong'
            : (isPathLikeToken(token) ? 'path_missing' : 'symbol_missing');
          flags.push({
            path: relPath,
            line: sentenceLine,
            token,
            claimType,
            sentence,
            sourceId: SOURCE_ID,
          });
        }
      }
    }
  }

  return { flags, dismissalLog, projectSlug, scannedAt: new Date().toISOString() };
}

// Mirror of function-length-scan.js's scanProject entry name, so the review stage and the
// tests can call either; same (repoRoot, projectSlug, options) -> { flags, ... } shape.
function scanProject(repoRoot, projectSlug, options) {
  return scanCommentDrift(repoRoot, projectSlug, options);
}

module.exports = {
  SOURCE_ID,
  scanCommentDrift,
  scanProject,
  isSkippedFile,
  isHistoricalRef,
  isCoreClaim,
  isPathLikeToken,
  splitSentences,
  extractCandidateTokens,
  extractCommentTexts,
  siblingRoots,
};
