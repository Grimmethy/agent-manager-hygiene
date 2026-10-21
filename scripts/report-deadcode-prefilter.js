#!/usr/bin/env node
'use strict';

// Shadow-mode scorecard for the dead-code pre-filter: how its predictions (promptContext.prefilter) compare with how each triage actually ended.
//   node scripts/report-deadcode-prefilter.js <pipelineDir>
// Exit 0 = ready to switch AGENT_MANAGER_DEADCODE_PREFILTER to `on` (enough decided samples and no dead symbol predicted dismissed); 1 = not yet.

const fs = require('fs');
const path = require('path');
const { compareShadow, readLedger } = require('../src/deadcode-prefilter.js');

const pipelineDir = process.argv[2];
if (!pipelineDir) { console.error('usage: report-deadcode-prefilter.js <pipelineDir>'); process.exit(2); }
const doneDir = path.join(pipelineDir, 'queue', 'done');
const tasks = [];
for (const f of (() => { try { return fs.readdirSync(doneDir); } catch { return []; } })()) {
  if (!f.endsWith('.json')) continue;
  try { const t = JSON.parse(fs.readFileSync(path.join(doneDir, f), 'utf8')); if (t && t.source === 'deadcode_triage') tasks.push(t); } catch { /* skip unreadable */ }
}
const r = compareShadow(tasks);
const l = readLedger(pipelineDir);
console.log(`prefilter scorecard for ${pipelineDir}`);
console.log(`  predicted dismiss -> alive: ${r.table.dismissAlive}   dismiss -> DEAD: ${r.table.dismissDead}`);
console.log(`  predicted model   -> alive: ${r.table.llmAlive}   model   -> DEAD: ${r.table.llmDead}`);
console.log(`  undecided: ${r.table.undecided}  spot-checks: ${r.table.spotCheck}  re-admitted: ${r.table.readmitted}`);
console.log(`  ledger: ${Object.keys(l.seen).length} symbol(s) seen, ${Object.keys(l.dismissed).length} dismissed`);
console.log(`  decided samples: ${r.decided} (need ${r.minSamples}); dead symbols predicted dismissed: ${r.deadDismissed.length}${r.deadDismissed.length ? ` [${r.deadDismissed.join(', ')}]` : ''}`);
console.log(r.promote ? '  READY to switch to `on`.' : '  NOT ready to switch to `on`.');
process.exit(r.promote ? 0 : 1);
