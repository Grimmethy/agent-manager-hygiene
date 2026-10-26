'use strict';

// Deterministic, dependency-free error-handling scanner -- fourth member of the
// maintenance task-source family, same detect-then-flag split as observability-scan.js /
// performance-scan.js / function-length-scan.js: THIS module only detects and flags
// candidates; the downstream review source (error_handling_review) judges genuine issue
// vs. false positive and the fix source (error_handling_fix) does the repair. The review
// stage's own judgment is what calibrates this, the same way every other scanner's
// heuristics stay useful despite firing on plenty of eventual false positives.
//
// Narrowest possible dependency on the rest of this plugin: scan-utils.js's generic,
// rule-agnostic utilities (listSourceFiles, isLikelyMinified, lineOfIndex, extractBraceBody,
// extractIndentedBlock, stripNonCode, isTestFile, windowFromContent), shared with the
// other three scanners. Everything else here is self-contained.
//
// Four patterns, same "one narrow detector per real shape, not one clever catch-all"
// style as every other rule in the family (regex + best-effort brace/indent matching,
// not a real parser -- false positives and negatives are both expected and are the
// review stage's job to filter):
//   - lost_cause        JS/TS catch block whose body neither rethrows nor surfaces the error
//   - floating_promise  a call to a same-file `async` function as a bare statement, not awaited
//   - unhandled_then    a `.then(` chain whose statement never attaches a `.catch(`
//   - broad_except      Python bare `except:` / `except Exception:` swallowing everything
//
// Every skipped file and every deduped candidate is recorded in a `dismissals` array
// alongside the flags, using the shared contract's reason tokens (skipped_minified,
// skipped_vendor, skipped_node_modules, skipped_test, deduped_by:<source>) so a wrongly
// dismissed case is findable by grepping for its file path.

const fs = require('fs');
const path = require('path');
const {
  listSourceFiles,
  isLikelyMinified,
  lineOfIndex,
  extractBraceBody,
  extractIndentedBlock,
  stripNonCode,
  isTestFile,
  windowFromContent,
} = require('./scan-utils.js');

// Shared contract tokens -- used exactly as-is by error-handling-review.js, register.js
// and the test files; do not rename.
const SOURCE_ID = 'error_handling_review';
const PATTERNS = ['lost_cause', 'floating_promise', 'unhandled_then', 'broad_except'];

// Dismissal reason tokens from the shared contract (the review source re-uses the same
// strings for its own dismissals: false_positive, deduped_by:<other_source>, ...).
const REASON_SKIPPED_MINIFIED = 'skipped_minified';
const REASON_SKIPPED_VENDOR = 'skipped_vendor';
const REASON_SKIPPED_NODE_MODULES = 'skipped_node_modules';
const REASON_SKIPPED_TEST = 'skipped_test';
const REASON_DEDUPED_BY = 'deduped_by:';

const SCAN_EXTENSIONS = ['.js', '.jsx', '.ts', '.tsx', '.py'];

