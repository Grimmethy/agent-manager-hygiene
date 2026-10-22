# Architecture Review Candidates

### AC-1 · Duplicated archived-directory skip rule with no shared source of truth
Strength: Strong
Files: src/scan-utils.js

Problem:
`scan-utils.js` re-implements the archived-directory exclusion rule (the `ARCHIVED_DIR_RE` pattern and the `isArchivedDirName` helper) that is canonically defined in the core `agent-manager` package's `archived-dirs` module. Because this repository deliberately cannot import that core module, the one-line policy is hand-copied and kept in sync only by a comment and a parallel test in each repo. If the core rule changes—whether a new retired directory name is added, the regex is refined, or the matching semantics shift—the copy here silently diverges, causing local scanners to walk directories that core considers retired (or to skip directories core still treats as active). The coupling is to a module that is structurally out of reach, so there is no compile-time or runtime guard against drift.

Solution:
Extract the archived-directory rule into a small, self-contained shared package (e.g. `@community/archived-dirs`) that both this repository and `agent-manager` depend on. The package exposes a single `isArchivedDirName(name: string): boolean` function and the underlying regex. `scan-utils.js` imports from that package instead of re-declaring the pattern, and `agent-manager`'s `archived-dirs.js` re-exports from it (or delegates to it) so the rule has exactly one definition. A version-pinning or lockfile mechanism ensures both consumers track the same rule revision.

Benefits:
A single source of truth eliminates the silent-divergence risk entirely: any change to the retired-directory policy is made in one place and propagated to every consumer through the package version. The hand-maintained comment and the duplicated test become unnecessary, reducing the maintenance surface. New community repositories that need the same skip rule can adopt the shared package without re-implementing the logic, preventing the duplication from spreading further.

### AC-2 · Two independent copies of the string/comment/escape state machine in scan-utils
Strength: Strong
Files: src/scan-utils.js

Problem:
`extractBraceBody` and `stripNonCode` each maintain their own independent implementation of the same lexical state machine (tracking `inString`, `inLineComment`, `inBlockComment`, and `escapeNext`). `stripNonCode` additionally layers on `prevCodeChar`, `word`, and `wordOpen` for regex-literal detection, but the core string/comment/escape transitions are duplicated verbatim. A comment in `stripNonCode` explicitly states it "extends the string/comment state machine `extractBraceBody` uses," confirming the two are intended to agree. Because there is no shared primitive, a bug fix or extension in one function (e.g., handling a template-literal edge case, fixing an escape-sequence off-by-one, or adding support for a new comment form) must be manually mirrored in the other, and nothing enforces that the mirror is correct.

Solution:
Factor the common lexical state machine into a single internal helper—e.g., a `scanTokens(source)` generator or a `LexicalState` class that advances character-by-character and yields the current state (`code`, `string`, `lineComment`, `blockComment`, `escape`). Both `extractBraceBody` and `stripNonCode` consume this shared scanner: `extractBraceBody` uses it to find the matching closing brace while ignoring braces inside strings or comments; `stripNonCode` uses it to decide which characters to emit and to feed its additional regex-detection logic. The shared scanner is unit-tested in isolation against a table of tricky inputs (nested templates, escaped quotes, `//` inside strings, `/*` inside block comments, etc.), and the two consuming functions are tested against their specific outputs.

Benefits:
A single, well-tested lexical scanner removes the risk of the two state machines drifting apart; any fix to string/comment/escape handling is made once and automatically applies to both consumers. The shared scanner is independently testable with a focused test suite, making edge-case coverage easier to reason about and extend. Future functions that need to "understand" code structure (e.g., a new scanner in `deterministic-recheck.js` or a downstream consumer) can reuse the same primitive rather than forking a third copy.

### AC-3 · Duplicated function-length measurement logic across Python and JS paths
Strength: Strong
Files: src/function-length-scan.js

Problem:
`findLongPythonFunctions` measures a function's span by calling `extractIndentedBlock` and comparing `block.lineCount` against the threshold, while `findLongFunctions` uses `extractBraceBody` plus `countLines(body)`. These are two different measurement primitives from `scan-utils.js` that must stay semantically in sync, yet nothing enforces that. Additionally, the JS path guards against double-reporting via a `seenBraceIndex` Set, but the Python path has no equivalent `seenIndex` guard—so if a future regex adjustment causes `PY_DEF_RE` to match the same `def` header twice (e.g., overlapping multi-line signatures), the Python detector would emit duplicate findings while the JS detector would not. Any change to the definition of "function length" (excluding decorators, counting only non-blank lines, etc.) requires a developer to remember to update both functions independently, and the two can silently drift.

Solution:
Extract a shared `measureFunctionSpan(text, startIndex, extractor)` helper in `scan-utils.js` (or the same module) that encapsulates the "given a start index and an extraction function, return a normalized line count" contract. Both `findLongPythonFunctions` and `findLongFunctions` call this helper, so the measurement definition lives in exactly one place. Add a `seenIndex` Set to `findLongPythonFunctions` mirroring the JS path's `seenBraceIndex` dedup, so both detectors share the same guarantee against duplicate reports.

Benefits:
A single measurement contract means a semantic change to "function length" is a one-line edit in the shared helper rather than a two-site change with drift risk. The dedup guarantee is now uniform across languages, eliminating a class of duplicate-finding bugs. Future language additions (Rust, Go) plug into the same helper and inherit both the measurement contract and the dedup guard for free.

### AC-4 · Language-to-detector routing is an inline ternary rather than a declarative table
Strength: Worth exploring
Files: src/function-length-scan.js

Problem:
`scanProject` selects the detector with the expression `const finder = file.endsWith('.py') ? findLongPythonFunctions : findLongFunctions;` buried inside the per-file loop. The full language coverage is split across two locations: the `SCAN_EXTENSIONS` array (which lists which extensions are scanned) and this ternary (which maps an extension to a detector). A reader must cross-reference both to understand the complete picture, and adding a third language requires editing the loop body, the extensions array, and the regex patterns in three separate spots with no single declarative statement of "language X uses detector Y."

Solution:
Replace the inline ternary with a small declarative map, e.g. `const DETECTORS = { '.py': findLongPythonFunctions, '.js': findLongFunctions };` placed adjacent to `SCAN_EXTENSIONS`, and a `getDetector(ext)` lookup that returns the mapped function (or `null` for unhandled extensions). The loop body becomes `const finder = getDetector(ext); if (!finder) continue;`. The map and the extensions array are co-located, making the full language coverage visible in one glance.

Benefits:
Adding a new language is a single map entry plus its regex, rather than a ternary edit inside the loop. The declarative table serves as self-documenting coverage: a reviewer can see at a glance which languages are supported and which detector handles each. The `getDetector` null-return path gives a clean, testable extension point for future languages without touching the loop logic.
