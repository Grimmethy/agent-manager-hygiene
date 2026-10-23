'use strict';

// Unit tests for observability-scan.js, run against throwaway fixture files in a temp
// dir -- never against this repo's own source, since agent-manager deliberately has
// many intentional silent catches (see unused-export-scan.js's own use of them) that
// would make a self-scan noisy and this suite would then be asserting on content that
// legitimately changes over time.
//
// Run: node --test src/observability-scan.test.js  (or `npm test`)

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');
const {
  scanProject, findSilentCatchBlocks, findSilentExceptBlocks, findUnguardedLoops, findOtelNamingViolations,
  findMissingReservedAttributes, hasOtelDependency, isValidOtelName, classifyCatchConfidence,
} = require('./observability-scan.js');

function makeTempRepo() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'observability-scan-test-'));
}

function writeFixture(repoRoot, relPath, content) {
  const full = path.join(repoRoot, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  return full;
}

test('findSilentCatchBlocks flags a truly empty catch block', () => {
  const text = 'try {\n  risky();\n} catch {}\n';
  const findings = findSilentCatchBlocks(text, 'a.js');
  assert.equal(findings.length, 1);
  assert.equal(findings[0].rule, 'silent-catch-block');
  assert.match(findings[0].detail, /silently discarded/);
});

test('silent-catch findings carry blockStartLine/blockEndLine/bodyFingerprint for re-location', () => {
  const js = 'function f() {\n  try {\n    risky();\n  } catch (e) {\n    doNothing();\n    alsoNothing();\n  }\n}\n';
  const jf = findSilentCatchBlocks(js, 'a.js')[0];
  assert.equal(jf.line, 4);            // the `} catch (e) {` line
  assert.equal(jf.blockStartLine, 4);
  assert.equal(jf.blockEndLine, 7);    // the closing `}`
  assert.equal(jf.bodyFingerprint, 'doNothing(); alsoNothing();');

  const py = 'def f():\n    try:\n        risky()\n    except Exception:\n        pass\n    return 1\n';
  const pf = findSilentExceptBlocks(py, 'a.py')[0];
  assert.equal(pf.line, 4);            // the `except Exception:` line
  assert.equal(pf.blockStartLine, 4);
  assert.equal(pf.blockEndLine, 5);    // the `pass` line
  assert.equal(pf.bodyFingerprint, 'pass');
});

test('findSilentCatchBlocks does NOT flag a catch whose only content is a comment (documented no-op)', () => {
  const text = 'try {\n  risky();\n} catch (e) {\n  // ignore, this is fine\n}\n';
  const findings = findSilentCatchBlocks(text, 'a.js');
  assert.equal(findings.length, 0);
});

test('findSilentCatchBlocks does NOT flag a catch with a block-comment-only body', () => {
  const text = 'try {\n  risky();\n} catch (e) {\n  /* best-effort: cache warm is optional */\n}\n';
  assert.equal(findSilentCatchBlocks(text, 'a.js').length, 0);
});

test('findSilentCatchBlocks flags `catch { return <literal> }` at LOW confidence, not skipped entirely (2026-09-15)', () => {
  // Previously hard-skipped as "a deliberate on-failure-default convention" -- that is
  // exactly the shape of a real, confirmed bug (countRecentCompletions's
  // `catch { return 0; }` masked a genuine unreadable-directory error as "0
  // completions"). Still routed to LOW confidence (the same digest-batched triage
  // `return someFallbackVar` already used), not full-priority -- see the confidence-tier
  // tests below for that assertion; this test only confirms the finding now exists.
  assert.equal(findSilentCatchBlocks('try { a() } catch (e) {\n  return null;\n}\n', 'a.js').length, 1);
  assert.equal(findSilentCatchBlocks('try { a() } catch {\n  return [];\n}\n', 'a.js').length, 1);
  assert.equal(findSilentCatchBlocks('try { a() } catch {\n  return;\n}\n', 'a.js').length, 1);
  const f = findSilentCatchBlocks('try { a() } catch {\n  return false\n}\n', 'a.js');
  assert.equal(f.length, 1);
  assert.equal(f[0].confidence, 'low');
});

test('findSilentCatchBlocks flags `catch { return someFallbackVar }` (identifier, not a literal) -- unchanged', () => {
  assert.equal(findSilentCatchBlocks('try { a() } catch {\n  return cached;\n}\n', 'a.js').length, 1);
});

// --- confidence tier ---------------------------------------------------------------------

test('silent-catch findings carry a confidence field; a truly empty body is HIGH', () => {
  const f = findSilentCatchBlocks('try { a() } catch {}\n', 'a.js');
  assert.equal(f[0].confidence, 'high');
});

test('classifyCatchConfidence: HIGH for empty / pass / a bare state mutation that just falls through', () => {
  const hi = (s, opts = {}) => classifyCatchConfidence({ stripped: s, text: opts.text || `x\ncatch {\n${s}\n}\n`, headerIndex: opts.text ? opts.headerIndex : 2, closeIndex: 999, isPython: !!opts.py });
  assert.equal(hi(''), 'high');
  assert.equal(hi('pass', { py: true }), 'high');
  assert.equal(hi('...', { py: true }), 'high');
  assert.equal(hi('this.missed = this.missed + 1'), 'high');
  assert.equal(hi('doNothing()'), 'high');
});

test('classifyCatchConfidence: LOW for a non-literal return / partial-result fallback', () => {
  const lo = (s) => classifyCatchConfidence({ stripped: s, text: `x\ncatch {\n${s}\n}\n`, headerIndex: 2, closeIndex: 999, isPython: false });
  assert.equal(lo('return this.cache'), 'low');
  assert.equal(lo('logSomething(); return result'), 'low');
  assert.equal(classifyCatchConfidence({ stripped: 'return partial', text: 'x', headerIndex: 1, closeIndex: 9, isPython: true }), 'low');
});

test('classifyCatchConfidence: LOW for a lone continue / break', () => {
  const c = (s) => classifyCatchConfidence({ stripped: s, text: `for(;;){try{}catch{\n${s}\n}}`, headerIndex: 12, closeIndex: 999, isPython: false });
  assert.equal(c('continue'), 'low');
  assert.equal(c('break;'), 'low');
});

test('classifyCatchConfidence: LOW for a catch that is the terminal clause of try/catch/finally (JS)', () => {
  const text = 'try {\n  a();\n} catch (e) {\n  state = null;\n} finally {\n  cleanup();\n}\n';
  const openIdx = text.indexOf('{', text.indexOf('catch'));
  const body = '\n  state = null;\n';
  const closeIndex = openIdx + 1 + body.length;
  assert.equal(classifyCatchConfidence({ stripped: 'state = null;', text, headerIndex: text.indexOf('catch'), closeIndex, isPython: false }), 'low');
});

test('classifyCatchConfidence: LOW when the enclosing name / a comment signals best-effort', () => {
  const named = 'function safeParse(s) {\n  try { return JSON.parse(s) } catch {\n    x = 1;\n  }\n}\n';
  assert.equal(classifyCatchConfidence({ stripped: 'x = 1;', text: named, headerIndex: named.indexOf('catch'), closeIndex: 999, isPython: false }), 'low');
  const commented = '// best-effort cache warm\ntry { warm() } catch {\n  y = 2;\n}\n';
  assert.equal(classifyCatchConfidence({ stripped: 'y = 2;', text: commented, headerIndex: commented.indexOf('catch'), closeIndex: 999, isPython: false }), 'low');
});

test('confidence tier kill switch: AGENT_MANAGER_OBSERVABILITY_CONFIDENCE_TIER=false -> everything HIGH', () => {
  const prev = process.env.AGENT_MANAGER_OBSERVABILITY_CONFIDENCE_TIER;
  process.env.AGENT_MANAGER_OBSERVABILITY_CONFIDENCE_TIER = 'false';
  delete require.cache[require.resolve('./observability-scan.js')];
  const scan = require('./observability-scan.js');
  try {
    const f = scan.findSilentCatchBlocks('try { a() } catch {\n  return cached;\n}\n', 'a.js');
    assert.equal(f[0].confidence, 'high');
  } finally {
    if (prev === undefined) delete process.env.AGENT_MANAGER_OBSERVABILITY_CONFIDENCE_TIER;
    else process.env.AGENT_MANAGER_OBSERVABILITY_CONFIDENCE_TIER = prev;
    delete require.cache[require.resolve('./observability-scan.js')];
  }
});

test('findSilentCatchBlocks skips test / fixture files', () => {
  const silent = 'try {\n  risky();\n} catch {}\n';
  assert.equal(findSilentCatchBlocks(silent, 'src/foo.test.js').length, 0);
  assert.equal(findSilentCatchBlocks(silent, 'pkg/tests/x.js').length, 0);
  assert.equal(findSilentCatchBlocks('try:\n    x()\nexcept Exception:\n    pass\n', 'a_test.py').length, 0);
});

test('findSilentCatchBlocks recognises widened error-surfacing tokens', () => {
  assert.equal(findSilentCatchBlocks("try { a() } catch (err) {\n  next(err);\n}\n", 'a.js').length, 0);
  assert.equal(findSilentCatchBlocks("try { a() } catch (err) {\n  reject(err);\n}\n", 'a.js').length, 0);
  assert.equal(findSilentCatchBlocks("try { a() } catch (e) {\n  Sentry.captureException(e);\n}\n", 'a.js').length, 0);
  assert.equal(findSilentCatchBlocks("try { a() } catch (e) {\n  toast('failed: ' + e.message);\n}\n", 'a.js').length, 0);
});

// --- .push(caughtId) collector form (2026-10-23) --------------------------------------------

test('findSilentCatchBlocks does NOT flag a catch that pushes the caught error into a collector (rejected-hub-disposition-backfill shape)', () => {
  // The exact shape from src/rejected-hub-disposition-backfill.js, whose CLI prints the
  // whole result as JSON -- pushing e.message into result.errors is a report, not a swallow.
  const text = 'function relabel(src) {\n  try {\n    doWork(src);\n  } catch (e) {\n    result.errors.push(`relabel-in-place(${src}): ${e.message}`);\n  }\n}\n';
  assert.equal(findSilentCatchBlocks(text, 'a.js').length, 0);
});

test('findSilentCatchBlocks does NOT flag a catch that pushes the caught identifier itself', () => {
  const text = 'try {\n  risky();\n} catch (e) {\n  errors.push(e);\n}\n';
  assert.equal(findSilentCatchBlocks(text, 'a.js').length, 0);
});

test('findSilentCatchBlocks STILL flags a .push() whose argument does not reference the caught identifier', () => {
  assert.equal(findSilentCatchBlocks('try {\n  risky();\n} catch (e) {\n  list.push(1);\n}\n', 'a.js').length, 1);
  assert.equal(findSilentCatchBlocks('try {\n  risky();\n} catch (e) {\n  list.push(unrelated);\n}\n', 'a.js').length, 1);
  // A push of an unrelated value plus a comment is just the previous case with noise:
  assert.equal(findSilentCatchBlocks('try {\n  risky();\n} catch (e) {\n  // accumulate for the CLI\n  list.push(1);\n}\n', 'a.js').length, 1);
});

test('a comment-only catch body is unaffected by the push check (existing documented no-op treatment)', () => {
  // A comment-only body is a documented, deliberate no-op (see isCommentOnlyBody and the
  // two "documented no-op" tests above); the new .push() check has no call to find there
  // and leaves that behaviour exactly as it was.
  assert.equal(findSilentCatchBlocks('try {\n  risky();\n} catch (e) {\n  // intentional: cache warm is best-effort\n}\n', 'a.js').length, 0);
});

test('the .push() collector form is JS-only: Python except-block handling is unchanged', () => {
  // findSilentExceptBlocks never consults the JS push/setter/helper checks -- behavior
  // for Python bodies is decided by the existing token list alone, exactly as before.
  assert.equal(findSilentExceptBlocks('try:\n    x()\nexcept Exception as e:\n    pass\n', 'a.py').length, 1);
  assert.equal(findSilentExceptBlocks('try:\n    x()\nexcept Exception:\n    raise\n', 'a.py').length, 0);
  assert.equal(findSilentExceptBlocks('try:\n    x()\nexcept Exception as e:\n    logging.exception(e)\n', 'a.py').length, 0);
});

test('findSilentExceptBlocks flags `except: return None` at LOW confidence, not skipped entirely (2026-09-15)', () => {
  // Same reasoning as the JS-side test above -- this shape is a real, confirmed bug
  // class, not a convention to hard-skip.
  const f = findSilentExceptBlocks('try:\n    x()\nexcept Exception:\n    return None\n', 'a.py');
  assert.equal(f.length, 1);
  assert.equal(f[0].confidence, 'low');
  assert.equal(findSilentExceptBlocks('try:\n    x()\nexcept Exception:\n    return\n', 'a.py').length, 1);
});

test('findSilentCatchBlocks does not flag a catch that logs the error', () => {
  const text = 'try {\n  risky();\n} catch (e) {\n  console.error(e);\n}\n';
  assert.equal(findSilentCatchBlocks(text, 'a.js').length, 0);
});

test('findSilentCatchBlocks does not flag a catch that rethrows', () => {
  const text = 'try {\n  risky();\n} catch (e) {\n  throw e;\n}\n';
  assert.equal(findSilentCatchBlocks(text, 'a.js').length, 0);
});

// --- Python ------------------------------------------------------------------------

test('findSilentCatchBlocks routes .py files to the except-block detector: bare "except: pass"', () => {
  const text = 'def f():\n    try:\n        risky()\n    except ValueError:\n        pass\n';
  const findings = findSilentCatchBlocks(text, 'a.py');
  assert.equal(findings.length, 1);
  assert.equal(findings[0].rule, 'silent-catch-block');
  assert.equal(findings[0].line, 4);
  assert.match(findings[0].detail, /silently discarded/);
});

test('findSilentExceptBlocks flags an except whose only content is "..." or a comment', () => {
  assert.equal(findSilentExceptBlocks('try:\n    x()\nexcept Exception:\n    ...\n', 'a.py').length, 1);
  assert.equal(findSilentExceptBlocks('try:\n    x()\nexcept Exception:\n    # not our problem\n    pass\n', 'a.py').length, 1);
});

test('findSilentExceptBlocks does not flag an except that logs or re-raises', () => {
  assert.equal(findSilentExceptBlocks('try:\n    x()\nexcept Exception as e:\n    logging.exception(e)\n', 'a.py').length, 0);
  assert.equal(findSilentExceptBlocks('try:\n    x()\nexcept Exception:\n    raise\n', 'a.py').length, 0);
  assert.equal(findSilentExceptBlocks('try:\n    x()\nexcept Exception:\n    traceback.print_exc()\n', 'a.py').length, 0);
});

test('findUnguardedLoops flags a Python `while True:` with no health signal nearby', () => {
  const text = 'def run():\n    while True:\n        do_work()\n        time.sleep(60)\n';
  const findings = findUnguardedLoops(text, 'worker.py');
  assert.equal(findings.length, 1);
  assert.equal(findings[0].rule, 'unguarded-long-running-loop');
});

test('findOtelNamingViolations recognises the snake_case (Python SDK) method names', () => {
  const text = "span.set_attribute('Bad.Name', 1)\nmeter.create_counter('requests_total')\n";
  const findings = findOtelNamingViolations(text, 'app.py');
  const details = findings.map((f) => f.detail).join(' | ');
  assert.match(details, /set_attribute\('Bad\.Name'\).*not lowercase/);
  assert.match(details, /create_counter\('requests_total'\).*_total/);
});

test('findUnguardedLoops flags a while(true) with no health signal nearby', () => {
  const text = 'function run() {\n  while (true) {\n    doWork();\n    sleep(60);\n  }\n}\n';
  const findings = findUnguardedLoops(text, 'worker.js');
  assert.equal(findings.length, 1);
  assert.equal(findings[0].rule, 'unguarded-long-running-loop');
});

test('findUnguardedLoops does not flag a while(true) that writes a heartbeat', () => {
  const text = 'function run() {\n  while (true) {\n    writeHeartbeat();\n    doWork();\n  }\n}\n';
  assert.equal(findUnguardedLoops(text, 'worker.js').length, 0);
});

test('isValidOtelName accepts a well-formed namespaced snake_case name', () => {
  assert.equal(isValidOtelName('http.server.request.duration'), null);
});

test('isValidOtelName rejects an uppercase name', () => {
  assert.match(isValidOtelName('Http.Server.Request'), /lowercase/);
});

test('isValidOtelName rejects camelCase segments', () => {
  assert.ok(isValidOtelName('http.serverRequest.duration'));
});

test('findOtelNamingViolations flags an uppercase attribute name', () => {
  const text = "span.setAttribute('Http.Method', 'GET');\n";
  const findings = findOtelNamingViolations(text, 'a.js');
  assert.equal(findings.length, 1);
  assert.equal(findings[0].rule, 'otel-naming-convention');
});

test('findOtelNamingViolations flags a counter using a _total suffix', () => {
  const text = "meter.createCounter('requests_total');\n";
  const findings = findOtelNamingViolations(text, 'a.js');
  assert.equal(findings.length, 1);
  assert.match(findings[0].detail, /_total/);
});

test('findOtelNamingViolations does not flag a well-formed span/metric name', () => {
  const text = "tracer.startSpan('http.server.request');\nmeter.createHistogram('http.server.request.duration');\n";
  assert.equal(findOtelNamingViolations(text, 'a.js').length, 0);
});

test('hasOtelDependency detects an @opentelemetry/* package.json dependency', () => {
  const repoRoot = makeTempRepo();
  writeFixture(repoRoot, 'package.json', JSON.stringify({ dependencies: { '@opentelemetry/api': '^1.0.0' } }));
  assert.equal(hasOtelDependency(repoRoot), true);
});

test('hasOtelDependency returns false when no OTel dependency marker is present', () => {
  const repoRoot = makeTempRepo();
  writeFixture(repoRoot, 'package.json', JSON.stringify({ dependencies: { express: '^4.0.0' } }));
  assert.equal(hasOtelDependency(repoRoot), false);
});

test('findMissingReservedAttributes flags only the reserved attributes absent from scanned source', () => {
  const repoRoot = makeTempRepo();
  const file = writeFixture(repoRoot, 'a.js', "const x = 'service.name';\n");
  const findings = findMissingReservedAttributes(repoRoot, [file]);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].rule, 'missing-reserved-attribute');
  assert.match(findings[0].detail, /error\.type/);
});

