'use strict';

// Entry point for AGENT_MANAGER_REGISTER_PATH. agent-manager's config.js ensureRegistered()
// require()s this once, for its side effect of registering every programming-hygiene task
// source with the shared task-source-registry.js singleton.
//
// Dependency direction is one-way: this plugin imports from agent-manager/src/*; core never
// imports back. The `agent-manager` dependency is a file: link (see package.json) and MUST
// resolve, via realpath, to the exact checkout core itself runs from -- otherwise this file
// would populate a *second*, separate registry object and the sources would never fire.
// `ls -la node_modules/agent-manager` must show a symlink; never run node with
// --preserve-symlinks.

const { getConfig } = require('agent-manager/src/config.js');
const { nextCandidateFulfillmentTask } = require('agent-manager/src/sdk/candidate-fulfillment.js');
const { taskIdExistsInQueue, taskPriority } = require('agent-manager/src/task-sources.js');

// The same injected-deps bag the three review modules expected when task-sources.js wired
// them in-tree (removed from task-sources.js in the same change that added this file).
const deps = { getConfig, nextCandidateFulfillmentTask, taskIdExistsInQueue, taskPriority };

require('./src/function-length-review.js').register(deps);
require('./src/observability-review.js').register(deps);
require('./src/performance-review.js').register(deps);
require('./src/arch.js').register(deps);
require('./src/unused-export.js').register(deps);
require('./src/change-review.js').register(deps);

// ADR-0022 Stage B: register how observability_review / performance_review scanner rules
// are re-run against a file's current content, for agent-manager's staleness-fastpath.js
// deterministic recheck. Takes no deps -- imports the detectors from agent-manager core.
require('./src/deterministic-recheck.js').register();

// File-decompose family (S4a of the hub-tasks extraction, 2026-09-24, moved here from
// agent-manager core -- see Docs/hub-tasks-extraction-plan.md in that repo). Not task
// sources (no .register(deps) call) -- these are the deterministic decompose builders and
// their watchdog sweeps, invoked directly by agent-manager's scripts/queue-watcher.sh
// (agent-manager-hygiene/src/<file>.js, resolved off AGENT_MANAGER_REGISTER_PATH the same
// way queue-watcher.sh already resolves file-length-scan.js).
//
// script-extract.js deliberately did NOT move here -- found live while verifying this
// move: scripts/extract-core-ui.js (a standalone agent-manager dev CLI, unrelated to the
// pipeline) requires it directly and can't depend on an optional plugin being installed.
// It stays in core and registers its own 'script-extract' kind there automatically
// (decompose-auto-merge.js / review-task.js already require it for other reasons). This
// repo's decompose-one-pass.js / decompose-node-module.js reach its buildExtraction /
// locateFunctions via `agent-manager/src/script-extract.js`, the normal plugin-depends-
// on-core direction.
//
// decompose-one-pass.js / decompose-node-module.js / decompose-flask-blueprint.js each
// call agent-manager's registerMechanicalMoveKind/registerDeterministicReview/
// registerDeterministicDraft as a module-load side effect -- requiring them here is how
// that registration actually reaches coordinator-sweep.js's / review-task.js's / local-
// draft.js's own one-shot processes (all three call agent-manager/src/config.js's
// ensureRegistered(), which requires this file).
// decompose-loop-autoroute.js / proactive-file-decompose-sweep.js / file-decompose-to-hub.js
// / decompose-move-determinism-backfill.js / file-decompose-plan-pass.js / hot-file-guard.js
// need no registration of their own -- queue-watcher.sh invokes them directly as their own
// `node <file>.js` processes -- but are required here too so a plain
// `require('agent-manager-hygiene')`-style load (or a future test harness) sees the whole
// family, and so a require-cycle among them never depends on load order.
require('./src/decompose-one-pass.js');
require('./src/decompose-node-module.js');
require('./src/decompose-flask-blueprint.js');
