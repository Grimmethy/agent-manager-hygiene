'use strict';

// PROJECT CAPABILITIES grounding for the *_fix / *_review prompt chain.
//
// observability_fix / performance_fix hand the drafting model a candidate write-up
// (framed "already vetted -- do not second-guess") plus the real content of the file it
// names, but NOTHING about what observability / telemetry primitives the target project
// actually has. A candidate whose Solution says "add a metric" then gets a fabricated
// metric emission invented for a project with no metrics system -- real incident:
// observability candidate AC-47 added `process.stderr.write('..._total 1\n')` to
// agent-manager, which logs with console.* and has no metrics dependency at all.
//
// This builds a short factual statement from the repo's dependency MANIFESTS only (no
// repo-wide scan): which telemetry/logging libraries are and are not available, plus an
// explicit instruction -- if the candidate names a primitive this project lacks, do the
// available parts and omit the rest, never fabricate one.
//
// Kept consistent with observability-scan.js's hasOtelDependency() (same "does this string
// appear in a manifest" approach -- we only need presence, not a parsed dep graph).

const fs = require('fs');
const path = require('path');

const MANIFESTS = ['package.json', 'requirements.txt', 'pyproject.toml', 'go.mod', 'Pipfile', 'Gemfile'];

// A library is "present" if its marker string appears in any dependency manifest.
const METRICS_LIBS = [
  { label: 'OpenTelemetry', res: [/"@opentelemetry\//, /\bopentelemetry-/, /go\.opentelemetry\.io/] },
  { label: 'prom-client / Prometheus', res: [/"prom-client"/, /prometheus[-_]client/, /"prometheus"/] },
  { label: 'StatsD', res: [/"(?:hot-shots|node-statsd|statsd)"/, /\bstatsd\b/] },
  { label: 'Datadog', res: [/"dd-trace"/, /datadog/] },
];
const LOGGING_LIBS = [
  { label: 'winston', res: [/"winston"/] },
  { label: 'pino', res: [/"pino"/] },
  { label: 'bunyan', res: [/"bunyan"/] },
  { label: 'loglevel', res: [/"loglevel"/] },
];

function readManifests(repoRoot) {
  return MANIFESTS.map((m) => {
    try { return fs.readFileSync(path.join(repoRoot, m), 'utf8'); } catch { return ''; }
  }).join('\n');
}

function detect(manifestText, libs) {
  return libs.filter((lib) => lib.res.some((re) => re.test(manifestText))).map((lib) => lib.label);
}

// A short, factual "what this project has / does not have" block to prepend to a *_fix or
// *_review prompt so the model does not invent a primitive the project cannot support.
// `kind` tailors only the closing instruction: 'observability' (default) or 'performance'.
function projectCapabilityProfile(repoRoot, { kind = 'observability' } = {}) {
  const manifests = repoRoot ? readManifests(repoRoot) : '';
  const metrics = detect(manifests, METRICS_LIBS);
  const loggers = detect(manifests, LOGGING_LIBS);

  const lines = [
    "PROJECT CAPABILITIES (from this repo's dependency manifests -- authoritative for what primitives exist):",
  ];

  lines.push(metrics.length
    ? `- Metrics / telemetry: available via ${metrics.join(', ')}. Use only the API already present in the file shown above; do not introduce a different metrics library.`
    : '- Metrics / telemetry: NONE. No OpenTelemetry / prom-client / StatsD / Datadog dependency -- this project has no metrics system, and nowhere for a metric, counter, gauge or Prometheus-format line to go.');

  lines.push(loggers.length
    ? `- Logging: ${loggers.join(', ')} available. Use it if the file you are editing already does; otherwise match that file's existing logging idiom.`
    : '- Logging: no third-party logging framework (no winston / pino / bunyan / loglevel). Node code logs with console.error / console.warn / process.stderr.write; Python code uses the stdlib logging module. Match whatever the file shown above already uses.');

  lines.push('');
  if (kind === 'performance') {
    lines.push('Do NOT add a new dependency (a caching / pooling / profiling / metrics library) or call an API this project does not already expose. Implement the fix with only what the file shown above and this project\'s existing dependencies provide -- e.g. batch or reorder existing calls, parallelize with primitives already in use, memoize with a plain object/Map. If the write-up\'s approach needs something not available, use the simplest available alternative and say what you simplified. Do not fabricate a missing primitive and do not block the task over it.');
  } else {
    lines.push('Do NOT add a new logging or telemetry dependency, and do NOT emit to a system not listed above. If the write-up asks for a primitive this project does not have (e.g. "add a metric", "increment a counter", "emit a health-signal number" in a project with no metrics system), implement only the parts that ARE available -- log the swallowed error with enough context to identify it, and rethrow only if a caller can act on it -- and omit the rest. Do not fabricate the missing primitive and do not block the task over it.');
  }

  return lines.join('\n');
}

module.exports = { projectCapabilityProfile };
