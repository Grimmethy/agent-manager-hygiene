# Function Length Decomposition Candidates

### AC-1 · Decompose fileHub into Atomic Responsibilities
Strength: Strong
Files: src/file-decompose-to-hub.js
Symbol: fileHub
Snippet:
```
}

function fileHub({ pipelineDir, repoRoot, requestFile, request, now }) {
  // Always validate now (was stacked-only) -- Tier 1's planIsFullyMechanicalHtml needs
  // every move's `deterministicApplyOk`, and a non-resolvable symbol should block a
  // per-move-branch hub just as it blocks a stacked one. validatePlan is non-destructive:
  // an unavailable Python checker returns null -> no false hard-problem.
  const validation = validatePlan(repoRoot, request);
  if (!validation.ok) {
    return fileBlockedHub({ pipelineDir, requestFile, request, now, hardProblems: validation.hardProblems });
  }

  // Tier 1 ([[hub-task-integration]] / spec Docs/hub-task-independent-merge.md): a fully-
  // mechanical HTML plan (every move a script-extract, every symbol deterministicApplyOk)
  // has no judgement left. File ONE deterministic task instead of a stacked hub of N move
  // children + a wiring child + a multi-day merge window -- local-draft.js's
  // tryDeterministicOnePassDecompose runs the whole split with no model call, against
  // CURRENT main, in one tick. Fall through to the hub if it doesn't qualify.
  if (planIsFullyMechanicalHtml(request, validation)) {
    return fileOnePassTask({ pipelineDir, requestFile, request, now, kind: 'html' });
  }

  // Same, for a plain CommonJS source (src/*.js): every move a self-contained function
  // cluster (decompose-node-module.js) -> ONE deterministic task, no hub. This is what
  // finally lets a src/*.js file be decomposed by the pipeline at all -- until now the
  // only shapes with a deterministic path were HTML <script> and flask-blueprint.
  if (planIsFullyMechanicalNodeModule(request, validation)) {
    return fileOnePassTask({ pipelineDir, requestFile, request, now, kind: 'node-module' });
  }

  // Same, for an all-flask-blueprint .py plan: one deterministic task (AST extract +
  // register_blueprint splice + py_compile), no hub, no per-move 27B agentic pass.
  if (planIsFullyMechanicalBlueprint(request, validation)) {
    return fileOnePassTask({ pipelineDir, requestFile, request, now, kind: 'flask-blueprint' });
  }

  // Same, for an all-python-module-extract .py plan: one deterministic task (AST extract +
  // py_compile, no register_blueprint wiring since there's nothing to register). This is
  // what finally lets a routeless-helper-heavy file like app.py's current shape be
  // decomposed at all -- until now the only deterministic .py path required an @app.route.
  if (planIsFullyMechanicalPythonModule(request, validation)) {
    return fileOnePassTask({ pipelineDir, requestFile, request, now, kind: 'python-module' });
  }

  // Hot-file exclusion applies ONLY here, past every Tier-1 short-circuit above (2026-09-14
  // fix -- screaminggoatclubmt: "we need these things broken down into manageable chunks
  // as we build them", found live when the proactive sweep held app.py's flask-blueprint
  // decomposes for a full week even though every one of them landed as a single Tier-1
  // one-pass commit, never the multi-day Tier-2 hub this guard exists to protect). Do NOT
  // stamp hubFiledAt/hubId -- leaving the request unresolved means sweep() above just
  // retries this same cheap (no model call) check on its next tick, and materialises the
  // real hub the moment the file cools down.
  if (fileHasRecentCommits(repoRoot, request.sourceFile)) {
    return { deferred: true, reason: `${request.sourceFile} has commits in the last ${HOT_FILE_DAYS} days -- Tier-2 hub deferred until it cools down` };
  }

  const adhocDir = path.join(pipelineDir, 'queue', 'adhoc');
  const coordDir = path.join(pipelineDir, 'queue', 'coordinating');
  fs.mkdirSync(adhocDir, { recursive: true });
  fs.mkdirSync(coordDir, { recursive: true });
  const nowIso = new Date(now).toISOString();
  const planSlug = slugify(request.id);
  const moves = request.moves;
  const stacked = stackedEnabled();
  const branch = `agent/decompose-${planSlug}`;

  // Deterministic wiring (wire-decomposed-blueprints.js): for flask-blueprint moves the
  // coordinator splices the `register_blueprint` block itself once every move child is
  // done -- no LLM wiring child. Anything else (script-extract, plain require) still gets
  // an LLM wiring child, scoped to just those moves. Kill switch: DECOMPOSE_DET_WIRING.
  const bpMoves = moves.filter((m) => m.kind === 'flask-blueprint');
  const otherMoves = moves.filter((m) => m.kind !== 'flask-blueprint');
  const useDetWiring = stacked && bpMoves.length > 0
    && process.env.AGENT_MANAGER_DECOMPOSE_DET_WIRING !== 'false';
  const fileWiringChild = !useDetWiring || otherMoves.length > 0;
  const wiringChildMoves = useDetWiring ? otherMoves : moves;
  const wiringChildCount = fileWiringChild ? 1 : 0;

  const children = [];
  const moveIds = [];
  let prevId = null;
  moves.forEach((move, i) => {
    const id = `adhoc-decompose-${planSlug}-${String(i + 1).padStart(2, '0')}-${slugify(path.basename(move.newFile))}`.slice(0, 120);
    moveIds.push(id);
    // Deterministic apply (2026-09-07, "Ghost in the Machine" concept): a script-extract
    // move validatePlan() already confirmed resolves every symbol cleanly skips the model
    // entirely at draft time -- see local-draft.js's tryDeterministicScriptExtractEdit.
    // symbols/sourceFile are stashed here (not just baked into the prose rawText) so that
    // check has real structured data to act on without re-parsing English.
    const deterministic = move.kind === 'script-extract' && validation.moveMeta[i] && validation.moveMeta[i].deterministicApplyOk;
    const record = {
      id,
      domain: 'adhoc',
      source: 'manual',
      title: `Decompose ${request.sourceFile} → ${move.newFile}`,
      createdAt: nowIso,
      promptContext: {
        rawText: moveRawText(request, move, i, moves.length, validation.moveMeta[i]),
        decomposedFrom: `file-decompose-hub-${planSlug}`,
        moveIndex: i,
        newFile: move.newFile,
        ...(deterministic ? { deterministicApply: 'script-extract', sourceFile: request.sourceFile, symbols: move.symbols } : {}),
      },
    };
    if (stacked) {
      record.atomic = true;
      record.noDecompose = true;
      record.stacked = { branch, seq: i + 1, total: moves.length + wiringChildCount };
      if (prevId) record.dependsOn = [prevId];
    }
    // premiumPriority propagation (2026-09-08, Grimmethy: "any time a hub process that is
    // set to premium priority generates a new child, that child should be set to premium
    // priority as well. I've had to manually set premium on the last 2 children of
    // decompose") -- same propagation apply-adhoc-diff.js's queueSubTasks already does for
    // a plain RESOLUTION: decompose split; this hub-based path had no equivalent at all.
    if (request.premiumPriority) record.premiumPriority = true;
    fs.writeFileSync(path.join(adhocDir, `${id}.json`), `${JSON.stringify(record, null, 2)}\n`);
    children.push({ id, title: record.title, status: 'pending' });
    prevId = id;
  });

  // Final wiring task. In stacked mode it depends only on the last move (the chain is
  // sequential); in legacy mode it waits on every move being merged. Skipped entirely when
  // every move is a flask-blueprint the coordinator wires deterministically.
  if (fileWiringChild) {
    const wireId = `adhoc-decompose-${planSlug}-99-wiring`.slice(0, 120);
    const wiringMetas = wiringChildMoves.map((m) => validation.moveMeta[moves.indexOf(m)]);
    const wiringRecord = {
      id: wireId,
      domain: 'adhoc',
      source: 'manual',
      title: `Decompose ${request.sourceFile} — wire up ${wiringChildMoves.length} new file(s)`,
      createdAt: nowIso,
      dependsOn: stacked ? [prevId] : moveIds,
      promptContext: { rawText: wiringRawText(request, wiringChildMoves, wiringMetas), decomposedFrom: `file-decompose-hub-${planSlug}` },
    };
    if (stacked) {
      wiringRecord.atomic = true;
      wiringRecord.noDecompose = true;
      wiringRecord.stacked = { branch, seq: moves.length + 1, total: moves.length + wiringChildCount };
    }
    if (request.premiumPriority) wiringRecord.premiumPriority = true;
    fs.writeFileSync(path.join(adhocDir, `${wireId}.json`), `${JSON.stringify(wiringRecord, null, 2)}\n`);
    children.push({ id: wireId, title: `wire up ${wiringChildMoves.length} new file(s)`, status: 'pending' });
  }

  const hubId = `file-decompose-hub-${planSlug}`;
  const hub = {
    id: hubId,
    domain: 'adhoc',
    source: 'manual',
    status: 'coordinating',
    adhocResolution: 'decompose',
    title: `Decompose ${request.sourceFile} (${moves.length} module(s))`,
    createdAt: nowIso,
    promptContext: { rawText: `Coordinator for the ${request.id} decomposition of ${request.sourceFile}.`, decomposedFrom: hubId },
    subTasks: children,
    progress: { done: 0, total: children.length },
    planValidation: { ok: true, sharedDeps: validation.moveMeta.map((m) => m.sharedDeps || []), checkedAt: nowIso },
    // decomposeHub: coordinator-sweep.js treats a non-stacked one specially -- it does NOT
    // complete until every move child is actually MERGED to main (not merely `done` on its
    // own agent/<id> branch), reconciling each via the commit trailer. sourceFile is kept
    // here (not just for stacked) so a later per-move integration gate has the target.
    decomposeHub: true,
    sourceFile: request.sourceFile,
    ...(request.premiumPriority ? { premiumPriority: true } : {}),
    // parentHub (2026-09-08): propagated from the request the same way premiumPriority is,
    // above -- set by decompose-loop-autoroute.js when this hub rescues a stuck child of an
    // existing hub, so the dashboard's Hub Tasks tab can render the real family tree.
    ...(request.parentHub ? { parentHub: request.parentHub } : {}),
    history: [{ stage: 'created', at: nowIso, detail: `file-decompose-to-hub: filed ${moves.length} move task(s)${useDetWiring ? ` + deterministic wiring for ${bpMoves.length} blueprint(s)` : ''}${fileWiringChild ? ` + 1 LLM wiring task${useDetWiring ? ` for ${otherMoves.length} non-blueprint move(s)` : ''}` : ''}${stacked ? ` (stacked on ${branch})` : ''}` }],
  };
  if (stacked) {
    hub.mode = 'stacked';
    hub.branch = branch;
    hub.sourceFile = request.sourceFile;
    hub.integrationGate = { status: 'pending' };
  }
  if (useDetWiring) {
    hub.wiringPending = true;
    hub.wiringMoves = bpMoves.map((m) => ({ newFile: m.newFile, blueprint: m.blueprint, kind: m.kind }));
  }
  fs.writeFileSync(path.join(coordDir, `${hubId}.json`), `${JSON.stringify(hub, null, 2)}\n`);

  request.hubFiledAt = nowIso;
  request.hubId = hubId;
  request.hubChildIds = children.map((c) => c.id);
  if (stacked) request.branch = branch;
  fs.writeFileSync(requestFile, `${JSON.stringify(request, null, 2)}\n`);
  return { hubId, childCount: children.length, stacked, branch: stacked ? branch : undefined };
}
```

