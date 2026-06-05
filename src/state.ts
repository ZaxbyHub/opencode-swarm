/**
 * Shared state module for OpenCode Swarm plugin.
 * Provides a module-scoped singleton for cross-hook state sharing.
 *
 * This module is used by multiple hooks (tool.execute.before, tool.execute.after,
 * chat.message, system-enhancer) to share state like active agents, tool call tracking,
 * and delegation chains.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { OpencodeClient } from '@opencode-ai/sdk';
import { ORCHESTRATOR_NAME } from './config/constants';
import { type Plan, PlanSchema, type TaskStatus } from './config/plan-schema';
import { stripKnownSwarmPrefix } from './config/schema';
import type { CouncilAgent } from './council/types';
import { getProfile, type QaGates } from './db/qa-gate-profile.js';
import {
	detectEnvironmentProfile,
	type EnvironmentProfile,
} from './environment/profile.js';
import type { TaskEvidence } from './gate-evidence';
import { clearPendingCoderScope } from './hooks/delegation-gate.js';
import { loadPlanJsonOnly, updateTaskStatus } from './plan/manager.js';
import { derivePlanId } from './plan/utils.js';
import type { EscalationTracker } from './prm/escalation.js';
import type { PatternMatch } from './prm/types.js';
import { AgentRunContext } from './state/agent-run-context.js';
import { telemetry } from './telemetry.js';
import * as logger from './utils/logger';

export { AgentRunContext } from './state/agent-run-context.js';

/**
 * Cached plan + evidence data read once at plugin init by buildRehydrationCache().
 * Applied synchronously to every new session via applyRehydrationCache() so that
 * guardrails always see correct workflow state — even when no snapshot exists.
 */
interface RehydrationCache {
	planTaskStates: Map<string, TaskWorkflowState>;
	evidenceMap: Map<string, TaskEvidence>;
}
let _rehydrationCache: RehydrationCache | null = null;

/**
 * Tracks plan IDs that have already received the "council disagreement" warn.
 * One warning per plan_id, per process lifetime. Cleared by resetSwarmState.
 */
const _councilDisagreementWarned = new Set<string>();

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
export type DelegationReason =
	| 'normal_delegation'
	| 'review_rejected'
	| 'critic_consultation'
	| 'retry_circuit_breaker'
	| 'conflict_escalation'
	| 'stale_recovery';

/**
 * Per-task workflow state for gate progression tracking.
 * Transitions must be forward-only: idle → coder_delegated → pre_check_passed → reviewer_run → tests_run → complete
 */
export type TaskWorkflowState =
	| 'idle'
	| 'coder_delegated'
	| 'pre_check_passed'
	| 'reviewer_run'
	| 'tests_run'
	| 'complete';

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

	// Window tracking (per-invocation budgets)
	/** Current active invocation ID for this agent */
	activeInvocationId: number;
	/** Last invocation ID by agent name (e.g., { "coder": 3, "reviewer": 1 }) */
	lastInvocationIdByAgent: Record<string, number>;
	/** Active invocation windows keyed by "${agentName}:${invId}" */
	windows: Record<string, InvocationWindow>;

	/** Last tool-call threshold at which a compaction hint was issued */
	lastCompactionHint: number;

	// v6.12 Anti-Process-Violation Detection
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
	lastGateFailure: { tool: string; taskId: string; timestamp: number } | null;
	/** Task IDs for which partial gate warning has already been issued (prevents per-task spam) */
	partialGateWarningsIssuedForTask: Set<string>;
	/** Whether architect attempted self-fix write after gate failure */
	selfFixAttempted: boolean;
	/** Value of architectWriteCount at the time the self-coding warning was last injected.
	 *  Warning is suppressed unless architectWriteCount has increased since last injection. */
	selfCodingWarnedAtCount: number;
	/** Phases that have already received a catastrophic zero-reviewer warning */
	catastrophicPhaseWarnings: Set<number>;

	// QA Skip Hard-Block Enforcement (v6.17)
	/** Number of consecutive coder delegations without reviewer/test_engineer between them */
	qaSkipCount: number;
	/** Task IDs skipped without QA (for audit trail), reset when reviewer/test_engineer fires */
	qaSkipTaskIds: string[];

	// v6.21 Per-task state machine
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
	taskCouncilApproved?: Map<
		string,
		{
			verdict: 'APPROVE' | 'REJECT' | 'CONCERNS';
			roundNumber: number;
			/**
			 * Distinct council members that voted on this verdict.
			 * Validated by the council fast-path against `council.minimumMembers`
			 * (default 3). Old evidence files without this field rehydrate as
			 * quorumSize: 1 — conservative; forces a fresh council run.
			 */
			quorumSize: number;
		}
	>;
	/**
	 * Per-(task,round) required council members for the next submission attempt.
	 * Key format: `${taskId}:${roundNumber}`.
	 */
	pendingCouncilRequirements?: Map<string, Set<CouncilAgent>>;
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

	// Bounded Coder Revisions (v6.33)
	/** Number of coder revisions in the current task (incremented on each coder delegation completion) */
	coderRevisions: number;
	/** Flag set when coder revisions hit the configured ceiling */
	revisionLimitHit: boolean;

	// Phase completion tracking
	/** Timestamp of most recent phase completion */
	lastPhaseCompleteTimestamp: number;
	/** Phase number of most recent phase completion */
	lastPhaseCompletePhase: number;
	/** Set of agents dispatched in current phase (normalized names) */
	phaseAgentsDispatched: Set<string>;
	/** Set of agents dispatched in the most recently completed phase (persisted across phase reset) */
	lastCompletedPhaseAgentsDispatched: Set<string>;

	// Model Fallback (v6.33)
	/** Current index into the fallback_models array (0 = primary model, incremented on transient failure) */
	model_fallback_index: number;
	/** Flag set when all fallback models have been exhausted */
	modelFallbackExhausted: boolean;

	// Turbo Mode (v6.26)
	/** Session-scoped Turbo Mode flag for controlling LLM inference speed */
	turboMode: boolean;

	// Lean Turbo Mode (Phase 2)
	/** Session-scoped turbo strategy selection — standard or lean. When undefined,
	 *  falls back to standard (current behavior). */
	turboStrategy?: 'standard' | 'lean';
	/** Whether Lean Turbo is actively running in this session. Requires
	 *  turboStrategy === 'lean'. */
	leanTurboActive?: boolean;
	/** Current phase number when Lean Turbo is active (for durable state sync). */
	leanTurboCurrentPhase?: number;
	/** Session-scoped concurrency override for max_concurrent_tasks (Issue #761).
	 *  When set, overrides the plan's execution_profile.max_concurrent_tasks
	 *  for delegation-gate guidance. Cleared on session reset. */
	maxConcurrencyOverride?: number;

	// QA Gate Profile session overrides (ratchet-tighter only)
	/** Session-level QA gate overrides layered on top of the spec-level profile.
	 *  Overrides can only enable gates (true); false values are ignored by
	 *  getEffectiveGates. Cleared on session reset. Optional for backwards
	 *  compatibility with pre-existing session state fixtures; consumers
	 *  should read via `session.qaGateSessionOverrides ?? {}`. */
	qaGateSessionOverrides?: Partial<QaGates>;

	// Full Auto Mode (Phase 2)
	/** Session-scoped Full Auto flag for autonomous multi-agent oversight */
	fullAutoMode: boolean;
	/** Count of full-auto interactions this phase (for max_interactions_per_phase limit) */
	fullAutoInteractionCount: number;
	/** Count of detected deadlocks (repeated identical questions) in full-auto mode */
	fullAutoDeadlockCount: number;
	/** Hash of last question asked (for deadlock detection via hash comparison) */
	fullAutoLastQuestionHash: string | null;

	// Loop Detection (v6.29)
	/** Sliding window of last 10 Task delegation hashes for loop detection */
	loopDetectionWindow?: Array<{ hash: string; timestamp: number }>;
	/** Pending loop warning message to inject into next messagesTransform (cleared after injection) */
	loopWarningPending?: { agent: string; message: string; timestamp: number };
	/** Flag to track if the 50% context pressure warning has been sent this session */
	contextPressureWarningSent?: boolean;
	/** Queue of advisory messages (e.g., SLOP, context pressure) pending injection into next messagesTransform */
	pendingAdvisoryMessages?: string[];
	/** Fingerprint of the most recent provider-failure transcript that received recovery guidance */
	lastProviderRecoveryFingerprint?: string;

	// Stale state detection (Bug B)
	/** Timestamp when session was rehydrated from snapshot (0 if never rehydrated) */
	sessionRehydratedAt: number;

	// PRM (Process Remediation Manager) - Phase 1
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
	recentToolCalls: Array<{ tool: string; argsHash: number; timestamp: number }>;
	/** Whether soft warning has been issued for this invocation */
	warningIssued: boolean;
	/** Human-readable warning reason */
	warningReason: string;
	/** Transient model error retry count for this invocation (resets per window) */
	transientRetryCount: number;
}

