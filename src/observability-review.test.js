'use strict';

// Unit tests for nextObservabilityReviewTask, moved from agent-manager's
// src/maintenance/observability-review.test.js (2026-08-27) when the observability /
// performance / function-length REVIEW modules were extracted into this out-of-tree
// plugin. The fixtures and assertions are unchanged; only the harness moved -- setup now
// registers the sources through this module's own register() with the injected-deps bag
// (getConfig / nextCandidateFulfillmentTask / taskIdExistsInQueue / taskPriority pulled
// from the agent-manager package) instead of relying on a require('../task-sources.js')
// side effect.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Fresh registry + fresh module cache, then register this plugin's sources via register().
// Returns the injected deps plus the direct nextObservabilityReviewTask entry point and a
// couple of registry helpers the round-trip tests below use.
function freshPlugin(repoRoot) {
  process.env.AGENT_MANAGER_REPO_ROOT = repoRoot;
  process.env.AGENT_MANAGER_PIPELINE_DIR = repoRoot;
  const registry = require('agent-manager/src/task-source-registry.js');
  registry.clearRegistry();
  const { clearModelProfileRegistry } = require('agent-manager/src/model-profile-registry.js');
  clearModelProfileRegistry();
  delete require.cache[require.resolve('agent-manager/src/task-sources.js')];
  delete require.cache[require.resolve('./observability-review.js')];
  const { getConfig } = require('agent-manager/src/config.js');
  const { nextCandidateFulfillmentTask, taskIdExistsInQueue, taskPriority } = require('agent-manager/src/task-sources.js');
  const deps = { getConfig, nextCandidateFulfillmentTask, taskIdExistsInQueue, taskPriority };
  const mod = require('./observability-review.js');
  mod.register(deps);
  return { ...deps, nextObservabilityReviewTask: mod.nextObservabilityReviewTask, getRegisteredSource: registry.getRegisteredSource };
}

// Back-compat alias: the direct-call tests below were written against a freshDeps() that
// returned { taskIdExistsInQueue, nextObservabilityReviewTask }. freshPlugin() is a
// superset, so keep the old name pointing at it.
const freshDeps = freshPlugin;

function makeObservabilityFixtureRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'observability-review-test-'));
  return dir;
}

