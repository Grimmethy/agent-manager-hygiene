'use strict';

// change_review / change_review_fix -- diff-scoped correctness review of each unit merged
// to the main branch (2026-09-04). Everything else in this plugin is a whole-repo regex
// scanner for a fixed maintainability/perf/style rule; nothing looks at *the change a
// commit introduced*. This does: for each first-parent commit on origin/<mainBranch> since
// a SHA cursor (a direct commit, or the first-parent delta of a --no-ff merge), a review
// draft hunts ONLY for correctness regressions -- off-by-one, inverted/dropped condition,
// removed error path, resource leak, wrong variable, or a changed signature/return-shape
// whose callers were not all updated. Confirmed findings become `### AC-NNN` candidates in
// Docs/CHANGE_REVIEW_CANDIDATES.md; change_review_fix turns them into real diffs on
// agent/<id> branches a human merges.
//
// Template: arch_discovery (generator + custom candidate-doc apply + emptyApproval +
// directToMain) crossed with pipeline_forensics (advisoryProse report as the draft,
// harnessSearch grounding). The _fix half mirrors arch_review exactly.
//
// Idempotency is the SHA-in-the-task-id + taskIdExistsInQueue (done/ copies live forever);
// the cursor file is a pure optimization and is only ever advanced over commits whose task
// is already queued/done or was deliberately skipped -- so a task that getNextTask()
// discards on a tier filter can never make its commit un-reviewable.

const { hygieneFamily } = require('./hygiene-family.js');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { registerTaskSource, updateTaskSource } = require('agent-manager/src/task-source-registry.js');
const { verifyQuotedCode, describeUnverified } = require('./change-review-quote-check.js');
const { applyArchDiscoveryCandidates, isEffectivelyEmptyResponse } = require('agent-manager/src/candidate-docs.js');
const { writeJsonAtomicSync } = require('agent-manager/src/atomic-write.js');
const { archReviewPlanPrompt, archReviewImplementPrompt } = require('agent-manager/src/prompts.js');
const { detectDefaultBranch } = require('agent-manager/src/git-runner.js');
const { runScopedTests } = require('agent-manager/src/scoped-test-runner.js');

const DIFF_LINE_CAP = Number(process.env.AGENT_MANAGER_CHANGE_REVIEW_LINE_CAP) || 1500;
const DIFF_FILE_CAP = Number(process.env.AGENT_MANAGER_CHANGE_REVIEW_FILE_CAP) || 60;
const ENUMERATE_CAP = 200;                 // units inspected per tick
const CHANGE_REVIEW_CONTEXT_BUDGET_CHARS = 22000;
const DIFF_BUDGET_CHARS = 16000;
const SMALL_FILE_MAX_CHARS = 6000;
const SMALL_FILE_MAX_COUNT = 3;
const SNIPPET_CAP_CHARS = 1500;
const AC_BLOCK_MAX_CHARS = 3500;           // MAX_ARCH_REVIEW_TASK_CHARS is 4000 -- stay well under
const DEFAULT_BACKFILL = 10;

// --- batching small commits into one review task (2026-09-23) -----------------------
// Generation was outpacing consumption: change_review materializes one task per
// first-parent commit, and this repo's own pipeline can land dozens of tiny commits
// (a one-line fix, a doc tweak that still touches code, a config bump) in a single day,
// each paying the full per-task overhead (a worker claim, a plan pass, an implement pass,
// a review round) for a diff a human would glance at in seconds. Confirmed live
// 2026-09-22: ~870 new pending change_review tasks materialized in 24h against only ~22
// new commits actually landing that day -- the generator was grinding through a long-
// stale historical backlog, one tiny commit at a time.
//
// Bundling several small, CONSECUTIVE commits into one review task cuts task count
// without skipping anything: every commit is still reviewed, hunk-by-hunk, by name --
// this only amortizes the fixed per-task overhead across commits too small to need their
// own dedicated pass. A commit whose own diff already eats a meaningful chunk of the
// budget is still reviewed alone, exactly as before (large, security/behavior-heavy
// changes are exactly the ones that should NOT get diluted by being bundled with others).
const CHANGE_REVIEW_BATCH_MAX_UNITS = Number(process.env.AGENT_MANAGER_CHANGE_REVIEW_BATCH_SIZE) || 5;
const CHANGE_REVIEW_BATCH_UNIT_MAX_CHARS = 3000;    // a unit diff bigger than this reviews alone
const CHANGE_REVIEW_BATCH_COMBINED_MAX_CHARS = 12000; // stays well under DIFF_BUDGET_CHARS/CONTEXT_BUDGET

// %n (newline) field separator: execFileSync args cannot contain a literal NUL byte, and
// %s (subject) / %an / %cI never themselves contain a newline, so this round-trips cleanly.
const FIELD_SEP = '\n';

// --- git ------------------------------------------------------------------------------