// Process-global tool aggregates — intentionally shared across all run contexts.
// Isolated per-run maps live on AgentRunContext; this one is a cross-run accumulator.
const _toolAggregates = new Map<string, ToolAggregate>();

/**
 * Default run context — the single active run for current single-threaded behavior.
 * PR 2 will create additional contexts for parallel dispatcher slots.
 */
export const defaultRunContext = new AgentRunContext<
	ToolCallEntry,
	ToolAggregate,
	DelegationEntry,
	AgentSessionState,
	EnvironmentProfile
>('default', _toolAggregates);

// Registry for future multi-run dispatch (dark, not yet populated by production code).
const _runContexts = new Map<string, typeof defaultRunContext>();

/**
 * Return the AgentRunContext for the given runId.
 * No argument or unknown runId returns defaultRunContext (single-run semantics preserved).
 */
export function getRunContext(runId?: string): typeof defaultRunContext {
	if (!runId) return defaultRunContext;
	return _runContexts.get(runId) ?? defaultRunContext;
}

/**
 * Singleton state object for sharing data across hooks.
 * Per-run maps are backed by defaultRunContext so that swarmState references
 * stay valid and single-run behavior is unchanged.
 */
export const swarmState = {
	/** Active tool calls — keyed by callID for before→after correlation */
	activeToolCalls: defaultRunContext.activeToolCalls,

	/** Aggregated tool usage stats — process-global accumulator */
	toolAggregates: defaultRunContext.toolAggregates,

	/** Active agent per session — keyed by sessionID, updated by chat.message hook */
	activeAgent: defaultRunContext.activeAgent,

	/** Delegation chains per session — keyed by sessionID */
	delegationChains: defaultRunContext.delegationChains,

	/** Number of events since last flush */
	pendingEvents: 0,

	/** SDK client — set at plugin init for curator LLM delegation */
	opencodeClient: null as OpencodeClient | null,

	/** All registered curator agent names across all swarms (with their swarm prefix).
	 * e.g. ['curator_init'] for a single default swarm, or
	 * ['swarm1_curator_init', 'swarm2_curator_init', ...] for multiple named swarms.
	 * Set at plugin init after agents are built. The factory resolves the correct
	 * name at call time by matching the active session's agent prefix. */
	curatorInitAgentNames: [] as string[],
	curatorPhaseAgentNames: [] as string[],

	/** All registered skill_improver / spec_writer agent names across swarms,
	 * mirroring curatorInitAgentNames so the LLM delegate factory can resolve
	 * the correct prefixed agent under multi-swarm configs. */
	skillImproverAgentNames: [] as string[],
	specWriterAgentNames: [] as string[],

	/** v2: in-memory cache of "currently-active critical directive ids" per
	 *  session+task, populated by the knowledge-injector when it injects a
	 *  critical+matching directive. Read by the toolBefore enforcement gate
	 *  so we don't re-scan the entire knowledge file on every high-risk tool
	 *  call. Cleared by phase change, curator commits, knowledge mutations,
	 *  and resetSwarmState. FIFO-capped — see setCriticalShownIds. */
	currentCriticalShownIds: new Map<
		string,
		{ ids: string[]; taskId?: string; phase?: string; generatedAt: number }
	>(),

	/** v2: dedup set for ack records. Key = `${sessionId}|${id}|${result}|${dayKey}`.
	 *  Prevents the chat.messages.transform path AND a knowledge_ack tool call
	 *  from double-counting the same ack within a session-day. FIFO-capped —
	 *  see addKnowledgeAckDedup. */
	knowledgeAckDedup: new Set<string>(),

	/**
	 * All generated agent names registered with OpenCode at plugin init.
	 * Used by Full-Auto v2 delegation guard to apply strict registry-aware
	 * canonical-role extraction (so user-supplied prose like
	 * `not_an_architect` cannot collapse to `architect` via suffix-only
	 * matching). Populated by `src/index.ts` after `createAgents`.
	 */
	generatedAgentNames: [] as string[],

	/** Last known context budget percentage (0-100), updated by system-enhancer */
	lastBudgetPct: 0,

	/** Per-session guardrail state — keyed by sessionID */
	agentSessions: defaultRunContext.agentSessions,

	/** In-flight rehydration promises — awaited by rehydrateState before clearing agentSessions */
	pendingRehydrations: new Set<Promise<void>>(),

	// Full Auto Mode (Phase 4)
	/** Whether full-auto mode is enabled in config */
	fullAutoEnabledInConfig: false,

	/** Per-session environment profiles — keyed by sessionID */
	environmentProfiles: defaultRunContext.environmentProfiles,
};

/**
 * Reset all state to initial values - useful for testing
 */
