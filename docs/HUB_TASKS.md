# Hub tasks in agent-manager-hygiene: shape and extraction map

Status: reference (brain dump) · Written 2026-09-20 from a code read of `master` at the commit below · Companion:
`agent-manager/Docs/hub-tasks-extraction-map.md` (the machinery; read that first for the record shapes and lifecycle).

**Why this exists.** Hub tasks (a task too big for one pass, replaced by a coordinator plus pieces) are now part of both repos. The
plan is to pull the hub system out of both without losing a working part. **This plugin contains no hub code.** It takes part in
hubs through five things: registration flags on its task sources, the candidate-doc format, the split JSON its prompts request,
the oversized-file flags it writes, and one queue-state classification. Those five are the whole surface an extraction has to keep
working from this side.

---

## 1. Which plugin tasks can become, or feed, a hub

The tasks that reach a hub are the **candidate-fulfillment** ones: a `### AC-N` candidate in a `Docs/*_CANDIDATES.md` is turned into a
fix task `<source-with-dashes>-ac-n` (e.g. `function-length-fix-ac-2`), and if its implement pass judges the change too big for one
pass it answers `{"mode":"split", ...}` instead of a diff.

| Source | `candidateFulfillment` | `noCandidateSplit` | other split-relevant | Implement prompt offers split via |
|---|---|---|---|---|
| `function_length_fix` | yes | **yes** | | its own prompt imports core's `candidateSplitInstructions` unconditionally |
| `observability_fix` | yes | | | its own prompt imports `candidateSplitInstructions` |
| `performance_fix` | yes | | | its own prompt imports `candidateSplitInstructions` |
| `arch_review` | yes | | | core `archReviewImplementPrompt` |
| `arch_import_review` | yes | | `premiseCheck` (runs right before a split is honored) | core `archReviewImplementPrompt` |
| `change_review_fix` | yes | **yes** | | core `archReviewImplementPrompt` (offered to it since core PR #392) |
| generators/reviewers (`*_review`, `arch_discovery`, `arch_import`, `change_review`, `unused_export`) | no | | | never split |

What happens to a split, by case (implemented in agent-manager `local-draft.js` `finalizeCandidateFulfillment`):
* normal source, Split-Depth 0 -> **doc split**: sub-candidates are written back into the same candidate doc (`candidatesPath` +
  `candidateDocTitle` on the registration) as `Split-Depth: 1` with `Depends-On:` between them. No hub.
* `noCandidateSplit` source, or any sub-candidate already at Split-Depth >= 1 -> **hub route** (agent-manager PR #391): the fix task
  becomes a coordinator; each piece is an adhoc task chained after the previous on one stacked branch.
  Until 2026-09-20 this case blocked "for a human to narrow the fix" (PF `function-length-fix-ac-2`, `arch-review-ac-6`).
* the `mustPreSplit` gate (core, `nextCandidateFulfillmentTask`: a candidate spanning 2+ files) forces a doc split.

## 2. The five things the plugin owns that the hub system depends on

1. **Registration flags** (in `register()` of `src/function-length-review.js`, `observability-review.js`, `performance-review.js`,
   `arch.js`, `change-review.js`): `candidateFulfillment`, `noCandidateSplit`, `candidatesPath`, `candidateDocTitle`, `premiseCheck`,
   `emptyApproval`. `noCandidateSplit` exists because a doc split of an already-decomposed candidate looped (function-length
   AC-15 -> AC-15a/b, 2026-09-01); the hub route is what makes offering a split safe again.
2. **Candidate-doc format** (parsed by core `candidate-docs.js`, `sdk/lib/candidate-lifecycle.js`): `### AC-N · title`, `Strength`,
   `Files`, `Split-Depth`, `Depends-On: AC-M`, `Snippet:` fenced block, `Problem:` / `Solution:` / `Benefits:`.
   Size guard (core): the **authored text**, excluding the harness-added `Snippet:` block, must be <= 4000 chars or the candidate is
   never picked up (agent-manager PR #390). A candidate whose *authored* text is still too big is what the hub route now handles.
3. **The split JSON** requested by the prompts: `{"mode":"split","candidates":[{title, files, problem, solution, benefits, dependsOn}]}`,
   >= 2 pieces covering the whole scope. Core parses it (`parseCandidateSplit`) and, on the hub route, converts it
   (`candidateSplitToSubTasks`). The plugin's prompts must keep emitting exactly this shape.
4. **Oversized-file flags -> file-decompose hubs.** `src/file-length-scan.js` writes `queue/file-length-flags.json` (advisory: a
   "file too long, author a decomposition plan in `queue/file-decompose-requests/`" message per file). Nothing in the plugin consumes
   it; core's `file-decompose-to-hub.js` / `proactive-file-decompose-sweep.js` / `decompose-loop-autoroute.js` do. **This is the only
   plugin-produced input to the file-decompose hub family.** The Hygiene tab shows these under "File length (advisory)".
5. **Queue-state classification.** `src/flag-inventory.js` treats `coordinating` as **in flight** (not "needs a human"): a flag whose
   fix task is a coordinating hub counts as `queued`. `hygieneFamily` declarations (`src/hygiene-family.js`) decide which family a
   hub's parent task is counted under, by task-id prefix (`function-length-`, `arch-`, `observability-`, ...).

## 3. Shape of a hub-bound plugin task, end to end

```
flag (queue/<rule>-flags.json)  -> *_review task -> candidate in Docs/<X>_CANDIDATES.md   [plugin]
candidate -> fix task <source>-ac-N (candidateFulfillment)                                 [core reads the doc; plugin prompts]
fix task implement pass emits {"mode":"split"} (too big)                                   [plugin/core prompt asks for it]
   -> task.candidateSplitProposals + candidateSplitRoute:'hub'                             [core local-draft.js]
   -> review (split-coverage) -> apply: applyCandidateSplitAsHub                           [core]
   -> fix task moves to queue/coordinating/ (status 'coordinating'), pieces in queue/adhoc/ [core]
   -> pieces are ordinary adhoc tasks: promptContext.decomposedFrom = '<fix-task-id>'      [core]
```
Nothing on the piece records the candidate id except that `decomposedFrom` link and the `Part i of n ... <candidateId> -- <title>`
line in `rawText`. **Open question for extraction:** the candidate-doc entry itself is not updated when its fix task becomes a hub, so
the link candidate -> hub is only `taskId = <source>-ac-N` plus `decomposedFrom`. What the parent's terminal disposition becomes when
the last piece merges has not been observed yet (first live run: `function-length-fix-ac-2`).

## 4. Extraction guidance

* **Nothing to move out of this repo for the hub kernel** - it lives in core. What must stay working from here is section 2. A clean
  extraction should turn those five items into a documented contract (`PLUGIN_API.md`) instead of implicit conventions:
  (1) a `hubRoute`/`splitPolicy` registration field replacing the paired `candidateFulfillment` + `noCandidateSplit` flags,
  (2) candidate-doc format spec, (3) the split JSON schema, (4) the file-decompose request/flag file schemas, (5) a queue-state
  vocabulary the inventory can import instead of hardcoding `IN_FLIGHT` / `NEEDS_HUMAN`.
* **Risks specific to this side.** (a) `function_length_fix`, `observability_fix` and `performance_fix` each carry their own implement prompt that must keep including core's `candidateSplitInstructions`; a rewrite that drops it silently removes the hub route for that source. (b) The candidate size
  guard counts authored text only; a plugin that starts writing long authored bodies re-creates the "never picked up, silent" failure.
  (c) `function_length_review` caps the `Snippet:` at 200 lines (`SNIPPET_MAX_LINES`), so a function longer than that is shown
  truncated to the fix drafter - AC-2's plan pass even said so - which is one reason those candidates are over-scoped.
  (d) The plugin's candidate generators can still over-scope a candidate (several extractions in one Solution); the hub route is the
  safety net, not a fix for that. A "one extraction per candidate" rule in `function_length_review`'s guidance/gate has not been built.
* **Tests that pin this contract:** `src/hygiene-family.test.js` (families + the core-read flags), `src/flag-inventory.test.js`
  (`coordinating` is in flight), `src/register.test.js`, and core's `candidate-split-hub.test.js` / `local-draft.test.js` for the
  routing itself.