// realGit shape (agent-manager/src/task-disposition.js): -C <repoRoot>, no prompts, times
// out, '' on ANY failure so a caller can treat "" as "couldn't tell".
function git(repoRoot, args) {
  try {
    return execFileSync('git', ['-C', repoRoot, ...args], {
      encoding: 'utf8',
      timeout: 15000,
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
  } catch {
    return '';
  }
}

function isGitRepo(repoRoot) {
  return git(repoRoot, ['rev-parse', '--git-dir']).trim() !== '';
}

function resolveMainBranch(repoRoot) {
  try {
    const b = detectDefaultBranch(repoRoot);
    if (b) return b;
  } catch { /* fall through */ }
  for (const b of ['main', 'master']) {
    if (git(repoRoot, ['rev-parse', '--verify', '--quiet', `origin/${b}`]).trim()) return b;
  }
  return 'master';
}

function headSha(repoRoot, mainBranch) {
  return git(repoRoot, ['rev-parse', `origin/${mainBranch}`]).trim();
}

function seedCursorSha(repoRoot, mainBranch) {
  const n = Number.isFinite(Number(process.env.AGENT_MANAGER_CHANGE_REVIEW_BACKFILL))
    ? Math.max(0, Number(process.env.AGENT_MANAGER_CHANGE_REVIEW_BACKFILL))
    : DEFAULT_BACKFILL;
  const skipped = git(repoRoot, ['rev-list', '--first-parent', `--skip=${n}`, '-n', '1', `origin/${mainBranch}`]).trim();
  if (skipped) return skipped;
  // Fewer than n commits on the branch -> start from its root commit's parent, i.e. review
  // everything: use the empty-tree sentinel so `<seed>..origin/<main>` includes commit 1.
  return git(repoRoot, ['rev-list', '--max-parents=0', '--first-parent', '-n', '1', `origin/${mainBranch}`]).trim()
    || headSha(repoRoot, mainBranch);
}

function enumerateUnits(repoRoot, mainBranch, sinceSha) {
  const range = sinceSha ? `${sinceSha}..origin/${mainBranch}` : `origin/${mainBranch}`;
  const out = git(repoRoot, ['rev-list', '--reverse', '--first-parent', range]).trim();
  if (!out) return [];
  return out.split('\n').filter(Boolean).slice(0, ENUMERATE_CAP);
}

function unitMetadata(repoRoot, sha) {
  const raw = git(repoRoot, ['show', '-s', '--format=%H%n%s%n%an%n%cI', sha]);
  const [full = sha, subject = '', author = '', dateISO = ''] = raw.split(FIELD_SEP);
  return { sha: full, sha7: full.slice(0, 7), subject: subject.trim(), author: author.trim(), dateISO: dateISO.trim() };
}

function unitNameStatus(repoRoot, sha) {
  // `git show` (not diff-tree, which emits nothing for a merge commit) so a --no-ff merge
  // and a plain commit both resolve to their first-parent name-status list.
  const raw = git(repoRoot, ['show', '--first-parent', '--name-status', '--format=', sha]).trim();
  if (!raw) return [];
  return raw.split('\n').filter(Boolean).map((line) => {
    const parts = line.split('\t');
    return { status: parts[0], path: parts[parts.length - 1] };
  });
}

function unitNumstat(repoRoot, sha) {
  const raw = git(repoRoot, ['show', '--first-parent', '--numstat', '--format=', sha]).trim();
  let added = 0;
  let deleted = 0;
  let files = 0;
  if (raw) {
    for (const line of raw.split('\n')) {
      const [a, d] = line.split('\t');
      files += 1;
      if (a !== '-') added += Number(a) || 0;
      if (d !== '-') deleted += Number(d) || 0;
    }
  }
  return { files, added, deleted, changedLines: added + deleted };
}

function unitDiff(repoRoot, sha) {
  return git(repoRoot, ['show', '--first-parent', '-U12', '--format=', sha]);
}

// --- classification -----------------------------------------------------------------

const DOC_RE = /(?:^|\/)(?:Docs|docs)\/|\.(?:md|txt|rst)$/i;
const GENERATED_RE = /(?:^|\/)(?:package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$|\.(?:min\.js|map|snap)$|(?:^|\/)(?:dist|build|vendor)\//i;

function classifyUnit(nameStatus) {
  const paths = nameStatus.map((f) => f.path).filter(Boolean);
  if (paths.length === 0) return 'reviewable';
  if (paths.every((p) => DOC_RE.test(p))) return 'doc-only';
  if (paths.every((p) => GENERATED_RE.test(p))) return 'generated';
  return 'reviewable';
}

// --- prompt context -----------------------------------------------------------------

// Bulk/generated data in a diff (2026-09-19, PF-Client-Portal a747d62): a commit added a 1.8 MB
// single-line GeoJSON file plus a small real change to PropertyMap.tsx. capHunks() keeps WHOLE hunks
// in order, so the giant JSON hunk (first in the diff) consumed the entire budget and the TSX hunks
// never reached the model -- 8 drafts all said "no hunks visible", the review correctly rejected
// them, and the task escalated to a human. sanitizeDiff() runs BEFORE the cap: it stubs out bulk data
// files and truncates absurdly long lines, so the code that actually changed is always what's shown.
const BULK_DATA_FILE_RE = /\.(?:json|geojson|ndjson|csv|tsv|svg|lock|map|snap|min\.[a-z]+)$/i;
const BULK_SECTION_CHARS = 6000;   // a data-file diff section bigger than this is elided whole
const MAX_DIFF_LINE_CHARS = 600;   // any single diff line longer than this (minified code, inline data) is cut

function sanitizeDiff(diffText) {
  if (!diffText) return diffText;
  const sections = diffText.split(/^(?=diff --git )/m);
  const out = [];
  for (const sec of sections) {
    const header = sec.match(/^diff --git a\/(.+?) b\/(.+)$/m);
    const file = header ? header[2] : null;
    if (file && BULK_DATA_FILE_RE.test(file) && sec.length > BULK_SECTION_CHARS) {
      const lines = sec.split('\n').length;
      out.push(`diff --git a/${file} b/${file}\n[bulk data file elided from review -- not a code change: ${file} (${sec.length.toLocaleString('en-US')} chars, ${lines} diff lines). Do not treat this as an unread hunk.]\n`);
      continue;
    }
    out.push(sec.split('\n').map((l) => (l.length > MAX_DIFF_LINE_CHARS ? `${l.slice(0, MAX_DIFF_LINE_CHARS)} ...[+${l.length - MAX_DIFF_LINE_CHARS} chars cut]` : l)).join('\n'));
  }
  return out.join('');
}

function capHunks(diffText, budget) {
  if (diffText.length <= budget) return diffText;
  // Keep whole hunks (a hunk starts at a line beginning with "@@ " or a "diff --git" header)
  // in order until the budget is spent.
  const lines = diffText.split('\n');
  const kept = [];
  let used = 0;
  let hunks = 0;
  let total = 0;
  for (const line of lines) {
    if (line.startsWith('@@ ')) total += 1;
  }
  for (const line of lines) {
    if (used + line.length + 1 > budget && line.startsWith('@@ ')) break;
    if (line.startsWith('@@ ')) hunks += 1;
    kept.push(line);
    used += line.length + 1;
  }
  let body = kept.join('\n');
  // A single hunk larger than the whole budget is kept whole by the loop above; never let it through.
  if (body.length > budget * 1.25) body = body.slice(0, budget);
  return `${body}\n...[diff truncated: showing ${hunks} of ${total} hunks]`;
}

function smallFileContents(repoRoot, nameStatus) {
  const out = [];
  for (const f of nameStatus) {
    if (out.length >= SMALL_FILE_MAX_COUNT) break;
    if (f.status === 'D') continue;
    if (DOC_RE.test(f.path) || GENERATED_RE.test(f.path)) continue;
    let content;
    try {
      content = fs.readFileSync(path.join(repoRoot, f.path), 'utf8');
    } catch {
      continue;
    }
    if (content.length > SMALL_FILE_MAX_CHARS) continue;
    out.push({ path: f.path, content });
  }
  return out;
}

function buildPromptContext(repoRoot, meta, nameStatus, diffText, mainBranch) {
  const files = nameStatus.map((f) => `${f.status}\t${f.path}`);
  diffText = sanitizeDiff(diffText);
  let cappedDiff = capHunks(diffText, DIFF_BUDGET_CHARS);
  let small = smallFileContents(repoRoot, nameStatus);
  // Keep the whole promptContext under the deep_dive-style budget.
  const size = () => cappedDiff.length + small.reduce((n, s) => n + s.content.length, 0);
  while (size() > CHANGE_REVIEW_CONTEXT_BUDGET_CHARS && small.length > 0) small = small.slice(0, -1);
  if (size() > CHANGE_REVIEW_CONTEXT_BUDGET_CHARS) {
    cappedDiff = capHunks(diffText, Math.max(4000, CHANGE_REVIEW_CONTEXT_BUDGET_CHARS));
  }
  return {
    sha: meta.sha7,
    subject: meta.subject,
    author: meta.author,
    dateISO: meta.dateISO,
    mainBranch,
    files,
    unitDiff: cappedDiff,
    smallFileContents: small,
  };
}

// --- state files -------------------------------------------------------------------

function readCursor(cursorPath) {
  try {
    const data = JSON.parse(fs.readFileSync(cursorPath, 'utf8'));
    if (data && typeof data.lastReviewedSha === 'string' && data.lastReviewedSha) return data;
  } catch { /* absent / malformed */ }
  return null;
}

function writeCursor(cursorPath, sha) {
  writeJsonAtomicSync(cursorPath, { lastReviewedSha: sha, updatedAt: new Date().toISOString() });
}

function skippedPath(pipelineDir) {
  return path.join(pipelineDir, 'change-review-skipped.json');
}

function recordSkip(pipelineDir, meta, reason, stats) {
  const p = skippedPath(pipelineDir);
  let arr = [];
  try {
    arr = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!Array.isArray(arr)) arr = [];
  } catch { /* new */ }
  if (arr.some((e) => e && e.sha === meta.sha)) return;
  arr.push({
    sha: meta.sha,
    sha7: meta.sha7,
    subject: meta.subject,
    reason,
    changedLines: stats ? stats.changedLines : undefined,
    files: stats ? stats.files : undefined,
    skippedAt: new Date().toISOString(),
  });
  try {
    writeJsonAtomicSync(p, arr);
  } catch { /* non-fatal audit log */ }
}

// --- the generator ----------------------------------------------------------------

function nextChangeReviewTask({ getConfig, taskIdExistsInQueue }) {
  let cfg;
  try {
    cfg = getConfig();
  } catch {
    return null;
  }
  const { repoRoot, pipelineDir, defaultDomain, changeReviewCursorPath } = cfg;
  if (!repoRoot || !isGitRepo(repoRoot)) return null;

  const mainBranch = resolveMainBranch(repoRoot);
  if (process.env.AGENT_MANAGER_CHANGE_REVIEW_FETCH === '1') {
    git(repoRoot, ['fetch', 'origin', mainBranch, '--quiet']);
  }
  const head = headSha(repoRoot, mainBranch);
  if (!head) return null;

  let cursor = readCursor(changeReviewCursorPath);
  if (!cursor) {
    const seed = seedCursorSha(repoRoot, mainBranch);
    if (!seed) return null;
    writeCursor(changeReviewCursorPath, seed);
    cursor = { lastReviewedSha: seed };
  }
  if (cursor.lastReviewedSha === head) return null;

  const units = enumerateUnits(repoRoot, mainBranch, cursor.lastReviewedSha);

  // Accumulates consecutive small reviewable units into one batch task -- see this file's
  // own header on CHANGE_REVIEW_BATCH_MAX_UNITS for why. flushBatch() below either returns
  // the batch as a task (0 or 1 members -> the exact legacy shape/behavior; 2+ -> the new
  // batch shape), or -- when that exact batch was already queued/done from a prior tick --
  // advances the cursor past every member and returns null so the caller keeps scanning.
  let batch = [];
  let batchChars = 0;
  const flushBatch = () => {
    if (batch.length === 0) return undefined;
    if (batch.length === 1) {
      const { id, meta, ctx } = batch[0];
      batch = []; batchChars = 0;
      return soloTask(defaultDomain, meta, ctx, id);
    }
    const batchId = `change-review-batch-${batch[0].meta.sha7}-${batch[batch.length - 1].meta.sha7}`;
    if (taskIdExistsInQueue(batchId)) {
      writeCursor(changeReviewCursorPath, batch[batch.length - 1].sha);
      batch = []; batchChars = 0;
      return undefined;
    }
    const task = batchTask(defaultDomain, batch, batchId, mainBranch);
    batch = []; batchChars = 0;
    return task;
  };

  for (const sha of units) {
    const id = `change-review-${sha.slice(0, 7)}`;
    if (taskIdExistsInQueue(id)) {
      const flushed = flushBatch();
      if (flushed) return flushed;
      writeCursor(changeReviewCursorPath, sha);
      continue;
    }
    const meta = unitMetadata(repoRoot, sha);
    const nameStatus = unitNameStatus(repoRoot, sha);
    const kind = classifyUnit(nameStatus);
    if (kind !== 'reviewable') {
      const flushed = flushBatch();
      if (flushed) return flushed;
      recordSkip(pipelineDir, meta, kind, null);
      writeCursor(changeReviewCursorPath, sha);
      continue;
    }
    const stats = unitNumstat(repoRoot, sha);
    if (stats.changedLines > DIFF_LINE_CAP || stats.files > DIFF_FILE_CAP) {
      const flushed = flushBatch();
      if (flushed) return flushed;
      recordSkip(pipelineDir, meta, 'too-large', stats);
      writeCursor(changeReviewCursorPath, sha);
      continue;
    }
    const diffText = unitDiff(repoRoot, sha);
    if (!diffText.trim()) {
      // Empty first-parent delta (e.g. a merge that changed nothing) -- nothing to review.
      const flushed = flushBatch();
      if (flushed) return flushed;
      recordSkip(pipelineDir, meta, 'empty-diff', stats);
      writeCursor(changeReviewCursorPath, sha);
      continue;
    }

    const ctx = buildPromptContext(repoRoot, meta, nameStatus, diffText, mainBranch);

    // Deterministic test gate (2026-09-23) -- see scoped-test-runner.js's own header for
    // the full rationale: this diff broke an EXISTING test is a fact, not a judgment
    // call, and running the test IS the ground truth -- no model call needed, and none
    // would be more reliable. Checked BEFORE this unit ever enters the batch/solo LLM
    // path below; a real failure here files its finding immediately and skips the model
    // entirely for this commit. `passed: true` or `null` (no covering test exists) both
    // fall through unchanged -- this gate can only ADD confidence, never subtract it, so
    // it never suppresses the normal LLM review that still runs for everything else.
    let testResult = null;
    try {
      testResult = runScopedTests(repoRoot, nameStatus.map((f) => f.path));
    } catch { /* fail open -- a runner-level problem must never block the normal review */ }
    if (testResult && !testResult.passed) {
      const flushed = flushBatch();
      if (flushed) return flushed;
      fileDeterministicTestFailureFinding(pipelineDir, meta, ctx, testResult);
      recordSkip(pipelineDir, meta, 'test-failure-auto-filed', stats);
      writeCursor(changeReviewCursorPath, sha);
      continue;
    }

    const unitChars = (ctx.unitDiff || '').length;
    const tooLargeForBatch = unitChars > CHANGE_REVIEW_BATCH_UNIT_MAX_CHARS;

    if (batch.length > 0 && (tooLargeForBatch || batchChars + unitChars > CHANGE_REVIEW_BATCH_COMBINED_MAX_CHARS)) {
      // This unit doesn't fit in the batch accumulated so far -- close that batch out
      // (returning it, or discarding it if already queued) before considering this unit.
      const flushed = flushBatch();
      if (flushed) return flushed;
    }
    if (batch.length === 0 && tooLargeForBatch) {
      // Too big to ever bundle -- reviewed alone, exactly like the original behavior.
      return soloTask(defaultDomain, meta, ctx, id);
    }

    batch.push({ id, sha, meta, ctx });
    batchChars += unitChars;
    if (batch.length >= CHANGE_REVIEW_BATCH_MAX_UNITS) {
      const flushed = flushBatch();
      if (flushed) return flushed;
    }
  }
  return flushBatch() || null;
}

function soloTask(defaultDomain, meta, ctx, id) {
  // Found a reviewable unit whose task is NOT yet queued -- return it WITHOUT advancing
  // the cursor (tier-filter-discard safety) -- exactly the original single-commit shape,
  // unchanged, so every already-queued task and every existing caller keeps working.
  return {
    id,
    domain: defaultDomain,
    source: 'change_review',
    title: `Change review: ${meta.sha7} ${meta.subject}`.slice(0, 140),
    promptContext: ctx,
  };
}

function batchTask(defaultDomain, batch, batchId, mainBranch) {
  const first = batch[0].meta.sha7;
  const last = batch[batch.length - 1].meta.sha7;
  return {
    id: batchId,
    domain: defaultDomain,
    source: 'change_review',
    title: `Change review: ${batch.length} small commits (${first}..${last})`.slice(0, 140),
    // Deliberately NOT the single-commit shape (no top-level sha/unitDiff) -- `units` is
    // the multi-commit shape unitsOf() below recognizes; every already-existing pending/
    // done task still has the flat legacy shape and unitsOf() wraps that unchanged.
    promptContext: {
      mainBranch,
      units: batch.map(({ meta, ctx }) => ({
        sha: meta.sha7,
        subject: meta.subject,
        author: meta.author,
        dateISO: meta.dateISO,
        files: ctx.files,
        unitDiff: ctx.unitDiff,
        smallFileContents: ctx.smallFileContents,
      })),
    },
  };
}

// Normalizes either promptContext shape (legacy flat single-unit, or the new
// `{units:[...]}` multi-unit batch) into an array -- every reader of a unit's own fields
// (prompts, apply, the quote-check) goes through this so both shapes work everywhere.
function unitsOf(ctx) {
  if (!ctx) return [];
  if (Array.isArray(ctx.units) && ctx.units.length) return ctx.units;
  if (ctx.sha) return [{ sha: ctx.sha, subject: ctx.subject, author: ctx.author, dateISO: ctx.dateISO, files: ctx.files, unitDiff: ctx.unitDiff, smallFileContents: ctx.smallFileContents }];
  return [];
}

// --- prompts --------------------------------------------------------------------

function renderSmallFiles(ctx) {
  if (!Array.isArray(ctx.smallFileContents) || ctx.smallFileContents.length === 0) {
    return '(none embedded -- work from the diff hunks)';
  }
  return ctx.smallFileContents
    .map((f) => `--- ${f.path} ---\n\`\`\`\n${f.content}\n\`\`\``)
    .join('\n\n');
}

function renderUnitBlock(u, index, total) {
  return [
    total > 1 ? `=== COMMIT ${index + 1}/${total}: ${u.sha} ${u.subject}  (author ${u.author}, ${u.dateISO}) ===` : `COMMIT: ${u.sha} ${u.subject}  (author ${u.author}, ${u.dateISO})`,
    'Changed files:',
    (u.files || []).join('\n'),
    '',
    'DIFF (unified, first-parent delta):',
    u.unitDiff || '(no diff)',
    '',
    'Small touched files, full content, for context:',
    renderSmallFiles(u),
  ].join('\n');
}

function changeReviewPlanPrompt(task) {
  const ctx = task.promptContext || {};
  const units = unitsOf(ctx);
  const multi = units.length > 1;
  const header = multi
    ? `You are triaging the diffs of ${units.length} small, separately-authored changes already merged to ${ctx.mainBranch || 'the main branch'}, looking ONLY for CORRECTNESS REGRESSIONS each one introduced -- behaviour that was right before and is wrong after. Judge each commit independently; a regression in one is unrelated to the others.`
    : `You are triaging the diff of ONE change already merged to ${ctx.mainBranch || 'the main branch'}, looking ONLY for CORRECTNESS REGRESSIONS this diff introduced -- behaviour that was right before and is wrong after.`;
  return [
    header,
    '',
    ...units.map((u, i) => renderUnitBlock(u, i, units.length)),
    '',
    multi
      ? 'PART 1 -- for EACH commit above, write a numbered PLAN that walks EVERY changed hunk and, for each, states one of:'
      : 'PART 1 -- write a numbered PLAN that walks EVERY changed hunk and, for each, states one of:',
    '  - "hunk N (<file>): no correctness change" + a one-clause reason, OR',
    '  - "hunk N (<file>): SUSPECT -- <what could now be wrong>"',
    multi ? 'Prefix each hunk with which commit it belongs to, e.g. "commit 2, hunk 1 (<file>): ...".' : '',
    '',
    'Hunt ONLY: off-by-one / wrong bound; inverted, dropped, or weakened condition; a removed',
    'or bypassed error/validation path; a resource not released on a path that now exists;',
    'the wrong variable / field / argument; a changed function signature, return shape, or',
    'thrown-error contract whose callers were NOT all updated.',
    '',
    'NOT in scope -- never mention: style, naming, formatting, performance, missing tests,',
    '"could be cleaner", docs, anything not visibly changed by this diff. Say UNKNOWN rather',
    'than guessing at code you were not shown.',
    '',
    'PART 2 -- for every function, method, or exported constant whose signature or contract',
    'any commit above CHANGED, emit one line to find its callers elsewhere in the repo:',
    'QUERY: <the symbol name>',
    '(Emit nothing here if nothing changed a public symbol.)',
  ].join('\n');
}

function renderHarness(ctx) {
  const hits = Array.isArray(ctx.harnessHits) ? ctx.harnessHits : [];
  const files = Array.isArray(ctx.harnessFiles) ? ctx.harnessFiles : [];
  const hitLines = hits.length
    ? hits.map((h) => `- ${h.file}:${h.line} (query "${h.query}"): ${h.text}`).join('\n')
    : '(no caller search hits)';
  const fileText = files.length
    ? `\n${files.map((f) => `--- ${f.path} ---\n\`\`\`\n${f.content}\n\`\`\``).join('\n\n')}`
    : '';
  return `${hitLines}${fileText}`;
}

function changeReviewImplementPrompt(task, planText) {
  const ctx = task.promptContext || {};
  const units = unitsOf(ctx);
  const multi = units.length > 1;
  return [
    'CONTEXT: you already triaged ' + (multi ? 'these merged changes' : 'this merged change') + ' hunk-by-hunk:',
    planText || '(no plan)',
    '',
    ...units.map((u, i) => [
      multi ? `=== COMMIT ${i + 1}/${units.length}: ${u.sha} ${u.subject} ===` : `COMMIT: ${u.sha} ${u.subject}`,
      'DIFF:',
      u.unitDiff || '(no diff)',
      renderSmallFiles(u),
    ].join('\n')),
    '',
    'CALLERS FOUND ELSEWHERE IN THE REPO (from your PART 2 queries -- check each against the',
    'changed contract):',
    renderHarness(ctx),
    '',
    'Produce the FINAL correctness review. For every SUSPECT hunk, promote it to a confirmed',
    'finding OR discard it -- discard any finding for which you cannot construct a concrete',
    'failing input.',
    '',
    'Output EXACTLY one of:',
    '',
    '(A) the single line:  NO CORRECTNESS ISSUES',
    '    -- use this if, after walking every hunk in every commit above, there is no regression',
    '      you can demonstrate with a concrete input. Common and fully acceptable.',
    '',
    '(B) one or more findings, each EXACTLY this block, blank-line separated, NOTHING else:',
    '',
    'FINDING',
    ...(multi ? [`Commit: <the exact COMMIT sha shown above this finding's diff, e.g. ${units[0].sha}>`] : []),
    'File: <path from the diff>',
    'Line: <post-change line number or hunk header>',
    'Severity: high | med | low',
    'Regression: <one sentence -- what was correct before this diff and is wrong after>',
    'Failure scenario: <a concrete input/call with REAL values, and the wrong output it now',
    '  produces, traceable line by line in the diff above>',
    'Fix sketch: <the smallest change to the named file that restores the pre-diff behaviour>',
    '',
    'Rules: every finding needs a Failure scenario with real values -- no constructible',
    'failing input means it is not a finding. Only regressions introduced by THIS diff (not a',
    'pre-existing bug it merely moved). Do not invent code outside the diff, the embedded',
    'files, and the caller hits. Cite the hunk.' + (multi ? ' A finding with no Commit: line, or one that names a sha not shown above, is unusable -- always include it.' : ''),
  ].join('\n');
}

