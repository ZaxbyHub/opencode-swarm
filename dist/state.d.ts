/**
 * Shared state module for OpenCode Swarm plugin.
 * Provides a module-scoped singleton for cross-hook state sharing.
 *
 * This module is used by multiple hooks (tool.execute.before, tool.execute.after,
 * chat.message, system-enhancer) to share state like active agents, tool call tracking,
 * and delegation chains.
 */
import type { OpencodeClient } from '@opencode-ai/sdk';
import { type QaGates } from './db/qa-gate-profile.js';
import { type EnvironmentProfile } from './environment/profile.js';
import type { EscalationTracker } from './prm/escalation.js';
import type { PatternMatch } from './prm/types.js';
import { AgentRunContext } from './state/agent-run-context.js';
export { AgentRunContext } from './state/agent-run-context.js';
/**
 * Represents a single tool call entry for tracking purposes
 */
export interface ToolCallEntry {
    tool: string;
    sessionID: string;
    callID: string;
    startTime: number;
}
/**
 * Aggregated statistics for a specific tool
 */
export interface ToolAggregate {
    tool: string;
    count: number;
    successCount: number;
    failureCount: number;
    totalDuration: number;
}
/**
 * Represents a delegation from one agent to another
 */
export interface DelegationEntry {
    from: string;
    to: string;
    timestamp: number;
}
/**
 * Reason a non-architect agent was activated during delegation tracking.
 * Used by delegation-tracker.ts to record why a delegation occurred.
 */
export type DelegationReason = 'normal_delegation' | 'review_rejected' | 'critic_consultation' | 'retry_circuit_breaker' | 'conflict_escalation' | 'stale_recovery';
/**
 * Per-task workflow state for gate progression tracking.
 * Transitions must be forward-only: idle → coder_delegated → pre_check_passed → reviewer_run → tests_run → complete
 */
export type TaskWorkflowState = 'idle' | 'coder_delegated' | 'pre_check_passed' | 'reviewer_run' | 'tests_run' | 'complete';
/**
 * Represents per-session state for guardrail tracking.
 * Budget fields (toolCallCount, consecutiveErrors, etc.) have moved to InvocationWindow.
 * This interface now tracks session-level metadata and window management.
 */
