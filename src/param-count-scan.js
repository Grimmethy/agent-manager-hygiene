'use strict';

// Param-count hygiene scanner: flags functions with too many positional parameters.
// Companion to function-length-scan.js (length) and file-length-scan.js (length):
// this one catches the "parameter bloat" smell -- a function whose signature has grown
// past what a reader can hold in working memory without referring back to the call site.
// Same "detect + flag only" contract as the other scanners; review/fix are separate
// downstream tasks (HUB0020/3 and HUB0020/4).
//
// Regex-based, not a real parser -- same accepted tradeoff as every other rule in this
// family. False positives and false negatives are expected and are the review stage's
// job to filter. JS/TS/Python/Go/Rust/C++ signatures are all covered by the param-count
// heuristic; only Python's self/cls exclusion is language-specific.
//
// Call-site pattern detection is optional (HYGIENE_PARAM_COUNT_CALL_SITES env, default
// true): when enabled, the scanner looks for 3+ distinct functions all called with the
// same positional argument structure (3+ args each). This is a heuristic for "parameter
// object" smell -- when callers keep passing the same cluster of args to different
// functions, those args probably belong to a single object.

const fs = require('fs');
const path = require('path');
const {
  listSourceFiles,
  extractBraceBody,
  stripNonCode,
  isTestFile,
  isLikelyMinified,
  SKIP_DIRS,
  getHygieneConfig,
  lineOfIndex,
} = require('./scan-utils.js');

// Language-specific file extensions to scan.
const JS_TS_EXTENSIONS = ['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs'];
const PYTHON_EXTENSIONS = ['.py'];
const GO_EXTENSIONS = ['.go'];
const RUST_EXTENSIONS = ['.rs'];
const CPP_EXTENSIONS = ['.cpp', '.cc', '.cxx', '.h', '.hpp'];

function countPositionalParams(paramStr) {
  if (!paramStr || !paramStr.trim()) return 0;
  // Split on commas at depth 0 (respecting nested parens, brackets, braces, strings).
  const params = splitParams(paramStr);
  return params.length;
}

function splitParams(str) {
  const params = [];
  let depth = 0;
  let inString = null;
  let inLineComment = false;
  let inBlockComment = false;
  let escapeNext = false;
  let start = 0;

  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    const next = str[i + 1];

    if (inLineComment) {
      if (ch === '\n') inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      if (ch === '*' && next === '/') {
        inBlockComment = false;
        i++;
      }
      continue;
    }
    if (inString) {
      if (escapeNext) {
        escapeNext = false;
        continue;
      }
      if (ch === '\\') {
        escapeNext = true;
        continue;
      }
      if (ch === inString) inString = null;
      continue;
    }
    if (ch === '/' && next === '/') {
      inLineComment = true;
      i++;
      continue;
    }
    if (ch === '/' && next === '*') {
      inBlockComment = true;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      inString = ch;
      continue;
    }

    if (ch === '(' || ch === '[' || ch === '{') {
      depth++;
    } else if (ch === ')' || ch === ']' || ch === '}') {
      depth--;
    } else if (ch === ',' && depth === 0) {
      params.push(str.slice(start, i));
      start = i + 1;
    }
  }

  // Last param (if any).
  const last = str.slice(start).trim();
  if (last) params.push(last);

  return params;
}

// For Python: subtract 1 if the first param is `self` or `cls`.
function countPythonParams(paramStr) {
  if (!paramStr || !paramStr.trim()) return 0;
  const params = splitParams(paramStr);
  let count = params.length;
  if (count > 0) {
    const first = params[0].trim();
    if (first === 'self' || first === 'cls') count--;
  }
  return count;
}

// Extract the function name from a JS/TS match, or null for anonymous.
function extractJsFunctionName(match, nameGroup) {
  if (nameGroup && match[nameGroup]) return match[nameGroup];
  // Try to find `function name(` pattern.
  const m = match[0].match(/function\s+\*?\s*([A-Za-z_$][\w$]*)/);
  return m ? m[1] : null;
}