export function resetSwarmState(): void {
	swarmState.activeToolCalls.clear();
	swarmState.toolAggregates.clear();
	swarmState.activeAgent.clear();
	swarmState.delegationChains.clear();
	swarmState.pendingEvents = 0;
	swarmState.lastBudgetPct = 0;
	swarmState.agentSessions.clear();
	swarmState.pendingRehydrations.clear();
	swarmState.opencodeClient = null;
	swarmState.curatorInitAgentNames = [];
	swarmState.curatorPhaseAgentNames = [];
	swarmState.skillImproverAgentNames = [];
	swarmState.specWriterAgentNames = [];
	swarmState.currentCriticalShownIds.clear();
	swarmState.knowledgeAckDedup.clear();
	swarmState.generatedAgentNames = [];
	_rehydrationCache = null;
	// Full Auto Mode (Phase 4)
	swarmState.fullAutoEnabledInConfig = false;
	swarmState.environmentProfiles.clear();
	// v6.70.0 gap-closure (#496): clear the module-scoped pending coder-scope
	// map so a /swarm close + new session with a colliding taskId (e.g. "1.1")
	// cannot inherit stale scope from the previous swarm.
	clearPendingCoderScope();
	// v6.71+ Clear the council-mode disagreement warn-once memo so tests and
	// fresh sessions observe consistent first-time warnings.
	_councilDisagreementWarned.clear();
	// Note: Session-scoped fields (architectWriteCount, gateLog, reviewerCallCount, lastGateFailure)
	// are cleared when agentSessions entries are deleted
}

/**
 * Start a new agent session with initialized guardrail state.
 * Also removes any stale sessions older than staleDurationMs.
 * @param sessionId - The session identifier
 * @param agentName - The agent associated with this session
 * @param staleDurationMs - Age threshold for stale session eviction (default: 120 min)
 * @param directory - Optional project directory for rehydrating workflow state from disk
 */
export function startAgentSession(
	sessionId: string,
	agentName: string,
	staleDurationMs = 7200000,
	directory?: string,
): void {
	const now = Date.now();

	// Evict stale sessions based on last activity, not start time
	// Default: 2 hours — should exceed typical agent durations (evicts inactive sessions)
	const staleIds: string[] = [];
	for (const [id, session] of swarmState.agentSessions) {
		if (now - session.lastToolCallTime > staleDurationMs) {
			staleIds.push(id);
		}
	}
	for (const id of staleIds) {
		swarmState.agentSessions.delete(id);
	}

	// Create new session state
	const sessionState: AgentSessionState = {
		agentName,
		lastToolCallTime: now,
		lastAgentEventTime: now,
		delegationActive: false,
		activeInvocationId: 0,
		lastInvocationIdByAgent: {},
		windows: {},
		lastCompactionHint: 0,
		// v6.12 Anti-Process-Violation Detection
		architectWriteCount: 0,
		lastCoderDelegationTaskId: null,
		currentTaskId: null,
		gateLog: new Map(),
		reviewerCallCount: new Map(),
		lastGateFailure: null,
		partialGateWarningsIssuedForTask: new Set(),
		selfFixAttempted: false,
		selfCodingWarnedAtCount: 0,
		catastrophicPhaseWarnings: new Set(),
		// Phase completion tracking
		lastPhaseCompleteTimestamp: 0,
		lastPhaseCompletePhase: 0,
		phaseAgentsDispatched: new Set(),
		lastCompletedPhaseAgentsDispatched: new Set(),
		// QA Skip Hard-Block Enforcement (v6.17)
		qaSkipCount: 0,
		qaSkipTaskIds: [],
		// v6.21 Per-task state machine
		taskWorkflowStates: new Map(),
		stageBCompletion: new Map(),
		taskCouncilApproved: new Map(),
		pendingCouncilRequirements: new Map(),
		lastGateOutcome: null,
		declaredCoderScope: null,
		lastScopeViolation: null,
		scopeViolationDetected: false,
		modifiedFilesThisCoderTask: [],
		// Turbo Mode (v6.26)
		turboMode: false,
		// Lean Turbo Mode (Phase 2)
		turboStrategy: undefined,
		leanTurboActive: false,
		leanTurboCurrentPhase: undefined,
		maxConcurrencyOverride: undefined,
		// QA Gate Profile session overrides
		qaGateSessionOverrides: {},
		// Full Auto Mode (Phase 2)
		fullAutoMode: false,
		fullAutoInteractionCount: 0,
		fullAutoDeadlockCount: 0,
		fullAutoLastQuestionHash: null,
		// Model Fallback (v6.33)
		model_fallback_index: 0,
		modelFallbackExhausted: false,
		// Bounded Coder Revisions (v6.33)
		coderRevisions: 0,
		revisionLimitHit: false,
		loopDetectionWindow: [],
		pendingAdvisoryMessages: [],
		sessionRehydratedAt: 0,
		// PRM (Process Remediation Manager) - Phase 1
		prmPatternCounts: new Map(),
		prmEscalationLevel: 0,
		prmLastPatternDetected: null,
		prmTrajectoryStep: 0,
		prmHardStopPending: false,
	};

	swarmState.agentSessions.set(sessionId, sessionState);
	telemetry.sessionStarted(sessionId, agentName);
	// Keep activeAgent map in sync so guardrails can always resolve the agent name
	// without falling back to ORCHESTRATOR_NAME for legitimately-named sessions.
	swarmState.activeAgent.set(sessionId, agentName);

	// Apply cached plan+evidence data so new sessions start with correct workflow
	// state even when no snapshot existed at init time.
	_internals.applyRehydrationCache(sessionState);

	// Rehydrate workflow state from disk if directory provided (non-fatal).
	// Register the promise in pendingRehydrations so rehydrateState can await it
	// before clearing agentSessions, preventing a race that would silently discard
	// in-flight workflow state.
	if (directory) {
		let rehydrationPromise: Promise<void>;
		rehydrationPromise = _internals
			.rehydrateSessionFromDisk(directory, sessionState)
			.catch((err) => {
				logger.warn(
					'[state] Rehydration failed:',
					err instanceof Error ? err.message : String(err),
				);
			})
			.finally(() => {
				swarmState.pendingRehydrations.delete(rehydrationPromise);
			});
		swarmState.pendingRehydrations.add(rehydrationPromise);
	}
}

/**
 * End an agent session by removing it from the state.
 * NOTE: Currently unused in production — no session lifecycle teardown is wired up.
 * Sessions accumulate for the process lifetime. Callers should integrate this into
 * a session TTL or idle-timeout mechanism to prevent unbounded Map growth.
 * @param sessionId - The session identifier to remove
 */
export function endAgentSession(sessionId: string): void {
	swarmState.agentSessions.delete(sessionId);
}

/**
 * Get an agent session state by session ID.
 * @param sessionId - The session identifier
 * @returns The AgentSessionState or undefined if not found
 */
export function getAgentSession(
	sessionId: string,
): AgentSessionState | undefined {
	return swarmState.agentSessions.get(sessionId);
}