Problem:
The function `fileHub` is 189 lines long and orchestrates six distinct responsibilities: short-circuit validation for deterministic tasks, hot-file exclusion, deterministic wiring logic, child task generation, hub construction with persistence, and stacked mode logic. These responsibilities are tightly coupled, making the function hard to test, debug, or modify without risking unintended side effects. The logic is not logically grouped, and state mutations occur across unrelated concerns, increasing cognitive load and error risk.

Solution:
Extract six named functions: `validateAndShortCircuit`, `generateChildren`, `constructHub`, `writeRequestFile`, and `returnHubResult`. Each handles one logical concern. `validateAndShortCircuit` handles early returns for deterministic tasks and hot files. `generateChildren` creates move and wiring tasks based on mode and move types. `constructHub` builds the hub object, writes it to disk, and mutates the request. `writeRequestFile` persists the updated request. `returnHubResult` returns the structured result. These functions are self-contained, testable, and isolated from each other.

Benefits:
Decomposing the function improves readability by isolating concerns, enables unit testing of each piece independently, and reduces the risk of side effects when modifying any part. It also makes future enhancements or bug fixes more localized and less error-prone, since each function has a single responsibility and clear boundaries.

VERDICT CONSTRAINT (mandatory for this task):
- The function snippet IS provided above in this prompt; you do not need to request it or assume it is missing.
- You MUST render exactly one verdict: GENUINE or FALSE POSITIVE.
- Refusals, hedging, or a third outcome (including "Uncertain", "I cannot determine", or any other qualifier) are NOT acceptable. Pick the one verdict that best fits the evidence in the snippet and commit to it.

VERDICT: GENUINE

