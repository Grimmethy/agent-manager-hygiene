'use strict';

// deadcode-prefilter.js -- decide, WITHOUT a model call, whether a low-usage export flag is worth a triage draft, and re-admit one whose evidence changed.
//
// Why (2026-10-10): the scanner flags any export with <= 2 external call sites (unused-export-scan.js LOW_USAGE_THRESHOLD), so a symbol with one import and one
// real use is always a candidate. PF-CP's first 7 hours: 53 triage drafts, all judged live. Replayed against history (scripts/replay-deadcode-prefilter.js), "has a
// production caller outside its own file" dismissed 52 of those 53 (PF) and 197 of 447 (TaxHarvest) and dismissed none of the 26 symbols the triage found genuinely
// dead (all had no production caller).
//
// A dismissal is a verdict on the EVIDENCE at the time, not on the symbol. Task ids are permanent (taskIdExistsInQueue), so before this a symbol triaged "alive"
// could never be looked at again when its last caller was removed. The fingerprint (the sorted caller files and their kinds, no line numbers) is stored in
// queue/dead-code-prefilter.json at every sighting; when it changes the symbol is re-admitted under a new id `<id>-r<fp8>`. A task that already existed before this
// ledger gets its CURRENT fingerprint recorded as a baseline (no re-triage of history); only later changes re-admit.
//
// A wrong dismissal can only delay a cleanup: removal still needs a triage verdict, a review and a human merge.
//
// AGENT_MANAGER_DEADCODE_PREFILTER=off|shadow|on (default shadow). off = behaviour exactly as before. shadow = every flag still becomes a task, stamped
// promptContext.prefilter = { prediction, fp } so the outcome can be compared (scripts/report-deadcode-prefilter.js). on = predicted dismissals are skipped, except a
// deterministic ~1-in-10 spot-check (hash of the fingerprint) that is still drafted. The generator is a fresh `node` per tick, so a mode change needs the workers
// restarted (their env is frozen at launch).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const LEDGER_NAME = 'dead-code-prefilter.json';
const SPOT_CHECK_MODULUS = 10;
const TEST_RE = /(?:\.test\.|\.spec\.|__tests__|\.stories\.|\/tests?\/|\/mocks?\/|\/fixtures?\/|\.d\.ts$|\/node_modules\/)/;

function prefilterMode() {
  const v = String(process.env.AGENT_MANAGER_DEADCODE_PREFILTER || 'shadow').toLowerCase();
  return v === 'off' || v === 'false' || v === '0' ? 'off' : v === 'on' || v === 'true' || v === '1' ? 'on' : 'shadow';
}

const norm = (p) => String(p || '').replace(/\\/g, '/');

// 'self' (inside the defining file), 'test' (test/story/mock/fixture/declaration code), 'dead-file' (itself flagged as a dead whole file), else 'production'.
function classifyCaller(file, definedIn, deadFiles = new Set()) {
  const f = norm(file);
  if (f === norm(definedIn)) return 'self';
  if (TEST_RE.test(`/${f}`)) return 'test';
  if (deadFiles.has(f)) return 'dead-file';
  return 'production';
}

