/**
 * Shared state module for OpenCode Swarm plugin.
 * Provides a module-scoped singleton for cross-hook state sharing.
 *
 * This module is used by multiple hooks (tool.execute.before, tool.execute.after,
 * chat.message, system-enhancer) to share state like active agents, tool call tracking,
 * and delegation chains.
 */

// FR-007: This module spans 6+ distinct concerns (session management, agent tracking,
// tool call history, spiral detection, QA gate overrides, worktree tracking) with 48
// exported symbols and 100+ importing files. Splitting is deferred pending a concrete
// driver. See .swarm/spec.md FR-007.

import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { OpencodeClient } from '@opencode-ai/sdk';
import { ORCHESTRATOR_NAME } from './config/constants';
import { type Plan, PlanSchema, type TaskStatus } from './config/plan-schema';
import { stripKnownSwarmPrefix } from './config/schema';
import type { CouncilAgent } from './council/types';
import {
	getEffectiveGates,
	getProfile,
	type QaGates,
} from './db/qa-gate-profile.js';
import {
	detectEnvironmentProfile,
	type EnvironmentProfile,
} from './environment/profile.js';
import type { TaskEvidence } from './gate-evidence';
import {
	clearPendingCoderScope,
	resetStandardWorktreeIsolationState,
} from './hooks/delegation-gate.js';
import {
	clearRealtimeLearningNudgeSession,
	resetRealtimeLearningNudgeState,
} from './hooks/realtime-learning-nudge.js';
import { clearTrajectoryStepCounters } from './hooks/trajectory-step-state.js';
import { resetSessionQueue } from './learning/candidate-queue.js';
import { resetPrmPatternSupport } from './learning/prm-pattern-support.js';
import {
	isTaskSettled,
	loadPlanJsonOnly,
	updateTaskStatus,
} from './plan/manager.js';
import { derivePlanId } from './plan/utils.js';
import type { EscalationTracker } from './prm/escalation.js';
import { clearTrajectoryCache } from './prm/trajectory-store.js';
import type { PatternMatch } from './prm/types.js';
import { clearScopeBindings } from './scope/scope-binding.js';
import { clearScopeBindingFromDisk } from './scope/scope-persistence.js';
import { recordSessionStart } from './session/session-start-store.js';
import { maybeSuggestWorktreeLink } from './session/worktree-link-suggestion.js';
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
 * Per-session PR subscription state for the background PR poller.
 * Keyed by `${repoFullName}::${prNumber}` within the session's prSubscriptions Map.
 */
export interface PrSubscriptionState {
	prNumber: number;
	repoFullName: string;
	prUrl: string;
	lastKnownStatus: string;
	lastPollTime: number;
	errorCount: number;
	isWatching: boolean;
}

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
 * Upper bound for per-session task file-attribution entries.
 *
 * Runtime concurrency is capped well below this value. When the map is full,
 * only workflow-complete entries may be reclaimed; live task attribution is
 * never evicted to make room.
 */
export const MAX_TRACKED_TASK_FILE_ATTRIBUTIONS = 128;

/**
 * Canonical ordering of TaskWorkflowState values for forward-only transition checks.
 * Used by advanceTaskState, canAdvanceTaskState, and applyRehydrationCache.
 * Extracted from three duplicate local literals to a single module-level constant
 * to eliminate duplication and prevent future drift.
 */
const STATE_ORDER: TaskWorkflowState[] = [
	'idle',
	'coder_delegated',
	'pre_check_passed',
	'reviewer_run',
	'tests_run',
	'complete',
];

/** Exact lifecycle state for one coder generation and its paired reviewer. */
export interface ReviewerScopeGeneration {
	taskId: string;
	coderCallID: string;
	generation: number;
	sessionIncarnation: string;
	background: boolean;
	declaredFiles: string[];
	modifiedFiles: string[];
	modifiedFileFingerprints: import('./hooks/reviewer-scope-file-fingerprint.js').ReviewerScopeFileFingerprint[];
	status: 'collecting' | 'ready' | 'claimed';
	createdAt: number;
	readyAt?: number;
	reviewerCallID?: string;
	reviewerDispatchScope?: ReviewerScopeDispatchSnapshot;
}

export interface ReviewerScopeDispatchSnapshot {
	hash: string;
	description: string;
	files: string[];
	headSha: string;
	taskId: string;
	coderCallID: string;
	generation: number;
	sessionIncarnation: string;
}

function cloneReviewerScopeGeneration(
	generation: ReviewerScopeGeneration,
): ReviewerScopeGeneration {
	return {
		...generation,
		declaredFiles: [...generation.declaredFiles],
		modifiedFiles: [...generation.modifiedFiles],
		modifiedFileFingerprints: generation.modifiedFileFingerprints.map(
			(entry) => ({
				...entry,
			}),
		),
		reviewerDispatchScope: generation.reviewerDispatchScope
			? {
					...generation.reviewerDispatchScope,
					files: [...generation.reviewerDispatchScope.files],
				}
			: undefined,
	};
}

export interface ReviewerScopeGenerationIdentity {
	generation: number;
	coderCallID: string;
	sessionIncarnation: string;
}

/**
 * Immutable ownership provenance retained after a background generation's
 * reviewer consumes the live handoff. Delayed sibling completion ingestion may
 * consult this bounded history, but only exact fingerprints and overlapping
 * dispatch intervals can establish ownership.
 */
export interface ReviewerScopeOwnershipTombstone
	extends ReviewerScopeGenerationIdentity {
	parentSessionID: string;
	taskId: string;
	background: true;
	declaredFiles: string[];
	modifiedFiles: string[];
	modifiedFileFingerprints: import('./hooks/reviewer-scope-file-fingerprint.js').ReviewerScopeFileFingerprint[];
	createdAt: number;
	readyAt: number;
	consumedAt: number;
}

