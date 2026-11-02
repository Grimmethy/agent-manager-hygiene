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
