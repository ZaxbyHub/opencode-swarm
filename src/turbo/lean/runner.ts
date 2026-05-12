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
import { DEFAULT_LEAN_TURBO_CONFIG } from '../../config/constants';
import type { LeanTurboConfig } from '../../config/schema';
import { loadFullAutoRunState } from '../../full-auto/state';
import { acquireLaneLocks, releaseLaneLocks } from '../../parallel/file-locks';
import { loadPlanJsonOnly } from '../../plan/manager';
import { hasActiveFullAuto, swarmState } from '../../state';
import type { LaneEvidence } from './evidence';
import { writeLaneEvidence } from './evidence';
import type { LeanTurboLanePlan } from './planner';
import { planLeanTurboLanes } from './planner';
import type { LeanTurboLane } from './state';
import { loadLeanTurboRunState, saveLeanTurboRunState } from './state';

/**
 * Shape of the OpencodeClient session API used by the runner.
 * Extracted into an interface so tests can inject a mock without
 * requiring the full SDK type.
 */
interface SessionClient {
	create(options: { query: { directory: string } }): Promise<{
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
	}): Promise<{
		data: { parts: Array<{ type: string; text?: string }> } | null;
		error: unknown;
	}>;
	delete(options: { path: { id: string } }): Promise<void>;
}

// ─── Result Types ─────────────────────────────────────────────────────────────

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

// ─── Internal Types ───────────────────────────────────────────────────────────

/**
 * Maps laneId → list of file paths locked for that lane.
 * Used by cleanup() to release all held locks.
 */
type LaneLockMap = Record<string, string[]>;

// ─── Runner Class ────────────────────────────────────────────────────────────

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
		/** Timeout for lane dispatch (session.create + session.prompt) in ms. Undefined = no timeout. */
		laneDispatchTimeoutMs: number | undefined;
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
		laneDispatchTimeoutMs: undefined,
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

	// ─── Public Methods ─────────────────────────────────────────────────────────

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

		// Plan lane distribution — type cast needed because Phase (schema) is structurally
		// wider than PlanPhase (planner) but at runtime all used fields are compatible
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const lanePlan: LeanTurboLanePlan =
			LeanTurboRunner._internals.planLeanTurboLanes(
				this._directory,
				phaseNumber,
				{ phases: plan.phases as any },
				leanConfig,
			);

		const degradedTasks = lanePlan.degradedTasks.map((d) => d.taskId);

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
				serializedTasks: lanePlan.serializedTasks,
			};
		}

		// When lanes.length === 0 but there are serialized/degraded fallback tasks,
		// persist state so phase-ready can verify them
		if (lanePlan.lanes.length === 0) {
			await this._withStateLock(() => this._updateDurableState(lanePlan));
			return {
				ok: true,
				lanes: [],
				degradedTasks,
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
			lanePlan.lanes.map((lane) => this._processLane(lane)),
		);
		laneResults.push(...results);

		return {
			ok: true,
			lanes: laneResults,
			degradedTasks,
			serializedTasks: lanePlan.serializedTasks,
		};
	}

	/**
	 * Dispatch a single lane to a named agent.
	 *
	 * Creates an ephemeral session, sends a task prompt, and returns
	 * the session ID for later status polling.
	 *
	 * @param lane - Lane to dispatch
	 * @param agentName - Agent name to dispatch to
	 */
	async dispatchLane(
		lane: LeanTurboLane,
		agentName: string,
	): Promise<LaneDispatchResult> {
		const session =
			this._sessionOps ??
			(this._client?.session as unknown as SessionClient | null);
		if (!session) {
			return { ok: false, error: 'NO_CLIENT' };
		}

		// Build a promise that does the full dispatch
		const dispatchPromise = this._doDispatch(session, lane, agentName);

		// Apply timeout if configured via _internals
		const timeoutMs = LeanTurboRunner._internals.laneDispatchTimeoutMs;
		if (timeoutMs !== undefined && timeoutMs > 0) {
			const timeoutPromise = new Promise<never>((_, reject) =>
				setTimeout(
					() =>
						reject(new Error(`Lane dispatch timed out after ${timeoutMs}ms`)),
					timeoutMs,
				),
			);
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
									session
										.delete({ path: { id: result.sessionId } })
										.catch(() => {});
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
	): Promise<LaneDispatchResult> {
		try {
			// Create ephemeral session
			const createResult = await session.create({
				query: { directory: this._directory },
			});

			if (!createResult.data) {
				return {
					ok: false,
					error: `session.create failed: ${typeof createResult.error === 'string' ? createResult.error : JSON.stringify(createResult.error)}`,
				};
			}

			const sessionId = createResult.data.id;

			// Build task prompt for this lane
			const promptText = this._buildLanePrompt(lane);

			// Send prompt to the agent (file-modifying tools enabled so coders can implement tasks)
			const promptResult = await session.prompt({
				path: { id: sessionId },
				body: {
					agent: agentName,
					tools: { write: true, edit: true, patch: true },
					parts: [{ type: 'text' as const, text: promptText }],
				},
			});

			if (!promptResult.data) {
				// Clean up the orphaned session
				session.delete({ path: { id: sessionId } }).catch(() => {});
				return {
					ok: false,
					error: `session.prompt failed: ${typeof promptResult.error === 'string' ? promptResult.error : JSON.stringify(promptResult.error)}`,
				};
			}

			return { ok: true, sessionId };
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			return { ok: false, error: msg };
		}
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
	private _resolveCoderAgents(names: string[]): string[] {
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
		const defaults = DEFAULT_LEAN_TURBO_CONFIG;

		if (config) {
			return { ...defaults, ...config };
		}
		return defaults;
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
	private async _processLane(lane: LeanTurboLane): Promise<LaneResult> {
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

		// Dispatch to selected agent
		const dispatchResult = await this.dispatchLane(lane, agent);

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
	 * Safely write lane evidence, catching errors to prevent evidence write
	 * failure from blocking lane processing.
	 */
	private async _writeLaneEvidenceSafely(
		lane: LeanTurboLane,
		status: LaneEvidence['status'],
		extras: Partial<LaneEvidence>,
	): Promise<void> {
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
			if (phase !== undefined) {
				await LeanTurboRunner._internals.writeLaneEvidence(
					this._directory,
					phase,
					evidence,
				);
			}
		} catch {
			// Evidence write failure is non-fatal for runner operation
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
	 * Serializes access to durable state via a promise chain.
	 * Prevents concurrent lane updates from racing on turbo-state.json writes.
	 *
	 * Includes a 10-second timeout: if state persistence hangs, the lock is
	 * released so subsequent updates are not blocked indefinitely.
	 */
	private async _withStateLock<T>(fn: () => Promise<T>): Promise<T> {
		const timeoutMs = 10_000;
		let timeoutId: ReturnType<typeof setTimeout> | undefined;

		const withTimeout = new Promise<T>((_resolve, reject) => {
			timeoutId = setTimeout(() => {
				reject(
					new Error(
						`_withStateLock timed out after ${timeoutMs}ms — state update will not block subsequent operations`,
					),
				);
			}, timeoutMs);
		});

		const chain = this._stateLock.then(fn).finally(() => {
			if (timeoutId) clearTimeout(timeoutId);
		});

		const promise = Promise.race([chain, withTimeout]).finally(() => {
			if (timeoutId) clearTimeout(timeoutId);
		});

		this._stateLock = promise.catch(() => {});
		return promise;
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

// ─── Exported Types ────────────────────────────────────────────────────────────

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