function cloneReviewerScopeOwnershipTombstone(
	tombstone: ReviewerScopeOwnershipTombstone,
): ReviewerScopeOwnershipTombstone {
	return {
		...tombstone,
		declaredFiles: [...tombstone.declaredFiles],
		modifiedFiles: [...tombstone.modifiedFiles],
		modifiedFileFingerprints: tombstone.modifiedFileFingerprints.map(
			(fingerprint) => ({ ...fingerprint }),
		),
	};
}

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
	/**
	 * In-memory only circuit for known non-transient tool failures. Deliberately
	 * omitted from snapshots so a restarted host never inherits a stale stop.
	 */
	nonTransientCircuit?: NonTransientCircuitState;
	/** Bounded in-memory correlation for original commands replaced by wrappers. */
	pendingToolExecutions?: Map<string, PendingToolExecution>;

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
	/** Task IDs for which the completion-gate violation advisory has already been issued
	 *  (issue #1976 B3: prevents re-injecting the identical, unactionable directive on
	 *  every subsequent Task tool call while the same task stays stuck in tests_run). */
	completionGateWarnedForTask: Set<string>;
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
			/**
			 * A.4 dedup guard: set true once the positive council reward
			 * (EMA step on session-recalled memories) has fired for this task.
			 * Ensures the reward is applied at most once per task even if the
			 * APPROVE→complete path is re-entered.
			 */
			rewarded?: boolean;
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
	/**
	 * Issue #2002: the root this session actually EXECUTES in, when it differs
	 * from the plugin-root `ctx.directory`.
	 *
	 * Worktree-isolated coder children are created with
	 * `session.create({ query: { directory: <lane> } })`, and their scope binding
	 * is derived and published against that lane. The write gates are constructed
	 * once at plugin init with `ctx.directory` and would otherwise resolve every
	 * session's binding, containment, and `.swarm/` reads against the project
	 * root — which can never match a lane-rooted binding.
	 *
	 * TRUST BOUNDARY: written ONLY by `recordSessionWorkspaceRoot`, whose single
	 * closed allowlist of production callers each pass `provisionWorktree`'s own
	 * output. `ensureAgentSession`'s `directory` argument (which can carry an
	 * agent-supplied `working_directory`, e.g. via `declare_scope`) must NEVER
	 * write this field.
	 *
	 * DELIBERATELY NOT SNAPSHOTTED (issue #2002 follow-up). `serializeAgentSession`
	 * (`src/session/snapshot-writer.ts`) intentionally omits this field, and it
	 * MUST stay omitted. The reason is trust, not oversight: `.swarm/session/state.json`
	 * lives under the project-root `.swarm/` directory, which the architect agent
	 * can write, so a restored string in that file is not a trusted resolution
	 * root — a tampered or stale snapshot could install an arbitrary root, or
	 * re-point a session at a *different* lane it never owned (cross-lane
	 * containment re-rooting). Persisting it would only be safe if rehydrate could
	 * revalidate the restored value against a durable, plugin-owned record of
	 * provisioned lanes, and no such record exists:
	 *   - `worktree-provisioning-owner.ts`'s durable marker
	 *     (`recordWorktreeProvisioningOwner`) stores no `worktreePath` at all, and
	 *     its `worktreeSessionId` field is always the *parent* session id
	 *     (`worktree-isolation.ts` passes `args.parentSessionID`, confirmed by
	 *     every production and test call site) — it cannot answer "does child
	 *     session X own lane path Y".
	 *   - `background-delegations.jsonl` (`src/background/pending-delegations.ts`)
	 *     does carry a `worktree.worktreePath` keyed by the child session id, but
	 *     it is written only inside the `isBackgroundTrue(...)` branch of
	 *     `delegation-gate.ts` (~line 3157) — i.e. only for `background: true` Task
	 *     dispatches. It is never written for the ordinary synchronous worktree
	 *     dispatch in `worktree-isolation.ts`, nor for the Lean Turbo dispatch in
	 *     `src/turbo/lean/lane-scope.ts`, which are the two actual
	 *     `recordSessionWorkspaceRoot` callers. It does not cover the field it
	 *     would need to validate.
	 *   - Re-deriving the expected path from `provisionWorktree`'s own naming
	 *     scheme (`resolveWorktreeBaseDir(directory, worktreeDir)/parentSessionId/taskId`,
	 *     or the `os.tmpdir()/swwt/...` Windows-shortened form) does not close the
	 *     gap either: it requires the child's *parent* session id, which is only
	 *     available from `delegationChains` in the very same untrusted snapshot —
	 *     validating one untrusted field with another untrusted field is circular,
	 *     not a validation. It would also require spawning `git worktree list` per
	 *     restored session inside `loadSnapshot`, which runs on the plugin-init
	 *     path under a bounded timeout (AGENTS.md invariant 1 / repro-704).
	 * Net effect: a plugin restart mid-lane loses the recorded root, and
	 * `resolveSessionWorkspaceDirectory` falls back to the plugin-root directory —
	 * fail-closed, byte-identical to pre-#2002 behaviour, never a widened
	 * authority (see its own doc comment). The lane coder is blocked with
	 * `SCOPE_NOT_DECLARED` (`src/hooks/scope-guard.ts`,
	 * `src/hooks/guardrails/tool-before.ts`) until a human/architect re-dispatches
	 * it, exactly like the pre-fix bug — not worse. `rehydrateState` (which would
	 * apply a restored value) only runs from `loadSnapshot`, itself only called at
	 * plugin init (`src/index.ts`), so this window is a real process restart, not
	 * something that can strip a live in-session lane coder of its root.
	 * Do NOT add this field to `TRANSIENT_SESSION_FIELDS`
	 * (`src/session/snapshot-reader.ts`) either — it is never restored in the
	 * first place, so there is nothing to reset.
	 */
	workspaceDirectory?: string;
	/** Last scope violation message (null = no violation) */
	lastScopeViolation: string | null;
	/** Flag for one-shot scope violation warning injection in messagesTransform */
	scopeViolationDetected?: boolean;
	/** Task-keyed files modified by coder work. Bounded by MAX_TRACKED_TASK_FILE_ATTRIBUTIONS. */
	modifiedFilesByTask: Map<string, string[]>;
	/**
	 * Compatibility projection for callers that still inspect the active task.
	 * Helpers in this module keep it synchronized only with `currentTaskId`.
	 */
	modifiedFilesThisCoderTask: string[];
	/** Bounded coder generations awaiting exact reviewer claims. */
	reviewerScopeGenerations?: Map<string, ReviewerScopeGeneration>;
	/** Monotonic per-session generation source; call identity remains authoritative. */
	reviewerScopeGenerationCounter?: number;
	/** Non-reused identity for this in-memory parent-session incarnation. */
	reviewerScopeIncarnation?: string;
	/** Latest generation token by task, retained through async validation. */
	reviewerScopeLatestGenerationByTask?: Map<
		string,
		ReviewerScopeGenerationIdentity
	>;
	/** Bounded recent background ownership retained after reviewer consumption. */
	reviewerScopeOwnershipHistory?: Map<string, ReviewerScopeOwnershipTombstone>;

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
	/** Whether Epic Mode (additive overlay above Lean Turbo) is active for
	 *  this session. Durable mirror lives in `.swarm/epic-state.json`; this
	 *  in-memory flag matches what `src/turbo/epic/state.ts` persists and is
	 *  what `hasActiveEpicMode(sessionID)` reads on the hot path. */
	epicModeActive?: boolean;

	// Auto-proceed session overrides (Phase 1)
	/** Session-scoped override for execution_profile.auto_proceed.
	 *  When set, overrides the plan's auto_proceed for this session.
	 *  true = auto-advance, false = do not auto-advance. Cleared on session reset. */
	autoProceedOverride?: boolean;
	/** Tracks whether the FR-004 nudge ("would you like to auto-advance?") has already been shown this session. */
	autoProceedNudgeDone?: boolean;

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
	/**
	 * Issue #2063 C2 — second, independent one-shot token for the PRM hard stop.
	 *
	 * `prmHardStopPending` is the DENY token: guardrails `toolBefore` consumes it
	 * by throwing the HARD STOP denial once. `prmHardStopInjectPending` is the
	 * INJECT token: `messagesTransform` consumes it by prepending the
	 * `[HARD STOP]` block into the next completion. They are deliberately
	 * separate because either consumer can run first, and a single shared flag
	 * meant whichever ran first disarmed the other — so the escalation was either
	 * denied without ever being explained, or explained without ever being
	 * denied.
	 *
	 * Optional: ~25 existing test/session literals enumerate the required PRM
	 * fields, and this one is additive.
	 */
	prmHardStopInjectPending?: boolean;
	// NOTE (issue #2063 C2, reviewer round-4 REQUIRED 3): there is deliberately
	// NO `prmHardStopDeliveredAt` field. A delivery timestamp was added here and
	// stamped at the deny site, but it had zero readers and was never serialized,
	// so it was write-only state on a hot, bounded session object. The
	// `prm_hard_stop_delivered` telemetry event — which already carries
	// sessionID, pattern, level, and count — is the delivery-observability
	// surface. Do not reintroduce the field without a reader.
	/** Per-session escalation tracker instance (set lazily by PRM hook) */
	prmEscalationTracker?: EscalationTracker;
	/** Cross-turn set of already-injected PRM advisory dedupe keys
	 *  (issue #1976 B1). The pushAdvisory helper only dedupes WITHIN a turn
	 *  (the drain clears pendingAdvisoryMessages each turn); this set suppresses
	 *  re-injecting the same pattern@level on subsequent tool calls until the
	 *  pattern's count advances escalation. Bounded by distinct (pattern, level)
	 *  pairs — at most (numPatterns × 3 levels). */
	prmInjectedAdvisoryKeys: Set<string>;

	/**
	 * Issue #2063 B3/B5 — whether an "execution episode" is currently armed for
	 * this session.
	 *
	 * An episode arms when the session actually attempts execution work (a `Task`
	 * dispatch to a mutating/verifying role, or an `update_task_status(...,
	 * in_progress)` that succeeds) and disarms on episode lapse. Consumers read
	 * it through {@link isExecutionEpisodeArmed} in
	 * `src/hooks/guardrails/execution-episode.ts` rather than touching the field,
	 * so the arming policy has exactly one owner.
	 *
	 * Deliberately reset on rehydrate (see `src/session/snapshot-reader.ts`): a
	 * stale `in_progress` task left over from a previous session must NOT arm a
	 * fresh one.
	 */
	executionEpisodeArmed?: boolean;

	// PR Monitor subscriptions (Phase 1)
	/** Active PR subscriptions for the background poller, keyed by `${repoFullName}::${prNumber}` */
	prSubscriptions: Map<string, PrSubscriptionState>;

	// Linked Knowledge (#1849)
	/**
	 * Cached canonical cohort id for this session's directory (issue #1849).
	 * Resolved once at `chat.message` (where sessionID + agent are reliably
	 * present) and reused by the system-enhancer's cohort-identity line and the
	 * PromotionEvidenceRecord writer — so neither re-runs `resolveCohortId`
	 * (which spawns git) on a per-turn / per-receipt hot path. Persisted through
	 * snapshots so restored sessions keep the value. `undefined` when not yet
	 * resolved (pre-existing sessions, restored old snapshots, or resolution
	 * failed); callers must handle the miss with a bounded fallback.
	 */
	cachedCohortId?: string;

	// Model divergence detection (#1896)
	/**
	 * The `provider/model` most recently OBSERVED on this (architect/primary)
	 * session's assistant turns (e.g. "anthropic/claude"). Persisted through
	 * snapshots and deliberately NOT reset on rehydration, so a silent model
	 * switch across an interrupt can be detected on resume by comparing the
	 * pre-interrupt observation with the first post-resume one. `undefined` until
	 * first observed.
	 */
	lastObservedModel?: string;
	/** Provider id paired with `lastObservedModel` (#1896). */
	lastObservedProviderID?: string;
	/** One-shot guard: the resume model-change advisory has fired for this rehydration (#1896). */
	resumeModelAdvisoryDone?: boolean;
	/** One-shot guard: the config-vs-UI model advisory has fired for this session (#1896). */
	configModelAdvisoryDone?: boolean;
}

export type NonTransientErrorCategory =
	| 'shell_parse_error'
	| 'command_not_found'
	| 'sandbox_wrapper_failure'
	| 'general_permanent';

export interface NonTransientCircuitState {
	ownerAgent: string;
	ownerInvocationId: number;
	category: NonTransientErrorCategory | null;
	sameCategoryCount: number;
	hardStop: boolean;
	lastSignal: string | null;
}

export interface PendingToolExecution {
	tool: string;
	originalCommand: string;
	sandboxWrapped: boolean;
	ownerAgent: string;
	ownerInvocationId: number;
}

