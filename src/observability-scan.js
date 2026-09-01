'use strict';

// Deterministic, dependency-free observability-hygiene scanner. Same split as
// unused-export-scan.js: this script only DETECTS and flags candidates (queue/
// observability-flags.json); a downstream Ornith triage task judges genuine issue vs.
// false positive and proposes a fix. That split matters here more than usual -- every
// rule below is a heuristic (brace-matching, keyword windows), not a real parser, so
// false positives are expected and are Ornith's job to filter, not this script's.
//
// Rules encoded here come from two cloned reference repos (see project idea
// "OpenTelemetry-Observability-Idea", 2026-07-26):
//   - specification/error-handling.md (opentelemetry-specification): background/async
//     errors must not vanish silently; long-running processes should expose a health
//     signal.
//   - docs/general/naming.md (semantic-conventions): span/metric/attribute names must be
//     lowercase, dot-namespaced, snake_case per segment; counters must not use a
//     `_total` suffix; UpDownCounter names must not be pluralized.
// The naming/reserved-attribute rules only fire on a project that actually depends on
// an OpenTelemetry SDK -- agent-manager itself doesn't, so those two rules are expected
// to stay dormant against this repo and only activate against a scanned community
// project that has adopted OTel.

const fs = require('fs');
const path = require('path');
const { listSourceFiles, isLikelyMinified, lineOfIndex, extractBraceBody, extractIndentedBlock, stripNonCode, isTestFile } = require('./scan-utils.js');

const SCAN_EXTENSIONS = ['.js', '.jsx', '.ts', '.tsx', '.py', '.go'];
const LOOP_CONTEXT_WINDOW_LINES = 40;
const HEALTH_SIGNAL_RE = /heartbeat|health.?check|liveness|readiness/i;