export interface AgentSessionState {
    /** Current agent identity for this session */
    agentName: string;
    /** Timestamp of most recent tool call (for session-level stale detection) */
    lastToolCallTime: number;
    /** Timestamp of most recent agent identity event (chat.message) */
    lastAgentEventTime: number;
    /** Whether active delegation is in progress for this session */
    delegationActive: boolean;
    /** Reason the most recent non-architect agent was activated */
    lastDelegationReason?: DelegationReason;
    /** Current active invocation ID for this agent */
    activeInvocationId: number;
    /** Last invocation ID by agent name (e.g., { "coder": 3, "reviewer": 1 }) */
    lastInvocationIdByAgent: Record<string, number>;
    /** Active invocation windows keyed by "${agentName}:${invId}" */
    windows: Record<string, InvocationWindow>;
    /** Last tool-call threshold at which a compaction hint was issued */
    lastCompactionHint: number;
    /** Count of architect direct writes to non-.swarm/ files */
    architectWriteCount: number;
    /** Last task ID that was delegated to coder (for zero-delegation detection) */
    lastCoderDelegationTaskId: string | null;
    /** Current task ID being worked on (set when coder delegation fires, used for per-task gate tracking) */
    currentTaskId: string | null;
    /** Gate names observed for current task (taskId → Set of gates) */
    gateLog: Map<string, Set<string>>;
    /** Reviewer delegations per phase (phaseNumber → count) */
    reviewerCallCount: Map<number, number>;
    /** Last gate failure for self-fix detection */
    lastGateFailure: {
        tool: string;
        taskId: string;
        timestamp: number;
    } | null;
    /** Task IDs for which partial gate warning has already been issued (prevents per-task spam) */
    partialGateWarningsIssuedForTask: Set<string>;
    /** Whether architect attempted self-fix write after gate failure */
    selfFixAttempted: boolean;
    /** Value of architectWriteCount at the time the self-coding warning was last injected.
     *  Warning is suppressed unless architectWriteCount has increased since last injection. */
    selfCodingWarnedAtCount: number;
    /** Phases that have already received a catastrophic zero-reviewer warning */
    catastrophicPhaseWarnings: Set<number>;
    /** Number of consecutive coder delegations without reviewer/test_engineer between them */
    qaSkipCount: number;
    /** Task IDs skipped without QA (for audit trail), reset when reviewer/test_engineer fires */
    qaSkipTaskIds: string[];
    /** Per-task workflow state — taskId → current state */
    taskWorkflowStates: Map<string, TaskWorkflowState>;
    /**
     * PR 2 Stage B barrier: per-task set of completed Stage B agents.
     * Order-independent — either 'reviewer' or 'test_engineer' may complete first.
     * When both are present, the task may advance to tests_run regardless of order.
     * Always populated — Stage B is unconditionally parallel.
     */
    stageBCompletion?: Map<string, Set<'reviewer' | 'test_engineer'>>;
    /** v6.71+ Council mode: per-task council verdict, recorded by delegation-gate when submit_council_verdicts resolves. */
    taskCouncilApproved?: Map<string, {
        verdict: 'APPROVE' | 'REJECT' | 'CONCERNS';
        roundNumber: number;
        /**
         * Distinct council members that voted on this verdict.
         * Validated by the council fast-path against `council.minimumMembers`
         * (default 3). Old evidence files without this field rehydrate as
         * quorumSize: 1 — conservative; forces a fresh council run.
         */
        quorumSize: number;
    }>;
    /** Last gate outcome for deliberation preamble injection */
    lastGateOutcome: {
        gate: string;
        taskId: string;
        passed: boolean;
        timestamp: number;
    } | null;
    /** Declared file scope for current coder task (null = no scope declared) */
    declaredCoderScope: string[] | null;
    /** Last scope violation message (null = no violation) */
    lastScopeViolation: string | null;
    /** Flag for one-shot scope violation warning injection in messagesTransform */
    scopeViolationDetected?: boolean;
    /** Files modified by the current coder task (populated by guardrails toolBefore/toolAfter, reset on new coder delegation) */
    modifiedFilesThisCoderTask: string[];
    /** Number of coder revisions in the current task (incremented on each coder delegation completion) */
    coderRevisions: number;
    /** Flag set when coder revisions hit the configured ceiling */
    revisionLimitHit: boolean;
    /** Timestamp of most recent phase completion */
    lastPhaseCompleteTimestamp: number;
    /** Phase number of most recent phase completion */
    lastPhaseCompletePhase: number;
    /** Set of agents dispatched in current phase (normalized names) */
    phaseAgentsDispatched: Set<string>;
    /** Set of agents dispatched in the most recently completed phase (persisted across phase reset) */
    lastCompletedPhaseAgentsDispatched: Set<string>;
    /** Current index into the fallback_models array (0 = primary model, incremented on transient failure) */
    model_fallback_index: number;
    /** Flag set when all fallback models have been exhausted */
    modelFallbackExhausted: boolean;
    /** Session-scoped Turbo Mode flag for controlling LLM inference speed */
    turboMode: boolean;
    /** Session-scoped turbo strategy selection — standard or lean. When undefined,
     *  falls back to standard (current behavior). */
    turboStrategy?: 'standard' | 'lean';
    /** Whether Lean Turbo is actively running in this session. Requires
     *  turboStrategy === 'lean'. */
    leanTurboActive?: boolean;
    /** Current phase number when Lean Turbo is active (for durable state sync). */
    leanTurboCurrentPhase?: number;
    /** Session-level QA gate overrides layered on top of the spec-level profile.
     *  Overrides can only enable gates (true); false values are ignored by
     *  getEffectiveGates. Cleared on session reset. Optional for backwards
     *  compatibility with pre-existing session state fixtures; consumers
     *  should read via `session.qaGateSessionOverrides ?? {}`. */
    qaGateSessionOverrides?: Partial<QaGates>;
    /** Session-scoped Full Auto flag for autonomous multi-agent oversight */
    fullAutoMode: boolean;
    /** Count of full-auto interactions this phase (for max_interactions_per_phase limit) */
    fullAutoInteractionCount: number;
    /** Count of detected deadlocks (repeated identical questions) in full-auto mode */
    fullAutoDeadlockCount: number;
    /** Hash of last question asked (for deadlock detection via hash comparison) */
    fullAutoLastQuestionHash: string | null;
    /** Sliding window of last 10 Task delegation hashes for loop detection */
    loopDetectionWindow?: Array<{
        hash: string;
        timestamp: number;
    }>;
    /** Pending loop warning message to inject into next messagesTransform (cleared after injection) */
    loopWarningPending?: {
        agent: string;
        message: string;
        timestamp: number;
    };
    /** Flag to track if the 50% context pressure warning has been sent this session */
    contextPressureWarningSent?: boolean;
    /** Queue of advisory messages (e.g., SLOP, context pressure) pending injection into next messagesTransform */
    pendingAdvisoryMessages?: string[];
    /** Fingerprint of the most recent provider-failure transcript that received recovery guidance */
    lastProviderRecoveryFingerprint?: string;
    /** Timestamp when session was rehydrated from snapshot (0 if never rehydrated) */
    sessionRehydratedAt: number;
    /** Pattern type to detection count mapping */
    prmPatternCounts: Map<string, number>;
    /** Current escalation level (0=none, 1=guidance, 2=strong guidance, 3=hard stop) */
    prmEscalationLevel: number;
    /** Last pattern detected (if any) */
    prmLastPatternDetected: PatternMatch | null;
    /** Current trajectory step counter */
    prmTrajectoryStep: number;
    /** Whether a hard stop has been triggered */
    prmHardStopPending: boolean;
    /** Per-session escalation tracker instance (set lazily by PRM hook) */
    prmEscalationTracker?: EscalationTracker;
}
/**
 * Represents a single agent invocation window with isolated guardrail budgets.
 * Each time the architect delegates to an agent, a new window is created.
 * Architect never creates windows (unlimited).
 */
