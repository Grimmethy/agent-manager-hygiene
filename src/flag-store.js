'use strict';

// Shared flags-file reconciliation for the deterministic maintenance sources
// (function_length_review / observability_review / performance_review). Each keeps a
// persistent queue/<rule>-flags.json backlog: a rescan every RESCAN_INTERVAL_MS appends
// newly-detected findings, and a human works the backlog down one review task at a time.
//
// The bug this fixes (found 2026-08-29 via three real stale function_length_review tasks,
// one of them for a function that had been moved to THIS very plugin two days earlier):
// the old prune only dropped a flag when its FILE no longer existed. It never dropped a
// flag when the flagged construct itself was gone while the file remained -- a function
// decomposed below threshold, deleted, moved to another file, moved to another repo (a
// plugin extraction), or just SHIFTED line numbers (a rescan re-flags it at its new line,
// and the old line's flag lingers forever because src/<file> still exists). The flags
// file filled with un-prunable false findings -- each still spawning one doomed review
// task via taskIdExistsInQueue's first miss -- and the same logical function ended up
// represented three times at three stale line numbers. Exactly the "a persistent flags
// file can outlive the bug it was flagging" failure agent-manager's own
// task-sources.js already warns about for its non-persistent audit sources.
//
// Fix: treat a SUCCESSFUL fresh scan as ground truth for the project it scanned. Keep an
// existing flag for that project only if the fresh scan still reports that exact
// rule::file::line; then append fresh findings not already present. A surviving flag
// keeps its ORIGINAL object (and thus its scannedAt, i.e. its place in the FIFO line the
// caller forms by sorting on scannedAt). Flags for OTHER projects are never touched --
// one scan looked at one repoRoot and cannot speak to any other (the old code dropped
// every other project's flags outright on each run: a latent multi-project data-loss bug
// fixed here in passing). If the scan THREW, fall back to the old file-exists-only prune
// (still scoped to this project) so a transient scan error can't wipe the live backlog.

const fs = require('fs');
const path = require('path');

function flagKey(f) {
  return `${f.rule}::${f.file}::${f.line}`;
}

// { flags, freshFindings, scanOk, projectTag, repoRoot } -> { flags, changed }.
// `flags`   : the reconciled array the caller should persist and then read tasks from.
// `changed` : whether it differs from the input, so the caller only rewrites the file
//             when there's a real change (a prune of N plus an append of N is still a
//             change even though the length is unmoved -- a length check would miss it).
function reconcileFlags({ flags, freshFindings, scanOk, projectTag, repoRoot }) {
  const before = JSON.stringify(flags);
  const fresh = Array.isArray(freshFindings) ? freshFindings : [];

  let kept;
  if (scanOk) {
    const freshKeys = new Set(fresh.map(flagKey));
    kept = flags.filter((f) => f.projectSlug !== projectTag || freshKeys.has(flagKey(f)));
  } else {
    kept = flags.filter((f) => f.projectSlug !== projectTag
      || !f.file
      || fs.existsSync(path.join(repoRoot, f.file)));
  }

  const keptKeys = new Set(kept.map(flagKey));
  for (const finding of fresh) {
    const key = flagKey(finding);
    if (keptKeys.has(key)) continue;
    kept.push(finding);
    keptKeys.add(key);
  }

  return { flags: kept, changed: JSON.stringify(kept) !== before };
}

module.exports = { reconcileFlags, flagKey };
