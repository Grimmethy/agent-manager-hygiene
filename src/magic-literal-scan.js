'use strict';

// Magic literal scanner -- detects overuse of magic numbers and strings in JS/Python files.
// Follows the same pattern as function-length-scan.js: narrow regex-based detection with
// clear exclusion rules, returning findings ready for downstream review tasks.
//
// Key design decisions:
// - Uses SKIP_DIRS from scan-utils.js for directory filtering (consistent with other scanners)
// - Excludes common literals (0, 1, -1, 2, 100, 1000) that are rarely problematic
// - Flags literals appearing 3+ times in one file (threshold calibrated to reduce noise)
// - Applies exclusion patterns for array indexes, imports, log messages, and object keys
// - Optional deduplication against existing function_length/nesting_depth flags to avoid
//   redundant findings at the same code location

const fs = require('fs');
const path = require('path');
const { SKIP_DIRS, isLikelyMinified, lineOfIndex } = require('./scan-utils.js');
const { reconcileFlags } = require('./flag-store.js');

const SCAN_EXTENSIONS = ['.js', '.jsx', '.ts', '.tsx', '.py'];

// Common literals that are rarely problematic (defaults, counters, thresholds)
const EXCLUDED_LITERALS = new Set(['0', '1', '-1', '2', '100', '1000']);

// Patterns that indicate a literal is not a magic literal (exclusion rules)
const ARRAY_INDEX_PATTERN = /\w+\[\d+\]/;
const IMPORT_PATTERN = /import\s+.*\s+from\s+['"]/;
const LOG_MESSAGE_PATTERN = /console\.(log|error|warn)\s*\(/;
const OBJECT_KEY_PATTERN = /['"]\w+['"]\s*:/;

function isTestFile(filePath) {
  const basename = path.basename(filePath);
  return basename.endsWith('.test.js') ||
         basename.endsWith('.test.ts') ||
         basename.endsWith('.spec.js') ||
         basename.endsWith('.spec.ts') ||
         basename.includes('__tests__') ||
         basename.includes('__test__');
}

function isVendoredPath(filePath) {
  const parts = filePath.split(/[\\/]/);
  return parts.some(part =>
    part === 'vendor' ||
    part === 'third_party' ||
    part === 'node_modules' ||
    part.startsWith('.')
  );
}

function findMagicLiterals(text, relPath) {
  const findings = [];
  const literalCounts = new Map();

  // Match numeric literals (integers and decimals, excluding hex/octal/binary)
  const numericRe = /\b(\d+\.?\d*)\b/g;
  // Match string literals (single and double quoted, not template literals)
  const stringRe = /(['"])([^'"]+)\1/g;

  let match;

  // Find numeric literals
  numericRe.lastIndex = 0;
  while ((match = numericRe.exec(text)) !== null) {
    const value = match[1];
    if (EXCLUDED_LITERALS.has(value)) continue;

    const context = text.slice(Math.max(0, match.index - 30), match.index + match[0].length + 30);
    if (ARRAY_INDEX_PATTERN.test(context)) continue;
    if (IMPORT_PATTERN.test(context)) continue;
    if (LOG_MESSAGE_PATTERN.test(context)) continue;

    literalCounts.set(value, (literalCounts.get(value) || 0) + 1);
  }

  // Find string literals
  stringRe.lastIndex = 0;
  while ((match = stringRe.exec(text)) !== null) {
    const value = match[2];
    if (value.length < 3) continue; // Skip very short strings (likely keys or flags)

    const context = text.slice(Math.max(0, match.index - 30), match.index + match[0].length + 30);
    if (IMPORT_PATTERN.test(context)) continue;
    if (LOG_MESSAGE_PATTERN.test(context)) continue;
    if (OBJECT_KEY_PATTERN.test(context)) continue;

    literalCounts.set(value, (literalCounts.get(value) || 0) + 1);
  }

  // Flag literals appearing 3+ times in this file
  for (const [value, count] of literalCounts) {
    if (count >= 3) {
      // Find the first occurrence for reporting
      const escapedValue = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const firstMatch = text.match(new RegExp(`\\b${escapedValue}\\b`));
      if (firstMatch) {
        findings.push({
          rule: 'magic-literal',
          file: relPath,
          line: lineOfIndex(text, firstMatch.index),
          value,
          count,
          type: /^\d/.test(value) ? 'numeric' : 'string',
          detail: `Magic literal "${value}" appears ${count} times -- consider extracting to a named constant`
        });
      }
    }
  }

  return findings;
}

// Scans a single file for magic literals
// Returns findings with rule/file/line/value/count/type/detail
function scan(filePath, content, options = {}) {
  if (isTestFile(filePath)) return [];
  if (isVendoredPath(filePath)) return [];
  if (isLikelyMinified(content)) return [];

  const relPath = path.relative(process.cwd(), filePath).replace(/\\/g, '/');
  let findings = findMagicLiterals(content, relPath);

  // Optional deduplication against existing function_length and nesting_depth flags
  // to avoid redundant findings at the same code location
  if (options.existingFlags && options.existingFlags.length > 0) {
    findings = findings.filter((finding) => {
      const findingKey = `${finding.file}::${finding.line}`;
      const hasOverlap = options.existingFlags.some((flag) => {
        if (flag.rule !== 'function-too-long' && flag.rule !== 'nesting-depth') return false;
        const flagKey = `${flag.file}::${flag.line}`;
        return flagKey === findingKey;
      });
      return !hasOverlap;
    });
  }

  return findings;
}

// Scans an entire project directory for magic literals
// Returns findings with projectSlug and scannedAt attached
function scanProject(projectRoot, projectSlug) {
  const allFiles = [];
  const scannedAt = new Date().toISOString();

  function walkDir(dir) {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.') || /^_?archived?$/i.test(entry.name)) {
            continue;
          }
          walkDir(path.join(dir, entry.name));
        } else if (entry.isFile() && SCAN_EXTENSIONS.some(ext => entry.name.endsWith(ext))) {
          allFiles.push(path.join(dir, entry.name));
        }
      }
    } catch (err) {
      // Ignore read errors (permission denied, etc.)
    }
  }

  walkDir(projectRoot);

  const findings = [];
  for (const file of allFiles) {
    let content;
    try {
      content = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }

    const relPath = path.relative(projectRoot, file).replace(/\\/g, '/');
    if (isLikelyMinified(content)) continue;

    const fileFindings = findMagicLiterals(content, relPath);
    findings.push(...fileFindings);
  }

  // Attach project metadata
  return findings.map(f => ({ ...f, projectSlug, scannedAt }));
}

// Generates fix suggestions for magic literal findings
// Returns array of {file, line, replacement, description}
function fix(findings) {
  return findings.map((f) => {
    const constantName = `MAGIC_${f.value.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
    const replacement = f.type === 'numeric'
      ? `const ${constantName} = ${f.value};`
      : `const ${constantName} = '${f.value.replace(/'/g, "\\'")}';`;

    return {
      file: f.file,
      line: f.line,
      replacement,
      description: `Extract magic literal "${f.value}" to named constant ${constantName}`
    };
  });
}

