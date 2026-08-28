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

// ADR-0022 Stage B: register how observability_review / performance_review scanner rules
// are re-run against a file's current content, for agent-manager's staleness-fastpath.js
// deterministic recheck. Takes no deps -- imports the detectors from agent-manager core.
require('./src/deterministic-recheck.js').register();