// --- apply ---------------------------------------------------------------------

// 2026-09-23, root-caused live wiring the deterministic test gate: with the /m flag, a
// bare `$` matches before EVERY line ending, not just the end of the whole string -- so
// `failure`/`fix`'s "or end of string" fallback alternative actually meant "or end of
// THIS LINE", silently truncating any multi-line field value at its very first internal
// newline. Invisible until now because a real LLM finding's prose never embeds a hard
// newline inside one field; the deterministic gate's own synthetic finding embeds real,
// multi-line `node --test`/`unittest` output and hit this immediately (confirmed live:
// filed with a completely empty Failure scenario, cut off right after its own first
// line). `(?![\s\S])` is a true end-of-STRING assertion, unaffected by /m, unlike `$`.
const FIELD_RES = {
  commit: /^Commit:\s*(.+)$/im,
  file: /^File:\s*(.+)$/im,
  line: /^Line:\s*(.+)$/im,
  severity: /^Severity:\s*(.+)$/im,
  regression: /^Regression:\s*(.+)$/im,
  failure: /^Failure scenario:\s*([\s\S]+?)(?=\n(?:Fix sketch:|Severity:|Regression:|File:|Line:)|\n{2,}|(?![\s\S]))/im,
  fix: /^Fix sketch:\s*([\s\S]+?)(?=\n{2,}|(?![\s\S]))/im,
};

