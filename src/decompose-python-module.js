'use strict';

// decompose-python-module.js (2026-09-26, screaminggoatclubmt: "why hasn't the sweep been
// decomposing these files already?" -- traced to computeRoutelessSections in
// file-decompose-plan-pass.js excluding any non-route Python section from `candidates`
// entirely, before any grouping tier runs. For app.py specifically: 193 of 194 top-level
// symbols came back routeless, leaving zero candidates, so the plan pass returns null on
// every tick -- silently, with no ghost-debt escalation, since a null plan never even
// reaches a filed request).
//
// decompose-flask-blueprint.js's move is structurally wrong for this case: a Flask
// Blueprint needs a URL to register, and a bag of routeless helper functions has none.
// This is the plain sibling -- the Python analogue of decompose-node-module.js's CommonJS
// module-extract: pull the named top-level functions out verbatim into a plain .py module,
// no Blueprint object, no register_blueprint wiring, just imports. The AST work (same as
// decompose-blueprint-extract.py, minus every blueprint-specific step, plus an explicit
// rejection of any @app.route symbol -- that belongs in a flask-blueprint move instead)
// lives in scripts/decompose-python-module-extract.py; this module drives it and shapes
// the result into the same Group-B change set buildNodeModuleOnePassChanges produces, then
// hard-gates it with a real `py_compile`, same discipline as the blueprint path.

const os = require('os');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const PY_EXTRACT = path.join(__dirname, '..', 'scripts', 'decompose-python-module-extract.py');

