# Triage gate replay, 2026-10-21

Produced by `scripts/triage-replay.js` on lane worker-rx580 (qwen3-vl:8b-instruct, numCtx 12288, numBatch 512), replaying the parent source's recorded tasks from the agent-manager project (`queue/done`) through the gate's own prompts. Nothing was written to a queue. 'unsafe' = a recorded POSITIVE (the pipeline acted on it) that the gate called false_positive. 'filtered' = a recorded noop/dismissal the gate called false_positive.

| parent source | recorded positives | unsafe | recorded noops/dismissals | filtered | invalid JSON | errors | p50 | p95 |
|---|---|---|---|---|---|---|---|---|
| performance_review | 14 | 0 | 26 | 3 | 0 | 0 | 4.0 s | 5.0 s |
| observability_review | 8 | 0 | 32 | 22 | 0 | 0 | 3.7 s | 4.9 s |

Verdict counts: performance_review {"real": 31, "uncertain": 6, "false_positive": 3}; observability_review {"real": 18, "false_positive": 22}.

The recorded positives (14 and 8) are below the 30-replay promotion gate in docs/design-notes/task-atomization-plugin.md (agent-manager repo), so the gate is NOT promoted; it ships in shadow mode.

## Sample of false_positive reasons (for the human read)

**performance_review**

- (noop) The loop iterates over a small, bounded set of subtasks and directories, and the fs operations are likely synchronous but not blocking the event loop in practice due to minimal scope.
- (noop) The loop iterates over a small, fixed set of failed suites and does not run synchronously in a way that blocks the event loop repeatedly.
- (dismissed) The loop iterates over lanes, but no await is present in the shown code; the scanner likely misinterpreted the context.

**observability_review**

- (noop) The catch block logs the error message to the DOM, which surfaces the error to the user.
- (dismissed) The catch block logs the error message to the UI, which surfaces the error to the user.
- (noop) The exception is logged as a text/event-stream message and the response is still returned, so it's not silently ignored.
- (dismissed) The loop is intentionally unguarded to avoid interfering with user interactions, and the 5s interval is a deliberate design choice with no heartbeat signal needed.
- (noop) The loop is intentionally unguarded to avoid interfering with user interactions, and the 5s interval is a deliberate design choice.
- (noop) The except block explicitly re-raises the exception by aborting with a 500 status and a descriptive message, which surfaces the error as required.
