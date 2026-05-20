/**
 * Lean Turbo Lane Runner.
 *
 * Orchestrates parallel lane execution for Lean Turbo:
 * - Reads plan.json for a given phase
 * - Plans lane distribution via planLeanTurboLanes()
 * - Acquires file locks for each lane (all-or-nothing per lane)
 * - Dispatches coder agents via OpencodeClient session API
 * - Tracks lane status in memory and updates durable state
 * - Releases locks on cleanup
 *
 * ## Fail-Closed Design
 *
 * - If opencodeClient is null at construction, runPhase() returns error immediately
 * - If lock acquisition fails for a lane, the lane is marked 'blocked'
 * - If dispatch fails, locks for that lane are released and lane is marked 'failed'
 */
import type { OpencodeClient } from '@opencode-ai/sdk';
import type { LeanTurboConfig } from '../../config/schema';
import { loadFullAutoRunState } from '../../full-auto/state';
import { acquireLaneLocks, releaseLaneLocks } from '../../parallel/file-locks';
import { loadPlanJsonOnly } from '../../plan/manager';
import { hasActiveFullAuto } from '../../state';
import { writeLaneEvidence } from './evidence';
import { planLeanTurboLanes } from './planner';
import type { LeanTurboLane } from './state';
import { loadLeanTurboRunState, saveLeanTurboRunState } from './state';
/**
 * Shape of the OpencodeClient session API used by the runner.
 * Extracted into an interface so tests can inject a mock without
 * requiring the full SDK type.
 */
interface SessionClient {
    create(options: {
        query: {
            directory: string;
        };
    }): Promise<{
        data: {
            id: string;
        } | null;
        error: unknown;
    }>;
    prompt(options: {
        path: {
            id: string;
        };
        body: {
            agent: string;
            tools: {
                write: boolean;
                edit: boolean;
                patch: boolean;
            };
            parts: Array<{
                type: 'text';
                text: string;
            }>;
        };
    }): Promise<{
        data: {
            parts: Array<{
                type: string;
                text?: string;
            }>;
        } | null;
        error: unknown;
    }>;
    delete(options: {
        path: {
            id: string;
        };
    }): Promise<void>;
}
/**
 * Result of a single lane dispatch (session creation + prompt).
 */
export interface LaneDispatchResult {
    /** Whether dispatch succeeded */
    ok: boolean;
    /** Session ID if ok === true */
    sessionId?: string;
    /** Error message if ok === false */
    error?: string;
}
/**
 * Result of a single lane's processing.
 */
export interface LaneResult {
    /** Lane identifier */
    laneId: string;
    /** Current status */
    status: 'pending' | 'running' | 'completed' | 'failed' | 'blocked';
    /** Task IDs assigned to this lane */
    taskIds: string[];
    /** Agent name that was dispatched */
    agent?: string;
    /** Session ID for this lane (set after successful dispatch) */
    sessionId?: string;
    /** Error message if status is 'failed' or 'blocked' */
    error?: string;
}
/**
 * Result of a full phase run.
 */
export interface LeanTurboPhaseResult {
    /** Whether the phase ran (at least one lane attempted) */
    ok: boolean;
    /** Human-readable reason when ok === false */
    reason?: string;
    /** Per-lane results */
    lanes: LaneResult[];
    /** Task IDs that were degraded (risk conditions) */
    degradedTasks: string[];
    /** Task IDs excluded from parallel lanes, must complete via standard serial flow */
    serializedTasks: string[];
}
/**
 * Orchestrates Lean Turbo lane execution.
 *
 * ## Usage
 *
 * ```ts
 * const runner = new LeanTurboRunner({
 *   directory: projectRoot,
 *   sessionID: 'sess-abc123',
 *   opencodeClient: swarmState.opencodeClient,
 *   generatedAgentNames: swarmState.generatedAgentNames,
 * });
 *
 * const result = await runner.runPhase(1);
 * // ... monitor lanes ...
 * await runner.cleanup();
 * ```
 */
