/**
 * Worktree Isolation Subsystem
 *
 * Manages standard worktree-backed coder dispatches: provisioning worktrees,
 * tracking dispatches, serializing when capacity is exceeded, and merging
 * results back after coder completion.
 *
 * Extracted from delegation-gate.ts (FR-003) for modularity.
 * The _internals seam allows test injection of worktree operations.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { PluginConfig, WorktreeIsolationConfig } from '../../config';
import { DEFAULT_WORKTREE_ISOLATION_CONFIG } from '../../config/constants';
import { isValidEnvKey } from '../../sandbox/executor';
import { ensureAgentSession, swarmState } from '../../state';
import type { WorktreeHandle } from '../../worktree';
import {
	attemptMergeBackFromDirty,
	cleanupOrphanedBranches,
	getMergeStrategy,
	postMergeCleanup,
	provisionWorktree,
	removeWorktree,
	startupOrphanRecovery,
} from '../../worktree';
import {
	clearWorktreeMergeStatus,
	recordWorktreeMergeFailure,
} from './worktree-merge-status';

/**
 * FR-201: Per-lane runtime profile injected into spawned child processes.
 *
 * Produced at lane provisioning time and written as `.swarm/lanes/{laneIndex}.env`
 * (KEY=VAL format, one per line) so any child process spawned inside the lane
 * can source it to get lane-specific PORT, TMPDIR, cache redirects, etc.
 *
 * The profile is computed from the resolved WorktreeIsolationConfig.runtime_isolation:
 * - PORT = (port_base ?? 0) + laneIndex * port_stride
 * - env_overrides merged verbatim
 * - cache_redirects mapped to env vars
 */
export interface LaneRuntimeProfile {
	/** 0-based lane index used for port and env derivation. */
	laneIndex: number;
	/** Absolute path to the provisioned worktree. */
	worktreePath: string;
	/** Env var overrides for this lane (includes PORT after derivation). */
	envOverrides: Record<string, string>;
}

/**
 * Parses a Lean Turbo laneId (e.g. "lane-3") and returns its 0-based index.
 * Returns 0 for unparseable ids.
 */
export function parseLeanLaneIndex(laneId: string): number {
	const match = /^lane-(\d+)$/.exec(laneId);
	if (match) {
		const n = parseInt(match[1]!, 10);
		return Number.isNaN(n) ? 0 : n - 1; // "lane-1" → 0, "lane-3" → 2
	}
	return 0;
}

/**
 * FR-201 SC-122: Computes the per-lane runtime profile from the resolved runtime_isolation config.
 *
 * Derives:
 * - PORT = (port_base ?? 0) + laneIndex * port_stride
 * - Derives PORT from port_base + lane_index * port_stride (when port_base is set)
 * - Merges env_overrides — explicit caller values win over derived PORT
 * - Merges cache_redirects (base → lane-suffixed-path mapped to env vars; wins over env_overrides)
 *
 * Returns undefined when runtime_isolation is disabled (zero behavior change).
 */
export function computeLaneRuntimeProfile(
	runtime: WorktreeIsolationConfig['runtime_isolation'],
	laneIndex: number,
	worktreePath: string,
): LaneRuntimeProfile | undefined {
	if (!runtime?.enabled) return undefined;

	const portStride = runtime.port_stride ?? 1;

	// Precedence (last write wins):
	//  1. Derive PORT if port_base is set
	//  2. env_overrides — explicit caller values win over derived PORT
	//  3. cache_redirects — explicit cache redirect wins (last write wins)

	// Start with derived PORT (lowest priority)
	const envOverrides: Record<string, string> = {};

	// 1. Derive PORT when port_base is explicitly defined.
	// Schema comment: "If omitted, no PORT variable is set."
	if (runtime.port_base !== undefined) {
		const portBase = runtime.port_base;
		const port = portBase + laneIndex * portStride;
		envOverrides.PORT = String(port);
	}

	// 2. env_overrides — explicit caller wins over derived PORT
	if (runtime.env_overrides) {
		Object.assign(envOverrides, runtime.env_overrides);
	}

	// 3. cache_redirects — explicit cache redirect wins (last write wins)
	if (runtime.cache_redirects) {
		for (const [envName, basePath] of Object.entries(runtime.cache_redirects)) {
			// Build lane-suffixed path: {basePath}/lane-{laneIndex}
			// Use path.join (platform-native) so the result uses native separators.
			// On Windows: C:\Users\...\Temp\cache → C:\Users\...\Temp\cache\lane-2
			// On POSIX: /home/user/.cache → /home/user/.cache/lane-2
			const laneSuffix = path.join(basePath, `lane-${laneIndex}`);
			envOverrides[envName] = laneSuffix;
		}
	}

	return {
		laneIndex,
		worktreePath,
		envOverrides,
	};
}