function writeObservabilityFinding(dir, relPath = 'worker.js', content = 'try {\n  risky();\n} catch {}\n') {
  const filePath = path.join(dir, relPath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
  return filePath;
}

function callNext(dir, deps) {
  const coveragePath = path.join(dir, 'observability-coverage.json');
  return {
    coveragePath,
    result: deps.nextObservabilityReviewTask({ repoRoot: dir, pipelineDir: dir, defaultDomain: 'default', taskIdExistsInQueue: deps.taskIdExistsInQueue, coveragePath }),
  };
}

test('nextObservabilityReviewTask returns null (and still records lastScannedAt) when the project has no findings', () => {
  const dir = makeObservabilityFixtureRepo();
  const deps = freshDeps(dir);
  const { coveragePath, result } = callNext(dir, deps);
  assert.equal(result, null);
  const coverage = JSON.parse(fs.readFileSync(coveragePath, 'utf8'));
  assert.ok(coverage.lastScannedAt);
});

test('nextObservabilityReviewTask scans the active project and returns a triage task for the first finding', () => {
  const dir = makeObservabilityFixtureRepo();
  writeObservabilityFinding(dir);
  const deps = freshDeps(dir);
  const projectTag = path.basename(dir);

  const { coveragePath, result: task } = callNext(dir, deps);
  assert.ok(task);
  assert.equal(task.source, 'observability_review');
  assert.equal(task.promptContext.rule, 'silent-catch-block');
  assert.equal(task.promptContext.projectSlug, projectTag);
  assert.equal(task.promptContext.file, 'worker.js');
  assert.match(task.promptContext.snippet, /risky\(\)/);

  const coverage = JSON.parse(fs.readFileSync(coveragePath, 'utf8'));
  assert.ok(coverage.lastScannedAt);

  const flags = JSON.parse(fs.readFileSync(path.join(dir, 'queue', 'observability-flags.json'), 'utf8'));
  assert.equal(flags.length, 1);
});

test('nextObservabilityReviewTask does not regenerate a duplicate once the original task has been archived', () => {
  const dir = makeObservabilityFixtureRepo();
  writeObservabilityFinding(dir);
  const deps = freshDeps(dir);

  const { result: first } = callNext(dir, deps);
  assert.ok(first, 'first call produces the real task');

  const archivedDir = path.join(dir, 'queue', 'done', '_archived_no_action');
  fs.mkdirSync(archivedDir, { recursive: true });
  fs.writeFileSync(path.join(archivedDir, `${first.id}.json`), JSON.stringify(first));

  const { result: second } = callNext(dir, deps);
  assert.equal(second, null, 'the archived task\'s id must still be seen as already-queued, not regenerated as a duplicate');
});

test('nextObservabilityReviewTask does not regenerate a duplicate for a task sitting in needs-clarification/ or awaiting-confirm/', () => {
  for (const state of ['needs-clarification', 'awaiting-confirm']) {
    const dir = makeObservabilityFixtureRepo();
    writeObservabilityFinding(dir);
    const deps = freshDeps(dir);
    const { result: first } = callNext(dir, deps);
    assert.ok(first, `first call produces the real task (state under test: ${state})`);

    const stateDir = path.join(dir, 'queue', state);
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, `${first.id}.json`), JSON.stringify(first));

    const { result: second } = callNext(dir, deps);
    assert.equal(second, null, `a task sitting in ${state}/ must not be duplicated`);
  }
});

test('nextObservabilityReviewTask does not rescan within the rescan interval', () => {
  const dir = makeObservabilityFixtureRepo();
  writeObservabilityFinding(dir);
  const deps = freshDeps(dir);

  const { coveragePath, result: first } = callNext(dir, deps);
  const flagsPath = path.join(dir, 'queue', 'observability-flags.json');
  const flagsAfterFirst = JSON.parse(fs.readFileSync(flagsPath, 'utf8'));

  const pendingDir = path.join(dir, 'queue', 'pending');
  fs.mkdirSync(pendingDir, { recursive: true });
  fs.writeFileSync(path.join(pendingDir, `${first.id}.json`), '{}');

  writeObservabilityFinding(dir, 'other.js', 'try {\n  risky2();\n} catch {}\n');

  const { result: second } = callNext(dir, deps);
  assert.equal(second, null);
  const flagsAfterSecond = JSON.parse(fs.readFileSync(flagsPath, 'utf8'));
  assert.equal(flagsAfterSecond.length, flagsAfterFirst.length); // no rescan happened
  void coveragePath;
});

test('nextObservabilityReviewTask rescans once the interval elapses, dedupes against already-flagged findings, and prunes flags for deleted files', () => {
  const dir = makeObservabilityFixtureRepo();
  const staleFilePath = writeObservabilityFinding(dir, 'stale.js');
  const deps = freshDeps(dir);
  const projectTag = path.basename(dir);
  const coveragePath = path.join(dir, 'observability-coverage.json');

  fs.writeFileSync(coveragePath, JSON.stringify({ lastScannedAt: new Date(0).toISOString() }));
  fs.mkdirSync(path.join(dir, 'queue'), { recursive: true });
  const flagsPath = path.join(dir, 'queue', 'observability-flags.json');
  fs.writeFileSync(flagsPath, JSON.stringify([
    { rule: 'silent-catch-block', file: 'stale.js', line: 3, detail: 'already known', projectSlug: projectTag, scannedAt: new Date(0).toISOString() },
    { rule: 'silent-catch-block', file: 'deleted.js', line: 5, detail: 'file about to be removed', projectSlug: projectTag, scannedAt: new Date(0).toISOString() },
  ]));
  fs.unlinkSync(staleFilePath);
  writeObservabilityFinding(dir, 'stale.js');
  writeObservabilityFinding(dir, 'fresh.js', 'try {\n  riskyFresh();\n} catch {}\n');

  deps.nextObservabilityReviewTask({ repoRoot: dir, pipelineDir: dir, defaultDomain: 'default', taskIdExistsInQueue: deps.taskIdExistsInQueue, coveragePath });
  const flags = JSON.parse(fs.readFileSync(flagsPath, 'utf8'));
  const keys = flags.map((f) => `${f.file}:${f.line}`).sort();
  assert.deepEqual(keys, ['fresh.js:3', 'stale.js:3']); // deleted.js pruned, stale.js not duplicated, fresh.js added
});