// One entry per caller FILE (an import line and a use in the same file are one caller), sorted for a stable fingerprint.
function callerKinds(entry, deadFiles) {
  const kinds = new Map();
  for (const cs of Array.isArray(entry && entry.callSites) ? entry.callSites : []) {
    if (!cs || !cs.file) continue;
    kinds.set(norm(cs.file), classifyCaller(cs.file, entry.definedIn, deadFiles));
  }
  return [...kinds.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(([file, kind]) => ({ file, kind }));
}

function fingerprint(callers) {
  return crypto.createHash('sha1').update(callers.map((c) => `${c.file}:${c.kind}`).join('\n')).digest('hex').slice(0, 12);
}

const hasProductionCaller = (callers) => callers.some((c) => c.kind === 'production');
const isSpotCheck = (fp) => parseInt(fp.slice(0, 4), 16) % SPOT_CHECK_MODULUS === 0;

function ledgerPath(pipelineDir) { return path.join(pipelineDir, 'queue', LEDGER_NAME); }

function readLedger(pipelineDir) {
  try {
    const d = JSON.parse(fs.readFileSync(ledgerPath(pipelineDir), 'utf8'));
    return { seen: d && typeof d.seen === 'object' && d.seen ? d.seen : {}, dismissed: d && typeof d.dismissed === 'object' && d.dismissed ? d.dismissed : {} };
  } catch {
    return { seen: {}, dismissed: {} };
  }
}

// Atomic; a failed write is swallowed (the next tick then behaves as if nothing was recorded, never worse than before).
function writeLedger(pipelineDir, ledger) {
  try {
    const p = ledgerPath(pipelineDir);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const tmp = `${p}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(ledger, null, 2));
    fs.renameSync(tmp, p);
    return true;
  } catch {
    return false;
  }
}

// Pure decision for ONE symbol entry. `exists(id)` is taskIdExistsInQueue. Mutates `ledger`; returns { action: 'create'|'skip', id, stamp, dirty }.
function decide({ entry, taskId, exists, deadFiles, ledger, mode, now = new Date().toISOString() }) {
  const taken = exists(taskId);
  if (mode === 'off') return { action: taken ? 'skip' : 'create', id: taskId, stamp: null, dirty: false };

  const callers = callerKinds(entry, deadFiles);
  const fp = fingerprint(callers);
  const prod = hasProductionCaller(callers);
  const prediction = prod ? 'dismiss' : 'llm';
  const rec = ledger.seen[taskId];

  if (taken) {
    if (!rec) { ledger.seen[taskId] = { fp, at: now }; return { action: 'skip', id: taskId, stamp: null, dirty: true }; }   // baseline, no re-triage of history
    if (rec.fp === fp) return { action: 'skip', id: taskId, stamp: null, dirty: false };
    const id = `${taskId}-r${fp.slice(0, 8)}`;
    ledger.seen[taskId] = { fp, at: now };
    if (exists(id)) return { action: 'skip', id: taskId, stamp: null, dirty: true };
    return { action: 'create', id, stamp: { prediction, fp, readmitted: true, previousFp: rec.fp }, dirty: true };
  }

  if (mode === 'on' && prod && !isSpotCheck(fp)) {
    if (rec && rec.dismissed && rec.fp === fp) return { action: 'skip', id: taskId, stamp: null, dirty: false };   // unchanged since the last dismissal
    ledger.seen[taskId] = { fp, at: now, dismissed: true };
    ledger.dismissed[taskId] = { fp, callers, at: now };
    return { action: 'skip', id: taskId, stamp: null, dirty: true };
  }
  ledger.seen[taskId] = { fp, at: now };
  delete ledger.dismissed[taskId];
  return { action: 'create', id: taskId, stamp: { prediction, fp, ...(mode === 'on' && prod ? { spotCheck: true } : {}) }, dirty: true };
}

// Shadow-mode scorecard: tasks carrying promptContext.prefilter, compared with how the triage actually ended. truth: 'noop' = alive; a filed candidate
// that says "Strength: Strong" = DEAD; any other filed candidate = alive. Promotion to `on` needs MIN_SAMPLES decided predictions and zero DEAD among predicted dismissals.
const MIN_SAMPLES = 30;
function compareShadow(tasks) {
  const table = { dismissAlive: 0, dismissDead: 0, llmAlive: 0, llmDead: 0, undecided: 0, spotCheck: 0, readmitted: 0 };
  const deadDismissed = [];
  for (const t of tasks) {
    const st = t && t.promptContext && t.promptContext.prefilter;
    if (!st) continue;
    if (st.spotCheck) table.spotCheck += 1;
    if (st.readmitted) table.readmitted += 1;
    const done = t.terminalDisposition;
    if (!done) { table.undecided += 1; continue; }
    const m = /Strength:\s*([A-Za-z ]+)/.exec(t.implementResponse || '');
    const dead = done !== 'noop' && m && m[1].trim() === 'Strong';
    if (st.prediction === 'dismiss') { if (dead) { table.dismissDead += 1; deadDismissed.push(t.id); } else table.dismissAlive += 1; }
    else if (dead) table.llmDead += 1; else table.llmAlive += 1;
  }
  const decided = table.dismissAlive + table.dismissDead + table.llmAlive + table.llmDead;
  const promote = decided >= MIN_SAMPLES && table.dismissDead === 0;
  return { table, decided, deadDismissed, promote, minSamples: MIN_SAMPLES };
}

module.exports = {
  compareShadow, MIN_SAMPLES,
  prefilterMode, classifyCaller, callerKinds, fingerprint, hasProductionCaller, isSpotCheck, readLedger, writeLedger, decide,
  LEDGER_NAME, SPOT_CHECK_MODULUS, TEST_RE,
};
