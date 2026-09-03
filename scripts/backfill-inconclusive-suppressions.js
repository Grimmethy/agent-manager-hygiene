'use strict';

// One-shot backfill for the inconclusive-review suppression path (suppression-store.js's
// recordInconclusiveReview, added 2026-09-03).
//
// Without this, the new ledger converges only as fresh reviews complete -- MAX_INCONCLUSIVE
// _REVIEW_ATTEMPTS more no-op tasks per construct (~3 x 185 backlog flags) before the churn
// stops. The pipeline has ALREADY run hundreds of these reviews; every completed _review
// task in queue/done/ retains its promptContext.snippet and implementResponse, which is
// exactly what recordInconclusiveReview needs. Replaying them in chronological order
// rebuilds the attempt counts deterministically and promotes anything already past the cap.
//
//   node scripts/backfill-inconclusive-suppressions.js                 # dry run (default)
//   node scripts/backfill-inconclusive-suppressions.js --apply         # write for real
//   node scripts/backfill-inconclusive-suppressions.js --all-projects  # don't filter by project
//   node scripts/backfill-inconclusive-suppressions.js --project foo   # add a project slug (repeatable)
//
// By default only the CURRENT project's reviews are replayed (its repo basename, plus
// "<basename>-apply-target" -- the pipeline's own worktree slug). The long tail of retired
// external-repo scanning (pre-2026-08-20 redirect) can't churn any live backlog, so
// seeding attempt rows for it would just be noise that ages out in 45 days anyway.
//
// Idempotent: recordInconclusiveReview no-ops on an already-suppressed key, so re-running
// only picks up reviews that completed since the last run.

const fs = require('fs');
const os = require('os');
const path = require('path');

const { getConfig } = require('agent-manager/src/config.js');
const store = require('../src/suppression-store.js');

const REVIEW_SOURCES = new Set(['observability_review', 'performance_review', 'function_length_review']);
const APPLY = process.argv.includes('--apply');
const ALL_PROJECTS = process.argv.includes('--all-projects');

function wantedProjects() {
  if (ALL_PROJECTS) return null; // no filter
  const base = path.basename(getConfig().repoRoot || '');
  const set = new Set(base ? [base, `${base}-apply-target`] : []);
  for (let i = 0; i < process.argv.length - 1; i += 1) {
    if (process.argv[i] === '--project') set.add(process.argv[i + 1]);
  }
  return set;
}

function doneDirs(pipelineDir) {
  const root = path.join(pipelineDir, 'queue', 'done');
  const dirs = [root, path.join(root, '_archived_no_action')];
  const archived = path.join(root, '_archived');
  try {
    for (const e of fs.readdirSync(archived, { withFileTypes: true })) {
      if (e.isDirectory()) dirs.push(path.join(archived, e.name));
    }
  } catch { /* no _archived bucket */ }
  return dirs.filter((d) => fs.existsSync(d));
}

function loadReviewTasks(pipelineDir, projects) {
  const out = [];
  for (const dir of doneDirs(pipelineDir)) {
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.json')) continue;
      let t;
      try { t = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')); } catch { continue; }
      if (!t || !REVIEW_SOURCES.has(t.source)) continue;
      if (projects && !projects.has((t.promptContext || {}).projectSlug)) continue;
      const at = t.reviewedAt || t.mergedAt || t.claimedAt || t.createdAt || null;
      out.push({ id: t.id, source: t.source, promptContext: t.promptContext, implementResponse: t.implementResponse, at });
    }
  }
  out.sort((a, b) => new Date(a.at || 0) - new Date(b.at || 0));
  return out;
}

function main() {
  const realPipelineDir = getConfig().pipelineDir;
  const projects = wantedProjects();
  const tasks = loadReviewTasks(realPipelineDir, projects);
  console.log(`projects: ${projects ? [...projects].join(', ') : '(all)'}`);
  console.log(`found ${tasks.length} completed _review tasks in queue/done/`);

  // Dry run works in a scratch copy so the live ledgers are never touched.
  let pipelineDir = realPipelineDir;
  if (!APPLY) {
    pipelineDir = fs.mkdtempSync(path.join(os.tmpdir(), 'backfill-suppress-'));
    for (const f of ['scanner-suppressions.json', 'scanner-review-attempts.json']) {
      try { fs.copyFileSync(path.join(realPipelineDir, f), path.join(pipelineDir, f)); } catch { /* absent */ }
    }
  }

  const before = store.readRows(pipelineDir).length;
  const tally = { promoted: 0, bumped: 0, candidate: 0, falsePositive: 0, noSnippet: 0, alreadySuppressed: 0 };
  const promotedRows = [];

  for (const t of tasks) {
    const fp = /false[\s-]*positive/i.test(t.implementResponse || '');
    const r = store.recordInconclusiveReview({
      implementResponse: t.implementResponse,
      task: { id: t.id, promptContext: t.promptContext },
      pipelineDir,
      at: t.at || undefined,
    });
    if (r === null) {
      if (fp) tally.falsePositive += 1;
      else if (!t.promptContext || !t.promptContext.snippet) tally.noSnippet += 1;
      else tally.candidate += 1;
      continue;
    }
    if (r.alreadySuppressed) { tally.alreadySuppressed += 1; continue; }
    if (r.promoted) { tally.promoted += 1; promotedRows.push({ id: t.id, rule: t.promptContext.rule, file: t.promptContext.file }); }
    else tally.bumped += 1;
  }

  const after = store.readRows(pipelineDir).length;
  console.log('\noutcome tally:', JSON.stringify(tally, null, 2));
  console.log(`suppression rows: ${before} -> ${after}  (+${after - before})`);
  console.log(`open attempt rows (below cap): ${store.readAttemptRows(pipelineDir).length}`);
  if (promotedRows.length) {
    console.log('\npromoted to suppression:');
    for (const p of promotedRows) console.log(`  ${p.rule}  ${p.file || '(repo-wide)'}  <- ${p.id}`);
  }

  if (!APPLY) {
    fs.rmSync(pipelineDir, { recursive: true, force: true });
    console.log('\n(dry run -- re-run with --apply to write)');
  } else {
    console.log('\nwritten.');
  }
}

main();
