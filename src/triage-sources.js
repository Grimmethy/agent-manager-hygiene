'use strict';

// triage-sources.js -- registers performance_triage / observability_triage (see triage-gate.js). Kept out of the two parent modules so each parent
// only gains the one-line in-flight guard; registered AFTER them in register.js.

const { hygieneFamily } = require('./hygiene-family.js');
const { registerTriageSource } = require('./triage-gate.js');
const { nextPerformanceReviewTask } = require('./performance-review.js');
const { nextObservabilityReviewTask } = require('./observability-review.js');

function register(deps) {
  registerTriageSource(deps, {
    source: 'performance_triage',
    parent: 'performance_review',
    family: 'performance',
    titleWord: 'performance',
    nextParentTask: nextPerformanceReviewTask,
    nextArgs: (c) => ({ repoRoot: c.repoRoot, pipelineDir: c.pipelineDir, defaultDomain: c.defaultDomain, coveragePath: c.performanceCoveragePath }),
    hygieneFamilyEntry: hygieneFamily('performance'),
  });
  registerTriageSource(deps, {
    source: 'observability_triage',
    parent: 'observability_review',
    family: 'observability',
    titleWord: 'observability',
    nextParentTask: nextObservabilityReviewTask,
    nextArgs: (c) => ({ repoRoot: c.repoRoot, pipelineDir: c.pipelineDir, defaultDomain: c.defaultDomain, coveragePath: c.observabilityCoveragePath }),
    hygieneFamilyEntry: hygieneFamily('observability'),
  });
}

module.exports = { register };
