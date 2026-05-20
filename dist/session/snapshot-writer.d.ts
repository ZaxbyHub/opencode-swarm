/**
 * Session snapshot writer for OpenCode Swarm plugin.
 * Serializes swarmState to .swarm/session/state.json using atomic write (temp-file + rename).
 */
import type { AgentSessionState, DelegationEntry, ToolAggregate } from '../state';
import { swarmState } from '../state';
/**
 * Serialized form of AgentSessionState with Map/Set fields converted to plain arrays/objects
 */
export interface SerializedAgentSession {
    agentName: string;
    lastToolCallTime: number;
    lastAgentEventTime: number;
    delegationActive: boolean;
    activeInvocationId: number;
    lastInvocationIdByAgent: Record<string, number>;
    windows: Record<string, SerializedInvocationWindow>;
    lastCompactionHint: number;
    architectWriteCount: number;
    lastCoderDelegationTaskId: string | null;
    currentTaskId: string | null;
    turboMode: boolean;
    gateLog: Record<string, string[]>;
    reviewerCallCount: Record<string, number>;
    lastGateFailure: {
        tool: string;
        taskId: string;
        timestamp: number;
    } | null;
    partialGateWarningsIssuedForTask: string[];
    selfFixAttempted: boolean;
    selfCodingWarnedAtCount: number;
    catastrophicPhaseWarnings: number[];
    lastPhaseCompleteTimestamp: number;
    lastPhaseCompletePhase: number;
    phaseAgentsDispatched: string[];
    lastCompletedPhaseAgentsDispatched: string[];
    qaSkipCount: number;
    qaSkipTaskIds: string[];
    pendingAdvisoryMessages: string[];
    taskWorkflowStates?: Record<string, string>;
    /** Flag for one-shot scope violation warning injection (omitted when undefined for additive-only schema) */
    scopeViolationDetected?: boolean;
    /** Current index into the fallback_models array (v6.33) */
    model_fallback_index: number;
    /** Flag set when all fallback models have been exhausted (v6.33) */
    modelFallbackExhausted: boolean;
    /** Number of coder revisions in the current task (v6.33) */
    coderRevisions: number;
    /** Flag set when coder revisions hit the configured ceiling (v6.33) */
    revisionLimitHit: boolean;
    /** Session-scoped Full Auto flag for autonomous multi-agent oversight (Phase 2) */
    fullAutoMode?: boolean;
    /** Count of full-auto interactions this phase (Phase 2) */
    fullAutoInteractionCount?: number;
    /** Count of detected deadlocks in full-auto mode (Phase 2) */
    fullAutoDeadlockCount?: number;
    /** Hash of last question asked in full-auto mode (Phase 2) */
    fullAutoLastQuestionHash?: string | null;
    /** Timestamp when session was rehydrated from snapshot (0 if never rehydrated) */
    sessionRehydratedAt?: number;
    /** Stage B completion tracking: per-task set of completed Stage B agents. Optional for backward compat with old snapshots. */
    stageBCompletion?: Record<string, string[]>;
}
/**
 * Minimal interface for serialized InvocationWindow
 */
export interface SerializedInvocationWindow {
    id: number;
    agentName: string;
    startedAtMs: number;
    toolCalls: number;
    consecutiveErrors: number;
    hardLimitHit: boolean;
    lastSuccessTimeMs: number;
    recentToolCalls: Array<{
        tool: string;
        argsHash: number;
        timestamp: number;
    }>;
    warningIssued: boolean;
    warningReason: string;
    transientRetryCount: number;
}
/**
 * Snapshot data structure written to disk
 */
export interface SnapshotData {
    version: 1 | 2;
    writtenAt: number;
    toolAggregates: Record<string, ToolAggregate>;
    activeAgent: Record<string, string>;
    delegationChains: Record<string, DelegationEntry[]>;
    agentSessions: Record<string, SerializedAgentSession>;
}
/**
 * Convert a live AgentSessionState to its serialized form.
 * Handles missing/undefined Map/Set fields gracefully (migration safety).
 */
export declare function serializeAgentSession(s: AgentSessionState): SerializedAgentSession;
/**
 * Write a snapshot of swarmState to .swarm/session/state.json atomically.
 * Silently swallows errors (non-fatal — never crash the plugin).
 */
export declare function writeSnapshot(directory: string, state: typeof swarmState): Promise<void>;
/**
 * Create a snapshot writer hook suitable for use in tool.execute.after.
 * Writes state immediately on every call.  Concurrent calls are serialised so
 * the last writer wins without producing a corrupt interleaved file.
 */
export declare function createSnapshotWriterHook(directory: string): (input: unknown, output: unknown) => Promise<void>;
/**
 * v6.35.4: Flush any in-flight snapshot write.
 * Called by phase-complete and handoff to ensure critical state transitions
 * are persisted before returning.
 */
export declare function flushPendingSnapshot(directory: string): Promise<void>;
/**
 * DI seam for testability. Contains all test-mocked exports.
 * Internal calls should use _internals.fn() instead of fn() directly.
 */
export declare const _internals: {
    writeSnapshot: typeof writeSnapshot;
    createSnapshotWriterHook: typeof createSnapshotWriterHook;
    flushPendingSnapshot: typeof flushPendingSnapshot;
};
