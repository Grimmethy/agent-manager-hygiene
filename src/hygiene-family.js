'use strict';

// hygiene-family.js -- which "family" each of this plugin's task sources belongs to, for the core dashboard's Hygiene tab.
//
// Core must not name plugin-owned sources (ADR-0022), so instead of core keeping a table of them, every source declares
// its own membership on its registration:  registerTaskSource('x', { ..., hygieneFamily: hygieneFamily('arch', { candidateDoc: true }) })
//   idPrefixes    task-id filename prefixes of the family's tasks (core reads only files that can belong to it)
//   candidateDoc  this source owns a Docs/*_CANDIDATES.md the tab inventories (its candidate ids are `<source-with-dashes>-ac-N`)
// A family's scanner-flag counts come from whichever member has an `inventory({ taskState })` hook.

const FAMILIES = {
  observability: { key: 'observability', label: 'Observability', order: 10, idPrefixes: ['observability-'] },
  performance: { key: 'performance', label: 'Performance', order: 20, idPrefixes: ['performance-'] },
  function_length: { key: 'function_length', label: 'Function length', order: 30, idPrefixes: ['function-length-'] },
  unused_export: { key: 'unused_export', label: 'Unused exports', order: 40, idPrefixes: ['deadcode-'] },
  arch: { key: 'arch', label: 'Architecture', order: 50, idPrefixes: ['arch-'] },
  change_review: { key: 'change_review', label: 'Change review', order: 60, idPrefixes: ['change-review-'] },
};

function hygieneFamily(key, { candidateDoc = false } = {}) {
  const f = FAMILIES[key];
  if (!f) throw new Error(`unknown hygiene family '${key}'`);
  return candidateDoc ? { ...f, candidateDoc: true } : { ...f };
}

module.exports = { hygieneFamily, FAMILIES };
