'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { runGroundingCheck } = require('./arch-discovery-grounding-check.js');

function withTmpRepo(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adgc-'));
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src', 'real.js'), '// real\n');
  const saved = { root: process.env.AGENT_MANAGER_REPO_ROOT, dirs: process.env.AGENT_MANAGER_GREP_DIRS };
  process.env.AGENT_MANAGER_REPO_ROOT = dir;
  process.env.AGENT_MANAGER_GREP_DIRS = 'src';
  return Promise.resolve(fn(dir)).finally(() => {
    if (saved.root === undefined) delete process.env.AGENT_MANAGER_REPO_ROOT; else process.env.AGENT_MANAGER_REPO_ROOT = saved.root;
    if (saved.dirs === undefined) delete process.env.AGENT_MANAGER_GREP_DIRS; else process.env.AGENT_MANAGER_GREP_DIRS = saved.dirs;
    fs.rmSync(dir, { recursive: true, force: true });
  });
}

const wu = (filesLine) => [`### AC-007 · x`, `Strength: Strong`, `Files: ${filesLine}`, ``, `Problem: ...`].join('\n');

test('flags a Files: line path that resolves nowhere', async () => {
  await withTmpRepo(async () => {
    const r = await runGroundingCheck({ source: 'arch_discovery' }, wu('src/real.js, src/invented.js'));
    assert.equal(r.verdict, 'ungrounded');
    assert.match(r.reason, /^fabricated file path\(s\): src\/invented\.js\b/);
  });
});

test('passes an all-real Files: line', async () => {
  await withTmpRepo(async () => {
    const r = await runGroundingCheck({ source: 'arch_discovery' }, wu('src/real.js'));
    assert.deepEqual(r, { verdict: 'ok' });
  });
});

test('an empty ("no friction found") draft is ok', async () => {
  await withTmpRepo(async () => {
    assert.deepEqual(await runGroundingCheck({ source: 'arch_discovery' }, ''), { verdict: 'ok' });
  });
});

test('a write-up with no Files: line is ok (nothing to check)', async () => {
  await withTmpRepo(async () => {
    const r = await runGroundingCheck({ source: 'arch_discovery' }, 'Just prose about src/whatever.js hypothetically.');
    assert.deepEqual(r, { verdict: 'ok' });
  });
});

test('no-op when AGENT_MANAGER_ARCH_DISCOVERY_GROUNDING_CHECK=false', async () => {
  await withTmpRepo(async () => {
    process.env.AGENT_MANAGER_ARCH_DISCOVERY_GROUNDING_CHECK = 'false';
    try {
      const r = await runGroundingCheck({ source: 'arch_discovery' }, wu('src/invented.js'));
      assert.deepEqual(r, { verdict: 'ok' });
    } finally {
      delete process.env.AGENT_MANAGER_ARCH_DISCOVERY_GROUNDING_CHECK;
    }
  });
});

test('advisory: an unresolvable repo root is skipped, not thrown', async () => {
  const saved = process.env.AGENT_MANAGER_REPO_ROOT;
  delete process.env.AGENT_MANAGER_REPO_ROOT;
  try {
    const r = await runGroundingCheck({ source: 'arch_discovery' }, wu('src/anything.js'));
    assert.deepEqual(r, { verdict: 'ok' });
  } finally {
    if (saved !== undefined) process.env.AGENT_MANAGER_REPO_ROOT = saved;
  }
});
