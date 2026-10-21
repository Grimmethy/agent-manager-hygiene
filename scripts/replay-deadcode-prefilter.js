#!/usr/bin/env node
'use strict';

// Replay the dead-code pre-filter rule against a pipeline's HISTORICAL triage outcomes, without touching it.
//   node scripts/replay-deadcode-prefilter.js <pipelineDir> [--confirmed-dead]
// Ground truth: terminalDisposition 'noop' = alive; a filed candidate whose text says "Strength: Strong" = genuinely dead; any other filed candidate (e.g.
// "Not actionable (false positive)") = alive. The rule's job is to dismiss only alive symbols; a dead one dismissed is the failure this exists to catch.
// Dead files default to the CURRENT whole-file flags (what the live generator uses); --confirmed-dead also adds files whose whole-file triage was Strong.

const fs = require('fs');
const path = require('path');
const pf = require('../src/deadcode-prefilter.js');

const pipelineDir = process.argv[2];
if (!pipelineDir) { console.error('usage: replay-deadcode-prefilter.js <pipelineDir> [--confirmed-dead]'); process.exit(2); }
const confirmed = process.argv.includes('--confirmed-dead');
const queue = path.join(pipelineDir, 'queue');

function listJson(dir) { try { return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => path.join(dir, f)); } catch { return []; } }
function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }

const doneDirs = [path.join(queue, 'done'), path.join(queue, 'done', '_archived_no_action')];
try { for (const m of fs.readdirSync(path.join(queue, 'done', '_archived'))) doneDirs.push(path.join(queue, 'done', '_archived', m)); } catch { /* none */ }
const tasks = doneDirs.flatMap(listJson).map(readJson).filter((t) => t && t.source === 'deadcode_triage');

const strength = (t) => { const m = /Strength:\s*([A-Za-z ]+)/.exec(t.implementResponse || ''); return m ? m[1].trim() : null; };
const flags = readJson(path.join(queue, 'dead-code-flags.json')) || [];
const deadFiles = new Set(flags.filter((e) => e && e.kind === 'file').map((e) => String(e.definedIn).replace(/\\/g, '/')));
if (confirmed) for (const t of tasks) if (t.terminalDisposition !== 'noop' && /whole-file/.test(t.title || '') && strength(t) === 'Strong') deadFiles.add(String((t.promptContext || {}).definedIn || ''));

const table = {};
const bad = [];
for (const t of tasks) {
  const pc = t.promptContext || {};
  const callers = pf.callerKinds({ definedIn: pc.definedIn, callSites: pc.callSites }, deadFiles);
  const prediction = pf.hasProductionCaller(callers) ? 'dismiss' : 'llm';
  const truth = t.terminalDisposition === 'noop' ? 'alive' : strength(t) === 'Strong' ? 'DEAD' : 'alive (filed not-actionable)';
  const key = `${truth} -> ${prediction}`;
  table[key] = (table[key] || 0) + 1;
  if (truth === 'DEAD' && prediction === 'dismiss') bad.push(t.title);
}
console.log(`${tasks.length} triage tasks in ${pipelineDir} (dead files: ${deadFiles.size}${confirmed ? ', incl. confirmed-dead' : ', current flags only'})`);
for (const [k, v] of Object.entries(table).sort()) console.log(`  ${k}: ${v}`);
const alive = Object.entries(table).filter(([k]) => k.startsWith('alive')).reduce((n, [, v]) => n + v, 0);
const saved = (table['alive -> dismiss'] || 0) + (table['alive (filed not-actionable) -> dismiss'] || 0);
console.log(`model calls the rule would save: ${saved} of ${tasks.length} (${tasks.length ? Math.round((100 * saved) / tasks.length) : 0}%); alive total ${alive}`);
console.log(`DEAD symbols wrongly dismissed: ${bad.length}${bad.length ? `\n  ${bad.join('\n  ')}` : ''}`);
process.exit(bad.length ? 1 : 0);
