'use strict';

// Naming-consistency scanner -- detects files where camelCase and snake_case identifiers
// are mixed within the same scope (locals or functions), which is a common source of
// style drift in projects that adopt a new convention mid-stream. Same architectural
// split as observability-scan.js / function-length-scan.js: this module ONLY detects and
// flags candidates; a downstream review task judges genuine issue vs. false positive.
//
// Dependencies kept narrow: only scan-utils.js's generic, rule-agnostic utilities plus
// fs/path from Node -- shared with observability-scan.js/performance-scan.js. Moved from
// agent-manager's src/maintenance/ in ADR-0022 Stage C.
//
// External-schema detection: names that mirror JSON field names (from .json files in the
// same directory), API payload keys, or env var names are skipped, since those follow
// an external contract the project did not choose (e.g. a third-party API returning
// snake_case keys while the project uses camelCase internally).

const fs = require('fs');
const path = require('path');
const {
  listSourceFiles,
  isVendoredPath,
  isLikelyMinified,
  isTestFile,
  SKIP_DIRS,
  stripNonCode,
  extractIdentifiers,
} = require('./scan-utils.js');

const SCAN_EXTENSIONS = ['.js', '.jsx', '.ts', '.tsx', '.py'];

// Regex patterns to classify identifier naming convention.
// camelCase: starts with lowercase, contains at least one uppercase letter, no underscores
// snake_case: all lowercase with underscores separating words
const CAMEL_CASE_RE = /^[a-z][a-zA-Z0-9]*$/;
const SNAKE_CASE_RE = /^[a-z][a-z0-9]*(_[a-z0-9]+)+$/;

// Collect top-level and nested object keys from a JSON structure (recursive).
// Used to build the set of external schema names that should be skipped.
function collectJsonKeys(obj, schemaNames) {
  if (obj === null || typeof obj !== 'object') return;
  if (Array.isArray(obj)) {
    for (const item of obj) {
      collectJsonKeys(item, schemaNames);
    }
    return;
  }
  for (const key of Object.keys(obj)) {
    schemaNames.add(key);
    collectJsonKeys(obj[key], schemaNames);
  }
}

// Build a set of external schema names from JSON files in the given directory.
// These names are skipped during naming-consistency checks because they follow an
// external contract (API responses, config files, etc.).
function collectExternalSchemas(dir) {
  const schemaNames = new Set();
  try {
    const files = fs.readdirSync(dir);
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      try {
        const content = fs.readFileSync(path.join(dir, file), 'utf8');
        const parsed = JSON.parse(content);
        collectJsonKeys(parsed, schemaNames);
      } catch {
        // Skip invalid JSON files
      }
    }
  } catch {
    // Skip directory read errors
  }
  return schemaNames;
}

// Check a single group of identifiers (locals or functions) for mixed naming.
// Filters out external schema names, then classifies by convention.
// If both camelCase and snake_case are present, emits a flag for each identifier.
function checkMixedNaming(identifiers, file, externalSchemas, flags) {
  // Filter out external schema names
  const internal = identifiers.filter((id) => !externalSchemas.has(id.name));

  // Classify by naming convention
  const camelCase = internal.filter((id) => CAMEL_CASE_RE.test(id.name));
  const snakeCase = internal.filter((id) => SNAKE_CASE_RE.test(id.name));

  // If both present, emit flags for each identifier
  if (camelCase.length > 0 && snakeCase.length > 0) {
    for (const id of camelCase) {
      flags.push({
        file,
        line: id.line,
        column: id.column,
        identifier: id.name,
        reason: `mixed naming in ${id.kind}: ${id.name} is camelCase but ${snakeCase[0].name} is snake_case`,
      });
    }
    for (const id of snakeCase) {
      flags.push({
        file,
        line: id.line,
        column: id.column,
        identifier: id.name,
        reason: `mixed naming in ${id.kind}: ${id.name} is snake_case but ${camelCase[0].name} is camelCase`,
      });
    }
  }
}

// Main scan function: iterates files, applies filters, extracts identifiers, flags
// mixed naming conventions. Returns an array of flag objects with file, line, column,
// identifier, and reason fields.
function run(dir) {
  const allFiles = listSourceFiles(dir, SCAN_EXTENSIONS);
  const flags = [];

  // Build external schemas map by directory (cached per directory)
  const externalSchemasByDir = new Map();
  for (const file of allFiles) {
    const dirName = path.dirname(file);
    if (!externalSchemasByDir.has(dirName)) {
      externalSchemasByDir.set(dirName, collectExternalSchemas(dirName));
    }
  }

  // Filter files
  const filtered = allFiles.filter((file) => {
    const relPath = path.relative(dir, file).replace(/\\/g, '/');
    if (isVendoredPath(relPath)) return false;
    if (isTestFile(relPath)) return false;
    if (relPath.split('/').some((seg) => SKIP_DIRS.has(seg))) return false;
    return true;
  });

  // Scan each file
  for (const file of filtered) {
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }

    // Skip minified files
    if (isLikelyMinified(text)) continue;

    const relPath = path.relative(dir, file).replace(/\\/g, '/');
    const code = stripNonCode(text);
    const externalSchemas = externalSchemasByDir.get(path.dirname(file)) || new Set();

    // Extract identifiers
    const identifiers = extractIdentifiers(code);

    // Group by kind (locals vs functions)
    const locals = identifiers.filter((id) => id.kind === 'variable');
    const functions = identifiers.filter((id) => id.kind === 'function' || id.kind === 'arrow');

    // Check each group for mixed naming
    checkMixedNaming(locals, relPath, externalSchemas, flags);
    checkMixedNaming(functions, relPath, externalSchemas, flags);
  }

  return flags;
}

// CLI entry point for quick testing
if (require.main === module) {
  const dir = process.argv[2] || '.';
  const flags = run(dir);
  console.log(JSON.stringify(flags, null, 2));
}

module.exports = { run };