test('findMissingReservedAttributes reports nothing when every reserved attribute is present', () => {
  const repoRoot = makeTempRepo();
  const file = writeFixture(repoRoot, 'a.js', "const a = 'service.name'; const b = 'error.type';\n");
  assert.deepEqual(findMissingReservedAttributes(repoRoot, [file]), []);
});

test('scanProject combines catch/loop findings and skips OTel-only rules with no OTel dependency', () => {
  const repoRoot = makeTempRepo();
  writeFixture(repoRoot, 'package.json', JSON.stringify({ dependencies: {} }));
  writeFixture(repoRoot, 'worker.js', 'try {\n  risky();\n} catch {}\nwhile (true) {\n  doWork();\n}\n');

  const findings = scanProject(repoRoot, 'test-project');
  const rules = findings.map((f) => f.rule);
  assert.ok(rules.includes('silent-catch-block'));
  assert.ok(rules.includes('unguarded-long-running-loop'));
  assert.equal(rules.includes('otel-naming-convention'), false);
  assert.equal(rules.includes('missing-reserved-attribute'), false);
  for (const f of findings) {
    assert.equal(f.projectSlug, 'test-project');
    assert.equal(typeof f.scannedAt, 'string');
  }
});

test('scanProject runs the OTel-only rules when the project depends on an OpenTelemetry SDK', () => {
  const repoRoot = makeTempRepo();
  writeFixture(repoRoot, 'package.json', JSON.stringify({ dependencies: { '@opentelemetry/api': '^1.0.0' } }));
  writeFixture(repoRoot, 'app.js', "span.setAttribute('Bad.Name', 1);\n");

  const findings = scanProject(repoRoot, 'test-project');
  const rules = findings.map((f) => f.rule);
  assert.ok(rules.includes('otel-naming-convention'));
  assert.ok(rules.includes('missing-reserved-attribute'));
});