export interface InvocationWindow {
    /** Unique ID for this invocation (increments per agent type) */
    id: number;
    /** Agent name (stripped of swarm prefix) */
    agentName: string;
    /** Timestamp when this invocation started */
    startedAtMs: number;
    /** Tool calls made in this invocation */
    toolCalls: number;
    /** Consecutive errors in this invocation */
    consecutiveErrors: number;
    /** Whether hard limit was hit for this invocation */
    hardLimitHit: boolean;
    /** Timestamp of most recent successful tool call */
    lastSuccessTimeMs: number;
    /** Circular buffer of recent tool calls (max 20) for repetition detection */
    recentToolCalls: Array<{
        tool: string;
        argsHash: number;
        timestamp: number;
    }>;
    /** Whether soft warning has been issued for this invocation */
    warningIssued: boolean;
    /** Human-readable warning reason */
    warningReason: string;
    /** Transient model error retry count for this invocation (resets per window) */
    transientRetryCount: number;
}
/**
 * Default run context — the single active run for current single-threaded behavior.
 * PR 2 will create additional contexts for parallel dispatcher slots.
 */
export declare const defaultRunContext: AgentRunContext<ToolCallEntry, ToolAggregate, DelegationEntry, AgentSessionState, EnvironmentProfile>;
/**
 * Return the AgentRunContext for the given runId.
 * No argument or unknown runId returns defaultRunContext (single-run semantics preserved).
 */
export declare function getRunContext(runId?: string): typeof defaultRunContext;
/**
 * Singleton state object for sharing data across hooks.
 * Per-run maps are backed by defaultRunContext so that swarmState references
 * stay valid and single-run behavior is unchanged.
 */
