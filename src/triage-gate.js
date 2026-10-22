'use strict';

// triage-gate.js -- performance_triage / observability_triage: narrow-verdict VARIANTS of performance_review / observability_review
// (agent-manager docs/design-notes/task-atomization-plugin.md, phase 2) shaped for the 8 GB RX 580 lane.
//
// Measured 2026-10-21 (src/replay-lab.js on worker-rx580, qwen3-vl:8b): the 8B fits these sources (p50 35-58 s, prompts under 2.5k tokens) and recalls
// every recorded real finding, but calls almost every recorded noop "genuine", and the free-form numbered plan sometimes truncates. So the variant asks
// ONE closed question -- real | false_positive | uncertain plus a one-line reason, as strict JSON -- and can only REMOVE work:
//   false_positive (enforce mode)  -> a suppression row (cause 'triage-gate'), so the scanner stops re-emitting that construct;
//   real / uncertain / shadow mode -> nothing is written; the finding stays in the backlog and the parent source reviews it on a big lane.
//
// The variant never rescans: it calls the parent's own next-task function (same flags backlog, snippet window, suppression checks) and relabels the
// task. The parent defers a finding while a fresh triage task for it is in flight (see triageInFlight), so the two never race on one finding.

const fs = require('fs');
const path = require('path');
const { recordSuppression } = require('./suppression-store.js');

const VERDICTS = new Set(['real', 'false_positive', 'uncertain']);
const REASON_MAX = 240;
// A triage task older than this no longer holds the parent back (the small lane may be down; findings must never strand).
const DEFER_MS = (() => {
  const n = Number(process.env.AGENT_MANAGER_TRIAGE_DEFER_SECS);
  return (Number.isFinite(n) && n > 0 ? n : 1800) * 1000;
})();

// shadow (default): record the verdict, write no suppression. enforce: false_positive writes a suppression. off: the sources emit nothing.
function triageMode(env = process.env) {
  const v = String(env.AGENT_MANAGER_TRIAGE_GATE || '').trim().toLowerCase();
  return v === 'enforce' || v === 'off' ? v : 'shadow';
}

// Strict: the whole text (an optional ```json fence aside) must be ONE object with exactly {verdict, reason}. Anything else is 'uncertain', never
// 'false_positive' -- a malformed answer can never hide a finding.
function parseTriageVerdict(text) {
  const bad = (why) => ({ verdict: 'uncertain', reason: why, valid: false });
  let s = String(text || '').trim();
  const fenced = s.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced) s = fenced[1].trim();
  if (!s.startsWith('{') || !s.endsWith('}')) return bad('no JSON object');
  let obj;
  try { obj = JSON.parse(s); } catch { return bad('invalid JSON'); }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return bad('not an object');
  const keys = Object.keys(obj).sort().join(',');
  if (keys !== 'reason,verdict') return bad('unexpected fields');
  if (typeof obj.verdict !== 'string' || !VERDICTS.has(obj.verdict)) return bad('unknown verdict');
  if (typeof obj.reason !== 'string' || !obj.reason.trim()) return bad('missing reason');
  return { verdict: obj.verdict, reason: obj.reason.trim().slice(0, REASON_MAX), valid: true };
}

const ANSWER_SHAPE = 'Answer with EXACTLY one JSON object and nothing else: {"verdict": "real" | "false_positive" | "uncertain", "reason": "<one sentence>"}';

function buildTriagePlanPrompt(task, { kind }) {
  const ctx = task.promptContext || {};
  return [
    `A deterministic scanner flagged a possible ${kind} issue. The scanner is a heuristic and false positives are common. Decide ONLY whether this specific code has the problem.`,
    '- "real": the code, as shown, has the concrete problem the scanner describes.',
    '- "false_positive": it does not (e.g. the loop is bounded and tiny, the call runs once at startup, the failure is deliberately ignored, the code is a test fixture).',
    '- "uncertain": the answer depends on something not shown here. Use this rather than guessing.',
    ANSWER_SHAPE,
    '',
    `Rule flagged: ${ctx.rule}`,
    ctx.file ? `File: ${ctx.file}:${ctx.line}` : '(repo-wide finding, not tied to one file)',
    `Scanner detail: ${ctx.detail}`,
    '',
    'SURROUNDING SOURCE:',
    ctx.snippet || '(no snippet available for this finding)',
  ].join('\n');
}

function buildTriageImplementPrompt(task, planText) {
  return [
    'Your answer above is final. Output it again as exactly one JSON object, unchanged in meaning.',
    '',
    planText,
    '',
    ANSWER_SHAPE,
  ].join('\n');
}

// parent task id -> triage task id: swap the leading '<family>-' for '<family>-triage-'.
function triageIdFor(parentId, family) {
  return parentId.startsWith(`${family}-`) ? `${family}-triage-${parentId.slice(family.length + 1)}` : `${family}-triage-${parentId}`;
}

