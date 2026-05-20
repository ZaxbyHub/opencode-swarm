/**
 * Default backend — registry-driven implementations of every optional hook
 * on `LanguageBackend`. A backend that overrides nothing still works for
 * common cases: any profile with build.commands + test.frameworks +
 * lint.linters declared correctly will get a working `selectTestFramework`,
 * `selectBuildCommand`, etc. without writing any backend code.
 *
 * No subprocess calls happen here — `isCommandAvailable` is the only seam
 * to the environment, and it lives in `src/build/discovery.ts` with full
 * invariant-3 properties (cwd, stdin: 'ignore', timeout, bounded stdio).
 */
import type { BuildCommandSelection, BuildTestCommandOpts, FrameworkSelection, LanguageBackend, TestFrameworkSelection, TestRunSummary } from './backend';
import type { LanguageProfile } from './profiles';
/**
 * Tokenize a string command into an array. Splits on whitespace; respects
 * single and double quotes for argument grouping. Used to convert profile
 * `cmd` strings (which today are written as "npx tsc --noEmit" etc.) into
 * the array form `bunSpawn` expects.
 *
 * This deliberately does NOT support shell metacharacters (`;`, `&`, `|`,
 * `>`, `<`, backticks, `$()`) — backends with non-trivial commands must
 * override `buildTestCommand`/`selectBuildCommand` to return a custom
 * `cmd: string[]`. Splitting a profile string into words is a 90% case;
 * the 10% override their backend.
 */
export declare function tokenizeCommand(cmd: string): string[];
/**
 * Default selectTestFramework: highest-priority framework whose detect
 * file exists AND whose binary is on PATH. Returns null if none.
 */
export declare function defaultSelectTestFramework(profile: LanguageProfile, dir: string): Promise<TestFrameworkSelection | null>;
/**
 * Default buildTestCommand: full 14-framework switch ported verbatim from
 * the legacy logic that lived in `src/tools/test-runner.ts:buildTestCommand`
 * (pre-Phase-3b). Handles per-framework coverage flags, scope-dependent
 * file inclusion, platform-specific python/python3, pester
 * `-EncodedCommand` for safe path passing, gradlew detection, ctest build-
 * directory probing, flutter-vs-dart selection, bundle/rspec detection,
 * and the minitest `require_relative` trick for multi-file runs.
 *
 * Backends are free to override individual framework cases via their own
 * `buildTestCommand` — this default is a single source of truth so adding
 * a 15th framework only requires one switch arm.
 *
 * `dir` is the base directory used for gradlew/ctest manifest probing.
 * `opts.scope` defaults to `'all'`; `opts.coverage` defaults to `false`.
 * Returns null when the framework name is not in the supported set.
 */
export declare function defaultBuildTestCommand(profile: LanguageProfile, framework: string, files: string[], dir?: string, opts?: BuildTestCommandOpts): string[] | null;
/**
 * Default parseTestOutput: full 14-framework switch ported verbatim from
 * `src/tools/test-runner.ts:parseTestOutput`. Returns a TestRunSummary
 * with `passed`/`failed`/`skipped`/`total`/`coveragePercent` populated
 * for every supported framework. Unknown frameworks return an
 * exit-code-only summary.
 *
 * `framework` is the union-name string (e.g. 'bun', 'vitest', 'pytest').
 * Callers pass the combined stdout+stderr as `stdout` and an empty
 * string for `stderr` per the legacy convention — the legacy parser
 * always concatenated streams before parsing.
 */
export declare function defaultParseTestOutput(framework: string, stdout: string, stderr: string, exitCode: number): TestRunSummary;
/**
 * Default detectProject: any of `profile.build.detectFiles` is present in
 * `dir`. Honors simple glob patterns the same way `detectFileExists` does.
 */
export declare function defaultDetectProject(profile: LanguageProfile, dir: string): Promise<boolean>;
/**
 * Default selectBuildCommand: highest-priority command whose detectFile
 * (if specified) exists AND whose binary is on PATH. Returns null if none.
 */
export declare function defaultSelectBuildCommand(profile: LanguageProfile, dir: string): Promise<BuildCommandSelection | null>;
/**
 * Default testFilesFor: convention swap `src/<x>.<ext>` ↔ `tests/<x>.<ext>`
 * (and `tests/<x>_test.<ext>`, `tests/<x>.test.<ext>`). Returns candidates
 * sorted by likelihood. Best-effort — backends with established patterns
 * (e.g. Python's `tests/test_<x>.py`) override.
 */
export declare function defaultTestFilesFor(profile: LanguageProfile, sourceFile: string, dir: string): Promise<string[]>;
/**
 * Default extractImports: returns []. The analyzer treats this as
 * "graph scope unavailable for {lang}" and falls back to convention scope
 * with an explicit notice. Backends with parser-driven extraction
 * (TypeScript, Python, Go in the language-agnostic plan's Phase 5) override.
 */
export declare function defaultExtractImports(): string[];
/**
 * Default selectFramework: returns null. Frameworks (React, Django, Gin)
 * are not detectable from a profile alone — a concrete backend must read
 * its language-specific manifest. Returning null causes the architect's
 * PROJECT_FRAMEWORK placeholder to resolve to the `unresolved` sentinel.
 */
export declare function defaultSelectFramework(): Promise<FrameworkSelection | null>;
/**
 * Default selectEntryPoints: returns []. Concrete backends override per
 * language. Empty list maps to the `unresolved` sentinel.
 */
export declare function defaultSelectEntryPoints(): Promise<string[]>;
/**
 * Build a backend object that delegates every hook to the registry-driven
 * defaults. Used by `pickBackend` when no language-specific override has
 * been registered. The returned object is a structural `LanguageBackend`
 * (it spreads the profile, then attaches default method bindings).
 */
export declare function defaultBackendFor(profile: LanguageProfile): LanguageBackend;
