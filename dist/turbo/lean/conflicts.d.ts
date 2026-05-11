/**
 * File Scope Conflict Detection for Lean Turbo.
 *
 * This module provides conflict detection utilities for determining whether
 * tasks can be executed in parallel based on their file scopes.
 *
 * ## Conflict Detection Rules
 *
 * Two tasks conflict if:
 * - They touch the **same file**
 * - One task touches a **parent directory** of a file the other task touches
 *   (e.g., `src/auth/` vs `src/auth/login.ts`)
 * - A task touches a **global file** (affects all coders)
 * - A task touches a **protected path** (security-sensitive areas)
 *
 * ## Path Normalization
 *
 * All paths are normalized to POSIX-style (forward slashes, no trailing slash)
 * before conflict detection. This ensures consistent behavior across platforms.
 */
/**
 * A scope file persisted by the `declare_scope` tool.
 * Stored at `.swarm/scopes/scope-{taskId}.json`.
 */
export interface ScopeFile {
    taskId: string;
    files: string[];
    declaredAt: string;
}
/**
 * Barrel file patterns that indicate generated/index files.
 * These are treated as global because other tasks may import from them.
 */
export declare const BARREL_FILE_PATTERNS: readonly RegExp[];
/**
 * Normalize a file path to POSIX-style for consistent cross-platform comparison.
 *
 * - Converts backslashes to forward slashes
 * - Removes trailing slashes
 * - Collapses multiple consecutive slashes
 * - Resolves `.` path segments (current directory references)
 * - Does NOT resolve `..` segments or symlinks
 *
 * @param filePath - The path to normalize
 * @returns POSIX-normalized path
 */
export declare function normalizePath(filePath: string): string;
/**
 * Check if a path contains directory traversal components.
 * Rejects paths with `..` segments that could escape the project root.
 *
 * @param filePath - The path to validate
 * @returns true if the path is safe (no traversal)
 */
export declare function isPathSafe(filePath: string): boolean;
/**
 * Check if two normalized paths conflict.
 *
 * Conflicts occur when:
 * - The paths are identical (same file)
 * - One path is a parent directory of the other
 *
 * IMPORTANT: Parent/child detection is path-segment aware.
 * `src/auth/` contains `src/auth/login.ts` but NOT `src/authentication.ts`.
 *
 * @param path1 - First normalized path
 * @param path2 - Second normalized path
 * @returns true if the paths conflict
 */
export declare function pathsConflict(path1: string, path2: string): boolean;
/**
 * Check if a normalized path is a global file.
 * Global files affect all coders and cannot be parallelized safely.
 *
 * @param normalizedPath - POSIX-normalized path
 * @returns true if the file is global
 */
export declare function isGlobalFile(normalizedPath: string): boolean;
/**
 * Check if a normalized path matches a protected path pattern.
 * Protected paths are security-sensitive areas that require special handling.
 *
 * @param normalizedPath - POSIX-normalized path to check
 * @returns true if the path is protected
 */
export declare function isProtectedPath(normalizedPath: string): boolean;
/**
 * Read task scope from the scope file for a given task.
 *
 * Scope files are stored at `.swarm/scopes/scope-{taskId}.json`.
 *
 * @param directory - The project root directory
 * @param taskId - The task ID (e.g., "4.1")
 * @returns Array of file paths, or null if scope file doesn't exist
 */
export declare function readTaskScopes(directory: string, taskId: string): string[] | null;
/** Exported for unit testing */
export declare const GLOBAL_FILES_LIST: readonly string[];
/** Exported for unit testing */
export declare const PROTECTED_PATTERNS_LIST: readonly string[];