/**
 * Ensure a guardrail session exists for the given sessionID.
 * If one exists and agentName is provided and different, update it.
 * If none exists, create one.
 * Always updates lastToolCallTime.
 * @param sessionId - The session identifier
 * @param agentName - Optional agent name (if known)
 * @returns The AgentSessionState
 */
export function ensureAgentSession(
	sessionId: string,
	agentName?: string,
	directory?: string,
): AgentSessionState {
	const now = Date.now();
	let session = swarmState.agentSessions.get(sessionId);

	if (session) {
		// Update agent name if provided and different from current
		if (agentName && agentName !== session.agentName) {
			const oldName = session.agentName;
			session.agentName = agentName;
			telemetry.agentActivated(sessionId, agentName, oldName);
			session.delegationActive = false;
			session.lastAgentEventTime = now;

			// Initialize window tracking if missing (migration from old state)
			if (!session.windows) {
				session.activeInvocationId = 0;
				session.lastInvocationIdByAgent = {};
				session.windows = {};
			}
		}

		// Ensure window tracking exists (migration safety)
		if (!session.windows) {
			session.activeInvocationId = 0;
			session.lastInvocationIdByAgent = {};
			session.windows = {};
		}

		// Initialize lastCompactionHint if missing (migration safety)
		if (session.lastCompactionHint === undefined) {
			session.lastCompactionHint = 0;
		}

		// Initialize v6.12 fields if missing (migration safety)
		if (session.architectWriteCount === undefined) {
			session.architectWriteCount = 0;
		}
		if (session.lastCoderDelegationTaskId === undefined) {
			session.lastCoderDelegationTaskId = null;
		}
		if (session.currentTaskId === undefined) {
			session.currentTaskId = null;
		}
		if (!session.gateLog) {
			session.gateLog = new Map();
		}
		if (!session.reviewerCallCount) {
			session.reviewerCallCount = new Map();
		}
		if (session.lastGateFailure === undefined) {
			session.lastGateFailure = null;
		}
		if (!session.partialGateWarningsIssuedForTask) {
			session.partialGateWarningsIssuedForTask = new Set();
		}
		if (session.selfFixAttempted === undefined) {
			session.selfFixAttempted = false;
		}
		if (session.selfCodingWarnedAtCount === undefined) {
			session.selfCodingWarnedAtCount = 0;
		}
		if (!session.catastrophicPhaseWarnings) {
			session.catastrophicPhaseWarnings = new Set();
		}
		// Phase completion tracking migration safety
		if (session.lastPhaseCompleteTimestamp === undefined) {
			session.lastPhaseCompleteTimestamp = 0;
		}
		if (session.lastPhaseCompletePhase === undefined) {
			session.lastPhaseCompletePhase = 0;
		}
		if (!session.phaseAgentsDispatched) {
			session.phaseAgentsDispatched = new Set();
		}
		if (!session.lastCompletedPhaseAgentsDispatched) {
			session.lastCompletedPhaseAgentsDispatched = new Set();
		}
		// QA Skip Hard-Block Enforcement migration safety (v6.17)
		if (session.qaSkipCount === undefined) {
			session.qaSkipCount = 0;
		}
		if (!session.qaSkipTaskIds) {
			session.qaSkipTaskIds = [];
		}
		// v6.21 Per-task state machine migration safety
		if (!session.taskWorkflowStates) {
			session.taskWorkflowStates = new Map();
		}
		// PR 2 Stage B barrier migration safety
		if (!session.stageBCompletion) {
			session.stageBCompletion = new Map();
		}
		// v6.71+ Council mode migration safety
		if (!session.taskCouncilApproved) {
			session.taskCouncilApproved = new Map();
		}
		if (!session.pendingCouncilRequirements) {
			session.pendingCouncilRequirements = new Map();
		}
		if (session.lastGateOutcome === undefined) {
			session.lastGateOutcome = null;
		}
		if (session.declaredCoderScope === undefined) {
			session.declaredCoderScope = null;
		}
		if (session.lastScopeViolation === undefined) {
			session.lastScopeViolation = null;
		}
		if (session.modifiedFilesThisCoderTask === undefined) {
			session.modifiedFilesThisCoderTask = [];
		}
		if (session.scopeViolationDetected === undefined) {
			session.scopeViolationDetected = false;
		}
		// Turbo Mode migration safety (v6.26)
		if (session.turboMode === undefined) {
			session.turboMode = false;
		}
		// Lean Turbo Mode migration safety (Phase 2)
		if (session.turboStrategy === undefined) {
			session.turboStrategy = undefined;
		}
		if (session.leanTurboActive === undefined) {
			session.leanTurboActive = false;
		}
		if (session.leanTurboCurrentPhase === undefined) {
			session.leanTurboCurrentPhase = undefined;
		}
		// QA Gate Profile session overrides migration safety
		if (session.qaGateSessionOverrides === undefined) {
			session.qaGateSessionOverrides = {};
		}
		// Model Fallback migration safety (v6.33)
		if (session.model_fallback_index === undefined) {
			session.model_fallback_index = 0;
		}
		if (session.modelFallbackExhausted === undefined) {
			session.modelFallbackExhausted = false;
		}
		if (session.loopDetectionWindow === undefined) {
			session.loopDetectionWindow = [];
		}
		if (session.pendingAdvisoryMessages === undefined) {
			session.pendingAdvisoryMessages = [];
		}
		// Bounded coder revisions migration safety (v6.33)
		if (session.coderRevisions === undefined) {
			session.coderRevisions = 0;
		}
		if (session.revisionLimitHit === undefined) {
			session.revisionLimitHit = false;
		}
		// Stale state detection migration safety (Bug B)
		if (session.sessionRehydratedAt === undefined) {
			session.sessionRehydratedAt = 0;
		}
		// PRM migration safety (Phase 1)
		if (session.prmPatternCounts === undefined) {
			session.prmPatternCounts = new Map();
		}
		if (session.prmEscalationLevel === undefined) {
			session.prmEscalationLevel = 0;
		}
		if (session.prmLastPatternDetected === undefined) {
			session.prmLastPatternDetected = null;
		}
		if (session.prmTrajectoryStep === undefined) {
			session.prmTrajectoryStep = 0;
		}
		if (session.prmHardStopPending === undefined) {
			session.prmHardStopPending = false;
		}

		session.lastToolCallTime = now;
		return session;
	}

	// Create new session
	_internals.startAgentSession(
		sessionId,
		agentName ?? 'unknown',
		7200000,
		directory,
	);
	session = swarmState.agentSessions.get(sessionId);
	if (!session) {
		// This should never happen, but TypeScript needs it
		throw new Error(`Failed to create guardrail session for ${sessionId}`);
	}
	return session;
}

/**
 * Update only the agent event timestamp (for stale detection).
 * Does NOT change agent name or reset guardrail state.
 * @param sessionId - The session identifier
 */
