'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

const {
  extractReferencedEntity,
  entityExistsInCodebase,
  classifyFinding,
  review,
  fuzzyMatch,
  levenshteinDistance,
} = require('./todo-aging-review.js');

describe('todo-aging-review', () => {
  describe('extractReferencedEntity', () => {
    it('extracts entity from TODO comment with function name', () => {
      const result = extractReferencedEntity('TODO: fix processData function');
      assert.strictEqual(result, 'processData');
    });

    it('extracts entity from FIXME comment', () => {
      const result = extractReferencedEntity('FIXME: update fetchData API call');
      assert.strictEqual(result, 'fetchData');
    });

    it('extracts entity from HACK comment', () => {
      const result = extractReferencedEntity('HACK: workaround for bug-123 issue');
      assert.strictEqual(result, 'bug-123');
    });

    it('extracts entity from XXX comment', () => {
      const result = extractReferencedEntity('XXX: refactor util module');
      assert.strictEqual(result, 'util');
    });

    it('returns null for comment without keyword', () => {
      const result = extractReferencedEntity('Just a regular comment');
      assert.strictEqual(result, null);
    });

    it('returns null for empty comment', () => {
      const result = extractReferencedEntity('');
      assert.strictEqual(result, null);
    });

    it('returns null for non-string input', () => {
      const result = extractReferencedEntity(123);
      assert.strictEqual(result, null);
    });

    it('handles TODO with no text after keyword', () => {
      const result = extractReferencedEntity('TODO:');
      assert.strictEqual(result, null);
    });

    it('extracts first capitalized word from mixed text', () => {
      const result = extractReferencedEntity('TODO: fix the processData and validateInput functions');
      assert.strictEqual(result, 'processData');
    });
  });

  describe('fuzzyMatch', () => {
    it('matches identical strings', () => {
      assert.strictEqual(fuzzyMatch('processData', 'processData'), true);
    });

    it('matches strings within 20% threshold', () => {
      // processData vs processDataV2 (2 chars different out of 14)
      assert.strictEqual(fuzzyMatch('processData', 'processDataV2'), true);
    });

    it('rejects strings beyond 20% threshold', () => {
      // util vs utilities (7 chars different out of 9)
      assert.strictEqual(fuzzyMatch('util', 'utilities'), false);
    });

    it('rejects completely different strings', () => {
      assert.strictEqual(fuzzyMatch('abc', 'xyz'), false);
    });

    it('handles empty strings', () => {
      assert.strictEqual(fuzzyMatch('', ''), true);
      assert.strictEqual(fuzzyMatch('abc', ''), false);
    });

    it('is case-sensitive', () => {
      // processData vs ProcessData (1 char different out of 13)
      assert.strictEqual(fuzzyMatch('processData', 'ProcessData'), true);
    });
  });

  describe('levenshteinDistance', () => {
    it('returns 0 for identical strings', () => {
      assert.strictEqual(levenshteinDistance('hello', 'hello'), 0);
    });

    it('returns length of other string when one is empty', () => {
      assert.strictEqual(levenshteinDistance('', 'hello'), 5);
      assert.strictEqual(levenshteinDistance('hello', ''), 5);
    });

    it('calculates distance correctly', () => {
      // kitten → sitting (3 edits: k→s, e→i, +g)
      assert.strictEqual(levenshteinDistance('kitten', 'sitting'), 3);
    });
  });

  describe('entityExistsInCodebase', () => {
    it('returns true when entity exists exactly', () => {
      const repoRoot = '/tmp/test-repo';
      const sourceFiles = ['test.js'];
      // Create a temp file with the entity
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-'));
      fs.writeFileSync(path.join(tmpDir, 'test.js'), 'const processData = () => {};');
      
      const result = entityExistsInCodebase(tmpDir, 'processData', sourceFiles);
      assert.strictEqual(result, true);
      
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('returns true when entity exists with fuzzy match', () => {
      const repoRoot = '/tmp/test-repo';
      const sourceFiles = ['test.js'];
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-'));
      fs.writeFileSync(path.join(tmpDir, 'test.js'), 'const processDataV2 = () => {};');
      
      const result = entityExistsInCodebase(tmpDir, 'processData', sourceFiles);
      assert.strictEqual(result, true);
      
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('returns false when entity does not exist', () => {
      const repoRoot = '/tmp/test-repo';
      const sourceFiles = ['test.js'];
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-'));
      fs.writeFileSync(path.join(tmpDir, 'test.js'), 'const otherFunc = () => {};');
      
      const result = entityExistsInCodebase(tmpDir, 'processData', sourceFiles);
      assert.strictEqual(result, false);
      
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('returns false for empty entity name', () => {
      const result = entityExistsInCodebase('/tmp', '', ['test.js']);
      assert.strictEqual(result, false);
    });

    it('returns false for invalid inputs', () => {
      const result = entityExistsInCodebase(null, 'test', ['test.js']);
      assert.strictEqual(result, false);
    });
  });

  describe('classifyFinding', () => {
    it('classifies as valid when entity exists', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-'));
      fs.writeFileSync(path.join(tmpDir, 'test.js'), 'const processData = () => {};');
      
      const finding = { comment: 'TODO: fix processData', file: 'test.js', line: 1 };
      const result = classifyFinding(finding, tmpDir, ['test.js']);
      assert.strictEqual(result, 'valid');
      
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('classifies as resolved when entity does not exist', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-'));
      fs.writeFileSync(path.join(tmpDir, 'test.js'), 'const otherFunc = () => {};');
      
      const finding = { comment: 'TODO: fix processData', file: 'test.js', line: 1 };
      const result = classifyFinding(finding, tmpDir, ['test.js']);
      assert.strictEqual(result, 'resolved');
      
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('classifies as ambiguous when no entity can be extracted', () => {
      const finding = { comment: 'TODO: fix this later', file: 'test.js', line: 1 };
      const result = classifyFinding(finding, '/tmp', []);
      assert.strictEqual(result, 'ambiguous');
    });
  });

  describe('review', () => {
    it('handles empty flags array', () => {
      const result = review([]);
      assert.deepStrictEqual(result.findings, []);
      assert.strictEqual(result.summary.total, 0);
    });

    it('handles invalid flags input', () => {
      const result = review('not an array');
      assert.deepStrictEqual(result.findings, []);
      assert.strictEqual(result.summary.total, 0);
    });

    it('filters for todo-aging-scan source only', () => {
      const flags = [
        { source: 'todo-aging-scan', comment: 'TODO: fix processData', file: 'test.js', line: 1 },
        { source: 'other-source', comment: 'TODO: fix otherFunc', file: 'test.js', line: 2 },
      ];
      
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-'));
      fs.writeFileSync(path.join(tmpDir, 'test.js'), 'const processData = () => {};');
      
      const result = review(flags, { repoRoot: tmpDir });
      assert.strictEqual(result.findings.length, 1);
      assert.strictEqual(result.findings[0].comment, 'TODO: fix processData');
      
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('classifies findings correctly', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-'));
      fs.writeFileSync(path.join(tmpDir, 'test.js'), 'const processData = () => {};');
      
      const flags = [
        { source: 'todo-aging-scan', comment: 'TODO: fix processData', file: 'test.js', line: 1 },
        { source: 'todo-aging-scan', comment: 'TODO: fix nonexistentFunc', file: 'test.js', line: 2 },
      ];
      
      const result = review(flags, { repoRoot: tmpDir });
      assert.strictEqual(result.summary.valid, 1);
      assert.strictEqual(result.summary.resolved, 1);
      
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('extracts referenced entity for each finding', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-'));
      fs.writeFileSync(path.join(tmpDir, 'test.js'), 'const processData = () => {};');
      
      const flags = [
        { source: 'todo-aging-scan', comment: 'TODO: fix processData', file: 'test.js', line: 1 },
      ];
      
      const result = review(flags, { repoRoot: tmpDir });
      assert.strictEqual(result.findings[0].referencedEntity, 'processData');
      
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('records dismissals for resolved findings', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-'));
      const pipelineDir = path.join(tmpDir, 'pipeline');
      fs.mkdirSync(pipelineDir, { recursive: true });
      fs.writeFileSync(path.join(tmpDir, 'test.js'), 'const otherFunc = () => {};');
      
      const flags = [
        { source: 'todo-aging-scan', comment: 'TODO: fix processData', file: 'test.js', line: 1 },
      ];
      
      const result = review(flags, { repoRoot: tmpDir, pipelineDir });
      assert.strictEqual(result.summary.resolved, 1);
      
      // Check that dismissal was recorded
      const flagsPath = path.join(pipelineDir, 'queue', 'todo-aging-flags.json');
      assert.strictEqual(fs.existsSync(flagsPath), true);
      const recorded = JSON.parse(fs.readFileSync(flagsPath, 'utf8'));
      assert.strictEqual(recorded.length, 1);
      assert.strictEqual(recorded[0].action, 'dismissed');
      assert.strictEqual(recorded[0].reason, 'stale_todo_resolved');
      
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });
  });

  describe('register', () => {
    it('registers task source with correct metadata', () => {
      const registered = [];
      const deps = {
        registerTaskSource: (source) => registered.push(source),
      };
      
      const { register } = require('./todo-aging-review.js');
      register(deps);
      
      assert.strictEqual(registered.length, 1);
      assert.strictEqual(registered[0].id, 'todo_aging_review');
      assert.strictEqual(registered[0].name, 'todo-aging-review');
      assert.ok(typeof registered[0].review === 'function');
    });
  });
});