function parseFindings(text) {
  // Split on a line that is exactly "FINDING".
  const blocks = text.split(/^FINDING\s*$/im).slice(1);
  const out = [];
  for (const block of blocks) {
    const g = (re) => {
      const m = block.match(re);
      return m ? m[1].trim() : '';
    };
    const finding = {
      commit: g(FIELD_RES.commit), // '' on a solo (single-commit) task -- Commit: is only required/emitted for a batch
      file: g(FIELD_RES.file),
      line: g(FIELD_RES.line),
      severity: (g(FIELD_RES.severity) || 'med').toLowerCase().split(/\s|\|/)[0],
      regression: g(FIELD_RES.regression),
      failure: g(FIELD_RES.failure),
      fix: g(FIELD_RES.fix),
    };
    if (!finding.file || !finding.regression || !finding.failure) continue;
    if (!['high', 'med', 'low'].includes(finding.severity)) finding.severity = 'med';
    out.push(finding);
  }
  return out;
}

// Resolves which reviewed commit a finding is about. A solo task has exactly one unit --
// always that one, Commit: field or not. A batch needs the model's own Commit: line to
// disambiguate; an exact or prefix match against a unit's (short) sha wins, and an
// unmatched/missing Commit: on a batch falls back to the first unit rather than silently
// mislabeling the finding as belonging to none of them.
function unitForFinding(units, finding) {
  if (units.length <= 1) return units[0] || {};
  const wanted = (finding.commit || '').trim();
  if (wanted) {
    const hit = units.find((u) => u.sha && (u.sha === wanted || u.sha.startsWith(wanted) || wanted.startsWith(u.sha)));
    if (hit) return hit;
  }
  return units[0];
}