test('nextObservabilityReviewTask skips a stale flag whose target file is now minified, even when not due for a rescan', () => {
  const dir = makeObservabilityFixtureRepo();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'bundle.js'), 'x'.repeat(3000)); // one line > MINIFIED_LINE_LENGTH_THRESHOLD (2000)
  const projectTag = path.basename(dir);
  const coveragePath = path.join(dir, 'observability-coverage.json');

  fs.writeFileSync(coveragePath, JSON.stringify({ lastScannedAt: new Date().toISOString() })); // fresh -- not due for a rescan
  fs.mkdirSync(path.join(dir, 'queue'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'queue', 'observability-flags.json'), JSON.stringify([
    { rule: 'silent-catch-block', file: 'bundle.js', line: 1, detail: 'stale pre-fix flag', projectSlug: projectTag, scannedAt: new Date(0).toISOString() },
  ]));

  const deps = freshDeps(dir);
  assert.equal(deps.nextObservabilityReviewTask({ repoRoot: dir, pipelineDir: dir, defaultDomain: 'default', taskIdExistsInQueue: deps.taskIdExistsInQueue, coveragePath }), null);
});

test('observability_review genuine verdict -> apply writes a candidate -> observability_fix offers it as a real task', () => {
  const dir = makeObservabilityFixtureRepo();
  const candidatesPath = path.join(dir, 'OBSERVABILITY_FIX_CANDIDATES.md');
  process.env.AGENT_MANAGER_OBSERVABILITY_FIX_CANDIDATES_PATH = candidatesPath;
  const { getRegisteredSource, nextCandidateFulfillmentTask } = freshPlugin(dir);

  const genuineImplementResponse = [
    '### AC-001 · Silent catch swallows fetch errors',
    'Strength: Strong',
    'Files: worker.js',
    '',
    'Problem:',
    'The catch block hides network failures from the user.',
    '',
    'Solution:',
    'Log the error and surface a visible failure state.',
    '',
    'Benefits:',
    'Real errors are debuggable instead of silently vanishing.',
  ].join('\n');

  const observabilityReview = getRegisteredSource('observability_review');
  const applyResult = observabilityReview.apply({ implementResponse: genuineImplementResponse });
  assert.equal(applyResult.skipped, undefined); // NOT the no-op path -- a real candidate was written
  assert.equal(applyResult.candidateCount, 1);
  assert.ok(fs.existsSync(candidatesPath));

  const fixTask = nextCandidateFulfillmentTask(candidatesPath, 'observability_fix');
  assert.ok(fixTask);
  assert.equal(fixTask.source, 'observability_fix');
  assert.match(fixTask.title, /Silent catch swallows fetch errors/);
  assert.deepEqual(fixTask.promptContext.files, ['worker.js']);
});