// State-setter error surfacing (2026-09-19, PF-Client-Portal): React handlers report a caught error by writing it to state the UI
// renders. Landing.tsx:209 and two digest findings were exactly this and each cost a review call to dismiss.
test('silent-catch-block: a state setter that reports the error counts as surfacing it', () => {
  const ok = [
    'try { a(); } catch (e) { setErrorMsg(e.message); setStatus("error"); }',   // Landing.tsx:209 shape
    'try { a(); } catch (e) { setErr(String(e)); }',
    'try { a(); } catch { setBulkMsg("could not save"); }',                       // error-ish name, literal message
    'try { a(); } catch (err) { setDetail(err.message); }',                       // handed the caught error
    'try { a(); } catch { setStatus("error"); }',                                 // error-status literal
    'try { a(); } catch (e) { setErr(fmt(e)); }',                                 // nested call args
    'try { a(); } catch (e) { setItems(prev => [...prev, e]); }',                 // caught error inside an arrow arg
    'try { a(); } catch (err: unknown) { setToast(String(err)); }',               // TS-annotated catch param
  ];
  for (const code of ok) assert.equal(findSilentCatchBlocks(code, 'src/x.tsx').length, 0, code);
});

test('silent-catch-block: a state RESET with no message, or a setter unrelated to the error, is still flagged', () => {
  const flagged = [
    'try { a(); } catch { setData(null); }',                                      // reset on failure, user told nothing
    'try { a(); } catch (e) { setResult(null); }',
    'try { a(); } catch (e) { client.logout(); setMe(null); }',
    'try { a(); } catch (e) { setErr(null); }',                                   // CLEARING an error is not reporting one
    'try { a(); } catch (e) { setErrors({}); }',
    'try { a(); } catch (e) { setMsg(""); }',
    'try { a(); } catch (e) { setCount(e2); }',                                   // `e2` is not the caught `e`
    'try { a(); } catch (e) {}',
  ];
  for (const code of flagged) assert.equal(findSilentCatchBlocks(code, 'src/x.tsx').length, 1, code);
});

