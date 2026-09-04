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
import { getSwarmAgents, resolveFallbackModel } from '../../agents/index';
import { DEFAULT_LEAN_TURBO_CONFIG } from '../../config/constants';
import type { Plan } from '../../config/plan-schema';
import type { LeanTurboConfig } from '../../config/schema';
import { stripKnownSwarmPrefix } from '../../config/schema';
import { loadFullAutoRunState } from '../../full-auto/state';
import { acquireLaneLocks, releaseLaneLocks } from '../../parallel/file-locks';
import { loadPlanJsonOnly } from '../../plan/manager';
import { derivePlanId } from '../../plan/utils';
import {
	endAgentSession,
	getAgentSession,
	hasActiveFullAuto,
	swarmState,
} from '../../state';
import { telemetry } from '../../telemetry';
import { pushAdvisory } from '../../utils/advisory-queue';
import { teardownEphemeralSession } from '../../utils/ephemeral-session-teardown';
import { criticalWarn, log } from '../../utils/logger';
import {
	dispatchWithModelFallback,
	type ModelOverride,
} from '../../utils/model-dispatch-fallback';
import {
	isQuotaError,
	isTransientProviderError,
} from '../../utils/provider-error-classification';
import type { LaneEvidence, PhaseEvidence } from './evidence';
import { writeLaneEvidence, writePhaseEvidence } from './evidence';
import { publishLeanTurboLaneScopeBinding } from './lane-scope';
import {
	attemptMergeBackFromDirty,
	getMergeStrategy,
	mergeLaneBranch,
	postMergeCleanup,
	startupOrphanRecovery,
} from './merge-back';
import type { LeanTurboLanePlan } from './planner';
import { planLeanTurboLanes } from './planner';
import { clearRecoveryRecord, writeRecoveryRecord } from './recovery';
import type { LeanTurboDegradedTask, LeanTurboLane } from './state';
import { loadLeanTurboRunState, saveLeanTurboRunState } from './state';
import { withTurboStateLock } from './state-lock';
import {
	assertCleanWorkingTree,
	parseLeanLaneIndex,
	provisionWorktree,
	removeLaneProfileFromDiskReal,
	removeWorktree,
} from './worktree';

/**
 * Shape of the OpencodeClient session API used by the runner.
 * Extracted into an interface so tests can inject a mock without
 * requiring the full SDK type.
 */
interface SessionClient {
	create(options: {
		body?: { parentID?: string; title?: string };
		query: { directory: string };
	}): Promise<{
		data: { id: string } | null;
		error: unknown;
	}>;
	prompt(options: {
		path: { id: string };
		body: {
			agent: string;
			tools: { write: boolean; edit: boolean; patch: boolean };
			parts: Array<{ type: 'text'; text: string }>;
		};
		signal?: AbortSignal;
	}): Promise<{
		data: { parts: Array<{ type: string; text?: string }> } | null;
		error: unknown;
	}>;
	delete(options: { path: { id: string } }): Promise<void>;
	/**
	 * Optional graceful abort. Present on the real opencode SDK session at
	 * runtime (absent on minimal test fakes). Teardown awaits it before delete
	 * so opencode flushes the final part/message (#2123).
	 */
	abort?(options: { path: { id: string } }): Promise<unknown>;
}

// ─── Result Types ───────────────────────────────────────────────────────────────────

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
 * Describes a merge-back failure for a completed lane.
 */
export interface MergeBackFailureInfo {
	/** Lane identifier */
	laneId: string;
	/** Lane branch preserved for recovery */
	branchName?: string;
	/** Lane worktree preserved for recovery */
	worktreePath: string;
	/** Merge-back failure class */
	status: 'failed' | 'partial' | 'conflict';
	/** Human-readable reason for the merge-back failure */
	reason: string;
	/** Conflict files if the failure was a merge conflict */
	conflictFiles?: string[];
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
	/** Merge-back failure info if the coder completed but integration back to primary failed */
	mergeBackFailure?: MergeBackFailureInfo;
}

/**
 * Result of a full phase run.
 *
 * ## Serial Tasks Contract
 *
 * `serializedTasks` contains task IDs excluded from parallel lanes due to lock conflicts
 * (Issue #1 - Serial Task Orphan Risk).
 *
 * **Caller Responsibility**: The orchestrator MUST complete these tasks via standard
 * serial flow (normal task dispatch). The runner does NOT dispatch serializedTasks.
 *
 * **Verification**: phase-ready (step 6b) verifies serializedTasks by checking that
 * each task ID has status: completed in plan.json. If serializedTasks contain task IDs
 * but those tasks are not marked completed in plan.json, phase-ready returns ok: false,
 * blocking phase advancement.
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
	/**
	 * #1657: full degraded-task details (reason/files/requiredMode) so the
	 * architect sees per-task degradation reasons in the tool result, not
	 * just task IDs. Additive alongside `degradedTasks` (kept for back-compat).
	 */
	degradedDetails?: LeanTurboDegradedTask[];
	/**
	 * Task IDs excluded from parallel lanes due to lock conflicts.
	 * Caller must complete these via standard serial flow before phase can advance.
	 * (Issue #1: Serial Task Orphan Risk - Fixed with integration test)
	 */
	serializedTasks: string[];
	/** Lanes whose coder completed but merge-back to primary branch failed */
	mergeBackFailures?: MergeBackFailureInfo[];
}

// ─── Internal Types ───────────────────────────────────────────────────────────

/**
 * Maps laneId → list of file paths locked for that lane.
 * Used by cleanup() to release all held locks.
 */
type LaneLockMap = Record<string, string[]>;

// ─── Transient Error Detection ───────────────────────────────────────────────

/**
 * Determines whether a worktree provisioning error is transient and worth retrying.
 *
 * Transient errors include well-known system error codes (ENOENT, EBUSY, EPERM, etc.),
 * disk-space messages, and git "fatal:" stderr that doesn't indicate a permanent
 * condition like "already exists" or "not a git repository".
 */
function isTransientProvisionError(errorMsg: string): boolean {
	const lower = errorMsg.toLowerCase();

	// Permanent conditions — never retry
	if (
		lower.includes('already exists') ||
		lower.includes('not a git repository')
	) {
		return false;
	}

	// Known transient system error codes
	const transientCodes = [
		'enoent',
		'econnrefused',
		'etimedout',
		'ebusy',
		'eperm',
		'enomem',
	];
	for (const code of transientCodes) {
		if (lower.includes(code)) {
			return true;
		}
	}

	// Transient disk/resource messages
	const transientMessages = [
		'disk full',
		'no space left',
		'resource temporarily unavailable',
	];
	for (const msg of transientMessages) {
		if (lower.includes(msg)) {
			return true;
		}
	}

	// Git "fatal:" stderr with non-zero exit — transient unless excluded above
	if (lower.includes('fatal:')) {
		return true;
	}

	return false;
}

// ─── Runner Class ───────────────────────────────────────────────────────────────

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

// ─── Module-level helpers ───────────────────────────────────────────────────────

/**
 * Error code returned when a lane's write authority could not be published
 * (issue #2002). Deliberately free of any token matched by
 * `TRANSIENT_MODEL_ERROR_PATTERN` / `QUOTA_ERROR_PATTERN`, and classified
 * `permanent` explicitly in `_processLane` so a broken authority handshake can
 * never be mistaken for a provider blip and retried across fallback models.
 */
export const LANE_SCOPE_DENIED_CODE = 'LEAN_TURBO_LANE_SCOPE_DENIED';

/**
 * FR-106: Pushes a dirty-tree downgrade advisory into the architect's advisory queue.
 *
 * @param sessionID - The session to push the advisory into
 * @param reason - The dirty-tree reason (error message from assertCleanWorkingTree)
 * @param lanesAffected - Optional list of lane IDs affected by the downgrade
 */
function pushDirtyTreeDowngradeAdvisory(
	sessionID: string,
	reason: string,
	lanesAffected: string[] = [],
): void {
	// Issue #2002 hardening: never `ensureAgentSession(sessionID)` with no
	// agent name. That call is the exact fail-open documented at
	// `_doDispatch`/`_publishLaneScope` below: with no session registered it
	// calls `startAgentSession(..., 'unknown', ...)`, setting
	// `swarmState.activeAgent` to the truthy string 'unknown', which passes the
	// no-active-agent guards in `src/hooks/guardrails/tool-before.ts` and lands
	// in the `noScopeLenient` branch that skips the authority check entirely.
	//
	// A plain lookup-only fallback (drop the advisory when absent) over-corrected:
	// FR-106 is a "never defer work" advisory — silently dropping it on a missing
	// session is exactly the prohibited shape (see AGENTS.md "we never defer
	// work").
	//
	// Naming the created session ORCHESTRATOR_NAME was also considered and
	// REJECTED — but NOT because architect is more permissive than 'unknown'.
	// It is not: `scope-guard.ts` early-returns for BOTH (`isArchitect` and
	// `agentRole !== 'coder'`), and on the shell path `'unknown'` is strictly
	// MORE permissive, because `noScopeLenient` (`tool-before.ts`) is
	// `!isArch && !isCoder && …` and skips the authority check for 'unknown'
	// while architect additionally picks up `handlePlanAndScopeProtection`.
	//
	// The actual reason: only the architect agent can invoke
	// `lean_turbo_run_phase` (`TURBO_AGENT_TOOL_MAP`), but that authorizes the
	// CALL, not the VALUE — `sessionID` is a zod tool argument
	// (`src/tools/lean-turbo-run-phase.ts`), so the caller chooses the string.
	// Minting here would write a durable, cross-hook identity assertion into
	// `swarmState.activeAgent` for an id the plugin never issued. Advisory
	// delivery is not a good enough reason to fabricate an identity.
	//
	// Resolution: never create; emit via `criticalWarn` when the session is
	// unknown. `log()`/`warn()` are gated behind `OPENCODE_SWARM_DEBUG=1`
	// (`src/utils/logger.ts`), so they would silence this in every normal run —
	// which is the same vanishing-signal shape this comment exists to prevent.
	const affected =
		lanesAffected.length > 0
			? `; affected lanes: ${lanesAffected.join(', ')}`
			: '';
	const advisory = `LEAN_TURBO_DIRTY_TREE_DOWNGRADE: ${reason}${affected}. Worktree isolation is OFF for this phase; lanes run in the shared working tree.`;
	const session = getAgentSession(sessionID);
	if (!session) {
		// Do NOT mint the session here — `sessionID` is caller-supplied (see the
		// block comment above). `criticalWarn` and not `log`/`warn`: those are
		// gated behind OPENCODE_SWARM_DEBUG=1, which would hide a phase-wide
		// isolation downgrade in every normal run.
		criticalWarn(
			`[lean-turbo] ${advisory} (advisory not delivered: session ${sessionID} is not registered)`,
		);
		return;
	}
	pushAdvisory(session, advisory);
}