export declare const swarmState: {
    /** Active tool calls — keyed by callID for before→after correlation */
    activeToolCalls: Map<string, ToolCallEntry>;
    /** Aggregated tool usage stats — process-global accumulator */
    toolAggregates: Map<string, ToolAggregate>;
    /** Active agent per session — keyed by sessionID, updated by chat.message hook */
    activeAgent: Map<string, string>;
    /** Delegation chains per session — keyed by sessionID */
    delegationChains: Map<string, DelegationEntry[]>;
    /** Number of events since last flush */
    pendingEvents: number;
    /** SDK client — set at plugin init for curator LLM delegation */
    opencodeClient: OpencodeClient | null;
    /** All registered curator agent names across all swarms (with their swarm prefix).
     * e.g. ['curator_init'] for a single default swarm, or
     * ['swarm1_curator_init', 'swarm2_curator_init', ...] for multiple named swarms.
     * Set at plugin init after agents are built. The factory resolves the correct
     * name at call time by matching the active session's agent prefix. */
    curatorInitAgentNames: string[];
    curatorPhaseAgentNames: string[];
    /** All registered skill_improver / spec_writer agent names across swarms,
     * mirroring curatorInitAgentNames so the LLM delegate factory can resolve
     * the correct prefixed agent under multi-swarm configs. */
    skillImproverAgentNames: string[];
    specWriterAgentNames: string[];
    /** v2: in-memory cache of "currently-active critical directive ids" per
     *  session+task, populated by the knowledge-injector when it injects a
     *  critical+matching directive. Read by the toolBefore enforcement gate
     *  so we don't re-scan the entire knowledge file on every high-risk tool
     *  call. Cleared by phase change, curator commits, knowledge mutations,
     *  and resetSwarmState. FIFO-capped — see setCriticalShownIds. */
    currentCriticalShownIds: Map<string, {
        ids: string[];
        taskId?: string;
        phase?: string;
        generatedAt: number;
    }>;
    /** v2: dedup set for ack records. Key = `${sessionId}|${id}|${result}|${dayKey}`.
     *  Prevents the chat.messages.transform path AND a knowledge_ack tool call
     *  from double-counting the same ack within a session-day. FIFO-capped —
     *  see addKnowledgeAckDedup. */
    knowledgeAckDedup: Set<string>;
    /**
     * All generated agent names registered with OpenCode at plugin init.
     * Used by Full-Auto v2 delegation guard to apply strict registry-aware
     * canonical-role extraction (so user-supplied prose like
     * `not_an_architect` cannot collapse to `architect` via suffix-only
     * matching). Populated by `src/index.ts` after `createAgents`.
     */
    generatedAgentNames: string[];
    /** Last known context budget percentage (0-100), updated by system-enhancer */
    lastBudgetPct: number;
    /** Per-session guardrail state — keyed by sessionID */
    agentSessions: Map<string, AgentSessionState>;
    /** In-flight rehydration promises — awaited by rehydrateState before clearing agentSessions */
    pendingRehydrations: Set<Promise<void>>;
    /** Whether full-auto mode is enabled in config */
    fullAutoEnabledInConfig: boolean;
    /** Per-session environment profiles — keyed by sessionID */
    environmentProfiles: Map<string, EnvironmentProfile>;
};
/**
 * Reset all state to initial values - useful for testing
 */
export declare function resetSwarmState(): void;
/**
 * Start a new agent session with initialized guardrail state.
 * Also removes any stale sessions older than staleDurationMs.
 * @param sessionId - The session identifier
 * @param agentName - The agent associated with this session
 * @param staleDurationMs - Age threshold for stale session eviction (default: 120 min)
 * @param directory - Optional project directory for rehydrating workflow state from disk
 */
export declare function startAgentSession(sessionId: string, agentName: string, staleDurationMs?: number, directory?: string): void;
/**
 * End an agent session by removing it from the state.
 * NOTE: Currently unused in production — no session lifecycle teardown is wired up.
 * Sessions accumulate for the process lifetime. Callers should integrate this into
 * a session TTL or idle-timeout mechanism to prevent unbounded Map growth.
 * @param sessionId - The session identifier to remove
 */
