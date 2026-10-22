#!/usr/bin/env node
'use strict';

// triage-replay.js -- proof harness for the triage gate (src/triage-gate.js). Replays the PARENT source's recorded tasks through the gate's own two
// prompts (plan = the verdict, implement = the echo) on a named lane, with that lane's real model / numCtx / numBatch, and scores the verdicts by
// the pipeline's recorded outcome. Nothing is written to the queue, ledger or repo; the only output is a JSON report.
//
//   node scripts/triage-replay.js <performance_review|observability_review> --lane worker-rx580 [--limit 40] [--pipeline-dir DIR] [--out FILE]
//   AGENT_MANAGER_LANES_PATH=<scratch lanes.json> to replay with other numCtx/numBatch than the live lanes.json.
//
// Headline numbers (design note: score by recorded class, never overall agreement):
//   unsafe  = recorded POSITIVE (the pipeline acted on it) that the gate called false_positive. Must be 0 before enforce mode is considered.
//   filtered = recorded NOOP / DISMISSED that the gate called false_positive (work the big lanes no longer have to do).

const fs = require('fs');
const path = require('path');
const { buildCorpus } = require('agent-manager/src/replay-lab.js');
const { laneById } = require('agent-manager/src/lanes.js');
const { buildTriagePlanPrompt, buildTriageImplementPrompt, parseTriageVerdict } = require('../src/triage-gate.js');

const KIND = { performance_review: 'performance', observability_review: 'observability' };

async function generate(lane, prompt, numPredict) {
  const body = { model: lane.model, prompt, stream: false, keep_alive: '10m', options: { temperature: 0.4, num_predict: numPredict, num_ctx: lane.numCtx || 12288, ...(lane.numBatch ? { num_batch: lane.numBatch } : {}) } };
  const res = await fetch(`${lane.ollamaUrl.replace(/\/$/, '')}/api/generate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(600000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = await res.json();
  return { text: String(j.response || '').trim(), evalCount: j.eval_count || 0, promptCount: j.prompt_eval_count || 0 };
}

function laneFromEnv(id) {
  const l = laneById(id);
  if (!l) throw new Error(`unknown lane ${id}`);
  const env = l.env || {};
  return { id: l.id, model: env.LOCAL_MODEL || l.model, ollamaUrl: env.OLLAMA_URL || l.ollamaUrl, numCtx: Number(env.AGENT_MANAGER_LANE_NUM_CTX) || l.numCtx, numBatch: Number(env.AGENT_MANAGER_LANE_NUM_BATCH) || l.numBatch };
}

async function main() {
  const args = process.argv.slice(2);
  const get = (n, d) => { const i = args.indexOf(`--${n}`); return i === -1 ? d : args[i + 1]; };
  const source = args[0];
  if (!KIND[source]) throw new Error('first argument must be performance_review or observability_review');
  const lane = laneFromEnv(get('lane', 'worker-rx580'));
  const pipelineDir = get('pipeline-dir', process.env.AGENT_MANAGER_PIPELINE_DIR || process.cwd());
  const corpus = buildCorpus({ pipelineDir, source, limit: Number(get('limit', 40)) });
  const out = get('out', path.join(pipelineDir, 'replay-reports', `triage-${source}-${lane.id}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`));
  const rows = [];
  for (const [i, e] of corpus.entries.entries()) {
    const t0 = Date.now();
    let row = { id: e.id, klass: e.klass };
    try {
      const plan = await generate(lane, buildTriagePlanPrompt(e.task, { kind: KIND[source] }), 160);
      const impl = await generate(lane, buildTriageImplementPrompt(e.task, plan.text), 160);
      let v = parseTriageVerdict(impl.text);
      if (!v.valid) { const p = parseTriageVerdict(plan.text); if (p.valid) v = p; }
      row = { ...row, verdict: v.verdict, valid: v.valid, reason: v.reason, rawImplement: v.valid ? undefined : impl.text.slice(0, 300), evalTokens: plan.evalCount + impl.evalCount, promptTokens: plan.promptCount, ms: Date.now() - t0 };
    } catch (err) {
      row = { ...row, error: String(err.message || err).slice(0, 200), ms: Date.now() - t0 };
    }
    rows.push(row);
    console.error(`[${i + 1}/${corpus.entries.length}] ${e.klass} -> ${row.verdict || 'ERROR'} ${Math.round(row.ms / 1000)}s`);
  }
  const by = (k) => rows.filter((r) => r.klass === k);
  const pos = by('positive');
  const neg = rows.filter((r) => r.klass === 'noop' || r.klass === 'dismissed');
  const ms = rows.map((r) => r.ms).sort((a, b) => a - b);
  const summary = {
    source, lane: lane.id, model: lane.model, numCtx: lane.numCtx, numBatch: lane.numBatch, corpus: corpus.counts,
    positives: pos.length, unsafe: pos.filter((r) => r.verdict === 'false_positive').length,
    negatives: neg.length, filtered: neg.filter((r) => r.verdict === 'false_positive').length,
    invalid: rows.filter((r) => r.valid === false).length, errors: rows.filter((r) => r.error).length,
    verdicts: rows.reduce((a, r) => { a[r.verdict || 'error'] = (a[r.verdict || 'error'] || 0) + 1; return a; }, {}),
    msP50: ms[Math.floor(ms.length / 2)], msP95: ms[Math.min(ms.length - 1, Math.floor(ms.length * 0.95))],
  };
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), summary, rows }, null, 2));
  console.log(JSON.stringify(summary, null, 2));
  console.log(out);
}

main().catch((e) => { console.error(e.stack || e); process.exit(1); });
