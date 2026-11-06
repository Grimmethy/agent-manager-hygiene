'use strict';

// register.js -- wires every hygiene-family task source into agent-manager's shared
// task-source-registry. One place to load, one place to audit. Every family contributes
// its own register(deps) function; this file is just the orchestrator.
//
// Families wired here:
//   - function_length (function-length-review.js)
//   - observability (observability-review.js)
//   - performance (performance-review.js)
//   - param_count (param-count-review.js)
//
// The registry is a singleton keyed by the agent-manager package path, so requiring
// this file from any test or entry point registers every family exactly once.

const { registerTaskSource } = require('agent-manager/src/task-source-registry.js');
const { getConfig } = require('agent-manager/src/config.js');
const { nextCandidateFulfillmentTask, taskIdExistsInQueue, taskPriority } = require('agent-manager/src/task-sources.js');

const deps = { getConfig, nextCandidateFulfillmentTask, taskIdExistsInQueue, taskPriority };

// --- param_count_scan: flags functions with too many positional parameters ---
// Schema (per finding): { file, line, functionPath, paramCount, callSitePattern? }
// callSitePattern is optional and only present when HYGIENE_PARAM_COUNT_CALL_SITES is enabled.
registerTaskSource({
  name: 'param_count_scan',
  family: 'hygiene',
  stage: 'scan',
  reportClass: 'benefit',
  directToMain: false,
  candidateFulfillment: false,
  requireCodeShapeInCandidate: false,
  preValidateCitedPaths: false,
  groundedPromptFiles: false,
  buildPlanPrompt: (task) => {
    const ctx = task.promptContext;
    return [
      'A deterministic hygiene scanner flagged a function for parameter bloat in a project this pipeline is reviewing.',
      'File/line/functionPath/paramCount given below. Summarize the finding in one line: what the function does and why the param count is a problem.',
      'Do NOT propose code changes -- this is a scan-only finding, not a review.',
      '',
      `File: ${ctx.file}:${ctx.line}`,
      `Function: ${ctx.functionPath}`,
      `Param count: ${ctx.paramCount}`,
      ctx.callSitePattern ? `Call-site pattern: ${ctx.callSitePattern}` : null,
    ].filter(Boolean).join('\n');
  },
  buildVerdictPrompt: () => null,
  applyVerdict: () => {},
});

// --- param_count_review: judges genuine vs. false positive for param-count flags ---
// Schema (per result): { file, line, functionPath, paramCount, isReal, reason }
registerTaskSource({
  name: 'param_count_review',
  family: 'hygiene',
  stage: 'review',
  reportClass: 'benefit',
  directToMain: true,
  candidateFulfillment: false,
  requireCodeShapeInCandidate: false,
  preValidateCitedPaths: false,
  groundedPromptFiles: false,
  buildPlanPrompt: (task) => {
    const ctx = task.promptContext;
    return [
      'This is a judgment call, NOT a code-change task (yet). A deterministic scanner flagged a function for parameter bloat in a project this pipeline is reviewing (file/line/functionPath/paramCount given below). Determine whether decomposing it is a GENUINE improvement or a false positive.',
      'Write a numbered PLAN that is actually a REASONED VERDICT:',
      '- "genuine — here why this param count is a real maintainability problem (e.g. the function takes on multiple responsibilities that could each be a named, independently-testable helper)"',
      '- "false positive — here why the param count itself is not a real problem (e.g. a thin wrapper around another function, generated code, or a callback signature that must match an external contract)"',
      '- "uncertain — here what would need to be checked that is not given here"',
      'A function having many params is not automatically a problem -- the scanner only counts them, it has no sense of whether the params reflect real complexity. Do not assume the scanner is right just because it flagged something.',
      '',
      `File: ${ctx.file}:${ctx.line}`,
      `Function: ${ctx.functionPath}`,
      `Param count: ${ctx.paramCount}`,
      `Scanner detail: ${ctx.detail || '(none)'}`,
      '',
      'THE FLAGGED FUNCTION (or a snippet if the scanner did not capture the whole body):',
      ctx.snippet || '(no snippet available for this finding)',
    ].join('\n');
  },
  buildVerdictPrompt: (task) => {
    const ctx = task.promptContext;
    return [
      'You already produced a verdict in the plan stage (genuine / false positive / uncertain). Confirm it or revise it based on the candidate document the implement stage produced.',
      'If the verdict is "genuine" and the candidate proposes a decomposition, verify the candidate actually reduces the param count on the flagged function and does not break callers.',
      'If the verdict is "false positive", explain why in one sentence and skip the candidate.',
      '',
      `Original verdict: ${ctx.verdict || '(none)'}`,
      `File: ${ctx.file}:${ctx.line}`,
      `Function: ${ctx.functionPath}`,
      `Param count: ${ctx.paramCount}`,
      ctx.candidateSnippet ? `\nCandidate document:\n${ctx.candidateSnippet}` : '',
    ].filter(Boolean).join('\n');
  },
  applyVerdict: (task, verdict) => {
    // param_count_review is direct-to-main: the verdict IS the output.
    // No candidate-doc append, no fix task creation at this stage.
    return {
      verdict,
      directToMain: true,
    };
  },
});

// --- function_length (already wired by function-length-review.js) ---
require('./function-length-review.js').register(deps);

// --- observability (already wired by observability-review.js) ---
require('./observability-review.js').register(deps);

// --- performance (already wired by performance-review.js) ---
require('./performance-review.js').register(deps);

module.exports = {};