// 2026-08-27, Grimmethy: "we should be looking for code content instead of the line
// itself." The review task already carries the real code text it judged as
// promptContext.snippet; apply must thread it through to applyArchDiscoveryCandidates so
// it lands in the candidate doc as a deterministic Snippet: field (see apply-group-a.js),
// giving windowFetchedFileContent a real anchor instead of the model's own prose.
test('observability_review apply threads task.promptContext.snippet into the candidate doc as a Snippet: field', () => {
  const dir = makeObservabilityFixtureRepo();
  process.env.AGENT_MANAGER_REPO_ROOT = dir;
  process.env.AGENT_MANAGER_PIPELINE_DIR = dir;
  const candidatesPath = path.join(dir, 'OBSERVABILITY_FIX_CANDIDATES.md');
  process.env.AGENT_MANAGER_OBSERVABILITY_FIX_CANDIDATES_PATH = candidatesPath;
  const { getRegisteredSource } = freshPlugin(dir);

  const genuineImplementResponse = [
    '### AC-001 · Silent catch swallows fetch errors',
    'Strength: Strong',
    'Files: worker.js',
    '',
    'Problem:',
    'The catch block hides network failures -- prose paraphrases it as `catch (err)`.',
    '',
    'Solution:',
    'Log the error.',
    '',
    'Benefits:',
    'Debuggable.',
  ].join('\n');

  const observabilityReview = getRegisteredSource('observability_review');
  observabilityReview.apply({
    implementResponse: genuineImplementResponse,
    task: { promptContext: { snippet: '  } catch {\n    return [];\n  }' } },
  });

  const text = fs.readFileSync(candidatesPath, 'utf8');
  assert.match(text, /Snippet:\n```\n {2}\} catch \{\n {4}return \[\];\n {2}\}\n```/);
});

test('observability_review false-positive verdict -> apply is a clean no-op, no candidate written', () => {
  const dir = makeObservabilityFixtureRepo();
  process.env.AGENT_MANAGER_REPO_ROOT = dir;
  process.env.AGENT_MANAGER_PIPELINE_DIR = dir;
  const candidatesPath = path.join(dir, 'OBSERVABILITY_FIX_CANDIDATES.md');
  process.env.AGENT_MANAGER_OBSERVABILITY_FIX_CANDIDATES_PATH = candidatesPath;
  const { getRegisteredSource } = freshPlugin(dir);

  const observabilityReview = getRegisteredSource('observability_review');
  const applyResult = observabilityReview.apply({ implementResponse: 'False positive: this catch intentionally no-ops for a known-safe case.' });
  assert.equal(applyResult.skipped, true);
  assert.equal(fs.existsSync(candidatesPath), false);
});

// --- 2026-09-01: PROJECT CAPABILITIES grounding (see project-capabilities.js). AC-47
// fabricated a metric emission for a project with no metrics system because no prompt
// told the model what primitives exist. Every review/fix prompt now carries the block.

function obsPrompts(dir) {
  process.env.AGENT_MANAGER_REPO_ROOT = dir;
  process.env.AGENT_MANAGER_PIPELINE_DIR = dir;
  delete require.cache[require.resolve('./observability-review.js')];
  delete require.cache[require.resolve('./project-capabilities.js')];
  return require('./observability-review.js');
}

test('all four observability prompts carry the PROJECT CAPABILITIES block for a no-metrics repo', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'obs-caps-prompt-'));
  fs.writeFileSync(path.join(dir, 'package.json'), '{"dependencies":{"express":"^4"}}');
  const m = obsPrompts(dir);
  const task = { title: 't', promptContext: { rule: 'silent-catch-block', projectSlug: 'p', file: 'src/x.js', line: 5, detail: 'the error is silently discarded with no log/rethrow/metric', snippet: '} catch {}', candidateId: 'AC-9', title: 'x', body: 'Problem: ...\nSolution: add a metric counting the failures.\nBenefits: ...', files: ['src/x.js'], fetchedFiles: [{ path: 'src/x.js', content: 'try { risky(); } catch {}' }] } };

  for (const text of [
    m.observabilityReviewPlanPrompt(task),
    m.observabilityReviewImplementPrompt(task, 'PLAN'),
    m.observabilityFixPlanPrompt(task),
    m.observabilityFixImplementPrompt(task, 'PLAN'),
  ]) {
    assert.match(text, /PROJECT CAPABILITIES/);
    assert.match(text, /no metrics system/);
    assert.match(text, /Do not fabricate the missing primitive|not an instruction to add a metric|only primitives listed above|only primitives this project has/);
  }
});

