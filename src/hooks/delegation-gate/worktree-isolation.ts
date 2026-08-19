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

import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { PluginConfig, WorktreeIsolationConfig } from '../../config';
import { DEFAULT_WORKTREE_ISOLATION_CONFIG } from '../../config/constants';
import { tryAcquireLock } from '../../parallel/file-locks';
import { isValidEnvKey } from '../../sandbox/executor';
import {
	ensureAgentSession,
	recordSessionWorkspaceRoot,
	swarmState,
} from '../../state';
import { pushAdvisory } from '../../utils/advisory-queue';
import { bunSpawn } from '../../utils/bun-compat';
import * as logger from '../../utils/logger.js';
import type { WorktreeHandle } from '../../worktree';
import {
	attemptMergeBackFromDirty,
	cleanupOrphanedBranches,
	getMergeStrategy,
	mergeInternals,
	postMergeCleanup,
	provisionWorktree,
	pruneStaleWorktreeMetadata,
	removeWorktree,
	startupOrphanRecovery,
} from '../../worktree';
import type {
	DirtyMergeOptions,
	MergeOperationProvenance,
} from '../../worktree/merge';
import {
	clearWorktreeMergeStatus,
	recordWorktreeMergeFailure,
} from './worktree-merge-status';
import {
	recordWorktreeProvisioningOwner,
	removeWorktreeProvisioningOwner,
	WORKTREE_LIFECYCLE_LOCK_FILE,
} from './worktree-provisioning-owner';

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
		// Clamp to 65535 — valid TCP port range max. Without this, port_base +
		// laneIndex * port_stride can exceed 65535 and cause EADDRINUSE or
		// "port out of range" bind failures that the failure-classifier misclassifies.
		const port = Math.min(portBase + laneIndex * portStride, 65535);
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
	/** Configured worktree-dir override, so cleanup trusts the same base. */
	worktree_dir?: string;
}

export interface StandardWorktreeSettlementOptions
	extends Pick<DirtyMergeOptions, 'operationId' | 'resume' | 'onBeforeMerge'> {
	/**
	 * Awaited after Git reports success (including reconciled success) and before
	 * destructive worktree/branch cleanup. A rejection preserves the lane.
	 */
	onMerged?: (result: StandardWorktreeMergedSettlement) => Promise<void>;
}

export interface StandardWorktreeMergedSettlement {
	outcome: 'merged';
	strategy: string;
	autoCommitted: boolean;
	cleaned: boolean;
	reconciled: boolean;
	provenance?: MergeOperationProvenance;
}

export interface StandardWorktreePartialSettlement {
	outcome: 'partial';
	stage: string;
	message: string;
	autoCommitted: boolean;
	cleaned: boolean;
	conflictFiles?: string[];
	provenance?: MergeOperationProvenance;
}

export interface StandardWorktreeFailedSettlement {
	outcome: 'failed';
	stage: string;
	message: string;
	provenance?: MergeOperationProvenance;
}