// Generates human-readable review summary and recommendations
// Returns {summary, recommendations, examples}
function review(findings) {
  if (findings.length === 0) {
    return {
      summary: 'No magic literals detected.',
      recommendations: []
    };
  }

  const numericCount = findings.filter(f => f.type === 'numeric').length;
  const stringCount = findings.filter(f => f.type === 'string').length;

  return {
    summary: `Found ${findings.length} magic literal(s): ${numericCount} numeric, ${stringCount} string.`,
    recommendations: [
      'Extract magic literals to named constants at module scope.',
      'Use descriptive names that explain the meaning, not the value.',
      'Consider using enums or constants files for related numeric values.',
      'For string literals, use a configuration object or constants module.'
    ],
    examples: [
      '// Before:\nconst timeout = 3000;\nconst maxRetries = 3;\n\n// After:\nconst REQUEST_TIMEOUT_MS = 3000;\nconst MAX_RETRIES = 3;\nconst timeout = REQUEST_TIMEOUT_MS;\nconst maxRetries = MAX_RETRIES;'
    ]
  };
}

// Register function returns the scanner module interface
// Matches the pattern used by other scanners (function-length-scan, observability-scan, etc.)
function register() {
  return {
    name: 'magic_literal',
    scan,
    fix,
    review
  };
}

module.exports = { register, scan, fix, review, scanProject };
