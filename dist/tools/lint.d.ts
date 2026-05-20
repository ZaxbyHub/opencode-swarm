import type { tool } from '@opencode-ai/plugin';
export declare const MAX_OUTPUT_BYTES = 512000;
export declare const MAX_COMMAND_LENGTH = 500;
export declare const SUPPORTED_LINTERS: readonly ["biome", "eslint"];
export type SupportedLinter = (typeof SUPPORTED_LINTERS)[number];
export type AdditionalLinter = 'ruff' | 'clippy' | 'golangci-lint' | 'checkstyle' | 'ktlint' | 'dotnet-format' | 'cppcheck' | 'swiftlint' | 'dart-analyze' | 'rubocop';
export interface LintSuccessResult {
    success: true;
    mode: 'fix' | 'check';
    linter: SupportedLinter | AdditionalLinter;
    command: string[];
    exitCode: number;
    output: string;
    message?: string;
}
export interface LintErrorResult {
    success: false;
    mode: 'fix' | 'check';
    linter?: SupportedLinter | AdditionalLinter;
    command?: string[];
    exitCode?: number;
    output?: string;
    error: string;
    message?: string;
}
export type LintResult = LintSuccessResult | LintErrorResult;
export { containsControlChars, containsPathTraversal, } from '../utils/path-security';
export declare function validateArgs(args: unknown): args is {
    mode: 'fix' | 'check';
};
export declare function getLinterCommand(linter: SupportedLinter, mode: 'fix' | 'check', projectDir: string): string[];
/**
 * Build the shell command for an additional (non-JS/TS) linter.
 * cppcheck has no --fix mode; csharp and some others behave differently.
 */
export declare function getAdditionalLinterCommand(linter: AdditionalLinter, mode: 'fix' | 'check', cwd: string): string[];
/**
 * Detect the first available additional (non-JS/TS) linter for the current project.
 * Returns null when no additional linter is detected or its binary is unavailable.
 */
export declare function detectAdditionalLinter(cwd: string): 'ruff' | 'clippy' | 'golangci-lint' | 'checkstyle' | 'ktlint' | 'dotnet-format' | 'cppcheck' | 'swiftlint' | 'dart-analyze' | 'rubocop' | null;
/** Compute the local biome binary path for a given project directory. */
export declare function getBiomeBinPath(directory: string): string;
/**
 * Resolve the binary path for a linter, using the same hierarchy as detectAvailableLinter:
 * 1. Local node_modules/.bin
 * 2. Ancestor node_modules/.bin (monorepo)
 * 3. process.env.PATH scan
 * 4. Local path as fallback (may not exist)
 */
export declare function resolveLinterBinPath(linter: SupportedLinter, projectDir: string): string;
/** Compute the local eslint binary path for a given project directory. */
export declare function getEslintBinPath(directory: string): string;
export declare function detectAvailableLinter(directory?: string): Promise<SupportedLinter | null>;
/** Internal implementation — accepts pre-computed binary paths for testability. */
export declare function _detectAvailableLinter(_projectDir: string, biomeBin: string, eslintBin: string): Promise<SupportedLinter | null>;
export declare function runLint(linter: SupportedLinter, mode: 'fix' | 'check', directory: string): Promise<LintResult>;
/**
 * Run an additional (non-JS/TS) linter.
 * Follows the same structure as runLint() but uses getAdditionalLinterCommand().
 */
export declare function runAdditionalLint(linter: AdditionalLinter, mode: 'fix' | 'check', cwd: string): Promise<LintResult>;
export declare const lint: ReturnType<typeof tool>;
/**
 * DI seam for testability. Contains all test-mocked exports.
 * Internal calls should use _internals.fn() instead of fn() directly.
 */
export declare const _internals: {
    detectAvailableLinter: typeof detectAvailableLinter;
    runLint: typeof runLint;
    detectAdditionalLinter: typeof detectAdditionalLinter;
    runAdditionalLint: typeof runAdditionalLint;
};
