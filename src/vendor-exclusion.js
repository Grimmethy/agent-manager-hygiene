'use strict';

// Shared vendored-path rule (HUB0022 1/6). Matches whole '/'-split segments only.
const VENDORED_SEGMENTS = new Set(['vendor', 'node_modules', '.venv', 'third_party']);

function isVendoredPath(relPath) {
  const segments = String(relPath).replace(/\\/g, '/').split('/');
  return segments.some((seg) => VENDORED_SEGMENTS.has(seg));
}

module.exports = { isVendoredPath };
