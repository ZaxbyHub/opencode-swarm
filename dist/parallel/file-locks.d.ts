import * as fs from 'node:fs';
/**
 * Test-only dependency-injection seam. Tests replace the function on this
 * object so they can inject mock behaviour without touching the real
 * `proper-lockfile` module — `mock.module` from `bun:test` leaks across
 * files in Bun's shared test-runner process, which would corrupt
 * unrelated suites. Mutating this local object is file-scoped and
 * trivially restorable via `afterEach`.
 *
 * NOTE: Production code does NOT call through this seam internally.
 * `_internals` exists solely to allow test code to intercept lock
 * acquisition without patching the real implementation.
 */
export declare const _internals: {
    tryAcquireLock: typeof tryAcquireLock;
    writeFile: typeof fs.promises.writeFile;
};
/**
 * Sidecar metadata written alongside each lock sentinel file.
 */
export interface LockMetadata {
    originalPath: string;
    laneId: string;
    taskId: string;
    agent: string;
    sessionID: string;
    acquiredAt: string;
    expiresAt: number;
}
export interface FileLock {
    filePath: string;
    agent: string;
    taskId: string;
    timestamp: string;
    expiresAt: number;
    laneId?: string;
    _release?: () => Promise<void>;
}
/**
 * Try to acquire a lock on a file using proper-lockfile
 */
export declare function tryAcquireLock(directory: string, filePath: string, agent: string, taskId: string): Promise<{
    acquired: true;
    lock: FileLock;
} | {
    acquired: false;
    existing?: FileLock;
}>;
/**
 * Release a lock on a file.
 *
 * The preferred release path is `lockResult.lock._release()` at the call site.
 * This function is kept for API compatibility but is a no-op: callers that
 * stored a proper-lockfile release function on `lock._release` should call
 * that directly.  Callers that do not have the release function (e.g. tests
 * that write lock sentinel files by hand) can ignore the return value.
 */
export declare function releaseLock(_directory: string, _filePath: string, _taskId: string): Promise<boolean>;
/**
 * Check if a file is locked
 */
export declare function isLocked(directory: string, filePath: string): FileLock | null;
/**
 * Clean up expired locks and their sidecar metadata files.
 */
export declare function cleanupExpiredLocks(directory: string): number;
/**
 * List all active locks, reading metadata from sidecar files when available.
 * Filters out expired locks.
 */
export declare function listActiveLocks(directory: string): FileLock[];
/**
 * Acquire locks for all files in a lane (all-or-nothing).
 *
 * If ANY file is already locked, releases ALL previously acquired locks
 * in this lane and returns `{ acquired: false, conflicts }`.
 *
 * @param directory - Project root directory
 * @param laneId - Unique lane identifier
 * @param files - Array of file paths to lock
 * @param agent - Agent name
 * @param taskId - Task ID
 * @param sessionID - Session ID
 * @returns Success with array of FileLock objects, or failure with conflict list
 */
export declare function acquireLaneLocks(directory: string, laneId: string, files: string[], agent: string, taskId: string, sessionID: string): Promise<{
    acquired: true;
    locks: FileLock[];
} | {
    acquired: false;
    conflicts: string[];
}>;
/**
 * Release all locks for a given lane.
 *
 * Reads all `.meta` files in `.swarm/locks/`, finds entries matching `laneId`,
 * and releases + deletes corresponding lock files.
 *
 * @param directory - Project root directory
 * @param laneId - Lane ID to release
 * @returns Number of locks released
 */
export declare function releaseLaneLocks(directory: string, laneId: string): Promise<number>;