export declare class LeanTurboRunner {
    /**
     * Test-only dependency-injection seam.
     * Allows tests to intercept plan/lock/state operations without mock.module leakage.
     * Production code assigns real functions here at module load.
     */
    static _internals: {
        loadPlanJsonOnly: typeof loadPlanJsonOnly;
        planLeanTurboLanes: typeof planLeanTurboLanes;
        acquireLaneLocks: typeof acquireLaneLocks;
        releaseLaneLocks: typeof releaseLaneLocks;
        loadLeanTurboRunState: typeof loadLeanTurboRunState;
        saveLeanTurboRunState: typeof saveLeanTurboRunState;
        hasActiveFullAuto: typeof hasActiveFullAuto;
        loadFullAutoRunState: typeof loadFullAutoRunState;
        writeLaneEvidence: typeof writeLaneEvidence;
        /** Timeout for lane dispatch (session.create + session.prompt) in ms. Undefined = no timeout. */
        laneDispatchTimeoutMs: number | undefined;
    };
    /**
     * Test-only dependency-injection seam for session operations.
     * Allows tests to intercept client.session calls without mock.module leakage.
     *
     * Default: uses real OpencodeClient session API from the injected client.
     * Tests: replace by assigning a mock SessionClient directly to this field
     * on the runner instance.
     *
     * Example:
     * ```ts
     * const runner = new LeanTurboRunner({ directory, sessionID });
     * (runner as unknown as { _sessionOps: SessionClient })._sessionOps = mockSessionOps;
     * ```
     *
     * NB: The fail-closed check uses `opencodeClient === null` (strict equality)
     * so omitting `opencodeClient` (undefined) does NOT trigger fail-closed,
     * allowing test mock injection to proceed.
     */
    _sessionOps: SessionClient | null;
    private readonly _directory;
    private readonly _sessionID;
    private readonly _client;
    private readonly _availableAgents;
    /** Tracks which files are locked per lane (for cleanup) */
    private _laneLockMap;
    /** Current lane statuses (updated after each dispatch) */
    private _laneStatuses;
    /** Round-robin index for agent selection */
    private _agentIndex;
    /**
     * Tracks lanes that timed out so that when their _doDispatch completes,
     * we can clean up the orphan session.
     */
    private _timedOutLanes;
    /** Chains durable state updates to prevent race conditions on concurrent lanes. */
    private _stateLock;
    /** Lean-mode configuration passed at construction. Undefined means use defaults. */
    private readonly _leanConfig?;
    constructor(options: {
        /** Project root directory */
        directory: string;
        /** Current session ID */
        sessionID: string;
        /** OpenCode SDK client. Pass null to stay fail-closed. Omit to allow test mock injection. */
        opencodeClient?: OpencodeClient | null;
        /** Pre-registered generated agent names */
        generatedAgentNames?: string[];
        /** Lean-mode configuration. Falls back to hardcoded defaults if omitted. */
        leanConfig?: LeanTurboConfig;
    });
    /**
     * Run a single phase: plan lanes, acquire locks, dispatch coders.
     *
     * @param phaseNumber - Phase number to execute
     * @returns Result with per-lane statuses and degraded task list
     */
    runPhase(phaseNumber: number): Promise<LeanTurboPhaseResult>;
    /**
     * Dispatch a single lane to a named agent.
     *
     * Creates an ephemeral session, sends a task prompt, and returns
     * the session ID for later status polling.
     *
     * @param lane - Lane to dispatch
     * @param agentName - Agent name to dispatch to
     */
    dispatchLane(lane: LeanTurboLane, agentName: string): Promise<LaneDispatchResult>;
    /**
     * Internal dispatch implementation (separated for timeout wrapping).
     */
    private _doDispatch;
    /**
     * Get current status of all lanes tracked by this runner.
     *
     * Note: This returns in-memory status only. Lane sessions are
     * managed by the OpenCode runtime and cannot be directly polled
     * through the SDK. External status tracking (e.g., via session
     * list) should be used for production status polling.
     */
    waitForLanes(): Promise<LaneStatus[]>;
    /**
     * Release all lane locks and mark unresolved lanes as blocked.
     *
     * Call this on error exit or when shutting down a phase early.
     * Releases ALL locks and transitions ALL running/pending lanes to blocked.
     */
    cleanup(): Promise<void>;
    /**
     * Cleanup after a successful phase run.
     *
     * Only releases locks for lanes that reached a terminal state (completed,
     * failed, blocked). Does NOT change lane statuses — running lanes stay running.
     */
    cleanupAfterSuccess(): Promise<void>;
    /**
     * Cleanup after a failed phase run.
     *
     * Current behavior: releases ALL locks, marks all unresolved lanes blocked.
     */
    cleanupAfterFailure(): Promise<void>;
    /**
     * Resolve the list of available coder agent names.
     *
     * Prefers agents matching swarm prefix patterns (e.g. `mega_coder`)
     * over bare `coder`. Falls back to `['coder']` if no coder agents found.
     */
    private _resolveCoderAgents;
    /**
     * Get the Lean Turbo configuration.
     *
     * The config is passed to runPhase (from plugin config or caller).
     * If not provided, sensible defaults are used.
     */
    private _getLeanConfig;
    /**
     * Process a single lane: acquire locks, dispatch, track status.
     *
     * On successful dispatch completion (session.prompt resolves), the lane
     * is transitioned to 'completed', locks are released, evidence is written,
     * and the lane counter is incremented.
     *
     * On lock acquisition failure (Bug #4), the lane's tasks are routed to
     * the serialized tasks set for standard serial fallback.
     */
    private _processLane;
    /**
     * Select the next available agent using round-robin.
     */
    private _selectNextAgent;
    /**
     * Safely write lane evidence, catching errors to prevent evidence write
     * failure from blocking lane processing.
     */
    private _writeLaneEvidenceSafely;
    /**
     * Build a human-readable prompt describing a lane's tasks.
     */
    private _buildLanePrompt;
    /**
     * Serializes access to durable state via a promise chain.
     * Prevents concurrent lane updates from racing on turbo-state.json writes.
     *
     * Includes a 10-second timeout: if state persistence hangs, the lock is
     * released so subsequent updates are not blocked indefinitely.
     */
    private _withStateLock;
    /**
     * Update durable state with the full lane plan (called once per phase).
     */
    private _updateDurableState;
    /**
     * Update a single lane's status in durable state.
     * Serialized through _withStateLock to prevent race conditions with concurrent lanes.
     */
    private _updateDurableStateLaneStatus;
}
/**
 * Current status of a lane (returned by waitForLanes).
 */
export interface LaneStatus {
    laneId: string;
    status: LeanTurboLane['status'];
    taskIds: string[];
    agent?: string;
    sessionId?: string;
    error?: string;
}
export {};