// Extract the parameter string from a JS/TS match (between the outermost parens).
function extractJsParamStr(match) {
  const full = match[0];
  // Find the opening paren after "function" or arrow.
  const funcIdx = full.indexOf('function');
  const startIdx = funcIdx === -1 ? full.indexOf('(') : full.indexOf('(', funcIdx);
  if (startIdx === -1) return '';
  // Find matching close paren.
  let depth = 0;
  for (let i = startIdx; i < full.length; i++) {
    if (full[i] === '(') depth++;
    else if (full[i] === ')') {
      depth--;
      if (depth === 0) return full.slice(startIdx + 1, i);
    }
  }
  return '';
}

// Regex patterns for JS/TS function declarations.
const NAMED_FUNCTION_RE = /\bfunction\s*\*?\s*[A-Za-z_$][\w$]*\s*\([^)]*\)\s*\{/g;
const ARROW_ASSIGNMENT_RE = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?\([^)]*\)\s*=>\s*\{/g;
const FUNCTION_EXPRESSION_ASSIGNMENT_RE = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?function\s*\*?\s*\([^)]*\)\s*\{/g;
const CLASS_METHOD_RE = /\b([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/g;

// Python: match `def name(params):` at a line start.
const PY_DEF_RE = /^([ \t]*)(?:async[ \t]+)?def[ \t]+([A-Za-z_]\w*)[ \t]*\(/gm;

// Go: match `func name(params)` (possibly with receiver).
const GO_FUNC_RE = /\bfunc\s+(?:\([^)]*\)\s+)?([A-Za-z_][\w$]*)\s*\(/g;

// Rust: match `fn name(params)` (possibly with generics).
const RUST_FN_RE = /\bfn\s+([A-Za-z_]\w*)\s*<[^>]*>\s*\(/g;
const RUST_FN_SIMPLE_RE = /\bfn\s+([A-Za-z_]\w*)\s*\(/g;

// C/C++: match `type name(params)` where type is a known keyword or identifier.
const CPP_FUNC_RE = /\b(?:void|int|char|float|double|long|short|unsigned|signed|bool|auto|[A-Za-z_]\w*\s*)+([A-Za-z_]\w*)\s*\(/g;

// Detect call-site patterns: find function calls with 3+ positional args, group by
// argument-count signature. A "pattern" is identified when 3+ distinct functions are
// all called with the same arg-count structure.
function detectCallSitePatterns(text, flaggedFunctions) {
  // Find all function calls with 3+ args. We use a simple heuristic: look for
  // `identifier(` followed by 3+ comma-separated args at depth 0.
  const callRe = /\b([A-Za-z_$][\w$]*)\s*\(/g;
  const argPatterns = new Map(); // argCountSignature -> Set of function names

  callRe.lastIndex = 0;
  let m;
  while ((m = callRe.exec(text))) {
    const callName = m[1];
    const openIdx = m.index + m[0].length - 1; // index of '('

    // Find matching close paren.
    let depth = 0;
    let argCount = 0;
    let inString = null;
    let inLineComment = false;
    let inBlockComment = false;
    let escapeNext = false;
    let argStart = -1;

    for (let i = openIdx; i < text.length; i++) {
      const ch = text[i];
      const next = text[i + 1];

      if (inLineComment) {
        if (ch === '\n') inLineComment = false;
        continue;
      }
      if (inBlockComment) {
        if (ch === '*' && next === '/') {
          inBlockComment = false;
          i++;
        }
        continue;
      }
      if (inString) {
        if (escapeNext) {
          escapeNext = false;
          continue;
        }
        if (ch === '\\') {
          escapeNext = true;
          continue;
        }
        if (ch === inString) inString = null;
        continue;
      }
      if (ch === '/' && next === '/') {
        inLineComment = true;
        i++;
        continue;
      }
      if (ch === '/' && next === '*') {
        inBlockComment = true;
        i++;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === '`') {
        inString = ch;
        continue;
      }

      if (ch === '(' || ch === '[' || ch === '{') {
        depth++;
      } else if (ch === ')' || ch === ']' || ch === '}') {
        depth--;
        if (depth === 0) {
          // Count args at depth 1 (inside the call's parens).
          const callBody = text.slice(openIdx + 1, i);
          const args = splitParams(callBody);
          argCount = args.length;
          break;
        }
      } else if (ch === ',' && depth === 0) {
        argCount++;
      }
    }

    if (argCount >= 3) {
      // Create a signature based on arg count (simplified: just the count).
      const signature = `${argCount}args`;
      if (!argPatterns.has(signature)) {
        argPatterns.set(signature, new Set());
      }
      argPatterns.get(signature).add(callName);
    }
  }

  // Find signatures with 3+ distinct functions.
  const patterns = [];
  for (const [signature, funcs] of argPatterns) {
    if (funcs.size >= 3) {
      patterns.push({ signature, matchingFunctions: [...funcs] });
    }
  }

  return patterns;
}

// Build the functionPath: `file:functionName` or `file:ClassName.methodName`.
function buildFunctionPath(relPath, functionName, className) {
  if (className) {
    return `${relPath}:${className}.${functionName}`;
  }
  return `${relPath}:${functionName}`;
}

// Scan JS/TS source for functions with too many params.
function scanJsTs(text, relPath, threshold) {
  const flags = [];
  const seenBraceIndex = new Set();

  const patterns = [
    { re: NAMED_FUNCTION_RE, nameGroup: null, language: 'js' },
    { re: ARROW_ASSIGNMENT_RE, nameGroup: 1, language: 'js' },
    { re: FUNCTION_EXPRESSION_ASSIGNMENT_RE, nameGroup: 1, language: 'js' },
    { re: CLASS_METHOD_RE, nameGroup: 1, language: 'js' },
  ];

  for (const { re, nameGroup, language } of patterns) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text))) {
      const openIndex = m.index + m[0].length - 1;
      if (seenBraceIndex.has(openIndex)) continue;
      seenBraceIndex.add(openIndex);

      const body = extractBraceBody(text, openIndex);
      if (body === null) continue;

      const paramStr = extractJsParamStr(m);
      const paramCount = countPositionalParams(paramStr);
      if (paramCount < threshold) continue;

      const name = extractJsFunctionName(m, nameGroup);
      const functionPath = buildFunctionPath(relPath, name || 'anonymous');

      flags.push({
        file: relPath,
        line: lineOfIndex(text, m.index),
        functionPath,
        paramCount,
      });
    }
  }

  return flags;
}

// Scan Python source for functions with too many params (excluding self/cls).
function scanPython(text, relPath, threshold) {
  const flags = [];

  PY_DEF_RE.lastIndex = 0;
  let m;
  while ((m = PY_DEF_RE.exec(text))) {
    const funcName = m[2];
    const openParenIdx = m.index + m[0].length - 1;

    // Find matching close paren.
    let depth = 0;
    let paramStr = '';
    for (let i = openParenIdx; i < text.length; i++) {
      const ch = text[i];
      if (ch === '(') depth++;
      else if (ch === ')') {
        depth--;
        if (depth === 0) {
          paramStr = text.slice(openParenIdx + 1, i);
          break;
        }
      }
    }

    const paramCount = countPythonParams(paramStr);
    if (paramCount < threshold) continue;

    const functionPath = buildFunctionPath(relPath, funcName);

    flags.push({
      file: relPath,
      line: lineOfIndex(text, m.index),
      functionPath,
      paramCount,
    });
  }

  return flags;
}

// Scan Go source for functions with too many params.
function scanGo(text, relPath, threshold) {
  const flags = [];

  GO_FUNC_RE.lastIndex = 0;
  let m;
  while ((m = GO_FUNC_RE.exec(text))) {
    const funcName = m[1];
    const openParenIdx = m.index + m[0].length - 1;

    // Find matching close paren.
    let depth = 0;
    let paramStr = '';
    for (let i = openParenIdx; i < text.length; i++) {
      const ch = text[i];
      if (ch === '(') depth++;
      else if (ch === ')') {
        depth--;
        if (depth === 0) {
          paramStr = text.slice(openParenIdx + 1, i);
          break;
        }
      }
    }

    const paramCount = countPositionalParams(paramStr);
    if (paramCount < threshold) continue;

    const functionPath = buildFunctionPath(relPath, funcName);

    flags.push({
      file: relPath,
      line: lineOfIndex(text, m.index),
      functionPath,
      paramCount,
    });
  }

  return flags;
}

// Scan Rust source for functions with too many params.
function scanRust(text, relPath, threshold) {
  const flags = [];

  // Try generic version first, then simple.
  const patterns = [RUST_FN_RE, RUST_FN_SIMPLE_RE];

  for (const re of patterns) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text))) {
      const funcName = m[1];
      const openParenIdx = m.index + m[0].length - 1;

      // Find matching close paren.
      let depth = 0;
      let paramStr = '';
      for (let i = openParenIdx; i < text.length; i++) {
        const ch = text[i];
        if (ch === '(') depth++;
        else if (ch === ')') {
          depth--;
          if (depth === 0) {
            paramStr = text.slice(openParenIdx + 1, i);
            break;
          }
        }
      }

      const paramCount = countPositionalParams(paramStr);
      if (paramCount < threshold) continue;

      const functionPath = buildFunctionPath(relPath, funcName);

      flags.push({
        file: relPath,
        line: lineOfIndex(text, m.index),
        functionPath,
        paramCount,
      });
    }
  }

  return flags;
}

