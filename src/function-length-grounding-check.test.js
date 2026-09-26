'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  runGroundingCheck, checkFalseNoGroundingClaim, extractSolution, parseGroundingVerdict,
} = require('./function-length-grounding-check.js');

// Real snippet shape from the incident this module fixes (local-draft.js:801's
// runPlanPass): the actual call site is runHarnessSearch(harnessKind, task, {...}).
const REAL_SNIPPET = [
  'async function runPlanPass(task, { maybeLocked, resolvedCallIsLocal }) {',
  '  const harnessKind = getRegisteredSource(resolveSourceName(task))?.harnessSearch;',
  '  if (harnessKind) {',
  '    await runHarnessSearch(harnessKind, task, { projectSearchFetch, archImportFetch });',
  '  }',
  '}',
].join('\n');

const task = (over = {}) => ({
  source: 'function_length_review',
  promptContext: { file: 'src/local-draft.js', line: 801, snippet: REAL_SNIPPET, ...over.promptContext },
  ...over,
});

// --- checkFalseNoGroundingClaim (the AC-431 shape, free deterministic check) -----------

test('checkFalseNoGroundingClaim flags a FALSE POSITIVE verdict that falsely claims no snippet was given', () => {
  const r = checkFalseNoGroundingClaim(task(), 'FALSE POSITIVE -- no grounding snippet or line-range evidence was provided for this finding.');
  assert.equal(r.verdict, 'ungrounded');
  assert.match(r.reason, /a real, non-empty function snippet was provided/);
});

test('checkFalseNoGroundingClaim does not flag when the claim is actually true (snippet really is empty)', () => {
  const r = checkFalseNoGroundingClaim(task({ promptContext: { snippet: '' } }), 'FALSE POSITIVE -- no grounding snippet or line-range evidence was provided.');
  assert.equal(r, null);
});

test('checkFalseNoGroundingClaim ignores a GENUINE verdict entirely (different shape, check 2 handles it)', () => {
  const r = checkFalseNoGroundingClaim(task(), '### AC-1 · title\nStrength: Strong\nno grounding evidence mentioned here either');
  assert.equal(r, null);
});

test('checkFalseNoGroundingClaim returns null when the verdict never claims missing grounding at all', () => {
  const r = checkFalseNoGroundingClaim(task(), 'FALSE POSITIVE -- this is a simple linear switch statement, not real complexity.');
  assert.equal(r, null);
});

// --- extractSolution --------------------------------------------------------------------

test('extractSolution pulls the Solution section out of a well-formed candidate block', () => {
  const body = [
    '### AC-1 · title',
    'Strength: Strong',
    'Files: src/x.js',
    '',
    'Problem:',
    'some problem text',
    '',
    'Solution:',
    'Extract `finalizePlanPass` to wrap `runHarnessSearch`.',
    '',
    'Benefits:',
    'more testable',
  ].join('\n');
  assert.equal(extractSolution(body), "Extract `finalizePlanPass` to wrap `runHarnessSearch`.");
});

test('extractSolution returns empty string for a malformed candidate with no Solution section', () => {
  assert.equal(extractSolution('### AC-1 · title\nStrength: Strong\nProblem:\nx'), '');
});

// --- parseGroundingVerdict ----------------------------------------------------------------

test('parseGroundingVerdict parses GROUNDED and NOT_GROUNDED, and treats non-conforming output as ok', () => {
  assert.deepEqual(parseGroundingVerdict('GROUNDED'), { verdict: 'ok' });
  assert.deepEqual(parseGroundingVerdict('NOT_GROUNDED -- the real function never calls finalizePlanPass'),
    { verdict: 'ungrounded', reason: 'the real function never calls finalizePlanPass' });
  assert.deepEqual(parseGroundingVerdict('some unrelated 3b noise'), { verdict: 'ok' });
  assert.deepEqual(parseGroundingVerdict(''), { verdict: 'ok' });
});

// --- runGroundingCheck end-to-end (mocked model call) ------------------------------------