// True when a triage task for this finding exists in a not-yet-finished stage and is younger than DEFER_MS.
function triageInFlight(pipelineDir, triageId, now = Date.now()) {
  const queueDir = path.join(pipelineDir, 'queue');
  const fresh = (p) => { try { return now - fs.statSync(p).mtimeMs < DEFER_MS; } catch { return false; } };
  let stages;
  try { stages = fs.readdirSync(queueDir, { withFileTypes: true }).filter((e) => e.isDirectory() && e.name !== 'done' && !e.name.startsWith('_')); } catch { return false; }
  for (const st of stages) {
    if (fresh(path.join(queueDir, st.name, `${triageId}.json`))) return true;
    if (st.name === 'drafting') {
      let subs = [];
      try { subs = fs.readdirSync(path.join(queueDir, 'drafting'), { withFileTypes: true }).filter((e) => e.isDirectory()); } catch { /* none */ }
      if (subs.some((e) => fresh(path.join(queueDir, 'drafting', e.name, `${triageId}.json`)))) return true;
    }
  }
  return false;
}

// The parent's taskIdExistsInQueue, extended so a finding is skipped while its triage task is queued or in flight (and done: a finished triage
// task has either suppressed the finding or left it for the parent, and the parent is what must look at it then -- so 'done' is NOT counted here).
function parentIdGuard({ taskIdExistsInQueue, pipelineDir, family }) {
  return (id) => taskIdExistsInQueue(id) || (triageMode() !== 'off' && triageInFlight(pipelineDir, triageIdFor(id, family)));
}

// Variant next(): ask the parent for its next eligible finding, treating a finding as taken if EITHER its parent id or its triage id exists anywhere
// (including done: one triage verdict per finding), then relabel.
function nextTriageTask({ nextParentTask, family, source, titleWord, args }) {
  if (triageMode() === 'off') return null;
  const taken = (id) => args.taskIdExistsInQueue(id) || args.taskIdExistsInQueue(triageIdFor(id, family));
  const t = nextParentTask({ ...args, taskIdExistsInQueue: taken });
  if (!t) return null;
  return {
    ...t,
    id: triageIdFor(t.id, family),
    source,
    title: `Triage gate: ${t.title}`,
    promptContext: { ...t.promptContext, triageOf: t.id },
  };
}

// apply(): see header. Returns the same {skipped, reason} shape the other prose-verdict sources use.
function applyTriage({ implementResponse, task, pipelineDir, mode = triageMode() }) {
  let parsed = parseTriageVerdict(implementResponse);
  if (!parsed.valid && task && task.planResponse) {
    const fromPlan = parseTriageVerdict(task.planResponse);
    if (fromPlan.valid) parsed = fromPlan;
  }
  const pc = (task && task.promptContext) || {};
  let suppressed = false;
  if (mode === 'enforce' && parsed.verdict === 'false_positive' && pc.snippet) {
    recordSuppression(pipelineDir, {
      rule: pc.rule, file: pc.file, snippet: pc.snippet, taskId: task && task.id, cause: 'triage-gate', at: new Date().toISOString(),
    });
    suppressed = true;
  }
  if (task) {
    task.triageVerdict = { verdict: parsed.verdict, reason: parsed.reason, valid: parsed.valid, mode, suppressed };
    task.reviewDisposition = suppressed ? 'dismissed' : 'inconclusive';
  }
  const note = `triage ${parsed.verdict}${parsed.valid ? '' : ' (unparsed)'} [${mode}${suppressed ? ', suppressed' : ''}]: ${parsed.reason}`;
  return { skipped: true, reason: note };
}

const REVIEW_GUIDANCE = 'This is a one-line triage verdict on a scanner flag, NOT a code change. A valid draft is EXACTLY one JSON object {"verdict": "real"|"false_positive"|"uncertain", "reason": "<one sentence>"} and nothing else. Reject prose, extra fields, a missing reason, or a verdict that contradicts the code snippet in the finding.';
const REVIEW_QUESTION = 'Is the draft exactly one JSON object with a verdict of real, false_positive or uncertain and a one-sentence reason that is consistent with the flagged code?';

// Registers one variant. parent: the original source name; family: the task-id family prefix of the parent's tasks.
function registerTriageSource(deps, { source, parent, family, titleWord, nextParentTask, nextArgs, hygieneFamilyEntry }) {
  const { registerTaskSource, updateTaskSource } = require('agent-manager/src/task-source-registry.js');
  const { getConfig, taskIdExistsInQueue, taskPriority } = deps;
  registerTaskSource(source, {
    hygieneFamily: hygieneFamilyEntry,
    variantOf: parent,
    priority: taskPriority(source, 79),
    modelProfile: 'brain-dump-cheap-local', // core's {backend:'local', think:false} profile: a closed JSON answer needs no reasoning trace
    next: () => nextTriageTask({ nextParentTask, family, source, titleWord, args: { ...nextArgs(getConfig()), taskIdExistsInQueue } }),
    apply: ({ implementResponse, task }) => applyTriage({ implementResponse, task, pipelineDir: getConfig().pipelineDir }),
    groundingFields: ['snippet'],
    advisoryProse: true,
    reviewGuidance: REVIEW_GUIDANCE,
    reviewCompletenessQuestion: REVIEW_QUESTION,
    reportClass: (task) => ((task.triageVerdict && task.triageVerdict.verdict === 'false_positive') ? 'filtering' : 'unclear'),
  });
  updateTaskSource(source, {
    buildPlanPrompt: (task) => buildTriagePlanPrompt(task, { kind: titleWord }),
    buildImplementPrompt: (task, planText) => buildTriageImplementPrompt(task, planText),
  });
}

module.exports = {
  VERDICTS, triageMode, parseTriageVerdict, buildTriagePlanPrompt, buildTriageImplementPrompt,
  triageIdFor, triageInFlight, parentIdGuard, nextTriageTask, applyTriage, registerTriageSource,
};