/**
 * FR-201: Allocates and returns the next 0-based lane index for a standard worktree session.
 * Indices are per-session (keyed by parentSessionID) and monotonically increase.
 */
function allocateStandardLaneIndex(parentSessionID: string): number {
	const current = standardWorktreeLaneIndexBySession.get(parentSessionID) ?? 0;
	standardWorktreeLaneIndexBySession.set(parentSessionID, current + 1);
	return current;
}

// INVARIANT: this cap MUST stay strictly above the `max_concurrent_tasks`
// schema ceiling (currently clamped to <= 64 in execution-profile-schema). The
// tracking-cap branch in precreateStandardWorktreeSession degrades gracefully
// (un-isolated) instead of blocking, which is only safe because in-flight coders
// can never approach this cap. If the concurrency ceiling is ever raised to or
// above this value, that branch would reopen the F-008 un-isolated-collision
// window and must switch to handleStandardWorktreeFailure like the other paths.
export const MAX_TRACKED_STANDARD_WORKTREE_CALLS = 256;

export interface StandardWorktreeDispatch {
	callID: string;
	parentSessionID: string;
	taskId: string;
	planTaskId?: string;
	handle: WorktreeHandle;
	mergeStrategy: 'merge' | 'rebase' | 'cherry-pick';
	/** FR-201: 0-based lane index for runtime profile derivation. */
	laneIndex: number;
}

export interface AwaitingMergeRecord {
	callID: string;
	parentSessionID: string;
	taskId: string;
	planTaskId?: string;
	branch: string;
	worktreePath: string;
	mergeStrategy: 'merge' | 'rebase' | 'cherry-pick';
	queuedAt: number; // Date.now()
}

/** Map keyed by callID. Lanes waiting for or in the middle of merge-back. */
export const awaitingMergeByCallID = new Map<string, AwaitingMergeRecord>();

export const standardWorktreeByCallID = new Map<
	string,
	StandardWorktreeDispatch
>();
export const standardWorktreeSerializationSessions = new Set<string>();
let standardWorktreeMergeQueue: Promise<unknown> = Promise.resolve();

/**
 * FR-201: Per-session counter for standard worktree lane indices.
 * Provides deterministic 0-based laneIndex for runtime profile derivation
 * (port = base + laneIndex * stride).
 * Keyed by parentSessionID so each session's lanes get independent indices.
 */
const standardWorktreeLaneIndexBySession = new Map<string, number>();

/**
 * FR-104 SC-111/SC-112: Per-session state tracking for serialization release.
 * Maps sessionID → serialization state for that session.
 */
interface SessionSerializationState {
	sessionID: string;
	/** Date.now() when the session was first added to standardWorktreeSerializationSessions */
	serializedAt: number;
	/**
	 * Count of successful dispatches (merge-back completed with 'merged') from this
	 * session since it entered serialized mode.
	 */
	successfulDispatchesSince: number;
}

const serializationStateBySessionID = new Map<
	string,
	SessionSerializationState
>();

function rememberStandardWorktreeDispatch(
	dispatch: StandardWorktreeDispatch,
): void {
	standardWorktreeByCallID.set(dispatch.callID, dispatch);
}

function hasStandardWorktreeDispatchCapacity(): boolean {
	return standardWorktreeByCallID.size < MAX_TRACKED_STANDARD_WORKTREE_CALLS;
}

/**
 * True when at least one standard worktree dispatch for this parent session is
 * still tracked (provisioned but not yet merged back). Used to decide whether a
 * NON-required isolation failure can safely degrade to an un-isolated coder.
 */
