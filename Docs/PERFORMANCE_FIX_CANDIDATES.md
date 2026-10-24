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
