export type LeanTurboStatus = 'idle' | 'running' | 'paused' | 'terminated';
export interface LeanTurboLane {
    laneId: string;
    taskIds: string[];
    files: string[];
    status: 'pending' | 'running' | 'completed' | 'failed' | 'blocked';
    startedAt?: string;
    completedAt?: string;
    error?: string;
    agent?: string;
    sessionId?: string;
}
export interface LeanTurboDegradedTask {
    taskId: string;
    reason: string;
    files: string[];
    requiredMode: 'standard' | 'balanced';
}
export interface LeanTurboCounters {
    lanesPlanned: number;
    lanesStarted: number;
    lanesCompleted: number;
    lanesFailed: number;
    tasksSerialized: number;
    tasksDegraded: number;
}
export interface LeanTurboRunState {
    status: LeanTurboStatus;
    sessionID: string;
    strategy: 'lean';
    phase?: number;
    maxParallelCoders: number;
    planId?: string;
    activeLanePlanId?: string;
    lanes: LeanTurboLane[];
    degradedTasks: LeanTurboDegradedTask[];
    /** Task IDs excluded from parallel lanes, must complete via standard serial flow */
    serializedTasks: string[];
    lastReviewerVerdict?: 'APPROVED' | 'NEEDS_REVISION' | 'REJECTED';
    lastCriticVerdict?: string;
    pauseReason?: string;
    terminateReason?: string;
    counters: LeanTurboCounters;
}
export interface LeanTurboPersistedState {
    version: 1;
    updatedAt: string;
    sessions: Record<string, LeanTurboRunState>;
}
export declare function emptyCounters(): LeanTurboCounters;
export declare function emptyRunState(sessionID: string, maxParallelCoders: number): LeanTurboRunState;
export declare function emptyPersisted(): LeanTurboPersistedState;
export declare function isStateUnreadable(directory: string): boolean;
export declare function repairStateUnreadable(directory: string): void;
export declare function readPersisted(directory: string): LeanTurboPersistedState | null;
export declare function writePersisted(directory: string, persisted: LeanTurboPersistedState): void;
export declare function loadLeanTurboRunState(directory: string, sessionID: string): LeanTurboRunState | null;
export declare function saveLeanTurboRunState(directory: string, runState: LeanTurboRunState): void;
export declare function isLeanTurboRunActive(directory: string, sessionID: string): boolean;
export declare function pauseLeanTurboRun(directory: string, sessionID: string, reason: string): void;
export declare function resetLeanTurboRun(directory: string, sessionID: string): void;
