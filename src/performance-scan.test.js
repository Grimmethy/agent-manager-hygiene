'use strict';

// Unit tests for performance-scan.js, run against throwaway fixture files in a temp
// dir -- never against this repo's own source, same reasoning observability-scan.test.js
// documents (agent-manager's own code legitimately changes over time and isn't the
// thing under test here).
//
// Run: node --test src/performance-scan.test.js  (or `npm test`)

const test = require('node:test');
const assert = require('node:assert/strict');
const { scanProject, findLoopBodyIssues, findPyLoopBodyIssues, findJsonDeepCloneAntipattern } = require('./performance-scan.js');

test('findLoopBodyIssues flags a synchronous fs call inside a for loop', () => {
  const text = 'function run(files) {\n  for (let i = 0; i < files.length; i++) {\n    const data = fs.readFileSync(files[i]);\n  }\n}\n';
  const findings = findLoopBodyIssues(text, 'a.js');
  const rules = findings.map((f) => f.rule);
  assert.ok(rules.includes('sync-io-in-loop'));
});

test('findLoopBodyIssues flags an await inside a while loop', () => {
  const text = 'async function run(ids) {\n  while (ids.length) {\n    const id = ids.pop();\n    await fetchOne(id);\n  }\n}\n';
  const findings = findLoopBodyIssues(text, 'a.js');
  const rules = findings.map((f) => f.rule);
  assert.ok(rules.includes('sequential-await-in-loop'));
});

test('findLoopBodyIssues does not flag a loop with no sync I/O or await', () => {
  const text = 'function run(items) {\n  for (let i = 0; i < items.length; i++) {\n    total += items[i].value;\n  }\n}\n';
  assert.deepEqual(findLoopBodyIssues(text, 'a.js'), []);
});

test('findLoopBodyIssues reports the loop-start line, not the offending call\'s own line', () => {
  const text = 'for (const f of files) {\n  const x = 1;\n  fs.existsSync(f);\n}\n';
  const findings = findLoopBodyIssues(text, 'a.js');
  assert.equal(findings.find((f) => f.rule === 'sync-io-in-loop').line, 1);
});

test('findJsonDeepCloneAntipattern flags JSON.parse(JSON.stringify(...))', () => {
  const text = 'const copy = JSON.parse(JSON.stringify(original));\n';
  const findings = findJsonDeepCloneAntipattern(text, 'a.js');
  assert.equal(findings.length, 1);
  assert.equal(findings[0].rule, 'json-deep-clone-antipattern');
});

test('findJsonDeepCloneAntipattern does not flag an unrelated JSON.parse call', () => {
  const text = 'const parsed = JSON.parse(rawString);\n';
  assert.deepEqual(findJsonDeepCloneAntipattern(text, 'a.js'), []);
});

test('scanProject combines loop and clone findings across scanned files', () => {
  const os = require('os');
  const path = require('path');
  const fs = require('fs');
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'performance-scan-test-'));
  fs.writeFileSync(
    path.join(repoRoot, 'worker.js'),
    'for (const f of files) {\n  fs.readFileSync(f);\n}\nconst copy = JSON.parse(JSON.stringify(state));\n',
  );

  const findings = scanProject(repoRoot, 'test-project');
  const rules = findings.map((f) => f.rule);
  assert.ok(rules.includes('sync-io-in-loop'));
  assert.ok(rules.includes('json-deep-clone-antipattern'));
  for (const f of findings) {
    assert.equal(f.projectSlug, 'test-project');
    assert.equal(typeof f.scannedAt, 'string');
  }
});

// --- Python -------------------------------------------------------------------------

test('findPyLoopBodyIssues flags a blocking subprocess call inside a for loop', () => {
  const text = 'def run(items):\n    for it in items:\n        subprocess.run(["do", it])\n';
  const findings = findLoopBodyIssues(text, 'a.py'); // dispatches on the .py extension
  assert.deepEqual(findings.map((f) => f.rule), ['blocking-call-in-loop']);
  assert.equal(findings[0].line, 2); // the `for` line, not the call's line
});

test('findPyLoopBodyIssues flags a sequential await inside an async for/while loop', () => {
  const text = 'async def run(items):\n    for it in items:\n        await fetch(it)\n';
  const findings = findPyLoopBodyIssues(text, 'a.py');
  assert.deepEqual(findings.map((f) => f.rule), ['sequential-await-in-loop']);
});

test('findPyLoopBodyIssues does not flag a Python loop with no blocking call or await', () => {
  const text = 'for x in data:\n    total += x * 2\n';
  assert.deepEqual(findPyLoopBodyIssues(text, 'a.py'), []);
});

test('findJsonDeepCloneAntipattern flags json.loads(json.dumps(...)) in a .py file', () => {
  const text = 'snapshot = json.loads(json.dumps(state))\n';
  const findings = findJsonDeepCloneAntipattern(text, 'a.py');
  assert.equal(findings.length, 1);
  assert.equal(findings[0].rule, 'json-deep-clone-antipattern');
  assert.match(findings[0].detail, /copy\.deepcopy/);
});