export function updateAgentEventTime(sessionId: string): void {
	const session = swarmState.agentSessions.get(sessionId);
	if (session) {
		session.lastAgentEventTime = Date.now();
	}
}

/**
 * Begin a new invocation window for the given agent.
 * Increments invocation ID, creates fresh budget counters.
 * Returns null for architect (unlimited, no window).
 *
 * @param sessionId - Session identifier
 * @param agentName - Agent name (with or without swarm prefix)
 * @returns New window or null if architect
 */
export function beginInvocation(
	sessionId: string,
	agentName: string,
): InvocationWindow | null {
	const session = swarmState.agentSessions.get(sessionId);
	if (!session) {
		throw new Error(
			`Cannot begin invocation: session ${sessionId} does not exist`,
		);
	}

	// Architect never creates windows (unlimited)
	const stripped = stripKnownSwarmPrefix(agentName);
	if (stripped === ORCHESTRATOR_NAME) {
		return null;
	}

	// Increment invocation ID for this agent
	const lastId = session.lastInvocationIdByAgent[stripped] || 0;
	const newId = lastId + 1;
	session.lastInvocationIdByAgent[stripped] = newId;
	session.activeInvocationId = newId;

	// Create new window
	const now = Date.now();
	const window: InvocationWindow = {
		id: newId,
		agentName: stripped,
		startedAtMs: now,
		toolCalls: 0,
		consecutiveErrors: 0,
		hardLimitHit: false,
		lastSuccessTimeMs: now,
		recentToolCalls: [],
		warningIssued: false,
		warningReason: '',
		transientRetryCount: 0,
	};

	const key = `${stripped}:${newId}`;
	session.windows[key] = window;

	// Prune old windows to prevent memory leak
	pruneOldWindows(sessionId, 24 * 60 * 60 * 1000, 50); // 24h max age, 50 max windows

	telemetry.delegationBegin(
		sessionId,
		stripped,
		session.currentTaskId ?? 'unknown',
	);
	return window;
}

/**
 * Get the currently active invocation window for the session.
 * Returns undefined if no window exists (e.g., architect session).
 *
 * @param sessionId - Session identifier
 * @returns Active window or undefined
 */
export function getActiveWindow(
	sessionId: string,
): InvocationWindow | undefined {
	const session = swarmState.agentSessions.get(sessionId);
	if (!session || !session.windows) {
		return undefined;
	}

	const stripped = stripKnownSwarmPrefix(session.agentName);
	const key = `${stripped}:${session.activeInvocationId}`;
	return session.windows[key];
}

/**
 * Prune old invocation windows to prevent unbounded memory growth.
 * Removes windows older than maxAgeMs and keeps only the most recent maxWindows.
 *
 * @param sessionId - Session identifier
 * @param maxAgeMs - Maximum age in milliseconds (default 24 hours)
 * @param maxWindows - Maximum number of windows to keep (default 50)
 */
export function pruneOldWindows(
	sessionId: string,
	maxAgeMs = 24 * 60 * 60 * 1000,
	maxWindows = 50,
): void {
	const session = swarmState.agentSessions.get(sessionId);
	if (!session || !session.windows) {
		return;
	}

	const now = Date.now();
	const entries = Object.entries(session.windows);

	// Remove windows older than maxAgeMs
	const validByAge = entries.filter(
		([_, window]) => now - window.startedAtMs < maxAgeMs,
	);

	// Sort by timestamp descending, keep most recent maxWindows
	const sorted = validByAge.sort((a, b) => b[1].startedAtMs - a[1].startedAtMs);
	const toKeep = sorted.slice(0, maxWindows);

	// Rebuild windows object
	session.windows = Object.fromEntries(toKeep);
}

/**
 * Record an agent dispatch for phase completion tracking.
 * Normalizes the agent name via stripKnownSwarmPrefix before adding to phaseAgentsDispatched.
 * @param sessionId - Session identifier
 * @param agentName - Agent name to record (will be normalized)
 */
export function recordPhaseAgentDispatch(
	sessionId: string,
	agentName: string,
): void {
	const session = swarmState.agentSessions.get(sessionId);
	if (!session) {
		return;
	}

	// Ensure phaseAgentsDispatched exists (migration safety)
	if (!session.phaseAgentsDispatched) {
		session.phaseAgentsDispatched = new Set();
	}

	const normalizedName = stripKnownSwarmPrefix(agentName);
	session.phaseAgentsDispatched.add(normalizedName);
}

/**
 * Check if a task ID is valid (not null, undefined, empty, or whitespace-only).
 * @param taskId - The task identifier to validate
 * @returns true if valid, false otherwise
 */
