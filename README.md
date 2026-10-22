# agent-manager-hygiene

Programming-hygiene task sources for the [agent-manager](../agent-manager) pipeline,
loaded out-of-tree via `AGENT_MANAGER_REGISTER_PATH`.

These sources review the **code quality of the consumer repo** the pipeline operates on —
they are separate from the pipeline platform itself (queue, dashboard UI, hardware
tracking, worker management), which stays in `agent-manager`.

## Sources

| Source | Stage | What it does |
|---|---|---|
| `function_length_review` / `function_length_fix` | review → fix | flags over-long functions, judges genuine vs. false positive, turns a vetted candidate into a decomposition diff |
| `observability_review` / `observability_fix` | review → fix | silent catch blocks, unguarded loops, OpenTelemetry naming/attribute gaps |
| `performance_review` / `performance_fix` | review → fix | sync I/O in loops, sequential awaits, `JSON.parse(JSON.stringify(...))` deep-clone antipattern |
| `arch_discovery` → `arch_review` | generate → fulfill | community-graph-driven architecture candidates, then turned into diffs |
| `arch_import` → `arch_import_review` | generate → fulfill | promote a deep-dive finding from an external repo into an architecture candidate |
| `unused_export` | triage | low-usage exported CommonJS symbols (majority-vote genuine-dead vs. false-positive) |

`arch_review` / `arch_import_review` are consumers of agent-manager's own
`nextCandidateFulfillmentTask` (which stays in core — `backlog_fulfillment` uses it too).
The `community-coverage.json` / graph inputs `arch_discovery` reads are produced by
agent-manager's `python/build_graph.py` and consumed here read-only.

## How it loads

`agent-manager`'s `src/config.js` `ensureRegistered()` `require()`s the path in
`AGENT_MANAGER_REGISTER_PATH` once, for its side effect. Point it at this repo's
`register.js`:

```sh
AGENT_MANAGER_REGISTER_PATH=/media/model-cache/github/agent-manager-hygiene/register.js
```

(Comma-separated if you load more than one plugin.)

`register.js` pulls the injected-deps bag (`getConfig`, `nextCandidateFulfillmentTask`,
`taskIdExistsInQueue`, `taskPriority`) from the `agent-manager` package and calls each
module's `register(deps)`.

## Dependency on `agent-manager`

`package.json` declares `"agent-manager": "file:../agent-manager"`. This **must** install
as a symlink (npm ≥5 default) so `require('agent-manager/src/task-source-registry.js')`
resolves, via realpath, to the exact checkout the pipeline runs from — otherwise this
plugin would populate a second, private registry object and its sources would never fire.
`src/register.test.js` guards both the symlink and the registration. Never run Node with
`--preserve-symlinks`.

The dependency direction is one-way: this plugin imports from `agent-manager/src/*`; core
never imports back. The deterministic scanner modules (`src/{observability,performance,
function-length}-scan.js` + `src/scan-utils.js`) live here as of ADR-0022 Stage C; core's
`staleness-fastpath.js` re-runs their rules for the deterministic staleness recheck via
the `registerDeterministicRecheck` seam (`src/deterministic-recheck.js`), holding no
detector code and no source names of its own.

**`agent-manager/docs/PLUGIN_API.md` is the contract** for exactly which core exports this
plugin may depend on. Core's `src/plugin-api.test.js` fails if one is removed. If this
plugin needs to reach for something not on that list, add it there first — never a private
internal.

## Plugin-owned config

`function-length-review.js` reads these directly from the environment (no `config.js` key):

- `AGENT_MANAGER_FUNCTION_LENGTH_CANDIDATES_PATH` (default `<repoRoot>/Docs/FUNCTION_LENGTH_CANDIDATES.md`)
- `AGENT_MANAGER_FUNCTION_LENGTH_COVERAGE_PATH` (default `<pipelineDir>/function-length-coverage.json`)
- `AGENT_MANAGER_MAX_FUNCTION_LINES` (default 100)

`observability_*` / `performance_*` use `config.js`'s existing
`observabilityFixCandidatesPath` / `observabilityCoveragePath` /
`performanceFixCandidatesPath` / `performanceCoveragePath` keys.

`suppression-store.js` (shared by all three `*_review` sources):

- `SCANNER_REVIEW_MAX_INCONCLUSIVE_ATTEMPTS` (default 3) — after this many completed
  reviews of one construct that each reach a verdict but produce no candidate, it is
  promoted to a `scanner-suppressions.json` row (`cause: "unproducible"`) so the scanner
  stops re-flagging it. The ledgers (`scanner-suppressions.json`,
  `scanner-review-attempts.json`) sit at `<pipelineDir>/` and MUST be gitignored when
  `pipelineDir == repoRoot` — `git-runner.js`'s `stash -u` before `resetToMain()` evicts
  them otherwise (agent-manager `d0be33b5`).
  Backfill an existing pipeline's ledger from `queue/done/` history with
  `node scripts/backfill-inconclusive-suppressions.js --apply`.

## Triage gate (`performance_triage`, `observability_triage`)

Narrow-verdict variants (`variantOf` their parents) for small GPUs, from the task-atomization design note. One closed question per finding,
answered as strict JSON `{verdict: real|false_positive|uncertain, reason}`; the gate can only remove work. `real` / `uncertain` write nothing, so the
parent source still reviews the finding on a big lane. The parent defers to a fresh in-flight triage task for 30 min (`AGENT_MANAGER_TRIAGE_DEFER_SECS`)
and then reviews anyway, so nothing strands.

`AGENT_MANAGER_TRIAGE_GATE`: `shadow` (default; the verdict is recorded on the task as `triageVerdict`, no suppression is written), `enforce` (a
`false_positive` verdict writes a suppression with cause `triage-gate`), `off` (no triage tasks, no deferral).

Measured 2026-10-21 (full table and a sample of reasons: `docs/TRIAGE_REPLAY_2026-10-21.md`), `scripts/triage-replay.js` on worker-rx580 (qwen3-vl:8b, numCtx 12288, numBatch 512), 40 recorded tasks per parent, about 4 s per task:
performance_review 0 of 14 recorded positives called false positive, 3 of 26 recorded noops/dismissals filtered; observability_review 0 of 8 positives,
22 of 32 filtered. The positive counts are below the design note's 30-replay gate, so the gate has NOT been promoted.

Promotion (operator steps, in order; nothing here is done automatically):
1. Replay again when the project has more recorded positives (`node scripts/triage-replay.js <performance_review|observability_review> --lane worker-rx580`; use `AGENT_MANAGER_LANES_PATH` for a scratch lanes file). Require 0 unsafe over at least 30 positives, then read a sample of the filtered reasons.
2. Let shadow mode run on the live lane and compare `triageVerdict` with what the parent concludes for the same finding.
3. Add `performance_triage` and `observability_triage` to the rx580 entry's `taskClasses` in the live `lanes.json` and set that entry's `"reserve": "always"` so big lanes defer to it once capability routing is `enforce`. Then set `AGENT_MANAGER_TRIAGE_GATE=enforce`.
4. To undo a wrong suppression, delete its row (cause `triage-gate`) from `<pipelineDir>/scanner-suppressions.json`.

## Tests

```sh
npm install   # creates the node_modules/agent-manager symlink
npm test
```

## History

Extracted from `agent-manager` on 2026-08-27. `src/maintenance/*` in that repo had been
built as a proto-plugin since 2026-08-23 ("intent to further separate it into a fully
separate npm later"); this repo is that separation.
