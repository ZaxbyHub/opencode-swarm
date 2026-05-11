/**
 * Lean Turbo Acquire Locks Tool.
 * Wraps acquireLaneLocks from src/parallel/file-locks.
 * Acquires file locks for all files in a lane (all-or-nothing).
 */
import type { ToolDefinition } from '@opencode-ai/plugin/tool';
import { type FileLock } from '../parallel/file-locks';
/**
 * Arguments for the lean_turbo_acquire_locks tool
 */
export interface LeanTurboAcquireLocksArgs {
    directory: string;
    laneId: string;
    files: string[];
    agent: string;
    taskId: string;
    sessionID: string;
}
/**
 * Result from executing lean_turbo_acquire_locks
 */
export interface LeanTurboAcquireLocksResult {
    success: boolean;
    locks?: FileLock[];
    conflicts?: string[];
    errors?: string[];
}
/**
 * Execute the lean_turbo_acquire_locks tool.
 * Acquires locks for all files in a lane (all-or-nothing).
 */
export declare function executeLeanTurboAcquireLocks(args: LeanTurboAcquireLocksArgs): Promise<LeanTurboAcquireLocksResult>;
/**
 * Tool definition for lean_turbo_acquire_locks
 */
export declare const lean_turbo_acquire_locks: ToolDefinition;
