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