// Strips comments AND string/docstring literals from a body so a body that's "empty
// except for a comment (or a lone docstring) explaining why it's intentionally empty"
// doesn't read as suspicious content. Covers both languages: // and /* */ (JS), # (Python/
// shell-ish), and triple-quoted Python strings.
function stripComments(body) {
  return body
    .replace(/'''[\s\S]*?'''|"""[\s\S]*?"""/g, '')
    .replace(/\/\/.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/#.*$/gm, '')
    .trim();
}

// error-handling.md's Guidance #2/#3/self-diagnostics: a caught error that is neither
// rethrown nor surfaced (logged, recorded as a metric, etc.) has silently vanished.
// Skips a body containing any of these tokens -- presence of ANY of them is read as
// "this error was surfaced somehow," even if imperfectly. Covers JS and Python idioms.
const SURFACES_ERROR_RE = /throw|console\.|log(ger|ging)?\.|\.error\(|Error\(|raise\b|panic\(|record|notify|alert|metric|traceback|warn|capture_exception|sys\.exc_info|reject\(|Promise\.reject|next\(err|captureException|Sentry|reportError|toast\(|showError\(|\.exception\(|\.critical\(|\.fatal\(|print\(|(?:cb|callback|done)\(\s*err/i;

// A Python `except` body that is ONLY `pass` or `...` is the silent-swallow equivalent of
// an empty JS catch block.
const PY_EMPTY_EXCEPT_RE = /^(?:pass|\.\.\.)$/;

// A catch/except body that is exactly `return <simple literal>` (or a bare `return`) is a
// deliberate "on failure, produce this default value" convention -- not an error that
// silently vanished. Scoped to LITERALS only: `return someFallbackVar` is a judgement
// call this scanner deliberately leaves to the review stage.
const JS_SIMPLE_RETURN_RE = /^return(\s+(null|undefined|false|true|\[\s*\]|\{\s*\}|0|-1|''|""|``))?\s*;?$/;
const PY_SIMPLE_RETURN_RE = /^return(\s+(None|False|True|\[\s*\]|\{\s*\}|0|-1|''|""))?$/;

// The RAW body (before stripComments) is non-empty but strips to nothing -> it is
// exclusively comment(s): a documented, deliberate no-op, not a silent swallow. (JS only;
// a Python `except:` body cannot be comment-only without a SyntaxError.)
function isCommentOnlyBody(rawBody, strippedBody) {
  return rawBody.trim().length > 0 && strippedBody.length === 0;
}

function findSilentCatchBlocks(text, relPath) {
  // Test / fixture / mock files deliberately swallow errors to exercise failure paths;
  // flagging them is noise. Matches performance-scan.js's use of the same helper.
  if (isTestFile(relPath)) return [];
  if (relPath.endsWith('.py')) return findSilentExceptBlocks(text, relPath);
  const findings = [];
  const catchRe = /\bcatch\s*(\([^)]*\))?\s*\{/g;
  let m;
  while ((m = catchRe.exec(text))) {
    const openIndex = m.index + m[0].length - 1;
    const body = extractBraceBody(text, openIndex);
    if (body === null) continue;
    const stripped = stripComments(body);
    // A body that is exclusively comment(s) is a documented, deliberate no-op.
    if (isCommentOnlyBody(body, stripped)) continue;
    // `catch { return null }` / bare `return;` etc. -- a deliberate "failure -> default
    // value" convention, not a vanished error.
    if (JS_SIMPLE_RETURN_RE.test(stripped)) continue;
    if (stripped.length === 0 || !SURFACES_ERROR_RE.test(stripped)) {
      findings.push({
        rule: 'silent-catch-block',
        file: relPath,
        line: lineOfIndex(text, m.index),
        detail: stripped.length === 0
          ? 'catch block is empty -- the error is silently discarded with no log/rethrow/metric'
          : 'catch block does not appear to log, rethrow, or otherwise surface the error',
      });
    }
  }
  return findings;
}

// Python counterpart of findSilentCatchBlocks: `except [Type [as e]]:` whose indented
// body neither re-raises nor surfaces the error. Same rule name / finding shape so the
// downstream review + deterministic-recheck paths treat it identically.
function findSilentExceptBlocks(text, relPath) {
  const findings = [];
  const exceptRe = /^([ \t]*)except\b[^\n:]*:/gm;
  let m;
  while ((m = exceptRe.exec(text))) {
    const block = extractIndentedBlock(text, m.index);
    if (!block) continue;
    // body's first line is the `except ...:` header itself -- judge only the block body.
    const bodyOnly = block.body.split('\n').slice(1).join('\n');
    const stripped = stripComments(bodyOnly);
    // `except X: return None` / bare `return` -- deliberate "failure -> default value".
    if (PY_SIMPLE_RETURN_RE.test(stripped)) continue;
    const isEmpty = stripped.length === 0 || PY_EMPTY_EXCEPT_RE.test(stripped);
    if (isEmpty || !SURFACES_ERROR_RE.test(stripped)) {
      findings.push({
        rule: 'silent-catch-block',
        file: relPath,
        line: lineOfIndex(text, m.index),
        detail: isEmpty
          ? 'except block is empty (only pass/.../a comment) -- the exception is silently discarded with no log/re-raise/metric'
          : 'except block does not appear to log, re-raise, or otherwise surface the exception',
      });
    }
  }
  return findings;
}

// self-observability.md: a long-running process should expose a health signal an
// operator can monitor. Heuristic: a while(true)/for(;;)/setInterval (JS) or `while True:`
// (Python) construct with no heartbeat/health-check/liveness keyword within the following
// N lines.
const LOOP_START_RE = /\bwhile\s*\(\s*true\s*\)|\bfor\s*\(\s*;\s*;\s*\)|\bsetInterval\s*\(|\bwhile\s+True\s*:/g;

function findUnguardedLoops(text, relPath) {
  const findings = [];
  let m;
  // Match loop headers against a string/comment-blanked view so a `while (true)` that is
  // only string-literal fixture data is never flagged. The health-signal window below is
  // checked against the REAL text -- a "heartbeat handled elsewhere" note in a comment is
  // a legitimate all-clear, not something to blank away.
  const scan = stripNonCode(text);
  LOOP_START_RE.lastIndex = 0;
  while ((m = LOOP_START_RE.exec(scan))) {
    const startLine = lineOfIndex(text, m.index);
    const lines = text.split('\n');
    const windowText = lines.slice(startLine - 1, startLine - 1 + LOOP_CONTEXT_WINDOW_LINES).join('\n');
    if (!HEALTH_SIGNAL_RE.test(windowText)) {
      findings.push({
        rule: 'unguarded-long-running-loop',
        file: relPath,
        line: startLine,
        detail: `long-running loop with no heartbeat/health-check signal within ${LOOP_CONTEXT_WINDOW_LINES} lines`,
      });
    }
  }
  return findings;
}

// Only the naming/reserved-attribute rules are conditional on the project actually
// depending on an OpenTelemetry SDK -- everything else applies to any codebase.
function hasOtelDependency(repoRoot) {
  const checks = [
    { file: 'package.json', re: /"@opentelemetry\// },
    { file: 'requirements.txt', re: /\bopentelemetry-/ },
    { file: 'pyproject.toml', re: /opentelemetry-/ },
    { file: 'go.mod', re: /go\.opentelemetry\.io/ },
  ];
  for (const { file, re } of checks) {
    try {
      const text = fs.readFileSync(path.join(repoRoot, file), 'utf8');
      if (re.test(text)) return true;
    } catch {}
  }
  return false;
}

// naming.md: lowercase, dot-namespaced, snake_case per segment.
function isValidOtelName(name) {
  if (name !== name.toLowerCase()) return 'name is not lowercase';
  if (!/^[a-z][a-z0-9_.]*[a-z0-9]$/.test(name)) {
    return 'name must be lowercase letters/digits/underscore/dot, starting with a letter and ending alphanumeric';
  }
  if (name.includes('..') || name.includes('__')) return 'name must not contain consecutive delimiters';
  return null;
}

// camelCase (JS SDK) and snake_case (Python SDK) method names both -- start_as_current_span
// is Python-only, the rest have a form in each.
const OTEL_CALL_RE = /\.(set_?[Aa]ttribute|create_?[Cc]ounter|create_?[Uu]p_?[Dd]own_?[Cc]ounter|create_?[Hh]istogram|create_?[Gg]auge|start_?[Ss]pan|start_as_current_span)\(\s*['"]([^'"]+)['"]/g;

function findOtelNamingViolations(text, relPath) {
  const findings = [];
  let m;
  OTEL_CALL_RE.lastIndex = 0;
  while ((m = OTEL_CALL_RE.exec(text))) {
    const [, method, name] = m;
    const line = lineOfIndex(text, m.index);
    const canonical = method.replace(/_/g, '').toLowerCase(); // createcounter / createupdowncounter / ...
    const nameError = isValidOtelName(name);
    if (nameError) {
      findings.push({ rule: 'otel-naming-convention', file: relPath, line, detail: `${method}('${name}'): ${nameError}` });
      continue;
    }
    if ((canonical === 'createcounter' || canonical === 'createupdowncounter') && name.endsWith('_total')) {
      findings.push({ rule: 'otel-naming-convention', file: relPath, line, detail: `${method}('${name}'): counter/UpDownCounter names should not use a '_total' suffix (naming.md)` });
    }
    if (canonical === 'createupdowncounter' && /s$/.test(name) && !/ss$/.test(name)) {
      findings.push({ rule: 'otel-naming-convention', file: relPath, line, detail: `${method}('${name}'): UpDownCounter names should not be pluralized (naming.md) -- verify this isn't a false positive on a naturally-plural word` });
    }
  }
  return findings;
}

// Reserved attributes (semantic-conventions.md): service.name/error.type/etc. must
// appear SOMEWHERE in an OTel-instrumented project. Repo-wide, not per-file -- these
// are meant to exist once (e.g. at Resource construction), not on every call site.
const RESERVED_ATTRIBUTES = ['service.name', 'error.type'];

function findMissingReservedAttributes(repoRoot, files) {
  const found = new Set();
  for (const file of files) {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    for (const attr of RESERVED_ATTRIBUTES) {
      if (found.has(attr)) continue;
      if (text.includes(attr)) found.add(attr);
    }
    if (found.size === RESERVED_ATTRIBUTES.length) break;
  }
  return RESERVED_ATTRIBUTES.filter((attr) => !found.has(attr)).map((attr) => ({
    rule: 'missing-reserved-attribute',
    file: null,
    line: null,
    detail: `project depends on an OpenTelemetry SDK but '${attr}' was not found anywhere in scanned source -- required by semantic-conventions.md`,
  }));
}

// Scans one project (a clonePath, already onboarded elsewhere -- this script never
// clones anything itself). Returns findings with projectSlug/scannedAt attached, ready
// to append to queue/observability-flags.json.
function scanProject(clonePath, projectSlug) {
  const allFiles = listSourceFiles(clonePath, SCAN_EXTENSIONS);
  // One read+check per file, up front, so every rule below (silent-catch-block,
  // unguarded-loop, OTel naming, reserved-attribute) skips minified/bundled files the
  // same way instead of each needing its own guard -- see isLikelyMinified's own comment.
  const files = allFiles.filter((file) => {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { return false; }
    return !isLikelyMinified(text);
  });
  const scannedAt = new Date().toISOString();
  const findings = [];

  for (const file of files) {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    const relPath = path.relative(clonePath, file).replace(/\\/g, '/');
    findings.push(...findSilentCatchBlocks(text, relPath));
    findings.push(...findUnguardedLoops(text, relPath));
  }

  if (hasOtelDependency(clonePath)) {
    for (const file of files) {
      let text;
      try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
      const relPath = path.relative(clonePath, file).replace(/\\/g, '/');
      findings.push(...findOtelNamingViolations(text, relPath));
    }
    findings.push(...findMissingReservedAttributes(clonePath, files));
  }

  return findings.map((f) => ({ ...f, projectSlug, scannedAt }));
}

module.exports = {
  scanProject,
  findSilentCatchBlocks,
  findSilentExceptBlocks,
  findUnguardedLoops,
  findOtelNamingViolations,
  findMissingReservedAttributes,
  hasOtelDependency,
  isValidOtelName,
};
