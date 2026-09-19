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

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { registerTaskSource, updateTaskSource } = require('agent-manager/src/task-source-registry.js');
const { applyArchDiscoveryCandidates, isEffectivelyEmptyResponse } = require('agent-manager/src/candidate-docs.js');
const { writeJsonAtomicSync } = require('agent-manager/src/atomic-write.js');
const { archReviewPlanPrompt, archReviewImplementPrompt } = require('agent-manager/src/prompts.js');
const { detectDefaultBranch } = require('agent-manager/src/git-runner.js');

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
  for (const sha of units) {
    const id = `change-review-${sha.slice(0, 7)}`;
    if (taskIdExistsInQueue(id)) {
      writeCursor(changeReviewCursorPath, sha);
      continue;
    }
    const meta = unitMetadata(repoRoot, sha);
    const nameStatus = unitNameStatus(repoRoot, sha);
    const kind = classifyUnit(nameStatus);
    if (kind !== 'reviewable') {
      recordSkip(pipelineDir, meta, kind, null);
      writeCursor(changeReviewCursorPath, sha);
      continue;
    }
    const stats = unitNumstat(repoRoot, sha);
    if (stats.changedLines > DIFF_LINE_CAP || stats.files > DIFF_FILE_CAP) {
      recordSkip(pipelineDir, meta, 'too-large', stats);
      writeCursor(changeReviewCursorPath, sha);
      continue;
    }
    const diffText = unitDiff(repoRoot, sha);
    if (!diffText.trim()) {
      // Empty first-parent delta (e.g. a merge that changed nothing) -- nothing to review.
      recordSkip(pipelineDir, meta, 'empty-diff', stats);
      writeCursor(changeReviewCursorPath, sha);
      continue;
    }
    // Found a reviewable unit whose task is NOT yet queued -- return it WITHOUT advancing
    // the cursor (tier-filter-discard safety).
    return {
      id,
      domain: defaultDomain,
      source: 'change_review',
      title: `Change review: ${meta.sha7} ${meta.subject}`.slice(0, 140),
      promptContext: buildPromptContext(repoRoot, meta, nameStatus, diffText, mainBranch),
    };
  }
  return null;
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

function changeReviewPlanPrompt(task) {
  const ctx = task.promptContext || {};
  return [
    `You are triaging the diff of ONE change already merged to ${ctx.mainBranch || 'the main branch'}, looking ONLY for CORRECTNESS REGRESSIONS this diff introduced -- behaviour that was right before and is wrong after.`,
    '',
    `COMMIT: ${ctx.sha} ${ctx.subject}  (author ${ctx.author}, ${ctx.dateISO})`,
    'Changed files:',
    (ctx.files || []).join('\n'),
    '',
    'DIFF (unified, first-parent delta):',
    ctx.unitDiff || '(no diff)',
    '',
    'Small touched files, full content, for context:',
    renderSmallFiles(ctx),
    '',
    'PART 1 -- write a numbered PLAN that walks EVERY changed hunk and, for each, states one of:',
    '  - "hunk N (<file>): no correctness change" + a one-clause reason, OR',
    '  - "hunk N (<file>): SUSPECT -- <what could now be wrong>"',
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
    'this diff CHANGED, emit one line to find its callers elsewhere in the repo:',
    'QUERY: <the symbol name>',
    '(Emit nothing here if the diff changed no public symbol.)',
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
  return [
    'CONTEXT: you already triaged this merged change hunk-by-hunk:',
    planText || '(no plan)',
    '',
    `COMMIT: ${ctx.sha} ${ctx.subject}`,
    'DIFF:',
    ctx.unitDiff || '(no diff)',
    renderSmallFiles(ctx),
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
    '    -- use this if, after walking every hunk, there is no regression you can demonstrate',
    '      with a concrete input. Common and fully acceptable.',
    '',
    '(B) one or more findings, each EXACTLY this block, blank-line separated, NOTHING else:',
    '',
    'FINDING',
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
    'files, and the caller hits. Cite the hunk.',
  ].join('\n');
}

// --- apply ---------------------------------------------------------------------

const FIELD_RES = {
  file: /^File:\s*(.+)$/im,
  line: /^Line:\s*(.+)$/im,
  severity: /^Severity:\s*(.+)$/im,
  regression: /^Regression:\s*(.+)$/im,
  failure: /^Failure scenario:\s*([\s\S]+?)(?=\n(?:Fix sketch:|Severity:|Regression:|File:|Line:)|\n{2,}|$)/im,
  fix: /^Fix sketch:\s*([\s\S]+?)(?=\n{2,}|$)/im,
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

function buildAcBlock(finding, ctx) {
  const sha7 = ctx.sha || '';
  const base = finding.file.split('/').pop();
  const title = `${finding.regression.replace(/\s+/g, ' ').slice(0, 90)} (${sha7} ${base})`;
  const snippet = hunkForFile(ctx.unitDiff, finding.file);
  // applyArchDiscoveryCandidates only preserves the canonical fields (Strength / Split-Depth
  // / Source / Files / Snippet) plus the body -- so severity and the commit go INTO the
  // Problem line where they survive to the fix stage and a human reader.
  const block = [
    `### AC-1 · ${title}`,
    'Strength: Strong',
    `Source: change_review of ${sha7} "${(ctx.subject || '').replace(/"/g, "'").slice(0, 80)}"`,
    `Files: ${finding.file}`,
    'Snippet:',
    '```',
    snippet,
    '```',
    '',
    `Problem: [severity: ${finding.severity}; regression shipped in ${sha7}] ${finding.regression}  Failure scenario: ${finding.failure.replace(/\s+/g, ' ')}`,
    `Solution: ${finding.fix || 'Restore the pre-diff behaviour for the failure scenario above (smallest change to ' + finding.file + ').'}`,
    `Benefits: Restores correct behaviour for the scenario above; undoes the regression shipped in ${sha7}.`,
  ].join('\n');
  if (block.length <= AC_BLOCK_MAX_CHARS) return block;
  // Over budget -- shrink the snippet hard.
  const shortSnippet = snippet.slice(0, Math.max(200, SNIPPET_CAP_CHARS - (block.length - AC_BLOCK_MAX_CHARS) - 40));
  return block.replace(snippet, `${shortSnippet}\n...[snippet truncated]`);
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
  const blocks = findings.map((f) => buildAcBlock(f, ctx));

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
  });
  updateTaskSource('change_review', {
    buildPlanPrompt: changeReviewPlanPrompt,
    buildImplementPrompt: changeReviewImplementPrompt,
  });

  registerTaskSource('change_review_fix', {
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
};
