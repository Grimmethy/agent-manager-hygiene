'use strict';

// flag-inventory.js -- a READ-ONLY view of a flag-based review source's backlog, for the dashboard's Hygiene tab.
//
// Why (2026-09-19): the scanners (observability / performance / function-length / unused-export) keep their
// findings in queue/<rule>-flags.json and only turn one into a task when a worker reaches it. The queue therefore
// shows the tiny slice already tasked, never the pile behind it: AM had ~520 flags not yet tasked plus 346 pending
// change_review tasks and nothing surfaced any of it. "Don't create tasks before working through what exists" is a
// sound throttle when the inventory is visible (brain dump entries); here it wasn't.
//
// This must be a PURE READ. prepare*Flags() in the review modules rescans the repo and rewrites the flags file, so
// this reads the file directly and applies only the cheap rules the review loops apply, in the same order:
//   already tasked (queue state / disposition) -> unreadable file ("stale") -> low-confidence digest batching ->
//   suppressed (exact snippet, or cluster) -> WAITING (what a worker will pick up next).
// It does NOT relocate a flag against the current file (the review does, and may then discard it as stale), so
// `waiting` can slightly overstate; the caller labels it accordingly.

const fs = require('fs');
const path = require('path');

const DEFAULT_ITEM_CAP = 500;
// A coordinating hub (a decomposed task whose pieces workers are implementing) is in flight, not waiting on a human.
const IN_FLIGHT = new Set(['pending', 'drafting', 'review', 'approved', 'coordinating']);
const NEEDS_HUMAN = new Set(['blocked', 'needs-clarification', 'awaiting-confirm']);
const STATUS_ORDER = ['waiting', 'blocked', 'queued', 'digest', 'suppressed', 'stale', 'done'];

function readIfExists(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return null; }
}

// flags: the flags-file array. idFor(flag) -> the task id the review source would give it.
// taskState(id) -> null | { state, disposition } (core's lookup: state is a queue dir name, 'done' or 'archived').
// snippetFor(flag, content) -> the code window the review would suppress-check (or null).
// isSuppressed(rule, snippet) / isClusterSuppressed(rule, dir) / isDigestBatched(flag) / isUnreviewable(content): optional.
function buildFlagInventory({
  flags, projectTag, repoRoot, idFor, taskState,
  snippetFor = null, isSuppressed = null, isClusterSuppressed = null, isDigestBatched = null, isUnreviewable = null,
  itemCap = DEFAULT_ITEM_CAP,
}) {
  const mine = (Array.isArray(flags) ? flags : []).filter((f) => f && (!f.projectSlug || f.projectSlug === projectTag));
  const fileCache = new Map();
  const contentOf = (file) => {
    if (!fileCache.has(file)) fileCache.set(file, repoRoot ? readIfExists(path.join(repoRoot, file)) : null);
    return fileCache.get(file);
  };

  const counts = { waiting: 0, queued: 0, blocked: 0, done: 0, digest: 0, suppressed: 0, stale: 0 };
  const doneByDisposition = {};
  const waitingByConfidence = {};
  let oldestWaitingAt = null;
  const items = [];

  for (const flag of mine) {
    const item = {
      rule: flag.rule || null, file: flag.file || null, line: flag.line || 0,
      confidence: flag.confidence || null, scannedAt: flag.scannedAt || null,
      detail: String(flag.detail || '').slice(0, 200),
    };
    const ts = taskState ? taskState(idFor(flag)) : null;
    let status;
    if (ts) {
      item.taskState = ts.state;
      if (ts.disposition) item.disposition = ts.disposition;
      if (IN_FLIGHT.has(ts.state)) status = 'queued';
      else if (NEEDS_HUMAN.has(ts.state)) status = 'blocked';
      else {
        status = 'done';
        const d = ts.disposition || 'unclassified';
        doneByDisposition[d] = (doneByDisposition[d] || 0) + 1;
      }
    } else {
      const content = flag.file ? contentOf(flag.file) : null;
      if (flag.file && (!content || (isUnreviewable && isUnreviewable(content)))) status = 'stale';
      else if (isDigestBatched && isDigestBatched(flag)) status = 'digest';
      else {
        const snippet = snippetFor && content ? snippetFor(flag, content) : null;
        if (isSuppressed && flag.rule && snippet && isSuppressed(flag.rule, snippet)) status = 'suppressed';
        else if (isClusterSuppressed && flag.rule && flag.file && isClusterSuppressed(flag.rule, path.dirname(flag.file))) status = 'suppressed';
        else status = 'waiting';
      }
    }
    item.status = status;
    counts[status] += 1;
    if (status === 'waiting') {
      const c = flag.confidence || 'n/a';
      waitingByConfidence[c] = (waitingByConfidence[c] || 0) + 1;
      if (flag.scannedAt && (!oldestWaitingAt || flag.scannedAt < oldestWaitingAt)) oldestWaitingAt = flag.scannedAt;
    }
    items.push(item);
  }

  // Waiting first, oldest first (that is the order workers take them); then the rest by status.
  items.sort((a, b) => (STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status))
    || String(a.scannedAt || '').localeCompare(String(b.scannedAt || '')));
  return {
    total: mine.length,
    counts,
    doneByDisposition,
    waitingByConfidence,
    oldestWaitingAt,
    items: items.slice(0, itemCap),
    truncated: items.length > itemCap,
    // What this cannot know without the review's own relocation pass (see the header).
    approximate: true,
  };
}

module.exports = { buildFlagInventory, readIfExists, IN_FLIGHT, NEEDS_HUMAN };
