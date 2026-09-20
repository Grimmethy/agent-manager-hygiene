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
