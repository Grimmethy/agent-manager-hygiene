# Observability Fix Candidates

### AC-1 · `readdirSync` catch-all swallows permission and type errors as "no candidates"
Strength: Strong
Files: src/arch.js
Snippet:
```
  let deepDiveCoverage;
  try {
    deepDiveCoverage = JSON.parse(readIfExists(deepDiveCoveragePath) || '{"projects":{}}');
  } catch {
    deepDiveCoverage = { projects: {} };
  }
  const relevantSlugs = new Set(
```

Problem:
The `catch` block around `fs.readdirSync(deepDiveAnalysisDir, …)` is an unguarded, parameterless `catch` that returns `null` for every possible failure mode. The inline comment ("no analysis dir yet -- nothing to promote") makes the author's intent clear: the null return is meant to cover only the benign `ENOENT` case where the directory has not been created yet. However, `readdirSync` also throws `EACCES`/`EPERM` when the directory exists but the process lacks read permission, `ENOTDIR` when the path resolves to a regular file, and other I/O errors. In all of those cases the function silently returns `null`, which a caller interprets as "no promotion candidates yet." A real, actionable failure (unreadable directory, wrong path type) is indistinguishable from the legitimate empty state, and no log line, no rethrow, and no other signal is emitted. This is a textbook swallowed-error hazard: the observability gap means an operator will never see that the directory is present but unreadable, and the promotion pipeline will quietly no-op forever until the permission issue is fixed by other means.

Solution:
Replace the parameterless `catch` with a `catch (err)` that first checks `err.code === 'ENOENT'` and returns `null` only in that case (preserving the intended "directory not yet created" semantics). For every other error code, emit a `console.error` line that includes the directory path, the OS error code, and the message, then `throw err` so the calling function can decide whether to abort, retry, or surface the failure to its own caller. No new dependency is introduced; the fix uses only `console.error` and a rethrow, both of which are already available in the project. The second `catch` around `JSON.parse` (the `deepDiveCoverage` fallback to `{ projects: {} }`) is left unchanged, as falling back to an empty coverage map on a malformed or missing JSON file is a reasonable defensive default and was not the flagged issue.

Benefits:
Once applied, the only path that returns `null` from the `readdirSync` call is the genuinely benign "directory does not exist yet" case. Any real I/O failure—permission denied, path is a file, disk error—produces a log line that names the directory, the OS error code, and the message, giving an operator an immediate, greppable signal. The rethrow ensures the failure propagates to a caller that can decide whether to abort the promotion run or degrade gracefully, rather than being silently absorbed and misreported as "nothing to promote." This closes the observability gap without adding any new dependency or altering the function's public contract for the legitimate empty case.

### AC-2 · Silent JSON.parse catch swallows corrupt coverage file
Strength: Strong
Files: src/arch.js
Snippet:
```
  let coverage;
  try {
    coverage = JSON.parse(readIfExists(importCoveragePath) || '{"items":{}}');
  } catch {
    coverage = { items: {} };
  }
  if (!coverage.items) coverage.items = {};
```

Problem:
In `src/arch.js`, the block that loads the import-coverage map does `coverage = JSON.parse(readIfExists(importCoveragePath) || '{"items":{}}')` inside a `try`, and the corresponding `catch` simply assigns `coverage = { items: {} }` with no logging, rethrow, or other surfacing of the exception. The same pattern appears one block earlier for `deepDiveCoverage`. Because the fallback object is structurally identical to a legitimately empty coverage file, a truncated, hand-edited, or otherwise corrupt JSON file on disk is indistinguishable from "no coverage yet." Downstream code then iterates `entries`, mutates `coverage.items`, and writes the result back—silently discarding whatever prior coverage data the corrupt file held—while no operator-visible signal is ever emitted to explain why coverage "reset" to empty.

Solution:
Replace the bare `catch { coverage = { items: {} }; }` with a `catch (err)` that first calls `console.error` with a message naming the file path (`importCoveragePath`) and the underlying parse error (`err.message`), then assigns the same `{ items: {} }` fallback so the function's return contract is unchanged. Apply the identical treatment to the `deepDiveCoverage` catch immediately above it for consistency. No rethrow is added because the caller's contract is to continue with a default coverage map; no metrics or telemetry primitive is introduced because the project has none.

Benefits:
An operator running the build or test pipeline will see a single, identifiable stderr line (e.g. `arch: failed to parse import coverage file "…"; falling back to empty coverage. Error: Unexpected token …`) the moment a coverage file becomes corrupt, making the root cause of a silent data-loss reset immediately diagnosable instead of requiring a forensic diff of the written-back file. The fix is a two-line change per catch block, introduces no new dependency, and preserves the existing fallback behavior so no caller contract changes.

