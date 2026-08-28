'use strict';

// Architecture task sources -- arch_discovery, arch_review, arch_import, arch_import_review.
// Extracted from agent-manager's src/task-sources.js + src/apply-group-a.js (2026-08-27,
// Phase 2 of the hygiene-plugin split). Wired via register(deps) from ../register.js with
// the injected-deps bag; imports only already-public agent-manager extension points.
//
// arch_review / arch_import_review are consumers of agent-manager's own
// nextCandidateFulfillmentTask (which stays in core -- backlog_fulfillment uses it too),
// pointed at the arch / arch-import candidate docs. arch_discovery / arch_import are the
// generators, each with a deterministic no-LLM apply that appends to the candidate doc
// (via candidate-docs.js's applyArchDiscoveryCandidates, shared with core).
//
// arch-discovery-structcheck.js and arch-import-fetch.js stay in agent-manager core:
// the structcheck is invoked by the worker as a subprocess by hardcoded path, and
// arch-import-fetch is a repo-search harness shared with non-hygiene self-audit sources.

const fs = require('fs');
const path = require('path');
const { registerTaskSource, updateTaskSource } = require('agent-manager/src/task-source-registry.js');
const { applyArchDiscoveryCandidates } = require('agent-manager/src/candidate-docs.js');
const { writeJsonAtomicSync } = require('agent-manager/src/atomic-write.js');
const {
  archReviewPlanPrompt, archReviewImplementPrompt,
  archDiscoveryPlanPrompt, archDiscoveryImplementPrompt,
  archImportPlanPrompt, archImportImplementPrompt,
} = require('agent-manager/src/prompts.js');

// Review-gate guidance for the two arch generators, read by agent-manager's review-task.js
// buildVerdictPrompt off source.reviewGuidance (ADR-0022 Stage A2: the plugin that defines
// the work defines how its draft is judged). Core keeps a byte-identical FALLBACK_REVIEW_GUIDANCE
// for these two names so its gate stays correct when this plugin isn't loaded; that fallback
// goes away in Stage G once this field is the only source.
const ARCH_DISCOVERY_REVIEW_GUIDANCE = 'This is an architecture-discovery task: finding ZERO real issues in the given files is a valid, EXPECTED, and often correct outcome -- do not reject a draft merely for concluding there is nothing worth flagging. Only reject an empty result if the draft itself looks like it never actually engaged with the given file content (e.g. generic boilerplate with no reference to anything specific in the files).';
const ARCH_IMPORT_REVIEW_GUIDANCE = "This is an architecture-import task (an idea from an external project, being checked against agent-manager's own code): the drafter was told to output nothing if the harness search found no real agent-manager files this idea concretely applies to -- do not reject an empty result on that basis alone. Reject only if the draft names a file the harness search results do NOT show, or proposes something contradicted by the real file content given.";

// Tiny helpers duplicated from task-sources.js (which keeps them unexported) rather than
// reached across a module boundary -- same convention the maintenance modules follow.
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

// --- Source: arch_discovery -- generates new candidates for one graphify community at a
// time (priority 80). Deliberately picked AFTER arch_review (the consumer): new candidates
// are only generated once there's nothing left to consume. The model has no filesystem
// access, so every real file this needs is read here and embedded verbatim into
// promptContext. Budget was 60000, cut to ~2x local-client.js's num_ctx=8192 default which
// arch_discovery's plan call never overrides.
const ARCH_DISCOVERY_CONTEXT_BUDGET_CHARS = 24000;

