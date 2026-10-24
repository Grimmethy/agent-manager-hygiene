# Performance Fix Candidates

### AC-1 · Fix Synchronous Directory Scans with Async Parallelization
Strength: Strong
Files: src/decompose-loop-autoroute.js
Snippet:
```
  const reqDir = path.join(pipelineDir, 'queue', 'file-decompose-requests');
  const pendingDir = path.join(pipelineDir, 'queue', 'pending');

  for (const dir of SCAN_DIRS) {
    let names;
    try { names = fs.readdirSync(path.join(pipelineDir, 'queue', dir)).filter((n) => n.endsWith('.json')); } catch (err) { if (err.code === 'ENOENT') continue; console.error(`[decompose-loop-autoroute] readdir failed for ${path.join(pipelineDir, 'queue', dir)}: ${err.code || 'UNKNOWN'} ${err.message}`); throw err; }
    for (const name of names) {
```

Problem:
The code currently calls `fs.readdirSync` synchronously inside a loop over `SCAN_DIRS`, which may contain multiple directories. Each call blocks the Node.js event loop, and nested loops over files within each directory compound the latency. This creates a serial, blocking I/O bottleneck that degrades performance under load or frequent execution — especially if directories contain hundreds or thousands of files.

Solution:
Replace `fs.readdirSync` with `fs.promises.readdir`, and use `Promise.all` to read all directories in parallel. Then flatten the results into a single loop over all files, eliminating nested iteration and blocking I/O per directory. Add error handling for `ENOENT` and log other errors via `console.error` to maintain consistency with existing logging.

Benefits:
The event loop is no longer blocked per directory scan, and the overall operation becomes parallelized and amortized over all directories. This reduces latency, improves scalability, and allows the system to handle larger or more frequent scans without degradation — especially under concurrent or high-load conditions.

### AC-2 · Fix Synchronous Directory Reads with Async Parallelization
Strength: Strong
Files: src/decompose-move-determinism-backfill.js
Snippet:
```

function listTaskFiles(pipelineDir, dirNames) {
  const out = [];
  for (const d of dirNames) {
    const dir = path.join(pipelineDir, 'queue', d);
    let names;
    try { names = fs.readdirSync(dir); } catch { continue; }
```

Problem:
The current loop iterates over a list of directories and calls `fs.readdirSync` once per iteration, causing each call to block the Node.js event loop. With dozens or hundreds of directories, this leads to cumulative latency — potentially 100ms+ per directory — stalling HTTP responses, timers, and user interactions. The scanner is correct: this is not a correctness issue, but a performance and responsiveness bottleneck in production.

Solution:
Replace the synchronous `fs.readdirSync` with `fs.promises.readdir` and process all directory reads in parallel using `Promise.allSettled`. This avoids blocking I/O per iteration and lets the event loop remain responsive. Errors are logged via `console.error` — matching the project’s existing logging style — and empty results are silently skipped.

Benefits:
The fix eliminates blocking I/O, reducing latency per directory read and improving overall system responsiveness. It’s safe, uses only primitives available in the project (Node.js `fs.promises` and `console.error`), and requires no new dependencies or metrics/logging frameworks.