export type StandardWorktreeSettlementResult =
	| StandardWorktreeMergedSettlement
	| StandardWorktreePartialSettlement
	| StandardWorktreeFailedSettlement;

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
	// Also check awaiting merge-backs — a session with pending merges is still "in-flight"
	for (const record of awaitingMergeByCallID.values()) {
		if (record.parentSessionID === parentSessionID) return true;
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

function hardStopStandardWorktreeLifecycle(
	parentSessionID: string,
	message: string,
): never {
	const session = ensureAgentSession(parentSessionID);
	pushAdvisory(session, message);
	throw new Error(message);
}

function serializeStandardWorktreeDispatches(
	sessionID: string,
	message: string,
): void {
	const added = rememberStandardWorktreeSerializationSession(sessionID);
	if (!added) {
		// Serialization tracking at capacity — cannot safely serialize because
		// the release mechanism (checkStandardWorktreeSerializationRelease) needs
		// the tracking entry. Let the session continue in normal parallel mode.
		const session = ensureAgentSession(sessionID);
		pushAdvisory(
			session,
			`${message} Serialization tracking is at capacity (256 sessions active); ` +
				`continuing in normal parallel mode.`,
		);
		return;
	}
	const session = ensureAgentSession(sessionID);
	session.maxConcurrencyOverride = 1;
	pushAdvisory(
		session,
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
	pushAdvisory(
		session,
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
function rememberStandardWorktreeSerializationSession(
	sessionID: string,
): boolean {
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
			logger.log(
				`[worktree-isolation] serialization set at cap with all sessions active; refusing eviction for ${sessionID}`,
			);
			return false;
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
	return true;
}

export function sanitizeWorktreeTaskId(raw: string): string {
	const sanitized = raw.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 64);
	return sanitized || 'task';
}

import { resolveWorktreeIsolationConfig } from '../../config/worktree-isolation-config';
export { resolveWorktreeIsolationConfig };

// ---------------------------------------------------------------------------
// FR-001b: Pre-provision collision detection
// ---------------------------------------------------------------------------

const WORKTREE_LIST_TIMEOUT_MS = 15_000;

/**
 * FR-001b SC-004: Runs `git worktree list --porcelain` and checks whether
 * ANY registered worktree has a lane branch for the given taskId (regardless
 * of which session owns it).
 *
 * The detection pattern matches both current `swarm/lane/<sessionId>/<taskId>`
 * and legacy `swarm-lane/<sessionId>/<taskId>` branch formats.
 *
 * Returns collision info if any lane for this taskId is found registered in
 * an active worktree. Does NOT check whether the worktree path is valid on
 * disk — only whether the branch is checked out somewhere.
 *
 * @param taskId       - Task ID to detect collisions for.
 * @param directory    - Project root (git working tree).
 * @param sessionId    - Current session ID (used only to populate ownerSessionId
 *                       in the collision result; NOT used for collision detection).
 */
export async function preProvisionCollisionCheck(
	taskId: string,
	directory: string,
	_sessionId: string,
): Promise<{
	collision: boolean;
	existingBranch?: string;
	ownerSessionId?: string;
	worktreePath?: string;
	uncertainty?: string;
}> {
	const proc = _internals.bunSpawn(
		['git', '-C', directory, 'worktree', 'list', '--porcelain'],
		{
			stdin: 'ignore',
			stdout: 'pipe',
			stderr: 'pipe',
			timeout: WORKTREE_LIST_TIMEOUT_MS,
		},
	);
	let stdout = '';
	let stderr = '';
	try {
		const exitCode = await proc.exited;
		stdout = await proc.stdout.text();
		stderr = await proc.stderr.text();
		if (exitCode !== 0) {
			// A directory outside a Git repository cannot have a registered Git
			// worktree collision. Provisioning will independently report that the
			// project is not a repository; do not mislabel this known-empty state
			// as an unreadable ownership inventory.
			if (stderr.toLowerCase().includes('not a git repository')) {
				return { collision: false };
			}
			// Destructive callers must not infer absence when enumeration failed.
			logger.log(
				`[swarm] preProvisionCollisionCheck: git worktree list failed (exit ${exitCode}): ${stderr}`,
			);
			return {
				collision: false,
				uncertainty: stderr.trim() || `git worktree list exited ${exitCode}`,
			};
		}
	} finally {
		try {
			proc.kill();
		} catch {
			// best-effort — process may already have exited
		}
	}

	// Parse porcelain output. Each worktree entry has:
	//   worktree <path>
	//   branch refs/heads/<name>
	// (the branch line is absent when HEAD is detached)
	interface ParsedEntry {
		path: string;
		branch: string | undefined;
		/**
		 * #2208: git marks a registration `prunable` when the worktree's
		 * directory is gone (crash/kill mid-task, interrupted remove). A
		 * prunable registration is stale metadata, not an active lane —
		 * excluding it below lets a restart recover the task instead of
		 * stalling on STANDARD_WORKTREE_OWNER_PROTECTED for the full
		 * provisioning-lease window. `git worktree add` is atomic
		 * (registration exists iff the worktree exists), so a provisioning
		 * lane that is mid-creation can never appear as prunable.
		 */
		prunable: boolean;
	}
	const entries: ParsedEntry[] = [];
	let current: ParsedEntry = {
		path: '',
		branch: undefined,
		prunable: false,
	};
	for (const rawLine of stdout.split('\n')) {
		const line = rawLine.trim();
		if (line.startsWith('worktree ')) {
			if (current.path) entries.push(current);
			current = {
				path: line.slice('worktree '.length),
				branch: undefined,
				prunable: false,
			};
		} else if (line.startsWith('branch ')) {
			current.branch = line.slice('branch '.length);
		} else if (line === 'prunable' || line.startsWith('prunable ')) {
			current.prunable = true;
		}
	}
	if (current.path) entries.push(current);

	// SC-004: Scan ALL worktrees to find ANY lane for this taskId
	// (regardless of which session owns it). A lane is identified by a branch
	// whose last path segment equals taskId and whose prefix matches the
	// swarm lane naming convention. #2208: prunable (stale) registrations are
	// skipped — the recovery path in provisionWorktree prunes the stale
	// registration and reconciles the leftover branch.
	for (const entry of entries) {
		if (!entry.branch) continue;
		if (entry.prunable) continue;
		// Strip "refs/heads/" prefix
		const branchName = entry.branch.startsWith('refs/heads/')
			? entry.branch.slice('refs/heads/'.length)
			: entry.branch;
		// Check modern swarm/lane/<sessionId>/<taskId> format
		const segments = branchName.split('/');
		if (
			segments.length >= 4 &&
			segments[0] === 'swarm' &&
			segments[1] === 'lane'
		) {
			const laneTaskId = segments[3];
			if (laneTaskId === taskId) {
				const ownerSessionId = segments[2];
				return {
					collision: true,
					existingBranch: branchName,
					ownerSessionId,
					worktreePath: entry.path,
				};
			}
		}
		// Check legacy swarm-lane/<sessionId>/<taskId> format
		if (segments.length >= 3 && segments[0] === 'swarm-lane') {
			const laneTaskId = segments[2];
			if (laneTaskId === taskId) {
				const ownerSessionId = segments[1];
				return {
					collision: true,
					existingBranch: branchName,
					ownerSessionId,
					worktreePath: entry.path,
				};
			}
		}
	}

	return { collision: false };
}

/**
 * FR-001b SC-005: Returns true when `branchName`'s embedded session ID matches
 * `expectedSessionId`.
 *
 * Uses `extractSessionId` (merge.ts) to parse the branch name. Supports both
 * legacy `swarm-lane/<sessionId>/<id>` and current `swarm/lane/<sessionId>/<id>`
 * patterns.
 */
export function isLaneOwnedByCurrentSession(
	branchName: string,
	expectedSessionId: string,
): boolean {
	const extracted = mergeInternals.extractSessionId(branchName);
	return extracted === expectedSessionId;
}

async function inspectStandardWorktreeCollisionOwnership(identity: {
	directory: string;
	parentSessionId: string;
	taskId: string;
	branchName: string;
	worktreePath: string;
}) {
	const collisionOwnership = await import('./worktree-collision-ownership');
	return collisionOwnership.inspectStandardWorktreeCollisionOwnership(identity);
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

	// Global orphan recovery runs from the bounded init path. Dispatch-time
	// cleanup below is intentionally limited to one exact same-session collision
	// whose durable stores prove that no live or preserved owner remains.
	// FR-201 SC-123: Allocate lane index and compute runtime profile BEFORE provisioning
	// so the profile is available for materialization inside the worktree.
	// Indices are per-session and monotonically increase.
	const laneIndex = allocateStandardLaneIndex(args.parentSessionID);

	// Serialize collision classification, destructive stale-lane cleanup, and
	// provisional-owner publication with init orphan recovery. The lock must be
	// held before scanning so ownership cannot change between classification
	// and cleanup/provisioning.
	const lifecycleLock = await _internals.tryAcquireWorktreeLifecycleLock(
		args.directory,
		WORKTREE_LIFECYCLE_LOCK_FILE,
		'worktree-provisioning',
		args.taskId,
	);
	if (!lifecycleLock.acquired) {
		hardStopStandardWorktreeLifecycle(
			args.parentSessionID,
			'STANDARD_WORKTREE_LIFECYCLE_BUSY: init orphan recovery is active; retry this coder dispatch after recovery completes.',
		);
	}
	try {
		const collision = await _internals.preProvisionCollisionCheck(
			args.taskId,
			args.directory,
			args.parentSessionID,
		);
		if (collision.uncertainty) {
			hardStopStandardWorktreeLifecycle(
				args.parentSessionID,
				`STANDARD_WORKTREE_COLLISION_SCAN_UNCERTAIN: ${collision.uncertainty}. Destructive cleanup and provisioning were blocked.`,
			);
		}

		if (collision.collision) {
			if (
				!collision.existingBranch ||
				!collision.worktreePath ||
				!isLaneOwnedByCurrentSession(
					collision.existingBranch,
					args.parentSessionID,
				)
			) {
				const ownerInfo = collision.ownerSessionId
					? ` owned by session ${collision.ownerSessionId}`
					: ' with uncertain ownership';
				hardStopStandardWorktreeLifecycle(
					args.parentSessionID,
					`PREPROVISION_COLLISION: task ${args.taskId} already has a lane on branch ${collision.existingBranch ?? 'unknown'}${ownerInfo}; cleanup and provisioning were blocked.`,
				);
			}

			for (const dispatch of _internals.standardWorktreeByCallID.values()) {
				if (dispatch.handle.branchName === collision.existingBranch) {
					hardStopStandardWorktreeLifecycle(
						args.parentSessionID,
						`PREPROVISION_COLLISION_ACTIVE: branch ${collision.existingBranch} is still tracked by an active standard-worktree dispatch.`,
					);
				}
			}
			for (const record of _internals.awaitingMergeByCallID.values()) {
				if (record.branch === collision.existingBranch) {
					hardStopStandardWorktreeLifecycle(
						args.parentSessionID,
						`PREPROVISION_COLLISION_AWAITING_MERGE: branch ${collision.existingBranch} is still awaiting merge-back.`,
					);
				}
			}

			const ownership =
				await _internals.inspectStandardWorktreeCollisionOwnership({
					directory: args.directory,
					parentSessionId: args.parentSessionID,
					taskId: args.taskId,
					branchName: collision.existingBranch,
					worktreePath: collision.worktreePath,
				});
			if (ownership.status === 'uncertain') {
				hardStopStandardWorktreeLifecycle(
					args.parentSessionID,
					`STANDARD_WORKTREE_OWNERSHIP_UNCERTAIN: ${ownership.reason}. Destructive cleanup and provisioning were blocked.`,
				);
			}
			if (ownership.status === 'protected') {
				hardStopStandardWorktreeLifecycle(
					args.parentSessionID,
					`STANDARD_WORKTREE_OWNER_PROTECTED: ${ownership.ownerKind} owner is ${ownership.lifecycle}; ${ownership.reason}. Destructive cleanup and provisioning were blocked.`,
				);
			}

			let collisionPathExists = true;
			try {
				await fs.stat(collision.worktreePath);
			} catch (error) {
				const code = (error as NodeJS.ErrnoException).code;
				if (code === 'ENOENT' || code === 'ENOTDIR') {
					collisionPathExists = false;
				} else {
					hardStopStandardWorktreeLifecycle(
						args.parentSessionID,
						`STANDARD_WORKTREE_COLLISION_PATH_STAT_FAILED: ${
							error instanceof Error ? error.message : String(error)
						}. Destructive cleanup and provisioning were blocked.`,
					);
				}
			}

			if (collisionPathExists) {
				const preserveResult = await _internals.preserveDirtyWorktreeAtPath(
					collision.worktreePath,
					collision.existingBranch,
					'denied',
					args.directory,
					worktreeConfig.worktree_dir,
				);
				if (preserveResult.outcome === 'preserve-failed') {
					hardStopStandardWorktreeLifecycle(
						args.parentSessionID,
						`STANDARD_WORKTREE_PRESERVATION_FAILED_ABORT_CLEANUP: pre-provision collision for task ${args.taskId} could not be preserved (${preserveResult.error}). Cleanup and provisioning were blocked.`,
					);
				}

				const removeResult = await _internals.removeWorktree(
					collision.worktreePath,
					args.directory,
					{ force: true, worktreeDir: worktreeConfig.worktree_dir },
				);
				if ('error' in removeResult) {
					hardStopStandardWorktreeLifecycle(
						args.parentSessionID,
						`STANDARD_WORKTREE_COLLISION_REMOVE_FAILED: ${removeResult.error}. Provisioning was blocked.`,
					);
				}
				const cleanupResult = await _internals.postMergeCleanup(
					args.directory,
					collision.existingBranch,
				);
				if ('error' in cleanupResult) {
					hardStopStandardWorktreeLifecycle(
						args.parentSessionID,
						`STANDARD_WORKTREE_COLLISION_BRANCH_CLEANUP_FAILED: ${cleanupResult.error}. Provisioning was blocked.`,
					);
				}
			} else {
				const pruneResult = await _internals.pruneStaleWorktreeMetadata(
					args.directory,
				);
				if ('error' in pruneResult) {
					hardStopStandardWorktreeLifecycle(
						args.parentSessionID,
						`STANDARD_WORKTREE_COLLISION_PRUNE_FAILED: ${pruneResult.error}. Provisioning was blocked without deleting the lane branch.`,
					);
				}
			}

			const verification = await _internals.preProvisionCollisionCheck(
				args.taskId,
				args.directory,
				args.parentSessionID,
			);
			if (verification.uncertainty || verification.collision) {
				hardStopStandardWorktreeLifecycle(
					args.parentSessionID,
					`STANDARD_WORKTREE_COLLISION_CLEANUP_UNVERIFIED: ${
						verification.uncertainty ??
						'git still reports the colliding lane after cleanup'
					}. Provisioning was blocked.`,
				);
			}
		}

		_internals.recordWorktreeProvisioningOwner(args.directory, {
			callID: args.callID,
			parentSessionId: args.parentSessionID,
			worktreeSessionId: args.parentSessionID,
			taskId: args.taskId,
		});
	} catch (error) {
		if (
			error instanceof Error &&
			(error.message.startsWith('STANDARD_WORKTREE_') ||
				error.message.startsWith('PREPROVISION_COLLISION'))
		) {
			throw error;
		}
		hardStopStandardWorktreeLifecycle(
			args.parentSessionID,
			`STANDARD_WORKTREE_OWNER_PERSIST_FAILED: ${
				error instanceof Error ? error.message : String(error)
			}.`,
		);
	} finally {
		try {
			await lifecycleLock.lock._release?.();
		} catch {
			// Marker publication is durable; stale lock recovery remains safe.
		}
	}

	// Reserve a placeholder worktreePath for profile computation (updated after provision).
	// The profile needs the actual worktreePath, so we compute it after provisioning.
	let provisionResult: Awaited<ReturnType<typeof provisionWorktree>>;
	try {
		provisionResult = await _internals.provisionWorktree(
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
	} catch (error) {
		_internals.removeWorktreeProvisioningOwner(args.directory, args.callID);
		throw error;
	}
	if ('error' in provisionResult) {
		_internals.removeWorktreeProvisioningOwner(args.directory, args.callID);
		const message = `STANDARD_WORKTREE_PROVISION_FAILED: ${provisionResult.error}.`;
		handleStandardWorktreeFailure(
			args.parentSessionID,
			worktreeConfig.policy,
			message,
		);
		return;
	}

	const originalPrompt =
		typeof args.outputArgs.prompt === 'string' ? args.outputArgs.prompt : '';
	args.outputArgs.prompt = [
		'<worktree_lane_context>',
		`authoritative_lane_root: ${JSON.stringify(provisionResult.worktreePath)}`,
		'All FILE declarations and scope-bound edit/write paths must be workspace-relative to authoritative_lane_root.',
		'Do not declare project-root absolute paths; resolve and operate inside this lane root.',
		'</worktree_lane_context>',
		'',
		originalPrompt,
	].join('\n');

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
		// B4 (issue #1976): use word-boundary matching instead of bare includes().
		// `includes('test')` matched 'latest'/'attest'; `includes('check')` matched
		// 'checkout'/'unchecked' — firing the deps-skip advisory for tasks whose
		// descriptions merely contain those substrings without actually running
		// test/build/lint/check commands.
		const mayNeedDeps =
			/\btests?\b/.test(desc) ||
			/\bbuild(ing|s)?\b/.test(desc) ||
			/\blint(ing|er)?\b/.test(desc) ||
			/\bchecks?\b/.test(desc);
		if (mayNeedDeps) {
			const session = ensureAgentSession(args.parentSessionID);
			pushAdvisory(
				session,
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
			.removeWorktree(provisionResult.worktreePath, args.directory, {
				force: true,
				worktreeDir: worktreeConfig.worktree_dir,
			})
			.catch(() => {});
		_internals.removeWorktreeProvisioningOwner(args.directory, args.callID);
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
	// Issue #2002: the child session executes in the lane, not in the project
	// root. Record that root so the write gates (scope-guard, guardrails
	// tool-before) resolve this session's scope binding and path containment
	// against the lane instead of the plugin-root `ctx.directory` they were
	// constructed with — otherwise the child binding derived and published
	// against the lane can never be found and every write fails
	// SCOPE_NOT_DECLARED.
	//
	// Recorded HERE, at the session-creation site, rather than alongside
	// `ensureAgentSession(childSessionId, 'coder', worktreePath)` in
	// delegation-gate.ts: that call sits inside `if (resolvedTaskId)`, so a lane
	// dispatched without a resolvable plan task id would get a lane-rooted
	// session with no recorded root. This site covers every lane-rooted session
	// unconditionally. `provisionResult.worktreePath` is provisionWorktree's own
	// output and is never reachable from a tool argument.
	//
	// ORDER IS LOAD-BEARING. The child session must be registered with its real
	// agent name BEFORE its workspace root is recorded. `recordSessionWorkspaceRoot`
	// deliberately refuses to create a session, because creating one unnamed would
	// register `swarmState.activeAgent` as 'unknown' — which FAILS OPEN: 'unknown'
	// is truthy, so it clears the no-active-agent guards in guardrails and then
	// takes the `noScopeLenient` branch that skips the authority check entirely,
	// while scope-guard returns early because the role is not 'coder'. The lane
	// child's shell writes would run unenforced. Registering as 'coder' first also
	// restores this session's `recordSessionStart` and disk rehydration, which the
	// `directory` argument drives on the create path.
	ensureAgentSession(
		createResult.data.id,
		'coder',
		provisionResult.worktreePath,
	);
	recordSessionWorkspaceRoot(
		createResult.data.id,
		provisionResult.worktreePath,
	);
	rememberStandardWorktreeDispatch({
		callID: args.callID,
		parentSessionID: args.parentSessionID,
		taskId: args.taskId,
		planTaskId: args.planTaskId,
		handle: provisionResult,
		mergeStrategy: worktreeConfig.merge_strategy,
		laneIndex,
		worktree_dir: worktreeConfig.worktree_dir,
	});
}

const PRESERVE_COMMIT_TIMEOUT_MS = 30_000;

/**
 * Create a durable ownership tag without touching an in-flight background
 * coder's index or working tree. This is used only when both correlation
 * stores fail after launch: committing dirty files at that point could race
 * the still-running child, while a tag plus the durable merge-status record
 * makes restart cleanup fail closed.
 */
export async function preserveBackgroundWorktreeOwnershipForCallId(
	callID: string,
): Promise<{
	outcome: 'preserved' | 'preserve-failed' | 'not-found';
	tag?: string;
	ref?: string;
	error?: string;
}> {
	const dispatch = standardWorktreeByCallID.get(callID);
	if (!dispatch) return { outcome: 'not-found' };

	const refProc = _internals.bunSpawn(
		['git', '-C', dispatch.handle.worktreePath, 'rev-parse', 'HEAD'],
		{
			stdin: 'ignore',
			stdout: 'pipe',
			stderr: 'pipe',
			timeout: PRESERVE_COMMIT_TIMEOUT_MS,
		},
	);
	let ref = '';
	try {
		const exitCode = await refProc.exited;
		if (exitCode !== 0) {
			return {
				outcome: 'preserve-failed',
				error:
					(await refProc.stderr.text()) || `git rev-parse exited ${exitCode}`,
			};
		}
		ref = (await refProc.stdout.text()).trim();
	} finally {
		try {
			refProc.kill();
		} catch {
			// best-effort
		}
	}
	if (!ref) {
		return {
			outcome: 'preserve-failed',
			error: 'git rev-parse returned empty',
		};
	}

	const session = Buffer.from(dispatch.handle.sessionId, 'utf8').toString(
		'base64url',
	);
	const lane = Buffer.from(dispatch.handle.id, 'utf8').toString('base64url');
	const callDigest = createHash('sha256')
		.update(callID)
		.digest('hex')
		.slice(0, 12);
	const tag = `swarm-preserved-owner/${session}/${lane}/${callDigest}`;
	const tagProc = _internals.bunSpawn(
		['git', '-C', dispatch.handle.worktreePath, 'tag', tag, ref],
		{
			stdin: 'ignore',
			stdout: 'pipe',
			stderr: 'pipe',
			timeout: PRESERVE_COMMIT_TIMEOUT_MS,
		},
	);
	try {
		const exitCode = await tagProc.exited;
		if (exitCode !== 0) {
			return {
				outcome: 'preserve-failed',
				error: (await tagProc.stderr.text()) || `git tag exited ${exitCode}`,
			};
		}
	} finally {
		try {
			tagProc.kill();
		} catch {
			// best-effort
		}
	}
	return { outcome: 'preserved', tag, ref };
}

/**
 * FR-001c: Preserves dirty work in a worktree before cleanup on denial or cancellation.
 *
 * Detects dirty state, auto-commits with a descriptive message, tags the commit,
 * and returns the commit hash so the work is recoverable from the reflog.
 *
 * @returns Three distinct outcomes:
 *   - `{ outcome: 'clean', preserved: false }` — worktree was clean; nothing to preserve.
 *   - `{ outcome: 'preserved', preserved: true, ref: <hash> }` — dirty AND commit succeeded.
 *   - `{ outcome: 'preserve-failed', preserved: false, error: <msg> }` — dirty AND commit/tag failed.
 */
export async function preserveDirtyWorktreeForCallId(
	callID: string,
	reason: 'denied' | 'cancelled',
	_directory: string,
	_worktree_dir?: string,
): Promise<{
	outcome: 'clean' | 'preserved' | 'preserve-failed';
	preserved: false | true;
	ref?: string;
	error?: string;
}> {
	// Look in standardWorktreeByCallID first (active dispatch).
	const dispatch = standardWorktreeByCallID.get(callID);
	let worktreePath: string;
	let parentSessionID: string;

	if (dispatch) {
		worktreePath = dispatch.handle.worktreePath;
		parentSessionID = dispatch.parentSessionID;
	} else {
		// Not in active map — check awaiting-merge map.
		const awaiting = awaitingMergeByCallID.get(callID);
		if (!awaiting) {
			// No entry — either never provisioned or already cleaned up.
			return { outcome: 'clean', preserved: false };
		}
		worktreePath = awaiting.worktreePath;
		parentSessionID = awaiting.parentSessionID;
	}

	// Detect dirty state: git status --porcelain
	const statusProc = _internals.bunSpawn(
		['git', '-C', worktreePath, 'status', '--porcelain'],
		{
			stdin: 'ignore',
			stdout: 'pipe',
			stderr: 'pipe',
			timeout: PRESERVE_COMMIT_TIMEOUT_MS,
		},
	);
	let statusStdout = '';
	let statusStderr = '';
	try {
		const exitCode = await statusProc.exited;
		statusStdout = await statusProc.stdout.text();
		statusStderr = await statusProc.stderr.text();
		if (exitCode !== 0) {
			logger.log(
				`[swarm] preserveDirtyWorktreeForCallId: git status failed for ${callID}: ${statusStderr}`,
			);
			return {
				outcome: 'preserve-failed',
				preserved: false,
				error: `git status failed: ${statusStderr || `exit ${exitCode}`}`,
			};
		}
	} finally {
		try {
			statusProc.kill();
		} catch {
			// best-effort
		}
	}

	// If output is empty, worktree is clean — nothing to preserve
	if (statusStdout.trim() === '') {
		return { outcome: 'clean', preserved: false };
	}

	// Dirty — stage all changes
	const addProc = _internals.bunSpawn(
		['git', '-C', worktreePath, 'add', '-A'],
		{
			stdin: 'ignore',
			stdout: 'pipe',
			stderr: 'pipe',
			timeout: PRESERVE_COMMIT_TIMEOUT_MS,
		},
	);
	try {
		const addExit = await addProc.exited;
		if (addExit !== 0) {
			const addErr = await addProc.stderr.text();
			logger.log(
				`[swarm] preserveDirtyWorktreeForCallId: git add failed for ${callID}: ${addErr}`,
			);
			return {
				outcome: 'preserve-failed',
				preserved: false,
				error: `git add failed: ${addErr || `exit ${addExit}`}`,
			};
		}
	} finally {
		try {
			addProc.kill();
		} catch {
			// best-effort
		}
	}

	// Commit with a descriptive message
	const isoDate = new Date().toISOString();
	const sanitizedCallID = callID.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 64);
	const commitMessage = `swarm-preserved: ${reason} for callID ${sanitizedCallID} at ${isoDate}`;

	const commitProc = _internals.bunSpawn(
		['git', '-C', worktreePath, 'commit', '-m', commitMessage],
		{
			stdin: 'ignore',
			stdout: 'pipe',
			stderr: 'pipe',
			timeout: PRESERVE_COMMIT_TIMEOUT_MS,
		},
	);
	let commitHash = '';
	try {
		const commitExit = await commitProc.exited;
		if (commitExit !== 0) {
			const commitErr = await commitProc.stderr.text();
			logger.log(
				`[swarm] preserveDirtyWorktreeForCallId: git commit failed for ${callID}: ${commitErr}`,
			);
			return {
				outcome: 'preserve-failed',
				preserved: false,
				error: `git commit failed: ${commitErr || `exit ${commitExit}`}`,
			};
		}
	} finally {
		try {
			commitProc.kill();
		} catch {
			// best-effort
		}
	}

	// Get commit hash: git rev-parse HEAD
	const hashProc = _internals.bunSpawn(
		['git', '-C', worktreePath, 'rev-parse', 'HEAD'],
		{
			stdin: 'ignore',
			stdout: 'pipe',
			stderr: 'pipe',
			timeout: PRESERVE_COMMIT_TIMEOUT_MS,
		},
	);
	try {
		const hashExit = await hashProc.exited;
		if (hashExit !== 0) {
			const hashErr = await hashProc.stderr.text();
			logger.log(
				`[swarm] preserveDirtyWorktreeForCallId: git rev-parse failed for ${callID}: ${hashErr}`,
			);
			return {
				outcome: 'preserve-failed',
				preserved: false,
				error: `git rev-parse failed: ${hashErr || `exit ${hashExit}`}`,
			};
		}
		commitHash = (await hashProc.stdout.text()).trim();
	} finally {
		try {
			hashProc.kill();
		} catch {
			// best-effort
		}
	}

	if (!commitHash) {
		return {
			outcome: 'preserve-failed',
			preserved: false,
			error: 'git rev-parse returned empty hash',
		};
	}

	// Tag the preserved commit: swarm-preserved-<sanitizedCallID>-<shortHash>
	const shortHash = commitHash.slice(0, 8);
	const tagName = `swarm-preserved-${sanitizedCallID}-${shortHash}`;

	const tagProc = _internals.bunSpawn(
		['git', '-C', worktreePath, 'tag', tagName],
		{
			stdin: 'ignore',
			stdout: 'pipe',
			stderr: 'pipe',
			timeout: PRESERVE_COMMIT_TIMEOUT_MS,
		},
	);
	try {
		const tagExit = await tagProc.exited;
		if (tagExit !== 0) {
			const tagErr = await tagProc.stderr.text();
			logger.log(
				`[swarm] preserveDirtyWorktreeForCallId: git tag failed for ${callID}: ${tagErr}`,
			);
			return {
				outcome: 'preserve-failed',
				preserved: false,
				error: `git tag failed: ${tagErr || `exit ${tagExit}`}`,
			};
		}
	} finally {
		try {
			tagProc.kill();
		} catch {
			// best-effort
		}
	}

	// Push advisory
	const session = ensureAgentSession(parentSessionID);
	pushAdvisory(
		session,
		`STANDARD_WORKTREE_PRESERVED: dispatch ${callID} dirty work preserved as commit ${commitHash} (tag: ${tagName}; reason: ${reason}); worktree will be cleaned.`,
	);

	return { outcome: 'preserved', preserved: true, ref: commitHash };
}

/**
 * FR-001b SC-004: Preserves dirty worktree state at a known worktree path.
 *
 * This is the path-based counterpart of `preserveDirtyWorktreeForCallId` for the
 * pre-provision collision fallback path where the callID is no longer tracked in
 * any map (dispatch was GC'd). It runs the same git status → add → commit → tag
 * sequence on a direct worktreePath.
 *
 * @param worktreePath - Absolute path to the worktree directory.
 * @param branchName - Branch name (used only for advisory messages).
 * @param reason - Preservation reason: 'denied' (pre-provision collision) or 'cancelled'.
 * @param directory - Project root for git commands.
 * @param worktree_dir - Optional worktree-dir override.
 * @returns Preservation result matching preserveDirtyWorktreeForCallId's shape.
 */
export async function preserveDirtyWorktreeAtPath(
	worktreePath: string,
	branchName: string,
	reason: 'denied' | 'cancelled',
	_directory: string,
	_worktree_dir?: string,
): Promise<{
	outcome: 'clean' | 'preserved' | 'preserve-failed';
	preserved: false | true;
	ref?: string;
	error?: string;
}> {
	// Detect dirty state: git status --porcelain
	const statusProc = _internals.bunSpawn(
		['git', '-C', worktreePath, 'status', '--porcelain'],
		{
			stdin: 'ignore',
			stdout: 'pipe',
			stderr: 'pipe',
			timeout: PRESERVE_COMMIT_TIMEOUT_MS,
		},
	);
	let statusStdout = '';
	let statusStderr = '';
	try {
		const exitCode = await statusProc.exited;
		statusStdout = await statusProc.stdout.text();
		statusStderr = await statusProc.stderr.text();
		if (exitCode !== 0) {
			logger.log(
				`[swarm] preserveDirtyWorktreeAtPath: git status failed for ${worktreePath}: ${statusStderr}`,
			);
			return {
				outcome: 'preserve-failed',
				preserved: false,
				error: `git status failed: ${statusStderr || `exit ${exitCode}`}`,
			};
		}
	} finally {
		try {
			statusProc.kill();
		} catch {
			// best-effort
		}
	}

	// If output is empty, worktree is clean — nothing to preserve
	if (statusStdout.trim() === '') {
		return { outcome: 'clean', preserved: false };
	}

	// Dirty — stage all changes
	const addProc = _internals.bunSpawn(
		['git', '-C', worktreePath, 'add', '-A'],
		{
			stdin: 'ignore',
			stdout: 'pipe',
			stderr: 'pipe',
			timeout: PRESERVE_COMMIT_TIMEOUT_MS,
		},
	);
	try {
		const addExit = await addProc.exited;
		if (addExit !== 0) {
			const addErr = await addProc.stderr.text();
			logger.log(
				`[swarm] preserveDirtyWorktreeAtPath: git add failed for ${worktreePath}: ${addErr}`,
			);
			return {
				outcome: 'preserve-failed',
				preserved: false,
				error: `git add failed: ${addErr || `exit ${addExit}`}`,
			};
		}
	} finally {
		try {
			addProc.kill();
		} catch {
			// best-effort
		}
	}

	// Commit with a descriptive message
	const isoDate = new Date().toISOString();
	const sanitizedPath = worktreePath
		.replace(/[^A-Za-z0-9._-]/g, '-')
		.slice(0, 64);
	const sanitizedBranch = branchName
		.replace(/[^A-Za-z0-9._-]/g, '-')
		.slice(0, 64);
	const commitMessage = `swarm-preserved: ${reason} for worktree ${sanitizedPath} at ${isoDate}`;

	const commitProc = _internals.bunSpawn(
		['git', '-C', worktreePath, 'commit', '-m', commitMessage],
		{
			stdin: 'ignore',
			stdout: 'pipe',
			stderr: 'pipe',
			timeout: PRESERVE_COMMIT_TIMEOUT_MS,
		},
	);
	let commitHash = '';
	try {
		const commitExit = await commitProc.exited;
		if (commitExit !== 0) {
			const commitErr = await commitProc.stderr.text();
			logger.log(
				`[swarm] preserveDirtyWorktreeAtPath: git commit failed for ${worktreePath}: ${commitErr}`,
			);
			return {
				outcome: 'preserve-failed',
				preserved: false,
				error: `git commit failed: ${commitErr || `exit ${commitExit}`}`,
			};
		}
	} finally {
		try {
			commitProc.kill();
		} catch {
			// best-effort
		}
	}

	// Get commit hash: git rev-parse HEAD
	const hashProc = _internals.bunSpawn(
		['git', '-C', worktreePath, 'rev-parse', 'HEAD'],
		{
			stdin: 'ignore',
			stdout: 'pipe',
			stderr: 'pipe',
			timeout: PRESERVE_COMMIT_TIMEOUT_MS,
		},
	);
	try {
		const hashExit = await hashProc.exited;
		if (hashExit !== 0) {
			const hashErr = await hashProc.stderr.text();
			logger.log(
				`[swarm] preserveDirtyWorktreeAtPath: git rev-parse failed for ${worktreePath}: ${hashErr}`,
			);
			return {
				outcome: 'preserve-failed',
				preserved: false,
				error: `git rev-parse failed: ${hashErr || `exit ${hashExit}`}`,
			};
		}
		commitHash = (await hashProc.stdout.text()).trim();
	} finally {
		try {
			hashProc.kill();
		} catch {
			// best-effort
		}
	}

	if (!commitHash) {
		return {
			outcome: 'preserve-failed',
			preserved: false,
			error: 'git rev-parse returned empty hash',
		};
	}

	// Tag the preserved commit: swarm-preserved-worktree-<sanitizedPath>-<shortHash>
	const shortHash = commitHash.slice(0, 8);
	const tagName = `swarm-preserved-worktree-${sanitizedBranch}-${shortHash}`;

	const tagProc = _internals.bunSpawn(
		['git', '-C', worktreePath, 'tag', tagName],
		{
			stdin: 'ignore',
			stdout: 'pipe',
			stderr: 'pipe',
			timeout: PRESERVE_COMMIT_TIMEOUT_MS,
		},
	);
	try {
		const tagExit = await tagProc.exited;
		if (tagExit !== 0) {
			const tagErr = await tagProc.stderr.text();
			logger.log(
				`[swarm] preserveDirtyWorktreeAtPath: git tag failed for ${worktreePath}: ${tagErr}`,
			);
			return {
				outcome: 'preserve-failed',
				preserved: false,
				error: `git tag failed: ${tagErr || `exit ${tagExit}`}`,
			};
		}
	} finally {
		try {
			tagProc.kill();
		} catch {
			// best-effort
		}
	}

	return { outcome: 'preserved', preserved: true, ref: commitHash };
}

/**
 * FR-001a: Unconditionally cleans up a standard worktree dispatch's resources.
 *
 * Called at the end of every dispatch outcome (success, denial, cancellation)
 * to ensure no worktree or branch is left behind.
 *
 * @param callID - The callID of the dispatch to clean up.
 * @param reason - The outcome reason: 'success', 'denied', or 'cancelled'.
 * @param directory - The project root (required for git worktree/branch commands).
 * @param worktree_dir - Configured worktree-dir override.
 */
export async function cleanupStandardWorktreeForCallId(
	callID: string,
	reason: 'success' | 'denied' | 'cancelled',
	directory: string,
	worktree_dir?: string,
): Promise<void> {
	// Look in standardWorktreeByCallID first (active dispatch).
	const dispatch = standardWorktreeByCallID.get(callID);
	let worktreePath: string;
	let branchName: string;
	let parentSessionID: string;

	if (dispatch) {
		worktreePath = dispatch.handle.worktreePath;
		branchName = dispatch.handle.branchName;
		parentSessionID = dispatch.parentSessionID;
	} else {
		// Not in active map — check awaiting-merge map (production moves the
		// entry there BEFORE calling finishStandardWorktreeDispatch).
		const awaiting = awaitingMergeByCallID.get(callID);
		if (!awaiting) {
			// No entry — either never provisioned or already cleaned up.
			return;
		}
		worktreePath = awaiting.worktreePath;
		branchName = awaiting.branch;
		parentSessionID = awaiting.parentSessionID;
	}

	// FR-001c: Preserve dirty work before cleanup on denial or cancellation.
	// The success path uses attemptMergeBackFromDirty which handles state differently.
	let preserveResult:
		| {
				outcome: 'clean' | 'preserved' | 'preserve-failed';
				preserved: boolean;
				ref?: string;
				error?: string;
		  }
		| undefined;
	if (reason === 'denied' || reason === 'cancelled') {
		try {
			preserveResult = await _internals.preserveDirtyWorktreeForCallId(
				callID,
				reason,
				directory,
				worktree_dir,
			);
		} catch (err) {
			logger.log(
				`[swarm] cleanupStandardWorktreeForCallId: preserveDirtyWorktreeForCallId threw for ${callID}: ${err}`,
			);
			preserveResult = {
				outcome: 'preserve-failed',
				preserved: false,
				error: String(err),
			};
		}

		// F-FB013: a dispatch can modify its worktree after the first clean
		// snapshot but before force-removal begins. Re-check immediately before
		// destructive cleanup so a late write is committed or fails closed.
		if (preserveResult.outcome === 'clean') {
			try {
				preserveResult = await _internals.preserveDirtyWorktreeForCallId(
					callID,
					reason,
					directory,
					worktree_dir,
				);
			} catch (err) {
				logger.log(
					`[swarm] cleanupStandardWorktreeForCallId: final preservation check threw for ${callID}: ${err}`,
				);
				preserveResult = {
					outcome: 'preserve-failed',
					preserved: false,
					error: String(err),
				};
			}
		}
	}

	// FR-001c fail-closed: if dirty state was detected AND preservation did NOT succeed,
	// do NOT remove the worktree or branch — return early with a clear advisory.
	if (preserveResult && preserveResult.outcome === 'preserve-failed') {
		// Dirty work was present but could not be preserved — ABORT cleanup to protect uncommitted work.
		// Do NOT call removeWorktree or postMergeCleanup.
		// Remove ONLY the in-memory tracking entries so a future retry can pick up the worktree state.
		standardWorktreeByCallID.delete(callID);
		awaitingMergeByCallID.delete(callID);

		const session = ensureAgentSession(parentSessionID);
		pushAdvisory(
			session,
			`STANDARD_WORKTREE_PRESERVATION_FAILED_ABORT_CLEANUP: dispatch ${callID} has dirty uncommitted work but preservation failed (${preserveResult.error}). ` +
				`Cleanup aborted to protect uncommitted work. Investigate and resolve manually. ` +
				`Worktree=${worktreePath}; branch=${branchName}.`,
		);
		return;
	}

	// Remove the worktree directory.
	await _internals
		.removeWorktree(worktreePath, directory, {
			force: true,
			worktreeDir: worktree_dir,
		})
		.catch((err) =>
			logger.log(
				`[swarm] cleanupStandardWorktreeForCallId: removeWorktree failed for ${callID}: ${err}`,
			),
		);

	// BRANCH DELETION: unconditionally on every dispatch outcome.
	// The branch is deleted on success (merge-back completed cleanly), denied
	// (orchestrator denied the dispatch), and cancelled (user/system cancelled).
	// Branch deletion is safe in all cases — the user's work is preserved in
	// the commit history via the lane branch reflog until GC.
	await _internals
		.postMergeCleanup(directory, branchName)
		.catch((err) =>
			logger.log(
				`[swarm] cleanupStandardWorktreeForCallId: postMergeCleanup failed for ${callID}: ${err}`,
			),
		);

	// Remove entries from in-memory tracking maps.
	standardWorktreeByCallID.delete(callID);
	awaitingMergeByCallID.delete(callID);

	const session = ensureAgentSession(parentSessionID);
	pushAdvisory(
		session,
		`STANDARD_WORKTREE_CLEANUP: dispatch ${callID} cleaned up (reason: ${reason}); worktree=${worktreePath}; branch=${branchName}.`,
	);
}

/**
 * FR-001a: Abort an in-flight standard worktree dispatch.
 *
 * Called when a dispatch needs to be cancelled before merge-back completes.
 * Handles the case where the worktree was never provisioned (no entry in
 * standardWorktreeByCallID) by returning early with a no-op diagnostic.
 *
 * @param callID - The callID of the dispatch to abort.
 * @param reason - The abort reason: 'denied' or 'cancelled'.
 * @param directory - The project root (required for git worktree/branch commands).
 */
export async function abortStandardWorktreeDispatch(
	callID: string,
	reason: 'denied' | 'cancelled',
	directory: string,
): Promise<void> {
	const dispatch = standardWorktreeByCallID.get(callID);
	if (!dispatch) {
		// No entry — either never provisioned or already cleaned up.
		const session = ensureAgentSession('unknown');
		pushAdvisory(
			session,
			`STANDARD_WORKTREE_ABORT_NOOP: dispatch ${callID} has no tracked worktree to abort (reason: ${reason}).`,
		);
		return;
	}

	await cleanupStandardWorktreeForCallId(
		callID,
		reason,
		directory,
		dispatch.worktree_dir,
	);
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
	settlement: StandardWorktreeSettlementOptions = {},
): Promise<StandardWorktreeSettlementResult> {
	const wtConfig = config
		? resolveWorktreeIsolationConfig(config)
		: DEFAULT_WORKTREE_ISOLATION_CONFIG;

	// Resolve callID: explicit param takes precedence (delegation-gate.ts path),
	// otherwise derive from dispatch (backward-compat for direct test callers).
	const resolvedCallID = callID ?? dispatch.callID;

	const run = async (): Promise<StandardWorktreeSettlementResult> => {
		const mergeResult = await _internals.attemptMergeBackFromDirty(
			dispatch.handle.worktreePath,
			dispatch.handle.branchName,
			directory,
			getMergeStrategy({ merge_strategy: dispatch.mergeStrategy }),
			{
				operationId: settlement.operationId,
				resume: settlement.resume,
				onBeforeMerge: settlement.onBeforeMerge,
			},
		);
		// Key the merge-back status by the plan task id (which equals the
		// `taskId` Epic Rule 2 sees in `updateTaskStatus`); fall back to the
		// dispatch taskId for non-plan dispatches.
		const statusKey = dispatch.planTaskId ?? dispatch.taskId;
		if ('merged' in mergeResult && mergeResult.merged) {
			const mergedSettlement: StandardWorktreeMergedSettlement = {
				outcome: 'merged',
				strategy: mergeResult.strategy,
				autoCommitted: mergeResult.autoCommitted,
				cleaned: mergeResult.cleaned,
				reconciled: mergeResult.reconciled ?? false,
				provenance: mergeResult.provenance,
			};

			if (settlement.onMerged) {
				try {
					await settlement.onMerged(mergedSettlement);
				} catch (error) {
					const failedSettlement: StandardWorktreeFailedSettlement = {
						outcome: 'failed',
						stage: 'settlement-persist',
						message: `Git merge-back succeeded but settlement persistence failed: ${String(error)}`,
						provenance: mergeResult.provenance,
					};
					recordWorktreeMergeFailure(statusKey, {
						outcome: 'failed',
						stage: failedSettlement.stage,
						message: failedSettlement.message,
						worktreePath: dispatch.handle.worktreePath,
						branch: dispatch.handle.branchName,
						completedAt: Date.now(),
					});
					const session = ensureAgentSession(dispatch.parentSessionID);
					pushAdvisory(
						session,
						`STANDARD_WORKTREE_SETTLEMENT_PERSIST_FAILED: task ${dispatch.taskId} landed in ${directory}, but settlement persistence failed; worktree and branch preserved at ${dispatch.handle.worktreePath} (${dispatch.handle.branchName}).`,
					);
					return failedSettlement;
				}
			}

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

			// FR-104 SC-111: Increment successful-dispatch counter and check release
			const state = serializationStateBySessionID.get(dispatch.parentSessionID);
			if (state) {
				state.successfulDispatchesSince++;
				checkStandardWorktreeSerializationRelease(
					dispatch.parentSessionID,
					wtConfig,
				);
			}

			// Cleanup unconditionally — runs on success, partial, AND failed.
			await cleanupStandardWorktreeForCallId(
				resolvedCallID,
				'success',
				directory,
				dispatch.worktree_dir,
			);

			return mergedSettlement;
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
			pushAdvisory(
				session,
				`STANDARD_WORKTREE_MERGE_PARTIAL: task ${dispatch.taskId} preserved at ${dispatch.handle.worktreePath}; stage: ${mergeResult.stage}; ${mergeResult.message}`,
			);

			// F-C004: merge conflicts retain the lane worktree and branch for
			// recovery. The conflict can leave uncommitted state that must not be
			// force-removed under the successful-cleanup path.

			return {
				outcome: 'partial',
				stage: mergeResult.stage,
				message: mergeResult.message,
				autoCommitted: mergeResult.autoCommitted,
				cleaned: mergeResult.cleaned,
				conflictFiles: mergeResult.conflictFiles,
				provenance: mergeResult.provenance,
			};
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
			pushAdvisory(
				session,
				`STANDARD_WORKTREE_MERGE_FAILED: task ${dispatch.taskId} preserved at ${dispatch.handle.worktreePath}; stage: ${mergeResult.stage}; ${mergeResult.message}.`,
			);

			// F-C004: retain failed merge lanes for recovery. In particular, a
			// cleanup-stage failure can leave dirty or untracked work that has not
			// been safely committed yet.
			return {
				outcome: 'failed',
				stage: mergeResult.stage,
				message: mergeResult.message,
				provenance: mergeResult.provenance,
			};
		}

		return {
			outcome: 'failed',
			stage: 'merge',
			message: 'Merge-back returned an unexpected result',
		};
	};

	const queuedRun = standardWorktreeMergeQueue.then(run, run);
	standardWorktreeMergeQueue = queuedRun;
	const result = await queuedRun;

	// SC-115: Remove from awaiting-merge registry after merge-back completes
	// (success, partial, or failed — all three paths).
	// NOTE: This is now redundant since cleanupStandardWorktreeForCallId also
	// deletes from awaitingMergeByCallID, but kept for safety in case
	// cleanupStandardWorktreeForCallId was never called (e.g., early throw).
	if (resolvedCallID) {
		awaitingMergeByCallID.delete(resolvedCallID);
	}
	return result;
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
		logger.log(
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
	pruneStaleWorktreeMetadata,
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
	/** FR-001a: cleanup entry point for finishStandardWorktreeDispatch. */
	cleanupStandardWorktreeForCallId,
	/** FR-001c: preserves dirty worktree state before cleanup on denial/cancellation. */
	preserveDirtyWorktreeForCallId,
	/** Background launch durability fallback: tag ownership without racing the child. */
	preserveBackgroundWorktreeOwnershipForCallId,
	tryAcquireWorktreeLifecycleLock: tryAcquireLock,
	recordWorktreeProvisioningOwner,
	removeWorktreeProvisioningOwner,
	/** FR-001b SC-004: path-based dirty worktree preservation for stale-lane fallback. */
	preserveDirtyWorktreeAtPath,
	/** FR-001a: abort entry point for in-flight dispatches. */
	abortStandardWorktreeDispatch,
	standardWorktreeByCallID,
	/** FR-001b SC-004: pre-provision collision check. */
	preProvisionCollisionCheck,
	/** Restart-safe durable owner classification for a colliding lane. */
	inspectStandardWorktreeCollisionOwnership,
	/** FR-001b SC-005: lane ownership validation. */
	isLaneOwnedByCurrentSession,
	/** FR-001b: bunSpawn — exposed for test injection so collision check can be mocked. */
	bunSpawn,
};