function nextArchDiscoveryTask({ getConfig, taskIdExistsInQueue }) {
  const { repoRoot, communityCoveragePath, graphPath, archReviewCandidatesPath, defaultDomain } = getConfig();
  const coverageText = readIfExists(communityCoveragePath);
  if (!coverageText) return null;

  let coverage;
  try {
    coverage = JSON.parse(coverageText);
  } catch {
    return null;
  }
  if (!coverage || !Array.isArray(coverage.communities) || coverage.communities.length === 0) return null;

  // Oldest lastReviewedAt first; null (never reviewed) sorts before any real timestamp.
  const sorted = [...coverage.communities].sort((a, b) => {
    const at = a.lastReviewedAt ? Date.parse(a.lastReviewedAt) : -Infinity;
    const bt = b.lastReviewedAt ? Date.parse(b.lastReviewedAt) : -Infinity;
    return at - bt;
  });
  const chosen = sorted.find((c) => !taskIdExistsInQueue('arch-discovery-community-' + c.id));
  if (!chosen) return null; // every community already has an in-flight or terminal task

  const graphText = readIfExists(graphPath);
  if (!graphText) return null;

  let graph;
  try {
    graph = JSON.parse(graphText);
  } catch {
    return null;
  }
  if (!graph || !Array.isArray(graph.nodes) || !Array.isArray(graph.links)) return null;

  const memberNodes = graph.nodes.filter((n) => n.community === chosen.id);
  if (memberNodes.length === 0) return null;

  // Degree = how many times a node's id appears as EITHER end of ANY link in the whole
  // graph, not just links within this community -- a file's real architectural weight
  // includes its cross-community connections.
  const degreeByNodeId = {};
  for (const link of graph.links) {
    degreeByNodeId[link.source] = (degreeByNodeId[link.source] || 0) + 1;
    degreeByNodeId[link.target] = (degreeByNodeId[link.target] || 0) + 1;
  }

  const degreeByFile = {};
  for (const node of memberNodes) {
    if (!node.source_file) continue;
    degreeByFile[node.source_file] = (degreeByFile[node.source_file] || 0) + (degreeByNodeId[node.id] || 0);
  }
  const rankedFiles = Object.entries(degreeByFile).sort((a, b) => b[1] - a[1]);

  const files = [];
  let budgetUsed = 0;
  for (const [sourceFile, degree] of rankedFiles) {
    const content = readIfExists(path.join(repoRoot, sourceFile));
    if (content == null) continue; // skip unreadable/missing files, never throw
    if (budgetUsed + content.length > ARCH_DISCOVERY_CONTEXT_BUDGET_CHARS) break;
    files.push({ path: sourceFile, degree, content });
    budgetUsed += content.length;
  }

  const candidatesTail = readIfExists(archReviewCandidatesPath);
  const existingCandidatesTail = candidatesTail ? candidatesTail.slice(-4000) : '';

  return {
    id: 'arch-discovery-community-' + chosen.id,
    domain: defaultDomain,
    source: 'arch_discovery',
    title: 'Architecture discovery: ' + chosen.name,
    promptContext: {
      communityId: chosen.id,
      communityName: chosen.name,
      files,
      existingCandidatesTail,
    },
  };
}

// --- Source: arch_import -- promotes a deep_dive Use/Adapt finding into a real,
// agent-manager-grounded architecture candidate (priority 81, ADR-0020,
// docs/arch-import-pipeline.md). Scans every UsefulProjectIndex/analysis/<project>.md for
// **ID:**-tagged items not yet a key in import-coverage.json, adds them with
// promotedAt: null, then picks the oldest not-yet-promoted Use/Adapt item not already
// in-flight. ARCH_IMPORT_RETRY_COOLDOWN_MS stops the same just-attempted item being
// re-picked every tick while nothing about the codebase has changed.
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

// arch_import's apply step (ADR-0020): wraps applyArchDiscoveryCandidates (same
// markdown-candidate append, since the format is byte-compatible modulo the Source: line)
// plus stamping import-coverage.json's item entry. Only a REAL candidate (result.skipped
// === false) is terminal; a skip just records lastAttemptedAt so nextArchImportTask can
// retry it later. Moved here from agent-manager's apply-group-a.js (2026-08-27) -- only
// arch_import ever used it.
function applyArchImportCandidate({ implementResponse, candidatesPath, importCoveragePath, task }) {
  const { itemId, sourceProject } = task.promptContext;

  const result = applyArchDiscoveryCandidates({ implementResponse, candidatesPath, docTitle: '# Architecture Import Candidates' });

  let coverage;
  try {
    coverage = JSON.parse(fs.existsSync(importCoveragePath) ? fs.readFileSync(importCoveragePath, 'utf8') : '{"items":{}}');
  } catch {
    coverage = { items: {} };
  }
  if (!coverage.items) coverage.items = {};
  const nowIso = new Date().toISOString();
  coverage.items[itemId] = {
    promotedAt: result.skipped ? (coverage.items[itemId]?.promotedAt ?? null) : nowIso,
    candidateId: result.skipped ? (coverage.items[itemId]?.candidateId ?? null) : result.candidateIds[0],
    lastAttemptedAt: nowIso,
    projectSlug: sourceProject,
  };
  fs.mkdirSync(path.dirname(importCoveragePath), { recursive: true });
  writeJsonAtomicSync(importCoveragePath, coverage);

  return result;
}