export class LeanTurboRunner {
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
		writePhaseEvidence: typeof writePhaseEvidence;
		/** Timeout for lane dispatch (session.create + session.prompt) in ms. Undefined = no timeout. */
		laneDispatchTimeoutMs: number | undefined;
		provisionWorktree: typeof provisionWorktree;
		removeWorktree: typeof removeWorktree;
		removeLaneProfileFromDisk: typeof removeLaneProfileFromDiskReal;
		mergeLaneBranch: typeof mergeLaneBranch;
		postMergeCleanup: typeof postMergeCleanup;
		attemptMergeBackFromDirty: typeof attemptMergeBackFromDirty;
		startupOrphanRecovery: typeof startupOrphanRecovery;
		getMergeStrategy: typeof getMergeStrategy;
		assertCleanWorkingTree: typeof assertCleanWorkingTree;
		/**
		 * Issue #2002: publishes a lane's plan-correlated, lane-rooted write
		 * authority before the lane's coder prompt is sent.
		 */
		publishLeanTurboLaneScopeBinding: typeof publishLeanTurboLaneScopeBinding;
	} = {
		loadPlanJsonOnly,
		planLeanTurboLanes,
		acquireLaneLocks,
		releaseLaneLocks,
		loadLeanTurboRunState,
		saveLeanTurboRunState,
		hasActiveFullAuto,
		loadFullAutoRunState,
		writeLaneEvidence,
		writePhaseEvidence,
		laneDispatchTimeoutMs: undefined,
		provisionWorktree,
		removeWorktree,
		removeLaneProfileFromDisk: removeLaneProfileFromDiskReal,
		mergeLaneBranch,
		postMergeCleanup,
		attemptMergeBackFromDirty,
		startupOrphanRecovery,
		getMergeStrategy,
		assertCleanWorkingTree,
		publishLeanTurboLaneScopeBinding,
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
	_sessionOps: SessionClient | null = null;

	private readonly _directory: string;
	private readonly _sessionID: string;
	private readonly _client!: OpencodeClient | null | undefined;
	private readonly _availableAgents: string[];

	/** Tracks which files are locked per lane (for cleanup) */
	private _laneLockMap: LaneLockMap = {};

	/** Current lane statuses (updated after each dispatch) */
	private _laneStatuses: Map<string, LeanTurboLane> = new Map();

	/** Round-robin index for agent selection */
	private _agentIndex: number = 0;

	/**
	 * Tracks lanes that timed out so that when their _doDispatch completes,
	 * we can clean up the orphan session.
	 */
	private _timedOutLanes: Map<string, string> = new Map();

	/** Chains durable state updates to prevent race conditions on concurrent lanes. */
	private _stateLock: Promise<unknown> = Promise.resolve();

	/** Lean-mode configuration passed at construction. Undefined means use defaults. */
	private readonly _leanConfig?: LeanTurboConfig;

	/**
	 * FR-106: Records a pending dirty-tree downgrade so we can enumerate affected lanes
	 * after `planLeanTurboLanes` runs and push a per-lane advisory to the architect.
	 * Null when no downgrade is pending.
	 */
	private _pendingDowngrade: { reason: string } | null = null;

	constructor(options: {
		/** Project root directory */
		directory: string;
		/** Current session ID */
		sessionID: string;
		/** OpenCode SDK client. Pass null to stay fail-closed. Omit to allow test mock injection. */
		opencodeClient?: OpencodeClient | null;
		/** Pre-registered generated agent names */
		generatedAgentNames?: readonly string[];
		/** Lean-mode configuration. Falls back to hardcoded defaults if omitted. */
		leanConfig?: LeanTurboConfig;
	}) {
		this._directory = options.directory;
		this._sessionID = options.sessionID;
		this._leanConfig = options.leanConfig;

		// Only set _client if explicitly provided (including null).
		// When omitted entirely, _client stays undefined → fail-open for production
		// but allows test mock injection via _sessionOps seam.
		if ('opencodeClient' in options) {
			this._client = options.opencodeClient ?? null;
			// Wire session ops from real client
			if (this._client) {
				this._sessionOps = this._client.session as unknown as SessionClient;
			}
		}

		// Resolve available coder agents
		const names = options.generatedAgentNames ?? swarmState.generatedAgentNames;
		this._availableAgents = this._resolveCoderAgents(names);
	}

	// ─── Public Methods ─────────────────────────────────────────────────────────────

	/**
	 * Run a single phase: plan lanes, acquire locks, dispatch coders.
	 *
	 * @param phaseNumber - Phase number to execute
	 * @returns Result with per-lane statuses and degraded task list
	 */
	async runPhase(phaseNumber: number): Promise<LeanTurboPhaseResult> {
		// Fail-closed: explicit null client means no dispatch
		// Omitting opencodeClient (undefined) allows test mock injection via _sessionOps
		if (this._client === null) {
			return {
				ok: false,
				reason: 'NO_CLIENT',
				lanes: [],
				degradedTasks: [],
				serializedTasks: [],
			};
		}

		// Load plan for lane planning
		const plan = await LeanTurboRunner._internals.loadPlanJsonOnly(
			this._directory,
		);
		if (!plan) {
			return {
				ok: false,
				reason: 'NO_PLAN',
				lanes: [],
				degradedTasks: [],
				serializedTasks: [],
			};
		}

		// Full-Auto composition check: block if Full-Auto session is paused or terminated
		if (LeanTurboRunner._internals.hasActiveFullAuto(this._sessionID)) {
			const fullAutoState = LeanTurboRunner._internals.loadFullAutoRunState(
				this._directory,
				this._sessionID,
			);
			if (
				fullAutoState &&
				(fullAutoState.status === 'paused' ||
					fullAutoState.status === 'terminated')
			) {
				return {
					ok: false,
					reason: 'FULL_AUTO_BLOCKED',
					lanes: [],
					degradedTasks: [],
					serializedTasks: [],
				};
			}
		}

		// Get lean config (use stored config or defaults if not set)
		const leanConfig = this._getLeanConfig(this._leanConfig);
		const phaseStartedAt = new Date().toISOString();

		// Startup orphan recovery (FR-002) — only when worktree isolation is enabled
		if (leanConfig.worktree_isolation) {
			await LeanTurboRunner._internals.startupOrphanRecovery(this._directory, [
				this._sessionID,
			]);

			// DD-2: Assert clean working tree before provisioning worktrees.
			// If dirty, degrade ALL lanes to shared-directory execution for this phase.
			try {
				const cleanResult =
					await LeanTurboRunner._internals.assertCleanWorkingTree(
						this._directory,
					);
				if (!cleanResult.clean) {
					// FR-106: Record the downgrade so we can enumerate affected lanes after planning
					this._pendingDowngrade = {
						reason: cleanResult.error ?? 'uncommitted changes',
					};
					log(
						`[lean-turbo] worktree isolation requires clean working tree: ${cleanResult.error}`,
					);
					leanConfig.worktree_isolation = false;
				}
			} catch (assertErr) {
				// If the check itself fails (e.g. not a git repo), degrade gracefully
				const assertMsg =
					assertErr instanceof Error ? assertErr.message : String(assertErr);
				// FR-106: Record the downgrade so we can enumerate affected lanes after planning
				this._pendingDowngrade = {
					reason: `cleanliness check failed: ${assertMsg}`,
				};
				log(
					`[lean-turbo] unable to verify working tree cleanliness: ${assertMsg} — degrading to shared directory`,
				);
				leanConfig.worktree_isolation = false;
			}
		}

		// Plan lane distribution — type cast needed because Phase (schema) is structurally
		// wider than PlanPhase (planner) but at runtime all used fields are compatible
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const lanePlan: LeanTurboLanePlan =
			LeanTurboRunner._internals.planLeanTurboLanes(
				this._directory,
				phaseNumber,
				// biome-ignore lint/suspicious/noExplicitAny: Phase/PlanPhase structural type mismatch
				{ phases: plan.phases as any },
				leanConfig,
			);

		// FR-106: If a dirty-tree downgrade was recorded before planning, enumerate the
		// affected lanes and push a session-visible advisory to the architect.
		if (this._pendingDowngrade) {
			const lanesAffected = lanePlan.lanes.map((l) => l.laneId);
			pushDirtyTreeDowngradeAdvisory(
				this._sessionID,
				this._pendingDowngrade.reason,
				lanesAffected,
			);
			this._pendingDowngrade = null;
		}

		const degradedTasks = lanePlan.degradedTasks.map((d) => d.taskId);
		// #1657: also carry the full degraded-task objects (reason/files/
		// requiredMode) so the tool result includes per-task degradation
		// reasons, not just IDs. The full objects are already persisted in
		// run state and reconstructed by /swarm status; this closes the
		// tool-boundary thinning point.
		const degradedDetails: LeanTurboDegradedTask[] = lanePlan.degradedTasks;

		// Return NO_LANES only if planner produced zero lanes AND no fallback tasks
		if (
			lanePlan.lanes.length === 0 &&
			degradedTasks.length === 0 &&
			lanePlan.serializedTasks.length === 0
		) {
			return {
				ok: false,
				reason: 'NO_LANES',
				lanes: [],
				degradedTasks,
				degradedDetails,
				serializedTasks: lanePlan.serializedTasks,
			};
		}

		// When lanes.length === 0 but there are serialized/degraded fallback tasks,
		// persist state so phase-ready can verify them
		if (lanePlan.lanes.length === 0) {
			await this._withStateLock(() => this._updateDurableState(lanePlan));
			await this._writePhaseEvidenceSafely({
				phaseNumber,
				plan,
				lanePlan,
				laneResults: [],
				leanConfig,
				status: 'completed',
				startedAt: phaseStartedAt,
			});
			return {
				ok: true,
				lanes: [],
				degradedTasks,
				degradedDetails,
				serializedTasks: lanePlan.serializedTasks,
			};
		}

		// Update durable state with planned lanes
		await this._withStateLock(() => this._updateDurableState(lanePlan));

		// Initialize lane statuses from plan
		this._laneStatuses = new Map(
			lanePlan.lanes.map((lane) => [lane.laneId, { ...lane }]),
		);

		const laneResults: LaneResult[] = [];

		// Process lanes concurrently for maximum throughput
		const results = await Promise.all(
			lanePlan.lanes.map((lane) => this._processLane(lane, leanConfig, plan)),
		);
		laneResults.push(...results);

		// Sequential worktree cleanup: after ALL lanes complete, handle worktree
		// lanes one at a time to prevent concurrent git merge/rebase/cherry-pick
		// from corrupting the shared .git index (race condition fix).
		// Handles both SUCCESS lanes (mergeLaneBranch + cleanup + removeWorktree)
		// and FAILURE lanes (attemptMergeBackFromDirty + removeWorktree).
		const mergeBackFailures = await this._sequentialWorktreeCleanup(
			laneResults,
			leanConfig,
		);

		const phaseResult: LeanTurboPhaseResult = {
			ok: mergeBackFailures.length === 0,
			reason:
				mergeBackFailures.length > 0
					? `Lean Turbo merge-back failed for ${mergeBackFailures.length} lane(s); preserved affected worktrees for manual recovery.`
					: undefined,
			lanes: laneResults,
			degradedTasks,
			degradedDetails,
			serializedTasks: lanePlan.serializedTasks,
			mergeBackFailures:
				mergeBackFailures.length > 0 ? mergeBackFailures : undefined,
		};
		await this._writePhaseEvidenceSafely({
			phaseNumber,
			plan,
			lanePlan,
			laneResults,
			leanConfig,
			status: phaseResult.ok ? 'completed' : 'failed',
			startedAt: phaseStartedAt,
			mergeBackFailures,
		});

		return phaseResult;
	}

	/**
	 * Dispatch a single lane to a named agent.
	 *
	 * Creates an ephemeral session, sends a task prompt, and returns
	 * the session ID for later status polling.
	 *
	 * @param lane - Lane to dispatch
	 * @param agentName - Agent name to dispatch to
	 * @param worktreeDirectory - Provisioned lane worktree, when isolation is on
	 * @param model - Per-call model override for a fallback attempt (#1896)
	 * @param plan - Authoritative plan for this run. Required to publish the
	 *   lane's write authority (issue #2002). When omitted, no binding is
	 *   minted AND the lane's `write`/`edit`/`patch` tools are force-disabled
	 *   (see `_doDispatch`) — an unscoped lane can never be dispatched
	 *   writable, regardless of caller. Only `_processLane` supplies a plan in
	 *   production (always, per `runPhase`'s own `NO_PLAN` guard); direct
	 *   callers that omit it get a read-only lane rather than a silent
	 *   unscoped-but-writable one.
	 */
	async dispatchLane(
		lane: LeanTurboLane,
		agentName: string,
		worktreeDirectory?: string,
		model?: ModelOverride,
		plan?: Plan,
	): Promise<LaneDispatchResult> {
		const session =
			this._sessionOps ??
			(this._client?.session as unknown as SessionClient | null);
		if (!session) {
			return { ok: false, error: 'NO_CLIENT' };
		}

		// Build a promise that does the full dispatch
		const promptController = new AbortController();
		const dispatchPromise = this._doDispatch(
			session,
			lane,
			agentName,
			worktreeDirectory,
			promptController,
			model,
			plan,
		);

		// Apply timeout if configured via _internals
		const timeoutMs = LeanTurboRunner._internals.laneDispatchTimeoutMs;
		if (timeoutMs !== undefined && timeoutMs > 0) {
			let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
			const timeoutPromise = new Promise<never>((_, reject) => {
				timeoutHandle = setTimeout(() => {
					promptController.abort();
					reject(new Error(`Lane dispatch timed out after ${timeoutMs}ms`));
				}, timeoutMs);
			});
			try {
				return await Promise.race([dispatchPromise, timeoutPromise]);
			} catch (err) {
				if (err instanceof Error && err.message.includes('timed out')) {
					// Timeout won the race. Track this lane so that when _doDispatch
					// completes in the background, we can clean up the orphan session
					// if one was created. We store a sentinel and capture the sessionId
					// via the side effect in _doDispatch's completion handler.
					this._timedOutLanes.set(lane.laneId, '__pending__');
					// Set up completion handler to clean up if session was created
					dispatchPromise
						.then((result) => {
							if (result.ok && result.sessionId) {
								const tracked = this._timedOutLanes.get(lane.laneId);
								if (tracked !== undefined) {
									// Timeout already fired — clean up orphan session
									this._timedOutLanes.delete(lane.laneId);
									// #2123: teardown awaits a graceful abort
									// (flush) before the cascade-delete.
									void teardownEphemeralSession(session, result.sessionId!);
									// Issue #2002 hardening (item 2b): a lane that timed out
									// but later completed successfully in the background may
									// already have a published scope binding + child
									// AgentSessionState (`_publishLaneScope` ran before the
									// slow step). Mirror the prompt-failure and
									// thrown-exception cleanup in `_doDispatch` so a lane
									// timeout does not leave those behind alongside the orphan
									// remote session deleted above.
									endAgentSession(
										result.sessionId,
										worktreeDirectory ?? this._directory,
									);
								} else {
									// Timeout hadn't fired yet, clear the pending marker
									this._timedOutLanes.delete(lane.laneId);
								}
							} else {
								this._timedOutLanes.delete(lane.laneId);
							}
						})
						.catch(() => {
							// Dispatch itself failed — no orphan to clean up
							this._timedOutLanes.delete(lane.laneId);
						});
					return { ok: false, error: err.message };
				}
				throw err;
			} finally {
				if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
			}
		}

		return dispatchPromise;
	}

	/**
	 * Internal dispatch implementation (separated for timeout wrapping).
	 */
	private async _doDispatch(
		session: SessionClient,
		lane: LeanTurboLane,
		agentName: string,
		worktreeDirectory?: string,
		abortController?: AbortController,
		model?: ModelOverride,
		plan?: Plan,
	): Promise<LaneDispatchResult> {
		let sessionId: string | undefined;
		const effectiveDirectory = worktreeDirectory ?? this._directory;
		try {
			// Use worktree directory when provided, otherwise use primary directory.
			// Create ephemeral session
			const createResult = await session.create({
				...(this._sessionID
					? {
							body: {
								parentID: this._sessionID,
								title: `lean_turbo_lane_${lane.laneId} background`,
							},
						}
					: {}),
				query: { directory: effectiveDirectory },
			});

			if (!createResult.data) {
				return {
					ok: false,
					error: `session.create failed: ${typeof createResult.error === 'string' ? createResult.error : JSON.stringify(createResult.error)}`,
				};
			}

			sessionId = createResult.data.id;

			// Issue #2002 (Lean Turbo half): the lane's coder is about to be
			// prompted with write/edit/patch enabled. Publish its plan-correlated,
			// lane-rooted write authority FIRST — mirroring the standard worktree
			// path in `src/hooks/delegation-gate.ts` — or the coder runs with no
			// binding at all and every write fails SCOPE_NOT_DECLARED.
			if (plan) {
				const laneScopeError = await this._publishLaneScope(
					session,
					lane,
					plan,
					sessionId,
					worktreeDirectory,
					effectiveDirectory,
					abortController,
				);
				if (laneScopeError) return laneScopeError;
			}

			// Build task prompt for this lane
			const promptText = this._buildLanePrompt(lane);

			// Issue #2002 hardening: file-modifying tools are enabled ONLY when a
			// plan was supplied. `plan` is what `_publishLaneScope` above needs to
			// mint the lane's write-authority binding — without it, nothing was
			// published and a writable lane would run with no scope binding at
			// all. This was previously safety-by-convention (only `_processLane`
			// calls `dispatchLane`, and it always has a plan). Gating the tools
			// payload itself — rather than requiring the `plan` parameter — means
			// no caller (typed, untyped, or a future direct `dispatchLane` call)
			// can obtain a writable lane without also supplying the plan that
			// authorizes it, regardless of how many other callers exist that
			// legitimately omit `plan` to test dispatch mechanics unrelated to
			// scope (session parenting, timeouts, model fallback).
			//
			// This `tools` gate covers write/edit/patch only — it does NOT disable
			// `bash`, so a plan-less lane's coder can still attempt shell writes.
			// What actually blocks those is that `_publishLaneScope` never runs
			// without a `plan` (see the `if (plan)` guard above), so no session is
			// ever registered for this child id, and the shell-write path in
			// `src/hooks/guardrails/tool-before.ts` throws `WRITE BLOCKED: No
			// active agent registered for session "…"` before any shell write is
			// permitted.
			const promptResult = await session.prompt({
				path: { id: sessionId },
				body: {
					agent: agentName,
					// #1896: per-call model override on a fallback attempt.
					...(model ? { model } : {}),
					tools: plan
						? { write: true, edit: true, patch: true }
						: { write: false, edit: false, patch: false },
					parts: [{ type: 'text' as const, text: promptText }],
				},
				signal: abortController?.signal,
			});

			if (!promptResult.data) {
				abortController?.abort();
				void teardownEphemeralSession(session, sessionId);
				// Issue #2002 (Lean Turbo half): `_publishLaneScope` may have already
				// published this lane's write authority and created the child
				// AgentSessionState before this dispatch failed. Mirror the standard
				// worktree path's `clearPublishedScopeBindings` — the binding must not
				// outlive the session it authorized. `endAgentSession` unconditionally
				// clears any scope binding owned by this session id (plus its disk
				// copy via `clearScopeBindingFromDisk`) and deletes the
				// `AgentSessionState` entry (`src/state.ts`); for a fresh lane session
				// id with nothing published (e.g. `plan` was omitted or the lane had
				// no authorizable scope) those clears simply match zero bindings and a
				// missing map key, so it is safe — but not a no-op in general — to
				// call unconditionally here.
				endAgentSession(sessionId, effectiveDirectory);
				return {
					ok: false,
					error: `session.prompt failed: ${typeof promptResult.error === 'string' ? promptResult.error : JSON.stringify(promptResult.error)}`,
				};
			}

			return { ok: true, sessionId };
		} catch (err) {
			if (sessionId) {
				abortController?.abort();
				void teardownEphemeralSession(session, sessionId);
				// Same rationale as the session.prompt failure branch above: clear
				// any lane scope binding + AgentSessionState published for this
				// session before the exception aborted dispatch.
				endAgentSession(sessionId, effectiveDirectory);
			}
			const msg = err instanceof Error ? err.message : String(err);
			return { ok: false, error: msg };
		}
	}

	/**
	 * Publish the lane's write authority for a freshly created lane session
	 * (issue #2002 — Lean Turbo half).
	 *
	 * Two distinct fail-closed outcomes, deliberately kept apart:
	 *
	 * - **No authorizable lane** (`publishLeanTurboLaneScopeBinding` returns
	 *   null: representative task id not in strict `N.M[.P]` form, no
	 *   plan-backed files, unusable child identity). Nothing is published and
	 *   the lane still runs — the coder is blocked by the ordinary
	 *   `SCOPE_NOT_DECLARED` gate exactly as it was before this fix. An
	 *   architect advisory makes the unscoped lane visible instead of silent.
	 * - **Publication failed unexpectedly** (I/O error, plan materialization
	 *   rejected). That is not a pre-existing state, so the lane session is
	 *   torn down and the dispatch fails permanently rather than running a
	 *   coder whose authority is in an unknown state.
	 *
	 * @returns a failing `LaneDispatchResult` to abort the dispatch, or null to
	 *   continue.
	 */
	private async _publishLaneScope(
		session: SessionClient,
		lane: LeanTurboLane,
		plan: Plan,
		childSessionId: string,
		worktreeDirectory: string | undefined,
		effectiveDirectory: string,
		abortController?: AbortController,
	): Promise<LaneDispatchResult | null> {
		let published: Awaited<ReturnType<typeof publishLeanTurboLaneScopeBinding>>;
		try {
			published =
				await LeanTurboRunner._internals.publishLeanTurboLaneScopeBinding({
					primaryDirectory: this._directory,
					laneRoot: effectiveDirectory,
					// Trusted provisioning signal only — never a path comparison and
					// never anything an agent can supply.
					isolated: worktreeDirectory !== undefined,
					plan,
					lane,
					parentSessionId: this._sessionID,
					childSessionId,
				});
		} catch (scopeErr) {
			const reason =
				scopeErr instanceof Error ? scopeErr.message : String(scopeErr);
			abortController?.abort();
			void teardownEphemeralSession(session, childSessionId);
			// Issue #2002 hardening (item 2a): `publishLeanTurboLaneScopeBinding`
			// (`src/turbo/lean/lane-scope.ts`) calls `registerScopeBinding` before
			// `writeScopeBindingToDisk`, and `ensureAgentSession` for the child
			// session before `recordSessionWorkspaceRoot`. A throw from either of
			// those disk/registration steps can leave the in-memory binding and/or
			// the child `AgentSessionState` registered even though this whole
			// publish attempt is being treated as failed. `endAgentSession` clears
			// both for this child session id and is a safe no-op if neither was
			// actually created yet.
			endAgentSession(childSessionId, effectiveDirectory);
			log(
				`[lean-turbo] lane ${lane.laneId} write authority could not be published: ${reason}`,
			);
			return {
				ok: false,
				error: `${LANE_SCOPE_DENIED_CODE}: ${reason}`,
			};
		}

		if (!published) {
			log(
				`[lean-turbo] lane ${lane.laneId} has no plan-backed scope authority (tasks: ${lane.taskIds.join(', ')}) — the lane coder will be blocked on every write`,
			);
			if (this._sessionID) {
				// Issue #2002 hardening: same rationale as
				// `pushDirtyTreeDowngradeAdvisory` above — never
				// `ensureAgentSession(this._sessionID)` with no agent name (that is
				// the 'unknown' fail-open), and never mint an architect-named
				// session for a caller-supplied id either. Look up only, and log
				// rather than drop when the session is unknown.
				try {
					const unscopedAdvisory = `LEAN_TURBO_LANE_UNSCOPED: lane ${lane.laneId} (tasks: ${lane.taskIds.join(', ')}) could not be given a validated write scope, so its coder is blocked from writing. Declare a scope for the lane's tasks or give them files_touched in the plan.`;
					const architectSession = getAgentSession(this._sessionID);
					if (architectSession) {
						pushAdvisory(architectSession, unscopedAdvisory);
					} else {
						// Same rule as `pushDirtyTreeDowngradeAdvisory`: never mint a
						// session for a caller-supplied id. `criticalWarn`, not
						// `log`/`warn` — those are gated behind OPENCODE_SWARM_DEBUG=1
						// and would hide the fact that this lane's coder is running
						// unable to write anything.
						criticalWarn(
							`[lean-turbo] ${unscopedAdvisory} (advisory not delivered: session ${this._sessionID} is not registered)`,
						);
					}
				} catch {
					/* advisory delivery is best-effort — never blocks dispatch */
				}
			}
		}
		return null;
	}

	/**
	 * Get current status of all lanes tracked by this runner.
	 *
	 * Note: This returns in-memory status only. Lane sessions are
	 * managed by the OpenCode runtime and cannot be directly polled
	 * through the SDK. External status tracking (e.g., via session
	 * list) should be used for production status polling.
	 */
	async waitForLanes(): Promise<LaneStatus[]> {
		const statuses: LaneStatus[] = [];

		for (const [laneId, lane] of this._laneStatuses) {
			statuses.push({
				laneId,
				status: lane.status,
				taskIds: lane.taskIds,
				agent: lane.agent,
				sessionId: lane.sessionId,
				error: lane.error,
			});
		}

		return statuses;
	}

	/**
	 * Release all lane locks and mark unresolved lanes as blocked.
	 *
	 * Call this on error exit or when shutting down a phase early.
	 * Releases ALL locks and transitions ALL running/pending lanes to blocked.
	 */
	async cleanup(): Promise<void> {
		// Release all held lane locks
		for (const [laneId] of Object.entries(this._laneLockMap)) {
			try {
				await LeanTurboRunner._internals.releaseLaneLocks(
					this._directory,
					laneId,
				);
			} catch {
				// Best-effort cleanup — continue with other lanes
			}
		}

		this._laneLockMap = {};

		// Remove worktrees for lanes that were active
		for (const [_laneId, lane] of this._laneStatuses) {
			if (lane.worktreePath) {
				try {
					await LeanTurboRunner._internals.removeWorktree(
						lane.worktreePath,
						this._directory,
						{ force: true, worktreeDir: this._leanConfig?.worktree_dir },
					);
				} catch {
					// Best-effort cleanup
				}
			}
		}

		// Update durable state to reflect released lanes
		// Use _withStateLock to prevent races with concurrent lane status updates
		await this._withStateLock(async () => {
			const runState = LeanTurboRunner._internals.loadLeanTurboRunState(
				this._directory,
				this._sessionID,
			);
			if (runState) {
				// Only block lanes that are still running or pending.
				// Completed and failed lanes reached their final state — leave them.
				runState.lanes = runState.lanes.map((lane) =>
					lane.status === 'running' || lane.status === 'pending'
						? { ...lane, status: 'blocked' as const }
						: lane,
				);
				LeanTurboRunner._internals.saveLeanTurboRunState(
					this._directory,
					runState,
				);
			}
		});
	}

	/**
	 * Cleanup after a successful phase run.
	 *
	 * Only releases locks for lanes that reached a terminal state (completed,
	 * failed, blocked). Does NOT change lane statuses — running lanes stay running.
	 */
	async cleanupAfterSuccess(): Promise<void> {
		// Release locks only for terminal lanes
		for (const [laneId] of Object.entries(this._laneLockMap)) {
			const laneStatus = this._laneStatuses.get(laneId);
			if (
				laneStatus &&
				(laneStatus.status === 'completed' ||
					laneStatus.status === 'failed' ||
					laneStatus.status === 'blocked')
			) {
				try {
					await LeanTurboRunner._internals.releaseLaneLocks(
						this._directory,
						laneId,
					);
				} catch {
					// Best-effort cleanup
				}
				delete this._laneLockMap[laneId];
			}
		}
	}

	/**
	 * Cleanup after a failed phase run.
	 *
	 * Current behavior: releases ALL locks, marks all unresolved lanes blocked.
	 */
	async cleanupAfterFailure(): Promise<void> {
		return this.cleanup();
	}

	// ─── Private Helpers ────────────────────────────────────────────────────────

	/**
	 * Resolve the list of available coder agent names.
	 *
	 * Prefers agents matching swarm prefix patterns (e.g. `mega_coder`)
	 * over bare `coder`. Falls back to `['coder']` if no coder agents found.
	 */
	private _resolveCoderAgents(names: readonly string[]): string[] {
		// Filter to coder-role agents
		const coders = names.filter((n) => n.toLowerCase().includes('coder'));

		if (coders.length === 0) {
			return ['coder'];
		}

		// Sort: prefixed coders first (e.g. mega_coder > coder)
		// A "prefixed" coder has underscore or hyphen before "coder"
		const prefixed = coders.filter(
			(n) => /[_-]coder$/i.test(n) || /^[a-z]+_[a-z]+_coder$/i.test(n),
		);
		const bare = coders.filter(
			(n) => !n.includes('_') && !n.includes('-') && n === 'coder',
		);

		// Prefixed coders first, then bare coders
		const sorted = [...prefixed.sort((a, b) => b.length - a.length), ...bare];

		// Deduplicate while preserving order
		const seen = new Set<string>();
		const deduped: string[] = [];
		for (const name of sorted) {
			if (!seen.has(name.toLowerCase())) {
				seen.add(name.toLowerCase());
				deduped.push(name);
			}
		}

		return deduped.length > 0 ? deduped : ['coder'];
	}

	/**
	 * Get the Lean Turbo configuration.
	 *
	 * The config is passed to runPhase (from plugin config or caller).
	 * If not provided, sensible defaults are used.
	 */
	private _getLeanConfig(config?: LeanTurboConfig): LeanTurboConfig {
		if (config) {
			// Deep clone the merged config to prevent shared-reference mutations
			// to nested runtime_isolation (env_overrides, cache_redirects).
			return structuredClone({ ...DEFAULT_LEAN_TURBO_CONFIG, ...config });
		}
		return { ...DEFAULT_LEAN_TURBO_CONFIG };
	}

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
	private async _processLane(
		lane: LeanTurboLane,
		leanConfig: LeanTurboConfig,
		plan?: Plan,
	): Promise<LaneResult> {
		// Update status to running
		const laneInState = this._laneStatuses.get(lane.laneId);
		if (laneInState) {
			laneInState.status = 'running';
			laneInState.startedAt = new Date().toISOString();
		}

		// Acquire locks for all files in this lane
		// Use first task's ID as the representative taskId for lock metadata
		const taskId = lane.taskIds[0] ?? lane.laneId;
		const agent = this._selectNextAgent();

		const lockResult = await LeanTurboRunner._internals.acquireLaneLocks(
			this._directory,
			lane.laneId,
			lane.files,
			agent,
			taskId,
			this._sessionID,
		);

		if (!lockResult.acquired) {
			// Bug #4: Route the lane's task IDs into the serialized tasks set
			// so they get completed via standard serial flow
			await this._withStateLock(async () => {
				try {
					const runState = LeanTurboRunner._internals.loadLeanTurboRunState(
						this._directory,
						this._sessionID,
					);
					if (runState) {
						const existingSerialized = new Set(runState.serializedTasks ?? []);
						for (const tid of lane.taskIds) {
							existingSerialized.add(tid);
						}
						runState.serializedTasks = Array.from(existingSerialized);
						runState.counters.tasksSerialized += lane.taskIds.length;
						LeanTurboRunner._internals.saveLeanTurboRunState(
							this._directory,
							runState,
						);
					}
				} catch {
					// Non-fatal — state update failure should not block lane processing
				}
			});

			// Mark lane as failed due to lock conflict — tasks routed to serial fallback.
			// Use 'failed' (not 'blocked') so phase-ready treats this lane as settled.
			if (laneInState) {
				laneInState.status = 'failed';
				laneInState.error = 'lock conflict - tasks routed to serial fallback';
			}
			await this._updateDurableStateLaneStatus(lane.laneId, 'failed');

			return {
				laneId: lane.laneId,
				status: 'failed',
				taskIds: lane.taskIds,
				error: 'lock conflict - tasks routed to serial fallback',
			};
		}

		// Track locked files for cleanup
		this._laneLockMap[lane.laneId] = [...lane.files];

		// Worktree provisioning (if enabled)
		let worktreeDirectory: string | undefined;
		if (leanConfig.worktree_isolation) {
			let provisionError: string | undefined;
			try {
				const provisionResult =
					await LeanTurboRunner._internals.provisionWorktree(
						this._directory,
						lane.laneId,
						this._sessionID,
						leanConfig,
					);
				if ('worktreePath' in provisionResult) {
					worktreeDirectory = provisionResult.worktreePath;
					// Track in state and persist to durable storage
					if (laneInState) {
						laneInState.worktreePath = provisionResult.worktreePath;
						laneInState.branchName = provisionResult.branchName;
					}
					await this._persistLaneWorktreeFields(
						lane.laneId,
						provisionResult.worktreePath,
						provisionResult.branchName,
					);
				} else {
					provisionError = provisionResult.error;
				}
			} catch (provisionErr) {
				provisionError =
					provisionErr instanceof Error
						? provisionErr.message
						: String(provisionErr);
			}

			// Retry once for transient errors, fail immediately for permanent ones
			if (provisionError) {
				if (isTransientProvisionError(provisionError)) {
					log(
						`[lean-turbo] worktree provision failed for lane ${lane.laneId}: ${provisionError} — retrying once...`,
					);
					await new Promise<void>((r) => setTimeout(r, 100));
					try {
						const retryResult =
							await LeanTurboRunner._internals.provisionWorktree(
								this._directory,
								lane.laneId,
								this._sessionID,
								leanConfig,
							);
						if ('worktreePath' in retryResult) {
							worktreeDirectory = retryResult.worktreePath;
							if (laneInState) {
								laneInState.worktreePath = retryResult.worktreePath;
								laneInState.branchName = retryResult.branchName;
							}
							await this._persistLaneWorktreeFields(
								lane.laneId,
								retryResult.worktreePath,
								retryResult.branchName,
							);
							log(
								`[lean-turbo] worktree provision retry succeeded for lane ${lane.laneId}`,
							);
							// Retry succeeded — clear provisionError so we don't fail below
							provisionError = undefined;
						} else {
							// Retry returned an error — keep provisionError set
							provisionError = retryResult.error;
							log(
								`[lean-turbo] worktree provision retry failed for lane ${lane.laneId}: ${retryResult.error}`,
							);
						}
					} catch (retryErr) {
						const retryMsg =
							retryErr instanceof Error ? retryErr.message : String(retryErr);
						// Retry threw — keep provisionError set
						log(
							`[lean-turbo] worktree provision retry threw for lane ${lane.laneId}: ${retryMsg}`,
						);
					}
				} else {
					// Permanent error — log and fail (no retry)
					log(
						`[lean-turbo] worktree provision failed for lane ${lane.laneId}: ${provisionError}`,
					);
				}
			}

			// After retry, if worktreeDirectory is still undefined, the lane cannot
			// proceed under worktree isolation — fail explicitly rather than silently
			// degrading to the shared directory (which would break the isolation contract).
			if (!worktreeDirectory) {
				const failMsg = `worktree provision failed: ${provisionError ?? 'unknown error'}`;

				// Release locks — this lane will not proceed
				try {
					await LeanTurboRunner._internals.releaseLaneLocks(
						this._directory,
						lane.laneId,
					);
				} catch {
					// Best-effort
				}
				delete this._laneLockMap[lane.laneId];

				if (laneInState) {
					laneInState.status = 'failed';
					laneInState.error = failMsg;
				}
				await this._updateDurableStateLaneStatus(lane.laneId, 'failed');

				// Write evidence for failed lane
				await this._writeLaneEvidenceSafely(lane, 'failed', {
					status: 'failed',
					error: failMsg,
					agent,
				});

				return {
					laneId: lane.laneId,
					status: 'failed',
					taskIds: lane.taskIds,
					agent,
					error: failMsg,
				};
			}
		}

		// Dispatch to selected agent.
		// #1896: on a transient/quota PROVIDER error, fail over to a configured
		// coder fallback_model instead of failing the lane outright. Lane-level
		// timeouts are NOT provider-transient and keep their existing fail-the-lane
		// behavior (classified permanent below).
		const coderBase = stripKnownSwarmPrefix(agent);
		const coderSwarmId =
			coderBase !== agent
				? agent.slice(0, agent.length - coderBase.length - 1)
				: undefined;
		const coderSwarmAgents = getSwarmAgents(coderSwarmId);
		let dispatchResult: LaneDispatchResult;
		try {
			const fb = await dispatchWithModelFallback<LaneDispatchResult>({
				dispatch: async (model) => {
					const r = await this.dispatchLane(
						lane,
						agent,
						worktreeDirectory,
						model,
						plan,
					);
					if (!r.ok) throw new Error(r.error ?? 'lane dispatch failed');
					return r;
				},
				scope: this._sessionID
					? {
							sessionID: this._sessionID,
							invocationID: `lean-runner:${lane.laneId}`,
							swarmID: coderSwarmId,
							role: coderBase,
						}
					: undefined,
				primaryModel: coderSwarmAgents?.[coderBase]?.model,
				fallbackModels: coderSwarmAgents?.[coderBase]?.fallback_models ?? [],
				resolveFallback: (index) =>
					resolveFallbackModel(coderBase, index, coderSwarmAgents),
				// Advance immediately on a transient/quota error — an instant
				// same-model retry cannot clear an exhausted quota.
				maxTransientRetriesPerModel: 0,
				classify: (err) => {
					const msg = err instanceof Error ? err.message : String(err);
					// A lane-level dispatch timeout is not a provider transient — keep
					// the existing fail-the-lane behavior instead of failing over.
					if (/Lane dispatch timed out/i.test(msg)) return 'permanent';
					// Issue #2002: a failed write-authority handshake is a local
					// invariant break, never a provider blip. Retrying it on another
					// model would create another unscoped lane session.
					if (msg.includes(LANE_SCOPE_DENIED_CODE)) return 'permanent';
					return isTransientProviderError(msg) ? 'transient' : 'permanent';
				},
				onFallback: ({ toModel, fallbackIndex }) => {
					telemetry.modelFallback(
						this._sessionID ?? '',
						agent,
						coderSwarmAgents?.[coderBase]?.model ?? 'default',
						toModel,
						'transient_model_error',
					);
					const session = this._sessionID
						? getAgentSession(this._sessionID)
						: undefined;
					if (session) {
						pushAdvisory(
							session,
							`MODEL FALLBACK: coder lane ${lane.laneId} failed over to "${toModel}" (fallback ${fallbackIndex}) after a transient/quota dispatch error.`,
						);
					}
				},
			});
			dispatchResult = fb.result;
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			dispatchResult = {
				ok: false,
				error: isQuotaError(msg)
					? `${msg} (model quota/usage limit exhausted across all configured fallbacks)`
					: msg,
			};
		}

		if (!dispatchResult.ok) {
			// Dispatch failed — release locks immediately
			try {
				await LeanTurboRunner._internals.releaseLaneLocks(
					this._directory,
					lane.laneId,
				);
			} catch {
				// Best-effort
			}
			delete this._laneLockMap[lane.laneId];

			// Mark lane as needing failure cleanup in sequential post-processing.
			// Do NOT call attemptMergeBackFromDirty / removeWorktree here because
			// this runs inside Promise.all (concurrent lanes) and concurrent git
			// mutations on the shared .git index cause race conditions.
			if (worktreeDirectory && laneInState) {
				laneInState._failureCleanupPending = true;
			}

			if (laneInState) {
				laneInState.status = 'failed';
				laneInState.error = dispatchResult.error;
			}
			await this._updateDurableStateLaneStatus(lane.laneId, 'failed');

			// Write evidence for failed lane
			await this._writeLaneEvidenceSafely(lane, 'failed', {
				status: 'failed',
				error: dispatchResult.error,
				agent,
			});

			return {
				laneId: lane.laneId,
				status: 'failed',
				taskIds: lane.taskIds,
				agent,
				error: dispatchResult.error,
			};
		}

		// Bug #2: Dispatch succeeded — session.prompt() resolved (coder finished).
		// Transition lane to 'completed' since the awaited dispatch means the
		// coder session has completed its work.
		const completedAt = new Date().toISOString();
		if (laneInState) {
			laneInState.status = 'completed';
			laneInState.agent = agent;
			laneInState.sessionId = dispatchResult.sessionId;
			laneInState.completedAt = completedAt;
		}
		await this._updateDurableStateLaneStatus(lane.laneId, 'completed');

		// Release locks for the completed lane
		try {
			await LeanTurboRunner._internals.releaseLaneLocks(
				this._directory,
				lane.laneId,
			);
		} catch {
			// Best-effort
		}
		delete this._laneLockMap[lane.laneId];

		// Write evidence for completed lane
		await this._writeLaneEvidenceSafely(lane, 'completed', {
			status: 'completed',
			agent,
			sessionId: dispatchResult.sessionId,
			completedAt,
		});

		return {
			laneId: lane.laneId,
			status: 'completed',
			taskIds: lane.taskIds,
			agent,
			sessionId: dispatchResult.sessionId,
		};
	}

	/**
	 * Persist a durable recovery record for a merge-back / dispatch failure (#1657).
	 *
	 * Wraps `writeRecoveryRecord` (best-effort, non-fatal) with this session's
	 * id and portable human recovery guidance. Called from every failure branch of
	 * `_sequentialWorktreeCleanup`. Records are auto-cleared on successful
	 * merge-back so they exist only while a lane is preserved.
	 */
	private _persistRecovery(info: MergeBackFailureInfo): void {
		writeRecoveryRecord(this._directory, {
			laneId: info.laneId,
			sessionId: this._sessionID,
			branchName: info.branchName,
			worktreePath: info.worktreePath,
			status: info.status,
			reason: info.reason,
			conflictFiles: info.conflictFiles,
			// F-006: shell quoting is platform-specific. Keep the filesystem path
			// in the structured worktreePath field and give portable human
			// guidance instead of synthesizing an executable `cd` command.
			replayHint:
				'Open the directory in worktreePath and run git status with that directory as the working directory.',
		});
	}

	/**
	 * Sequential worktree cleanup for completed and failed worktree lanes.
	 *
	 * Runs AFTER all lanes have been dispatched and completed via Promise.all.
	 * Each worktree lane is processed one at a time, preventing concurrent
	 * git merge/rebase/cherry-pick from corrupting the shared .git index.
	 *
	 * - **Success lanes**: mergeLaneBranch → removeWorktree → postMergeCleanup
	 * - **Success lanes with merge failure**: log warning, keep worktree, update lane result
	 * - **Failed lanes**: attemptMergeBackFromDirty → removeWorktree
	 *
	 * @returns Array of MergeBackFailureInfo for lanes where merge-back failed
	 */
	private async _sequentialWorktreeCleanup(
		laneResults: LaneResult[],
		leanConfig: LeanTurboConfig,
	): Promise<MergeBackFailureInfo[]> {
		const mergeBackFailures: MergeBackFailureInfo[] = [];

		for (const lr of laneResults) {
			const laneInState = this._laneStatuses.get(lr.laneId);
			if (!laneInState?.worktreePath) continue;

			let needsPostMergeCleanup = false;

			if (lr.status === 'completed') {
				// Success path: commit dirty lane work, clean untracked files, then
				// merge the lane branch back into HEAD.
				if (!laneInState.branchName) continue;

				try {
					const strategy =
						LeanTurboRunner._internals.getMergeStrategy(leanConfig);
					const mergeResult =
						await LeanTurboRunner._internals.attemptMergeBackFromDirty(
							laneInState.worktreePath,
							laneInState.branchName,
							this._directory,
							strategy,
						);
					if ('merged' in mergeResult && mergeResult.merged) {
						// Mark for post-merge cleanup AFTER worktree removal (branch delete
						// fails while the branch is still checked out in an active worktree).
						needsPostMergeCleanup = true;

						// #1657: clear any prior recovery record for this lane now that it
						// merged cleanly, so recovery records don't accumulate. (A record
						// exists only while a lane is preserved; auto-clear on success.)
						clearRecoveryRecord(this._directory, lr.laneId, this._sessionID);

						// FR-205 SC-134: Remove lane profile at successful merge-back.
						// Best-effort — non-fatal if removal fails (e.g. file already gone).
						const leanLaneIndex = parseLeanLaneIndex(lr.laneId);
						try {
							await LeanTurboRunner._internals.removeLaneProfileFromDisk(
								laneInState.worktreePath,
								leanLaneIndex,
							);
						} catch {
							/* non-fatal */
						}
					} else if (
						('conflict' in mergeResult && mergeResult.conflict) ||
						('partial' in mergeResult && mergeResult.partial)
					) {
						// Merge conflict or partial failure: log warning, do NOT remove worktree, record failure
						const conflictFiles =
							'conflictFiles' in mergeResult &&
							Array.isArray(
								(mergeResult as { conflictFiles?: unknown }).conflictFiles,
							)
								? (mergeResult as { conflictFiles: string[] }).conflictFiles
								: [];
						// attemptMergeBackFromDirty's DirtyMergePartial result never sets a
						// `conflict` field (only mergeLaneBranch's MergeConflict does) — it
						// signals a real conflict via non-empty `conflictFiles` instead. Without
						// this, every dirty-worktree merge conflict was misclassified as
						// 'partial' rather than 'conflict'.
						const isConflict =
							('conflict' in mergeResult && mergeResult.conflict === true) ||
							conflictFiles.length > 0;
						const reason =
							('message' in mergeResult &&
								typeof (mergeResult as { message?: unknown }).message ===
									'string' &&
								((mergeResult as { message: string }).message || '')) ||
							'merge-back partially failed';
						const failureInfo: MergeBackFailureInfo = {
							laneId: lr.laneId,
							branchName: laneInState.branchName,
							worktreePath: laneInState.worktreePath,
							status: isConflict ? 'conflict' : 'partial',
							reason,
							conflictFiles,
						};
						mergeBackFailures.push(failureInfo);
						lr.status = 'failed';
						lr.error = failureInfo.reason;
						lr.mergeBackFailure = failureInfo;
						laneInState.status = 'failed';
						laneInState.error = failureInfo.reason;
						await this._updateDurableStateLaneStatus(lr.laneId, 'failed');
						await this._writeLaneEvidenceSafely(
							{
								laneId: lr.laneId,
								taskIds: lr.taskIds,
								files: [],
								status: 'failed',
							},
							'failed',
							{
								status: 'failed',
								error: failureInfo.reason,
								mergeBackFailure: failureInfo,
							},
						);
						// #1657: persist a durable recovery record so the preserved
						// worktree/branch survives session end + orphan cleanup, and
						// /swarm status can surface it.
						this._persistRecovery(failureInfo);
						log(
							`[lean-turbo] merge-back PARTIAL for lane ${lr.laneId}: ${failureInfo.reason} — worktree preserved at ${laneInState.worktreePath} for manual recovery`,
						);
						continue; // Skip removeWorktree — keep worktree for manual recovery
					} else if ('failed' in mergeResult && mergeResult.failed) {
						const failureInfo: MergeBackFailureInfo = {
							laneId: lr.laneId,
							branchName: laneInState.branchName,
							worktreePath: laneInState.worktreePath,
							status: 'failed',
							reason: mergeResult.message,
						};
						mergeBackFailures.push(failureInfo);
						lr.status = 'failed';
						lr.error = failureInfo.reason;
						lr.mergeBackFailure = failureInfo;
						laneInState.status = 'failed';
						laneInState.error = failureInfo.reason;
						await this._updateDurableStateLaneStatus(lr.laneId, 'failed');
						await this._writeLaneEvidenceSafely(
							{
								laneId: lr.laneId,
								taskIds: lr.taskIds,
								files: [],
								status: 'failed',
							},
							'failed',
							{
								status: 'failed',
								error: failureInfo.reason,
								mergeBackFailure: failureInfo,
							},
						);
						log(
							`[lean-turbo] merge-back ERROR for lane ${lr.laneId}: ${failureInfo.reason} — worktree preserved at ${laneInState.worktreePath} for manual recovery`,
						);
						// #1657: persist durable recovery record (same rationale as the
						// partial-conflict branch above).
						this._persistRecovery(failureInfo);
						continue; // Skip removeWorktree — keep worktree for manual recovery
					}
				} catch (err) {
					// Unexpected error during merge — log but do NOT remove worktree
					const errMsg = err instanceof Error ? err.message : String(err);
					const failureInfo: MergeBackFailureInfo = {
						laneId: lr.laneId,
						branchName: laneInState.branchName,
						worktreePath: laneInState.worktreePath,
						status: 'failed',
						reason: errMsg,
					};
					mergeBackFailures.push(failureInfo);
					lr.status = 'failed';
					lr.error = failureInfo.reason;
					lr.mergeBackFailure = failureInfo;
					laneInState.status = 'failed';
					laneInState.error = failureInfo.reason;
					await this._updateDurableStateLaneStatus(lr.laneId, 'failed');
					await this._writeLaneEvidenceSafely(
						{
							laneId: lr.laneId,
							taskIds: lr.taskIds,
							files: [],
							status: 'failed',
						},
						'failed',
						{
							status: 'failed',
							error: failureInfo.reason,
							mergeBackFailure: failureInfo,
						},
					);
					log(
						`[lean-turbo] merge-back EXCEPTION for lane ${lr.laneId}: ${errMsg} — worktree preserved at ${laneInState.worktreePath} for manual recovery`,
					);
					// #1657: persist durable recovery record.
					this._persistRecovery(failureInfo);
					continue; // Skip removeWorktree — keep worktree for manual recovery
				}
			} else if (lr.status === 'failed' && laneInState._failureCleanupPending) {
				const failureInfo: MergeBackFailureInfo = {
					laneId: lr.laneId,
					branchName: laneInState.branchName,
					worktreePath: laneInState.worktreePath,
					status: 'failed',
					reason:
						lr.error ||
						'Lane failed before completion; worktree preserved without merge-back',
				};
				mergeBackFailures.push(failureInfo);
				lr.mergeBackFailure = failureInfo;
				log(
					`[lean-turbo] failed lane ${lr.laneId}: ${failureInfo.reason} — worktree preserved at ${laneInState.worktreePath}; not merging partial work`,
				);
				// #1657: persist durable recovery record.
				this._persistRecovery(failureInfo);
				continue; // Keep failed lane worktree for manual inspection.
			}

			// Only lanes that are safe to clean up remove their worktree. Failed
			// merge-back and failed dispatch lanes are preserved for manual recovery.
			try {
				await LeanTurboRunner._internals.removeWorktree(
					laneInState.worktreePath,
					this._directory,
					{ force: true, worktreeDir: leanConfig.worktree_dir },
				);
			} catch {
				// Best-effort cleanup
			}

			// Post-merge cleanup (branch delete + prune) must happen AFTER
			// removeWorktree because git refuses to delete a branch that is
			// still checked out in an active worktree.
			if (needsPostMergeCleanup && laneInState.branchName) {
				try {
					await LeanTurboRunner._internals.postMergeCleanup(
						this._directory,
						laneInState.branchName,
					);
				} catch {
					// Best-effort — branch/prune cleanup is not critical
				}
			}
		}

		return mergeBackFailures;
	}

	private _buildIntegratedDiffSummary(
		lanePlan: LeanTurboLanePlan,
		laneResults: LaneResult[],
		mergeBackFailures: MergeBackFailureInfo[] = [],
	): string {
		const resultByLane = new Map(
			laneResults.map((lane) => [lane.laneId, lane]),
		);
		const files = new Set<string>();
		for (const lane of lanePlan.lanes) {
			for (const file of lane.files) files.add(file);
		}

		const completed = laneResults.filter(
			(lane) => lane.status === 'completed',
		).length;
		const failed = laneResults.filter(
			(lane) => lane.status === 'failed',
		).length;
		const blocked = laneResults.filter(
			(lane) => lane.status === 'blocked',
		).length;
		const fileList = [...files].sort();
		const displayedFiles = fileList.slice(0, 50);
		const hiddenFileCount = Math.max(
			0,
			fileList.length - displayedFiles.length,
		);
		const lines = [
			`Lean Turbo phase ${lanePlan.phase}: ${completed}/${lanePlan.lanes.length} lanes completed, ${failed} failed, ${blocked} blocked.`,
			`Files declared changed (${fileList.length}): ${
				displayedFiles.length > 0 ? displayedFiles.join(', ') : 'none'
			}${hiddenFileCount > 0 ? `, ... +${hiddenFileCount} more` : ''}.`,
		];

		if (lanePlan.serializedTasks.length > 0) {
			lines.push(
				`Serialized tasks pending standard execution: ${lanePlan.serializedTasks.join(', ')}.`,
			);
		}
		if (lanePlan.degradedTasks.length > 0) {
			lines.push(
				`Degraded tasks: ${lanePlan.degradedTasks.map((task) => `${task.taskId} (${task.reason})`).join(', ')}.`,
			);
		}
		if (mergeBackFailures.length > 0) {
			lines.push(
				`Merge-back failures: ${mergeBackFailures.map((failure) => `${failure.laneId}: ${failure.reason}`).join('; ')}.`,
			);
		}
		for (const lane of lanePlan.lanes) {
			const result = resultByLane.get(lane.laneId);
			if (result?.error) {
				lines.push(`${lane.laneId} error: ${result.error}.`);
			}
		}

		return lines.join('\n');
	}

	private async _writePhaseEvidenceSafely(args: {
		phaseNumber: number;
		plan: { swarm?: string; title?: string };
		lanePlan: LeanTurboLanePlan;
		laneResults: LaneResult[];
		leanConfig: LeanTurboConfig;
		status: PhaseEvidence['status'];
		startedAt: string;
		mergeBackFailures?: MergeBackFailureInfo[];
	}): Promise<void> {
		const completedAt = new Date().toISOString();
		const resultByLane = new Map(
			args.laneResults.map((lane) => [lane.laneId, lane]),
		);
		const lanes: LaneEvidence[] = args.lanePlan.lanes.map((lane) => {
			const result = resultByLane.get(lane.laneId);
			const evidenceLane: LaneEvidence = {
				laneId: lane.laneId,
				taskIds: lane.taskIds,
				files: lane.files,
				status: result?.status ?? lane.status,
				startedAt: lane.startedAt,
				completedAt:
					result?.status === 'completed' || result?.status === 'failed'
						? (lane.completedAt ?? completedAt)
						: lane.completedAt,
				error: result?.error ?? lane.error,
				agent: result?.agent ?? lane.agent,
				sessionId: result?.sessionId ?? lane.sessionId,
			};
			if (result?.mergeBackFailure) {
				evidenceLane.mergeBackFailure = result.mergeBackFailure;
			}
			return evidenceLane;
		});
		const planId =
			args.lanePlan.planId ||
			derivePlanId({
				swarm: args.plan.swarm ?? 'default',
				title: args.plan.title ?? 'Untitled Plan',
			});
		const evidence: PhaseEvidence = {
			phase: args.phaseNumber,
			planId,
			lanes,
			degradedTasks: args.lanePlan.degradedTasks.map((task) => ({
				taskId: task.taskId,
				reason: task.reason,
			})),
			startedAt: args.startedAt,
			completedAt,
			status: args.status,
			evidencePaths: lanes.map(
				(lane) =>
					`.swarm/evidence/${args.phaseNumber}/lean-turbo/${lane.laneId}.json`,
			),
			integratedDiffSummary: this._buildIntegratedDiffSummary(
				args.lanePlan,
				args.laneResults,
				args.mergeBackFailures ?? [],
			),
			configSnapshot: args.leanConfig,
			timestamp: completedAt,
		};

		try {
			await LeanTurboRunner._internals.writePhaseEvidence(
				this._directory,
				evidence,
			);
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			log(`[lean-turbo] phase evidence write failed: ${msg}`);
		}
	}

	/**
	 * Select the next available agent using round-robin.
	 */
	private _selectNextAgent(): string {
		if (this._availableAgents.length === 0) {
			return 'coder';
		}
		const agent =
			this._availableAgents[this._agentIndex % this._availableAgents.length];
		this._agentIndex++;
		return agent;
	}

	/**
	 * Write lane evidence with retry logic for transient disk errors.
	 *
	 * Evidence is required by phase-ready (step 4b) to verify lane completion.
	 * Transient I/O errors are retried with exponential backoff; permanent errors
	 * are logged and dropped (evidence failure is non-fatal for runner operation).
	 */
	private async _writeLaneEvidenceSafely(
		lane: LeanTurboLane,
		status: LaneEvidence['status'],
		extras: Partial<LaneEvidence>,
	): Promise<void> {
		const maxAttempts = 3;
		const baseDelayMs = 100;

		for (let attempt = 0; attempt < maxAttempts; attempt++) {
			try {
				const evidence: LaneEvidence = {
					laneId: lane.laneId,
					taskIds: lane.taskIds,
					files: lane.files,
					status,
					startedAt: lane.startedAt,
					...extras,
				};
				// Determine phase from the lane plan — use the stored phase if available
				const runState = LeanTurboRunner._internals.loadLeanTurboRunState(
					this._directory,
					this._sessionID,
				);
				const phase = runState?.phase;
				if (phase === undefined) {
					log(
						`[lean-turbo] evidence write skipped for lane ${lane.laneId}: phase not set in run state`,
					);
					return;
				}
				await LeanTurboRunner._internals.writeLaneEvidence(
					this._directory,
					phase,
					evidence,
				);
				return; // Success
			} catch (error) {
				const errCode =
					error instanceof Error
						? ((error as NodeJS.ErrnoException).code ?? '')
						: '';
				const isTransient =
					errCode.length > 0 &&
					// EACCES omitted: permission denied on a swarm evidence path is a
					// permanent misconfiguration — retrying wastes time without recovery.
					// EROFS omitted: read-only filesystem is also permanent.
					[
						'ENOENT',
						'EBUSY',
						'EPERM',
						'EIO',
						'EAGAIN',
						'ETIMEDOUT',
						'ENOSPC',
					].includes(errCode);

				if (attempt < maxAttempts - 1 && isTransient) {
					// Transient error — retry with exponential backoff
					const delayMs = baseDelayMs * 2 ** attempt;
					await new Promise((resolve) => setTimeout(resolve, delayMs));
					continue;
				}

				// Permanent error or last attempt — log but don't fail the runner
				const msg = error instanceof Error ? error.message : String(error);
				log(
					`[lean-turbo] evidence write failed for lane ${lane.laneId}: ${msg}`,
				);
				return;
			}
		}
	}

	/**
	 * Build a human-readable prompt describing a lane's tasks.
	 */
	private _buildLanePrompt(lane: LeanTurboLane): string {
		const taskList = lane.taskIds.map((id) => `  - ${id}`).join('\n');

		const fileList = lane.files.map((f) => `  - ${f}`).join('\n');

		return (
			`You are assigned to implement the following task(s) in lane "${lane.laneId}".\n\n` +
			`Task IDs:\n${taskList}\n\n` +
			`Files in scope:\n${fileList}\n\n` +
			`Implement each task fully. Use the tools available to you (write, edit, etc.).\n` +
			`When all tasks are complete, signal completion.`
		);
	}

	/**
	 * Serializes access to durable state via a promise chain AND file-based lock.
	 *
	 * - Promise chain: serializes writes within a single runner instance
	 * - File-based lock: coordinates between multiple runners with the same sessionID
	 *
	 * Timeout budget starts when this call reaches the front of the queue (execution
	 * time), not when it is enqueued. withTurboStateLock computes its deadline
	 * internally on entry, so each caller gets a full 10-second window regardless
	 * of how long it waited behind prior entries.
	 *
	 * Timeout coverage: withTurboStateLock is tested directly in state-lock.test.ts
	 * (test: "throws TurboStateLockTimeoutError when lock is held by another caller").
	 * This wrapper delegates to it in a single line with no additional timeout logic,
	 * so a separate wrapper-level timeout test would duplicate that coverage.
	 */
	private async _withStateLock<T>(fn: () => Promise<T>): Promise<T> {
		const chain = this._stateLock.then(() =>
			withTurboStateLock(this._directory, this._sessionID, fn, 10_000),
		);
		this._stateLock = chain.catch(() => {});
		return chain;
	}

	/**
	 * Update durable state with the full lane plan (called once per phase).
	 */
	private async _updateDurableState(
		lanePlan: LeanTurboLanePlan,
	): Promise<void> {
		try {
			let runState = LeanTurboRunner._internals.loadLeanTurboRunState(
				this._directory,
				this._sessionID,
			);

			if (!runState) {
				// Bootstrap minimal state
				runState = {
					status: 'running',
					sessionID: this._sessionID,
					strategy: 'lean',
					maxParallelCoders: 4,
					lanes: [],
					degradedTasks: [],
					serializedTasks: [],
					counters: {
						lanesPlanned: 0,
						lanesStarted: 0,
						lanesCompleted: 0,
						lanesFailed: 0,
						tasksSerialized: 0,
						tasksDegraded: 0,
					},
				};
			}

			runState.status = 'running';
			runState.phase = lanePlan.phase;
			runState.planId = lanePlan.planId;
			runState.activeLanePlanId = lanePlan.planId;
			runState.lanes = lanePlan.lanes.map((l) => ({ ...l }));
			runState.degradedTasks = lanePlan.degradedTasks;
			runState.serializedTasks = lanePlan.serializedTasks;
			runState.counters = { ...lanePlan.counters };

			LeanTurboRunner._internals.saveLeanTurboRunState(
				this._directory,
				runState,
			);
		} catch {
			// Durable state write failure is non-fatal for runner operation
		}
	}

	/**
	 * Persist a lane's worktreePath and branchName to durable state.
	 *
	 * Called after provisioning so that after a crash/restart these fields
	 * are recoverable from turbo-state.json.
	 */
	private async _persistLaneWorktreeFields(
		laneId: string,
		worktreePath: string,
		branchName: string,
	): Promise<void> {
		await this._withStateLock(async () => {
			try {
				const runState = LeanTurboRunner._internals.loadLeanTurboRunState(
					this._directory,
					this._sessionID,
				);
				if (!runState) return;

				const lane = runState.lanes.find((l) => l.laneId === laneId);
				if (lane) {
					lane.worktreePath = worktreePath;
					lane.branchName = branchName;
					LeanTurboRunner._internals.saveLeanTurboRunState(
						this._directory,
						runState,
					);
				}
			} catch {
				// Non-fatal — worktree metadata loss is recoverable via orphan cleanup
			}
		});
	}

	/**
	 * Update a single lane's status in durable state.
	 * Serialized through _withStateLock to prevent race conditions with concurrent lanes.
	 */
	private async _updateDurableStateLaneStatus(
		laneId: string,
		status: LeanTurboLane['status'],
	): Promise<void> {
		await this._withStateLock(async () => {
			try {
				const runState = LeanTurboRunner._internals.loadLeanTurboRunState(
					this._directory,
					this._sessionID,
				);
				if (!runState) return;

				const lane = runState.lanes.find((l) => l.laneId === laneId);
				if (lane) {
					lane.status = status;
					if (status === 'running') {
						runState.counters.lanesStarted++;
					} else if (status === 'completed') {
						runState.counters.lanesCompleted++;
					} else if (status === 'failed') {
						runState.counters.lanesFailed++;
					}
				}

				LeanTurboRunner._internals.saveLeanTurboRunState(
					this._directory,
					runState,
				);
			} catch {
				// Non-fatal
			}
		});
	}
}

// ─── Exported Types ───────────────────────────────────────────────────────────────

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