### AC-2 · Decompose Long Validation Orchestrator
Strength: Strong
Files: src/file-decompose-to-hub.js
Symbol: validatePlan
Snippet:
```
// hardProblems block the whole plan (hub filed blocked, no children). Shared deps do not
// block -- they are threaded into the move + wiring prompts.
function validatePlan(repoRoot, request) {
  const hardProblems = [];
  const moveMeta = [];
  const allMovedSymbols = new Set();
  for (const m of request.moves) for (const s of (m.symbols || [])) allMovedSymbols.add(s);

  // A plain CommonJS source (src/*.js) -- neither an HTML <script> nor a .py. Run the
  // whole plan through decompose-node-module.js once: it chains the N moves and only
  // succeeds if EVERY move is a self-contained set of top-level function declarations
  // (references only each other + require()d names + JS globals). ok -> every move gets
  // nodeModuleApplyOk (the .js analogue of deterministicApplyOk); not-ok -> one hard
  // problem with the exact reason. The move `kind` (script-extract vs module-extract) is
  // irrelevant here -- .js wiring is require()/module.exports either way.
  //
  // 2026-09-14, screaminggoatclubmt: "Harden [this]" -- caught live: this branch used to
  // match ANY .js source by extension alone, with zero regard for whether it's actually a
  // Node CommonJS module. python/dashboard/static/js/*.js files are loaded via a plain
  // browser `<script src>` tag (see index.html) -- no bundler, no Node runtime, `require`
  // is not a defined identifier there at all. The produced split used real
  // require()/module.exports wiring anyway, which would have thrown "require is not
  // defined" the instant the browser loaded it, breaking the Models/Deep-Dive/Discovery/
  // Tokenfold tabs -- caught before merge only because this session verifies every branch
  // for real before recommending one. looksLikeNodeCommonJsModule (require()/module.exports
  // ANYWHERE in the source) gates this branch now; every real Node module in this repo has
  // at least one of those (confirmed: 0 occurrences across every static/js/*.js file,
  // 20+ each across a sample of real src/*.js modules). A file that fails this gate falls
  // through to the generic per-move loop below, which already handles `script-extract`
  // moves in a browser-safe way (staticCheckScriptExtractMove, verbatim extraction, no
  // require()/module.exports wiring at all) -- built and proven for plain .js sources
  // back on 2026-09-08 (review-task.js), just never reachable for THIS class of file
  // because this earlier, broader check always intercepted it first.
  if (/\.(js|mjs|cjs)$/.test(request.sourceFile || '')) {
    let sourceText = null;
    try { sourceText = fs.readFileSync(path.join(repoRoot, request.sourceFile), 'utf8'); } catch { /* unreadable -> advisory only */ }
    if (sourceText != null && looksLikeNodeCommonJsModule(sourceText, request.sourceFile)) {
      const built = buildNodeModuleOnePassChanges(sourceText, request.sourceFile, request.moves.map((m) => ({ newFile: m.newFile, symbols: m.symbols || [] })), repoRoot);
      if (built.ok) {
        for (const _m of request.moves) moveMeta.push({ sharedDeps: [], neededImports: [], nodeModuleApplyOk: true });
      } else {
        hardProblems.push(`${request.sourceFile}: ${built.reason}`);
        for (const _m of request.moves) moveMeta.push({ sharedDeps: [], neededImports: [] });
      }
      return { ok: hardProblems.length === 0, hardProblems, moveMeta };
    }
    // Unreadable, OR readable but not a CommonJS module -- fall through to the generic
    // per-move loop below rather than returning here.
  }

  // A .py source whose plan is ALL flask-blueprint moves: run the whole plan through
  // decompose-flask-blueprint.js once (AST extract + py_compile). ok -> every move gets
  // blueprintApplyOk and fileHub short-circuits to a single deterministic one-pass task
  // (no hub, no per-move 27B agentic pass -- which on a large app.py runs out of turn
  // budget before finishing: the 2026-09-09 blueprint hub). not-ok -> one hard problem.
  // A MIXED .py plan (some blueprint, some not) still falls through to the per-move path.
  if (process.env.AGENT_MANAGER_DECOMPOSE_BLUEPRINT !== 'false'
      && /\.py$/.test(request.sourceFile || '') && request.moves.length
      && request.moves.every((m) => m.kind === 'flask-blueprint' && m.blueprint)) {
    let sourceText = null;
    try { sourceText = fs.readFileSync(path.join(repoRoot, request.sourceFile), 'utf8'); } catch { /* unreadable -> advisory only */ }
    if (sourceText != null) {
      const built = buildBlueprintOnePassChanges(sourceText, request.sourceFile,
        request.moves.map((m) => ({ newFile: m.newFile, blueprint: m.blueprint, symbols: m.symbols || [] })));
      if (built.ok) {
        for (const _m of request.moves) moveMeta.push({ sharedDeps: [], neededImports: [], blueprintApplyOk: true });
      } else {
        hardProblems.push(`${request.sourceFile}: ${built.reason}`);
        for (const _m of request.moves) moveMeta.push({ sharedDeps: [], neededImports: [] });
      }
    } else {
      for (const _m of request.moves) moveMeta.push({ sharedDeps: [], neededImports: [] });
    }
    return { ok: hardProblems.length === 0, hardProblems, moveMeta };
  }

  // A .py source whose plan is ALL python-module-extract moves (2026-09-26): the plain,
  // non-route sibling of the flask-blueprint branch above -- for helper functions with no
  // @app.route to anchor a Blueprint on (traced live: computeRoutelessSections in
  // file-decompose-plan-pass.js was excluding these from every candidate set entirely, so
  // app.py's plan pass returned null on every tick with 193/194 symbols routeless and
  // nothing ever filed). Same AST-extract + py_compile discipline, no wiring step -- a
  // plain module has nothing to register. A MIXED .py plan still falls through below.
  if (process.env.AGENT_MANAGER_DECOMPOSE_PY_MODULE !== 'false'
      && /\.py$/.test(request.sourceFile || '') && request.moves.length
      && request.moves.every((m) => m.kind === 'python-module-extract')) {
    let sourceText = null;
    try { sourceText = fs.readFileSync(path.join(repoRoot, request.sourceFile), 'utf8'); } catch { /* unreadable -> advisory only */ }
    if (sourceText != null) {
      const built = buildPythonModuleOnePassChanges(sourceText, request.sourceFile,
        request.moves.map((m) => ({ newFile: m.newFile, symbols: m.symbols || [] })));
      if (built.ok) {
        for (const _m of request.moves) moveMeta.push({ sharedDeps: [], neededImports: [], pythonModuleApplyOk: true });
      } else {
        hardProblems.push(`${request.sourceFile}: ${built.reason}`);
        for (const _m of request.moves) moveMeta.push({ sharedDeps: [], neededImports: [] });
      }
    } else {
      for (const _m of request.moves) moveMeta.push({ sharedDeps: [], neededImports: [] });
    }
    return { ok: hardProblems.length === 0, hardProblems, moveMeta };
  }

  for (const move of request.moves) {
    const symbols = move.symbols || [];
    const meta = { sharedDeps: [], neededImports: [] };
    if (symbols.length === 0) {
      hardProblems.push(`${move.newFile}: move has no symbols`);
      moveMeta.push(meta);
      continue;
    }
    if (move.kind === 'script-extract') {
      const seCheck = staticCheckScriptExtractMove(repoRoot, request.sourceFile, symbols);
      if (seCheck && seCheck.resolvable) {
        if (!seCheck.ok) {
          hardProblems.push(`${move.newFile}: ${seCheck.missing.join(', ')} could not be located as top-level function declarations in ${request.sourceFile}`);
        } else {
          // Every symbol resolves cleanly -- this move can skip the model entirely at
          // apply time (see local-draft.js's tryDeterministicScriptExtractEdit).
          meta.deterministicApplyOk = true;
        }
      }
      moveMeta.push(meta);
      continue;
    }
    const check = staticCheckMove(repoRoot, request.sourceFile, symbols);
    if (check) {
      if (check.missing && check.missing.length) {
        hardProblems.push(`${move.newFile}: ${check.missing.join(', ')} not defined at module scope in ${request.sourceFile}`);
      }
      const strays = Object.entries(check.externalRefs || {});
      if (strays.length) {
        hardProblems.push(`${move.newFile}: ${strays.map(([s, lines]) => `${s} is still referenced elsewhere in ${request.sourceFile} (line(s) ${lines.slice(0, 6).join(', ')})`).join('; ')} -- not a self-contained move`);
      }
      // `app` is expected for a flask-blueprint move (every @app.route becomes
      // @<bp>.route); anything else that resolves to an app.py module-level name and is
      // not itself being moved becomes a cross-module import.
      meta.sharedDeps = (check.sharedDeps || []).filter((d) => {
        if (d === 'app' && move.kind === 'flask-blueprint') return false;
        return !allMovedSymbols.has(d);
      });
      meta.neededImports = check.neededImports || [];
    }
    moveMeta.push(meta);
  }
  return { ok: hardProblems.length === 0, hardProblems, moveMeta };
}
```

