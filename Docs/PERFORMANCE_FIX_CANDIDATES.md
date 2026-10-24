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

### AC-3 · Synchronous File I/O Bottleneck
Strength: Strong
Files: src/file-decompose-to-hub.js
Snippet:
```
  let names;
  try { names = fs.readdirSync(requestsDir).filter((n) => n.endsWith('.json')); } catch { return []; }
  const out = [];
  for (const name of names) {
    const full = path.join(requestsDir, name);
    try {
      const parsed = JSON.parse(fs.readFileSync(full, 'utf8'));
```

Problem:
The code synchronously reads and parses every `.json` file in `requestsDir` one at a time using `fs.readFileSync` inside a loop. This blocks the Node.js event loop for each file, causing severe latency that scales linearly with the number of files — potentially hundreds of milliseconds per file on slow disks. This makes the operation unusable for any real-world workload with more than a few files, as no concurrent operations (including HTTP requests or timers) can proceed.

Solution:
Replace the synchronous loop with an asynchronous approach: first read the directory with `fs.promises.readdir`, then map each `.json` file to a `fs.promises.readFile` promise, and use `Promise.all` to execute all reads in parallel. After parsing, retain the same `filter` and `map` logic. This removes all blocking I/O, allowing the event loop to remain responsive while processing hundreds of files.

Benefits:
The operation becomes non-blocking and scales linearly with file count instead of quadratically. Performance improves dramatically for large directories, and the system remains responsive to concurrent operations — including HTTP requests and timers — which is essential for real-world usage.

### AC-4 · Parallelize Synchronous File Reads with Async I/O
Strength: Strong
Files: src/observability-scan.js
Snippet:
```
    { file: 'pyproject.toml', re: /opentelemetry-/ },
    { file: 'go.mod', re: /go\.opentelemetry\.io/ },
  ];
  for (const { file, re } of checks) {
    try {
      const text = fs.readFileSync(path.join(repoRoot, file), 'utf8');
      if (re.test(text)) return true;
```

Problem:  
The scanner correctly identifies a performance bottleneck: a synchronous `fs.readFileSync` inside a loop that iterates over check configurations, blocking the Node.js event loop per iteration. Each file read may take 10s–100s of ms, and with hundreds or thousands of files, this causes significant latency and reduced throughput — especially in hot paths like startup or frequent scans. Since there’s no metrics or logging, the impact is invisible, but the blocking is real and measurable.

Solution:  
Replace `fs.readFileSync` with `fs.promises.readFile`, and wrap the loop in `Promise.all` to run all reads concurrently. This eliminates the blocking per iteration, allowing the event loop to remain responsive while all reads proceed in parallel. The loop’s logic remains unchanged — only the I/O is async.

Benefits:  
Once fixed, the system will no longer block during file reads, reducing startup time and improving throughput for repeated scans. The fix is deterministic and matches the scanner’s concern: synchronous I/O → async I/O with parallelization → no blocking per iteration. Since the project runs on Node.js 18+, `fs.promises` is available without any new dependencies.