test('runGroundingCheck: FALSE POSITIVE claiming no evidence when a real snippet exists is caught deterministically, no model call', async () => {
  let calls = 0;
  const call = async () => { calls += 1; return { response: 'GROUNDED' }; };
  const r = await runGroundingCheck(task(), 'FALSE POSITIVE -- no grounding snippet or line-range evidence was given.', { call });
  assert.equal(r.verdict, 'ungrounded');
  assert.equal(calls, 0, 'the deterministic check must short-circuit before any model call');
});

test('runGroundingCheck: a GENUINE candidate whose Solution the cheap model flags as contradicting the snippet is ungrounded', async () => {
  const implementResponse = [
    '### AC-1 · runPlanPass mixes harness search into the main body',
    'Strength: Strong',
    'Files: src/local-draft.js',
    '',
    'Problem:',
    'runPlanPass does too much.',
    '',
    'Solution:',
    'Extract `finalizePlanPass(plan, researchPlanTools)` to wrap the `runHarnessSearch` call.',
    '',
    'Benefits:',
    'more readable',
  ].join('\n');
  const call = async () => ({ response: "NOT_GROUNDED -- runHarnessSearch is called with (harnessKind, task, { projectSearchFetch, archImportFetch }), not researchPlanTools" });
  const r = await runGroundingCheck(task(), implementResponse, { call });
  assert.equal(r.verdict, 'ungrounded');
  assert.match(r.reason, /researchPlanTools/);
});

test('runGroundingCheck: a GENUINE candidate the cheap model finds correctly grounded passes through', async () => {
  const implementResponse = [
    '### AC-1 · title',
    'Strength: Strong',
    'Files: src/local-draft.js',
    '',
    'Problem:', 'p',
    '',
    'Solution:',
    'Extract a helper that wraps the existing `runHarnessSearch(harnessKind, task, { projectSearchFetch, archImportFetch })` call unchanged.',
    '',
    'Benefits:', 'b',
  ].join('\n');
  const call = async () => ({ response: 'GROUNDED' });
  const r = await runGroundingCheck(task(), implementResponse, { call });
  assert.deepEqual(r, { verdict: 'ok' });
});

test('runGroundingCheck skips the model call entirely for a FALSE POSITIVE/UNCERTAIN verdict that makes no missing-grounding claim', async () => {
  let calls = 0;
  const call = async () => { calls += 1; return { response: 'GROUNDED' }; };
  const r = await runGroundingCheck(task(), 'FALSE POSITIVE -- this is a simple linear config object, no real complexity.', { call });
  assert.deepEqual(r, { verdict: 'ok' });
  assert.equal(calls, 0);
});

test('runGroundingCheck is advisory: a throwing/failing model call never blocks the draft', async () => {
  const implementResponse = '### AC-1 · t\nStrength: Strong\nFiles: x\n\nProblem:\np\n\nSolution:\nExtract `foo`.\n\nBenefits:\nb';
  const call = async () => { throw new Error('model call timed out'); };
  const r = await runGroundingCheck(task(), implementResponse, { call });
  assert.equal(r.verdict, 'ok');
});

test('runGroundingCheck is a no-op when AGENT_MANAGER_FUNCTION_LENGTH_GROUNDING_CHECK=false', async () => {
  process.env.AGENT_MANAGER_FUNCTION_LENGTH_GROUNDING_CHECK = 'false';
  try {
    const call = async () => ({ response: 'NOT_GROUNDED -- anything' });
    const r = await runGroundingCheck(task(), 'FALSE POSITIVE -- no grounding snippet or line-range evidence given.', { call });
    assert.deepEqual(r, { verdict: 'ok' });
  } finally {
    delete process.env.AGENT_MANAGER_FUNCTION_LENGTH_GROUNDING_CHECK;
  }
});