### AC-3 · Silent catch swallows coverage-file parse failure and wipes prior item history
Strength: Strong
Files: src/arch.js
Snippet:
```
  let coverage;
  try {
    coverage = JSON.parse(fs.existsSync(importCoveragePath) ? fs.readFileSync(importCoveragePath, 'utf8') : '{"items":{}}');
  } catch {
    coverage = { items: {} };
  }
  if (!coverage.items) coverage.items = {};
```

Problem:
In `applyArchImportCandidate`, the `try` block reads and `JSON.parse`s the file at `importCoveragePath`. If that file is corrupt, truncated, or otherwise unreadable (partial write, disk error, manual edit), the bare `catch` discards the exception entirely and substitutes `coverage = { items: {} }`. The very next lines then assign `coverage.items[itemId]` with fresh `promotedAt` and `candidateId` values, silently discarding any prior coverage history for that item. No `console.error`, `console.warn`, `process.stderr.write`, or rethrow appears inside the catch, so the operator receives zero signal that the coverage file was unreadable and that prior state was lost.

Solution:
Capture the exception in the catch binding and emit a `console.error` that names the function, the offending path, the `itemId`, the `sourceProject`, and the error message, before falling back to `{ items: {} }`. Concretely, change the bare `catch {` to `catch (err) {`, add a single `console.error(\`applyArchImportCandidate: failed to read/parse import coverage at ${importCoveragePath} (item ${itemId}, source ${sourceProject}); falling back to empty coverage. ${err && err.message ? err.message : err}\`)` line, and keep the existing `coverage = { items: {} }` fallback so the task can still record the real candidate. Do not rethrow — the caller's intent is best-effort coverage recording and a rethrow would abort the task over a recoverable read failure. Do not add any metric or counter; this project has no metrics system.

Benefits:
Once fixed, a corrupt or unreadable coverage file produces an immediate, identifiable stderr line that names the file path, the affected item, and the source project, so an operator can locate and repair the file before the next run silently overwrites it again. The best-effort fallback behavior is preserved (the task still records the candidate), but the silent data loss of prior `promotedAt`/`candidateId` history is no longer invisible — it is logged at the moment it happens, giving the operator a concrete, time-stamped signal to investigate.

### AC-4 · Silent JSON.parse catch blocks mask corrupt state files as "rescan everything"
Strength: Strong
Files: src/function-length-review.js
Snippet:
```
  let coverage;
  try { coverage = JSON.parse(readIfExists(coveragePath) || '{}'); } catch { coverage = {}; }
  let flags;
  try { flags = JSON.parse(readIfExists(flagsPath) || '[]'); } catch { flags = []; }

  const now = Date.now();
  const lastScannedAt = coverage.lastScannedAt ? Date.parse(coverage.lastScannedAt) : NaN;
```

Problem:
In `nextFunctionLengthReviewTask`, the two `try/catch` blocks that parse `coveragePath` and `flagsPath` use a bare `catch` with no bound parameter and no body beyond reassigning the default (`{}` or `[]`). If the state file is corrupt, half-written, or manually mangled, `JSON.parse` throws a `SyntaxError` that is discarded entirely — no `console.error`, no `process.stderr.write`, no rethrow. The function then proceeds with an empty coverage object, so `coverage.lastScannedAt` is `undefined`, `lastScannedAt` resolves to `NaN`, and `due` is unconditionally `true`. The pipeline re-scans and re-flags every function it has already reviewed, flooding the queue with duplicate candidates, while the operator receives zero signal that the underlying state file is unreadable. A genuine data-integrity failure is indistinguishable from a normal first-run or interval-expiry rescan.

Solution:
Bind the caught error in each `catch` clause and emit a `console.error` call that includes the offending file path, a short human-readable description ("failed to parse … ; defaulting to {}" / "… defaulting to []"), and the original error object (so the stack and `SyntaxError` message are preserved). Keep the graceful-degradation contract intact — the function still assigns the empty default and continues the review cycle — because a caller mid-pipeline cannot meaningfully recover a corrupt state file in-place, and crashing the whole pipeline over a recoverable state-file issue is worse than logging and proceeding. No metric, counter, or telemetry primitive is added; the project has no metrics system, and `console.error` (Node stdlib) is the available logging surface.

Benefits:
An operator running the pipeline sees an immediate, identifiable error on stderr naming the exact file path and the parse failure, so a corrupt or half-written state file is diagnosed in seconds rather than discovered (if at all) through the confusing symptom of duplicate re-scan output. The graceful-degradation behavior is preserved — the pipeline does not crash — but the silent data-loss path is closed. Future debugging of state-file corruption (interrupted writes, merge artifacts, manual edits) becomes a grep-able log line instead of an invisible no-op.

