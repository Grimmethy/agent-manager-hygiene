'use strict';

// unused_export / deadcode_fix -- two-stage shape (2026-09-24, mirroring
// function_length_review/function_length_fix and arch_discovery/arch_review). Extracted
// from agent-manager's src/task-sources.js (2026-08-27, Phase 2). unused_export reads
// <pipelineDir>/queue/dead-code-flags.json (written by the sibling unused-export-scan.js
// CLI) and turns the oldest not-yet-in-flight entry into a judgment-verdict task --
// "genuine dead code vs. false positive (barrel re-export, factory pattern, ...)". A
// GENUINE verdict now writes a real, vetted `### AC-NNN` candidate to
// Docs/DEAD_CODE_CANDIDATES.md (directToMain: additive doc append, low-risk); deadcode_fix
// (the generic candidateFulfillment consumer) turns that candidate into a real removal
// diff on an agent/<id> branch a human merges. Before this, the verdict text was thrown
// away entirely by applyVerdictOnly -- even a confident "safe to remove" call had nowhere
// to go (see git history for the prior applyVerdictOnly-only shape).
//
// The task stamps source: 'deadcode_triage'; agent-manager's task-source-registry.js
// resolveSourceName() maps that back to the 'unused_export' registry key.

const { hygieneFamily } = require('./hygiene-family.js');
const path = require('path');
const fs = require('fs');
const { registerTaskSource, updateTaskSource, registerSourceAlias } = require('agent-manager/src/task-source-registry.js');
const { applyArchDiscoveryCandidates } = require('agent-manager/src/candidate-docs.js');
const { unusedExportPlanPrompt, unusedExportImplementPrompt, archReviewPlanPrompt, archReviewImplementPrompt } = require('agent-manager/src/prompts.js');
const { buildFlagInventory } = require('./flag-inventory.js');

function deadCodeCandidatesPath(repoRoot) {
  return process.env.AGENT_MANAGER_DEAD_CODE_CANDIDATES_PATH || path.join(repoRoot, 'Docs', 'DEAD_CODE_CANDIDATES.md');
}

const DEAD_CODE_REVIEW_GUIDANCE = 'This is a dead-code triage verdict for a low-usage export in OUR OWN project, NOT itself a code change. A valid draft is EXACTLY ONE of: (a) "GENUINE" + a correctly-formatted `### AC-NNN` candidate block (Strength: Strong / Files / Problem / Solution / Benefits) describing exactly what to remove; or (b) "FALSE POSITIVE" / "UNCERTAIN" + one short paragraph (2-4 sentences) explaining why, grounded in the call sites shown. There is deliberately NO diff, no code, and no "steps" here -- do NOT reject the draft for lacking them. REJECT only if: the draft refuses to reach a verdict ("a human should look", "cannot determine"); a GENUINE verdict\'s candidate block is malformed or missing a required section; a GENUINE verdict\'s Solution proposes removing something broader than this one symbol; or a FALSE POSITIVE/UNCERTAIN verdict\'s stated reason actually contradicts the call sites shown (e.g. claims a barrel re-export exists when none of the shown sites are one).';
const DEAD_CODE_REVIEW_COMPLETENESS_QUESTION = 'Does the draft reach a decisive GENUINE-or-FALSE-POSITIVE-or-UNCERTAIN verdict and, if GENUINE, is it followed by a well-formed `### AC-NNN` candidate block whose Solution is scoped to removing exactly this one symbol (and its real call sites, if any)?';