// Path-based skip rules -- pure string tests on the repo-relative path, applied BEFORE
// any content-based rule so a genuine case in a real source file is never dismissed by
// accident. listSourceFiles' own SKIP_DIRS already keeps node_modules/vendor off the walk,
// but committed vendor trees (a repo that commits node_modules, static/vendor/ bundles)
// can still reach a scanner invoked on a hand-picked directory, so we re-check explicitly
// here instead of trusting the walk alone.
function skipReasonForPath(relPath) {
  const p = String(relPath || '').replace(/\\/g, '/');
  if (/(^|\/)node_modules\//.test(p)) return REASON_SKIPPED_NODE_MODULES;
  if (/(^|\/)(static\/)?vendor\//.test(p)) return REASON_SKIPPED_VENDOR;
  return null;
}

// JS/TS: a catch block whose body surfaces the error in no way (no throw/rethrow, no
// reject, no next(err), no log/record, no state-setter) is a lost error cause. Same
// SURFACES_ERROR_RE-style token list as observability-scan.js's silent-catch rule:
// presence of ANY of them is read as "the error was surfaced somehow, even imperfectly."
const SURFACES_ERROR_RE = /throw|reject\s*\(s?\b|Promise\.reject|next\s*\(\s*err|console\.|log(ger|ging)?\.|\.error\s*\(|Error\s*\(|raise\b|record|notify|alert|metric|traceback|warn|capture|Sentry|report|toast\s*\(|showError\s*\(|\.exception\s*\(|\.critical\s*\(|\.fatal\s*\(|print\s*\(|(?:cb|callback|done)\s*\(\s*err|set[A-Za-z0-9_$]*(?:Err|Msg|Message|Fail|Warn|Toast|Alert|Banner)/i;
const CATCH_RE = /\bcatch\s*(\([^)]*\))?\s*\{/g;

function findLostCauses(text, relPath, flags, dismissals) {
  // Run against the string/comment-blanked view so a catch that exists only as
  // string-literal fixture data is never flagged (same convention as performance-scan.js).
  const scan = stripNonCode(text);
  CATCH_RE.lastIndex = 0;
  let m;
  while ((m = CATCH_RE.exec(scan))) {
    const openIndex = m.index + m[0].length - 1;
    const body = extractBraceBody(text, openIndex);
    if (body === null) continue; // unbalanced -- truncated file, nothing to report
    // stripComments-lite: blank strings/comments in the body, same reasoning as
    // observability-scan.js's stripComments.
    const stripped = body
      .replace(/'''[\s\S]*?'''|"""[\s\S]*?"""/g, '')
      .replace(/\/\/.*$/gm, '')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .trim();
    if (SURFACES_ERROR_RE.test(stripped)) continue;
    const line = lineOfIndex(text, m.index);
    flags.push(makeFlag(text, relPath, line, 'lost_cause', flags, dismissals));
  }
}

// JS/TS: collect the same file's own async function names (the only promise-returning
// calls we can confidently name without a type system), then flag a BARE-STATEMENT call
// to one of them: not awaited, not assigned, not returned, not handed to .then/.catch.
// `obj.asyncMethod()` counts too -- the call's position is a statement start, not the
// tail of another call.
const ASYNC_FUNCTION_RE = /\basync\s+function\s+([A-Za-z_$][\w$]*)/g;
const ASYNC_ARROW_RE = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*async\s+(?:function\b|\([^)]*\)\s*=>|\w)/g;

function findFloatingPromises(text, relPath, flags, dismissals) {
  const scan = stripNonCode(text);
  const asyncNames = new Set();
  let m;
  ASYNC_FUNCTION_RE.lastIndex = 0;
  while ((m = ASYNC_FUNCTION_RE.exec(scan))) asyncNames.add(m[1]);
  ASYNC_ARROW_RE.lastIndex = 0;
  while ((m = ASYNC_ARROW_RE.exec(scan))) asyncNames.add(m[1]);
  if (asyncNames.size === 0) return;

  const lineRe = /^\s*([A-Za-z_$][\w$]*)\s*\(/gm;
  lineRe.lastIndex = 0;
  while ((m = lineRe.exec(scan))) {
    const name = m[1];
    if (!asyncNames.has(name)) continue;
    const rest = scan.slice(m.index, m.index + 200); // to end of this line + a little
    const lineEnd = rest.indexOf('\n');
    const lineText = lineEnd === -1 ? rest : rest.slice(0, lineEnd);
    // Consumed some other way -> not floating (a .then chain is the unhandled_then rule's job).
    if (lineText.includes('await')) continue;
    if (/\breturn\s+/.test(lineText)) continue;
    if (/(^|[^.\w$])=/.test(lineText)) continue; // assigned
    if (/\.then\s*\(|\.catch\s*\(|\.finally\s*\(/.test(lineText)) continue;
    const line = lineOfIndex(text, m.index);
    flags.push(makeFlag(text, relPath, line, 'floating_promise', flags, dismissals));
  }
}

// JS/TS: a `.then(` whose statement never attaches a `.catch(` anywhere in the chain
// (checked across the match line + 2 following lines, since real chains wrap) is an
// unhandled rejection path. An awaited chain (await p.then(...)) is fine: the await is
// the handler.
const THEN_RE = /\.then\s*\(/g;

function findUnhandledThens(text, relPath, flags, dismissals) {
  const scan = stripNonCode(text);
  THEN_RE.lastIndex = 0;
  let m;
  while ((m = THEN_RE.exec(scan))) {
    const lines = scan.split('\n');
    const matchLine = lineOfIndex(scan, m.index) - 1; // 0-based
    const from = Math.max(0, matchLine - 1);          // chain may start on the previous line
    const to = Math.min(lines.length - 1, matchLine + 2);
    const window = lines.slice(from, to + 1).join('\n');
    if (window.includes('await')) continue;
    if (/\.catch\s*\(/.test(window)) continue;
    const line = lineOfIndex(text, m.index);
    flags.push(makeFlag(text, relPath, line, 'unhandled_then', flags, dismissals));
  }
}

// Python: bare `except:` swallows EVERYTHING (including KeyboardInterrupt/SystemExit,
// not even the real error type); `except Exception:` swallows the entire standard
// exception hierarchy. Both lose the specific cause behind them. `except SpecificErr:`
// is a normal, reviewed shape and is NOT flagged.
const BROAD_EXCEPT_RE = /^\s*except\s*(?:Exception\s*)?[:;]/gm;

function findBroadExceptBlocks(text, relPath, flags, dismissals) {
  BROAD_EXCEPT_RE.lastIndex = 0;
  let m;
  while ((m = BROAD_EXCEPT_RE.exec(text))) {
    // Require a real body: `except Exception:` with an empty body would be a scan
    // artifact of a dangling header, and extractIndentedBlock returning null says so.
    const block = extractIndentedBlock(text, m.index);
    if (!block) continue;
    const line = lineOfIndex(text, m.index);
    flags.push(makeFlag(text, relPath, line, 'broad_except', flags, dismissals));
  }
}

// Builds one flag record in the EXACT shared-contract shape {source, file, line, pattern,
// snippet, id} -- nothing more -- and enforces the file:line:pattern dedupe key (two
// different patterns on the same line keep distinct keys; a true repeat of the same
// triple is recorded as a dismissal, not silently dropped).
function makeFlag(text, relPath, line, pattern, flags, dismissals) {
  const id = `${relPath}:${line}:${pattern}`;
  if (flags.some((f) => f && f.id === id)) {
    dismissals.push({ reason: `${REASON_DEDUPED_BY}${SOURCE_ID}`, file: relPath, line, pattern });
    return null;
  }
  return {
    source: SOURCE_ID,
    file: relPath,
    line,
    pattern,
    snippet: windowFromContent(text, line),
    id,
  };
}

// Scans one already-read file's text for all four patterns. `relPath` is repo-relative
// with forward slashes. Returns { flags, dismissals } -- both may be empty. Path-based
// skip rules (node_modules, vendor, test files) are pure path-string checks applied
// FIRST; the minified check is the only content-based rule and runs before any pattern
// match, so a genuine finding in a real, hand-written, non-test source file is never
// dismissed by a pattern quirk.
function scanFile(text, relPath) {
  const flags = [];
  const dismissals = [];

  const pathReason = skipReasonForPath(relPath);
  if (pathReason) {
    dismissals.push({ reason: pathReason, file: relPath });
    return { flags, dismissals };
  }
  if (isLikelyMinified(text)) {
    dismissals.push({ reason: REASON_SKIPPED_MINIFIED, file: relPath });
    return { flags, dismissals };
  }
  if (isTestFile(relPath)) {
    // Test/fixture code deliberately exercises failure paths -- a broad except or a
    // swallowed error there is the fixture doing its job, same reasoning as every other
    // scanner's isTestFile short-circuit.
    dismissals.push({ reason: REASON_SKIPPED_TEST, file: relPath });
    return { flags, dismissals };
  }

  if (relPath.endsWith('.py')) {
    findBroadExceptBlocks(text, relPath, flags, dismissals);
  } else {
    findLostCauses(text, relPath, flags, dismissals);
    findFloatingPromises(text, relPath, flags, dismissals);
    findUnhandledThens(text, relPath, flags, dismissals);
  }

  return { flags: flags.filter(Boolean), dismissals };
}

// Scans one project (a real repoRoot, already checked out -- this module never clones or
// mutates anything). Returns { flags, dismissals }; flags carry projectSlug/scannedAt
// attached, ready to append to a persistent flags file, same shape the other scanners'
// scanProject returns.
function scanProject(repoRoot, projectSlug) {
  const allFiles = listSourceFiles(repoRoot, SCAN_EXTENSIONS);
  const scannedAt = new Date().toISOString();
  const flags = [];
  const dismissals = [];

  for (const file of allFiles) {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    const relPath = path.relative(repoRoot, file).replace(/\\/g, '/');
    const { flags: fileFlags, dismissals: fileDismissals } = scanFile(text, relPath);
    flags.push(...fileFlags);
    dismissals.push(...fileDismissals);
  }

  return {
    flags: flags.map((f) => ({ ...f, projectSlug, scannedAt })),
    dismissals,
  };
}

module.exports = {
  scanProject,
  scanFile,
  skipReasonForPath,
  SOURCE_ID,
  PATTERNS,
  SCAN_EXTENSIONS,
};