Problem:
The function `validatePlan` is 145 lines long and combines three distinct validation responsibilities — Node CommonJS module checks, Flask blueprint validation, Python module extraction, and generic move validation — into a single monolithic block. Each branch has its own logic, error handling, and return structure, yet they all share mutable state (`hardProblems`, `moveMeta`, `allMovedSymbols`) and are executed sequentially with no isolation. This violates the Single Responsibility Principle and makes the function hard to test, extend, debug, and read — any change to one validation type risks breaking or confusing behavior in another.

Solution:
Extract each validation branch into its own named, independently testable function: `validateNodeCommonJsModule`, `validateFlaskBlueprint`, `validatePythonModule`, and `validateGenericMoves`. The main `validatePlan` function becomes a thin orchestrator that initializes shared state, calls each sub-function in sequence, and aggregates results. Each sub-function should accept the same inputs and return a consistent result structure (ok, hardProblems, moveMeta) to ensure predictable composition.

Benefits:
Once decomposed, each validation type can be unit-tested in isolation with mocked dependencies. Adding a new validation type becomes trivial — just write a new `validateXXX` function and add it to the main orchestrator’s call list. The code becomes more readable, maintainable, and less error-prone during future changes or debugging.

VERDICT CONSTRAINT (mandatory for this task):
- The function snippet IS provided above in this prompt; you do not need to request it or assume it is missing.
- You MUST render exactly one verdict: GENUINE or FALSE POSITIVE.
- Refusals, hedging, or a third outcome (including "Uncertain", "I cannot determine", or any other qualifier) are NOT acceptable. Pick the one verdict that best fits the evidence in the snippet and commit to it.

VERDICT: GENUINE

