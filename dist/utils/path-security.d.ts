/**
 * Canonical path security utilities.
 * Consolidated from 6+ local implementations across the codebase.
 * Use these instead of defining local copies.
 */
/**
 * Check if a string contains path traversal patterns.
 * Based on the most comprehensive implementation (test-runner.ts).
 * Checks: basic ../, isolated double dots, URL-encoded traversal,
 * double-encoded traversal, Unicode homoglyphs, and encoded separators.
 */
export declare function containsPathTraversal(str: string): boolean;
/**
 * Check if a string contains control characters that could be used
 * for injection attacks. Matches null byte, tab, carriage return, and newline.
 */
export declare function containsControlChars(str: string): boolean;
/**
 * Validate a directory path for safety.
 * Rejects empty paths, paths with traversal, control characters, and absolute paths.
 * Throws an Error if the directory is invalid.
 *
 * @param directory - The directory string to validate
 * @throws Error if directory is invalid
 */
export declare function validateDirectory(directory: string): void;
/**
 * Validate that a resolved path stays within an allowed root directory.
 * Resolves symlinks via realpathSync for both the target path and the root,
 * then verifies the resolved target is within the resolved root.
 *
 * @param targetPath - The path to validate (absolute)
 * @param rootPath - The root directory boundary (absolute)
 * @throws Error if the resolved target escapes the root boundary
 */
export declare function validateSymlinkBoundary(targetPath: string, rootPath: string): void;
/**
 * DI seam for testability. Contains all test-mocked exports.
 * Internal calls should use _internals.fn() instead of fn() directly.
 */
export declare const _internals: {
    containsPathTraversal: typeof containsPathTraversal;
    containsControlChars: typeof containsControlChars;
    validateDirectory: typeof validateDirectory;
    validateSymlinkBoundary: typeof validateSymlinkBoundary;
};
