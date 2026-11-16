// DEVIATION: src/nesting-scan.js is missing from this checkout; the local enumerator in this file stands in for it.
'use strict';

// Returns true when any path segment is exactly 'vendor' (exact match, POSIX or Windows separators).
function isVendoredPath(p) {
  const segs = String(p).split(/[\\/]/);
  return segs.some((s) => s === 'vendor');
}

module.exports = { isVendoredPath };
