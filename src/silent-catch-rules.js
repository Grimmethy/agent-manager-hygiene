'use strict';
// Pure silent-catch dismissal rules.
//
// Contract:
// - No imports, no filesystem or process access, no module-level state.
// - classifySilentCatch returns { tier: 'keep' | 'low' | 'dismiss', reason }.
//   Result-affecting statements in the catch body always yield 'keep' and are
//   checked first. 'dismiss' is only returned when every try-body call is in
//   the cleanup set. Comments, logger role, localStorage writes and numeric
//   parsing can only lower the tier to 'low'.
// - Every 'dismiss' result carries a non-empty `reason` naming the rule that
//   fired. A caller that records dismissals (sibling 2/3) must emit that reason
//   so wrongly dismissed sites can be traced.
// - siteKey is a plain string builder. Two catches in one function with the same
//   callSig produce the same key. Callers that count must count occurrences per
//   key and must not use the key to skip classification.

const CLEANUP_CALLS = [
  'unlinkSync', 'rmSync', 'mkdirSync', 'close', 'disconnect', 'abort',
];
const CLEANUP_QUALIFIED = ['browser.close'];
const KNOWN_LANGUAGES = [
  'javascript', 'typescript', 'js', 'ts', 'python', 'py', 'node',
];

const LOW_COMMENT_RE = /best-effort|never|must not/i;
const LOCAL_STORAGE_WRITE_RE = /localStorage\s*\.\s*setItem\s*\(|localStorage\s*\[[^\]]*\]\s*=(?![=>])/;
const NUMERIC_PARSE_RE = /\b(?:parseInt|parseFloat|Number)\s*\(/;

function isNonEmptyString(v) {
  return typeof v === 'string' && v.length > 0;
}

// Returns true when the catch body contains a statement whose effect is visible
// outside the catch block.
function resultAffectingReason(catchBody) {
  if (/\breturn\b/.test(catchBody)) return 'catch body returns a value';
  if (/\bthrow\b/.test(catchBody)) return 'catch body rethrows';
  if (/\.push\s*\(/.test(catchBody)) return 'catch body pushes to a collection';
  if (/\b(?:status|error|err|ok|result)\s*:/.test(catchBody)) {
    return 'catch body builds a status/error field';
  }
  if (/\.(?:status|error|ok|result)\s*=(?![=>])/.test(catchBody)) {
    return 'catch body sets a status/error field';
  }
  // Strip local declarations, then look for any remaining plain assignment
  // to an identifier (outer variable) or any member assignment.
  const noDecls = catchBody.replace(/\b(?:let|const|var)\s+[A-Za-z_$][\w$]*\s*=/g, '');
  if (/(?:^|[^\w$.!<>=])[A-Za-z_$][\w$]*\s*=(?![=>])/.test(noDecls)) {
    return 'catch body assigns to an outer variable';
  }
  if (/\.[A-Za-z_$][\w$]*\s*=(?![=>])/.test(noDecls)) {
    return 'catch body assigns to a member';
  }
  return null;
}

function isCleanupCall(name) {
  if (CLEANUP_QUALIFIED.includes(name)) return true;
  const last = name.split('.').pop();
  return CLEANUP_CALLS.includes(last);
}

function classifySilentCatch(input) {
  const {
    filePath, enclosingFunction, tryCalls, catchBody, catchComment, language, moduleRole,
  } = input || {};

  // (b) Missing or unknown inputs never dismiss and never throw.
  if (!isNonEmptyString(filePath) || !isNonEmptyString(enclosingFunction)) {
    return { tier: 'keep', reason: 'unknown: missing filePath or enclosingFunction' };
  }
  if (!Array.isArray(tryCalls) || typeof catchBody !== 'string') {
    return { tier: 'keep', reason: 'unknown: missing tryCalls or catchBody' };
  }
  if (!KNOWN_LANGUAGES.includes(language)) {
    return { tier: 'keep', reason: 'unknown: unrecognised language' };
  }

  // (a) Result-affecting statements are checked first and short-circuit.
  const affecting = resultAffectingReason(catchBody);
  if (affecting) {
    return { tier: 'keep', reason: `keep: ${affecting}` };
  }

  // (d) Signals that can only lower the tier to 'low'.
  const lowReasons = [];
  if (typeof catchComment === 'string' && LOW_COMMENT_RE.test(catchComment)) {
    lowReasons.push('comment marks swallow as best-effort/never/must-not');
  }
  if (moduleRole === 'logger') {
    lowReasons.push('catch is in a logger module');
  }
  if (LOCAL_STORAGE_WRITE_RE.test(catchBody)) {
    lowReasons.push('catch body writes localStorage');
  }
  if (NUMERIC_PARSE_RE.test(catchBody) || tryCalls.some((c) => typeof c === 'string' && /^(?:parseInt|parseFloat|Number)$/.test(c))) {
    lowReasons.push('numeric parse of an optional field');
  }

  // (c) Dismiss only when the try body is non-empty and every call is cleanup.
  const allCleanup = tryCalls.length > 0 &&
    tryCalls.every((c) => typeof c === 'string' && isCleanupCall(c));
  if (allCleanup && lowReasons.length === 0) {
    return { tier: 'dismiss', reason: 'dismiss: every try-body call is a cleanup call' };
  }
  if (lowReasons.length > 0) {
    return { tier: 'low', reason: `low: ${lowReasons.join('; ')}` };
  }
  return { tier: 'keep', reason: 'keep: no benign-swallow rule matched' };
}

function siteKey(filePath, enclosingFunction, callSig) {
  return `${filePath}#${enclosingFunction}#${callSig}`;
}

module.exports = { classifySilentCatch, siteKey };