function isValidTaskId(taskId: string | null | undefined): boolean {
	if (taskId === null || taskId === undefined) {
		return false;
	}
	if (typeof taskId !== 'string') {
		return false;
	}
	const trimmed = taskId.trim();
	return trimmed.length > 0;
}

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
export function advanceTaskState(
	session: AgentSessionState,
	taskId: string,
	newState: TaskWorkflowState,
	options?: {
		telemetrySessionId?: string;
		emitTelemetry?: boolean;
	},
	councilConfig?: { minimumMembers?: number; requireAllMembers?: boolean },
): void {
	// Guard against invalid taskId - safely return without mutating state
	if (!isValidTaskId(taskId)) {
		return;
	}

	if (!session || !(session.taskWorkflowStates instanceof Map)) {
		throw new Error(
			'INVALID_SESSION: session.taskWorkflowStates must be a Map instance',
		);
	}

	const STATE_ORDER: TaskWorkflowState[] = [
		'idle',
		'coder_delegated',
		'pre_check_passed',
		'reviewer_run',
		'tests_run',
		'complete',
	];

	const current = session.taskWorkflowStates.get(taskId) ?? 'idle';
	const currentIndex = STATE_ORDER.indexOf(current);
	const newIndex = STATE_ORDER.indexOf(newState);

	if (newIndex <= currentIndex) {
		throw new Error(
			`INVALID_TASK_STATE_TRANSITION: ${taskId} ${current} → ${newState}`,
		);
	}

	// 'complete' can only be reached from 'tests_run' — enforce sequential progression
	if (newState === 'complete' && current !== 'tests_run') {
		// Council fast-path: if submit_council_verdicts recorded an APPROVE verdict for this task,
		// allow advancement from any non-idle prior state. Pre-check (pre_check_passed) is
		// still required to avoid skipping Stage A.
		// Quorum gate: an APPROVE verdict only short-circuits the gate sequence
		// when it was recorded with at least `minimumMembers` distinct member
		// verdicts. Default 3; `requireAllMembers: true` overrides to 5.
		// Callers without `councilConfig` get the default — old single-member
		// approvals are no longer trusted automatically.
		const councilEntry = session.taskCouncilApproved?.get(taskId);
		const effectiveMinimum = councilConfig?.requireAllMembers
			? 5
			: (councilConfig?.minimumMembers ?? 3);
		const councilApproved =
			councilEntry?.verdict === 'APPROVE' &&
			// ?? 0: final safety net for Map entries lacking quorumSize. Old
			// evidence rehydrates as quorumSize: 1 (Task 3.3); a missing field
			// here is more conservative still and forces a fresh council run.
			(councilEntry.quorumSize ?? 0) >= effectiveMinimum;
		const pastPreCheck =
			currentIndex >= STATE_ORDER.indexOf('pre_check_passed');
		if (!councilApproved || !pastPreCheck) {
			throw new Error(
				`INVALID_TASK_STATE_TRANSITION: ${taskId} cannot reach complete from ${current} — must pass through tests_run first (or have council APPROVE after pre_check)`,
			);
		}
	}

	session.taskWorkflowStates.set(taskId, newState);
	if (options?.emitTelemetry !== false) {
		telemetry.taskStateChanged(
			options?.telemetrySessionId ?? session.agentName,
			taskId,
			newState,
			current,
		);
	}
}

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
export async function advanceTaskStateAndPersist(
	session: AgentSessionState,
	taskId: string,
	newState: TaskWorkflowState,
	directory: string,
	options?: {
		telemetrySessionId?: string;
		emitTelemetry?: boolean;
	},
	councilConfig?: { minimumMembers?: number; requireAllMembers?: boolean },
): Promise<void> {
	advanceTaskState(session, taskId, newState, options, councilConfig);

	if (newState !== 'coder_delegated' && newState !== 'complete') {
		return;
	}

	const planStatus: TaskStatus =
		newState === 'complete' ? 'completed' : 'in_progress';

	try {
		await updateTaskStatus(directory, taskId, planStatus);
	} catch (err) {
		logger.warn(
			`[advanceTaskStateAndPersist] persist ${taskId} → ${planStatus} failed (in-memory state still advanced): ${err instanceof Error ? err.message : String(err)}`,
		);
	}
}

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
export function getTaskState(
	session: AgentSessionState,
	taskId: string,
): TaskWorkflowState {
	// Guard against invalid taskId - safely return 'idle'
	if (!isValidTaskId(taskId)) {
		return 'idle';
	}

	if (!session.taskWorkflowStates) {
		session.taskWorkflowStates = new Map();
	}

	return session.taskWorkflowStates.get(taskId) ?? 'idle';
}

/**
 * PR 2 Stage B barrier: record that a Stage B agent has completed for a task.
 * Order-independent — either 'reviewer' or 'test_engineer' may complete first.
 * Initializes the per-task set on first write.
 *
 * @param session - The agent session state
 * @param taskId - The task identifier
 * @param agent - Which Stage B agent completed ('reviewer' or 'test_engineer')
 */
export function recordStageBCompletion(
	session: AgentSessionState,
	taskId: string,
	agent: 'reviewer' | 'test_engineer',
): void {
	if (!isValidTaskId(taskId)) return;
	if (!session.stageBCompletion) {
		session.stageBCompletion = new Map();
	}
	const existing = session.stageBCompletion.get(taskId);
	if (existing) {
		existing.add(agent);
	} else {
		session.stageBCompletion.set(taskId, new Set([agent]));
	}
}

/**
 * PR 2 Stage B barrier: returns true iff both 'reviewer' and 'test_engineer' have
 * been recorded for the given task in this session.
 *
 * @param session - The agent session state
 * @param taskId - The task identifier
 * @returns true when both Stage B agents have completed
 */
export function hasBothStageBCompletions(
	session: AgentSessionState,
	taskId: string,
): boolean {
	if (!isValidTaskId(taskId)) return false;
	const completions = session.stageBCompletion?.get(taskId);
	if (!completions) return false;
	return completions.has('reviewer') && completions.has('test_engineer');
}

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
export async function isCouncilGateActive(
	directory: string,
	council: { enabled?: boolean } | undefined,
): Promise<boolean> {
	const enabled = council?.enabled === true;

	let plan: Plan | null = null;
	try {
		plan = await loadPlanJsonOnly(directory);
	} catch {
		plan = null;
	}
	if (!plan) {
		return false;
	}

	const planId = derivePlanId(plan);
	let profile: ReturnType<typeof getProfile> | null = null;
	try {
		profile = getProfile(directory, planId);
	} catch (err) {
		// getProfile returns null on missing DB; it only throws on unexpected I/O or
		// SQLite errors (EACCES, EBUSY, corrupt database). Log those so they're visible.
		const msg = err instanceof Error ? err.message : String(err);
		const isBenign = msg.includes('SQLITE_CANTOPEN') || msg.includes('ENOENT');
		if (!isBenign) {
			logger.warn(
				`[isCouncilGateActive] getProfile threw unexpectedly for plan ${planId}: ${msg}. Treating council as inactive.`,
			);
		}
		profile = null;
	}
	if (!profile) {
		return false;
	}

	const councilMode = profile.gates.council_mode === true;

	if (enabled && councilMode) {
		return true;
	}

	// Disagreement case: warn once per plan_id, then fall back.
	if (enabled !== councilMode && !_councilDisagreementWarned.has(planId)) {
		_councilDisagreementWarned.add(planId);
		logger.warn(
			`[delegation-gate] Council mode mismatch for plan ${planId}: ` +
				`pluginConfig.council.enabled=${enabled}, QaGates.council_mode=${councilMode}. ` +
				'Falling back to Stage B (non-council) advancement.',
		);
	}

	return false;
}

/**
 * Test-only helper: clear the warn-once memo so each test can observe a fresh
 * disagreement warning. Not part of the public surface.
 */
export function _resetCouncilDisagreementWarnings(): void {
	_councilDisagreementWarned.clear();
}

/**
 * Maps plan task status to task workflow state.
 * - 'pending' -> 'idle' (no work started yet)
 * - 'in_progress' -> 'coder_delegated' (work has started)
 * - 'completed' -> 'complete' (done)
 * - 'blocked' -> 'idle' (blocked tasks haven't progressed)
 */
function planStatusToWorkflowState(status: TaskStatus): TaskWorkflowState {
	switch (status) {
		case 'in_progress':
			return 'coder_delegated';
		case 'completed':
			return 'complete';
		default:
			return 'idle';
	}
}

/**
 * Maps evidence gates to task workflow state.
 * Evidence provides stronger signal than plan-only status.
 * - 'coder' dispatched -> 'coder_delegated'
 * - 'reviewer' passed -> 'reviewer_run'
 * - 'test_engineer' passed -> 'tests_run'
 * - All required gates passed -> 'complete'
 */
function evidenceToWorkflowState(evidence: TaskEvidence): TaskWorkflowState {
	const gates = evidence.gates ?? {};
	const requiredGates = evidence.required_gates ?? [];

	// Check if all required gates have evidence
	if (requiredGates.length > 0) {
		const allPassed = requiredGates.every((gate) => gates[gate] != null);
		if (allPassed) {
			return 'complete';
		}
	}

	// Check the highest gate passed
	if (gates.test_engineer != null) {
		return 'tests_run';
	}
	if (gates.reviewer != null) {
		return 'reviewer_run';
	}
	if (Object.keys(gates).length > 0) {
		return 'coder_delegated';
	}

	return 'idle';
}