// Best-effort: the hunk from ctx.unitDiff that touches the finding's file, capped.
function hunkForFile(unitDiff, file) {
  if (!unitDiff || !file) return '';
  const lines = unitDiff.split('\n');
  const base = file.split('/').pop();
  let capture = false;
  const out = [];
  for (const line of lines) {
    if (line.startsWith('diff --git ') || line.startsWith('--- ') || line.startsWith('+++ ')) {
      capture = line.includes(file) || line.includes(base);
      if (capture) out.push(line);
      continue;
    }
    if (capture) {
      out.push(line);
      if (out.join('\n').length > SNIPPET_CAP_CHARS) break;
    }
  }
  const text = out.join('\n').slice(0, SNIPPET_CAP_CHARS);
  return text || unitDiff.slice(0, SNIPPET_CAP_CHARS);
}

// Does the code this finding quotes as EXISTING actually appear in the file at the reviewed commit? See
// change-review-quote-check.js. Fail-open: no readable file / no config -> nothing is checked.
function verifyFinding(finding, ctx) {
  let fileText = '';
  try {
    const { repoRoot } = require('agent-manager/src/config.js').getConfig();
    if (repoRoot && ctx.sha && finding.file && !finding.file.includes('..')) fileText = git(repoRoot, ['show', `${ctx.sha}:${finding.file}`]);
  } catch { /* unreadable -> fall back to the diff, then to "not checked" */ }
  return verifyQuotedCode(finding, { fileText, unitDiff: ctx.unitDiff });
}