### AC-3 · Decompose Multi-Phase Runtime Probe Execution
Strength: Strong
Files: src/decompose-node-module.js
Symbol: firstRuntimeError
Snippet:
```
}

function firstRuntimeError(changes, sourceFile, repoRoot) {
  const os = require('os');
  const fs = require('fs');
  const { execFileSync } = require('child_process');
  const dirCandidates = [path.dirname(sourceFile)];
  for (const ch of changes) {
    dirCandidates.push(path.dirname(ch.file));
    const body = ch.mode === 'create' ? ch.content : ch.replace;
    if (typeof body === 'string') dirCandidates.push(...relativeRequireTargetDirs(body, path.dirname(ch.file)));
  }
  const ancestorRel = commonAncestorDir(dirCandidates);
  const ancestorAbs = path.join(repoRoot, ancestorRel);
  let dir;
  try {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nm-runtime-'));
    fs.cpSync(ancestorAbs, dir, { recursive: true });
  } catch (e) {
    try { if (dir) fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    return null; // can't stage a runnable copy -- fall back to the static + parse guards
  }
  try {
    for (const ch of changes) {
      const body = ch.mode === 'create' ? ch.content : ch.replace;
      if (typeof body !== 'string') continue;
      // Preserve ch.file's real position relative to the copied ancestor -- a basename-
      // only write flattens a newFile that sits in a subdirectory (e.g.
      // sdk/lib/candidate-lifecycle.js under sdk/candidate-fulfillment.js), so a
      // correctly-relative-pathed require() from the reduced source can never resolve it
      // here even though it would in the real repo.
      const relPath = path.relative(ancestorRel, ch.file);
      const dest = path.join(dir, relPath);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, body);
    }
    const probe = [
      'const path=require("path");',
      `const m=require(${JSON.stringify(path.join(dir, path.relative(ancestorRel, sourceFile)))});`,
      // 2026-09-14, screaminggoatclubmt: "fix the runtime probe bug too" -- found live
      // against task-sources.js's own real exports: nextDeepDiveTask/nextProjectSearchTask
      // (task-source POLLERS, not simple helpers) spawn REAL python3 subprocesses against
      // REAL external repo clones as a side effect of merely being called with no args --
      // this isn't a naming-convention edge case, it's this pipeline's own dominant
      // `next<X>Task()` shape across every task-source module. The risky-name denylist
      // never anticipated it (none of write/apply/save/... match "next"), so the probe ran
      // real external I/O during what's supposed to be a side-effect-free dry-run check,
      // then blew the timeout mid-spawn -- misreported by the generic fallback below as
      // "module failed to load" instead of what actually happened (a timeout while it was
      // doing real work it should never have been allowed to start).
      // 2026-09-14, screaminggoatclubmt: "dig into the new bug too" -- found live against
      // local-draft.js's own real exports: callImplementModel is an `async function`.
      // Calling `v()` on it NEVER throws synchronously, even when its own parameter
      // destructuring (`{ recordModelCall, implPrompt, ... }` with no argument supplied)
      // would throw -- an async function always returns a Promise, so that failure
      // becomes a REJECTED promise instead, which the `try{v()}catch` here can never see.
      // The rejection then surfaces later as an unhandled promise rejection, which
      // crashes the WHOLE probe process by default in modern Node -- not name-pattern-
      // specific like the next*/onboard/clone fix above, since ANY async export with a
      // required parameter hits this, regardless of its name. Extending the denylist
      // forever is whack-a-mole; a global safety net fixes the whole class at once.
      'let sawRTE=null;',
      'process.on("unhandledRejection",(e)=>{ if(e && e.name==="ReferenceError" && !sawRTE) sawRTE=e; });',
      'process.on("uncaughtException",()=>{});', // same belt-and-suspenders spirit as the risky-name denylist: never let a call we made crash this probe outright
      'const risky=/^(write|apply|save|generate|run|queue|file|commit|push|delete|sync|remove|move|reset|migrate|send|post|exec|spawn|kill|install|build|next|onboard|clone)/i;',
      'for(const [k,v] of Object.entries(m||{})){',
      '  if(typeof v!=="function"||risky.test(k)||v.length>4) continue;',
      '  try{',
      '    const r=v();',
      '    if(r && typeof r.then==="function") r.catch((e)=>{ if(e && e.name==="ReferenceError" && !sawRTE) sawRTE=e; });',
      '  }catch(e){',
      '    if(e && e.name==="ReferenceError"){ process.stderr.write("RTE "+k+": "+e.message); process.exit(3); }',
      '  }',
      '}',
      // Give any pending promise rejection a chance to settle before deciding the
      // verdict -- without this, a same-tick unhandledRejection listener can still fire
      // AFTER the process would otherwise exit 0, silently losing a genuine async RTE.
      'setTimeout(()=>{',
      '  if(sawRTE){ process.stderr.write("RTE (async): "+sawRTE.message); process.exit(3); }',
      '  process.exit(0);',
      '},50);',
    ].join('\n');
    try {
      // Timeout dropped 20s -> 8s: belt-and-suspenders alongside the risky-name fix above
      // -- bounds the worst case for any FUTURE side-effecting export shape this denylist
      // still doesn't anticipate, so a stray real subprocess fails fast instead of running
      // wild for 20s.
      execFileSync('node', ['-e', probe], {
        cwd: dir, timeout: 8_000, stdio: ['ignore', 'ignore', 'pipe'],
        env: { ...process.env, AGENT_MANAGER_REPO_ROOT: repoRoot },
      });
      return null;
    } catch (e) {
      const err = String((e && e.stderr) || (e && e.message) || e);
      if (e && e.status === 3) return err.replace(/^RTE\s*/, '').split('\n')[0].slice(0, 200);
      // A SIGTERM (e.signal) with no output is the timeout firing mid-call -- distinct
      // from "the module could not even be require()d" (the ONLY case this branch used to
      // describe), and worth saying so plainly rather than the misleading generic message.
      if (e && e.signal && !err.trim()) {
        return `${sourceFile}: an exported function ran long enough to hit the ${8_000}ms probe timeout (likely real side effects the risky-name filter didn't anticipate) -- rather than a missing dependency`;
      }
      const line = err.split('\n').find((l) => /Error:|ReferenceError|is not defined/.test(l)) || 'module failed to load';
      return `${sourceFile}: ${line.trim().slice(0, 200)}`;
    }
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}
```

Problem:
The function `firstRuntimeError` orchestrates six distinct, stateful phases — directory discovery, environment staging, file mirroring, probe construction, execution with timeout, and cleanup — each with its own failure modes and responsibilities. These are not merely “lines” of code but logically separate operations that are interleaved with error handling and state management, making the function hard to test, debug, extend, or reason about.

Solution:
Extract the six phases into six named functions: `gatherDirCandidates`, `resolveAncestorDir`, `stageRepoCopy`, `writeFilesToStage`, `buildRuntimeProbeScript`, and `runProbeAndWait`. Also extract the nested probe logic into `probeRuntimeExports`, which returns a promise or error with categorized failure modes. Each function should handle only one concern and return early on failure, with cleanup handled by a finally block or explicit `cleanupStage`.

Benefits:
Decomposing the function improves testability (each phase can be unit-tested in isolation), debuggability (failure modes are localized), extensibility (adding a new probe step doesn’t require touching the whole function), and readability (each function has a single responsibility). The error handling becomes explicit and composable, not interleaved with setup or execution logic.

### AC-4 · Decompose Long Main Function into Logical Phases
Strength: Strong
Files: scripts/decompose-python-module-extract.py
Symbol: main
Snippet:
```