// Same-file error helper (2026-10-14, videoforge): `catch (e) { fail(e); }` where `fail` is defined in the same file and shows
// the error was flagged ten times in one VideoForge run and dismissed ten times as a false positive, one review call each.
test('silent-catch-block: a catch that hands the error to a same-file helper which surfaces it is not silent', () => {
  const ok = [
    "const fail = e => { say(''); alert(e.message || e); };\nasync function go() { try { a(); } catch (e) { fail(e); } }",
    "function showProblem(err) { document.getElementById('msg').textContent = err.message; }\ntry { a(); } catch (err) { showProblem(err); }",
    "const report = async (e) => { await post('/log', { error: String(e) }); console.error(e); };\ntry { a(); } catch (e) { report(e); }",
    "const fail = e => alert(e.message);\ntry { a(); } catch (e) { fail(e); }",                      // expression-bodied arrow
    "var oops = function (x) { toast(x); };\ntry { a(); } catch (e) { cleanup(); oops(e); }",       // function expression, with other statements
  ];
  for (const code of ok) assert.equal(findSilentCatchBlocks(code, 'src/x.js').length, 0, code);
});

test('silent-catch-block: a same-file helper that does NOT surface the error, is not defined here, or is not handed it is still flagged', () => {
  const flagged = [
    "const swallow = e => { cache = null; };\ntry { a(); } catch (e) { swallow(e); }",                // helper hides it too
    "try { a(); } catch (e) { handle(e); }",                                                          // imported / unknown: cannot verify
    "const fail = e => { alert(e.message); };\ntry { a(); } catch (e) { fail(); }",                 // helper exists but the error is not passed
    "const fail = e => { alert(e.message); };\ntry { a(); } catch (e) { fail(other); }",            // a different identifier
    "const wrap = e => { inner(e); };\nconst inner = e => { cache = null; };\ntry { a(); } catch (e) { wrap(e); }",   // one level only
    "const fail = e => { fail(e); };\ntry { a(); } catch (e) { fail(e); }",                         // self-recursive, surfaces nothing
  ];
  for (const code of flagged) assert.equal(findSilentCatchBlocks(code, 'src/x.js').length, 1, code);
});

test('silent-catch-block: a same-file helper is a JS/TS rule only -- Python except bodies are unchanged', () => {
  const py = 'def fail(e):\n    print(e)\ntry:\n    a()\nexcept Exception as e:\n    fail(e)\n';
  assert.equal(findSilentCatchBlocks(py, 'x.py').length, 1);
});

test('silent-catch-block: state-setter surfacing is JS/TS only -- a Python except with a set_* call is unchanged', () => {
  const py = 'try:\n    a()\nexcept Exception as e:\n    set_detail(str(e))\n';
  assert.equal(findSilentCatchBlocks(py, 'x.py').length, 1);
});