/**
 * Reads and parses plan.json from the given directory.
 * Returns null if file doesn't exist or is malformed (non-fatal).
 */
async function readPlanFromDisk(directory: string): Promise<Plan | null> {
	try {
		const planPath = path.join(directory, '.swarm', 'plan.json');
		const content = await fs.readFile(planPath, 'utf-8');
		const parsed = JSON.parse(content);
		return PlanSchema.parse(parsed) as Plan;
	} catch {
		// Non-fatal: missing or malformed plan.json
		return null;
	}
}

/**
 * Reads gate evidence files from .swarm/evidence/*.json (written by recordGateEvidence).
 * Returns a Map of taskId -> TaskEvidence (only valid gate evidence parsed).
 * Validates that each file has the gate evidence schema: { taskId: string, required_gates: string[] }.
 * Non-fatal: skips malformed files without throwing.
 */
async function readGateEvidenceFromDisk(
	directory: string,
): Promise<Map<string, TaskEvidence>> {
	const evidenceMap = new Map<string, TaskEvidence>();

	try {
		const evidenceDir = path.join(directory, '.swarm', 'evidence');
		const entries = await fs.readdir(evidenceDir, { withFileTypes: true });

		for (const entry of entries) {
			if (!entry.isFile() || !entry.name.endsWith('.json')) {
				continue;
			}

			const taskId = entry.name.replace(/\.json$/, '');
			// Validate taskId format to prevent path traversal
			if (!/^\d+\.\d+(\.\d+)*$/.test(taskId)) {
				continue;
			}

			try {
				const filePath = path.join(evidenceDir, entry.name);
				const content = await fs.readFile(filePath, 'utf-8');
				const parsed = JSON.parse(content);

				// Gate evidence schema validation: must have taskId and required_gates
				// to match what recordGateEvidence writes ({ taskId, required_gates, gates })
				if (
					parsed &&
					typeof parsed.taskId === 'string' &&
					Array.isArray(parsed.required_gates)
				) {
					evidenceMap.set(taskId, parsed as TaskEvidence);
				}
			} catch {
				// Skip malformed evidence files (non-fatal)
			}
		}
	} catch {
		// Evidence directory doesn't exist (non-fatal)
	}

	return evidenceMap;
}

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
export async function buildRehydrationCache(directory: string): Promise<void> {
	const planTaskStates = new Map<string, TaskWorkflowState>();

	const plan = await readPlanFromDisk(directory);
	if (plan) {
		for (const phase of plan.phases ?? []) {
			for (const task of phase.tasks ?? []) {
				planTaskStates.set(task.id, planStatusToWorkflowState(task.status));
			}
		}
	}

	const evidenceMap = await readGateEvidenceFromDisk(directory);
	_rehydrationCache = { planTaskStates, evidenceMap };
}

/**
 * Synchronously applies the cached plan+evidence data to a session.
 * Merge rules:
 *   - evidence-derived state: only applied if it advances past existing state
 *   - plan-only derived state: only applied if it advances past existing state
 * No-op when the cache has not been built yet.
 */
export function applyRehydrationCache(session: AgentSessionState): void {
	if (!_rehydrationCache) {
		return;
	}

	if (!session.taskWorkflowStates) {
		session.taskWorkflowStates = new Map();
	}
	if (!session.taskCouncilApproved) {
		session.taskCouncilApproved = new Map();
	}

	const { planTaskStates, evidenceMap } = _rehydrationCache;

	const STATE_ORDER: TaskWorkflowState[] = [
		'idle',
		'coder_delegated',
		'pre_check_passed',
		'reviewer_run',
		'tests_run',
		'complete',
	];

	for (const [taskId, planState] of planTaskStates) {
		const existingState = session.taskWorkflowStates.get(taskId);
		const evidence = evidenceMap.get(taskId);

		if (evidence) {
			// Evidence provides the strongest signal for completed gates.
			// But evidence files lag behind in-memory state (evidence recording
			// is async and only captures completed gates). Only upgrade state,
			// never downgrade — same guard as the plan-only branch below.
			const derivedState = evidenceToWorkflowState(evidence);
			const existingIndex = existingState
				? STATE_ORDER.indexOf(existingState)
				: -1;
			const derivedIndex = STATE_ORDER.indexOf(derivedState);
			if (derivedIndex > existingIndex) {
				session.taskWorkflowStates.set(taskId, derivedState);
			}
		} else {
			// Plan-only: only advance past existing state, never downgrade.
			// A snapshot state that is ahead of the plan is valid (e.g. gates passed
			// after plan was last written), so keep it.
			const existingIndex = existingState
				? STATE_ORDER.indexOf(existingState)
				: -1;
			const derivedIndex = STATE_ORDER.indexOf(planState);
			if (derivedIndex > existingIndex) {
				session.taskWorkflowStates.set(taskId, planState);
			}
		}
	}

	// Rehydrate council verdicts from evidenceMap for ALL tasks (not just planTaskStates).
	// In-memory entries take priority; skip on malformed or missing data.
	const VALID_COUNCIL_VERDICTS = new Set([
		'APPROVE',
		'REJECT',
		'CONCERNS',
	] as const);
	for (const [taskId, evidence] of evidenceMap) {
		// Skip if already in memory (in-memory wins over persisted evidence).
		if (session.taskCouncilApproved.has(taskId)) {
			continue;
		}
		// Cast to extended type — verdict/roundNumber/quorumSize are preserved via
		// passthrough() but not in the base GateEvidence interface (which only has
		// sessionId/timestamp/agent).
		const council = evidence.gates?.council as
			| { verdict?: string; roundNumber?: number; quorumSize?: number }
			| undefined;
		if (!council) {
			continue;
		}
		const rawVerdict = council.verdict;
		if (!rawVerdict || typeof rawVerdict !== 'string') {
			continue;
		}
		if (
			!VALID_COUNCIL_VERDICTS.has(
				rawVerdict as 'APPROVE' | 'REJECT' | 'CONCERNS',
			)
		) {
			continue;
		}
		const verdict = rawVerdict as 'APPROVE' | 'REJECT' | 'CONCERNS';
		let roundNumber = council.roundNumber;
		if (typeof roundNumber !== 'number' || !Number.isFinite(roundNumber)) {
			roundNumber = 1;
		}
		// Conservative default: pre-quorum evidence files (without quorumSize)
		// rehydrate as 1, which fails the fast-path against the default
		// minimumMembers=3 — forcing a fresh council run after upgrade rather
		// than trusting an unverified single-member APPROVE.
		const rawQuorumSize = council.quorumSize;
		const quorumSize =
			typeof rawQuorumSize === 'number' &&
			Number.isFinite(rawQuorumSize) &&
			rawQuorumSize >= 1
				? rawQuorumSize
				: 1;
		session.taskCouncilApproved.set(taskId, {
			verdict,
			roundNumber,
			quorumSize,
		});
	}
}