test('runGroundingCheck returns ok for an empty/malformed implement response (nothing to check)', async () => {
  assert.deepEqual(await runGroundingCheck(task(), '', {}), { verdict: 'ok' });
  assert.deepEqual(await runGroundingCheck(task(), '### AC-1 · t\nStrength: Strong\nno solution section here', {}), { verdict: 'ok' });
});

test('runGroundingCheck returns ok when the task has no snippet at all to ground a GENUINE verdict against', async () => {
  let calls = 0;
  const call = async () => { calls += 1; return { response: 'NOT_GROUNDED -- x' }; };
  const implementResponse = '### AC-1 · t\nStrength: Strong\nFiles: x\n\nProblem:\np\n\nSolution:\nExtract `foo`.\n\nBenefits:\nb';
  const r = await runGroundingCheck(task({ promptContext: { snippet: null } }), implementResponse, { call });
  assert.deepEqual(r, { verdict: 'ok' });
  assert.equal(calls, 0);
});

// --- 2026-09-26: the prompt must show the whole function (10 of 12 blocked tasks had snippets clipped at 6000 chars) ---

const { buildGroundingCheckPrompt, snippetForPrompt, GROUNDING_SNIPPET_MAX_CHARS } = require('./function-length-grounding-check.js');

// Shape of function-length-agent-manager-src-system-report-js-207: a ~140-line function, ~8700 chars, whose END is the part the old clip cut off.
const longFunctionSnippet = () => {
  const body = Array.from({ length: 130 }, (_, i) => `  lines.push('## Section ${i} -- some fairly long line of report text so this function is realistically wide');`);
  return ['function renderMarkdown({ period, tasks }) {', "  const lines = [];", ...body, '', "  return lines.join('\\n');", '}'].join('\n');
};

test('the grounding prompt shows the END of a long function (the old 6000-char clip cut it off), with no partial-view note', () => {
  const snippet = longFunctionSnippet();
  assert.ok(snippet.length > 6000 && snippet.length < GROUNDING_SNIPPET_MAX_CHARS, `fixture is ${snippet.length} chars`);
  const prompt = buildGroundingCheckPrompt(task({ promptContext: { snippet } }), 'Extract a buildSections helper; renderMarkdown still returns lines.join.');
  assert.ok(prompt.includes("return lines.join('\\n');"), 'the return statement the model needs to see is in the prompt');
  assert.doesNotMatch(prompt, /continues past the end of the snippet/);
  assert.doesNotMatch(prompt, /complete text/, 'the prompt no longer promises a complete text it may not deliver');
});

test('a snippet carrying functionSnippet\'s truncation marker tells the model its view is partial', () => {
  const snippet = `${longFunctionSnippet().slice(0, 3000)}\n// ... [truncated for review: this function continues for 40 more line(s) not shown]`;
  const prompt = buildGroundingCheckPrompt(task({ promptContext: { snippet } }), 'sol');
  assert.match(prompt, /the function continues past the end of the snippet/);
  assert.match(prompt, /a claim about the unseen remainder is NOT a contradiction/);
});

test('a snippet longer than the cap is clipped AND flagged partial', () => {
  const huge = 'x'.repeat(GROUNDING_SNIPPET_MAX_CHARS + 500);
  const { text, partial } = snippetForPrompt(huge);
  assert.equal(partial, true);
  assert.ok(text.length < huge.length);
  assert.equal(snippetForPrompt('short').partial, false);
});

test('runGroundingCheck passes the full long-function snippet to the model call', async () => {
  const snippet = longFunctionSnippet();
  let seenPrompt = '';
  const call = async ({ prompt }) => { seenPrompt = prompt; return { response: 'GROUNDED' }; };
  const impl = '### AC-1 · Split renderMarkdown\nStrength: Strong\nFiles: src/system-report.js\nProblem:\nlong.\nSolution:\nKeep the final return lines.join.\nBenefits:\nsmaller.';
  const r = await runGroundingCheck(task({ promptContext: { snippet } }), impl, { call });
  assert.equal(r.verdict, 'ok');
  assert.ok(seenPrompt.includes("return lines.join('\\n');"));
});
