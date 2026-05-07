export type FullAutoStatus = 'idle' | 'running' | 'paused' | 'terminated';
export interface FullAutoDenialRecord {
    timestamp: string;
    tool?: string;
    code?: string;
    reason: string;
}
export interface FullAutoCounters {
    architectTurns: number;
    toolCalls: number;
    coderDelegations: number;
    reviewerRejections: number;
    testFailures: number;
    oversightChecks: number;
    consecutiveNoProgressTurns: number;
}
export interface FullAutoRunState {
    status: FullAutoStatus;
    sessionID: string;
    mode: 'assisted' | 'supervised' | 'strict';
    planID?: string;
    currentPhase?: number;
    currentTaskID?: string;
    startedAt: string;
    updatedAt: string;
    lastOversightAt?: string;
    lastOversightReason?: string;
    lastOversightVerdict?: string;
    denialCounters: {
        consecutive: number;
        total: number;
    };
    denialHistory: FullAutoDenialRecord[];
    counters: FullAutoCounters;
    pauseReason?: string;
    terminateReason?: string;
}
export interface FullAutoPersistedState {
    version: 2;
    updatedAt: string;
    /**
     * Monotonic counter for `full_auto_oversight` evidence-file sequencing.
     * Persisted so the per-phase filename `full-auto-{seq}.json` does not
     * collide after a process restart. (C4 fix.)
     */
    oversightSequence?: number;
    sessions: Record<string, FullAutoRunState>;
}
export interface FullAutoConfigShape {
    enabled?: boolean;
    mode?: 'assisted' | 'supervised' | 'strict';
    denials?: {
        max_consecutive?: number;
        max_total?: number;
        on_limit?: 'pause' | 'terminate';
    };
}
export declare class FullAutoStateUnreadableError extends Error {
    constructor(reason: string);
}
export declare function isFullAutoStateUnreadable(): {
    unreadable: boolean;
    reason: string;
};
declare function readPersisted(directory: string): FullAutoPersistedState;
/**
 * Atomically persist Full-Auto durable state.
 *
 * TASK 3 fix: persistence failures MUST propagate. The previous
 * implementation caught and logged write errors, which let
 * `startFullAutoRun` (and the `/swarm full-auto on` command) silently
 * report success even when nothing was written. Callers relied on the
 * durable record to fail-closed; that contract is now enforced.
 *
 * Behavior:
 *   - Writes via `tmp -> fsync -> rename`, so a crash mid-write cannot
 *     truncate the canonical file.
 *   - Keeps `.bak` of the prior canonical file as a recovery hint.
 *   - Reads the file back after the rename and confirms the JSON
 *     round-trips. Any failure throws.
 */
declare function writePersisted(directory: string, persisted: FullAutoPersistedState): void;
export declare function loadFullAutoRunState(directory: string, sessionID: string): FullAutoRunState | undefined;
export declare function saveFullAutoRunState(directory: string, state: FullAutoRunState): void;
export declare function startFullAutoRun(directory: string, sessionID: string, config: FullAutoConfigShape | undefined, options?: {
    planID?: string;
    phase?: number;
    taskID?: string;
}): FullAutoRunState;
export declare function pauseFullAutoRun(directory: string, sessionID: string, reason: string): FullAutoRunState | undefined;
export declare function terminateFullAutoRun(directory: string, sessionID: string, reason: string): FullAutoRunState | undefined;
export declare function isFullAutoRunActive(directory: string, sessionID: string): boolean;
export type FullAutoCounterKey = keyof FullAutoCounters;
export declare function incrementFullAutoCounter(directory: string, sessionID: string, counter: FullAutoCounterKey, delta?: number): FullAutoRunState | undefined;
export declare function recordFullAutoDenial(directory: string, sessionID: string, denial: {
    tool?: string;
    code?: string;
    reason: string;
}): FullAutoRunState | undefined;
export declare function resetFullAutoDenials(directory: string, sessionID: string): FullAutoRunState | undefined;
/**
 * Atomically increment and return the durable oversight-evidence sequence
 * counter. Used by `writeFullAutoOversightEvidence` to produce stable,
 * non-colliding evidence filenames across process restarts. (C4 fix.)
 */
export declare function nextFullAutoOversightSequence(directory: string): number;
export declare function recordFullAutoOversight(directory: string, sessionID: string, verdict: string, reason: string): FullAutoRunState | undefined;
export interface DenialLimitDecision {
    pause: boolean;
    reason?: string;
    mode?: 'pause' | 'terminate';
}
export declare function shouldPauseForDenials(state: FullAutoRunState, config: FullAutoConfigShape | undefined): DenialLimitDecision;
/**
 * Test-only DI seam — same rationale as `src/state.ts:_internals`.
 */
export declare const _internals: {
    readPersisted: typeof readPersisted;
    writePersisted: typeof writePersisted;
};
export {};