function buildAcBlock(finding, ctx, verification) {
  const sha7 = ctx.sha || '';
  const base = finding.file.split('/').pop();
  const title = `${finding.regression.replace(/\s+/g, ' ').slice(0, 90)} (${sha7} ${base})`;
  const snippet = hunkForFile(ctx.unitDiff, finding.file);
  // An unverifiable quote downgrades the finding (kept for a human, not auto-fulfilled: the fix stage consumes only
  // Strong). See change-review-quote-check.js for the incident.
  const unverified = verification && verification.unverified && verification.unverified.length ? verification.unverified : null;
  const unverifiedNote = unverified ? `[UNVERIFIED QUOTE: ${describeUnverified(unverified, { file: finding.file, sha: sha7 })} -- the finding may be a misreading; check before acting] ` : '';
  // applyArchDiscoveryCandidates only preserves the canonical fields (Strength / Split-Depth
  // / Source / Files / Snippet) plus the body -- so severity and the commit go INTO the
  // Problem line where they survive to the fix stage and a human reader.
  const block = [
    `### AC-1 · ${title}`,
    `Strength: ${unverified ? 'Unverified' : 'Strong'}`,
    `Source: change_review of ${sha7} "${(ctx.subject || '').replace(/"/g, "'").slice(0, 80)}"`,
    `Files: ${finding.file}`,
    'Snippet:',
    '```',
    snippet,
    '```',
    '',
    `Problem: ${unverifiedNote}[severity: ${finding.severity}; regression shipped in ${sha7}] ${finding.regression}  Failure scenario: ${finding.failure.replace(/\s+/g, ' ')}`,
    `Solution: ${finding.fix || 'Restore the pre-diff behaviour for the failure scenario above (smallest change to ' + finding.file + ').'}`,
    `Benefits: Restores correct behaviour for the scenario above; undoes the regression shipped in ${sha7}.`,
  ].join('\n');
  if (block.length <= AC_BLOCK_MAX_CHARS) return block;
  // Over budget -- shrink the snippet hard.
  const shortSnippet = snippet.slice(0, Math.max(200, SNIPPET_CAP_CHARS - (block.length - AC_BLOCK_MAX_CHARS) - 40));
  return block.replace(snippet, `${shortSnippet}\n...[snippet truncated]`);
}

// Deterministic-test-gate finding (2026-09-23): the model is never consulted here -- the
// FINDING block below is built entirely from real `runScopedTests` output and fed through
// the exact same applyChangeReview()/buildAcBlock() path a real LLM finding would take, so
// it lands in Docs/CHANGE_REVIEW_CANDIDATES.md identically (same format, same downstream
// change_review_fix consumption). Severity is always 'high' -- an existing test failing is
// unconditionally a real regression, never a judgment call the way an LLM's own findings
// are. Best-effort: any failure while filing (a config/fs problem) is swallowed with a
// warning, matching recordSkip's own "an audit-log write must never break the caller"
// discipline -- the commit's own review coverage isn't lost either way, since the caller
// (nextChangeReviewTask) still records the ordinary 'test-failure-auto-filed' skip and
// advances the cursor regardless of whether this filing itself succeeded.
function fileDeterministicTestFailureFinding(pipelineDir, meta, ctx, testResult) {
  const primaryFile = (ctx.files || [])[0] ? ctx.files[0].split('\t').slice(1).join('\t') : (ctx.sha || 'unknown file');
  const failureNames = testResult.failures.length ? testResult.failures.slice(0, 5).join('; ') : '(test runner reported failure with no individually-named test)';
  const ranList = (testResult.ran || []).join(', ');
  // Collapsed to single-newline-max BEFORE slicing/embedding: parseFindings' own
  // Failure-scenario field terminates on a blank line (\n{2,}) exactly like it terminates
  // on the next field name -- real `node --test`/unittest output is full of blank lines,
  // so embedding it verbatim silently truncated this field (confirmed live: the finding
  // filed with an EMPTY failure scenario, cut off at the very first blank line in the raw
  // TAP output). This is purely a report-readability compaction, not a content change.
  const rawExcerpt = ((testResult.jsRaw || '') + (testResult.pyRaw || ''))
    .replace(/\n{2,}/g, '\n').trim().slice(0, 600);
  const implementResponse = [
    'FINDING',
    `File: ${primaryFile}`,
    'Line: (deterministic test-gate finding -- no single line; see the failing test(s) below)',
    'Severity: high',
    `Regression: This diff makes an EXISTING test fail: ${failureNames}. Confirmed by actually running the test (${ranList}), not inferred.`,
    `Failure scenario: Running the scoped test suite for the files this commit touched fails with:\n${rawExcerpt || '(no output captured)'}`,
    'Fix sketch: Restore the behaviour the failing test expects, or update the test if this diff intentionally changed the contract it checks (and explain why in the fix).',
  ].join('\n');
  try {
    const res = applyChangeReview({ implementResponse, task: { promptContext: ctx } });
    if (!res || (!res.succeeded && !res.skipped)) {
      console.error(`[change-review] deterministic test-failure finding for ${meta.sha7} did not file cleanly: ${JSON.stringify(res)}`);
    }
  } catch (e) {
    console.error(`[change-review] failed to file deterministic test-failure finding for ${meta.sha7}: ${e.message}`);
  }
}

