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
never imports back. The pure scanner modules (`agent-manager/src/maintenance/*-scan.js`)
stay in core — `staleness-fastpath.js` re-runs their rules for the deterministic staleness
recheck — and are imported here.

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

## Tests

```sh
npm install   # creates the node_modules/agent-manager symlink
npm test
```

## History

Extracted from `agent-manager` on 2026-08-27. `src/maintenance/*` in that repo had been
built as a proto-plugin since 2026-08-23 ("intent to further separate it into a fully
separate npm later"); this repo is that separation.