function hasInFlightStandardWorktreeDispatch(parentSessionID: string): boolean {
	for (const dispatch of standardWorktreeByCallID.values()) {
		if (dispatch.parentSessionID === parentSessionID) return true;
	}
	return false;
}

/**
 * Handle a standard worktree isolation failure under the resolved policy.
 *
 * - `required`: always throw — isolation is mandatory.
 * - otherwise (auto/best-effort): degrading the triggering coder to run
 *   un-isolated in the main working tree is only safe when NO sibling coder is
 *   currently isolated in a worktree for this session. If a sibling IS in-flight,
 *   running this coder un-isolated risks a merge-back collision when the sibling
 *   finishes, so block this dispatch and force the architect to wait (F-008).
 *   With no in-flight sibling the un-isolated coder runs alone, which is the
 *   intended graceful degradation to serial execution.
 */
function handleStandardWorktreeFailure(
	parentSessionID: string,
	policy: WorktreeIsolationConfig['policy'],
	message: string,
): void {
	if (policy === 'required') throw new Error(message);
	if (hasInFlightStandardWorktreeDispatch(parentSessionID)) {
		throw new Error(
			`STANDARD_WORKTREE_ISOLATION_UNSAFE: ${message} ` +
				`Sibling coder task(s) are isolated in worktrees for this session, so ` +
				`dispatching this coder un-isolated in the main tree would risk a ` +
				`merge-back collision. Wait for in-flight coder task(s) to be reviewed ` +
				`and merged, then retry.`,
		);
	}
	serializeStandardWorktreeDispatches(parentSessionID, message);
}

function serializeStandardWorktreeDispatches(
	sessionID: string,
	message: string,
): void {
	rememberStandardWorktreeSerializationSession(sessionID);
	const session = ensureAgentSession(sessionID);
	session.maxConcurrencyOverride = 1;
	session.pendingAdvisoryMessages ??= [];
	session.pendingAdvisoryMessages.push(
		`${message} Serializing standard coder dispatches for this session.`,
	);
}

export function resetStandardWorktreeIsolationState(): void {
	standardWorktreeByCallID.clear();
	standardWorktreeSerializationSessions.clear();
	serializationStateBySessionID.clear();
	awaitingMergeByCallID.clear();
	standardWorktreeMergeQueue = Promise.resolve();
	standardWorktreeLaneIndexBySession.clear();
}

/**
 * FR-104: Release a session from serialized mode, restoring parallel dispatch eligibility.
 * Returns true if the session was found and released, false if it was not serialized.
 */
function releaseStandardWorktreeSerialization(sessionID: string): boolean {
	if (!standardWorktreeSerializationSessions.has(sessionID)) return false;
	standardWorktreeSerializationSessions.delete(sessionID);
	serializationStateBySessionID.delete(sessionID);
	const session = ensureAgentSession(sessionID);
	session.maxConcurrencyOverride = undefined;
	session.pendingAdvisoryMessages ??= [];
	session.pendingAdvisoryMessages.push(
		`WORKTREE_SERIALIZATION_RELEASED: ${sessionID} regains parallel dispatch eligibility (release-after-dispatches or TTL).`,
	);
	return true;
}

/**
 * FR-104 SC-111/SC-112: Check whether a serialized session has met its release conditions
 * (either enough successful dispatches have completed, or the TTL has expired).
 * If so, release it from serialized mode.
 */
export function checkStandardWorktreeSerializationRelease(
	sessionID: string,
	config: WorktreeIsolationConfig,
): void {
	const state = serializationStateBySessionID.get(sessionID);
	if (!state) return;
	const count = config.serialization_release_after_dispatches ?? 5;
	const ttl = config.serialization_release_after_ms ?? 60_000;
	if (state.successfulDispatchesSince >= count) {
		releaseStandardWorktreeSerialization(sessionID);
		return;
	}
	if (Date.now() - state.serializedAt >= ttl) {
		releaseStandardWorktreeSerialization(sessionID);
	}
}

/**
 * FR-104 SC-113: Add a session to the serialization set.
 * When the set is at capacity, evicts the oldest entry whose session has NO
 * in-flight dispatch — never evict an actively-dispatching session.
 * If ALL 256 entries are in-flight, refuses the new entry and logs a warning
 * rather than silently breaking isolation.
 */