export declare function endAgentSession(sessionId: string): void;
/**
 * Get an agent session state by session ID.
 * @param sessionId - The session identifier
 * @returns The AgentSessionState or undefined if not found
 */
export declare function getAgentSession(sessionId: string): AgentSessionState | undefined;
/**
 * Ensure a guardrail session exists for the given sessionID.
 * If one exists and agentName is provided and different, update it.
 * If none exists, create one.
 * Always updates lastToolCallTime.
 * @param sessionId - The session identifier
 * @param agentName - Optional agent name (if known)
 * @returns The AgentSessionState
 */
export declare function ensureAgentSession(sessionId: string, agentName?: string, directory?: string): AgentSessionState;
/**
 * Update only the agent event timestamp (for stale detection).
 * Does NOT change agent name or reset guardrail state.
 * @param sessionId - The session identifier
 */
export declare function updateAgentEventTime(sessionId: string): void;
/**
 * Begin a new invocation window for the given agent.
 * Increments invocation ID, creates fresh budget counters.
 * Returns null for architect (unlimited, no window).
 *
 * @param sessionId - Session identifier
 * @param agentName - Agent name (with or without swarm prefix)
 * @returns New window or null if architect
 */
export declare function beginInvocation(sessionId: string, agentName: string): InvocationWindow | null;
/**
 * Get the currently active invocation window for the session.
 * Returns undefined if no window exists (e.g., architect session).
 *
 * @param sessionId - Session identifier
 * @returns Active window or undefined
 */
export declare function getActiveWindow(sessionId: string): InvocationWindow | undefined;
/**
 * Prune old invocation windows to prevent unbounded memory growth.
 * Removes windows older than maxAgeMs and keeps only the most recent maxWindows.
 *
 * @param sessionId - Session identifier
 * @param maxAgeMs - Maximum age in milliseconds (default 24 hours)
 * @param maxWindows - Maximum number of windows to keep (default 50)
 */
export declare function pruneOldWindows(sessionId: string, maxAgeMs?: number, maxWindows?: number): void;
/**
 * Record an agent dispatch for phase completion tracking.
 * Normalizes the agent name via stripKnownSwarmPrefix before adding to phaseAgentsDispatched.
 * @param sessionId - Session identifier
 * @param agentName - Agent name to record (will be normalized)
 */
export declare function recordPhaseAgentDispatch(sessionId: string, agentName: string): void;
/**
 * Advance a task's workflow state. Validates forward-only transitions.
 * Throws 'INVALID_TASK_STATE_TRANSITION: [taskId] [current] → [requested]' on illegal transition.
 * Safely returns without mutating state when taskId is null, undefined, empty, or whitespace-only.
 *
 * Valid forward order: idle → coder_delegated → pre_check_passed → reviewer_run → tests_run → complete
 *
 * @param session - The agent session state
 * @param taskId - The task identifier
 * @param newState - The requested new state
 */
export declare function advanceTaskState(session: AgentSessionState, taskId: string, newState: TaskWorkflowState, options?: {
    telemetrySessionId?: string;
    emitTelemetry?: boolean;
}, councilConfig?: {
    minimumMembers?: number;
    requireAllMembers?: boolean;
}): void;
/**
 * Advance the per-task workflow state machine AND persist the corresponding
 * plan.json status at meaningful workflow boundaries.
 *
 * The two-layer model splits in-memory workflow state (Layer 1, fast, used by
 * gates) from the durable plan (Layer 2, projected to plan.md). Without this
 * bridge, council APPROVE → 'complete' updates Layer 1 only and plan.md goes
 * stale. This helper closes the gap by mapping:
 *   - 'coder_delegated' → plan.json status 'in_progress'
 *   - 'complete'        → plan.json status 'completed'
 * Other transitions are in-memory only (the task is already in_progress on disk
 * once coder_delegated has fired).
 *
 * Persistence errors are logged and swallowed so a transient disk failure does
 * not break the in-memory state machine — matches the existing defensive
 * pattern around advanceTaskState call sites.
 */
