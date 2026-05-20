#!/usr/bin/env bun
export declare function isSafeCachePath(p: string): boolean;
/**
 * Safety guard for lock file deletion. Lock files have different basenames
 * than cache directories so they need a separate check. Mirrors
 * isSafeCachePath()'s defense-in-depth: minimum segment depth, recognized
 * basename, and parent directory must be 'opencode'.
 */
export declare function isSafeLockFilePath(p: string): boolean;
/**
 * Recursively delete every known opencode plugin cache location for
 * opencode-swarm. Returns paths actually cleared and paths that errored.
 * Skips paths that don't exist or fail the safety guard.
 */
export declare function evictPluginCaches(): {
    cleared: string[];
    failed: string[];
};
/**
 * Delete every known opencode plugin lock file (bun.lock, bun.lockb,
 * package-lock.json). Returns paths actually cleared and paths that
 * errored. Skips paths that don't exist or fail the safety guard.
 *
 * Why: opencode runs `bun install` at startup; bun.lock pins the
 * installed plugin version. Deleting the lock forces re-resolution
 * from npm so users actually receive the @latest version after `update`.
 */
export declare function evictLockFiles(): {
    cleared: string[];
    failed: string[];
};
/**
 * Dispatch function for routing argv tokens to plugin command handlers.
 * Used by the "run" subcommand entry point.
 * Delegates to the unified COMMAND_REGISTRY via resolveCommand().
 */
export declare function run(args: string[]): Promise<number>;
