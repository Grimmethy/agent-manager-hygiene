'use strict';

// Unit tests for projectCapabilityProfile -- the "what primitives does this project
// actually have" grounding block that stops *_fix drafts inventing a metrics/telemetry
// emission (real incident: observability candidate AC-47 added a fabricated
// `process.stderr.write('..._total 1\n')` to a project with no metrics system).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { projectCapabilityProfile } = require('./project-capabilities.js');

function repoWith(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'project-caps-test-'));
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content);
  }
  return dir;
}

test('a project with no metrics/logging deps: profile says NONE and forbids fabricating one', () => {
  const dir = repoWith({ 'package.json': JSON.stringify({ dependencies: { express: '^4' } }) });
  const p = projectCapabilityProfile(dir);
  assert.match(p, /Metrics \/ telemetry: NONE/);
  assert.match(p, /no metrics system/);
  assert.match(p, /no third-party logging framework/);
  assert.match(p, /console\.error \/ console\.warn \/ process\.stderr\.write/);
  assert.match(p, /Do not fabricate the missing primitive/);
  assert.match(p, /"add a metric"/);
});

test('a null repoRoot falls back to the safe "assume nothing exists" profile', () => {
  const p = projectCapabilityProfile(null);
  assert.match(p, /Metrics \/ telemetry: NONE/);
  assert.match(p, /Do not fabricate the missing primitive/);
});

test('detects OpenTelemetry in package.json and permits its use', () => {
  const dir = repoWith({ 'package.json': JSON.stringify({ dependencies: { '@opentelemetry/api': '^1', '@opentelemetry/sdk-node': '^0.5' } }) });
  const p = projectCapabilityProfile(dir);
  assert.match(p, /Metrics \/ telemetry: available via OpenTelemetry/);
  assert.doesNotMatch(p, /Metrics \/ telemetry: NONE/);
});

test('detects prom-client and a Python metrics lib', () => {
  assert.match(projectCapabilityProfile(repoWith({ 'package.json': '{"dependencies":{"prom-client":"^15"}}' })), /prom-client \/ Prometheus/);
  assert.match(projectCapabilityProfile(repoWith({ 'requirements.txt': 'flask==3\nprometheus-client==0.20\n' })), /prom-client \/ Prometheus/);
});

test('detects a third-party logger and tells the model to use it', () => {
  const p = projectCapabilityProfile(repoWith({ 'package.json': '{"dependencies":{"pino":"^9"}}' }));
  assert.match(p, /Logging: pino available/);
  assert.doesNotMatch(p, /no third-party logging framework/);
});

test('kind:"performance" swaps the closing instruction for the dependency/API guardrail', () => {
  const p = projectCapabilityProfile(null, { kind: 'performance' });
  assert.match(p, /Do NOT add a new dependency \(a caching \/ pooling \/ profiling \/ metrics library\)/);
  assert.doesNotMatch(p, /log the swallowed error/);
});
