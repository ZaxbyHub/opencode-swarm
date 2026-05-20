/**
 * Run Memory Service
 *
 * Provides append-only per-task outcome logging for tracking task execution
 * results across swarm sessions. Used to avoid repeating known failure patterns.
 */
/**
 * Represents a single task execution outcome entry
 */
export interface RunMemoryEntry {
    /** ISO timestamp when the entry was recorded */
    timestamp: string;
    /** Plan.json task ID (e.g. "3.2") */
    taskId: string;
    /** SHA256 hash of taskId + sorted file targets, first 8 chars */
    taskFingerprint: string;
    /** Which agent executed the task (e.g. "coder") */
    agent: string;
    /** Outcome of the task execution */
    outcome: 'pass' | 'fail' | 'retry' | 'skip';
    /** 1-indexed attempt number */
    attemptNumber: number;
    /** One-line failure reason (only for fail/retry outcomes) */
    failureReason?: string;
    /** Files that were modified during this attempt */
    filesModified?: string[];
    /** Wall-clock time in milliseconds */
    durationMs?: number;
}
/**
 * Generate a task fingerprint from taskId and file targets
 *
 * @param taskId - The task identifier
 * @param fileTargets - Array of file paths that were targeted
 * @returns First 8 characters of SHA256 hash
 */
export declare function generateTaskFingerprint(taskId: string, fileTargets: string[]): string;
/**
 * Append a task outcome entry to the run memory log
 *
 * @param directory - The swarm workspace directory
 * @param entry - The outcome entry to record
 */
export declare function recordOutcome(directory: string, entry: RunMemoryEntry): Promise<void>;
/**
 * Get all entries for a specific task ID
 *
 * @param directory - The swarm workspace directory
 * @param taskId - The task identifier to filter by
 * @returns Array of matching entries
 */
export declare function getTaskHistory(directory: string, taskId: string): Promise<RunMemoryEntry[]>;
/**
 * Get all failure and retry entries
 *
 * @param directory - The swarm workspace directory
 * @returns Array of fail/retry entries
 */
export declare function getFailures(directory: string): Promise<RunMemoryEntry[]>;
/**
 * Group entries by taskId
 */
declare function groupByTaskId(entries: RunMemoryEntry[]): Map<string, RunMemoryEntry[]>;
/**
 * Build a summary line for a single task
 */
declare function summarizeTask(taskId: string, entries: RunMemoryEntry[]): string | null;
/**
 * Generate a compact summary of task failures for context injection
 *
 * @param directory - The swarm workspace directory
 * @returns Formatted summary string (≤500 tokens) or null if no failures
 */
export declare function getRunMemorySummary(directory: string): Promise<string | null>;
/**
 * DI seam for testability. Contains all test-mocked exports.
 * Internal calls should use _internals.fn() instead of fn() directly.
 */
export declare const _internals: {
    generateTaskFingerprint: typeof generateTaskFingerprint;
    recordOutcome: typeof recordOutcome;
    getTaskHistory: typeof getTaskHistory;
    getFailures: typeof getFailures;
    getRunMemorySummary: typeof getRunMemorySummary;
    groupByTaskId: typeof groupByTaskId;
    summarizeTask: typeof summarizeTask;
};
export {};
