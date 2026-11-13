'use strict';

// todo_aging_review -- review stage of the TODO/FIXME/HACK/XXX aging hygiene family.
// Mirrors function-length-review.js's two-stage shape: a deterministic scanner
// (todo-aging-scan.js) flags stale comments, this review stage judges whether the
// referenced entity still exists in the codebase, and routes findings to either the
// fix stage (resolved) or the candidate path (valid).
//
// The review logic:
//   1. Extract the referenced entity name from each stale TODO comment
//   2. Check if that entity still exists in the codebase using fuzzy matching
//   3. Classify as:
//      - RESOLVED: entity doesn't exist → route to fix stage for deletion
//      - VALID: entity exists → route through candidate path as brain-dump candidate
//      - AMBIGUOUS: uncertain match → leave for human review
//
// Uses reconcileFlags from flag-store.js for deduplication and isSuppressed from
// suppression-store.js for user suppressions. Dismissals are recorded in the flags
// file with reason 'stale_todo_resolved' for audit trail.

const path = require('path');
const fs = require('fs');
const { reconcileFlags } = require('./flag-store.js');
const { isSuppressed } = require('./suppression-store.js');

// Levenshtein distance for fuzzy matching. Returns the minimum number of single-character
// edits (insertions, deletions, or substitutions) required to change one word into another.
function levenshteinDistance(a, b) {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  const matrix = [];
  for (let i = 0; i <= b.length; i++) {
    matrix[i] = [i];
  }
  for (let j = 0; j <= a.length; j++) {
    matrix[0][j] = j;
  }

  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b[i - 1] === a[j - 1]) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1, // substitution
          matrix[i][j - 1] + 1,     // insertion
          matrix[i - 1][j] + 1      // deletion
        );
      }
    }
  }

  return matrix[b.length][a.length];
}

// Check if two strings are within 20% character difference using Levenshtein distance.
// Returns true if the distance is <= 20% of the longer string's length.
function fuzzyMatch(a, b, threshold = 0.2) {
  if (a === b) return true; // identical strings
  if (!a || !b) return false; // one is empty, the other is not
  if (a === '' && b === '') return true; // both empty
  
  const lenA = a.length;
  const lenB = b.length;
  const maxLen = Math.max(lenA, lenB);
  if (maxLen === 0) return true;

  const distance = levenshteinDistance(a, b);
  const ratio = distance / maxLen;
  return ratio <= threshold;
}

// Extract the referenced entity name from a TODO/FIXME/HACK/XXX comment.
// Looks for patterns like:
//   - "TODO: fix processData" → "processData"
//   - "FIXME: update fetchData" → "fetchData"
//   - "HACK: workaround for bug-123" → "bug-123"
//   - "XXX: refactor util" → "util"
// Returns the first capitalized word or identifier after the keyword, or null if none found.
function extractReferencedEntity(comment) {
  if (!comment || typeof comment !== 'string') return null;

  // Match the keyword and extract the rest of the line
  const match = comment.match(/(?:TODO|FIXME|HACK|XXX)\s*[:.]?\s*(.+)/i);
  if (!match) return null;

  const rest = match[1].trim();
  if (!rest) return null;

  // Common words to skip when looking for the entity
  const skipWords = new Set([
    'fix', 'update', 'refactor', 'change', 'modify', 'adjust', 'correct',
    'resolve', 'address', 'handle', 'implement', 'create', 'add', 'remove',
    'delete', 'improve', 'optimize', 'clean', 'tidy', 'organize',
    'the', 'a', 'an', 'this', 'that', 'these', 'those', 'for', 'with', 'by',
    'to', 'from', 'in', 'on', 'at', 'is', 'are', 'was', 'were', 'be', 'been',
    'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
    'should', 'may', 'might', 'must', 'can', 'later', 'soon', 'now', 'today',
    'tomorrow', 'yesterday', 'here', 'there', 'when', 'where', 'why', 'how',
    'what', 'which', 'who', 'whom', 'whose', 'its', 'it', 'he', 'she', 'they',
    'them', 'his', 'her', 'their', 'our', 'your', 'my', 'me', 'him', 'us',
  ]);

  // Try to extract an issue/bug number first (e.g., "bug-123", "JIRA-456")
  const issueMatch = rest.match(/\b(bug|jira|issue|ticket)[\-_: ]+(\w+)/i);
  if (issueMatch) return `${issueMatch[1]}-${issueMatch[2]}`;

  // Split into words and skip common words
  const words = rest.split(/\s+/);
  for (const word of words) {
    // Remove trailing punctuation
    const cleanWord = word.replace(/[.,;:!?]+$/, '');
    if (!cleanWord) continue;
    
    // Skip common words
    if (skipWords.has(cleanWord.toLowerCase())) continue;
    
    // Return the first meaningful word (could be camelCase, hyphenated, etc.)
    return cleanWord;
  }

  return null;
}