function register({ getConfig, nextCandidateFulfillmentTask, taskIdExistsInQueue, taskPriority }) {
  // arch_review -- consumer of nextCandidateFulfillmentTask against arch_discovery's doc.
  // reasoningTier 'high': arch_review's low-tier implement pass has produced 0-char output
  // on its final retry live. candidatesPath is a lazy getter (getConfig() isn't callable
  // at module-load time) -- where a {"mode":"split"} implement response writes its
  // sub-candidates back.
  // No emptyApproval (2026-08-28): a fulfillment source consumes an already-Strong-rated
  // candidate -- an empty draft there means "I couldn't produce this fix" (model gave up,
  // couldn't locate the code, or the code moved), not "there was nothing to do". With
  // emptyApproval those silently auto-closed with no branch and no human (see retired
  // AC-25, whose target had moved to this plugin). Without it, an empty draft is rejected
  // -> retried -> eventually blocked for a human. emptyApproval stays on the arch_discovery
  // / arch_import GENERATORS below, where "found zero real issues" is a valid common outcome.
  registerTaskSource('arch_review', {
    priority: taskPriority('arch_review', 70),
    next: () => nextCandidateFulfillmentTask(getConfig().archReviewCandidatesPath, 'arch_review'),
    candidateFulfillment: true,
    candidatesPath: () => getConfig().archReviewCandidatesPath,
    candidateDocTitle: '# Architecture Review Candidates',
    reasoningTier: 'high',
  });
  updateTaskSource('arch_review', { buildPlanPrompt: archReviewPlanPrompt, buildImplementPrompt: archReviewImplementPrompt });

  // arch_import_review -- the OTHER consumer of nextCandidateFulfillmentTask, against
  // arch_import's own candidates doc. Priority 71: every stage's own consumer outranks its
  // own generator. Shares arch_review's plan/implement prompt pair.
  registerTaskSource('arch_import_review', {
    priority: taskPriority('arch_import_review', 71),
    next: () => nextCandidateFulfillmentTask(getConfig().archImportCandidatesPath, 'arch_import_review'),
    candidateFulfillment: true, // no emptyApproval -- see arch_review above
    candidatesPath: () => getConfig().archImportCandidatesPath,
    candidateDocTitle: '# Architecture Import Candidates',
    reasoningTier: 'high',
  });
  updateTaskSource('arch_import_review', { buildPlanPrompt: archReviewPlanPrompt, buildImplementPrompt: archReviewImplementPrompt });

  // arch_discovery -- generator. Custom apply: its implement pass outputs raw markdown
  // candidate write-ups, not Group B JSON, so without this apply-task.js's writeArtifact()
  // falls through to the generic JSON parser and every approved task fails apply.
  registerTaskSource('arch_discovery', {
    priority: taskPriority('arch_discovery', 80),
    next: () => nextArchDiscoveryTask({ getConfig, taskIdExistsInQueue }),
    apply: ({ implementResponse }) => {
      const { archReviewCandidatesPath } = getConfig();
      return applyArchDiscoveryCandidates({ implementResponse, candidatesPath: archReviewCandidatesPath });
    },
    emptyApproval: true,
    directToMain: true, // low-risk additive candidate-doc append -- commit straight to main, no throwaway branch
    reviewGuidance: ARCH_DISCOVERY_REVIEW_GUIDANCE,
    reportClass: 'benefit', // a surfaced, human-reviewed architecture candidate is a real outcome (system-report.js)
  });
  updateTaskSource('arch_discovery', { buildPlanPrompt: archDiscoveryPlanPrompt, buildImplementPrompt: archDiscoveryImplementPrompt });

  // arch_import -- generator. Same raw-markdown apply, plus the import-coverage.json stamp.
  registerTaskSource('arch_import', {
    priority: taskPriority('arch_import', 81),
    next: () => nextArchImportTask({ getConfig, taskIdExistsInQueue }),
    apply: ({ implementResponse, task }) => {
      const { archImportCandidatesPath, importCoveragePath } = getConfig();
      return applyArchImportCandidate({ implementResponse, candidatesPath: archImportCandidatesPath, importCoveragePath, task });
    },
    emptyApproval: true,
    directToMain: true, // see arch_discovery
    reviewGuidance: ARCH_IMPORT_REVIEW_GUIDANCE,
    reportClass: 'benefit', // see arch_discovery
  });
  updateTaskSource('arch_import', { buildPlanPrompt: archImportPlanPrompt, buildImplementPrompt: archImportImplementPrompt });
}

module.exports = {
  register,
  nextArchDiscoveryTask,
  nextArchImportTask,
  applyArchImportCandidate,
  ARCH_DISCOVERY_CONTEXT_BUDGET_CHARS,
  ARCH_IMPORT_RETRY_COOLDOWN_MS,
};
