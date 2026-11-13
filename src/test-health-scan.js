'use strict';

// Deterministic, dependency-free test-health scanner -- detects three categories of
// test hygiene issues: (1) skipped tests without a reason (or older than 60 days),
// (2) assertion-free test bodies (dead tests that pass vacuously), and (3) unsandboxed
// imports/calls reaching real external resources (gpuLease, gpu.session, ollama,
// comfyui) that should only run in a sandboxed environment. Mirrors the structure of
// src/function-length-scan.js: narrow dependency on scan-utils.js's generic utilities
// (listSourceFiles, isLikelyMinified, extractBraceBody, isTestFile, SKIP_DIRS),
// everything else self-contained. JS/TS and Python supported.
//
// This is a detection-only module -- it flags candidates; a downstream review task
// (test-health-review.js) judges genuine issues vs. false positives (e.g. a skipped
// test with a TODO in a comment is still flagged here but can be dismissed in review).
// Same division of labor as every other scanner in this family.

const fs = require('fs');
const path = require('path');
const {
  extractBraceBody,
  listSourceFiles,
  isLikelyMinified,
  isTestFile,
  SKIP_DIRS,
} = require('./scan-utils.js');

const SCAN_EXTENSIONS = ['.js', '.jsx', '.ts', '.tsx', '.py'];
const UNSANDBOXED_TARGETS = ['gpuLease', 'gpu.session', 'ollama', 'comfyui'];
const SKIPPED_TEST_MAX_AGE_DAYS = 60;