test('observabilityFixPlanPrompt no longer tells the model to trust the candidate unconditionally', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'obs-caps-vetted-'));
  fs.writeFileSync(path.join(dir, 'package.json'), '{}');
  const m = obsPrompts(dir);
  const text = m.observabilityFixPlanPrompt({ promptContext: { candidateId: 'AC-1', title: 't', body: 'b', files: ['f.js'] } });
  assert.doesNotMatch(text, /do not second-guess/);
  assert.match(text, /written WITHOUT checking this project's actual capabilities/);
});

// --- 2026-09-02: A-D grounding fix. The whole observability_review blocked backlog was
// the model being asked to rule on a catch block it was never shown (stale line -> wrong
// 8-line snippet), answering "I can't verify / a human should look", and review correctly
// rejecting that as hedging.

const PY_SILENT = [
  '# header',
  'import json',
  '',
  'def _parse(text):',           // line 4
  '    if not text:',
  '        return None',
  '    try:',                     // line 7
  '        return json.loads(text)',
  '    except Exception:',        // line 9  <-- the real finding
  '        pass',                 // line 10
  '    return None',
  '',
].join('\n');

test('nextObservabilityReviewTask re-locates a stale-line flag against the current file (not-due window)', () => {
  const dir = makeObservabilityFixtureRepo();
  writeObservabilityFinding(dir, 'app.py', PY_SILENT);
  const deps = freshDeps(dir);

  // first call: scans, writes coverage + a correct flag
  const { result: first } = callNext(dir, deps);
  assert.ok(first);
  assert.equal(first.promptContext.line, 9);

  // simulate a pre-existing flag with a DRIFTED line and no new fields, and no rescan due
  const flagsPath = path.join(dir, 'queue', 'observability-flags.json');
  const staleFlag = { rule: 'silent-catch-block', file: 'app.py', line: 3, projectSlug: path.basename(dir), scannedAt: new Date(Date.now() - 1000).toISOString(), detail: 'except block is empty' };
  fs.writeFileSync(flagsPath, JSON.stringify([staleFlag], null, 2));

  const { result: relocated } = callNext(dir, deps);
  assert.ok(relocated, 'a task is still produced');
  assert.equal(relocated.promptContext.line, 9, 're-located to the real except line');
  assert.equal(relocated.promptContext.blockStartLine, 9);
  assert.equal(relocated.promptContext.blockEndLine, 10);
  assert.match(relocated.promptContext.enclosingCode, /def _parse/); // the enclosing function is in view
  assert.match(relocated.promptContext.enclosingCode, /except Exception:\n\s*pass/);
  assert.match(relocated.promptContext.enclosingCode, /lines \d+-\d+/);
});