export declare function advanceTaskStateAndPersist(session: AgentSessionState, taskId: string, newState: TaskWorkflowState, directory: string, options?: {
    telemetrySessionId?: string;
    emitTelemetry?: boolean;
}, councilConfig?: {
    minimumMembers?: number;
    requireAllMembers?: boolean;
}): Promise<void>;
/**
 * Get the current workflow state for a task.
 * Returns 'idle' if no entry exists.
 * Returns 'idle' for invalid taskId (null, undefined, empty, or whitespace-only).
 * If taskWorkflowStates is missing/invalid, initializes it as a new Map.
 *
 * @param session - The agent session state
 * @param taskId - The task identifier
 * @returns Current task workflow state
 */
export declare function getTaskState(session: AgentSessionState, taskId: string): TaskWorkflowState;
/**
 * PR 2 Stage B barrier: record that a Stage B agent has completed for a task.
 * Order-independent — either 'reviewer' or 'test_engineer' may complete first.
 * Initializes the per-task set on first write.
 *
 * @param session - The agent session state
 * @param taskId - The task identifier
 * @param agent - Which Stage B agent completed ('reviewer' or 'test_engineer')
 */
export declare function recordStageBCompletion(session: AgentSessionState, taskId: string, agent: 'reviewer' | 'test_engineer'): void;
/**
 * PR 2 Stage B barrier: returns true iff both 'reviewer' and 'test_engineer' have
 * been recorded for the given task in this session.
 *
 * @param session - The agent session state
 * @param taskId - The task identifier
 * @returns true when both Stage B agents have completed
 */
export declare function hasBothStageBCompletions(session: AgentSessionState, taskId: string): boolean;
/**
 * Returns true iff council is authoritative for the current plan.
 *
 * AND semantics: council is authoritative when BOTH `pluginConfig.council.enabled === true`
 * AND `QaGates.council_mode === true` for the plan associated with this directory.
 *
 * If exactly one of the two flags is true, a one-time warning is logged per plan_id
 * (so operators can see the deadlock case) and the function falls back to `false`,
 * which keeps Stage B running as the default.
 *
 * Returns false when the plan or QA gate profile cannot be loaded — when the plan
 * is missing the council cannot meaningfully be "authoritative".
 */
export declare function isCouncilGateActive(directory: string, council: {
    enabled?: boolean;
} | undefined): Promise<boolean>;
/**
 * Test-only helper: clear the warn-once memo so each test can observe a fresh
 * disagreement warning. Not part of the public surface.
 */
export declare function _resetCouncilDisagreementWarnings(): void;
/**
 * Rehydrates session workflow state from durable swarm files.
 *
 * Reads `.swarm/plan.json` and `.swarm/evidence/*.json` from the provided
 * project directory, derives task workflow states from this data, and merges
 * them into the target AgentSessionState.
 *
 * Merge rules:
 * - Evidence-derived progression wins over plan-only state
 * - Existing in-memory workflow states for the same task IDs are NOT downgraded
 * - Missing/malformed `.swarm` data is non-fatal (silently skipped)
 *
 * This helper is useful for session restart scenarios where in-memory state
 * is lost but durable files persist.
 *
 * @param directory - Project root containing .swarm/ subdirectory
 * @param session - Target AgentSessionState to merge rehydrated state into
 */
/**
 * Reads plan.json + evidence/*.json from the project directory and populates the
 * module-level _rehydrationCache.  Called at plugin init by loadSnapshot() and
 * refreshed after compaction by the compaction hook (src/hooks/compaction-customizer.ts).
 * Non-fatal: missing/malformed files leave an empty cache.
 */
export declare function buildRehydrationCache(directory: string): Promise<void>;
/**
 * Synchronously applies the cached plan+evidence data to a session.
 * Merge rules:
 *   - evidence-derived state: only applied if it advances past existing state
 *   - plan-only derived state: only applied if it advances past existing state
 * No-op when the cache has not been built yet.
 */
export declare function applyRehydrationCache(session: AgentSessionState): void;
/**
 * Rehydrates session workflow state from durable swarm files.
 * Builds (or refreshes) the rehydration cache from disk, then applies it
 * to the target session.
 */