// Scan C/C++ source for functions with too many params.
function scanCpp(text, relPath, threshold) {
  const flags = [];

  CPP_FUNC_RE.lastIndex = 0;
  let m;
  while ((m = CPP_FUNC_RE.exec(text))) {
    const funcName = m[1];
    const openParenIdx = m.index + m[0].length - 1;

    // Find matching close paren.
    let depth = 0;
    let paramStr = '';
    for (let i = openParenIdx; i < text.length; i++) {
      const ch = text[i];
      if (ch === '(') depth++;
      else if (ch === ')') {
        depth--;
        if (depth === 0) {
          paramStr = text.slice(openParenIdx + 1, i);
          break;
        }
      }
    }

    const paramCount = countPositionalParams(paramStr);
    if (paramCount < threshold) continue;

    const functionPath = buildFunctionPath(relPath, funcName);

    flags.push({
      file: relPath,
      line: lineOfIndex(text, m.index),
      functionPath,
      paramCount,
    });
  }

  return flags;
}

/**
 * Main exported scan function. Returns an array of flag objects:
 *   { file, line, functionPath, paramCount, callSitePattern? }
 *
 * @param {Object} options
 * @param {string} [options.sourcePath] - Single file to scan (overrides listSourceFiles).
 * @param {Function} [options.fileFilter] - Predicate to filter files.
 * @param {string} [options.language='multi'] - Language filter ('js', 'python', 'go', 'rust', 'cpp', 'multi').
 * @param {Function} [options.log] - Logger function.
 * @returns {Array} Array of flag objects.
 */