function slugifyForId(str) {
  return str.toLowerCase().replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '').replace(/[^a-z0-9]+/g, '-');
}
function readIfExists(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

function nextUnusedExportTask({ getConfig, taskIdExistsInQueue }) {
  const { pipelineDir, defaultDomain } = getConfig();
  const flagsPath = path.join(pipelineDir, 'queue', 'dead-code-flags.json');
  let entries;
  try {
    const raw = readIfExists(flagsPath);
    if (!raw) return null;
    entries = JSON.parse(raw);
  } catch {
    return null;
  }

  entries.sort((a, b) => new Date(a.scannedAt) - new Date(b.scannedAt));

  for (const entry of entries) {
    const taskId = `deadcode-${slugifyForId(entry.symbol)}-${slugifyForId(entry.definedIn)}`;
    if (taskIdExistsInQueue(taskId)) continue;

    return {
      id: taskId,
      domain: defaultDomain,
      source: 'deadcode_triage',
      title: `Triage dead-code candidate: ${entry.symbol} (defined in ${entry.definedIn}) — ${entry.callSites.length} call site(s) found`,
      promptContext: {
        symbol: entry.symbol,
        definedIn: entry.definedIn,
        callSites: entry.callSites,
        note: 'Judge genuine-dead vs false-positive (barrel/re-export, factory pattern, etc.). Use a majority-vote judgment, not a single verdict.',
      },
    };
  }

  return null;
}

// Read-only inventory for the dashboard's Hygiene tab (see flag-inventory.js). Same id formula as nextUnusedExportTask.
function unusedExportInventory({ pipelineDir, repoRoot, taskState }) {
  let entries;
  try { entries = JSON.parse(readIfExists(path.join(pipelineDir, 'queue', 'dead-code-flags.json')) || '[]'); } catch { entries = []; }
  const flags = (Array.isArray(entries) ? entries : []).map((e) => ({
    rule: 'unused-export', file: e.definedIn, line: 0, scannedAt: e.scannedAt,
    detail: `${e.symbol} -- ${(e.callSites || []).length} call site(s)`, _symbol: e.symbol,
  }));
  return buildFlagInventory({
    flags, projectTag: null, repoRoot, taskState,
    idFor: (f) => `deadcode-${slugifyForId(f._symbol)}-${slugifyForId(f.file)}`,
  });
}

function register({ getConfig, nextCandidateFulfillmentTask, taskIdExistsInQueue, taskPriority }) {
  registerTaskSource('unused_export', {
    hygieneFamily: hygieneFamily('unused_export'),
    priority: taskPriority('unused_export', 90),
    next: () => nextUnusedExportTask({ getConfig, taskIdExistsInQueue }),
    inventory: ({ taskState }) => {
      const { repoRoot, pipelineDir } = getConfig();
      return unusedExportInventory({ repoRoot, pipelineDir, taskState });
    },
    apply: ({ implementResponse }) => {
      const { repoRoot } = getConfig();
      return applyArchDiscoveryCandidates({
        implementResponse,
        candidatesPath: deadCodeCandidatesPath(repoRoot),
        docTitle: '# Dead Code Removal Candidates',
      });
    },
    // No emptyApproval (same reasoning as function_length_fix's own candidate-doc source):
    // a FALSE POSITIVE/UNCERTAIN verdict legitimately writes no candidate -- that's a real,
    // expected outcome here (applyArchDiscoveryCandidates returns {skipped:true} for it),
    // not something that needs an auto-approve exemption.
    directToMain: true, // additive candidate-doc append, same reasoning as arch_discovery/function_length_review
    reviewGuidance: DEAD_CODE_REVIEW_GUIDANCE,
    reviewCompletenessQuestion: DEAD_CODE_REVIEW_COMPLETENESS_QUESTION,
    // Grounds the reviewer in the same real call-site data the drafter saw -- same
    // reasoning as function_length_review's `groundingFields: ['snippet']`.
    groundingFields: ['callSites'],
    reportClass: 'benefit', // a surfaced, human-reviewed dead-code candidate is a real outcome (system-report.js)
  });
  updateTaskSource('unused_export', { buildPlanPrompt: unusedExportPlanPrompt, buildImplementPrompt: unusedExportImplementPrompt });
  // Generated tasks stamp source: 'deadcode_triage' (not 'unused_export') -- declare that
  // here rather than relying on agent-manager's legacy hardcoded fallback in
  // resolveSourceName(). Guarded: registerSourceAlias landed in agent-manager Stage A1;
  // an older core still has the hardcoded fallback, so this is belt-and-suspenders.
  if (typeof registerSourceAlias === 'function') registerSourceAlias('deadcode_triage', 'unused_export');

  // deadcode_fix -- consumer of unused_export's vetted candidates, generic
  // nextCandidateFulfillmentTask (same shared consumer arch_review/function_length_fix/
  // performance_fix all reuse). Priority higher (lower number) than unused_export's own
  // 90, same "consumer outranks its own generator" convention as every other review/fix
  // pair in this file (e.g. function_length_fix:72 vs function_length_review:80).
  registerTaskSource('deadcode_fix', {
    hygieneFamily: hygieneFamily('unused_export', { candidateDoc: true }),
    priority: taskPriority('deadcode_fix', 82),
    next: () => {
      const { repoRoot } = getConfig();
      return nextCandidateFulfillmentTask(deadCodeCandidatesPath(repoRoot), 'deadcode_fix');
    },
    // A vetted "safe to remove" candidate legitimately resolving to "nothing to change
    // after all" is rare -- an empty draft here is far more likely the model giving up or
    // the code having moved since triage. Reject -> retry -> block for a human, same
    // reasoning as function_length_fix's own no-emptyApproval comment.
    candidateFulfillment: true,
    // A single-symbol removal is already maximally scoped -- no reason to let it
    // recursively re-split (same reasoning/incident class as function_length_fix's
    // noCandidateSplit).
    noCandidateSplit: true,
    candidatesPath: () => deadCodeCandidatesPath(getConfig().repoRoot),
    candidateDocTitle: '# Dead Code Removal Candidates',
    reasoningTier: 'high',
    // NOT directToMain -- this is a real code deletion (the export and, potentially, its
    // call sites), so it gets the normal agent/<id> branch + human-merge path every other
    // actual code-editing fix source uses.
  });
  updateTaskSource('deadcode_fix', { buildPlanPrompt: archReviewPlanPrompt, buildImplementPrompt: archReviewImplementPrompt });
}

module.exports = { register, nextUnusedExportTask };