function rememberStandardWorktreeSerializationSession(sessionID: string): void {
	if (
		standardWorktreeSerializationSessions.size >=
		MAX_TRACKED_STANDARD_WORKTREE_CALLS
	) {
		// Find the oldest entry whose session has NO in-flight dispatch
		let evicted = false;
		for (const key of serializationStateBySessionID.keys()) {
			if (!hasInFlightStandardWorktreeDispatch(key)) {
				standardWorktreeSerializationSessions.delete(key);
				serializationStateBySessionID.delete(key);
				evicted = true;
				break;
			}
		}
		if (!evicted) {
			// All 256 entries are active — log and REFUSE to add rather than break isolation
			console.warn(
				`[worktree-isolation] serialization set at cap with all sessions active; refusing eviction for ${sessionID}`,
			);
			return;
		}
	}
	standardWorktreeSerializationSessions.add(sessionID);
	if (!serializationStateBySessionID.has(sessionID)) {
		serializationStateBySessionID.set(sessionID, {
			sessionID,
			serializedAt: Date.now(),
			successfulDispatchesSince: 0,
		});
	}
}

export function sanitizeWorktreeTaskId(raw: string): string {
	const sanitized = raw.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 64);
	return sanitized || 'task';
}

export function resolveWorktreeIsolationConfig(
	config: PluginConfig,
): WorktreeIsolationConfig {
	if (config.worktree) {
		return { ...DEFAULT_WORKTREE_ISOLATION_CONFIG, ...config.worktree };
	}
	const lean =
		config.turbo?.strategy === 'lean' ? config.turbo.lean : undefined;
	if (lean?.worktree_isolation) {
		return {
			...DEFAULT_WORKTREE_ISOLATION_CONFIG,
			policy: 'auto',
			merge_strategy: lean.merge_strategy ?? 'merge',
			worktree_dir: lean.worktree_dir,
			deps_strategy: lean.deps_strategy ?? 'skip',
			runtime_isolation:
				lean.runtime_isolation ??
				DEFAULT_WORKTREE_ISOLATION_CONFIG.runtime_isolation,
		};
	}
	return DEFAULT_WORKTREE_ISOLATION_CONFIG;
}

