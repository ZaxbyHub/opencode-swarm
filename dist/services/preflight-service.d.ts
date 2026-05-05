/**
 * Preflight Automation Service
 *
 * Runs automated preflight checks for release readiness:
 * - lint check
 * - tests check (sane verification scope)
 * - secrets check
 * - evidence completeness check
 * - version consistency check
 *
 * Returns deterministic structured result with per-check status + overall verdict.
 * Callable by background flow (from preflight.requested events).
 */
/** Preflight check types */
export type PreflightCheckType = 'lint' | 'tests' | 'secrets' | 'evidence' | 'version' | 'req_coverage';
/** Individual check status */
export interface PreflightCheckResult {
    type: PreflightCheckType;
    status: 'pass' | 'fail' | 'skip' | 'error';
    message: string;
    details?: Record<string, unknown>;
    durationMs?: number;
}
/** Preflight report structure */
export interface PreflightReport {
    id: string;
    timestamp: number;
    phase: number;
    overall: 'pass' | 'fail' | 'skipped';
    checks: PreflightCheckResult[];
    totalDurationMs: number;
    message: string;
}
/** Preflight configuration */
export interface PreflightConfig {
    /** Timeout per check in ms (default 60s, min 5s, max 300s) */
    checkTimeoutMs?: number;
    /** Skip tests check (default false) */
    skipTests?: boolean;
    /** Skip secrets check (default false) */
    skipSecrets?: boolean;
    /** Skip evidence check (default false) */
    skipEvidence?: boolean;
    /** Skip version check (default false) */
    skipVersion?: boolean;
    /** Test scope (default 'convention' for faster preflight) */
    testScope?: 'all' | 'convention' | 'graph';
    /** Linter to use (default 'biome') */
    linter?: 'biome' | 'eslint';
}
/**
 * Validate directory path to prevent path traversal attacks.
 * Returns the normalized absolute path if valid, or throws an error.
 */
declare function validateDirectoryPath(dir: string): string;
/**
 * Validate and sanitize timeout value.
 * Returns a valid timeout within bounds, or throws an error for invalid values.
 */
declare function validateTimeout(timeoutMs: number | undefined, defaultValue: number): number;
/**
 * Get package.json version from directory
 */
declare function getPackageVersion(dir: string): string | null;
/**
 * Get version from CHANGELOG.md (latest version header)
 */
declare function getChangelogVersion(dir: string): string | null;
/**
 * Get version from version file (e.g., VERSION.txt, version.txt)
 */
declare function getVersionFileVersion(dir: string): string | null;
/**
 * Run version consistency check
 */
declare function runVersionCheck(dir: string, _timeoutMs: number): Promise<PreflightCheckResult>;
/**
 * Run lint check
 */
declare function runLintCheck(dir: string, linter: 'biome' | 'eslint', timeoutMs: number): Promise<PreflightCheckResult>;
/**
 * Run tests check
 */
declare function runTestsCheck(_dir: string, scope: 'all' | 'convention' | 'graph', timeoutMs: number): Promise<PreflightCheckResult>;
/**
 * Run secrets check
 */
declare function runSecretsCheck(dir: string, timeoutMs: number): Promise<PreflightCheckResult>;
/**
 * Run evidence completeness check
 */
declare function runEvidenceCheck(dir: string): Promise<PreflightCheckResult>;
/**
 * Run requirement coverage check
 */
declare function runRequirementCoverageCheck(dir: string, currentPhase: number): Promise<PreflightCheckResult>;
/**
 * Run all preflight checks
 */
export declare function runPreflight(dir: string, phase: number, config?: PreflightConfig): Promise<PreflightReport>;
/**
 * Format preflight report as markdown
 */
export declare function formatPreflightMarkdown(report: PreflightReport): string;
/**
 * Handle preflight command - thin adapter for CLI
 */
export declare function handlePreflightCommand(directory: string, _args: string[]): Promise<string>;
/**
 * DI seam for testability. Contains all test-mocked exports.
 * Internal calls should use _internals.fn() instead of fn() directly.
 */
export declare const _internals: {
    runPreflight: typeof runPreflight;
    formatPreflightMarkdown: typeof formatPreflightMarkdown;
    handlePreflightCommand: typeof handlePreflightCommand;
    validateDirectoryPath: typeof validateDirectoryPath;
    validateTimeout: typeof validateTimeout;
    getPackageVersion: typeof getPackageVersion;
    getChangelogVersion: typeof getChangelogVersion;
    getVersionFileVersion: typeof getVersionFileVersion;
    runVersionCheck: typeof runVersionCheck;
    runLintCheck: typeof runLintCheck;
    runTestsCheck: typeof runTestsCheck;
    runSecretsCheck: typeof runSecretsCheck;
    runEvidenceCheck: typeof runEvidenceCheck;
    runRequirementCoverageCheck: typeof runRequirementCoverageCheck;
};
export {};