function createNonTransientCircuitState(
	agentName: string,
	invocationId: number,
): NonTransientCircuitState {
	return {
		ownerAgent: stripKnownSwarmPrefix(agentName),
		ownerInvocationId: invocationId,
		category: null,
		sameCategoryCount: 0,
		hardStop: false,
		lastSignal: null,
	};
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
	curatorPostmortemAgentNames: [] as string[],
	curatorConsolidationAgentNames: [] as string[],

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

	/** v2: dedup set for ack records. Key = `${sessionId}|${id}|${result}`.
	 *  Prevents the chat.messages.transform path AND a knowledge_ack tool call
	 *  from double-counting the same ack within a session. FIFO-capped —
	 *  see addKnowledgeAckDedup. */
	knowledgeAckDedup: new Set<string>(),

	/** v2: per-session denial counter for the knowledge-application enforcement
	 *  gate's deadlock escape hatch (`knowledgeApplicationGateBefore`). Keyed by
	 *  sessionID; each entry also records the `directiveKey` (a sorted, joined
	 *  fingerprint of the critical-directive-id set the count was accumulated
	 *  against) so a session that has its critical directives swapped out from
	 *  under it — an ordinary occurrence on phase/task transitions via
	 *  `setCriticalShownIds` — does not carry a stale denial count into an
	 *  unrelated new directive's budget. FIFO-capped — see
	 *  incrementGateDenialCount/clearGateDenialCount. */
	gateDenialCounts: new Map<string, { count: number; directiveKey: string }>(),

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

	/**
	 * The DENOMINATOR `lastBudgetPct` was computed against, in tokens. Written
	 * by system-enhancer at the same two statements that write `lastBudgetPct`,
	 * because a percentage without its denominator cannot be turned back into a
	 * token estimate. `/swarm status` used to reconstruct the estimate from a
	 * hardcoded constant, so a user whose real denominator differed saw a token
	 * figure that did not match the percentage next to it. 0 means "no budget
	 * report has run yet".
	 */
	lastBudgetTokens: 0,

	/**
	 * Live `model.limit.context` per session — keyed by sessionID and bound to
	 * the reporting model/provider identity. Recorded by the
	 * `experimental.chat.system.transform` hook (the only hook the host
	 * gives a `Model` to) and read by the `experimental.chat.messages.transform`
	 * consumers, which receive messages but no model object. Bounded via
	 * {@link setLiveContextWindow} (AGENTS.md invariant 8).
	 */
	liveContextWindows: new Map<
		string,
		{ tokens?: number; modelID?: string; providerID?: string }
	>(),

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
	swarmState.lastBudgetTokens = 0;
	swarmState.liveContextWindows.clear();
	swarmState.agentSessions.clear();
	// Reset the opportunistic idle-sweep cooldown so a fresh process / test run
	// sweeps on first session activity (invariant 8: bounded global state with
	// an explicit reset path).
	_lastIdleSweepAtMs = 0;
	clearTrajectoryCache();
	clearTrajectoryStepCounters();
	swarmState.pendingRehydrations.clear();
	swarmState.opencodeClient = null;
	swarmState.curatorInitAgentNames = [];
	swarmState.curatorPhaseAgentNames = [];
	swarmState.curatorPostmortemAgentNames = [];
	swarmState.curatorConsolidationAgentNames = [];
	swarmState.skillImproverAgentNames = [];
	swarmState.specWriterAgentNames = [];
	swarmState.currentCriticalShownIds.clear();
	swarmState.knowledgeAckDedup.clear();
	swarmState.gateDenialCounts.clear();
	swarmState.generatedAgentNames = [];
	_rehydrationCache = null;
	// Full Auto Mode (Phase 4)
	swarmState.fullAutoEnabledInConfig = false;
	swarmState.environmentProfiles.clear();
	// v6.70.0 gap-closure (#496): clear the module-scoped pending coder-scope
	// map so a /swarm close + new session with a colliding taskId (e.g. "1.1")
	// cannot inherit stale scope from the previous swarm.
	clearPendingCoderScope();
	for (const binding of clearScopeBindings()) {
		clearScopeBindingFromDisk({
			directory: binding.workspaceIdentity,
			binding,
		});
	}
	resetStandardWorktreeIsolationState();
	resetRealtimeLearningNudgeState();
	// v6.71+ Clear the council-mode disagreement warn-once memo so tests and
	// fresh sessions observe consistent first-time warnings.
	_councilDisagreementWarned.clear();
	// Note: Session-scoped fields (architectWriteCount, gateLog, reviewerCallCount, lastGateFailure)
	// are cleared when agentSessions entries are deleted
}

/**
 * Reset swarm state while preserving the 8 module-scoped singletons that are
 * populated once at plugin init and must survive a /swarm close + re-init
 * within the same process lifetime.
 *
 * The preserved fields are:
 * - opencodeClient (SDK client for curator/full-auto delegation)
 * - fullAutoEnabledInConfig (config flag read at init)
 * - curatorInitAgentNames, curatorPhaseAgentNames, curatorPostmortemAgentNames,
 *   curatorConsolidationAgentNames (curator registry)
 * - skillImproverAgentNames, specWriterAgentNames (skill/spec registry)
 * - generatedAgentNames (full-auto delegation guard registry)
 *
 * Implementation: save all to locals, call resetSwarmState(), restore all.
 * Synchronous (matches resetSwarmState contract). Errors from resetSwarmState
 * propagate to caller (no try/catch wrapper).
 */
export function resetSwarmStatePreservingSingletons(): void {
	const preservedOpencodeClient = swarmState.opencodeClient;
	const preservedFullAutoEnabledInConfig = swarmState.fullAutoEnabledInConfig;
	const preservedCuratorInitAgentNames = swarmState.curatorInitAgentNames;
	const preservedCuratorPhaseAgentNames = swarmState.curatorPhaseAgentNames;
	const preservedCuratorPostmortemAgentNames =
		swarmState.curatorPostmortemAgentNames;
	const preservedCuratorConsolidationAgentNames =
		swarmState.curatorConsolidationAgentNames;
	const preservedSkillImproverAgentNames = swarmState.skillImproverAgentNames;
	const preservedSpecWriterAgentNames = swarmState.specWriterAgentNames;
	const preservedGeneratedAgentNames = swarmState.generatedAgentNames;

	resetSwarmState();

	swarmState.opencodeClient = preservedOpencodeClient;
	swarmState.fullAutoEnabledInConfig = preservedFullAutoEnabledInConfig;
	swarmState.curatorInitAgentNames = preservedCuratorInitAgentNames;
	swarmState.curatorPhaseAgentNames = preservedCuratorPhaseAgentNames;
	swarmState.curatorPostmortemAgentNames = preservedCuratorPostmortemAgentNames;
	swarmState.curatorConsolidationAgentNames =
		preservedCuratorConsolidationAgentNames;
	swarmState.skillImproverAgentNames = preservedSkillImproverAgentNames;
	swarmState.specWriterAgentNames = preservedSpecWriterAgentNames;
	swarmState.generatedAgentNames = preservedGeneratedAgentNames;
}

/**
 * Default idle-TTL (ms) after which a session with no tool activity is
 * considered stale and eligible for eviction (2 hours). Extracted to a single
 * constant so startAgentSession (eager eviction) and the opportunistic idle
 * sweep share one source of truth instead of duplicating the literal.
 */
const STALE_SESSION_TTL_MS = 7_200_000;

/** Match the Stage-B scope builder's hard file-count ceiling. */
export const MAX_REVIEWER_SCOPE_GENERATION_FILES = 256;
/** One parent session may retain at most this many parallel task generations. */
export const MAX_REVIEWER_SCOPE_GENERATIONS = 256;
/** Recent consumed owners are bounded to the maximum parallel generation set. */
export const MAX_REVIEWER_SCOPE_OWNERSHIP_HISTORY = 256;
/** Generation expiry never exceeds the parent session's normal idle TTL. */
export const REVIEWER_SCOPE_GENERATION_TTL_MS = STALE_SESSION_TTL_MS;

function isBoundedGenerationValue(value: string, maxLength: number): boolean {
	return (
		value.length > 0 &&
		value.length <= maxLength &&
		!Array.from(value).some((char) => {
			const code = char.charCodeAt(0);
			return code <= 0x1f || code === 0x7f;
		})
	);
}

function reviewerScopeGenerationKey(
	taskId: string,
	coderCallID: string,
	generation: number,
): string {
	return `${taskId}\0${coderCallID}\0${generation}`;
}

function reviewerScopeOwnershipKey(
	taskId: string,
	coderCallID: string,
	generation: number,
	sessionIncarnation: string,
): string {
	return `${taskId}\0${coderCallID}\0${generation}\0${sessionIncarnation}`;
}

function ensureReviewerScopeGenerationState(session: AgentSessionState): {
	generations: Map<string, ReviewerScopeGeneration>;
	counter: number;
	incarnation: string;
	latestByTask: Map<string, ReviewerScopeGenerationIdentity>;
	ownershipHistory: Map<string, ReviewerScopeOwnershipTombstone>;
} {
	session.reviewerScopeGenerations ??= new Map();
	session.reviewerScopeGenerationCounter ??= 0;
	session.reviewerScopeIncarnation ??= randomUUID();
	session.reviewerScopeLatestGenerationByTask ??= new Map();
	session.reviewerScopeOwnershipHistory ??= new Map();
	return {
		generations: session.reviewerScopeGenerations,
		counter: session.reviewerScopeGenerationCounter,
		incarnation: session.reviewerScopeIncarnation,
		latestByTask: session.reviewerScopeLatestGenerationByTask,
		ownershipHistory: session.reviewerScopeOwnershipHistory,
	};
}

function sweepReviewerScopeGenerations(
	session: AgentSessionState,
	now: number,
): void {
	const { generations } = ensureReviewerScopeGenerationState(session);
	for (const [key, entry] of generations) {
		// Claimed state is correlated to a durable reviewer delegation. Its
		// terminal/error/stale lifecycle owns cleanup; an unrelated in-memory
		// clock sweep must never invalidate a reviewer that is still running.
		if (entry.status === 'claimed') continue;
		if (
			!Number.isFinite(entry.createdAt) ||
			now < entry.createdAt ||
			now - entry.createdAt > REVIEWER_SCOPE_GENERATION_TTL_MS
		) {
			generations.delete(key);
		}
	}
}