export async function precreateStandardWorktreeSession(args: {
	config: PluginConfig;
	directory: string;
	parentSessionID: string;
	callID: string;
	taskId: string;
	planTaskId?: string;
	description?: string;
	outputArgs: Record<string, unknown>;
	/** Scope to materialize into the lane for durability across restart (FR-102). */
	scope?: { taskId: string; files: string[] };
}): Promise<void> {
	const worktreeConfig = resolveWorktreeIsolationConfig(args.config);
	if (worktreeConfig.policy === 'disabled') return;

	// FR-104 SC-112: cheap TTL check on every precreate access — release a serialized
	// session if its TTL has expired even before the first dispatch completes.
	// NOTE: after release, we return early so that the subsequent capacity/client checks
	// cannot re-serialize the session via handleStandardWorktreeFailure.
	if (standardWorktreeSerializationSessions.has(args.parentSessionID)) {
		checkStandardWorktreeSerializationRelease(
			args.parentSessionID,
			worktreeConfig,
		);
		// If TTL check released the session, return early so capacity/client checks
		// don't re-add it via handleStandardWorktreeFailure
		if (!standardWorktreeSerializationSessions.has(args.parentSessionID)) {
			return;
		}
	}

	if (!hasStandardWorktreeDispatchCapacity()) {
		const message =
			'STANDARD_WORKTREE_TRACKING_CAP_EXCEEDED: too many standard worktree coder dispatches are already awaiting merge-back.';
		if (worktreeConfig.policy === 'required') throw new Error(message);
		// The tracking cap is a memory bound, not an isolation failure, and the
		// parallel slot cap (max_concurrent_tasks) keeps in-flight coders far below
		// it in practice. Degrade gracefully here rather than blocking.
		serializeStandardWorktreeDispatches(args.parentSessionID, message);
		return;
	}

	const client = swarmState.opencodeClient;
	if (!client) {
		const message =
			'STANDARD_WORKTREE_ISOLATION_UNAVAILABLE: OpenCode SDK client is unavailable; standard parallel coder work cannot be isolated.';
		handleStandardWorktreeFailure(
			args.parentSessionID,
			worktreeConfig.policy,
			message,
		);
		return;
	}

	// FR-004: Run startup orphan recovery before provisioning to clean up
	// stale worktree metadata and orphaned branches from prior sessions.
	// This gives the standard path the same cleanup the Lean Turbo runner has.
	try {
		await _internals.startupOrphanRecovery(args.directory, [
			args.parentSessionID,
		]);
	} catch (recoveryError) {
		console.warn(`[swarm] startup orphan recovery failed: ${recoveryError}`);
	}

	// SC-004.2: Also delete stale lane branches from inactive sessions so
	// they cannot collide on resume/re-provisioning. The current session's
	// branches are preserved by passing [args.parentSessionID] as the
	// active-session allowlist. Failures are non-fatal — provisioning proceeds.
	try {
		await _internals.cleanupOrphanedBranches(args.directory, [
			args.parentSessionID,
		]);
	} catch (cleanupError) {
		console.warn(`[swarm] orphaned branch cleanup failed: ${cleanupError}`);
	}

	// FR-201 SC-123: Allocate lane index and compute runtime profile BEFORE provisioning
	// so the profile is available for materialization inside the worktree.
	// Indices are per-session and monotonically increase.
	const laneIndex = allocateStandardLaneIndex(args.parentSessionID);

	// Reserve a placeholder worktreePath for profile computation (updated after provision).
	// The profile needs the actual worktreePath, so we compute it after provisioning.
	const provisionResult = await _internals.provisionWorktree(
		args.directory,
		args.taskId,
		args.parentSessionID,
		{
			purpose: 'lane',
			worktreeDir: worktreeConfig.worktree_dir,
			mergeStrategy: worktreeConfig.merge_strategy,
			depsStrategy: worktreeConfig.deps_strategy,
			scope: args.scope,
		},
	);
	if ('error' in provisionResult) {
		const message = `STANDARD_WORKTREE_PROVISION_FAILED: ${provisionResult.error}.`;
		handleStandardWorktreeFailure(
			args.parentSessionID,
			worktreeConfig.policy,
			message,
		);
		return;
	}

	// FR-201 SC-124: Compute and materialize the lane runtime profile.
	// Profile is computed AFTER provisioning so we have the real worktreePath.
	// Materialization is best-effort (defense-in-depth); failure is non-fatal.
	const laneProfile = computeLaneRuntimeProfile(
		worktreeConfig.runtime_isolation,
		laneIndex,
		provisionResult.worktreePath,
	);
	if (laneProfile) {
		try {
			const { writeLaneProfileToDiskReal } = await import(
				'../../worktree/core'
			);
			await writeLaneProfileToDiskReal(
				provisionResult.worktreePath,
				laneProfile.laneIndex,
				laneProfile.envOverrides,
			);
		} catch {
			/* non-fatal — profile materialization is defense-in-depth */
		}
	}

	// SC-104: session-visible advisory when deps_strategy 'skip' (default) and task may run test/build commands.
	// We use a heuristic on description/taskId for "gates include test/build commands" (common in acceptance criteria or task titles).
	// The advisory identifies the task and warns that dependencies may be absent in the lane.
	const resolvedDeps = worktreeConfig.deps_strategy ?? 'skip';
	if (resolvedDeps === 'skip') {
		const desc = (args.description ?? args.taskId ?? '').toLowerCase();
		const mayNeedDeps =
			desc.includes('test') ||
			desc.includes('build') ||
			desc.includes('lint') ||
			desc.includes('check');
		if (mayNeedDeps) {
			const session = ensureAgentSession(args.parentSessionID);
			session.pendingAdvisoryMessages ??= [];
			session.pendingAdvisoryMessages.push(
				`WORKTREE_DEPS_SKIP: task ${args.taskId} was provisioned with deps_strategy: 'skip' (default). This task's gates appear to include test/build commands; the lane may lack node_modules. Set worktree.deps_strategy to 'copy' or 'link' (or use a non-worktree lane) if the task requires host dependencies.`,
			);
		}
	}

	const createResult = await client.session.create({
		body: {
			parentID: args.parentSessionID,
			title: `${args.description ?? args.taskId} (worktree lane)`,
		},
		query: { directory: provisionResult.worktreePath },
	});
	if (!createResult.data?.id) {
		await _internals
			.removeWorktree(provisionResult.worktreePath, args.directory)
			.catch(() => {});
		const createError = (createResult as { error?: unknown }).error;
		const detail =
			typeof createError === 'string'
				? createError
				: JSON.stringify(createError ?? 'missing session id');
		const message = `STANDARD_WORKTREE_SESSION_CREATE_FAILED: ${detail}.`;
		handleStandardWorktreeFailure(
			args.parentSessionID,
			worktreeConfig.policy,
			message,
		);
		return;
	}

	args.outputArgs.task_id = createResult.data.id;
	rememberStandardWorktreeDispatch({
		callID: args.callID,
		parentSessionID: args.parentSessionID,
		taskId: args.taskId,
		planTaskId: args.planTaskId,
		handle: provisionResult,
		mergeStrategy: worktreeConfig.merge_strategy,
		laneIndex,
	});
}

