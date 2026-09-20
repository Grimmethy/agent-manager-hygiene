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
