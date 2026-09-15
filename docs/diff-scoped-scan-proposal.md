# Diff-scoped scanning for the deterministic hygiene scanners (proposal)

**Status as of 2026-09-13: steps 1-2 built and tested, step 3 (the live trigger) not
built.** `scan-utils.js` now has `changedLineRanges()` / `isFindingInChangedRanges()`, and
`observability-scan.js` / `performance-scan.js` / `function-length-scan.js`'s
`scanProject()` all take an optional, default-off `{ changedRanges }` — every existing
call site is unaffected (18 new tests cover the scoping behavior, including the
`lengthLines`-widening case; the full plugin suite is green at 301/301).
`unused-export-scan.js` deliberately has **no** `changedRanges` support: its finding
(a symbol's total call-site count) requires a whole-repo search to be correct at all — a
diff-scoped version of it would be actively wrong, not just less thorough, since a symbol
could look "low usage" purely because the scan window skipped the file that actually calls
it. Still open: **step 3**, the real trigger that calls `scanProject(..., { changedRanges:
changedLineRanges(repoRoot, range) })` after a task's diff lands and feeds the result
through the existing `reconcileFlags()` path. That's a deliberate pause point — inspecting
the scoping logic's own output on real diffs first, per the rollout gate below, before
wiring it into anything live.

Surfaced 2026-09-13 comparing this plugin against
[skylos](https://github.com/duriantaco/skylos) (added to `UsefulProjectIndex/INDEX.md` as
a Strong lead the same day) — its `--diff origin/main` changed-lines-only scan mode is the
one concrete, adoptable idea from that comparison. This doc is the spec an implementation
should match, same convention as agent-manager core's `docs/*-pipeline.md` files.

## Problem

`observability_review`, `performance_review`, `function_length_review`, and
`unused_export` are all built the same way: a deterministic scanner
(`observability-scan.js`'s `scanProject()`, etc.) walks the **entire** consumer repo via
`scan-utils.js`'s `listSourceFiles()`, and — per `observability-review.js`'s
`prepareObservabilityFlags()` — this full-tree rescan only runs when
`RESCAN_INTERVAL_MS` (24h) has elapsed since the last one. Fresh findings are reconciled
against a persistent backlog (`reconcileFlags()`) and drained FIFO by review tasks.

That 24h cadence is a deliberate, working design for what it does: catching legacy issues
and reconciling line-drift/suppression state across the whole repo without hammering it on
every tick. It is not a bug. But it means a hygiene regression a task *just introduced* —
a new silent catch block, a fresh sync-I/O-in-a-loop — can sit unflagged for up to a day,
purely because the next full-tree rescan hasn't come due yet. There is currently no way to
ask "did the change that just landed introduce a new hygiene finding," only "what does the
whole repo look like as of the last scheduled sweep."

## Why this isn't starting from zero

`change-review.js` (the `change_review` / `change_review_fix` source) already solved the
git-diff-since-a-point plumbing this needs, for a different purpose (LLM correctness
review of each merged commit): a small, tested `git()` wrapper
(`execFileSync` with a timeout and bounded buffer), `resolveMainBranch()`,
`enumerateUnits()` (commits since a cursor SHA), `unitDiff()`/`unitNumstat()`, and a
persisted cursor (`readCursor`/`writeCursor`/`seedCursorSha`, keyed the same way
`change-review-cursor.json` already is). None of that needs to be rebuilt — it needs a
second consumer.

## Proposed shape

**1. Extract shared diff-scope plumbing**, not duplicate it. Pull `git()`,
`resolveMainBranch()`, and a new `changedLineRanges(repoRoot, sinceSha, mainBranch)`
(wrapping `git diff --unified=0 <sinceSha>..origin/<mainBranch>` and parsing `@@ -a,b +c,d
@@` hunk headers into `{ file: [[startLine, endLine], ...] }`) into `scan-utils.js`
alongside the other rule-agnostic helpers already there (`listSourceFiles`,
`extractBraceBody`, ...). `change-review.js` keeps its own `git()` for now to avoid
churning a working module; a follow-up can point it at the shared one once this lands.

**2. Extend each scanner's entry point with an optional scope**, default-off:

```js
// observability-scan.js
function scanProject(clonePath, projectSlug, { changedRanges } = {}) {
  const allFiles = changedRanges
    ? [...changedRanges.keys()].map((f) => path.join(clonePath, f))
    : listSourceFiles(clonePath, SCAN_EXTENSIONS);
  // ...existing per-file rule logic, unchanged...
  // when changedRanges is set, a finding is kept only if its line falls inside
  // one of that file's changed ranges.
}
```

Same shape for `performance-scan.js`, `function-length-scan.js`, `unused-export-scan.js`.
When `changedRanges` is omitted (every existing call site), behavior is byte-for-byte
identical to today — the 24h full-tree rescan, `reconcileFlags()`, and the suppression
store are completely untouched. This is additive, not a replacement for the existing
cadence, which still needs to run for legacy-code coverage and line-drift reconciliation.

**3. New trigger: a fast, narrow scan right after a task's own diff lands**, wired into
the same place `apply-task.js` already commits a task's change (or a new lightweight
watchdog sweep keyed off its own cursor, mirroring `change_review`'s
`change-review-cursor.json`). Findings from this narrow scan feed through the **exact
same** `reconcileFlags()` call the periodic scan already uses — not a parallel data path —
so there is only ever one source of truth for what's in the backlog, and no double-
counting risk between "caught immediately" and "caught by the next 24h sweep."

**4. What this buys**: a hygiene regression introduced by task X can surface within
minutes of that task landing, scoped tightly enough (only the lines X touched) that it
reads as "this task's own fix introduced a new problem" rather than "here's an unrelated
finding from somewhere else in the repo" — a materially different, more actionable signal
than today's batched 24h sweep produces.

## What this deliberately does not do

- Does not replace the 24h full-tree rescan or its suppression/reconcile logic.
- Does not attempt skylos's multi-language AST parsing, security/secrets/CVE categories,
  or its "AI-code trust" (`verify`/`defend`) layer — those are separate, larger asks
  covered in the INDEX.md write-up, not this proposal's scope.
- Does not change scan *rules* at all, only scan *scope* — zero risk to existing
  detection logic or its accuracy.

## Rollout gate

Same convention as `arch_discovery`'s and `project_search`'s own rollout notes: land the
shared diff-scope helper and the optional `changedRanges` parameter first (inert, opt-in,
covered by unit tests against fixed diffs), inspect real output on one scanner
(`observability_review` is the best first target — it already has the most mature
false-positive tooling via `classifyCatchConfidence()`/the suppression store to catch a bad
finding before it reaches a human) before wiring in the actual post-apply trigger.
