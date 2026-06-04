/**
 * SCOPE GUARD (v6.31 Task 3.1)
 *
 * CONFIRMED THROW MECHANISM: throwing in tool.execute.before propagates as tool rejection,
 * NOT as session crash. Verified from guardrails.ts multiple existing throw sites.
 * Safe blocking pattern: throw new Error(`SCOPE VIOLATION: ...`)
 *
 * Fires BEFORE write/edit tools execute. When a non-architect agent attempts to
 * modify a file outside the declared task scope, blocks the call and injects an advisory.
 */
/**
 * Configuration for scope guard behavior.
 */
export interface ScopeGuardConfig {
    /** Whether scope guard is enabled (default: true) */
    enabled: boolean;
    /** Whether to skip in turbo mode (default: false — NOT skippable by design) */
    skip_in_turbo: boolean;
}
/**
 * Creates the scope-guard hook that blocks out-of-scope writes.
 * @param config - ScopeGuardConfig (enabled, skip_in_turbo)
 * @param _directory - The workspace directory (reserved for future use)
 * @param injectAdvisory - Optional callback to push advisory to architect session
 */
export declare function createScopeGuardHook(config: Partial<ScopeGuardConfig>, directory: string, injectAdvisory?: (sessionId: string, message: string) => void): {
    toolBefore: (input: {
        tool: string;
        sessionID: string;
        callID: string;
    }, output: {
        args: unknown;
    }) => Promise<void>;
};
/**
 * Check if a file path is within declared scope entries.
 * Handles exact match and directory containment.
 *
 * @param filePath - The file path to check
 * @param scopeEntries - Array of declared scope entries (files or directories)
 * @returns true if the file is within scope, false otherwise
 */
export declare function isFileInScope(filePath: string, scopeEntries: string[], directory?: string): boolean;
/**
 * Sanitize a raw file path string to prevent log injection and null-byte attacks.
 * Replaces C0 control characters (0x00-0x1F), DEL (0x7F), C1 control characters
 * (0x80-0x9F), and strips remaining ANSI CSI sequences.
 *
 * All matched control characters are replaced with underscores rather than removed,
 * so that the resulting string can still be passed to `path.resolve()` without
 * triggering `ERR_INVALID_ARG_VALUE` on embedded null bytes.
 *
 * Extracted from the original inline sanitization in the scope guard
 * to support reuse across single-path and multi-path code paths.
 *
 * @param raw - The unsanitized file path string
 * @returns The sanitized file path string safe for logging and scope matching
 */
declare function sanitizePath(raw: string): string;
/**
 * Internal implementation details exposed for unit testing.
 * DO NOT use these in production code.
 */
export declare const _internals: {
    sanitizePath: typeof sanitizePath;
};
export {};
