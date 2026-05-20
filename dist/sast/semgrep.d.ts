/**
 * Semgrep Integration for Tier B SAST Enhancement
 * Provides optional Semgrep detection and invocation for advanced static analysis
 */
import type { SastFinding } from './rules/index.js';
/**
 * Semgrep CLI options
 */
export interface SemgrepOptions {
    /** Files or directories to scan */
    files: string[];
    /** Directory containing Semgrep rules (default: .swarm/semgrep-rules/) */
    rulesDir?: string;
    /** Timeout in milliseconds (default: 30000) */
    timeoutMs?: number;
    /** Working directory for Semgrep execution */
    cwd?: string;
    /** Language identifier for --lang flag (used with useAutoConfig) */
    lang?: string;
    /** When true, use --config auto instead of local rulesDir (for profile-driven languages) */
    useAutoConfig?: boolean;
}
/**
 * Result from Semgrep execution
 */
export interface SemgrepResult {
    /** Whether Semgrep is available on the system */
    available: boolean;
    /** Array of security findings from Semgrep */
    findings: SastFinding[];
    /** Error message if Semgrep failed */
    error?: string;
    /** Engine label for the findings */
    engine: 'tier_a' | 'tier_a+tier_b';
}
export declare const _internals: {
    isSemgrepAvailable: typeof isSemgrepAvailable;
    checkSemgrepAvailable: typeof checkSemgrepAvailable;
    resetSemgrepCache: typeof resetSemgrepCache;
    runSemgrep: typeof runSemgrep;
    getRulesDirectory: typeof getRulesDirectory;
    hasBundledRules: typeof hasBundledRules;
};
/**
 * Check if Semgrep CLI is available on the system
 * Uses caching to avoid shelling out on every check
 * @returns true if Semgrep is available, false otherwise
 */
export declare function isSemgrepAvailable(): boolean;
/**
 * Check if Semgrep is available (async version for consistency)
 * @returns Promise resolving to availability status
 */
export declare function checkSemgrepAvailable(): Promise<boolean>;
/**
 * Reset the Semgrep availability cache (useful for testing)
 */
export declare function resetSemgrepCache(): void;
/**
 * Run Semgrep on specified files
 * @param options - Semgrep options
 * @returns Promise resolving to SemgrepResult
 */
export declare function runSemgrep(options: SemgrepOptions): Promise<SemgrepResult>;
/**
 * Get the default rules directory path
 * @param projectRoot - Optional project root directory
 * @returns Absolute path to rules directory
 */
export declare function getRulesDirectory(projectRoot?: string): string;
/**
 * Check if bundled rules directory exists
 * @param projectRoot - Optional project root directory
 * @returns true if rules directory exists
 */
export declare function hasBundledRules(projectRoot?: string): boolean;