/** Begin one exact coder generation after the full blocking before-chain passes. */
export function startReviewerScopeGeneration(input: {
	parentSessionID: string;
	taskId: string;
	coderCallID: string;
	background?: boolean;
	declaredFiles?: string[];
	createdAt?: number;
}): ReviewerScopeGeneration | null {
	const session = swarmState.agentSessions.get(input.parentSessionID);
	if (
		!session ||
		!isBoundedGenerationValue(input.taskId, 512) ||
		!isBoundedGenerationValue(input.coderCallID, 512)
	) {
		return null;
	}
	const now = input.createdAt ?? Date.now();
	sweepReviewerScopeGenerations(session, now);
	const { generations, counter, incarnation, latestByTask } =
		ensureReviewerScopeGenerationState(session);
	// A new coder call for the same task supersedes only older unclaimed
	// generations. Claimed generations remain bound to their already-approved
	// reviewer calls while the new coder generation proceeds independently.
	for (const [key, entry] of generations) {
		if (entry.taskId === input.taskId && entry.status !== 'claimed') {
			generations.delete(key);
		}
	}
	while (generations.size >= MAX_REVIEWER_SCOPE_GENERATIONS) {
		const oldestUnclaimed = [...generations.entries()].find(
			([, entry]) => entry.status !== 'claimed',
		)?.[0];
		if (!oldestUnclaimed) return null;
		generations.delete(oldestUnclaimed);
	}
	session.reviewerScopeGenerationCounter =
		counter >= Number.MAX_SAFE_INTEGER ? 1 : counter + 1;
	const generation: ReviewerScopeGeneration = {
		taskId: input.taskId,
		coderCallID: input.coderCallID,
		generation: session.reviewerScopeGenerationCounter,
		sessionIncarnation: incarnation,
		background: input.background === true,
		declaredFiles: [...new Set(input.declaredFiles ?? [])],
		modifiedFiles: [],
		modifiedFileFingerprints: [],
		status: 'collecting',
		createdAt: now,
	};
	if (!latestByTask.has(generation.taskId)) {
		while (latestByTask.size >= MAX_REVIEWER_SCOPE_GENERATIONS) {
			const oldestTask = latestByTask.keys().next().value as string | undefined;
			if (!oldestTask) break;
			latestByTask.delete(oldestTask);
		}
	}
	latestByTask.delete(generation.taskId);
	latestByTask.set(generation.taskId, {
		generation: generation.generation,
		coderCallID: generation.coderCallID,
		sessionIncarnation: generation.sessionIncarnation,
	});
	const key = reviewerScopeGenerationKey(
		generation.taskId,
		generation.coderCallID,
		generation.generation,
	);
	generations.set(key, generation);
	return cloneReviewerScopeGeneration(generation);
}

/** Route one child-observed write to its exact parent/task/coder generation. */
export function recordReviewerScopeGenerationFile(input: {
	parentSessionID: string;
	taskId: string;
	coderCallID: string;
	file: string;
	now?: number;
}): boolean {
	const session = swarmState.agentSessions.get(input.parentSessionID);
	if (
		!session ||
		!isBoundedGenerationValue(input.file, 4_096) ||
		!isBoundedGenerationValue(input.taskId, 512) ||
		!isBoundedGenerationValue(input.coderCallID, 512)
	) {
		return false;
	}
	sweepReviewerScopeGenerations(session, input.now ?? Date.now());
	const { generations } = ensureReviewerScopeGenerationState(session);
	const matches = [...generations.values()].filter(
		(entry) =>
			entry.taskId === input.taskId &&
			entry.coderCallID === input.coderCallID &&
			entry.status === 'collecting',
	);
	if (matches.length !== 1) return false;
	const generation = matches[0];
	if (generation.modifiedFiles.includes(input.file)) return true;
	if (generation.modifiedFiles.length >= MAX_REVIEWER_SCOPE_GENERATION_FILES) {
		const key = reviewerScopeGenerationKey(
			generation.taskId,
			generation.coderCallID,
			generation.generation,
		);
		generations.delete(key);
		return false;
	}
	generation.modifiedFiles.push(input.file);
	return true;
}

/**
 * Record the bounded post-write state only after a guarded child write returns
 * successfully. Pre-write routing in modifiedFiles remains authorization metadata.
 */
export function recordReviewerScopeGenerationFileFingerprint(input: {
	parentSessionID: string;
	taskId: string;
	coderCallID: string;
	fingerprint: import('./hooks/reviewer-scope-file-fingerprint.js').ReviewerScopeFileFingerprint;
}): boolean {
	const session = swarmState.agentSessions.get(input.parentSessionID);
	if (!session) return false;
	const { generations } = ensureReviewerScopeGenerationState(session);
	const matches = [...generations.values()].filter(
		(entry) =>
			entry.taskId === input.taskId &&
			entry.coderCallID === input.coderCallID &&
			entry.status === 'collecting',
	);
	if (matches.length !== 1) return false;
	const generation = matches[0];
	if (!generation.modifiedFiles.includes(input.fingerprint.file)) return false;
	const existingIndex = generation.modifiedFileFingerprints.findIndex(
		(entry) => entry.file === input.fingerprint.file,
	);
	if (existingIndex >= 0) {
		generation.modifiedFileFingerprints[existingIndex] = {
			...input.fingerprint,
		};
		return true;
	}
	if (
		generation.modifiedFileFingerprints.length >=
		MAX_REVIEWER_SCOPE_GENERATION_FILES
	) {
		return false;
	}
	generation.modifiedFileFingerprints.push({ ...input.fingerprint });
	return true;
}

/** Mark the exact coder call terminal; background running placeholders do not call this. */
export function markReviewerScopeGenerationReady(input: {
	parentSessionID: string;
	taskId: string;
	coderCallID: string;
	readyAt?: number;
}): boolean {
	const session = swarmState.agentSessions.get(input.parentSessionID);
	if (!session) return false;
	const now = input.readyAt ?? Date.now();
	sweepReviewerScopeGenerations(session, now);
	const { generations } = ensureReviewerScopeGenerationState(session);
	const matches = [...generations.values()].filter(
		(entry) =>
			entry.taskId === input.taskId &&
			entry.coderCallID === input.coderCallID &&
			(entry.status === 'collecting' || entry.status === 'ready'),
	);
	if (matches.length !== 1) return false;
	if (matches[0].status === 'ready') return true;
	matches[0].status = 'ready';
	matches[0].readyAt = now;
	return true;
}

/** Read one exact coder generation for terminal guardrail/evidence checks. */
export function getReviewerScopeGenerationForCoderCall(input: {
	parentSessionID: string;
	taskId?: string;
	coderCallID: string;
	now?: number;
}): ReviewerScopeGeneration | null {
	const session = swarmState.agentSessions.get(input.parentSessionID);
	if (!session) return null;
	sweepReviewerScopeGenerations(session, input.now ?? Date.now());
	const { generations } = ensureReviewerScopeGenerationState(session);
	const matches = [...generations.values()].filter(
		(entry) =>
			entry.coderCallID === input.coderCallID &&
			(input.taskId === undefined || entry.taskId === input.taskId),
	);
	return matches.length === 1 ? cloneReviewerScopeGeneration(matches[0]) : null;
}

/** Inspect the only ready generation for a task without claiming it. */
export function peekReadyReviewerScopeGeneration(input: {
	parentSessionID: string;
	taskId: string;
	now?: number;
}): ReviewerScopeGeneration | null {
	const session = swarmState.agentSessions.get(input.parentSessionID);
	if (!session) return null;
	sweepReviewerScopeGenerations(session, input.now ?? Date.now());
	const { generations } = ensureReviewerScopeGenerationState(session);
	const matches = [...generations.values()].filter(
		(entry) => entry.taskId === input.taskId && entry.status === 'ready',
	);
	return matches.length === 1 ? cloneReviewerScopeGeneration(matches[0]) : null;
}

/**
 * Claim the only ready generation for an exact task after every blocking
 * reviewer before-hook has passed. Ambiguity fails closed to no receipt.
 */
export function claimReviewerScopeGeneration(input: {
	parentSessionID: string;
	taskId: string;
	reviewerCallID: string;
	now?: number;
}): ReviewerScopeGeneration | null {
	const session = swarmState.agentSessions.get(input.parentSessionID);
	if (
		!session ||
		!isBoundedGenerationValue(input.taskId, 512) ||
		!isBoundedGenerationValue(input.reviewerCallID, 512)
	) {
		return null;
	}
	sweepReviewerScopeGenerations(session, input.now ?? Date.now());
	const { generations } = ensureReviewerScopeGenerationState(session);
	const matches = [...generations.values()].filter(
		(entry) => entry.taskId === input.taskId && entry.status === 'ready',
	);
	if (matches.length !== 1) return null;
	matches[0].status = 'claimed';
	matches[0].reviewerCallID = input.reviewerCallID;
	return cloneReviewerScopeGeneration(matches[0]);
}

/** Bind the immutable scope captured immediately before the reviewer Task dispatch. */
export function attachReviewerScopeGenerationDispatchSnapshot(input: {
	parentSessionID: string;
	taskId: string;
	reviewerCallID: string;
	snapshot: ReviewerScopeDispatchSnapshot;
}): boolean {
	const session = swarmState.agentSessions.get(input.parentSessionID);
	if (!session) return false;
	const { generations } = ensureReviewerScopeGenerationState(session);
	const matches = [...generations.values()].filter(
		(entry) =>
			entry.taskId === input.taskId &&
			entry.reviewerCallID === input.reviewerCallID &&
			entry.status === 'claimed' &&
			entry.coderCallID === input.snapshot.coderCallID &&
			entry.generation === input.snapshot.generation &&
			entry.sessionIncarnation === input.snapshot.sessionIncarnation,
	);
	if (matches.length !== 1) return false;
	matches[0].reviewerDispatchScope = {
		...input.snapshot,
		files: [...input.snapshot.files],
	};
	return true;
}