def main(argv):
    if len(argv) < 3:
        fail(["usage: decompose-python-module-extract.py <source.py> <sym>..."])
        return 2
    path, symbols = argv[1], argv[2:]
    try:
        src = open(path, "r", encoding="utf-8").read()
        tree = ast.parse(src, filename=path)
    except (OSError, SyntaxError, ValueError) as exc:
        fail([f"{type(exc).__name__}: {exc}"])
        return 2
    lines = src.split("\n")

    module_funcs, module_names = {}, set()
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            module_funcs.setdefault(node.name, node)
            module_names.add(node.name)
        elif isinstance(node, ast.ClassDef):
            module_names.add(node.name)
        elif isinstance(node, ast.Assign):
            for t in node.targets:
                if isinstance(t, ast.Name):
                    module_names.add(t.id)
        elif isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name):
            module_names.add(node.target.id)

    problems, moved = [], []
    for s in symbols:
        n = module_funcs.get(s)
        if n is None:
            problems.append(f"{s}: not a module-level function")
        else:
            moved.append(n)
    if problems:
        fail(problems)
        return 0
    # Mutual exclusivity with flask-blueprint moves: a route view has a real URL and
    # belongs in a Blueprint, not a plain helper module.
    routed = [n.name for n in moved if any(decorator_is_app_route(d) for d in n.decorator_list)]
    if routed:
        fail([f"{', '.join(routed)}: @app.route view(s) belong in a flask-blueprint move, not python-module-extract"])
        return 0

    moved_names = {n.name for n in moved}
    moved_lines = set()
    for n in moved:
        lo, hi = span(n)
        moved_lines.update(range(lo, hi + 1))

    strays = {}
    for node in ast.walk(tree):
        if isinstance(node, ast.Name) and node.id in moved_names and node.lineno not in moved_lines:
            strays.setdefault(node.id, []).append(node.lineno)
    if strays:
        fail([f"{s} is still referenced at line(s) {sorted(set(v))} outside the moved symbols"
              for s, v in strays.items()])
        return 0

    import_line_for = {}
    for node in tree.body:
        if isinstance(node, (ast.Import, ast.ImportFrom)):
            line = "\n".join(lines[node.lineno - 1:node.end_lineno])
            for a in node.names:
                bound = a.asname or a.name
                if isinstance(node, ast.Import):
                    bound = bound.split(".")[0]
                import_line_for[bound] = line

    shared_deps = {}
    needed_import_lines, seen = [], set()
    for n in moved:
        local_bound, read = set(), set()
        for stmt in n.body:
            for sub in ast.walk(stmt):
                if isinstance(sub, ast.Name):
                    (local_bound if isinstance(sub.ctx, ast.Store) else read).add(sub.id)
                elif isinstance(sub, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                    local_bound.add(sub.name)
                elif isinstance(sub, ast.arg):
                    local_bound.add(sub.arg)
        # Same annotation gap decompose-blueprint-extract.py hardened for (2026-09-13): a
        # type annotation lives on n.returns / arg.annotation, not n.body -- a name used
        # only there was invisible here and crashed at def-time with a NameError.
        annotation_nodes = [n.returns] if n.returns else []
        for a in n.args.args + n.args.posonlyargs + n.args.kwonlyargs + ([n.args.vararg] if n.args.vararg else []) + ([n.args.kwarg] if n.args.kwarg else []):
            if a.annotation:
                annotation_nodes.append(a.annotation)
        for ann in annotation_nodes:
            for sub in ast.walk(ann):
                if isinstance(sub, ast.Name):
                    read.add(sub.id)
        for a in n.args.args + n.args.posonlyargs + n.args.kwonlyargs:
            local_bound.add(a.arg)
        if n.args.vararg:
            local_bound.add(n.args.vararg.arg)
        if n.args.kwarg:
            local_bound.add(n.args.kwarg.arg)
        shared_deps[n.name] = sorted(
            x for x in read
            if x in module_names and x not in moved_names
            and x not in local_bound and x not in BUILTIN_NAMES and x != "app")
        for x in sorted(read):
            if x in import_line_for and x not in local_bound and x not in BUILTIN_NAMES:
                il = import_line_for[x]
                if il not in seen:
                    seen.add(il)
                    needed_import_lines.append(il)

    all_deps = sorted({d for ds in shared_deps.values() for d in ds})

    header = []
    if needed_import_lines:
        header.extend(needed_import_lines)
        header.append("")
    if all_deps:
        header += [
            f"# The module-level names these functions read ({', '.join(all_deps)}) are",
            "# imported lazily inside each function: the source module imports THIS module,",
            "# so a top-level back-import would be circular. By call time the source module",
            "# is fully initialised and the import is just a dict lookup.",
            "",
        ]
    header.append("")

    fn_texts = []
    for n in moved:
        lo, hi = span(n)
        body = lines[lo - 1:hi]
        def_idx = next(i for i, x in enumerate(body)
                       if x.lstrip().startswith(("def ", "async def ")))
        insert_at = def_idx + 1
        fb = n.body[0] if n.body else None
        if (isinstance(fb, ast.Expr) and isinstance(getattr(fb, "value", None), ast.Constant)
                and isinstance(fb.value.value, str)):
            insert_at = (fb.end_lineno - lo) + 1
        deps = shared_deps[n.name]
        out = body
        if deps:
            module_name = path.rsplit("/", 1)[-1][:-3] if path.endswith(".py") else path
            out = body[:insert_at] + [f"    from {module_name} import {', '.join(deps)}"] + body[insert_at:]
        fn_texts.append("\n".join(out))

    new_content = "\n".join(header) + "\n\n\n".join(fn_texts) + "\n"

    spans = sorted((span(n) for n in moved), reverse=True)
    red = lines[:]
    for lo, hi in spans:
        end = hi
        while end < len(red) and red[end].strip() == "":
            end += 1
        del red[lo - 1:end]
    reduced = "\n".join(red)
    while "\n\n\n\n" in reduced:
        reduced = reduced.replace("\n\n\n\n", "\n\n\n")

    print(json.dumps({
        "ok": True,
        "newFileContent": new_content,
        "reducedSource": reduced,
        "sharedDeps": shared_deps,
        "movedCount": len(moved),
    }))
    return 0
```

Problem:
The `main` function orchestrates six distinct responsibilities: argument parsing, AST symbol extraction, symbol validation, dependency analysis, header construction, and source modification. These are not sequential or atomic — they involve branching logic, state mutation, and multiple error paths. The function’s length (over 100 lines) reflects not just code volume but cognitive complexity: a single change can ripple across unrelated concerns, making debugging and testing difficult. The scanner’s 100-line threshold is appropriate here because the function is a state machine with side effects, not just a linear script.

Solution:
Extract the six responsibilities into separate, named functions: `parse_args_and_validate`, `extract_module_symbols`, `validate_moved_symbols`, `analyze_dependencies`, `build_header_and_insert_code`, and `reduce_source_and_output`. Each function should handle one concern with clear inputs/outputs and early returns for errors. The main function becomes a thin orchestrator that calls these in order, passing context between them.

Benefits:
Decomposing the function improves readability by isolating concerns, enables unit testing for each phase independently, and reduces cognitive load during code reviews. New contributors can understand one piece at a time, and changes to one responsibility won’t risk breaking unrelated logic. The codebase becomes more maintainable and resilient to future changes.

VERDICT CONSTRAINT:
Genuine

### AC-5 · Decompose God Function into Orchestrator + Atomic Subtasks
Strength: Strong
Files: src/arch.js
Symbol: nextArchImportTask
Snippet:
```
const ARCH_IMPORT_RETRY_COOLDOWN_MS = 24 * 60 * 60 * 1000;

function nextArchImportTask({ getConfig, taskIdExistsInQueue }) {
  const { repoRoot, deepDiveAnalysisDir, deepDiveCoveragePath, importCoveragePath, defaultDomain } = getConfig();
  // Same convention nextDeepDiveTask()/nextProjectSearchTask() already use.
  const projectTag = path.basename(repoRoot);

  let entries;
  try {
    entries = fs.readdirSync(deepDiveAnalysisDir, { withFileTypes: true });
  } catch {
    return null; // no analysis dir yet -- nothing to promote
  }

  // Scoping fix (2026-07-27): an analysis doc only contributes candidates when
  // deep-dive-coverage.json says that external project was onboarded FOR this consumer
  // project. A doc with no recorded relevantToProject predates this fix and is excluded.
  let deepDiveCoverage;
  try {
    deepDiveCoverage = JSON.parse(readIfExists(deepDiveCoveragePath) || '{"projects":{}}');
  } catch {
    deepDiveCoverage = { projects: {} };
  }
  const relevantSlugs = new Set(
    Object.entries(deepDiveCoverage.projects || {})
      .filter(([, proj]) => proj.relevantToProject === projectTag)
      .map(([slug]) => slug),
  );

  let coverage;
  try {
    coverage = JSON.parse(readIfExists(importCoveragePath) || '{"items":{}}');
  } catch {
    coverage = { items: {} };
  }
  if (!coverage.items) coverage.items = {};

  let coverageChanged = false;
  const candidates = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    const projectSlug = entry.name.replace(/\.md$/, '');
    if (!relevantSlugs.has(projectSlug)) continue;
    const text = readIfExists(path.join(deepDiveAnalysisDir, entry.name));
    if (!text) continue;

    // Split on H2 ("## ") item headings -- drop index 0, the "# <project> -- Deep Dive" H1.
    const blocks = text.split(/(?=^## )/m).slice(1);
    for (const block of blocks) {
      const idMatch = block.match(/^\*\*ID:\*\*\s*(\S+)/m);
      if (!idMatch) continue;
      const itemId = idMatch[1];

      if (!(itemId in coverage.items)) {
        coverage.items[itemId] = { promotedAt: null, candidateId: null, projectSlug };
        coverageChanged = true;
      }
      const itemCoverage = coverage.items[itemId];
      if (itemCoverage.promotedAt) continue; // a REAL candidate was produced -- genuinely done
      if (itemCoverage.lastAttemptedAt && Date.now() - Date.parse(itemCoverage.lastAttemptedAt) < ARCH_IMPORT_RETRY_COOLDOWN_MS) continue;

      const ratingMatch = block.match(/^\*\*Rating:\*\*\s*(\S+)/m);
      const rating = ratingMatch ? ratingMatch[1] : '';
      if (rating !== 'Use' && rating !== 'Adapt') continue;

      const titleMatch = block.match(/^##\s*(.+)$/m);
      const filesMatch = block.match(/^\*\*Files:\*\*\s*(.+)$/m);
      const rationaleAnchor = filesMatch ? filesMatch[0] : idMatch[0];
      const rationale = block.slice(block.indexOf(rationaleAnchor) + rationaleAnchor.length).trim();

      candidates.push({
        itemId,
        projectSlug,
        title: titleMatch ? titleMatch[1].trim() : itemId,
        rating,
        files: filesMatch ? filesMatch[1].trim() : '',
        rationale,
      });
    }
  }

  if (coverageChanged) {
    fs.mkdirSync(path.dirname(importCoveragePath), { recursive: true });
    fs.writeFileSync(importCoveragePath, JSON.stringify(coverage, null, 2));
  }

  // Sort by itemId string only for a stable, reproducible pick across repeated calls, not
  // a claim of real chronological ordering across projects.
  candidates.sort((a, b) => a.itemId.localeCompare(b.itemId));

  for (const c of candidates) {
    const taskId = 'arch-import-' + c.itemId;
    if (taskIdExistsInQueue(taskId)) continue;

    return {
      id: taskId,
      domain: defaultDomain,
      source: 'arch_import',
      title: `Arch import: ${c.title} (from ${c.projectSlug})`,
      promptContext: {
        itemId: c.itemId,
        sourceProject: c.projectSlug,
        itemTitle: c.title,
        rating: c.rating,
        itemFiles: c.files,
        itemRationale: c.rationale,
      },
    };
  }

  return null;
}
```

Problem:
This function bundles five distinct responsibilities — config parsing, project relevance filtering, Markdown metadata extraction, coverage state management, candidate sorting, and task metadata generation — into a single monolithic flow. Each responsibility mutates state or depends on external data in ways that make unit testing impossible without mocking the entire function. The interleaving of error-handling branches (e.g., `coverageChanged`, `deepDiveCoverage`) and state mutations (`candidates`, `deepDiveCoverage`) creates cognitive overhead and increases the risk of subtle bugs when modifying one part without understanding the others.

Solution:
Extract five atomic functions:  
1. `getProjectRelevanceMap(config)` — returns relevant project slugs based on `deepDiveCoverage`.  
2. `parseAnalysisEntries(deepDiveDir, relevantSlugs)` — parses and filters analysis entries by relevance and metadata.  
3. `filterCandidatesByRatingAndCooldown(candidates, coverage, cooldownMs)` — filters candidates by rating and cooldown.  
4. `generateTaskMetadata(candidates, config)` — generates final task metadata or null.  
5. `orchestrateNextArchImportTask(config, deepDiveDir, cooldownMs)` — coordinates the above, managing state and error paths.

Benefits:
Decomposing this function makes each unit testable in isolation, reduces cognitive load for future maintainers, and allows incremental refactoring without risking cascading failures. The orchestrator can be mocked or stubbed easily, while each subtask can be reviewed and tested independently, improving both code quality and team velocity.

VERDICT CONSTRAINT:
Genuine

### AC-6 · Decompose Main Transformation Logic
Strength: Strong
Files: scripts/decompose-blueprint-extract.py
Symbol: main
Snippet:
```


def main(argv):
    if len(argv) < 5:
        fail(["usage: decompose-blueprint-extract.py <source.py> <bp_var> <bp_slug> <sym>..."])
        return 2
    path, bp_var, bp_slug, symbols = argv[1], argv[2], argv[3], argv[4:]
    try:
        src = open(path, "r", encoding="utf-8").read()
        tree = ast.parse(src, filename=path)
    except (OSError, SyntaxError, ValueError) as exc:
        fail([f"{type(exc).__name__}: {exc}"])
        return 2
    lines = src.split("\n")

    module_funcs, module_names = {}, set()
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            module_funcs.setdefault(node.name, node)
            module_names.add(node.name)
        elif isinstance(node, ast.ClassDef):
            module_names.add(node.name)
        elif isinstance(node, ast.Assign):
            for t in node.targets:
                if isinstance(t, ast.Name):
                    module_names.add(t.id)
        elif isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name):
            module_names.add(node.target.id)

    problems, moved = [], []
    for s in symbols:
        n = module_funcs.get(s)
        if n is None:
            problems.append(f"{s}: not a module-level function")
        else:
            moved.append(n)
    if problems:
        fail(problems)
        return 0
    # A blueprint move must carry at least one actual route (helpers may ride along, but a
    # blueprint with zero @app.route views is a nonsense split).
    if not any(any(decorator_is_app_route(d) for d in n.decorator_list) for n in moved):
        fail([f"none of {', '.join(symbols)} is an @app.route view -- not a blueprint move"])
        return 0

    moved_names = {n.name for n in moved}
    moved_lines = set()
    for n in moved:
        lo, hi = span(n)
        moved_lines.update(range(lo, hi + 1))

    strays = {}
    for node in ast.walk(tree):
        if isinstance(node, ast.Name) and node.id in moved_names and node.lineno not in moved_lines:
            strays.setdefault(node.id, []).append(node.lineno)
    if strays:
        fail([f"{s} is still referenced at line(s) {sorted(set(v))} outside the moved routes"
              for s, v in strays.items()])
        return 0

    import_line_for = {}
    for node in tree.body:
        if isinstance(node, (ast.Import, ast.ImportFrom)):
            line = "\n".join(lines[node.lineno - 1:node.end_lineno])
            for a in node.names:
                bound = a.asname or a.name
                if isinstance(node, ast.Import):
                    bound = bound.split(".")[0]
                import_line_for[bound] = line

    shared_deps = {}
    needed_import_lines, seen = [], set()
    flask_used = set()
    for n in moved:
        local_bound, read = set(), set()
        # Walk the BODY only, not decorator_list -- `@app.route` is rewritten to
        # `@<bp>.route`, so `app` from the decorator must not count as a body dependency.
        for stmt in n.body:
            for sub in ast.walk(stmt):
                if isinstance(sub, ast.Name):
                    (local_bound if isinstance(sub.ctx, ast.Store) else read).add(sub.id)
                elif isinstance(sub, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                    local_bound.add(sub.name)
                elif isinstance(sub, ast.arg):
                    local_bound.add(sub.arg)
        # Real incident, 2026-09-13: a return/param type annotation (`-> Path`, `x: dict`)
        # is NOT part of n.body -- it lives on n.returns / arg.annotation -- so a name used
        # ONLY in an annotation was invisible here, carried no import, and crashed at
        # def-time (`NameError: name 'Path' is not defined`) the moment app.py imported the
        # new module. Annotations can't assign (Store), so every Name found here is a read.
        annotation_nodes = [n.returns] if n.returns else []
        for a in n.args.args + n.args.posonlyargs + n.args.kwonlyargs + ([n.args.vararg] if n.args.vararg else []) + ([n.args.kwarg] if n.args.kwarg else []):
            if a.annotation:
                annotation_nodes.append(a.annotation)
        for ann in annotation_nodes:
            for sub in ast.walk(ann):
                if isinstance(sub, ast.Name):
                    read.add(sub.id)
        for a in n.args.args + n.args.posonlyargs + n.args.kwonlyargs:
            local_bound.add(a.arg)
        if n.args.vararg:
            local_bound.add(n.args.vararg.arg)
        if n.args.kwarg:
            local_bound.add(n.args.kwarg.arg)
        shared_deps[n.name] = sorted(
            x for x in read
            if x in module_names and x not in moved_names
            and x not in local_bound and x not in BUILTIN_NAMES and x != "app")
        for x in sorted(read):
            if x in FLASK_NAMES:
                flask_used.add(x)
            elif x in import_line_for and x not in local_bound and x not in BUILTIN_NAMES:
                il = import_line_for[x]
                if il not in seen:
                    seen.add(il)
                    needed_import_lines.append(il)

    all_deps = sorted({d for ds in shared_deps.values() for d in ds})
    flask_import = "from flask import Blueprint"
    if flask_used:
        flask_import += ", " + ", ".join(sorted(flask_used))

    header = [flask_import]
    if needed_import_lines:
        header.append("")
        header.extend(needed_import_lines)
    header += [
        "",
        f"# The app.py helpers these views call ({', '.join(all_deps) or 'none'}) are",
        "# imported lazily inside each view: app.py imports THIS module to register the",
        "# blueprint, so a top-level `from app import ...` is a circular import that only",
        "# fails when app.py is the entrypoint (how the dashboard runs). By the time a view",
        "# runs, app.py is fully initialised and the import is just a dict lookup. (Same",
        "# pattern as routes/concepts.py, routes/second_brain.py, routes/reports.py.)",
        "",
        f'{bp_var} = Blueprint("{bp_slug}", __name__)',
        "",
        "",
    ]

    fn_texts = []
    for n in moved:
        lo, hi = span(n)
        body = lines[lo - 1:hi]
        out = []
        for bl in body:
            stripped = bl.lstrip()
            if is_route_decorator_line(stripped):
                indent = bl[:len(bl) - len(stripped)]
                bl = indent + "@" + bp_var + stripped[len("@app"):]
            out.append(bl)
        def_idx = next(i for i, x in enumerate(out)
                       if x.lstrip().startswith(("def ", "async def ")))
        insert_at = def_idx + 1
        fb = n.body[0] if n.body else None
        if (isinstance(fb, ast.Expr) and isinstance(getattr(fb, "value", None), ast.Constant)
                and isinstance(fb.value.value, str)):
            insert_at = (fb.end_lineno - lo) + 1
        deps = shared_deps[n.name]
        if deps:
            out = out[:insert_at] + [f"    from app import {', '.join(deps)}"] + out[insert_at:]
        fn_texts.append("\n".join(out))

    new_content = "\n".join(header) + "\n\n\n".join(fn_texts) + "\n"

    spans = sorted((span(n) for n in moved), reverse=True)
    red = lines[:]
    for lo, hi in spans:
        end = hi
        while end < len(red) and red[end].strip() == "":
            end += 1
        del red[lo - 1:end]
    reduced = "\n".join(red)
    while "\n\n\n\n" in reduced:
        reduced = reduced.replace("\n\n\n\n", "\n\n\n")

    print(json.dumps({
        "ok": True,
        "newFileContent": new_content,
        "reducedSource": reduced,
        "sharedDeps": shared_deps,
        "movedCount": len(moved),
    }))
    return 0
```

Problem:
The function `main` is 182 lines long and performs at least eight distinct, tightly coupled responsibilities: argument validation, AST parsing, symbol validation, stray reference detection, import analysis, blueprint header construction, function body transformation, and JSON output generation. These phases are interleaved with branching logic and state mutations, making the function a single monolithic transformation pipeline. The length is not merely voluminous—it reflects real cognitive complexity, as each phase has unique invariants and edge cases. A human reviewer must mentally track state across multiple concerns, which is error-prone and hard to test.

Solution:
Extract the following into separate, single-responsibility functions: `validate_arguments`, `extract_module_symbols`, `validate_moved_symbols`, `detect_stray_references`, `analyze_imports_and_deps`, `construct_blueprint_header`, `transform_function_bodies`, and `generate_output`. Each should take a consistent state object and return a mutated state or a result. The main function becomes a coordinator that orchestrates these steps in order, passing state between them. No function should mutate global state or perform multiple unrelated tasks.

Benefits:
Decomposing this function improves testability, as each unit can be unit-tested in isolation. It also improves readability, since each function has a clear purpose and boundary. Reviewers can focus on one concern at a time, reducing cognitive load. Maintenance becomes easier: changes to one phase (e.g., import analysis) won’t risk breaking unrelated logic (e.g., decorator rewriting).

VERDICT CONSTRAINT:
Genuine