function applyChangeReview({ implementResponse, task }) {
  const text = String(implementResponse || '').trim();
  if (/^NO CORRECTNESS ISSUES\b/im.test(text) || isEffectivelyEmptyResponse(text)) {
    return { skipped: true, reason: 'change review: no correctness issues found' };
  }
  const findings = parseFindings(text);
  if (findings.length === 0) {
    return { skipped: true, reason: 'change review: no well-formed FINDING blocks in the draft' };
  }
  const ctx = (task && task.promptContext) || {};
  const units = unitsOf(ctx);
  const blocks = findings.map((f) => {
    const unit = unitForFinding(units, f);
    return buildAcBlock(f, unit, verifyFinding(f, unit));
  });

  let candidatesPath;
  try {
    candidatesPath = require('agent-manager/src/config.js').getConfig().changeReviewCandidatesPath;
  } catch {
    return { skipped: true, reason: 'change review: config unavailable at apply time' };
  }

  const res = applyArchDiscoveryCandidates({
    implementResponse: blocks.join('\n\n'),
    candidatesPath,
    docTitle: '# Change Review Candidates',
  });
  if (res.skipped) return res;
  return {
    succeeded: true,
    file: res.file,
    doneMarker: `filed ${(res.candidateIds || []).join(', ') || 'change-review candidate(s)'}`,
  };
}

// Advisory postImplementCheck: the same quote check, surfaced to the review votes as a warning (never a block --
// applyChangeReview downgrades the finding either way). Warnings reach the reviewer via agent-manager's
// task.groundingWarnings.
async function changeReviewQuoteCheck(task, implementResponse) {
  try {
    const ctx = (task && task.promptContext) || {};
    const units = unitsOf(ctx);
    const warnings = [];
    for (const f of parseFindings(String(implementResponse || ''))) {
      const unit = unitForFinding(units, f);
      const v = verifyFinding(f, unit);
      if (v.unverified.length) warnings.push(`finding on ${f.file}: ${describeUnverified(v.unverified, { file: f.file, sha: unit.sha })}`);
    }
    return warnings.length ? { verdict: 'ok', warnings } : { verdict: 'ok' };
  } catch {
    return { verdict: 'ok' };
  }
}

// --- review-gate guidance --------------------------------------------------------

const CHANGE_REVIEW_REVIEW_GUIDANCE = [
  'This is a change_review task: the drafter reviewed the diff of ONE already-merged change',
  'for CORRECTNESS REGRESSIONS only. The draft is either the single line "NO CORRECTNESS',
  'ISSUES" or one or more FINDING blocks -- there is no code change in this task.',
  '',
  'ACCEPT "NO CORRECTNESS ISSUES" as correct and complete WHEN the plan shows the drafter',
  'actually walked the changed hunks (it names specific hunks/files/lines with a per-hunk',
  'reason). Do NOT reject an honest "nothing wrong here" -- most merged diffs are correct.',
  '',
  'REJECT the draft if ANY of:',
  '  - a FINDING has no concrete Failure scenario with real input values, or the scenario',
  '    cannot be traced line-by-line in the given diff (an unfalsifiable finding poisons the',
  '    whole draft -- the fix stage would chase a phantom);',
  '  - a FINDING describes a pre-existing bug the diff only moved, not a regression it introduced;',
  '  - a FINDING cites code not in the diff, the embedded files, or the caller hits;',
  '  - it flags style, naming, performance, formatting, missing tests, or anything that is',
  '    not a correctness regression;',
  '  - it says "NO CORRECTNESS ISSUES" with no evidence any hunk was read (generic boilerplate).',
  'When every surviving finding has a concrete constructed failure and any clean verdict is',
  'backed by per-hunk reasoning, APPROVE.',
].join('\n');

const CHANGE_REVIEW_COMPLETENESS_QUESTION = [
  'Does the draft show every changed hunk was walked, and is each reported finding backed by',
  'a concrete failing input traceable in the given diff (or is "NO CORRECTNESS ISSUES" stated',
  'with per-hunk reasons)?',
].join('\n');

// 2026-09-18 (brain-dump bd-1789601881616, "large blast radius" -- 6 of 12 currently-
// blocked change-review-* tasks): capHunks() (this file's own function, above) truncates
// an oversized diff by WHOLE hunks and appends a deterministic
// "...[diff truncated: showing N of M hunks]" marker to the diff text itself -- which
// flows into BOTH the plan prompt (PART 1's own "say UNKNOWN rather than guessing at code
// you were not shown" instruction already tells the drafter to stop at hunk N) and this
// review-gate's own unitDiff. But CHANGE_REVIEW_REVIEW_GUIDANCE/COMPLETENESS_QUESTION
// above were static strings demanding coverage of "every changed hunk" unconditionally --
// a bar that is structurally unsatisfiable once the diff itself is too big for one
// context window, no matter how many times the task is redrafted. Confirmed live
// (change-review-0289728, 5 draft attempts, all eventually blocked): the plan honestly
// flagged hunks 7-13 as UNKNOWN/unreadable (never shown, not skipped), the implement
// draft correctly reported a real, substantive finding for hunk 2 and said nothing about
// the unreadable hunks (there was nothing TO say), and both reviewer votes rejected it
// for lacking per-hunk reasoning on hunks it was structurally never given.
//
// Fix: read the SAME deterministic truncation marker capHunks() writes, directly off
// task.promptContext.unitDiff (the real diff text review-task.js's buildVerdictPrompt
// feeds the reviewer) -- not relying on the model to correctly transcribe or remember it
// -- and when present, scope the coverage bar to the hunks actually shown (1..N), making
// coverage of hunk N+1..M an explicit non-requirement instead of a silent, unsatisfiable
// one. Returns the ORIGINAL, stricter guidance unchanged when the diff was never
// truncated, so a normal-sized diff's existing "every hunk" bar is untouched.
const DIFF_TRUNCATED_RE = /\[diff truncated: showing (\d+) of (\d+) hunks\]/;