/** Terminal one-shot consumption by exact task and reviewer Task call. */
export function takeReviewerScopeGeneration(input: {
	parentSessionID: string;
	taskId: string;
	reviewerCallID: string;
	now?: number;
}): ReviewerScopeGeneration | null {
	const session = swarmState.agentSessions.get(input.parentSessionID);
	if (!session) return null;
	sweepReviewerScopeGenerations(session, input.now ?? Date.now());
	const { generations } = ensureReviewerScopeGenerationState(session);
	const matches = [...generations.entries()].filter(
		([, entry]) =>
			entry.taskId === input.taskId &&
			entry.reviewerCallID === input.reviewerCallID &&
			entry.status === 'claimed',
	);
	if (matches.length !== 1) return null;
	const [key, generation] = matches[0];
	if (
		generation.background === true &&
		generation.readyAt !== undefined &&
		Number.isFinite(generation.createdAt) &&
		Number.isFinite(generation.readyAt)
	) {
		const { ownershipHistory } = ensureReviewerScopeGenerationState(session);
		while (ownershipHistory.size >= MAX_REVIEWER_SCOPE_OWNERSHIP_HISTORY) {
			const oldestKey = ownershipHistory.keys().next().value as
				| string
				| undefined;
			if (!oldestKey) break;
			ownershipHistory.delete(oldestKey);
		}
		const tombstone: ReviewerScopeOwnershipTombstone = {
			parentSessionID: input.parentSessionID,
			taskId: generation.taskId,
			coderCallID: generation.coderCallID,
			generation: generation.generation,
			sessionIncarnation: generation.sessionIncarnation,
			background: true,
			declaredFiles: [...generation.declaredFiles],
			modifiedFiles: [...generation.modifiedFiles],
			modifiedFileFingerprints: generation.modifiedFileFingerprints.map(
				(fingerprint) => ({ ...fingerprint }),
			),
			createdAt: generation.createdAt,
			readyAt: generation.readyAt,
			consumedAt: input.now ?? Date.now(),
		};
		ownershipHistory.set(
			reviewerScopeOwnershipKey(
				tombstone.taskId,
				tombstone.coderCallID,
				tombstone.generation,
				tombstone.sessionIncarnation,
			),
			tombstone,
		);
	}
	generations.delete(key);
	return cloneReviewerScopeGeneration(generation);
}

/** Read bounded immutable ownership history for delayed background ingestion. */
export function getReviewerScopeOwnershipHistory(input: {
	parentSessionID: string;
}): ReviewerScopeOwnershipTombstone[] {
	const session = swarmState.agentSessions.get(input.parentSessionID);
	if (!session) return [];
	const { ownershipHistory } = ensureReviewerScopeGenerationState(session);
	return [...ownershipHistory.values()].map(
		cloneReviewerScopeOwnershipTombstone,
	);
}

/** Inspect one exact reviewer claim without consuming retryable state. */
export function peekReviewerScopeGenerationClaim(input: {
	parentSessionID: string;
	taskId: string;
	reviewerCallID: string;
	now?: number;
}): ReviewerScopeGeneration | null {
	const session = swarmState.agentSessions.get(input.parentSessionID);
	if (!session) return null;
	sweepReviewerScopeGenerations(session, input.now ?? Date.now());
	const { generations } = ensureReviewerScopeGenerationState(session);
	const matches = [...generations.values()].filter(
		(entry) =>
			entry.taskId === input.taskId &&
			entry.reviewerCallID === input.reviewerCallID &&
			entry.status === 'claimed',
	);
	return matches.length === 1 ? cloneReviewerScopeGeneration(matches[0]) : null;
}

/** Clear one exact terminal/stale reviewer claim without touching parallel tasks. */
export function discardReviewerScopeGenerationClaim(input: {
	parentSessionID: string;
	taskId?: string;
	reviewerCallID: string;
}): boolean {
	const session = swarmState.agentSessions.get(input.parentSessionID);
	if (!session) return false;
	const { generations } = ensureReviewerScopeGenerationState(session);
	const matches = [...generations.entries()].filter(
		([, entry]) =>
			(input.taskId === undefined || entry.taskId === input.taskId) &&
			entry.reviewerCallID === input.reviewerCallID &&
			entry.status === 'claimed',
	);
	if (matches.length !== 1) return false;
	generations.delete(matches[0][0]);
	return true;
}

/**
 * Detect a concurrently collecting coder generation whose declaration overlaps
 * this exact coder call. Shared declared paths cannot be attributed safely from
 * one workspace snapshot, even when child write routing observed both calls.
 */
export function reviewerScopeGenerationHasDeclaredOverlap(input: {
	parentSessionID: string;
	taskId: string;
	coderCallID: string;
	declaredFiles: string[];
}): boolean {
	const session = swarmState.agentSessions.get(input.parentSessionID);
	if (!session) return false;
	const { generations } = ensureReviewerScopeGenerationState(session);
	const declared = new Set(input.declaredFiles);
	return [...generations.values()].some(
		(entry) =>
			entry.status === 'collecting' &&
			(entry.taskId !== input.taskId ||
				entry.coderCallID !== input.coderCallID) &&
			entry.declaredFiles.some((file) => declared.has(file)),
	);
}

/** Clear one exact collecting/ready coder generation on terminal error/stale. */
export function discardReviewerScopeGenerationForCoderCall(input: {
	parentSessionID: string;
	taskId?: string;
	coderCallID: string;
}): boolean {
	const session = swarmState.agentSessions.get(input.parentSessionID);
	if (!session) return false;
	const { generations } = ensureReviewerScopeGenerationState(session);
	const matches = [...generations.entries()].filter(
		([, entry]) =>
			(input.taskId === undefined || entry.taskId === input.taskId) &&
			entry.coderCallID === input.coderCallID &&
			entry.status !== 'claimed',
	);
	if (matches.length !== 1) return false;
	generations.delete(matches[0][0]);
	return true;
}

/** Validate an async result against the latest coder generation for its task. */
export function isReviewerScopeGenerationCurrent(input: {
	parentSessionID: string;
	taskId: string;
	coderCallID: string;
	generation: number;
	sessionIncarnation: string;
}): boolean {
	const session = swarmState.agentSessions.get(input.parentSessionID);
	if (!session) return false;
	const { incarnation, latestByTask } =
		ensureReviewerScopeGenerationState(session);
	const latest = latestByTask.get(input.taskId);
	return (
		incarnation === input.sessionIncarnation &&
		latest?.generation === input.generation &&
		latest.coderCallID === input.coderCallID &&
		latest.sessionIncarnation === input.sessionIncarnation
	);
}

/**
 * Minimum interval (ms) between opportunistic idle sweeps triggered from the
 * per-tool-call hot path. Bounds the O(n) stale scan to at most once per
 * window so per-tool-call accounting stays effectively O(1) in the common
 * case while still reclaiming idle session state on a long-lived host.
 */
const IDLE_SWEEP_COOLDOWN_MS = 60_000;

/**
 * Cooldown timestamp (ms epoch) of the most recent opportunistic idle sweep.
 * Module-level state, but bounded by IDLE_SWEEP_COOLDOWN_MS and reset to 0 by
 * resetSwarmState so a fresh process / test sweeps on first activity
 * (invariant 8: keyed/bounded global state with an explicit reset path).
 */
let _lastIdleSweepAtMs = 0;

/**
 * Evict every agent session whose last tool activity is older than
 * staleDurationMs, and drop the delegation chain keyed by that same sessionID
 * (delegationChains is keyed by sessionID — see delegation-tracker.ts, which
 * does `delegationChains.set(input.sessionID, ...)`). This is the single
 * eviction loop reused by BOTH startAgentSession (eager, on new session start)
 * and maybeSweepStaleSessions (opportunistic, on the hot path) so the logic is
 * never duplicated.
 *
 * @param staleDurationMs - Age threshold in ms (default 2h)
 * @param now - Current time in ms (injectable for deterministic tests)
 * @returns The list of evicted session IDs
 */
export function sweepStaleSessions(
	staleDurationMs = STALE_SESSION_TTL_MS,
	now = Date.now(),
): string[] {
	// Preserve the original strict-greater-than comparison so the existing
	// eager-eviction behavior and tests are byte-for-byte unchanged.
	const staleIds: string[] = [];
	for (const [id, session] of swarmState.agentSessions) {
		if (now - session.lastToolCallTime > staleDurationMs) {
			staleIds.push(id);
		}
	}
	for (const id of staleIds) {
		swarmState.agentSessions.delete(id);
		// delegationChains is keyed by sessionID; the evicted session's chain is
		// now unreachable, so drop it in the same pass to reclaim its memory.
		swarmState.delegationChains.delete(id);
	}
	return staleIds;
}

/**
 * Opportunistic, cooldown-guarded wrapper around sweepStaleSessions, intended
 * to be called from a frequently-hit code path (per-tool-call accounting in
 * ensureAgentSession). This reclaims accumulated session state even when no
 * new session is ever started — closing the gap where eager eviction only ran
 * inside startAgentSession, so a long-lived host that stopped creating
 * sessions never reclaimed old ones.
 *
 * Bounded work (invariant 8): the O(n) scan runs at most once per
 * IDLE_SWEEP_COOLDOWN_MS. The cooldown timestamp advances whenever the cooldown
 * has elapsed — even when zero sessions are evicted — so an idle/empty map does
 * not re-scan on every call.
 *
 * No timers, no init-path work (invariant 1): this only runs when a hook
 * actively calls it on the hot path; it never schedules background work.
 *
 * @param staleDurationMs - Age threshold in ms (default 2h)
 * @param now - Current time in ms (injectable for deterministic tests)
 * @returns Evicted session IDs ([] when the cooldown blocks this run)
 */
