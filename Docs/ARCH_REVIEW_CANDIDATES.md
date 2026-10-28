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

### AC-8 · AC-2a – Add shared scanLexicalStates generator and refactor extractBraceBody to consume it
Strength: Strong
Split-Depth: 1
Files: src/scan-utils.js, src/scan-utils.test.js

Problem:
extractBraceBody (and, separately, stripNonCode) each carry an inline copy of the same string/comment/escape state machine: inString (tracking which of ' " ` opened it), inLineComment, inBlockComment, and escapeNext. The transitions are character-for-character identical in both functions, so a fix to one (e.g. adding a new escape rule) must be manually replicated in the other. extractBraceBody's only real job is brace-depth tracking; the lexical bookkeeping is incidental and duplicated.

Solution:
1) Insert a new named-export generator function scanLexicalStates(text) in src/scan-utils.js, placed above extractBraceBody. It iterates the source once and yields { index, state } for every character, where state is one of 'code' | 'string' | 'lineComment' | 'blockComment'. It owns the inString / inLineComment / inBlockComment / escapeNext transitions (ported verbatim from extractBraceBody's existing logic, including the i++ skip for the second char of // and /*). 2) Rewrite extractBraceBody to consume the generator: iterate its output, and only when state === 'code' track brace depth and capture the body slice. Remove all four local state variables and the per-char comment/string/escape branches. Preserve the exact signature (text, openIndex), return value (substring or null), and the bodyStart / depth logic. 3) Add scanLexicalStates to the module.exports list. 4) In src/scan-utils.test.js (create if absent; use node:test per repo convention), add a describe block for scanLexicalStates with table-driven cases: plain code, double-quoted string containing // and /*, single-quoted string with escaped quote, backtick template literal, line comment containing a quote, block comment containing // and a quote, escape at end-of-line, unterminated string, unterminated block comment. Assert the full state array per input.

Benefits:
Single source of truth for lexical-state transitions in the file. extractBraceBody shrinks to a ~10-line brace-depth loop. The scanner is independently unit-testable without exercising the brace logic. Sets up stripNonCode (next candidate) to consume the same generator, eliminating the second copy.

### AC-9 · AC-2b – Refactor stripNonCode to consume the shared scanLexicalStates generator
Strength: Strong
Split-Depth: 1
Files: src/scan-utils.js
Depends-On: AC-8

Problem:
stripNonCode maintains its own inString / inLineComment / inBlockComment / escapeNext state machine (identical transitions to extractBraceBody) alongside its regex-literal-detection state (prevCodeChar, word, wordOpen). The lexical half is pure duplication of what scanLexicalStates (added in AC-2a) already provides; keeping two copies means any future fix to string/comment/escape handling must be applied in two places and can silently diverge.

Solution:
Rewrite stripNonCode's main loop to iterate over scanLexicalStates(text) instead of maintaining its own inString / inLineComment / inBlockComment / escapeNext locals. For each yielded { index, state }: if state is 'string', 'lineComment', or 'blockComment', blank out[index] (preserving newlines, matching existing behaviour); if state is 'code', run the existing regex-literal heuristic (regexAllowedAfter using prevCodeChar and word) and update prevCodeChar / word / wordOpen as before. Remove the four duplicated state variables. Keep prevCodeChar, word, wordOpen, REGEX_PREV_KEYWORDS, IDENT_CHAR_RE, and regexAllowedAfter entirely local and unchanged in behaviour. Preserve the function signature (text), the output contract (same-length string with interiors blanked, newlines preserved), and the module.exports entry.

Benefits:
Eliminates the second copy of the lexical state machine. stripNonCode's loop becomes a straightforward map over the scanner's output plus its regex-detection logic. Future lexical fixes (e.g. new escape rules, regex-literal edge cases) are made once in scanLexicalStates and automatically benefit both consumers. The regex-detection heuristic remains isolated and testable in stripNonCode's own tests.

### AC-10 · Inconsistent I/O injection in the `scanOk: false` branch of `reconcileFlags`
Strength: Strong
Files: src/flag-store.js, src/flag-store.test.js

Problem:
`reconcileFlags` already accepts an injected predicate (`isSuppressed`) to keep one I/O-dependent decision testable and side-effect-free, yet the `scanOk: false` fallback hardcodes `fs.existsSync(path.join(repoRoot, f.file))` directly. This creates two concrete costs. First, the failure path is untestable without real filesystem access: the tests that exercise it must call `fs.mkdtempSync` and `fs.writeFileSync` to create temp directories and files, while every other test in the suite uses a `'/nope'` sentinel and needs no I/O at all. Second, the `repoRoot` parameter becomes conditionally required—it is dead weight on the common `scanOk: true` path but mandatory on the failure path. A caller who forgets to supply it gets a `TypeError` thrown by `path.join`, causing the reconciliation process to crash entirely rather than gracefully handling the transient scan error.

Solution:
Replace the hardcoded `fs.existsSync` call with a second injected predicate (e.g. `fileExists`), following the same pattern already established by `isSuppressed`: accept an optional callback, default to a no-op (or a pure in-memory check) when absent, and let the caller supply the real `fs.existsSync` wrapper in production. This makes `repoRoot` unnecessary for the reconciliation function itself—the filesystem concern is pushed entirely to the caller, who already knows the repo root and can close over it in the injected callback.

Benefits:
The failure path becomes testable with the same `'/nope'`-sentinel pattern used everywhere else in the suite, eliminating the need for `mkdtempSync`/`writeFileSync` scaffolding in those tests. The `repoRoot` parameter is removed from the function signature, eliminating the conditional-relevance footgun where a forgotten argument causes a hard crash. The module's existing design principle—pure-data reconciliation with narrow, explicit escape hatches for I/O—is applied uniformly, and the test surface shrinks to a single, consistent injection contract.

NOTE: Flag #2 was not applied because the critique's claim that the draft's "silent data loss" mechanism was technically inaccurate was correct, but the critique's assertion that the proposed solution was a "marginal stylistic change" that failed to solve the "conditional parameter" issue was incorrect. The proposed solution *does* solve the conditional parameter issue by removing `repoRoot` from the function signature entirely, allowing the caller to handle the I/O context via closure, which is a valid architectural improvement consistent with the existing `isSuppressed` pattern. The draft's original error was in describing the *failure mode* of the *old* code (silent false vs. crash), which has been corrected in this version.

### AC-13 · Extract responsibilities from `nextPerformanceReviewTask` into focused sub-functions
Strength: Strong
Files: src/performance-review.js

Problem:
`nextPerformanceReviewTask` simultaneously reads coverage state and decides whether a rescan is due, invokes the scanner, reconciles the persistent flag backlog against fresh findings, writes coverage and flags JSON to disk, sorts/filters/suppresses flags, and selects the next task to emit. This single-responsibility violation means a failure mid-scan leaves coverage state inconsistent, the function is hard to unit-test because every sub-responsibility needs its own fixtures, and any change to one concern (e.g. the suppression check) requires re-reading the whole function to verify it doesn't affect the others. The scanning + reconciliation logic and the task-selection logic should be separate.

Solution:
Split `nextPerformanceReviewTask` into a small pipeline of pure or narrowly-scoped helpers: (1) `shouldRescan(lastScannedAt, now)` for the rescan-interval decision, (2) `scanCoverage(scanner, repoRoot)` for the scanner invocation, (3) `reconcileFlags(existingFlags, freshFlags)` for the flag reconciliation step, (4) `persistCoverageAndFlags(coverage, flags)` for the disk write, (5) `applySuppressionAndSort(flags, suppressed)` for filtering/suppression/sorting, and (6) `selectNextTask(flags, coverage)` for the final task selection. The top-level function becomes a thin orchestrator that threads state through these helpers in order, with each helper independently testable and each failure mode isolated to its own stage.

Benefits:
Each sub-function can be unit-tested in isolation with minimal fixtures, a failure at any stage no longer corrupts downstream state, and future changes to one concern (e.g. swapping the suppression strategy) no longer require re-reading unrelated logic. The orchestrator becomes a clear contract that documents the pipeline order, making the review loop easier to reason about and extend.

### AC-14 · Consolidate structural duplication between `performance-review.js` and `observability-review.js`
Strength: Strong
Files: src/performance-review.js, src/observability-review.js

Problem:
The two files are an "exact structural mirror" of each other — same `lastScannedAt` / rescan-interval / dedupe / prune shape, swapped only to a different scanner and coverage files. Every concern is duplicated verbatim between them: the `RESCAN_INTERVAL_MS` constant, the `slugifyForId` helper, the `findingIsSuppressed` helper, the `capabilityProfileBlock` helper, the `assemblePrompt` helper, the `SNIPPET_BEFORE`/`SNIPPET_AFTER` constants, the `reconcileFlags` call shape, the `applyArchDiscoveryCandidates` integration, the `recordFalsePositiveIfVerdict` / `recordInconclusiveReview` / `classifyReviewOutcome` triad, the `groundingFields` / `advisoryProse` / `reviewGuidance` registration shape, and the `directToMain: true` flag. Adding a new hygiene plugin means copy-pasting ~70% of an existing one and swapping a handful of identifiers — every bug fix, behavior change, or API shift in one file must be manually replicated in the other, and drift between them is inevitable.

Solution:
Extract the shared scaffolding into a single reusable module (e.g. `src/review-lib.js`) parameterized by the scanner, coverage-file paths, and any domain-specific prompt fragments. The shared pieces — `RESCAN_INTERVAL_MS`, `slugifyForId`, `findingIsSuppressed`, `capabilityProfileBlock`, `assemblePrompt`, `SNIPPET_BEFORE`/`SNIPPET_AFTER`, `reconcileFlags`, `applyArchDiscoveryCandidates`, the `recordFalsePositiveIfVerdict` / `recordInconclusiveReview` / `classifyReviewOutcome` triad, the `groundingFields` / `advisoryProse` / `reviewGuidance` registration shape, and the `directToMain: true` flag — all move into the library. Each review file then becomes a thin adapter that supplies its scanner and file paths to the shared pipeline. A small regression test suite against the library covers the shared behavior once, for both reviewers.

Benefits:
A bug fix or behavior change in the shared logic is applied in one place and immediately correct for both reviewers. Adding a new hygiene plugin no longer requires copy-paste; it becomes a matter of wiring a new adapter. Drift between the two files becomes structurally impossible, and the test surface shrinks because the shared behavior is exercised once rather than duplicated.

### AC-15 · Surface `capabilityProfileBlock` failures instead of silently swallowing them
Strength: Strong
Files: src/performance-review.js

Problem:
`capabilityProfileBlock` calls `require('agent-manager/src/config.js').getConfig()` and catches all exceptions, falling back to `projectCapabilityProfile(null, ...)`. If the config file is missing, malformed, or the repo root is wrong, the prompt sent to the LLM will include a capability block that may be empty, from a different project context, or silently incomplete — with no log line, no warning, and no way for the reviewer (human or agent) to know the data is untrustworthy. The header comment acknowledges the project "can't support" certain primitives, making this capability block the gatekeeper for whether a proposed fix is feasible — and that gate is silently bypassed on any config failure.

Solution:
Replace the blanket `catch` with a structured error path: log a clear warning (e.g. `warn('capability-profile unavailable: %s', err.message)`) and return an explicit sentinel such as `{ status: 'unavailable', reason: err.message }` rather than silently falling back to `projectCapabilityProfile(null, ...)`. Downstream code in `assemblePrompt` should check for the sentinel and either omit the capability block with a documented note, or refuse to emit the prompt and surface the failure up the call stack so the reviewer knows the data is untrustworthy. Add a unit test that exercises the failure path to ensure the sentinel propagates correctly.

Benefits:
Reviewers (human or agent) are no longer misled by a capability block that looks valid but is actually empty or stale. Config failures become visible and actionable instead of silently producing wrong output. The sentinel gives downstream code a clear decision point: proceed with a known-good marker, or abort rather than act on untrustworthy data.

NOTE: The independent review's CRITIQUE section concluded "NO ISSUES FOUND" after verifying all three claims against the source file and dismissing the pre-check "missing-file" signals as not real problems; no flags were applied.

### AC-16 · Inconsistent extraction between arch_discovery and arch_import task sources
Strength: Strong
Files: src/arch.js

Problem:
`nextArchDiscoveryTask` is properly decomposed into extracted helpers (`loadGraph`, `selectBudgetedCommunityFiles`, `communityContentHash`, `buildArchDiscoveryTaskForCommunity`, `sortedCommunitiesByCoverage`, `legacyTaskId`, `readDirtySignals`, `clearDirtySignal`, `isCommunityCovered`), each with its own comment explaining its purpose and extraction history. `nextArchImportTask` keeps all JSON I/O (`JSON.parse` of `deepDiveCoveragePath` and `importCoveragePath`), file scanning (readdirSync, block splitting), and candidate-building logic inline within the function body. This means the JSON parsing and coverage-checking logic can't be tested or verified independently, the function is larger and more complex than necessary, and there's no way to reuse the coverage-update logic without duplicating it elsewhere. This inconsistency creates a maintenance hazard: the arch_import path is harder to understand, test, and modify than the arch_discovery path, despite being equally important.

Solution:
Extract the inline logic from `nextArchImportTask` into dedicated helpers: `parseCoverageFile` (parses JSON from a coverage file path), `readImportCandidates` (reads and filters import candidates from the import directory), and `buildImportCandidate` (constructs a candidate object from parsed data). Add comments explaining each helper's purpose and relationship to `nextArchImportTask`. Mirror the extraction pattern used in `nextArchDiscoveryTask`.

Benefits:
The arch_import path becomes as maintainable and testable as the arch_discovery path. Each helper can be unit-tested in isolation, the main function becomes a clear orchestration of smaller steps, and future changes to coverage parsing or candidate building are localized to their respective helpers.

### AC-17 · Dirty signal file documentation claims single-writer semantics that the code violates
Strength: Strong
Files: src/arch.js

Problem:
The comment block for `readDirtySignals` states: "Read-only here -- arch.js never writes this file, only change_review does, so there's exactly one writer and no read-modify-write race between the two plugins' independent per-tick invocations." But `clearDirtySignal` in the same file writes to `communityDirtySignalsPath`: `function clearDirtySignal(communityDirtySignalsPath, communityId) { const signals = readDirtySignals(communityDirtySignalsPath); const key = String(communityId); if (!(key in signals)) return; delete signals[key]; writeJsonAtomicSync(communityDirtySignalsPath, signals); }`. This creates two writers to the same file: `change_review` (documented as the only writer) adds dirty flags, and `arch.js` via `clearDirtySignal` removes dirty flags. Both perform read-modify-write on the same JSON file. Even with atomic writes, there's a race: if `change_review` writes while `arch.js` is reading, `arch.js`'s read gets stale data and could clear a flag that was just set by a newer commit. The documentation's claim of "no read-modify-write race" is false, which misleads future readers about the file's concurrency properties and could cause someone to add code assuming single-writer semantics, creating bugs.

Solution:
Update the comment block for `readDirtySignals` to accurately reflect the dual-writer reality: "This file is read by arch.js and written by both change_review (additive dirty flags) and arch.js via clearDirtySignal (subtractive). Both perform read-modify-write, so there is a potential race condition if they interleave within a tick." Additionally, consider adding a comment to `clearDirtySignal` noting its write semantics and the race window. If the race is acceptable (e.g., both operations are idempotent and the worst case is a stale flag), document this explicitly. If not, explore a coordination mechanism (file locking, a single-writer proxy, or atomic compare-and-swap).

Benefits:
The documentation now accurately reflects the code's behavior, preventing future readers from making incorrect assumptions about single-writer semantics. This reduces the risk of introducing bugs when modifying either writer. If the race is acceptable, the documentation makes this explicit; if not, it prompts investigation into proper coordination.