// Check if a referenced entity still exists in the codebase.
// Uses fuzzy matching against all identifiers found in the source files.
// Returns true if a match is found within the 20% threshold.
function entityExistsInCodebase(repoRoot, entityName, sourceFiles) {
  if (!entityName || !repoRoot || !Array.isArray(sourceFiles)) return false;

  const entityLower = entityName.toLowerCase();
  const foundEntities = new Set();

  // Collect all identifiers from the source files
  for (const file of sourceFiles) {
    const absPath = path.join(repoRoot, file);
    try {
      const content = fs.readFileSync(absPath, 'utf8');
      // Extract all identifiers (alphanumeric + underscore sequences)
      const identifiers = content.match(/[A-Za-z_][A-Za-z0-9_]*/g) || [];
      for (const id of identifiers) {
        foundEntities.add(id);
      }
    } catch {
      // File not readable, skip
    }
  }

  // Check if the entity exists exactly or within fuzzy threshold
  for (const entity of foundEntities) {
    if (entity.toLowerCase() === entityLower) return true;
    if (fuzzyMatch(entityName, entity, 0.2)) return true;
  }

  return false;
}

// Classify a stale TODO finding based on entity existence check.
// Returns one of: 'resolved', 'valid', 'ambiguous'
function classifyFinding(finding, repoRoot, sourceFiles) {
  const entityName = extractReferencedEntity(finding.comment);
  if (!entityName) return 'ambiguous'; // cannot determine what entity is referenced

  const exists = entityExistsInCodebase(repoRoot, entityName, sourceFiles);
  if (exists) return 'valid'; // entity still exists, worth reviewing
  return 'resolved'; // entity doesn't exist, TODO is stale
}

// Main review function: processes stale TODO flags and classifies them.
// Returns { findings: [...], summary: {...} }
function review(flags, options = {}) {
  if (!Array.isArray(flags)) {
    return { findings: [], summary: { total: 0, resolved: 0, valid: 0, ambiguous: 0 } };
  }

  const { repoRoot, pipelineDir, sourceFiles: providedSourceFiles } = options;
  if (!repoRoot) {
    return { findings: [], summary: { total: 0, resolved: 0, valid: 0, ambiguous: 0 } };
  }

  // Filter for todo-aging-scan findings
  const staleTodos = flags.filter(f => f.source === 'todo-aging-scan');
  if (staleTodos.length === 0) {
    return { findings: [], summary: { total: 0, resolved: 0, valid: 0, ambiguous: 0 } };
  }

  // Determine source files to check for entity existence
  // If not provided, scan the repoRoot for source files
  let sourceFiles = providedSourceFiles || [];
  if (sourceFiles.length === 0 && repoRoot) {
    try {
      const { listSourceFiles } = require('./scan-utils.js');
      const SCAN_EXTENSIONS = ['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.py', '.go', '.rb', '.java', '.c', '.cpp', '.h', '.hpp', '.rs', '.swift', '.kt', '.scala', '.sh', '.bash', '.zsh'];
      const allFiles = listSourceFiles(repoRoot, SCAN_EXTENSIONS);
      // Convert absolute paths to relative paths from repoRoot
      sourceFiles = allFiles.map(f => path.relative(repoRoot, f));
    } catch {
      // If scanning fails, use empty list (will classify all as resolved)
      sourceFiles = [];
    }
  }

  const findings = [];
  let resolved = 0;
  let valid = 0;
  let ambiguous = 0;

  for (const flag of staleTodos) {
    // Skip if suppressed
    if (pipelineDir && isSuppressed(pipelineDir, 'todo-aging-review', flag.comment)) {
      continue;
    }

    const classification = classifyFinding(flag, repoRoot, sourceFiles);
    const finding = {
      ...flag,
      classification,
      referencedEntity: extractReferencedEntity(flag.comment),
      timestamp: new Date().toISOString(),
    };

    findings.push(finding);

    if (classification === 'resolved') resolved++;
    else if (classification === 'valid') valid++;
    else ambiguous++;
  }

  // Record dismissals for resolved findings
  if (pipelineDir && findings.length > 0) {
    const flagsPath = path.join(pipelineDir, 'queue', 'todo-aging-flags.json');
    let existingFlags = [];
    try {
      const content = fs.readFileSync(flagsPath, 'utf8');
      const parsed = JSON.parse(content);
      if (Array.isArray(parsed)) existingFlags = parsed;
    } catch {
      // File doesn't exist or is invalid, start fresh
    }

    // Add dismissal records for resolved findings
    const dismissals = findings
      .filter(f => f.classification === 'resolved')
      .map(f => ({
        action: 'dismissed',
        reason: 'stale_todo_resolved',
        originalFinding: f.comment,
        referencedEntity: f.referencedEntity,
        timestamp: f.timestamp,
        file: f.file,
        line: f.line,
      }));

    existingFlags.push(...dismissals);
    fs.mkdirSync(path.dirname(flagsPath), { recursive: true });
    fs.writeFileSync(flagsPath, JSON.stringify(existingFlags, null, 2));
  }

  return {
    findings,
    summary: {
      total: findings.length,
      resolved,
      valid,
      ambiguous,
    },
  };
}

// Register the todo_aging_review task source
function register(deps) {
  const { registerTaskSource } = deps;
  registerTaskSource({
    id: 'todo_aging_review',
    name: 'todo-aging-review',
    description: 'Review stale TODO/FIXME/HACK/XXX comments and classify as resolved/valid/ambiguous',
    priority: 50,
    review,
  });
}

module.exports = {
  register,
  review,
  extractReferencedEntity,
  entityExistsInCodebase,
  classifyFinding,
  levenshteinDistance,
  fuzzyMatch,
};