export function maybeSweepStaleSessions(
	staleDurationMs = STALE_SESSION_TTL_MS,
	now = Date.now(),
): string[] {
	if (now - _lastIdleSweepAtMs < IDLE_SWEEP_COOLDOWN_MS) {
		return [];
	}
	_lastIdleSweepAtMs = now;
	return sweepStaleSessions(staleDurationMs, now);
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
	staleDurationMs = STALE_SESSION_TTL_MS,
	directory?: string,
): void {
	const now = Date.now();

	// Evict stale sessions based on last activity, not start time.
	// Default: 2 hours — should exceed typical agent durations (evicts inactive
	// sessions). Reuses the shared eviction loop (also used by the opportunistic
	// idle sweep) so the logic stays single-sourced.
	sweepStaleSessions(staleDurationMs, now);

	// Create new session state
	const sessionState: AgentSessionState = {
		agentName,
		lastToolCallTime: now,
		lastAgentEventTime: now,
		delegationActive: false,
		activeInvocationId: 0,
		lastInvocationIdByAgent: {},
		windows: {},
		nonTransientCircuit: createNonTransientCircuitState(agentName, 0),
		pendingToolExecutions: new Map(),
		lastCompactionHint: 0,
		// v6.12 Anti-Process-Violation Detection
		architectWriteCount: 0,
		lastCoderDelegationTaskId: null,
		currentTaskId: null,
		gateLog: new Map(),
		reviewerCallCount: new Map(),
		lastGateFailure: null,
		partialGateWarningsIssuedForTask: new Set(),
		completionGateWarnedForTask: new Set(),
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
		modifiedFilesByTask: new Map(),
		modifiedFilesThisCoderTask: [],
		reviewerScopeGenerations: new Map(),
		reviewerScopeGenerationCounter: 0,
		reviewerScopeIncarnation: randomUUID(),
		reviewerScopeLatestGenerationByTask: new Map(),
		reviewerScopeOwnershipHistory: new Map(),
		// Turbo Mode (v6.26)
		turboMode: false,
		// Lean Turbo Mode (Phase 2)
		turboStrategy: undefined,
		leanTurboActive: false,
		leanTurboCurrentPhase: undefined,
		maxConcurrencyOverride: undefined,
		// Epic Mode (additive overlay above Lean Turbo)
		epicModeActive: false,
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
		// Issue #2063 C2: the inject token is independent of the deny token
		// above; both start disarmed and are re-armed together by the PRM
		// producer on every level-3 detection.
		prmHardStopInjectPending: false,
		prmInjectedAdvisoryKeys: new Set(),
		// Issue #2063 B3/B5: no execution episode until this session actually
		// attempts execution work.
		executionEpisodeArmed: false,
		// PR Monitor subscriptions
		prSubscriptions: new Map<string, PrSubscriptionState>(),
	};

	swarmState.agentSessions.set(sessionId, sessionState);

	// Persist session start timestamp for cross-process session-scoping (#444 item 9).
	// Best-effort — fail-open if disk write fails.
	if (directory) {
		try {
			recordSessionStart(directory, now);
		} catch {
			// non-fatal — fail-open
		}
		// Advisory: if this repo has multiple worktrees and this one is unlinked,
		// suggest `/swarm link`. Deferred off the init critical path and never
		// awaited (Invariant 1); fully fail-open internally.
		queueMicrotask(() => {
			void maybeSuggestWorktreeLink(directory, sessionId);
		});
	}

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
			.then(async () => {
				// Rehydrate PR subscriptions for this session (fail-open).
				try {
					sessionState.prSubscriptions = await rehydratePrSubscriptions(
						sessionId,
						directory,
					);
				} catch (err) {
					logger.warn(
						'[state] PR subscription rehydration failed, starting with empty subscriptions:',
						err instanceof Error ? err.message : String(err),
					);
				}
			})
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
 * Called at session terminal state transitions (task completion, error, or session
 * teardown) to prevent unbounded Map growth. Double-calls are safe: Map.delete is
 * a no-op for missing keys (FR-010).
 * @param sessionId - The session identifier to remove
 */
export function endAgentSession(sessionId: string): void {
	const removedBindings = clearScopeBindings(
		(binding) =>
			binding.ownerSessionId === sessionId ||
			binding.parentOwnerSessionId === sessionId,
	);
	for (const binding of removedBindings) {
		clearScopeBindingFromDisk({
			directory: binding.workspaceIdentity,
			binding,
		});
	}
	swarmState.agentSessions.delete(sessionId);
	clearRealtimeLearningNudgeSession(sessionId);
	// #1821: the same-session learning loop keeps per-session module state (the
	// candidate queue and the PRM pattern-support/cooldown ledger). Both are
	// already bounded by a 500-key FIFO, but releasing them at session end is
	// what keeps that bound from being load-bearing — and it mirrors the
	// nudge cleanup directly above (invariant 8).
	resetSessionQueue(sessionId);
	resetPrmPatternSupport(sessionId);
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
			session.nonTransientCircuit = createNonTransientCircuitState(
				agentName,
				0,
			);

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
		if (session.nonTransientCircuit === undefined) {
			session.nonTransientCircuit = createNonTransientCircuitState(
				session.agentName,
				session.activeInvocationId ?? 0,
			);
		}
		if (session.pendingToolExecutions === undefined) {
			session.pendingToolExecutions = new Map();
		}

		// FR-009: The `=== undefined` migration guards below are intentional
		// forward-compatibility checks. The `undefined` value carries different semantics
		// from an explicit default. Do not replace with default-value coalescing.
		// See .swarm/spec.md FR-009.
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
		if (!session.completionGateWarnedForTask) {
			session.completionGateWarnedForTask = new Set();
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
		if (!(session.modifiedFilesByTask instanceof Map)) {
			session.modifiedFilesByTask = new Map();
			if (
				isValidTaskId(session.currentTaskId) &&
				Array.isArray(session.modifiedFilesThisCoderTask) &&
				session.modifiedFilesThisCoderTask.length > 0
			) {
				session.modifiedFilesByTask.set(session.currentTaskId!, [
					...new Set(session.modifiedFilesThisCoderTask),
				]);
			}
		}
		// modifiedFilesThisCoderTask is a derived compatibility view of the
		// authoritative modifiedFilesByTask map. Re-project on every
		// ensureAgentSession call so direct mutation/reassignment is discarded.
		projectModifiedFilesForActiveTask(session);
		if (!session.reviewerScopeGenerations) {
			session.reviewerScopeGenerations = new Map();
		}
		if (session.reviewerScopeGenerationCounter === undefined) {
			session.reviewerScopeGenerationCounter = 0;
		}
		if (!session.reviewerScopeIncarnation) {
			session.reviewerScopeIncarnation = randomUUID();
		}
		if (!session.reviewerScopeLatestGenerationByTask) {
			session.reviewerScopeLatestGenerationByTask = new Map();
		}
		if (!session.reviewerScopeOwnershipHistory) {
			session.reviewerScopeOwnershipHistory = new Map();
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
		// Epic Mode migration safety
		if (session.epicModeActive === undefined) {
			session.epicModeActive = false;
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
		if (session.prmHardStopInjectPending === undefined) {
			session.prmHardStopInjectPending = false;
		}
		if (!session.prmInjectedAdvisoryKeys) {
			session.prmInjectedAdvisoryKeys = new Set();
		}
		if (session.executionEpisodeArmed === undefined) {
			session.executionEpisodeArmed = false;
		}
		// PR Monitor subscriptions migration safety
		if (!session.prSubscriptions) {
			session.prSubscriptions = new Map<string, PrSubscriptionState>();
		}

		session.lastToolCallTime = now;
		// Opportunistic idle-TTL sweep (cooldown-guarded) on the per-tool-call
		// hot path. Reclaims stale SIBLING sessions even when this long-lived
		// host has stopped starting new sessions — independent of
		// startAgentSession. The session just refreshed above (lastToolCallTime
		// = now) is never its own victim, so there is no cross-session
		// pollution.
		maybeSweepStaleSessions();
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
 * Issue #2002 — record the root a session actually EXECUTES in, when it
 * differs from the plugin-root `ctx.directory`.
 *
 * TRUST BOUNDARY (security-critical): this function performs NO path
 * validation. `laneRoot` is trusted purely because of WHO calls it, not
 * because of its shape — `provisionWorktree` can legitimately relocate a lane
 * outside the swarm worktree base (e.g. a `os.tmpdir()`-shortened path on
 * Windows when the path-budget check trips), so a shape predicate would
 * refuse a legitimately provisioned lane and silently reintroduce the bug
 * this closes.
 *
 * The only thing standing between this setter and a privilege-escalation bug
 * is a closed allowlist of production callers, each of which passes
 * `provisionWorktree`'s own return value — never a tool argument, never
 * `ensureAgentSession`'s `directory` parameter (which CAN carry an
 * agent-supplied `working_directory`, e.g. via `declare_scope`). That
 * allowlist is mechanically enforced by
 * `tests/unit/state/session-workspace-root-trusted-callers.test.ts`. Adding a
 * new call site is a privilege-escalation review, not a formality: the
 * reviewer must confirm the new caller passes `provisionWorktree` output
 * before adding it to that test's allowlist.
 *
 * A blank or whitespace-only `laneRoot` is ignored (treated as unset) rather
 * than being recorded and later resolving to `path.resolve('')` (cwd).
 *
 * ORDERING IS PART OF THE CONTRACT. This never creates the session — callers
 * MUST register it with its real agent name (`ensureAgentSession(sessionId,
 * 'coder', laneRoot)`) FIRST. Calling this on an unregistered session is a
 * deliberate no-op, so resolution falls back to the plugin root and the write
 * is blocked. Creating the session here instead would register
 * `swarmState.activeAgent` as 'unknown', which fails OPEN rather than closed —
 * see the inline comment in the body for the full chain.
 *
 * @param sessionId - The session identifier
 * @param laneRoot - `provisionWorktree`'s own output; never agent-supplied
 */
export function recordSessionWorkspaceRoot(
	sessionId: string,
	laneRoot: string,
): void {
	const trimmed = laneRoot.trim();
	if (!trimmed) return;
	// MUST NOT create the session. `ensureAgentSession(sessionId)` with no agent
	// name routes to `startAgentSession(..., 'unknown', ...)`, which sets
	// `swarmState.activeAgent` to 'unknown' — and a later
	// `ensureAgentSession(id, 'coder', dir)` updates `session.agentName` but
	// never repairs `activeAgent`. That would FAIL OPEN, not closed: 'unknown'
	// is truthy, so it passes the no-active-agent guards in
	// `src/hooks/guardrails/tool-before.ts`, then lands in the `noScopeLenient`
	// branch that skips the authority check for non-coder/non-architect roles,
	// while `src/hooks/scope-guard.ts` returns early because the role is not
	// 'coder'. A lane child's shell write would execute unenforced.
	//
	// Callers therefore register the session (with its real agent name) FIRST.
	// If they have not, this is a no-op and resolution falls back to the plugin
	// root — the fail-closed outcome.
	const session = swarmState.agentSessions.get(sessionId);
	if (!session) return;
	session.workspaceDirectory = trimmed;
}

/**
 * Issue #2002 — resolve the root a write gate should evaluate path
 * containment and scope-binding lookups against for a given session.
 *
 * Fail-closed: returns `fallbackDirectory` (the plugin-root `ctx.directory`)
 * whenever no root was recorded for this session, or the recorded value is
 * blank/unset — i.e. byte-identical to pre-#2002 behaviour for every session
 * that was never lane-rooted.
 *
 * @param sessionId - The session identifier
 * @param fallbackDirectory - The plugin-root directory to fall back to
 * @returns the session's recorded workspace root, or `fallbackDirectory`
 */
export function resolveSessionWorkspaceDirectory(
	sessionId: string,
	fallbackDirectory: string,
): string {
	const session = swarmState.agentSessions.get(sessionId);
	const recorded = session?.workspaceDirectory;
	if (recorded?.trim()) return recorded;
	return fallbackDirectory;
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
 * Returns null for architect (unlimited, no budget window), while still
 * advancing the invocation identity and clearing invocation-local safety state.
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

	const stripped = stripKnownSwarmPrefix(agentName);

	// Advance every agent's invocation identity. Architects do not receive a
	// budget window, but non-transient STOP state and before/after correlation
	// must never leak into a corrected follow-up turn.
	const lastId = session.lastInvocationIdByAgent[stripped] || 0;
	const newId = lastId + 1;
	session.lastInvocationIdByAgent[stripped] = newId;
	session.activeInvocationId = newId;
	session.nonTransientCircuit = createNonTransientCircuitState(stripped, newId);
	// Keep bounded correlation records from the prior invocation so a late
	// tool-after result can be identified and ignored instead of poisoning this
	// fresh circuit. Entries are consumed on return or evicted at the map cap.

	// Architect never creates budget windows (unlimited).
	if (stripped === ORCHESTRATOR_NAME) {
		return null;
	}

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

function ensureModifiedFilesByTask(
	session: AgentSessionState,
): Map<string, string[]> {
	if (!(session.modifiedFilesByTask instanceof Map)) {
		session.modifiedFilesByTask = new Map();
	}
	return session.modifiedFilesByTask;
}

function projectModifiedFilesForActiveTask(session: AgentSessionState): void {
	const taskId = session.currentTaskId;
	session.modifiedFilesThisCoderTask =
		isValidTaskId(taskId) && session.modifiedFilesByTask instanceof Map
			? [...(session.modifiedFilesByTask.get(taskId!) ?? [])]
			: [];
}

/**
 * Ensure an attribution slot exists without evicting live task data.
 * Completed entries are reclaimed oldest-first (Map insertion order).
 */
function ensureModifiedFileTaskSlot(
	session: AgentSessionState,
	taskId: string,
): boolean {
	if (!isValidTaskId(taskId)) return false;
	const entries = ensureModifiedFilesByTask(session);
	if (entries.has(taskId)) return true;

	while (entries.size >= MAX_TRACKED_TASK_FILE_ATTRIBUTIONS) {
		const reclaimable = [...entries.keys()].find(
			(candidate) =>
				candidate !== taskId &&
				session.taskWorkflowStates?.get(candidate) === 'complete',
		);
		if (!reclaimable) return false;
		entries.delete(reclaimable);
	}

	entries.set(taskId, []);
	return true;
}

/**
 * Atomically replace one task's attributed file list.
 *
 * Returns false without mutation when the task id is invalid or the bounded
 * map has no reclaimable workflow-complete slot.
 */
export function recordModifiedFilesForTask(
	session: AgentSessionState,
	taskId: string,
	files: readonly string[],
): boolean {
	if (!ensureModifiedFileTaskSlot(session, taskId)) return false;
	const normalized = [
		...new Set(
			files.filter((file) => typeof file === 'string' && file.length > 0),
		),
	];
	session.modifiedFilesByTask.set(taskId, normalized);
	if (session.currentTaskId === taskId) {
		projectModifiedFilesForActiveTask(session);
	}
	return true;
}

/**
 * Add one file to a task's attribution without disturbing its existing files.
 */
export function recordModifiedFileForTask(
	session: AgentSessionState,
	taskId: string,
	file: string,
): boolean {
	if (typeof file !== 'string' || file.length === 0) return false;
	const existing = getModifiedFilesForTask(session, taskId);
	if (existing.includes(file)) return true;
	return recordModifiedFilesForTask(session, taskId, [...existing, file]);
}

/**
 * Return a defensive copy of the files attributed to one task.
 */
export function getModifiedFilesForTask(
	session: AgentSessionState,
	taskId: string,
): string[] {
	if (!isValidTaskId(taskId)) return [];
	return [...(ensureModifiedFilesByTask(session).get(taskId) ?? [])];
}

/**
 * Reset one task's attribution. `remove` is used at terminal cleanup; the
 * default keeps an empty live-task slot ready for subsequent writes.
 */
export function resetModifiedFilesForTask(
	session: AgentSessionState,
	taskId: string,
	options?: { remove?: boolean },
): boolean {
	if (!isValidTaskId(taskId)) return false;
	const entries = ensureModifiedFilesByTask(session);
	if (options?.remove) {
		entries.delete(taskId);
	} else {
		if (!ensureModifiedFileTaskSlot(session, taskId)) return false;
		entries.set(taskId, []);
	}
	if (session.currentTaskId === taskId) {
		projectModifiedFilesForActiveTask(session);
	}
	return true;
}

/**
 * Apply task-completion retention rules.
 *
 * Non-Epic sessions release attribution at the workflow-complete boundary.
 * Epic sessions retain it until `epic_record_divergence` consumes the entry.
 */
export function completeModifiedFilesForTask(
	session: AgentSessionState,
	taskId: string,
): void {
	if (!session.epicModeActive) {
		resetModifiedFilesForTask(session, taskId, { remove: true });
	}
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
		// Council fast-path: if council_mode is enabled and submit_council_verdicts
		// recorded an APPROVE verdict, allow advancement from any state past
		// pre_check_passed, bypassing the Stage B states (reviewer_run, tests_run).
		// Pre-check (pre_check_passed) is still required to avoid skipping Stage A.
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
	// Clear Stage B completion bits when a task reaches 'complete' so that
	// any future retry/restart cycle starts the barrier fresh and does not
	// fire prematurely from stale completion data.
	if (newState === 'complete') {
		session.stageBCompletion?.delete(taskId);
		completeModifiedFilesForTask(session, taskId);
	}
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
 * Returns true iff calling `advanceTaskState(session, taskId, newState)` would
 * succeed without throwing. Use this predicate to guard call sites that cannot
 * catch `INVALID_TASK_STATE_TRANSITION` as a control-flow mechanism.
 *
 * Does NOT perform side effects or emit telemetry.
 *
 * @param session - The agent session state
 * @param taskId - The task identifier
 * @param newState - The requested new state
 * @param councilConfig - Optional council quorum config (required when newState='complete')
 */
export function canAdvanceTaskState(
	session: AgentSessionState,
	taskId: string,
	newState: TaskWorkflowState,
	councilConfig?: { minimumMembers?: number; requireAllMembers?: boolean },
): boolean {
	if (!isValidTaskId(taskId)) return false;
	if (!session || !(session.taskWorkflowStates instanceof Map)) return false;

	const current = session.taskWorkflowStates.get(taskId) ?? 'idle';
	const currentIndex = STATE_ORDER.indexOf(current);
	const newIndex = STATE_ORDER.indexOf(newState);

	if (newIndex <= currentIndex) return false;

	if (newState === 'complete' && current !== 'tests_run') {
		const councilEntry = session.taskCouncilApproved?.get(taskId);
		const effectiveMinimum = councilConfig?.requireAllMembers
			? 5
			: (councilConfig?.minimumMembers ?? 3);
		const councilApproved =
			councilEntry?.verdict === 'APPROVE' &&
			(councilEntry.quorumSize ?? 0) >= effectiveMinimum;
		const pastPreCheck =
			currentIndex >= STATE_ORDER.indexOf('pre_check_passed');
		if (!councilApproved || !pastPreCheck) return false;
	}

	return true;
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
	// Preflight: refuse to re-dispatch a settled task (completed / closed /
	// blocked) to coder_delegated. The centralized guard in updateTaskStatus
	// already protects direct callers, but advanceTaskStateAndPersist is also
	// called on session restart where the in-memory advance at :1415 would
	// fire BEFORE the durable guard can refuse — leaving Layer 1 (session)
	// ahead of Layer 2 (plan). This preflight closes that gap by checking
	// the on-disk plan state first and skipping BOTH mutations when the
	// task is settled.
	if (newState === 'coder_delegated') {
		const settled = await isTaskSettled(directory, taskId);
		if (settled) {
			logger.warn(
				`[advanceTaskStateAndPersist] refusing to re-dispatch settled task ${taskId}; skipping in-memory advance + persist`,
			);
			return;
		}
	}

	advanceTaskState(session, taskId, newState, options, councilConfig);

	if (newState !== 'coder_delegated' && newState !== 'complete') {
		return;
	}

	const planStatus: TaskStatus =
		newState === 'complete' ? 'completed' : 'in_progress';

	try {
		await updateTaskStatus(directory, taskId, planStatus, { force: false });
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
 * Returns true iff per-task council mode is active (replaces Stage B).
 *
 * AND semantics: requires BOTH `pluginConfig.council.enabled === true`
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
	sessionOverrides: Partial<QaGates> = {},
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

	const councilMode =
		getEffectiveGates(profile, sessionOverrides).council_mode === true;

	if (enabled && councilMode) {
		return true;
	}

	// Disagreement case: warn once per plan_id, then fall back.
	if (enabled !== councilMode && !_councilDisagreementWarned.has(planId)) {
		_councilDisagreementWarned.add(planId);
		logger.warn(
			`[delegation-gate] Council mode mismatch for plan ${planId}: ` +
				`pluginConfig.council.enabled=${enabled}, QaGates.council_mode=${councilMode}. ` +
				'Falling back to Stage B (non-council) per-task advancement.',
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
 * Issue #1781 E2: return the sessionID of any currently-active Full-Auto
 * session, or `undefined` if none. Used by `/swarm status` to scope its
 * escalation-detail read to the live session (avoids surfacing stale
 * escalations from prior sessions persisted in `.swarm/full-auto-state.json`).
 * If multiple sessions are active, the one with the most recent tool-call
 * timestamp wins (a proxy for "most recently touched").
 */
export function getActiveFullAutoSessionID(): string | undefined {
	let activeId: string | undefined;
	let activeLastToolCall = -1;
	for (const [id, session] of swarmState.agentSessions) {
		if (session.fullAutoMode !== true) continue;
		const lastToolCall = session.lastToolCallTime ?? 0;
		if (activeId === undefined || lastToolCall > activeLastToolCall) {
			activeId = id;
			activeLastToolCall = lastToolCall;
		}
	}
	return activeId;
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

/**
 * Check if Epic Mode is active for a specific session or ANY session.
 * Mirrors `hasActiveLeanTurbo` but reads `session.epicModeActive`. The flag
 * is set by `enableEpicMode` (and by `/swarm turbo epic on`) and cleared by
 * `disableEpicMode` (and `/swarm turbo epic off`). The durable mirror is
 * `.swarm/epic-state.json` — see `src/turbo/epic/state.ts`. Epic Mode does
 * NOT require `turboStrategy === 'lean'`; it composes Lean Turbo internally
 * inside `epic_run_phase`.
 */
export function hasActiveEpicMode(sessionID?: string): boolean {
	if (sessionID) {
		const session = swarmState.agentSessions.get(sessionID);
		return session?.epicModeActive === true;
	}
	for (const [_sessionId, session] of swarmState.agentSessions) {
		if (session.epicModeActive === true) {
			return true;
		}
	}
	return false;
}

/**
 * Resolves the effective auto_proceed value for a session.
 * Session override (autoProceedOverride) takes precedence over the plan default.
 * Accepts `boolean | undefined` for the plan default so callers can pass
 * `plan?.execution_profile?.auto_proceed` directly without a falsy fallback.
 */
export function getResolvedAutoProceed(
	session: AgentSessionState,
	planAutoProceed: boolean | undefined,
): boolean {
	return session.autoProceedOverride ?? planAutoProceed ?? false;
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
export const MAX_TRACKED_GATE_DENIALS = 500;
export const MAX_TRACKED_CONTEXT_WINDOWS = 500;

/**
 * Record the live `model.limit.context` the host reported for `sessionID`,
 * bound to the reporting model/provider identity and FIFO-evicting the oldest
 * entry past {@link MAX_TRACKED_CONTEXT_WINDOWS}.
 *
 * Only accepts a finite number ≥ 1 — the caller (`src/config/context-window.ts`
 * `isUsableContextWindow`) applies the real plausibility floor, and storing a
 * junk value here would hand it to every `messages.transform` consumer. A
 * rejected value leaves any previously recorded window in place rather than
 * clobbering it, so one malformed turn does not blank a good reading.
 */
export function setLiveContextWindow(
	sessionID: string | undefined,
	tokens: unknown,
	identity?: { modelID?: string; providerID?: string },
): void {
	if (!sessionID) return;
	const map = swarmState.liveContextWindows;
	const modelID = normalizeLiveContextIdentity(identity?.modelID);
	const providerID = normalizeLiveContextIdentity(identity?.providerID);
	const existing = map.get(sessionID);
	const hasUsableTokens =
		typeof tokens === 'number' && Number.isFinite(tokens) && tokens >= 1;
	if (!hasUsableTokens) {
		if (!identity || (!modelID && !providerID)) return;
		if (
			existing?.modelID === modelID &&
			existing?.providerID === providerID &&
			existing?.tokens !== undefined
		) {
			return;
		}
		if (map.has(sessionID)) map.delete(sessionID);
		map.set(sessionID, { modelID, providerID });
		evictOldestLiveContextWindow(map, sessionID);
		return;
	}
	if (map.has(sessionID)) map.delete(sessionID);
	map.set(sessionID, {
		tokens: Math.floor(tokens as number),
		modelID,
		providerID,
	});
	evictOldestLiveContextWindow(map, sessionID);
}

/**
 * Read the live context window recorded for `sessionID`, or `undefined` when
 * no `system.transform` has run for it yet or the requested model/provider
 * identity does not exactly match the reporter. Callers must degrade to the
 * static resolution rungs rather than reuse a stale handoff denominator.
 */
export function getLiveContextWindow(
	sessionID: string | undefined,
	identity?: { modelID?: string; providerID?: string },
): number | undefined {
	if (!sessionID) return undefined;
	const cached = swarmState.liveContextWindows.get(sessionID);
	if (!cached) return undefined;
	const modelID = normalizeLiveContextIdentity(identity?.modelID);
	const providerID = normalizeLiveContextIdentity(identity?.providerID);
	if (
		identity &&
		(cached.modelID !== modelID || cached.providerID !== providerID)
	) {
		return undefined;
	}
	return cached.tokens;
}

export function getLiveContextModelIdentity(
	sessionID: string | undefined,
): { modelID?: string; providerID?: string } | undefined {
	if (!sessionID) return undefined;
	const cached = swarmState.liveContextWindows.get(sessionID);
	if (!cached) return undefined;
	return { modelID: cached.modelID, providerID: cached.providerID };
}

function evictOldestLiveContextWindow(
	map: typeof swarmState.liveContextWindows,
	sessionID: string,
): void {
	if (map.size <= MAX_TRACKED_CONTEXT_WINDOWS) return;
	const oldest = map.keys().next().value;
	if (oldest !== undefined && oldest !== sessionID) map.delete(oldest);
}

function normalizeLiveContextIdentity(
	value: string | undefined,
): string | undefined {
	const normalized = value?.trim().toLowerCase();
	return normalized ? normalized : undefined;
}

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

/** Build the directive-identity fingerprint used to key the gate denial
 *  counter — a sorted, joined snapshot of a critical-directive-id set. Two
 *  calls with the same id set (regardless of order) produce the same key,
 *  so re-injecting the identical directive on a later turn does not reset
 *  the counter, but swapping to a genuinely different directive set does. */
export function buildGateDenialDirectiveKey(ids: string[]): string {
	return [...ids].sort().join(',');
}

/** Increment (or start) the per-session gate denial counter for the given
 *  directive identity, FIFO-evicting the oldest session entry if the cap is
 *  exceeded. When the stored entry's `directiveKey` does not match
 *  `directiveKey`, the counter restarts at 1 instead of continuing to
 *  accumulate — this is what prevents a stale denial count from an earlier,
 *  unrelated critical directive from carrying into a fresh one's
 *  `max_gate_denials` budget. Returns the resulting count. */
export function incrementGateDenialCount(
	sessionID: string,
	directiveKey: string,
): number {
	const map = swarmState.gateDenialCounts;
	const existing = map.get(sessionID);
	const count =
		existing && existing.directiveKey === directiveKey ? existing.count + 1 : 1;
	if (map.has(sessionID)) map.delete(sessionID);
	map.set(sessionID, { count, directiveKey });
	if (map.size > MAX_TRACKED_GATE_DENIALS) {
		const oldest = map.keys().next().value;
		if (oldest !== undefined && oldest !== sessionID) {
			map.delete(oldest);
		}
	}
	return count;
}

/** Clear the gate denial counter for a session. Centralised so call sites do
 *  not bypass the FIFO-cap pathway with a direct `.delete()`. */
export function clearGateDenialCount(sessionID: string): void {
	swarmState.gateDenialCounts.delete(sessionID);
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
 * Rehydrate PR subscriptions for a given session from durable storage.
 * Reads active subscriptions from the JSONL store and filters to those
 * belonging to the specified sessionID, converting each to a PrSubscriptionState.
 *
 * @param sessionID - The session identifier to filter subscriptions by
 * @param directory - Project root containing .swarm/ subdirectory
 * @returns Map of PrSubscriptionState keyed by `${repoFullName}::${prNumber}`
 */
export async function rehydratePrSubscriptions(
	sessionID: string,
	directory: string,
): Promise<Map<string, PrSubscriptionState>> {
	const map = new Map<string, PrSubscriptionState>();

	try {
		const { listActive } = await import('./background/pr-subscriptions.js');
		const records = await listActive(directory);

		for (const record of records) {
			if (record.sessionID !== sessionID) continue;

			const key = `${record.repoFullName}::${record.prNumber}`;
			map.set(key, {
				prNumber: record.prNumber,
				repoFullName: record.repoFullName,
				prUrl: record.prUrl,
				lastKnownStatus: record.mergeableState ?? 'unknown',
				lastPollTime: record.lastCheckedAt,
				errorCount: record.errorCount,
				isWatching: record.isWatching,
			});
		}
	} catch (err) {
		logger.warn(
			`[state] rehydratePrSubscriptions failed for session ${sessionID}: ${err instanceof Error ? err.message : String(err)}`,
		);
	}

	return map;
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
	hasActiveEpicMode: typeof hasActiveEpicMode;
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
	hasActiveEpicMode,
	buildRehydrationCache,
	applyRehydrationCache,
	rehydrateSessionFromDisk,
	isCouncilGateActive,
	defaultRunContext,
};