/**
 * Rehydrates session workflow state from durable swarm files.
 * Builds (or refreshes) the rehydration cache from disk, then applies it
 * to the target session.
 */
export async function rehydrateSessionFromDisk(
	directory: string,
	session: AgentSessionState,
): Promise<void> {
	await _internals.buildRehydrationCache(directory);
	_internals.applyRehydrationCache(session);
}

/**
 * Check if Turbo Mode is enabled for a specific session or ANY session.
 * @param sessionID - Optional session ID to check. If provided, checks only that session.
 *                    If omitted, checks all sessions (backward-compatible global behavior).
 * @returns true if the specified session has turboMode: true, or if any session has turboMode: true when no sessionID provided
 */
export function hasActiveTurboMode(sessionID?: string): boolean {
	if (sessionID) {
		const session = swarmState.agentSessions.get(sessionID);
		return session?.turboMode === true;
	}
	// Global fallback — existing behavior when no sessionID provided
	for (const [_sessionId, session] of swarmState.agentSessions) {
		if (session.turboMode === true) {
			return true;
		}
	}
	return false;
}

/**
 * Check if Full Auto Mode is enabled for a specific session or ANY session.
 * @param sessionID - Optional session ID to check. If provided, checks only that session.
 *                    If omitted, checks all sessions (backward-compatible global behavior).
 * @returns true if the specified session has fullAutoMode: true (model validation is advisory-only).
 */
export function hasActiveFullAuto(sessionID?: string): boolean {
	if (sessionID) {
		const session = swarmState.agentSessions.get(sessionID);
		return session?.fullAutoMode === true;
	}
	// Global fallback — existing behavior when no sessionID provided
	for (const [_sessionId, session] of swarmState.agentSessions) {
		if (session.fullAutoMode === true) {
			return true;
		}
	}
	return false;
}

/**
 * Check if Lean Turbo Mode is active for a specific session or ANY session.
 * @param sessionID - Optional session ID to check. If provided, checks only that session.
 *                    If omitted, checks all sessions.
 * @returns true if the specified session has turboStrategy: 'lean' AND leanTurboActive: true,
 *          or if any session has that combination when no sessionID provided.
 */
export function hasActiveLeanTurbo(sessionID?: string): boolean {
	if (sessionID) {
		const session = swarmState.agentSessions.get(sessionID);
		return (
			session?.turboMode === true &&
			session?.turboStrategy === 'lean' &&
			session?.leanTurboActive === true
		);
	}
	// Global fallback
	for (const [_sessionId, session] of swarmState.agentSessions) {
		if (
			session.turboMode === true &&
			session.turboStrategy === 'lean' &&
			session.leanTurboActive === true
		) {
			return true;
		}
	}
	return false;
}

// ============================================================================
// Environment Profile Helpers
// ============================================================================

export function setSessionEnvironment(
	sessionId: string,
	profile: EnvironmentProfile,
): void {
	swarmState.environmentProfiles.set(sessionId, profile);
}

export function getSessionEnvironment(
	sessionId: string,
): EnvironmentProfile | undefined {
	return swarmState.environmentProfiles.get(sessionId);
}

export function ensureSessionEnvironment(
	sessionId: string,
): EnvironmentProfile {
	const existing = swarmState.environmentProfiles.get(sessionId);
	if (existing) return existing;
	const profile = detectEnvironmentProfile();
	swarmState.environmentProfiles.set(sessionId, profile);
	void import('./telemetry.js')
		.then(({ telemetry }) => {
			telemetry.environmentDetected(
				sessionId,
				profile.hostOS,
				profile.shellFamily,
				profile.executionMode,
			);
		})
		.catch(() => {
			// telemetry emission failure must not block environment detection
		});
	return profile;
}

// Bounded-collection caps for v2 knowledge state (AGENTS.md invariant #8 —
// "Module-level global state must have an explicit eviction strategy").
// Values mirror MAX_TRACKED_SESSIONS in adversarial-detector.ts. The Map
// preserves insertion order so `Map.keys().next()` is the FIFO oldest.
export const MAX_TRACKED_CRITICAL_SHOWN = 500;
export const MAX_TRACKED_KNOWLEDGE_ACKS = 5000;

/** Set the critical shown ids for a session, FIFO-evicting the oldest entry
 * if the cap is exceeded. Re-setting an existing key keeps insertion order
 * fresh for that key (delete-then-set). */
export function setCriticalShownIds(
	sessionID: string,
	value: {
		ids: string[];
		taskId?: string;
		phase?: string;
		generatedAt: number;
	},
): void {
	const map = swarmState.currentCriticalShownIds;
	if (map.has(sessionID)) map.delete(sessionID);
	map.set(sessionID, value);
	if (map.size > MAX_TRACKED_CRITICAL_SHOWN) {
		const oldest = map.keys().next().value;
		if (oldest !== undefined && oldest !== sessionID) {
			map.delete(oldest);
		}
	}
}

/** Clear the critical shown ids for a session. Centralised so call sites do
 *  not bypass the FIFO-cap pathway with a direct `.delete()`. Returns
 *  whether an entry was removed. */
export function clearCriticalShownIds(sessionID: string): boolean {
	return swarmState.currentCriticalShownIds.delete(sessionID);
}

/** Add a knowledge ack dedup key, FIFO-evicting the oldest if the cap is
 * exceeded. Sets preserve insertion order in JS. */
export function addKnowledgeAckDedup(key: string): void {
	const set = swarmState.knowledgeAckDedup;
	if (set.has(key)) return;
	set.add(key);
	if (set.size > MAX_TRACKED_KNOWLEDGE_ACKS) {
		const oldest = set.values().next().value;
		if (oldest !== undefined) set.delete(oldest);
	}
}

/**
 * Test-only dependency-injection seam. Production code calls
 * `_internals.*` for key exported functions and objects so tests can replace
 * them without using `mock.module` — `mock.module` from `bun:test` leaks
 * across files in Bun's shared test-runner process, which would corrupt
 * unrelated test suites. Mutating this local object is file-scoped and
 * trivially restorable via `afterEach`.
 */
export const _internals: {
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
} = {
	swarmState,
	resetSwarmState,
	ensureAgentSession,
	startAgentSession,
	getAgentSession,
	beginInvocation,
	getActiveWindow,
	advanceTaskState,
	getTaskState,
	hasActiveFullAuto,
	hasActiveTurboMode,
	hasActiveLeanTurbo,
	buildRehydrationCache,
	applyRehydrationCache,
	rehydrateSessionFromDisk,
	isCouncilGateActive,
	defaultRunContext,
};
