'use strict';

// Deterministic, dependency-free performance-hygiene scanner -- Brain Dump #94
// ("our pretty little cpu is getting overloaded... we need to develop a performance
// review job for projects anyways"). Same split as observability-scan.js: this script
// only DETECTS and flags candidates (queue/performance-flags.json); a downstream Ornith
// triage task judges genuine issue vs. false positive and proposes a fix. That split
// matters here more than usual -- every rule below is a heuristic (brace-matching,
// keyword windows), not a real profiler or parser, so false positives are expected and
// are Ornith's job to filter, not this script's.
//
// Each rule has a JS form and a Python form (dispatched by file extension inside the
// find* functions). The JS forms key off Node APIs (fs.*Sync, child_process's *Sync) and
// a JS idiom; the Python forms key off blocking stdlib calls (subprocess/requests/urlopen)
// and the direct Python analogues (`await` in a loop, `json.loads(json.dumps(...))`).

const fs = require('fs');
const path = require('path');
const { extractBraceBody, extractIndentedBlock, listSourceFiles, lineOfIndex, isLikelyMinified, stripNonCode, isTestFile, isFindingInChangedRanges } = require('./scan-utils.js');

const SCAN_EXTENSIONS = ['.js', '.jsx', '.ts', '.tsx', '.py'];
const LOOP_START_RE = /\bfor\s*\([^)]*\)\s*\{|\bwhile\s*\([^)]*\)\s*\{/g;
// Python loop headers: `for ... :` / `while ... :` / `async for ... :` at a line start.
const PY_LOOP_RE = /^[ \t]*(?:async[ \t]+)?for[ \t]+[^\n]+?:[ \t]*(?:#.*)?$|^[ \t]*while[ \t]+[^\n]+?:[ \t]*(?:#.*)?$/gm;

// A synchronous fs/child_process call blocks the event loop for its full duration --
// fine once, a CPU/latency problem when it runs once per loop iteration instead of
// once total or in parallel.
const SYNC_IO_RE = /\b(?:readFileSync|writeFileSync|appendFileSync|existsSync|statSync|lstatSync|readdirSync|mkdirSync|renameSync|copyFileSync|unlinkSync|execSync|spawnSync)\s*\(/;

// The Python analogue: a blocking stdlib call (subprocess spawn, a synchronous HTTP
// request, os.system) run once per loop iteration where it could be batched, moved out,
// or run concurrently (asyncio / a thread pool).
const PY_BLOCKING_IO_RE = /\b(?:subprocess\.(?:run|call|check_output|check_call|Popen)|requests\.(?:get|post|put|delete|patch|head|request)|urlopen|os\.system)\s*\(/;

// A sequential `await` inside a loop serializes work that's very often independent
// per-iteration (e.g. N separate network/file fetches) and could run concurrently via
// Promise.all / asyncio.gather -- not always wrong (a deliberate rate-limited/ordered
// sequence is a legitimate reason), which is exactly why this is a candidate for the
// review model to judge, not an auto-fix.
const AWAIT_RE = /\bawait\b/;

function findLoopBodyIssues(text, relPath) {
  if (relPath.endsWith('.py')) return findPyLoopBodyIssues(text, relPath);
  // Hot-path loop rules do not apply to fixture/test code -- a loop that runs a handful
  // of times once per suite has no per-request cost to regress. Every such finding so far
  // has been a false positive.
  if (isTestFile(relPath)) return [];
  const findings = [];
  // Match loop headers and test the body against a string/comment-blanked view of the
  // source, so a `for (...) { await ... }` that only exists as string-literal fixture
  // data (its most common shape in this codebase's own tests) is never flagged. Indices
  // in `scan` line up 1:1 with `text`, so extractBraceBody / lineOfIndex use the real text.
  const scan = stripNonCode(text);
  LOOP_START_RE.lastIndex = 0;
  let m;
  while ((m = LOOP_START_RE.exec(scan))) {
    const openIndex = m.index + m[0].length - 1;
    const body = extractBraceBody(text, openIndex);
    if (body === null) continue;
    const codeBody = stripNonCode(body);
    const line = lineOfIndex(text, m.index);
    if (SYNC_IO_RE.test(codeBody)) {
      findings.push({
        rule: 'sync-io-in-loop',
        file: relPath,
        line,
        detail: 'a synchronous fs/child_process call runs inside this loop, blocking the event loop once per iteration',
      });
    }
    if (AWAIT_RE.test(codeBody)) {
      findings.push({
        rule: 'sequential-await-in-loop',
        file: relPath,
        line,
        detail: 'an await inside this loop serializes work that may be independent per-iteration and could run concurrently (e.g. via Promise.all)',
      });
    }
  }
  return findings;
}

function findPyLoopBodyIssues(text, relPath) {
  if (isTestFile(relPath)) return []; // same reasoning as findLoopBodyIssues
  const findings = [];
  PY_LOOP_RE.lastIndex = 0;
  let m;
  while ((m = PY_LOOP_RE.exec(text))) {
    const block = extractIndentedBlock(text, m.index);
    if (!block) continue;
    const body = block.body.split('\n').slice(1).join('\n'); // drop the loop header line
    const line = lineOfIndex(text, m.index);
    if (PY_BLOCKING_IO_RE.test(body)) {
      findings.push({
        rule: 'blocking-call-in-loop',
        file: relPath,
        line,
        detail: 'a blocking subprocess/HTTP/os.system call runs once per loop iteration -- consider batching it, hoisting it out, or running the iterations concurrently',
      });
    }
    if (AWAIT_RE.test(body)) {
      findings.push({
        rule: 'sequential-await-in-loop',
        file: relPath,
        line,
        detail: 'an await inside this loop serializes work that may be independent per-iteration and could run concurrently (e.g. via asyncio.gather)',
      });
    }
  }
  return findings;
}

// JSON.parse(JSON.stringify(x)) / json.loads(json.dumps(x)) is a common "deep clone"
// idiom that pays for a full serialize+reparse of the whole structure -- wasteful on a
// large/hot object compared to a real structural clone (structuredClone in JS,
// copy.deepcopy in Python, or a targeted shallow copy).
const JSON_CLONE_RE = /JSON\.parse\s*\(\s*JSON\.stringify\s*\(/g;
const PY_JSON_CLONE_RE = /json\.loads\s*\(\s*json\.dumps\s*\(/g;

function findJsonDeepCloneAntipattern(text, relPath) {
  const findings = [];
  const [re, hint] = relPath.endsWith('.py')
    ? [PY_JSON_CLONE_RE, 'json.loads(json.dumps(...)) used to deep-clone -- pays for a full serialize+reparse; consider copy.deepcopy or a targeted copy']
    : [JSON_CLONE_RE, 'JSON.parse(JSON.stringify(...)) used to deep-clone -- pays for a full serialize+reparse; consider structuredClone or a targeted copy'];
  // Match against a string/comment-blanked view so a `JSON.parse(JSON.stringify(...))` that
  // is only string-literal fixture data (its shape in this codebase's own scanner tests)
  // is never flagged. Indices align 1:1, so lineOfIndex uses the real text.
  const scan = stripNonCode(text);
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(scan))) {
    findings.push({
      rule: 'json-deep-clone-antipattern',
      file: relPath,
      line: lineOfIndex(text, m.index),
      detail: hint,
    });
  }
  return findings;
}

// Scans one project (a clonePath, already onboarded elsewhere -- this script never
// clones anything itself). Returns findings with projectSlug/scannedAt attached, ready
// to append to queue/performance-flags.json. Same shape as observability-scan.js's
// scanProject on purpose -- task-sources.js's nextPerformanceReviewTask consumes it
// identically to nextObservabilityReviewTask's own scanProject call, changedRanges
// (docs/diff-scoped-scan-proposal.md) included: optional, default-off, same contract.
function scanProject(clonePath, projectSlug, { changedRanges } = {}) {
  const files = changedRanges
    ? Object.keys(changedRanges)
        .map((rel) => path.join(clonePath, rel))
        .filter((f) => SCAN_EXTENSIONS.some((ext) => f.endsWith(ext)))
    : listSourceFiles(clonePath, SCAN_EXTENSIONS);
  const scannedAt = new Date().toISOString();
  const findings = [];
  const keep = (f) => isFindingInChangedRanges(f, changedRanges);

  for (const file of files) {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    // Same minified/bundled-build-output skip as observability-scan.js's own scanProject
    // -- a loop-body/deep-clone finding inside a hashed bundler output file is exactly as
    // unfixable-by-design as a silent-catch-block one there (see isLikelyMinified's
    // comment for the live-confirmed repeat-offender queue/blocked/ backlog this fixes).
    if (isLikelyMinified(text)) continue;
    const relPath = path.relative(clonePath, file).replace(/\\/g, '/');
    findings.push(...findLoopBodyIssues(text, relPath).filter(keep));
    findings.push(...findJsonDeepCloneAntipattern(text, relPath).filter(keep));
  }

  return findings.map((f) => ({ ...f, projectSlug, scannedAt }));
}

module.exports = {
  scanProject,
  findLoopBodyIssues,
  findPyLoopBodyIssues,
  findJsonDeepCloneAntipattern,
};