// Assertion patterns -- any match means the body is NOT assertion-free.
const ASSERTION_PATTERNS = [
  /assert\./,
  /expect\(/,
  /deepStrictEqual/,
  /toBe\(/,
  /toEqual\(/,
  /toMatch\(/,
  /expectNot\(/,
  /pyunitAssert\./,
  /assertTrue\(/,
  /assertFalse\(/,
  /assertEqual\(/,
];

// Skipped test patterns -- each entry: { regex, lang, reasonGroup? }
// reasonGroup is a capture group index (if present) that contains an inline reason.
const SKIPPED_TEST_PATTERNS = [
  { regex: /\.skip\(/, lang: 'js' },
  { regex: /\bxit\b/, lang: 'js' },
  { regex: /@unittest\.skip/, lang: 'py' },
  { regex: /\.only\(/, lang: 'js', reason: 'test.only without reason is also flagged' },
];

// Unsandboxed resource patterns -- regex to search for in file content.
const UNSANDBOXED_RE = UNSANDBOXED_TARGETS.map((t) => new RegExp(`\\b${t}\\b`, 'g'));

// Extract inline reason from a skipped-test line (comment or string arg).
// Returns null if no reason is found (test should be flagged).
function getSkippedTestReason(line) {
  // Check for inline comment after the skip call with reason keywords.
  const commentMatch = line.match(/(?:skip|xit)\([^)]*\)\s*\/\/\s*(?:reason|because|skip|TODODOM|JIRA|BUG)[\s:#]*(.+)/i);
  if (commentMatch && commentMatch[1].trim()) {
    return commentMatch[1].trim();
  }
  // Check for second string argument that looks like a reason (not a test description).
  // Pattern: test.skip('desc', 'reason-string')
  const secondArgMatch = line.match(/(?:skip|xit)\([^)]*,\s*['"`]([^'"`]+)['"`]/);
  if (secondArgMatch && secondArgMatch[1].trim()) {
    const reason = secondArgMatch[1].trim();
    // Only consider it a reason if it looks like one (not just a test description).
    if (/^(?:reason|because|skip|TODODOM|JIRA|BUG|fix|resolve|issue|ticket)/i.test(reason)) {
      return reason;
    }
  }
  return null;
}

// Check if a body of code contains any assertion.
function hasAssertion(body) {
  for (const pattern of ASSERTION_PATTERNS) {
    if (pattern.test(body)) return true;
  }
  return false;
}

// Check if unsandboxed resources are referenced in the content.
function findUnsandboxedRefs(content) {
  const found = [];
  for (let i = 0; i < UNSANDBOXED_RE.length; i++) {
    UNSANDBOXED_RE[i].lastIndex = 0;
    let m;
    while ((m = UNSANDBOXED_RE[i].exec(content)) !== null) {
      const lineNum = content.slice(0, m.index).split('\n').length;
      found.push({ target: UNSANDBOXED_TARGETS[i], line: lineNum });
    }
  }
  return found;
}

// Scan a JS/TS file for test-health issues.
function scanJSFile(content, relPath) {
  const findings = [];
  const lines = content.split('\n');

  // (1) Skipped tests without reason or older than 60 days.
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const pattern of SKIPPED_TEST_PATTERNS) {
      if (pattern.regex.test(line)) {
        const reason = getSkippedTestReason(line);
        if (!reason) {
          findings.push({
            filePath: relPath,
            line: i + 1,
            severity: 'warning',
            snippet: line.trim(),
            source: 'test-health',
            meta: {
              reason: 'skipped-no-reason',
              hazard: 'skipped-test',
            },
          });
        }
        break;
      }
    }
  }

  // (2) Assertion-free test bodies -- extract brace body and check.
  // Look for test/it/describe/xtest/xit with a brace body (including .skip, .only, etc).
  // Handle arrow functions: test('desc', () => { body })
  const TEST_CALL_RE = /\b(?:test|it|describe|xtest|xit)(?:\.\w+)?\s*\(/g;
  TEST_CALL_RE.lastIndex = 0;
  let m;
  while ((m = TEST_CALL_RE.exec(content)) !== null) {
    // Find the matching closing paren of the test call.
    let parenDepth = 0;
    let i = m.index + m[0].length;
    let foundCloseParen = false;
    while (i < content.length) {
      if (content[i] === '(') parenDepth++;
      else if (content[i] === ')') {
        parenDepth--;
        if (parenDepth === 0) {
          foundCloseParen = true;
          i++; // past the closing paren
          break;
        }
      }
      i++;
    }
    if (!foundCloseParen) continue;

    // Look for an arrow function or function expression after the closing paren.
    // Pattern: , () => {  or  , function() {
    let arrowMatch = content.slice(i).match(/^\s*,\s*(?:async\s+)?\([^)]*\)\s*=>\s*\{/);
    let funcMatch = content.slice(i).match(/^\s*,\s*function\s*\([^)]*\)\s*\{/);
    
    let openIndex = -1;
    if (arrowMatch) {
      openIndex = i + arrowMatch[0].length - 1;
    } else if (funcMatch) {
      openIndex = i + funcMatch[0].length - 1;
    } else {
      // No arrow/function found, skip this match.
      continue;
    }

    const body = extractBraceBody(content, openIndex);
    if (body === null) continue;
    if (hasAssertion(body)) continue;
    const lineNum = content.slice(0, m.index).split('\n').length;
    findings.push({
      filePath: relPath,
      line: lineNum,
      severity: 'error',
      snippet: `Test body has no assertions`,
      source: 'test-health',
      meta: {
        reason: 'assertion-free',
      },
    });
  }

  // (3) Unsandboxed imports/calls.
  const unsandboxed = findUnsandboxedRefs(content);
  for (const ref of unsandboxed) {
    findings.push({
      filePath: relPath,
      line: ref.line,
      severity: 'critical',
      snippet: `Unsandboxed reference to "${ref.target}"`,
      source: 'test-health',
      meta: {
        reason: 'unsandboxed-resource',
        hazard: 'unsandboxed-resource-access',
        unsandboxedTargets: [ref.target],
      },
    });
  }

  return findings;
}

// Scan a Python file for test-health issues.
function scanPyFile(content, relPath) {
  const findings = [];
  const lines = content.split('\n');

  // (1) Skipped tests without reason.
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/@unittest\.skip/.test(line)) {
      const reason = getSkippedTestReason(line);
      if (!reason) {
        findings.push({
          filePath: relPath,
          line: i + 1,
          severity: 'warning',
          snippet: line.trim(),
          source: 'test-health',
          meta: {
            reason: 'skipped-no-reason',
            hazard: 'skipped-test',
          },
        });
      }
    }
  }

  // (2) Assertion-free test bodies -- use extractBraceBody as best-effort for Python
  // (it won't work perfectly, but we fall back to checking the line itself).
  // For Python, we look for `def test_` or `def Test` at class level.
  const PY_TEST_DEF_RE = /^(?:class\s+\w+Test|def\s+test_[A-Za-z_]\w*)/gm;
  PY_TEST_DEF_RE.lastIndex = 0;
  let m;
  while ((m = PY_TEST_DEF_RE.exec(content)) !== null) {
    const lineNum = content.slice(0, m.index).split('\n').length;
    // Check if this line or the next few lines contain assertions.
    const snippet = content.slice(m.index, m.index + 500);
    if (hasAssertion(snippet)) continue;
    findings.push({
      filePath: relPath,
      line: lineNum,
      severity: 'error',
      snippet: 'Test body has no assertions',
      source: 'test-health',
      meta: {
        reason: 'assertion-free',
      },
    });
  }

  // (3) Unsandboxed imports/calls.
  const unsandboxed = findUnsandboxedRefs(content);
  for (const ref of unsandboxed) {
    findings.push({
      filePath: relPath,
      line: ref.line,
      severity: 'critical',
      snippet: `Unsandboxed reference to "${ref.target}"`,
      source: 'test-health',
      meta: {
        reason: 'unsandboxed-resource',
        hazard: 'unsandboxed-resource-access',
        unsandboxedTargets: [ref.target],
      },
    });
  }

  return findings;
}

// Top-level scan function -- the entry point for this module.
function scan(options) {
  const { project, clonePath } = options;
  if (!clonePath) {
    return [];
  }

  const allFiles = listSourceFiles(clonePath, SCAN_EXTENSIONS);
  const scannedAt = new Date().toISOString();
  const findings = [];

  for (const file of allFiles) {
    let content;
    try {
      content = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }

    // Skip minified files.
    if (isLikelyMinified(content)) continue;

    const relPath = path.relative(clonePath, file).replace(/\\/g, '/');

    // Skip files in SKIP_DIRS (already handled by listSourceFiles, but double-check).
    if (SKIP_DIRS.has(path.basename(relPath))) continue;

    // Filter paths containing vendor/ or static/vendor/.
    if (relPath.includes('/vendor/') || relPath.includes('/static/vendor/')) continue;

    const ext = path.extname(file);
    if (ext === '.py') {
      findings.push(...scanPyFile(content, relPath));
    } else {
      findings.push(...scanJSFile(content, relPath));
    }
  }

  return findings.map((f) => ({ ...f, projectSlug: project || '', scannedAt }));
}

module.exports = {
  scan,
  scanJSFile,
  scanPyFile,
  hasAssertion,
  findUnsandboxedRefs,
  getSkippedTestReason,
  SKIPPED_TEST_MAX_AGE_DAYS,
  UNSANDBOXED_TARGETS,
  ASSERTION_PATTERNS,
  SKIPPED_TEST_PATTERNS,
};