function scan(options = {}) {
  const {
    sourcePath,
    fileFilter,
    language = 'multi',
    log,
  } = options;

  const { paramCountMax, paramCountCallSites } = getHygieneConfig();
  const threshold = paramCountMax;

  const flags = [];

  // Phase 1: collect candidate flags.
  let files;
  if (sourcePath) {
    files = [sourcePath];
  } else {
    // Default to current working directory if no sourcePath.
    const cwd = process.cwd();
    const allExtensions = [
      ...JS_TS_EXTENSIONS,
      ...PYTHON_EXTENSIONS,
      ...GO_EXTENSIONS,
      ...RUST_EXTENSIONS,
      ...CPP_EXTENSIONS,
    ];
    files = listSourceFiles(cwd, allExtensions);
  }

  for (const file of files) {
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }

    const relPath = path.relative(process.cwd(), file).replace(/\\/g, '/');

    // Skip test files.
    if (isTestFile(relPath)) continue;

    // Skip minified files.
    if (isLikelyMinified(text)) continue;

    // Strip non-code (comments, strings) to avoid counting params inside them.
    const code = stripNonCode(text);

    // Determine language and scan. When language === 'multi', scan based on file
    // extension regardless of the language filter (i.e., detect the language from
    // the file). When a specific language is requested, only scan files matching
    // that language's extensions.
    let langFlags = [];
    const isMulti = language === 'multi';
    if (isMulti || language === 'js') {
      if (JS_TS_EXTENSIONS.some((ext) => file.endsWith(ext))) {
        langFlags = scanJsTs(code, relPath, threshold);
      }
    }
    if (isMulti || language === 'python') {
      if (PYTHON_EXTENSIONS.some((ext) => file.endsWith(ext))) {
        langFlags = scanPython(code, relPath, threshold);
      }
    }
    if (isMulti || language === 'go') {
      if (GO_EXTENSIONS.some((ext) => file.endsWith(ext))) {
        langFlags = scanGo(code, relPath, threshold);
      }
    }
    if (isMulti || language === 'rust') {
      if (RUST_EXTENSIONS.some((ext) => file.endsWith(ext))) {
        langFlags = scanRust(code, relPath, threshold);
      }
    }
    if (isMulti || language === 'cpp') {
      if (CPP_EXTENSIONS.some((ext) => file.endsWith(ext))) {
        langFlags = scanCpp(code, relPath, threshold);
      }
    }

    // Apply file filter.
    if (fileFilter) {
      langFlags = langFlags.filter((flag) => fileFilter(flag.file));
    }

    flags.push(...langFlags);

    // Log each flag.
    if (log) {
      for (const f of langFlags) {
        log(`param-count-scan: ${f.file}:${f.line} ${f.functionPath} (${f.paramCount} params)`);
      }
    }
  }

  // Phase 2: optional call-site pattern detection.
  if (paramCountCallSites && files.length > 0) {
    // Collect all source text for pattern detection.
    const allTexts = [];
    for (const file of files) {
      let text;
      try {
        text = fs.readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      const relPath = path.relative(process.cwd(), file).replace(/\\/g, '/');
      if (isTestFile(relPath)) continue;
      if (isLikelyMinified(text)) continue;
      allTexts.push({ file, relPath, text: stripNonCode(text) });
    }

    // Detect call-site patterns across all files.
    const allPatterns = [];
    for (const { relPath, text } of allTexts) {
      const patterns = detectCallSitePatterns(text, flags);
      for (const p of patterns) {
        allPatterns.push({ file: relPath, ...p });
      }
    }

    // Attach callSitePattern to flags if they match.
    if (allPatterns.length > 0) {
      for (const flag of flags) {
        for (const pattern of allPatterns) {
          if (pattern.matchingFunctions.includes(flag.functionPath.split(':').pop())) {
            flag.callSitePattern = {
              patterns: [pattern.signature],
              matchingFunctions: pattern.matchingFunctions,
            };
            if (log) {
              log(`param-count-scan: call-site pattern detected in ${flag.file}: ${pattern.signature}`);
            }
            break;
          }
        }
      }
    }
  }

  return flags;
}

module.exports = {
  scan,
  countPositionalParams,
  countPythonParams,
  splitParams,
  detectCallSitePatterns,
  JS_TS_EXTENSIONS,
  PYTHON_EXTENSIONS,
  GO_EXTENSIONS,
  RUST_EXTENSIONS,
  CPP_EXTENSIONS,
};