export declare function rehydrateSessionFromDisk(directory: string, session: AgentSessionState): Promise<void>;
/**
 * Check if Turbo Mode is enabled for a specific session or ANY session.
 * @param sessionID - Optional session ID to check. If provided, checks only that session.
 *                    If omitted, checks all sessions (backward-compatible global behavior).
 * @returns true if the specified session has turboMode: true, or if any session has turboMode: true when no sessionID provided
 */
export declare function hasActiveTurboMode(sessionID?: string): boolean;
/**
 * Check if Full Auto Mode is enabled for a specific session or ANY session.
 * @param sessionID - Optional session ID to check. If provided, checks only that session.
 *                    If omitted, checks all sessions (backward-compatible global behavior).
 * @returns true if the specified session has fullAutoMode: true (model validation is advisory-only).
 */
export declare function hasActiveFullAuto(sessionID?: string): boolean;
/**
 * Check if Lean Turbo Mode is active for a specific session or ANY session.
 * @param sessionID - Optional session ID to check. If provided, checks only that session.
 *                    If omitted, checks all sessions.
 * @returns true if the specified session has turboStrategy: 'lean' AND leanTurboActive: true,
 *          or if any session has that combination when no sessionID provided.
 */
export declare function hasActiveLeanTurbo(sessionID?: string): boolean;
export declare function setSessionEnvironment(sessionId: string, profile: EnvironmentProfile): void;
export declare function getSessionEnvironment(sessionId: string): EnvironmentProfile | undefined;
export declare function ensureSessionEnvironment(sessionId: string): EnvironmentProfile;
export declare const MAX_TRACKED_CRITICAL_SHOWN = 500;
export declare const MAX_TRACKED_KNOWLEDGE_ACKS = 5000;
/** Set the critical shown ids for a session, FIFO-evicting the oldest entry
 * if the cap is exceeded. Re-setting an existing key keeps insertion order
 * fresh for that key (delete-then-set). */
export declare function setCriticalShownIds(sessionID: string, value: {
    ids: string[];
    taskId?: string;
    phase?: string;
    generatedAt: number;
}): void;
/** Clear the critical shown ids for a session. Centralised so call sites do
 *  not bypass the FIFO-cap pathway with a direct `.delete()`. Returns
 *  whether an entry was removed. */
export declare function clearCriticalShownIds(sessionID: string): boolean;
/** Add a knowledge ack dedup key, FIFO-evicting the oldest if the cap is
 * exceeded. Sets preserve insertion order in JS. */
export declare function addKnowledgeAckDedup(key: string): void;
/**
 * Test-only dependency-injection seam. Production code calls
 * `_internals.*` for key exported functions and objects so tests can replace
 * them without using `mock.module` — `mock.module` from `bun:test` leaks
 * across files in Bun's shared test-runner process, which would corrupt
 * unrelated test suites. Mutating this local object is file-scoped and
 * trivially restorable via `afterEach`.
 */
export declare const _internals: {
    swarmState: typeof swarmState;
    resetSwarmState: typeof resetSwarmState;
    ensureAgentSession: typeof ensureAgentSession;
    startAgentSession: typeof startAgentSession;
    getAgentSession: typeof getAgentSession;
    beginInvocation: typeof beginInvocation;
    getActiveWindow: typeof getActiveWindow;
    advanceTaskState: typeof advanceTaskState;
    getTaskState: typeof getTaskState;
    hasActiveFullAuto: typeof hasActiveFullAuto;
    hasActiveTurboMode: typeof hasActiveTurboMode;
    hasActiveLeanTurbo: typeof hasActiveLeanTurbo;
    buildRehydrationCache: typeof buildRehydrationCache;
    applyRehydrationCache: typeof applyRehydrationCache;
    rehydrateSessionFromDisk: typeof rehydrateSessionFromDisk;
    isCouncilGateActive: typeof isCouncilGateActive;
    defaultRunContext: typeof defaultRunContext;
};