test('scanProject picks up Python findings alongside JS ones and skips a clean .py file', () => {
  const os = require('os');
  const path = require('path');
  const fs = require('fs');
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'performance-scan-py-test-'));
  fs.writeFileSync(path.join(repoRoot, 'svc.py'), 'for job in jobs:\n    requests.get(job.url)\n    copy = json.loads(json.dumps(job.spec))\n');
  fs.writeFileSync(path.join(repoRoot, 'clean.py'), 'for x in xs:\n    acc.append(x + 1)\n');

  const findings = scanProject(repoRoot, 'py-project');
  const byFile = findings.reduce((m, f) => ((m[f.file] = (m[f.file] || []).concat(f.rule)), m), {});
  assert.ok(byFile['svc.py'].includes('blocking-call-in-loop'));
  assert.ok(byFile['svc.py'].includes('json-deep-clone-antipattern'));
  assert.equal(byFile['clean.py'], undefined);
  for (const f of findings) assert.equal(f.projectSlug, 'py-project');
});

// --- Regression: the 13 no-op hygiene tasks (2026-08-30) --------------------------------
// Every one of the 13 done tasks on agent-manager-hygiene was a scanner false positive in
// one of two shapes. These fixtures are lifted verbatim from those task snippets; each
// must now produce ZERO findings so the review pipeline never has to run them again.

// Class A -- "code as data": the loop exists ONLY as a string-literal argument (a test
// fixture seeding a known-bad snippet for the pipeline to detect). stripNonCode() blanks
// string interiors before matching, so this is not a loop at all as far as the rule is
// concerned. Uses a NON-test relPath to prove the string-literal handling stands alone.
test('class A: a for/await loop that is only string-literal fixture data is not flagged (stripNonCode)', () => {
  const cases = [
    `const dir = t();\nfs.writeFileSync(path.join(dir, 'worker.js'), 'for (const x of xs) {\\n  await fetch(x);\\n}\\n');\nconst v = check(dir);\n`,
    `writePerformanceFinding(dir, 'other.js', 'for (const item of items2) {\\n  await fetch(item.url);\\n}\\n');\nconst { result } = callNext(dir, deps);\n`,
    `performanceReview.apply({\n  implementResponse: r,\n  task: { promptContext: { snippet: '  for (const item of items) {\\n    await fetch(item.url);\\n  }' } },\n});\n`,
  ];
  for (const text of cases) {
    assert.deepEqual(findLoopBodyIssues(text, 'src/real-module.js'), [], text.slice(0, 50));
  }
});

test('class A: an await/io token inside a string INSIDE a real loop body is not flagged', () => {
  const text = 'for (const f of files) {\n  log("run: await fetch happens elsewhere");\n  const n = f.length;\n}\n';
  assert.deepEqual(findLoopBodyIssues(text, 'src/real-module.js'), []);
});

// Class B -- a bounded fixture loop in a test file. sync-io-in-loop / sequential-await
// are hot-path rules; a two-element fixture-setup loop that runs once per suite has no
// per-request cost. isTestFile() short-circuits the loop rules for these paths.
test('class B: a real sync-IO loop in a *.test.js / __tests__ / fixtures path is not flagged', () => {
  const text = "for (const state of ['needs-clarification', 'awaiting-confirm']) {\n  fs.writeFileSync(path.join(dir, state), '{}');\n}\n";
  assert.deepEqual(findLoopBodyIssues(text, 'src/observability-review.test.js'), []);
  assert.deepEqual(findLoopBodyIssues(text, 'src/__tests__/helpers.js'), []);
  assert.deepEqual(findLoopBodyIssues(text, 'test/fixtures/seed.js'), []);
  assert.deepEqual(findPyLoopBodyIssues('for x in ("a", "b"):\n    subprocess.run(x)\n', 'tests/test_seed.py'), []);
});

// Positive control: the identical construct in real production source still fires -- the
// fixes narrow precision, they do not disable the rules.
test('positive control: a real sync-IO / sequential-await loop in production source is STILL flagged', () => {
  const text = 'async function run(urls) {\n  for (const u of urls) {\n    await fetch(u);\n    fs.writeFileSync("/tmp/x", u);\n  }\n}\n';
  const rules = findLoopBodyIssues(text, 'src/worker.js').map((f) => f.rule).sort();
  assert.deepEqual(rules, ['sequential-await-in-loop', 'sync-io-in-loop']);
});

test('class A: JSON.parse(JSON.stringify(...)) that is only string-literal fixture data is not flagged', () => {
  const text = "const seed = 'const copy = JSON.parse(JSON.stringify(original));\\n';\nwrite(seed);\n";
  assert.deepEqual(findJsonDeepCloneAntipattern(text, 'src/real-module.js'), []);
});

test('positive control: a real JSON.parse(JSON.stringify(...)) deep clone is STILL flagged', () => {
  const text = 'function clone(x) {\n  return JSON.parse(JSON.stringify(x));\n}\n';
  const f = findJsonDeepCloneAntipattern(text, 'src/util.js');
  assert.equal(f.length, 1);
  assert.equal(f[0].line, 2);
});