// One move: run the Python extractor against `sourceText`, return the new module content
// + the reduced source, or a problem list.
function extractOne(sourceText, sourceFile, newFile, symbols) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'py-mod-extract-'));
  const srcPath = path.join(tmp, path.basename(sourceFile));
  try {
    fs.writeFileSync(srcPath, sourceText);
    let out;
    try {
      out = execFileSync('python3', [PY_EXTRACT, srcPath, ...symbols], {
        encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      const stdout = (e && e.stdout) || '';
      try { return JSON.parse(stdout); } catch { /* fall through */ }
      return { ok: false, problems: [`decompose-python-module-extract.py failed: ${String((e && e.stderr) || (e && e.message) || e).slice(0, 300)}`] };
    }
    let parsed;
    try { parsed = JSON.parse(out); } catch {
      return { ok: false, problems: [`decompose-python-module-extract.py produced non-JSON output: ${out.slice(0, 200)}`] };
    }
    // The script only ever sees the temp copy's path -- rewrite it back to the real name
    // (and its own derived module name) so a blocked-hub blockedReason reads cleanly and
    // the produced import line names the real module.
    if (Array.isArray(parsed.problems)) {
      const tmpRe = new RegExp(srcPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
      parsed.problems = parsed.problems.map((p) => String(p).replace(tmpRe, sourceFile));
    }
    if (parsed.ok && typeof parsed.newFileContent === 'string') {
      const realModule = path.basename(sourceFile, '.py');
      const tmpModule = path.basename(srcPath, '.py');
      parsed.newFileContent = parsed.newFileContent.split(`from ${tmpModule} import`).join(`from ${realModule} import`);
    }
    return parsed;
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}

/**
 * @returns {{ok:true, newContent:string, reduced:string, sharedDeps:object}|
 *           {ok:false, reason:string, problems?:string[]}}
 */
function buildPythonModuleExtraction(sourceText, sourceFile, newFile, symbols) {
  if (!/\.py$/.test(sourceFile || '')) return { ok: false, reason: 'source is not a .py file' };
  if (!/\.py$/.test(newFile || '')) return { ok: false, reason: 'target is not a .py file' };
  if (!Array.isArray(symbols) || !symbols.length) return { ok: false, reason: 'no symbols to move' };

  const r = extractOne(sourceText, sourceFile, newFile, symbols);
  if (!r || !r.ok) {
    return { ok: false, reason: (r && r.problems && r.problems.join('; ')) || 'extraction failed', problems: (r && r.problems) || [] };
  }
  return { ok: true, newContent: r.newFileContent, reduced: r.reducedSource, sharedDeps: r.sharedDeps || {} };
}

/**
 * The whole plan as one deterministic Group-B change set: N new plain modules + the
 * reduced source (spans removed, no wiring -- there is nothing to register), chained.
 *
 * @param {Array<{newFile:string, symbols:string[]}>} moves
 * @returns {{ok:true, changes:Array}|{ok:false, reason:string, problems?:string[]}}
 */
function buildPythonModuleOnePassChanges(sourceText, sourceFile, moves) {
  if (!/\.py$/.test(sourceFile || '')) return { ok: false, reason: 'source is not a .py file' };
  if (!Array.isArray(moves) || moves.length < 1) return { ok: false, reason: 'need at least one module move' };

  const creates = [];
  let cur = sourceText;
  for (const move of moves) {
    if (!move || !move.newFile || !Array.isArray(move.symbols) || !move.symbols.length) {
      return { ok: false, reason: `module move for ${move && move.newFile} is missing newFile / symbols` };
    }
    const one = buildPythonModuleExtraction(cur, sourceFile, move.newFile, move.symbols);
    if (!one.ok) return { ok: false, reason: `${move.newFile}: ${one.reason}`, problems: one.problems };
    creates.push({ mode: 'create', file: move.newFile, content: one.newContent });
    cur = one.reduced;
  }
  const changes = [...creates, { mode: 'edit', file: sourceFile, find: sourceText, replace: cur }];

  const compileErr = firstPyCompileError(changes);
  if (compileErr) return { ok: false, reason: `produced file does not pass \`python3 -m py_compile\` -- ${compileErr}` };

  return { ok: true, changes };
}

// Real `python3 -m py_compile` on every produced .py file, independent of the AST
// extractor and of this module's own splice logic -- same discipline
// decompose-flask-blueprint.js applies, same 2026-09-09 lesson (a builder that
// self-verifies can rubber-stamp its own bug).
function firstPyCompileError(changes) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'py-mod-pycheck-'));
  try {
    for (const ch of changes) {
      const body = ch.mode === 'create' ? ch.content : ch.replace;
      if (typeof body !== 'string' || !/\.py$/.test(ch.file)) continue;
      const fp = path.join(dir, `${path.basename(ch.file, '.py')}__check__.py`);
      fs.writeFileSync(fp, body);
      try {
        execFileSync('python3', ['-m', 'py_compile', fp], { stdio: ['ignore', 'ignore', 'pipe'], timeout: 20_000 });
      } catch (e) {
        const line = String((e && e.stderr) || (e && e.message) || e).split('\n').find((l) => /Error|error:/.test(l)) || 'compile failed';
        return `${ch.file}: ${line.trim().slice(0, 200)}`;
      }
    }
    return null;
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}

// Eligible for the deterministic one-pass path? Caller passes file-decompose-to-hub.js's
// validatePlan() result. Mirrors planIsFullyMechanicalNodeModule / ...Blueprint.
function planIsFullyMechanicalPythonModule(request, validation) {
  if (process.env.AGENT_MANAGER_DECOMPOSE_PY_MODULE === 'false') return false;
  if (!request || !/\.py$/.test(request.sourceFile || '')) return false;
  const moves = request.moves || [];
  if (moves.length < 1) return false;
  if (!moves.every((m) => m.kind === 'python-module-extract')) return false;
  const meta = (validation && validation.moveMeta) || [];
  return moves.every((_, i) => meta[i] && meta[i].pythonModuleApplyOk === true);
}

// Deterministic-review hook (S4a of the hub-tasks extraction, 2026-09-24,
// decompose-review-registry.js's own header has the full design) -- same shape as
// decompose-flask-blueprint.js's own registration, different kind name.
require('agent-manager/src/decompose-review-registry.js').registerDeterministicReview('python-module-decompose', {
  verify: (task, repoRoot) => require('agent-manager/src/decompose-review-registry.js').verifyOnePassStyleRederivation(
    task, repoRoot, (sourceText, sourceFile, moves) => buildPythonModuleOnePassChanges(sourceText, sourceFile, moves),
  ),
});

// Deterministic-draft hook, same shape as decompose-flask-blueprint.js's own registration.
require('agent-manager/src/deterministic-draft-registry.js').registerDeterministicDraft('python-module-decompose', {
  tryDraft: (task, attempt) => require('agent-manager/src/deterministic-draft-registry.js').runOnePassStyleDraft(
    task, attempt,
    (sourceText, sourceFile, moves) => buildPythonModuleOnePassChanges(sourceText, sourceFile, moves),
    (ctx) => {
      const symbolCount = ctx.moves.reduce((n, m) => n + (m.symbols || []).length, 0);
      return {
        label: 'deterministic python module decompose',
        plan: `Deterministic one-pass plain-module decomposition: ${ctx.moves.length} module(s), ${symbolCount} symbol(s), AST-extracted + py_compile-verified -- no model judgment needed.`,
        implementNote: `deterministic python module decompose (${ctx.moves.length} module(s), ${symbolCount} symbol(s), AST + py_compile)`,
        implementEvent: `deterministic python module decompose: ${symbolCount} symbol(s) into ${ctx.moves.length} module(s), no model call`,
      };
    },
  ),
});

module.exports = {
  buildPythonModuleExtraction,
  buildPythonModuleOnePassChanges,
  planIsFullyMechanicalPythonModule,
  firstPyCompileError,
};
