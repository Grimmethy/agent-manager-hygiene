'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const {
  buildPythonModuleExtraction,
  buildPythonModuleOnePassChanges,
  planIsFullyMechanicalPythonModule,
} = require('./decompose-python-module.js');

function pyOk() {
  try { execFileSync('python3', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; }
}
const PY = pyOk();

const APP = [
  "import json",
  "from pathlib import Path",
  "from flask import Flask, jsonify",
  "",
  "app = Flask(__name__)",
  "",
  "SETTINGS_PATH = Path('settings.json')",
  "",
  "",
  "def read_settings():",
  "    return json.loads(SETTINGS_PATH.read_text())",
  "",
  "",
  "def write_settings(data):",
  "    SETTINGS_PATH.write_text(json.dumps(data))",
  "",
  "",
  "def _cache_path(name):",
  "    return Path('cache') / name",
  "",
  "",
  "@app.route('/api/settings')",
  "def api_settings():",
  "    return jsonify(_cache_path('x').name)",
  "",
].join('\n');

test('buildPythonModuleExtraction: 2 helper functions -> new module + reduced source, imports carried over', { skip: !PY }, () => {
  const r = buildPythonModuleExtraction(APP, 'app.py', 'app_config.py', ['read_settings', 'write_settings']);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.match(r.newContent, /import json/);
  assert.match(r.newContent, /from app import SETTINGS_PATH/); // SETTINGS_PATH stays in app.py, read lazily
  assert.match(r.newContent, /def read_settings/);
  assert.match(r.newContent, /def write_settings/);
  assert.doesNotMatch(r.reduced, /def read_settings/);
  assert.doesNotMatch(r.reduced, /def write_settings/);
  assert.match(r.reduced, /def _cache_path/); // untouched
  assert.match(r.reduced, /@app\.route/); // untouched
});

test('buildPythonModuleExtraction: a shared module-level name gets a LAZY in-function import, not a top-level one', { skip: !PY }, () => {
  const r = buildPythonModuleExtraction(APP, 'app.py', 'app_config.py', ['read_settings', 'write_settings']);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.match(r.newContent, /from app import SETTINGS_PATH/);
  assert.doesNotMatch(r.newContent.split('\n').slice(0, 3).join('\n'), /^from app import/);
});

test('buildPythonModuleOnePassChanges: output py_compiles', { skip: !PY }, () => {
  const r = buildPythonModuleOnePassChanges(APP, 'app.py', [
    { newFile: 'app_config.py', symbols: ['read_settings', 'write_settings'] },
  ]);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.changes.length, 2);
});

test('buildPythonModuleOnePassChanges: BLOCKS when a moved symbol is still called elsewhere', { skip: !PY }, () => {
  const src = `${APP}\n\ndef other():\n    return read_settings()\n`;
  const r = buildPythonModuleOnePassChanges(src, 'app.py', [
    { newFile: 'app_config.py', symbols: ['read_settings', 'write_settings'] },
  ]);
  assert.equal(r.ok, false);
  assert.match(r.reason, /still referenced/);
});

test('buildPythonModuleOnePassChanges: BLOCKS an @app.route view -- that belongs in a flask-blueprint move', { skip: !PY }, () => {
  const r = buildPythonModuleOnePassChanges(APP, 'app.py', [
    { newFile: 'app_routes.py', symbols: ['api_settings'] },
  ]);
  assert.equal(r.ok, false);
  assert.match(r.reason, /belong in a flask-blueprint move/);
});

test('buildPythonModuleExtraction: rejects a non-.py source/target', () => {
  assert.equal(buildPythonModuleExtraction('x', 'app.js', 'app_config.py', ['a']).ok, false);
  assert.equal(buildPythonModuleExtraction('x', 'app.py', 'app_config.js', ['a']).ok, false);
  assert.equal(buildPythonModuleExtraction('x', 'app.py', 'app_config.py', []).ok, false);
});

test('planIsFullyMechanicalPythonModule: needs a .py source, every move python-module-extract + pythonModuleApplyOk', () => {
  const request = { sourceFile: 'app.py', moves: [{ newFile: 'app_config.py', kind: 'python-module-extract', symbols: ['a'] }] };
  assert.equal(planIsFullyMechanicalPythonModule(request, { moveMeta: [{ pythonModuleApplyOk: true }] }), true);
  assert.equal(planIsFullyMechanicalPythonModule(request, { moveMeta: [{ pythonModuleApplyOk: false }] }), false);
  assert.equal(planIsFullyMechanicalPythonModule({ sourceFile: 'app.js', moves: request.moves }, { moveMeta: [{ pythonModuleApplyOk: true }] }), false);
  const mixed = { sourceFile: 'app.py', moves: [...request.moves, { newFile: 'app_bp.py', kind: 'flask-blueprint', blueprint: 'bp', symbols: ['b'] }] };
  assert.equal(planIsFullyMechanicalPythonModule(mixed, { moveMeta: [{ pythonModuleApplyOk: true }, { pythonModuleApplyOk: true }] }), false);
});

test('planIsFullyMechanicalPythonModule: kill switch AGENT_MANAGER_DECOMPOSE_PY_MODULE=false', () => {
  const request = { sourceFile: 'app.py', moves: [{ newFile: 'app_config.py', kind: 'python-module-extract', symbols: ['a'] }] };
  process.env.AGENT_MANAGER_DECOMPOSE_PY_MODULE = 'false';
  try {
    assert.equal(planIsFullyMechanicalPythonModule(request, { moveMeta: [{ pythonModuleApplyOk: true }] }), false);
  } finally {
    delete process.env.AGENT_MANAGER_DECOMPOSE_PY_MODULE;
  }
});

test('buildPythonModuleExtraction: a return-type annotation naming a top-level import carries that import over', { skip: !PY }, () => {
  const src = [
    "from pathlib import Path",
    "",
    "def resolve_path(name) -> Path:",
    "    return Path(name)",
    "",
    "def other_helper():",
    "    return 1",
    "",
    "def third_helper():",
    "    return 2",
  ].join('\n');
  const r = buildPythonModuleExtraction(src, 'app.py', 'app_paths.py', ['resolve_path', 'other_helper', 'third_helper']);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.match(r.newContent, /from pathlib import Path/);
});