function truncatedHunkCounts(task) {
  const unitDiff = (task && task.promptContext && task.promptContext.unitDiff) || '';
  const m = DIFF_TRUNCATED_RE.exec(unitDiff);
  return m ? { shown: Number(m[1]), total: Number(m[2]) } : null;
}

function changeReviewGuidanceFor(task) {
  const counts = truncatedHunkCounts(task);
  if (!counts) return CHANGE_REVIEW_REVIEW_GUIDANCE;
  const { shown, total } = counts;
  return `${CHANGE_REVIEW_REVIEW_GUIDANCE}\n\n${[
    `TRUNCATION EXCEPTION: this diff was too large for one context window -- only hunks`,
    `1 through ${shown} of ${total} total were ever shown to the drafter (the diff text itself`,
    `ends with "...[diff truncated: showing ${shown} of ${total} hunks]"). The drafter cannot`,
    `walk, and must NOT be rejected for failing to walk, hunk ${shown + 1} through ${total} --`,
    'those hunks were never shown to it, not silently skipped. ACCEPT a verdict that covers',
    `every hunk from 1 through ${shown} (per-hunk reasoning, or a clean "NO CORRECTNESS ISSUES"`,
    `backed by per-hunk reasoning for hunks 1-${shown}). REJECT only for the same reasons listed`,
    `above, scoped to hunks 1-${shown} -- never for lacking coverage of a hunk beyond ${shown}.`,
  ].join('\n')}`;
}

function changeReviewCompletenessQuestionFor(task) {
  const counts = truncatedHunkCounts(task);
  if (!counts) return CHANGE_REVIEW_COMPLETENESS_QUESTION;
  const { shown, total } = counts;
  return [
    `Does the draft show every hunk from 1 through ${shown} was walked (this diff was truncated`,
    `to ${shown} of ${total} total hunks -- coverage beyond hunk ${shown} was never possible and`,
    'must not be required), and is each reported finding backed by a concrete failing input',
    `traceable in the given diff (or is "NO CORRECTNESS ISSUES" stated with per-hunk reasons`,
    `for hunks 1-${shown})?`,
  ].join('\n');
}

const CHANGE_REVIEW_FIX_REVIEW_GUIDANCE = [
  'This task implements ONE correctness-regression fix from a change_review finding (candidate',
  'body: Problem = Regression + Failure scenario; Solution = Fix sketch; Snippet = the',
  'offending hunk). Judge it as a normal bug fix: does the diff restore the pre-regression',
  'behaviour for the exact Failure scenario named, does it stay within the candidate\'s Files:',
  'line, and does it add or update a test that fails without the fix and passes with it?',
  'Reject a fix scoped wider than the one regression, one that changes behaviour the candidate',
  'did not identify, or a behavioural change with no test. An empty draft is not a valid',
  '"nothing to do" -- it means the fix could not be produced.',
].join('\n');

// --- registration --------------------------------------------------------------

function register({ getConfig, nextCandidateFulfillmentTask, taskIdExistsInQueue, taskPriority }) {
  registerTaskSource('change_review', {
    hygieneFamily: hygieneFamily('change_review'),
    priority: taskPriority('change_review', 60),
    next: () => nextChangeReviewTask({ getConfig, taskIdExistsInQueue }),
    apply: applyChangeReview,
    directToMain: true,
    advisoryProse: true,
    emptyApproval: true,
    harnessSearch: 'archImport',
    reasoningTier: 'low',
    reportClass: 'housekeeping',
    reviewGuidance: changeReviewGuidanceFor,
    reviewCompletenessQuestion: changeReviewCompletenessQuestionFor,
    postImplementCheck: changeReviewQuoteCheck,
  });
  updateTaskSource('change_review', {
    buildPlanPrompt: changeReviewPlanPrompt,
    buildImplementPrompt: changeReviewImplementPrompt,
  });

  registerTaskSource('change_review_fix', {
    hygieneFamily: hygieneFamily('change_review', { candidateDoc: true }),
    priority: taskPriority('change_review_fix', 58),
    next: () => nextCandidateFulfillmentTask(getConfig().changeReviewCandidatesPath, 'change_review_fix'),
    candidateFulfillment: true,
    noCandidateSplit: true,
    candidatesPath: () => getConfig().changeReviewCandidatesPath,
    candidateDocTitle: '# Change Review Candidates',
    reasoningTier: 'high',
    reportClass: 'benefit',
    reviewGuidance: CHANGE_REVIEW_FIX_REVIEW_GUIDANCE,
  });
  updateTaskSource('change_review_fix', {
    buildPlanPrompt: archReviewPlanPrompt,
    buildImplementPrompt: archReviewImplementPrompt,
  });
}

module.exports = {
  register,
  sanitizeDiff,
  capHunks,
  buildPromptContext,
  nextChangeReviewTask,
  applyChangeReview,
  changeReviewQuoteCheck,
  classifyUnit,
  parseFindings,
  changeReviewPlanPrompt,
  changeReviewImplementPrompt,
  seedCursorSha,
  CHANGE_REVIEW_CONTEXT_BUDGET_CHARS,
  DIFF_LINE_CAP,
  DIFF_FILE_CAP,
  changeReviewGuidanceFor,
  changeReviewCompletenessQuestionFor,
  CHANGE_REVIEW_REVIEW_GUIDANCE,
  CHANGE_REVIEW_COMPLETENESS_QUESTION,
  unitsOf,
  unitForFinding,
  CHANGE_REVIEW_BATCH_MAX_UNITS,
  CHANGE_REVIEW_BATCH_UNIT_MAX_CHARS,
  CHANGE_REVIEW_BATCH_COMBINED_MAX_CHARS,
};