export async function finishStandardWorktreeDispatch(
	directory: string,
	dispatch: StandardWorktreeDispatch,
	config?: PluginConfig,
	/**
	 * Optional callID for cleanup of awaitingMergeByCallID. When omitted,
	 * derived from dispatch.callID (for backward compatibility with test callers
	 * that pass StandardWorktreeDispatch objects directly).
	 */
	callID?: string,
): Promise<void> {
	const wtConfig = config
		? resolveWorktreeIsolationConfig(config)
		: DEFAULT_WORKTREE_ISOLATION_CONFIG;

	// Resolve callID: explicit param takes precedence (delegation-gate.ts path),
	// otherwise derive from dispatch (backward-compat for direct test callers).
	const resolvedCallID = callID ?? dispatch.callID;

	const run = async () => {
		const mergeResult = await _internals.attemptMergeBackFromDirty(
			dispatch.handle.worktreePath,
			dispatch.handle.branchName,
			directory,
			getMergeStrategy({ merge_strategy: dispatch.mergeStrategy }),
		);
		// Key the merge-back status by the plan task id (which equals the
		// `taskId` Epic Rule 2 sees in `updateTaskStatus`); fall back to the
		// dispatch taskId for non-plan dispatches.
		const statusKey = dispatch.planTaskId ?? dispatch.taskId;
		if ('merged' in mergeResult && mergeResult.merged) {
			// Clean merge supersedes any earlier failure for this task so a
			// successful re-dispatch re-enables Rule 2's marker commit.
			clearWorktreeMergeStatus(statusKey);

			// FR-205 SC-134: Remove lane profile at successful merge-back teardown.
			// Best-effort — non-fatal if removal fails (e.g. file already gone).
			try {
				const { removeLaneProfileFromDiskReal } = await import(
					'../../worktree/core'
				);
				await removeLaneProfileFromDiskReal(
					dispatch.handle.worktreePath,
					dispatch.laneIndex,
				);
			} catch {
				/* non-fatal */
			}

			await _internals
				.removeWorktree(dispatch.handle.worktreePath, directory)
				.catch(() => {});
			await _internals
				.postMergeCleanup(directory, dispatch.handle.branchName)
				.catch(() => {});

			// FR-104 SC-111: Increment successful-dispatch counter and check release
			const state = serializationStateBySessionID.get(dispatch.parentSessionID);
			if (state) {
				state.successfulDispatchesSince++;
				checkStandardWorktreeSerializationRelease(
					dispatch.parentSessionID,
					wtConfig,
				);
			}

			return;
		}
		if ('partial' in mergeResult) {
			recordWorktreeMergeFailure(statusKey, {
				outcome: 'partial',
				stage: mergeResult.stage,
				message: mergeResult.message,
				worktreePath: dispatch.handle.worktreePath,
				branch: dispatch.handle.branchName,
				completedAt: Date.now(),
			});
			const session = ensureAgentSession(dispatch.parentSessionID);
			session.pendingAdvisoryMessages ??= [];
			session.pendingAdvisoryMessages.push(
				`STANDARD_WORKTREE_MERGE_PARTIAL: task ${dispatch.taskId} preserved at ${dispatch.handle.worktreePath}; stage: ${mergeResult.stage}; ${mergeResult.message}`,
			);
			return;
		}

		if ('failed' in mergeResult) {
			recordWorktreeMergeFailure(statusKey, {
				outcome: 'failed',
				stage: mergeResult.stage,
				message: mergeResult.message,
				worktreePath: dispatch.handle.worktreePath,
				branch: dispatch.handle.branchName,
				completedAt: Date.now(),
			});
			const session = ensureAgentSession(dispatch.parentSessionID);
			session.pendingAdvisoryMessages ??= [];
			session.pendingAdvisoryMessages.push(
				`STANDARD_WORKTREE_MERGE_FAILED: task ${dispatch.taskId} preserved at ${dispatch.handle.worktreePath}; stage: ${mergeResult.stage}; ${mergeResult.message}.`,
			);
		}
	};

	standardWorktreeMergeQueue = standardWorktreeMergeQueue.then(run, run);
	await standardWorktreeMergeQueue;

	// SC-115: Remove from awaiting-merge registry after merge-back completes
	// (success, partial, or failed — all three paths).
	if (resolvedCallID) {
		awaitingMergeByCallID.delete(resolvedCallID);
	}
}

