# The decompose cycle in agent-manager-hygiene (function, file, repo)

Status: plan / ownership decision · 2026-09-21 (Grimmethy) · Full plan and sequence: `agent-manager/Docs/hub-tasks-extraction-plan.md`.
Companions: `docs/HUB_TASKS.md` (what this plugin takes part in today), `agent-manager/Docs/hub-tasks-extraction-map.md` (the hub machinery).

## The decision

Shrinking bloated code is **one cycle at three scales**, and **all of it belongs in this plugin**:

| Scale | Detect | Plan | Produce | Today |
|---|---|---|---|---|
| function | `function-length-scan` / `function_length_review` | the candidate (`### AC-N`, `Files`, `Solution`) | `function_length_fix` diff | **already here** |
| file | `file-length-scan` (advisory `queue/file-length-flags.json`) | a request in `queue/file-decompose-requests/<slug>.json` (human, or auto-authored) | a hub of "move these symbols verbatim" pieces + a wiring piece | **split**: detection here, everything after in agent-manager core |
| repo | new: a size/cohesion scan over a repo or directory, reading the community graph `arch_discovery` already uses (`python/build_graph.py`) | a request naming the subsystem, its destination repo and its seams | a hub of PR-sized pieces | **does not exist** (the process was hand-walked once, for the hub-tasks extraction) |

The current file-level split across two repos is the problem this fixes: moving it **entirely** here means the same detect -> plan -> produce shape
at every scale, owned in one place.

## What moves here from agent-manager core (file level)

`file-decompose-to-hub`, the deterministic builders (`script-extract`, `decompose-flask-blueprint`, `decompose-node-module`,
`decompose-one-pass`, `wire-decomposed-blueprints`), `decompose-loop-autoroute`, `proactive-file-decompose-sweep`,
`decompose-move-determinism-backfill`. The hub kernel itself (coordinator, ordering, stacked chain, integration gate) does **not** move here;
it goes to `agent-manager-hub-tasks`.

## Constraints

1. **Dependency direction stays one-way (plugin -> core).** Producers here must not import hub-tasks code. Proposal: a **core-owned hub-intake
   hook** that hub-tasks implements and this plugin calls; with hub-tasks absent this plugin degrades to advisory flags. (Open, not built.)
2. **Mechanical-move verification is the producer's job.** The kernel's `decompose-auto-merge` / integration gate need a producer-supplied
   `verifyMove` hook once the builders live here. (Open, not built.)
3. **Repo-level is outward-facing.** It creates new repos (remote, history, plugin registration). Plan and pieces can be automated; **creating the
   remote and registering it needs an explicit human gate.** The pipeline cannot push or merge itself and must not gain that quietly.
4. Order of work: the core hooks (S1-S3 in the plan) come first, then this move, then the repo-level source.
