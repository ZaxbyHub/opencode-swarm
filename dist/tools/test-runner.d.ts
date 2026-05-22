import type { tool } from '@opencode-ai/plugin';
export declare const MAX_OUTPUT_BYTES = 512000;
export declare const MAX_COMMAND_LENGTH = 500;
export declare const DEFAULT_TIMEOUT_MS = 60000;
export declare const MAX_TIMEOUT_MS = 300000;
export declare const MAX_SAFE_TEST_FILES = 50;
export declare const MAX_SAFE_SOURCE_FILES = 1;
/**
 * Estimate the fan-out (number of unique test files) for given source files
 * by reading the cached impact map without spawning a subprocess.
 * This is a pre-resolution check to prevent session blocking.
 *
 * Completes in <100ms by design — reads only the cached JSON and performs
 * in-memory Set collection.
 */
export declare function estimateFanOut(sourceFiles: string[], cwd: string): Promise<{
    estimatedCount: number;
}>;
export declare const SUPPORTED_FRAMEWORKS: readonly ["bun", "vitest", "jest", "mocha", "pytest", "cargo", "pester", "go-test", "maven", "gradle", "dotnet-test", "ctest", "swift-test", "dart-test", "rspec", "minitest"];
export type TestFramework = (typeof SUPPORTED_FRAMEWORKS)[number] | 'none';
export interface TestRunnerArgs {
    scope?: 'all' | 'convention' | 'graph' | 'impact';
    files?: string[];
    coverage?: boolean;
    timeout_ms?: number;
    allow_full_suite?: boolean;
}
export type RegressionOutcome = 'pass' | 'skip' | 'regression' | 'scope_exceeded' | 'error';
export interface TestTotals {
    passed: number;
    failed: number;
    skipped: number;
    total: number;
}
export interface ParsedTestCaseResult {
    testFile: string;
    testName: string;
    result: 'pass' | 'fail' | 'skip';
    durationMs: number;
    errorMessage?: string;
    stackPrefix?: string;
}
export interface TestSuccessResult {
    success: true;
    framework: TestFramework;
    scope: 'all' | 'convention' | 'graph' | 'impact';
    command: string[];
    timeout_ms: number;
    duration_ms: number;
    totals: TestTotals;
    coveragePercent?: number;
    rawOutput?: string;
    testCases?: ParsedTestCaseResult[];
    message?: string;
    outcome?: RegressionOutcome;
}
export interface TestErrorResult {
    success: false;
    framework: TestFramework;
    scope: 'all' | 'convention' | 'graph' | 'impact';
    command?: string[];
    timeout_ms?: number;
    duration_ms?: number;
    totals?: TestTotals;
    coveragePercent?: number;
    error: string;
    rawOutput?: string;
    testCases?: ParsedTestCaseResult[];
    message?: string;
    outcome?: RegressionOutcome;
    attempted_scope?: 'graph';
}
export type TestResult = TestSuccessResult | TestErrorResult;
export declare function detectTestFrameworkViaDispatch(cwd: string): Promise<TestFramework>;
/**
 * Build a test command via the LanguageBackend dispatch path. Reverse-maps
 * the union TestFramework string back to the profile name and asks the
 * matching backend to produce a command. Falls back to the legacy switch
 * (via `defaultBuildTestCommand` import) when no backend is registered or
 * the backend has no `buildTestCommand` hook.
 *
 * Returns null on framework=`none` or when dispatch fails — callers (the
 * test-runner) then surface "no test command available".
 */
export declare function buildTestCommandViaDispatch(framework: TestFramework, scope: 'all' | 'convention' | 'graph' | 'impact', files: string[], coverage: boolean, baseDir: string): Promise<string[] | null>;
/**
 * Parse test output via the LanguageBackend dispatch path. Calls
 * `backend.parseTestOutput` for the directory's resolved backend and
 * returns the legacy-shaped `{ totals, coveragePercent? }` for the
 * test-runner. Returns null when dispatch fails.
 */
export declare function parseTestOutputViaDispatch(framework: TestFramework, output: string, baseDir: string): Promise<{
    totals: TestTotals;
    coveragePercent?: number;
} | null>;
export declare function detectTestFramework(cwd: string): Promise<TestFramework>;
/**
 * Returns true when `basename` matches a language-specific test file naming
 * convention that is NOT captured by the compound-extension or dot-separated
 * `.test.`/`.spec.` checks above.
 *
 * Covered patterns (all lower-cased for comparison):
 *   Go   : <name>_test.go          (per `go test` convention)
 *   Python: test_<name>.py          (pytest discovery default)
 *           <name>_test.py          (pytest alternative)
 *   Ruby : <name>_spec.rb           (RSpec convention)
 *   Java : Test<Name>.java          (JUnit 4/5 prefix)
 *          <Name>Test.java          (JUnit 4/5 suffix)
 *          <Name>Tests.java         (JUnit 4/5 plural suffix)
 *          <Name>IT.java            (Maven Failsafe integration-test suffix)
 *   C#   : <Name>Test.cs            (xUnit/NUnit/MSTest suffix)
 *          <Name>Tests.cs           (xUnit/NUnit/MSTest plural suffix)
 *   Rust : test files are recognized by test-directory placement
 *           (for example, tests/<anything>.rs via /tests/ path detection)
 *   Kotlin: <Name>Test.kt / <Name>Tests.kt / Test<Name>.kt
 *
 * Exported for unit tests; production code uses it only through
 * getTestFilesFromConvention.
 */
export declare function isLanguageSpecificTestFile(basename: string): boolean;
/**
 * Map source files (or already-test files) to the test files that should be
 * run for them. Handles any language whose test files follow a naming convention
 * — TS/JS, Go, Python, Ruby, Java, C#, Kotlin, PowerShell.
 *
 * Exported for unit tests.
 */
export declare function getTestFilesFromConvention(sourceFiles: string[], workingDir?: string): string[];
export declare function runTests(framework: TestFramework, scope: 'all' | 'convention' | 'graph' | 'impact', files: string[], coverage: boolean, timeout_ms: number, cwd: string): Promise<TestResult>;
export declare const test_runner: ReturnType<typeof tool>;