/**
 * FR-201: Read and parse a lane runtime profile from disk.
 *
 * Reads `<worktree>/.swarm/lanes/{laneIndex}.env` (KEY=VALUE format, one per line).
 * - Skips blank lines and lines starting with `#` (comments).
 * - Skips malformed lines (no `=` separator).
 * - Validates each key with `isValidEnvKey`; rejects and skips invalid keys.
 * - Returns an empty record when the file does not exist.
 *
 * Exposed via _internals for testability (no mock.module leakage).
 */
export async function readLaneEnvFileFromDisk(
	worktreePath: string,
	laneIndex: number,
): Promise<Record<string, string>> {
	const envPath = path.join(
		worktreePath,
		'.swarm',
		'lanes',
		`${laneIndex}.env`,
	);
	let content: string;
	try {
		content = await fs.readFile(envPath, 'utf-8');
	} catch (err) {
		// ENOENT / ENOTDIR — file absent, which is fine (no lane profile materialised yet).
		if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
			return {};
		}
		// Other errors: warn and return empty so spawns degrade gracefully.
		console.warn(
			`[worktree-isolation] failed to read lane env file ${envPath}: ${(err as Error).message}`,
		);
		return {};
	}

	const result: Record<string, string> = {};
	for (const rawLine of content.split('\n')) {
		const line = rawLine.trim();
		if (!line || line.startsWith('#')) continue;
		const eqIdx = line.indexOf('=');
		if (eqIdx < 0) continue; // malformed: no '=' separator
		const k = line.slice(0, eqIdx);
		const v = line.slice(eqIdx + 1);
		if (!isValidEnvKey(k)) continue; // reject shell-injection vectors
		result[k] = v;
	}
	return result;
}

/**
 * _internals seam for test injection of worktree operations.
 * Tests set these entries on delegation-gate's _internals (which proxies
 * here via getters/setters) to mock worktree provisioning, merge-back, etc.
 */
export const _internals = {
	provisionWorktree,
	removeWorktree,
	attemptMergeBackFromDirty,
	postMergeCleanup,
	/** FR-201: read lane runtime profile from disk for spawn injection. */
	readLaneEnvFileFromDisk,
	/** FR-104: exposes serializationStateBySessionID for test setup (SC-111/SC-112/SC-113). */
	serializationStateBySessionID,
	/**
	 * FR-104 SC-113: exposes the FIFO eviction function for direct test invocation.
	 * Tests use this to exercise the cap-check logic without going through the
	 * full precreateStandardWorktreeSession path.
	 */
	rememberStandardWorktreeSerializationSession,
	/** FR-105 SC-115: exposes awaitingMergeByCallID for test setup. */
	awaitingMergeByCallID,
	startupOrphanRecovery,
	cleanupOrphanedBranches,
};