### AC-5 · Surface swallowed JSON.parse errors in function-length-review coverage/flags loading
Strength: Strong
Files: src/function-length-review.js
Snippet:
```
  const flagsPath = path.join(pipelineDir, 'queue', 'function-length-flags.json');

  let coverage;
  try { coverage = JSON.parse(readIfExists(coveragePath) || '{}'); } catch { coverage = {}; }
  let flags;
  try { flags = JSON.parse(readIfExists(flagsPath) || '[]'); } catch { flags = []; }

```

Problem:
In `nextFunctionLengthReviewTask`, the two `try { … } catch { … }` blocks that parse `function-length-coverage.json` and `function-length-flags.json` use bare `catch` with no binding and no log statement. If either file is corrupted (partial write, truncation, manual edit, encoding glitch), `JSON.parse` throws, the exception is silently discarded, and the code substitutes `{}` or `[]`. For the coverage file this is especially dangerous: `coverage.lastScannedAt` becomes `undefined`, so `Date.parse(undefined)` yields `NaN`, so `due` is always `true`, and the pipeline re-runs the full scan + judge + write cycle on every invocation with zero diagnostic output. For the flags file, all previously queued flags are silently dropped, risking duplicate flagging or loss of tracked items. Because the project has no metrics system and no third-party logger, the only available diagnostic primitive is a `console.error` call, and none is present.

Solution:
Bind the caught exception (`catch (err)`) in both blocks and emit a `console.error` line that includes the file path, the underlying parse error message, and the fallback value being substituted. Keep the existing fallback semantics (`coverage = {}` / `flags = []`) so the "scan if due" path and downstream callers that expect a valid object or array continue to work unchanged. Do not rethrow: the function's contract is a graceful fallback, and rethrowing would break the scheduling logic that depends on `coverage` being a plain object. The two log lines look like: `console.error('[function-length-review] failed to parse ' + coveragePath + ': ' + (err && err.message ? err.message : String(err)) + '; falling back to {}')` and the analogous line for the flags path.

Benefits:
An operator or CI log reader can immediately see *which* file failed to parse and *why* (e.g., "Unexpected token in JSON at position 0"), eliminating the silent infinite re-scan loop and the silent flag loss. The fix adds no dependency, no new abstraction, and changes no control-flow behavior—it only makes the already-intended fallback observable.

### AC-6 · Silent-catch analysis failure indistinguishable from clean file
Strength: Strong
Files: src/observability-review.js
Snippet:
```
    if (content && !minified) {
      try {
        silentCatch = findSilentCatchBlocks(content, relPath).filter((f) => f.rule === 'silent-catch-block');
      } catch { silentCatch = []; }
    }
    const entry = { content, minified, silentCatch };
    cache.set(relPath, entry);
```

Problem:
Inside `makeFileCache`, the `try` block calls `findSilentCatchBlocks(content, relPath)` and filters the result. The accompanying `catch { silentCatch = []; }` discards the exception entirely—no variable is bound, nothing is logged, and no marker is set on the returned entry. The resulting object `{ content, minified, silentCatch: [] }` is byte-identical to the case where the analyser ran successfully and found zero silent-catch blocks. In a review pipeline whose sole purpose is to surface findings, an operator or downstream aggregator reading `silentCatch: []` will record the file as clean and move on, with no trace that the analysis step actually threw (catastrophic regex backtrack, an unexpected AST shape causing a `TypeError`, a `RangeError` under memory pressure, etc.). The failure is a silent false-negative: the pipeline reports "no problems" when it could not determine whether problems exist.

Solution:
Replace the bare `catch { silentCatch = []; }` with `catch (err) { console.error("[observability-review] findSilentCatchBlocks failed for " + relPath + ": " + err.message); silentCatch = []; }`. This binds the exception so the original error message is available, emits a single `console.error` line that names the offending file path and the error's message (the only logging primitive this project uses—no third-party logger, no metrics system exists), and still degrades gracefully to an empty array so one pathological file does not crash the entire cache build. No rethrow is warranted: the caller's contract is a best-effort per-file entry, and aborting `makeFileCache` over a single file's analysis failure would be a larger outage than the single-file gap. No new dependency, no metric, no structural change.

Benefits:
Once the fix is in place, any future regression in `findSilentCatchBlocks` (a bad regex, a shape mismatch in the AST it receives, a memory-pressure abort) will produce a visible, greppable line in CI logs or `stderr` that names the exact file and the error message. An operator can distinguish "analysed, zero hits" from "analysis crashed" by the presence of the log line, and can triage the root cause without re-running the pipeline with debug instrumentation. The graceful-degradation contract is preserved—no other file in the cache is affected, and the pipeline continues to produce output for every path it is asked about.