test('nextObservabilityReviewTask relocates several drifted flags in ONE big file (per-poll file cache)', () => {
  const dir = makeObservabilityFixtureRepo();
  // three distinct silent excepts in one file
  const py = [
    'def a():',
    '    try:', '        x()', '    except Exception:', '        pass',        // except @ line 4, body "pass"
    '',
    'def b():',
    '    try:', '        y()', '    except ValueError:', '        ...',        // except @ line 10, body "..."
    '',
    'def c():',
    '    try:', '        z()', '    except KeyError:', '        return None if False else None',  // not simple-return literal -> flagged, line 16
    '',
  ].join('\n');
  writeObservabilityFinding(dir, 'big.py', py);
  const deps = freshDeps(dir);
  callNext(dir, deps); // establish coverage + real flags (with bodyFingerprint)

  const flagsPath = path.join(dir, 'queue', 'observability-flags.json');
  const real = JSON.parse(fs.readFileSync(flagsPath, 'utf8'));
  assert.equal(real.length, 3, 'all three excepts flagged');
  // drift every flag's line by +100 but keep its bodyFingerprint -> must relocate by fingerprint
  const drifted = real.map((f) => ({ ...f, line: f.line + 100 }));
  fs.writeFileSync(flagsPath, JSON.stringify(drifted, null, 2));

  const seen = new Set();
  const lines = [];
  for (let i = 0; i < 3; i++) {
    const t = deps.nextObservabilityReviewTask({ repoRoot: dir, pipelineDir: dir, defaultDomain: 'default', taskIdExistsInQueue: (id) => seen.has(id), coveragePath: path.join(dir, 'observability-coverage.json') });
    assert.ok(t, `task ${i} produced`);
    seen.add(t.id);
    lines.push(t.promptContext.line);
    assert.match(t.promptContext.enclosingCode, /lines \d+-\d+/);
  }
  assert.deepEqual(lines.sort((a, b) => a - b), [4, 10, 16], 'each drifted flag relocated to its own real except line');
});

test('nextObservabilityReviewTask drops a flag whose construct is gone, produces no task', () => {
  const dir = makeObservabilityFixtureRepo();
  writeObservabilityFinding(dir, 'app.py', PY_SILENT);
  const deps = freshDeps(dir);
  const { result: first } = callNext(dir, deps);
  assert.ok(first);

  // the silent except is fixed (now logs) -- but no rescan is due, the flag lingers
  fs.writeFileSync(path.join(dir, 'app.py'), PY_SILENT.replace('        pass', '        logger.exception("parse failed")'));
  const flagsPath = path.join(dir, 'queue', 'observability-flags.json');
  const flag = JSON.parse(fs.readFileSync(flagsPath, 'utf8'))[0];
  fs.writeFileSync(flagsPath, JSON.stringify([flag], null, 2)); // keep just the one, still at its old line

  const { result: gone } = callNext(dir, deps);
  assert.equal(gone, null, 'no task built from a construct that no longer matches the rule');
  assert.deepEqual(JSON.parse(fs.readFileSync(flagsPath, 'utf8')), [], 'the dead flag was pruned');
});

test('observabilityReviewPlanPrompt forces a binary verdict and shows the enclosing code', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'obs-binary-'));
  fs.writeFileSync(path.join(dir, 'package.json'), '{}');
  const m = obsPrompts(dir);
  const p = m.observabilityReviewPlanPrompt({ promptContext: {
    rule: 'silent-catch-block', projectSlug: 'p', file: 'app.py', line: 9, detail: 'except block is empty',
    snippet: 'except Exception:\n    pass', enclosingCode: '--- app.py lines 4-12 (the flagged block + surrounding code) ---\ndef _parse(text):\n    ...\n    except Exception:\n        pass',
  } });
  assert.match(p, /GENUINE/);
  assert.match(p, /FALSE POSITIVE/);
  assert.match(p, /Do NOT answer "uncertain"/i);
  assert.doesNotMatch(p, /- "uncertain —/);          // no longer offered as a verdict option
  assert.match(p, /REAL SOURCE/);
  assert.match(p, /def _parse\(text\)/);              // the enclosing code is inlined
});

test('observability_review registers reviewGuidance that permits a decisive false-positive verdict', () => {
  const dir = makeObservabilityFixtureRepo();
  const deps = freshDeps(dir);
  const src = deps.getRegisteredSource('observability_review');
  assert.deepEqual(src.groundingFields, ['snippet', 'enclosingCode']);
  assert.equal(typeof src.reviewGuidance, 'string');
  assert.match(src.reviewGuidance, /REJECT the draft if it answers "uncertain"/);
  assert.match(src.reviewGuidance, /do NOT reject a decisive verdict merely for sounding careful/);
  assert.match(src.reviewCompletenessQuestion, /decisive GENUINE-or-FALSE-POSITIVE verdict/);
});
