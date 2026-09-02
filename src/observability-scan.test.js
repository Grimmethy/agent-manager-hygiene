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
  findMissingReservedAttributes, hasOtelDependency, isValidOtelName,
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

test('findSilentCatchBlocks does NOT flag `catch { return <literal> }` (deliberate fallback value)', () => {
  assert.equal(findSilentCatchBlocks('try { a() } catch (e) {\n  return null;\n}\n', 'a.js').length, 0);
  assert.equal(findSilentCatchBlocks('try { a() } catch {\n  return [];\n}\n', 'a.js').length, 0);
  assert.equal(findSilentCatchBlocks('try { a() } catch {\n  return;\n}\n', 'a.js').length, 0);
  assert.equal(findSilentCatchBlocks('try { a() } catch {\n  return false\n}\n', 'a.js').length, 0);
});

test('findSilentCatchBlocks still flags `catch { return someFallbackVar }` (identifier, not a literal)', () => {
  assert.equal(findSilentCatchBlocks('try { a() } catch {\n  return cached;\n}\n', 'a.js').length, 1);
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

test('findSilentExceptBlocks does NOT flag `except: return None` (deliberate fallback value)', () => {
  assert.equal(findSilentExceptBlocks('try:\n    x()\nexcept Exception:\n    return None\n', 'a.py').length, 0);
  assert.equal(findSilentExceptBlocks('try:\n    x()\nexcept Exception:\n    return\n', 'a.py').length, 0);
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
