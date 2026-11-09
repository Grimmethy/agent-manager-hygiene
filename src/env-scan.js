'use strict';

// Environment-key hygiene scanner. Detects reads of process.env.X / os.environ[...] /
// os.getenv(...) in source files and compares them against documented keys in
// <repoRoot>/.env.example and README env tables. Flags:
//   1. Reads with no corresponding example/doc entry (undocumented)
//   2. Example/doc entries never read (documented-but-unused)
//
// Skips vendored paths (any path containing vendor/ or static/vendor/), minified files
// (via isLikelyMinified), test files (via isTestFile), and repos that commit node_modules.
// Uses the same SKIP_DIRS / helper API as scan-utils.js. Does NOT read agent-manager.env
// (only .example file and key names).

const fs = require('fs');
const path = require('path');
const {
  listSourceFiles,
  isLikelyMinified,
  isTestFile,
} = require('./scan-utils.js');

const SCAN_EXTENSIONS = ['.js', '.jsx', '.ts', '.tsx', '.py', '.go', '.rb', '.php', '.sh', '.bash'];

// Regex patterns for env key reads across languages.
const JS_ENV_READ_RE = /process\.env\.([A-Z_][A-Z0-9_]*)/g;
const PYTHON_ENV_READ_RE = /os\.environ\s*\[\s*['"]([A-Z_][A-Z0-9_]*)['"]\s*\]|os\.getenv\s*\(\s*['"]([A-Z_][A-Z0-9_]*)['"]\s*\)/g;
const GO_ENV_READ_RE = /os\.Getenv\s*\(\s*['"]([A-Z_][A-Z0-9_]*)['"]\s*\)|os\.LookupEnv\s*\(\s*['"]([A-Z_][A-Z0-9_]*)['"]\s*\)/g;
const RUBY_ENV_READ_RE = /ENV\s*\[\s*['"]([A-Z_][A-Z0-9_]*)['"]\s*\]|ENV\s*\(\s*['"]([A-Z_][A-Z0-9_]*)['"]\s*\)/g;
const PHP_ENV_READ_RE = /\$_ENV\s*\[\s*['"]([A-Z_][A-Z0-9_]*)['"]\s*\]|getenv\s*\(\s*['"]([A-Z_][A-Z0-9_]*)['"]\s*\)|\$_SERVER\s*\[\s*['"]([A-Z_][A-Z0-9_]*)['"]\s*\]/g;
const SHELL_ENV_READ_RE = /export\s+([A-Z_][A-Z0-9_]*)\s*=|^[A-Z_][A-Z0-9_]*\s*=/gm;

// README env table pattern: looks for tables with env var names in the first column.
const README_ENV_TABLE_RE = /^\|?\s*([A-Z_][A-Z0-9_]*)\s*\|/gm;

// Extract env keys from a file's text content.
function extractEnvKeys(text, filePath) {
  const keys = new Set();
  const ext = path.extname(filePath).toLowerCase();

  // JavaScript/TypeScript
  if (['.js', '.jsx', '.ts', '.tsx'].includes(ext)) {
    let m;
    JS_ENV_READ_RE.lastIndex = 0;
    while ((m = JS_ENV_READ_RE.exec(text))) {
      keys.add(m[1]);
    }
  }

  // Python
  if (ext === '.py') {
    let m;
    PYTHON_ENV_READ_RE.lastIndex = 0;
    while ((m = PYTHON_ENV_READ_RE.exec(text))) {
      if (m[1]) keys.add(m[1]);
      if (m[2]) keys.add(m[2]);
    }
  }

  // Go
  if (ext === '.go') {
    let m;
    GO_ENV_READ_RE.lastIndex = 0;
    while ((m = GO_ENV_READ_RE.exec(text))) {
      if (m[1]) keys.add(m[1]);
      if (m[2]) keys.add(m[2]);
    }
  }

  // Ruby
  if (ext === '.rb') {
    let m;
    RUBY_ENV_READ_RE.lastIndex = 0;
    while ((m = RUBY_ENV_READ_RE.exec(text))) {
      if (m[1]) keys.add(m[1]);
      if (m[2]) keys.add(m[2]);
    }
  }

  // PHP
  if (ext === '.php') {
    let m;
    PHP_ENV_READ_RE.lastIndex = 0;
    while ((m = PHP_ENV_READ_RE.exec(text))) {
      if (m[1]) keys.add(m[1]);
      if (m[2]) keys.add(m[2]);
      if (m[3]) keys.add(m[3]);
    }
  }

  // Shell scripts
  if (['.sh', '.bash'].includes(ext)) {
    let m;
    SHELL_ENV_READ_RE.lastIndex = 0;
    while ((m = SHELL_ENV_READ_RE.exec(text))) {
      const match = m[0].trim();
      const keyMatch = match.match(/^([A-Z_][A-Z0-9_]*)\s*=/);
      if (keyMatch) keys.add(keyMatch[1]);
    }
  }

  return keys;
}

// Extract env keys from a .env.example file.
function extractExampleKeys(examplePath) {
  const keys = new Set();
  try {
    const content = fs.readFileSync(examplePath, 'utf8');
    const lines = content.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      // Skip comments and empty lines
      if (!trimmed || trimmed.startsWith('#')) continue;
      // Match KEY=VALUE pattern
      const keyMatch = trimmed.match(/^([A-Z_][A-Z0-9_]*)\s*=/);
      if (keyMatch) keys.add(keyMatch[1]);
    }
  } catch (err) {
    // File doesn't exist or can't be read - that's okay, just no documented keys
  }
  return keys;
}

// Extract env keys from README files (look for tables with env var names).
function extractReadmeKeys(dir) {
  const keys = new Set();
  const readmeFiles = ['README.md', 'README.rst', 'README.txt'];

  for (const readme of readmeFiles) {
    const readmePath = path.join(dir, readme);
    try {
      const content = fs.readFileSync(readmePath, 'utf8');
      let m;
      README_ENV_TABLE_RE.lastIndex = 0;
      while ((m = README_ENV_TABLE_RE.exec(content))) {
        keys.add(m[1]);
      }
    } catch (err) {
      // File doesn't exist or can't be read
    }
  }

  return keys;
}

// Check if a path contains vendor/ or static/vendor/ (vendored code).
function isVendoredPath(relPath) {
  const parts = relPath.split('/');
  for (let i = 0; i < parts.length - 1; i++) {
    if (parts[i] === 'vendor' || (parts[i] === 'static' && parts[i + 1] === 'vendor')) {
      return true;
    }
  }
  return false;
}

// Scan a project directory for env key hygiene issues.
function scanProject(projectDir) {
  const findings = [];
  const scannedAt = new Date().toISOString();

  // Extract documented keys from .env.example
  const examplePath = path.join(projectDir, '.env.example');
  const documentedKeys = extractExampleKeys(examplePath);

  // Extract documented keys from README files
  const readmeKeys = extractReadmeKeys(projectDir);
  const allDocumentedKeys = new Set([...documentedKeys, ...readmeKeys]);

  // List source files, applying SKIP_DIRS filter
  const allFiles = listSourceFiles(projectDir, SCAN_EXTENSIONS);

  for (const filePath of allFiles) {
    const relPath = path.relative(projectDir, filePath).replace(/\\/g, '/');

    // Skip vendored paths
    if (isVendoredPath(relPath)) continue;

    // Skip test files
    if (isTestFile(relPath)) continue;

    // Read file content
    let text;
    try {
      text = fs.readFileSync(filePath, 'utf8');
    } catch (err) {
      continue;
    }

    // Skip minified files
    if (isLikelyMinified(text)) continue;

    // Extract env keys from this file
    const readKeys = extractEnvKeys(text, filePath);

    // Flag reads with no documented entry
    for (const key of readKeys) {
      if (!allDocumentedKeys.has(key)) {
        findings.push({
          rule: 'env-key-undocumented',
          file: relPath,
          key,
          scannedAt,
          detail: `Environment variable "${key}" is read but not documented in .env.example or README`,
        });
      }
    }
  }

  // Flag documented keys that are never read
  for (const key of allDocumentedKeys) {
    let wasRead = false;
    for (const filePath of allFiles) {
      const relPath = path.relative(projectDir, filePath).replace(/\\/g, '/');
      if (isVendoredPath(relPath)) continue;
      if (isTestFile(relPath)) continue;

      let text;
      try {
        text = fs.readFileSync(filePath, 'utf8');
      } catch (err) {
        continue;
      }
      if (isLikelyMinified(text)) continue;

      const readKeys = extractEnvKeys(text, filePath);
      if (readKeys.has(key)) {
        wasRead = true;
        break;
      }
    }

    if (!wasRead) {
      findings.push({
        rule: 'env-key-unread',
        key,
        scannedAt,
        detail: `Environment variable "${key}" is documented but never read in source files`,
      });
    }
  }

  return findings;
}

// Register this scanner with the task-source-registry.
function register(deps) {
  const { registerTaskSource } = require('agent-manager/src/task-source-registry.js');

  registerTaskSource('env-key-hygiene', {
    scan: scanProject,
    hygieneFamily: 'env-key-hygiene',
  });
}

module.exports = {
  scanProject,
  register,
  extractEnvKeys,
  extractExampleKeys,
  extractReadmeKeys,
  isVendoredPath,
};
