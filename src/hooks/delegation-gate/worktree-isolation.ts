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
import { closeProjectDb } from '../../db/project-db';
import { tryAcquireLock } from '../../parallel/file-locks';
import { recordLiveLaneOwner } from '../../parallel/lane-owners';
import { isUntrustedEnvKey, isValidEnvKey } from '../../sandbox/executor';
import {
	ensureAgentSession,
	markReviewerScopeGenerationMergebackPending,
	recordSessionWorkspaceRoot,
	swarmState,
} from '../../state';
import { pushAdvisory } from '../../utils/advisory-queue';
import { bunSpawn } from '../../utils/bun-compat';
import { sameProjectRoot } from '../../utils/canonical-root.js';
import { teardownEphemeralSessionVerified } from '../../utils/ephemeral-session-teardown.js';
import { resolveGitExecutable } from '../../utils/git-executable.js';
import * as logger from '../../utils/logger.js';
import { withTimeout } from '../../utils/timeout.js';
import type { WorktreeHandle } from '../../worktree';
import {
	attemptMergeBackFromDirty,
	cleanupOrphanedBranches,
	getMergeStrategy,
	isPathUnderSwarmWorktreeBase,
	makeWorktreeBranchName,
	mergeInternals,
	postMergeCleanup,
	provisionWorktree,
	pruneStaleWorktreeMetadata,
	recoverMergeBackFromImmutableCoordinates,
	removeWorktree,
	startupOrphanRecovery,
} from '../../worktree';
import type {
	DirtyMergeOptions,
	ImmutableMergeRecoveryCoordinates,
	MergeOperationProvenance,
} from '../../worktree/merge';
import {
	SOURCE_WORKTREE_GONE_STAGE,
	SOURCE_WORKTREE_UNCERTAIN_STAGE,
} from '../../worktree/merge';
import { verifyReviewerScopeGenerationMergeBack } from '../reviewer-scope-mergeback';
import { recordDeadLaneReclaim } from './dead-lane-reclaim';
import {
	clearWorktreeMergeStatus,
	recordWorktreeMergeFailure,
} from './worktree-merge-status';
import type { WorktreeProvisioningOwnerRemovalIdentity } from './worktree-provisioning-owner';
import {
	recordWorktreeProvisioningOwner,
	removeWorktreeProvisioningOwner,
	WORKTREE_LIFECYCLE_LOCK_FILE,
} from './worktree-provisioning-owner';
import type {
	ClaimWorktreeRecoveryAuthorityRequest,
	WorktreeRecoveryAuthorityRecord,
	WorktreeRecoveryImmutableIdentityInput,
	WorktreeRecoveryLookupResult,
	WorktreeRecoveryStrategy,
} from './worktree-recovery-authority';
import {
	claimWorktreeRecoveryAuthority,
	finalizeWorktreeRecoveryAuthority,
	lookupWorktreeRecoveryAuthoritiesByTask,
	publishWorktreeRecoveryAuthority,
	releaseWorktreeRecoveryClaim,
	renewWorktreeRecoveryClaim,
	replayWorktreeRecoveryClaimJournal,
} from './worktree-recovery-authority';

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
	reservationId?: string;
	generation?: number;
	provisioningOwner?: WorktreeProvisioningOwnerRemovalIdentity;
	canonicalBranch?: string;
	canonicalPath?: string;
	handle: WorktreeHandle;
	mergeStrategy: 'merge' | 'rebase' | 'cherry-pick';
	recoveryClaim?: {
		authorityDigest: string;
		claimRevision: number;
		rawToken: string;
		coordinates?: ImmutableMergeRecoveryCoordinates;
		settlement?: {
			sourceCommitOrder: string[];
			rewrittenCommitOrder: string[];
		};
	};
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
	/** Exact durable launch identity threaded from the delegation gate. */
	reservationId?: string;
	generation?: number;
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

const WORKTREE_RECOVERY_CLAIM_LEASE_MS = 5 * 60_000;
/**
 * Issue #2599: default for `worktree.session_create_timeout_ms` (mirrored in
 * WorktreeIsolationConfigSchema + DEFAULT_WORKTREE_ISOLATION_CONFIG). The old
 * hardcoded 5 s budget failed every dispatch on hosts whose fresh-worktree
 * child init legitimately exceeds it (cold-FS plugin init) AND leaked the
 * late-accepted child session, locking the lane DB.
 */
const WORKTREE_SESSION_CREATE_TIMEOUT_MS = 30_000;
const WORKTREE_SESSION_CREATE_SETTLE_GRACE_MS = 5_000;

type CreateSettleState<T> =
	| { status: 'fulfilled'; result: T }
	| { status: 'rejected' };

/**
 * Issue #2599: bounded lane session.create with deterministic late-settle
 * handling. The create promise's outcome is captured exactly once into a
 * derived settle-state promise — never a mutable flag read across async
 * continuations — so a create that settles after the deadline reaches
 * `onLateResolve` (verified teardown of the late child) under EVERY
 * microtask interleaving, and only after the settle (or this grace bound)
 * does the caller's lane cleanup begin.
 */
async function createSessionWithinBudget<T>(
	promise: Promise<T>,
	label: string,
	onLateResolve?: (result: T) => Promise<void> | void,
	timeoutMs: number = _internals.worktreeSessionCreateTimeoutMs,
): Promise<T> {
	const settled = new Promise<CreateSettleState<T>>((resolveState) => {
		void promise.then(
			(result) => resolveState({ status: 'fulfilled', result }),
			() => resolveState({ status: 'rejected' }),
		);
	});
	try {
		return await withTimeout(
			promise,
			timeoutMs,
			new Error(
				`${label} deadline expired after ${timeoutMs}ms (worktree.session_create_timeout_ms)`,
			),
		);
	} catch (error) {
		// Deadline fired. Attach exactly ONE settle-continuation that runs
		// verified teardown if the create FULFILLS — whenever that happens,
		// even after the settle grace below expires (the create may settle
		// long after the deadline error reached the caller; `settled`
		// resolves exactly once, so teardown fires at most once). A late
		// REJECTION needs no cleanup (the caller's failure path is already
		// entered — the pre-#2599 contract, preserved).
		//
		// The continuation gets its own TERMINAL catch. Under the current
		// race-based withTimeout the grace await's Promise.race already
		// attaches a handler that would absorb a late rejection, but that is
		// an implementation detail of src/utils/timeout.ts, not a contract:
		// this terminal catch makes the continuation's error handling
		// self-contained (and logged) no matter how withTimeout evolves
		// (#2599 review round 1).
		const teardown = settled
			.then(
				async (state) => {
					if (state.status === 'fulfilled') {
						await onLateResolve?.(state.result);
					}
				},
				() => {
					// `settled` never rejects by construction; defensive only.
				},
			)
			.catch((teardownError: unknown) => {
				logger.log(
					`[worktree-isolation] ${label} late-settle teardown failed: ${
						teardownError instanceof Error
							? teardownError.message
							: String(teardownError)
					}`,
				);
			});
		// AC4: give the create a bounded chance to settle BEFORE the caller's
		// lane cleanup starts, so deletion never races a booting child; a
		// create that never settles gives up at the grace bound.
		await withTimeout(
			teardown,
			_internals.worktreeSessionCreateSettleGraceMs,
			new Error(`${label} settle grace expired`),
		).catch(() => {});
		throw error;
	}
}

/**
 * Issue #2599: effective lane session-create deadline. The user's explicit
 * `worktree.session_create_timeout_ms` wins when set. NOTE: `args.config` is
 * the POST-zod-parse config (loader safeParse), so the schema's
 * `.default(30_000)` already supplies 30_000 for an unset knob in production —
 * the `_internals.worktreeSessionCreateTimeoutMs` fallback is reachable only
 * in tests (and from raw, unparseable config objects), where it preserves the
 * seam's pre-#2599 role as the test override for the dispatch paths.
 */
function resolveSessionCreateTimeoutMs(
	args: Parameters<typeof precreateStandardWorktreeSession>[0],
): number {
	const raw = (
		args.config as
			| { worktree?: { session_create_timeout_ms?: number } }
			| undefined
	)?.worktree?.session_create_timeout_ms;
	return raw ?? _internals.worktreeSessionCreateTimeoutMs;
}

/**
 * Issue #2599 AC6: a lane whose removal failed on a held handle (EBUSY) is
 * recorded for next-start reclaim and surfaced as a typed, actionable
 * diagnostic instead of being silently wedged until host restart.
 */
async function handleStrandedLane(lane: {
	directory: string;
	parentSessionID: string;
	lanePath: string;
	branchName: string;
	taskId: string;
	reason: string;
}): Promise<void> {
	recordDeadLaneReclaim(lane.directory, {
		lanePath: lane.lanePath,
		branchName: lane.branchName,
		parentSessionId: lane.parentSessionID,
		taskId: lane.taskId,
		reason: lane.reason,
	});
	const session = ensureAgentSession(lane.parentSessionID);
	pushAdvisory(
		session,
		`WORKTREE_LANE_STRANDED: lane ${lane.lanePath} could not be removed (${lane.reason}). ` +
			'A child session or system process may hold .swarm/swarm.db (WAL); its DB handle was released via closeProjectDb before this attempt. ' +
			'reclaim scheduled at next start.',
	);
}

interface RecoverySessionLaunch {
	childSessionId: string;
	worktreePath: string;
	branchName: string;
	strategy: WorktreeRecoveryStrategy;
	reservationId: string;
	generation: number;
	provisioningOwner: WorktreeProvisioningOwnerRemovalIdentity;
	canonicalBranch: string;
	canonicalPath: string;
	recoveryClaim: NonNullable<StandardWorktreeDispatch['recoveryClaim']>;
}

interface CleanupStandardWorktreeResult {
	removedWorktree: boolean;
	cleanedBranch: boolean;
	preservedRecoveryLane: boolean;
}

function rememberStandardWorktreeDispatch(
	dispatch: StandardWorktreeDispatch,
): void {
	standardWorktreeByCallID.set(dispatch.callID, dispatch);
}

function resolveRecoveryTaskId(input: {
	taskId: string;
	planTaskId?: string;
}): string {
	return input.planTaskId ?? input.taskId;
}

function toRecoveryStrategy(
	strategy:
		| StandardWorktreeDispatch['mergeStrategy']
		| MergeOperationProvenance['strategy'],
): WorktreeRecoveryStrategy {
	return strategy;
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

class StandardWorktreeLifecycleError extends Error {
	readonly kind = 'standard-worktree-lifecycle';

	constructor(message: string) {
		super(message);
		this.name = 'StandardWorktreeLifecycleError';
	}
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
	if (policy === 'required') throw new StandardWorktreeLifecycleError(message);
	if (hasInFlightStandardWorktreeDispatch(parentSessionID)) {
		throw new StandardWorktreeLifecycleError(
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
	throw new StandardWorktreeLifecycleError(message);
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
	standardWorktreeDegradationReasonBySession.set(sessionID, {
		reason: message,
		at: Date.now(),
	});
	const session = ensureAgentSession(sessionID);
	session.maxConcurrencyOverride = 1;
	pushAdvisory(
		session,
		`${message} Serializing standard coder dispatches for this session.`,
	);
}

/**
 * Issue #2271 bug 1: the latest reason a session's standard worktree
 * isolation degraded to serialized project-root execution, so dispatch sites
 * can record a durable event when a coder runs un-isolated. Cleared when the
 * session regains parallel eligibility.
 */
const standardWorktreeDegradationReasonBySession = new Map<
	string,
	{ reason: string; at: number }
>();

export function getStandardWorktreeDegradationReason(
	sessionID: string,
): { reason: string; at: number } | undefined {
	return standardWorktreeDegradationReasonBySession.get(sessionID);
}

export function resetStandardWorktreeIsolationState(): void {
	standardWorktreeByCallID.clear();
	standardWorktreeSerializationSessions.clear();
	serializationStateBySessionID.clear();
	standardWorktreeDegradationReasonBySession.clear();
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
	standardWorktreeDegradationReasonBySession.delete(sessionID);
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
				standardWorktreeDegradationReasonBySession.delete(key);
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
	// Issue #2236 (BL-1b): `_internals.resolveGitExecutable()` must not be able
	// to escape this function. The real resolver no longer throws — BL-1 made it
	// total, returning the unprobed bare name instead of a "git is missing"
	// error — but `_internals.resolveGitExecutable` is a replaceable DI seam, and
	// a typed contract must not rest on a reachability argument about today's
	// implementation. Calling it OUTSIDE the guard let a throw
	// escape this function entirely instead of becoming the typed result
	// the signature promises — structurally the same leak fixed in `runGit`
	// (`src/worktree/core.ts`), `src/worktree/merge.ts`, and
	// `./worktree-ownership-tag.ts`. Resolution and spawn are contained
	// together and mapped onto the SAME fail-closed result this function
	// already returns when `git worktree list` itself fails:
	// `{ collision: false, uncertainty }`.
	//
	// `uncertainty` is the load-bearing half. This is a destructive-cleanup
	// gate: `precreateStandardWorktreeSession` hard-stops the dispatch on any
	// `uncertainty`, so an enumeration that never ran can never be read as
	// "no lane exists". This is deliberately a dedicated catch rather than a
	// fall-through into the exit-code handling below — that path has a
	// `not a git repository` branch returning a bare `{ collision: false }`
	// with NO `uncertainty`, and a resolution failure must never reach it.
	let proc: ReturnType<typeof _internals.bunSpawn>;
	try {
		proc = _internals.bunSpawn(
			[
				_internals.resolveGitExecutable(),
				'-C',
				directory,
				'worktree',
				'list',
				'--porcelain',
			],
			{
				stdin: 'ignore',
				stdout: 'pipe',
				stderr: 'pipe',
				timeout: WORKTREE_LIST_TIMEOUT_MS,
			},
		);
	} catch (error) {
		const detail = `git worktree list could not start in ${directory}: ${
			error instanceof Error ? error.message : String(error)
		}`;
		// Destructive callers must not infer absence when enumeration never ran.
		logger.log(`[swarm] preProvisionCollisionCheck: ${detail}`);
		return { collision: false, uncertainty: detail };
	}
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

async function runRecoveryGit(
	directory: string,
	args: string[],
	timeoutMs = 15_000,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	let proc: ReturnType<typeof _internals.bunSpawn> | undefined;
	try {
		proc = _internals.bunSpawn(
			[_internals.resolveGitExecutable(), '-C', directory, ...args],
			{
				stdin: 'ignore',
				stdout: 'pipe',
				stderr: 'pipe',
				timeout: timeoutMs,
				env: { ...process.env, LC_ALL: 'C' },
			},
		);
		const exitCode = await proc.exited;
		const stdout = await proc.stdout.text();
		const stderr = await proc.stderr.text();
		return { exitCode, stdout, stderr };
	} catch (error) {
		return {
			exitCode: 1,
			stdout: '',
			stderr: error instanceof Error ? error.message : String(error),
		};
	} finally {
		try {
			proc?.kill();
		} catch {
			// best-effort
		}
	}
}

async function pathExists(targetPath: string): Promise<boolean> {
	try {
		await fs.stat(targetPath);
		return true;
	} catch {
		return false;
	}
}

async function buildWorktreeRecoveryPublishIdentity(input: {
	directory: string;
	dispatch: StandardWorktreeDispatch;
	taskId: string;
	provenance: MergeOperationProvenance;
	conflictFiles?: string[];
}): Promise<WorktreeRecoveryImmutableIdentityInput | undefined> {
	const mergeBase = await runRecoveryGit(input.directory, [
		'merge-base',
		input.provenance.targetHeadBefore,
		input.provenance.sourceHead,
	]);
	const mergeBaseOid = mergeBase.stdout.trim();
	if (
		mergeBase.exitCode !== 0 ||
		!/^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(mergeBaseOid)
	) {
		return undefined;
	}

	const targetHead = await runRecoveryGit(input.directory, [
		'rev-parse',
		'HEAD',
	]);
	const targetHeadOid = targetHead.stdout.trim();
	if (
		targetHead.exitCode !== 0 ||
		!/^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(targetHeadOid)
	) {
		return undefined;
	}

	return {
		originalCallID: input.dispatch.callID,
		parentSessionId: input.dispatch.parentSessionID,
		taskId: input.taskId,
		reservationId:
			input.dispatch.reservationId ??
			`worktree:${input.dispatch.parentSessionID}:${input.taskId}`,
		generation: input.dispatch.generation ?? 1,
		canonicalBranch:
			input.dispatch.canonicalBranch ?? input.dispatch.handle.branchName,
		canonicalPath:
			input.dispatch.canonicalPath ?? input.dispatch.handle.worktreePath,
		laneBranch: input.dispatch.handle.branchName,
		lanePath: input.dispatch.handle.worktreePath,
		expectedPrimaryHead: input.provenance.targetHeadBefore,
		sourceBaseOid: mergeBaseOid,
		sourceHeadOid: input.provenance.sourceHead,
		targetHeadOid,
		strategy: toRecoveryStrategy(input.provenance.strategy),
		...(input.conflictFiles && input.conflictFiles.length > 0
			? { declaredConflictFiles: input.conflictFiles }
			: {}),
	};
}

async function publishRecoveryAuthorityForSettlement(input: {
	directory: string;
	dispatch: StandardWorktreeDispatch;
	taskId: string;
	provenance?: MergeOperationProvenance;
	conflictFiles?: string[];
}): Promise<
	| { ok: true }
	| {
			ok: false;
			code: string;
			reason: string;
	  }
> {
	if (input.dispatch.recoveryClaim || !input.provenance) {
		return { ok: true };
	}
	const identity = await _internals.buildWorktreeRecoveryPublishIdentity({
		directory: input.directory,
		dispatch: input.dispatch,
		taskId: input.taskId,
		provenance: input.provenance,
		conflictFiles: input.conflictFiles,
	});
	if (!identity) {
		return {
			ok: false,
			code: 'identity_unavailable',
			reason:
				'worktree recovery publish identity could not be derived from the merge provenance',
		};
	}
	const published = _internals.publishWorktreeRecoveryAuthority(
		input.directory,
		identity,
	);
	return published.ok
		? { ok: true }
		: { ok: false, code: published.code, reason: published.reason };
}

function isExactRecoveryClaimantStillActive(
	authority: WorktreeRecoveryAuthorityRecord,
): boolean {
	const claim = authority.claim;
	if (!claim) return false;
	if (
		standardWorktreeByCallID.has(claim.claimantCallID) ||
		awaitingMergeByCallID.has(claim.claimantCallID)
	) {
		return true;
	}
	const childSession = swarmState.agentSessions.get(claim.childSessionId);
	if (!childSession?.workspaceDirectory?.trim()) {
		return false;
	}
	return sameProjectRoot(
		childSession.workspaceDirectory,
		authority.immutable.lanePath,
	);
}

function describeRecoveryMutationFailure(input: {
	action: 'publish' | 'renew' | 'release' | 'finalize';
	code: string;
	reason: string;
}): string {
	return `recovery claim ${input.action} failed (${input.code}): ${input.reason}`;
}

function maybeSelectRecoverableAuthority(
	lookup: WorktreeRecoveryLookupResult,
	collision: { existingBranch?: string; worktreePath?: string },
):
	| { status: 'match'; authority: WorktreeRecoveryAuthorityRecord }
	| {
			status: 'none';
	  }
	| { status: 'uncertain'; reason: string } {
	if (lookup.status !== 'ok') {
		return { status: 'uncertain', reason: lookup.reason };
	}
	const authority = lookup.authorities.find(
		(candidate) =>
			candidate.status !== 'finalized' &&
			candidate.immutable.laneBranch === collision.existingBranch &&
			candidate.immutable.lanePath === collision.worktreePath,
	);
	return authority ? { status: 'match', authority } : { status: 'none' };
}

export async function precreateStandardWorktreeSession(args: {
	config: PluginConfig;
	directory: string;
	parentSessionID: string;
	callID: string;
	taskId: string;
	planTaskId?: string;
	/** Exact durable launch identity threaded from the delegation gate. */
	reservationId?: string;
	generation?: number;
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
	let provisioningOwnerIdentity: WorktreeProvisioningOwnerRemovalIdentity = {
		reservationId:
			args.reservationId ??
			`foreground:${args.parentSessionID}:${resolveRecoveryTaskId(args)}:${args.callID}`,
		generation: Math.max(1, args.generation ?? 1),
		branchName: makeWorktreeBranchName(args.parentSessionID, args.taskId, {
			purpose: 'lane' as const,
		}),
	};
	let recoveryLaunch: RecoverySessionLaunch | undefined;

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

			const recoveryCandidate = maybeSelectRecoverableAuthority(
				_internals.lookupWorktreeRecoveryAuthoritiesByTask(args.directory, {
					parentSessionId: args.parentSessionID,
					taskId: resolveRecoveryTaskId(args),
				}),
				collision,
			);
			if (recoveryCandidate.status === 'uncertain') {
				hardStopStandardWorktreeLifecycle(
					args.parentSessionID,
					`STANDARD_WORKTREE_RECOVERY_AUTHORITY_UNCERTAIN: ${recoveryCandidate.reason}. Recovery re-dispatch was blocked.`,
				);
			}
			if (recoveryCandidate.status === 'match') {
				let recoveredChildSessionId = '';
				let claimed: Awaited<ReturnType<typeof claimWorktreeRecoveryAuthority>>;
				try {
					claimed = await _internals.claimWorktreeRecoveryAuthority(
						args.directory,
						{
							authorityDigest: recoveryCandidate.authority.authorityDigest,
							claimantCallID: args.callID,
							claimantSessionId: args.parentSessionID,
							leaseMs: WORKTREE_RECOVERY_CLAIM_LEASE_MS,
							createChildSession: async () => {
								const createResult = await createSessionWithinBudget(
									client.session.create({
										body: {
											parentID: args.parentSessionID,
											title: `${args.description ?? args.taskId} (worktree recovery lane)`,
										},
										query: { directory: collision.worktreePath },
									}),
									'STANDARD_WORKTREE_RECOVERY_SESSION_CREATE',
									async (result) => {
										const lateChildSessionId = result.data?.id;
										if (lateChildSessionId) {
											// Issue #2599: verified teardown. A surviving
											// late-accepted recovery child would re-lock the
											// preserved lane's swarm.db. The lane itself is
											// owned by recovery records (never reclaimed
											// here) — surface the leak, don't schedule
											// reclaim for a protected lane.
											const verification =
												await teardownEphemeralSessionVerified(
													client.session,
													lateChildSessionId,
												);
											if (!verification.ok) {
												pushAdvisory(
													ensureAgentSession(args.parentSessionID),
													`WORKTREE_RECOVERY_CHILD_SESSION_LEAKED: recovery child session ${lateChildSessionId} survived verified teardown (${verification.reason}); it holds the lane swarm.db at ${collision.worktreePath}. Retry the dispatch or restart the host to release it.`,
												);
											}
										}
									},
									resolveSessionCreateTimeoutMs(args),
								);
								recoveredChildSessionId = createResult.data?.id ?? '';
								if (!recoveredChildSessionId) {
									const createError = (createResult as { error?: unknown })
										.error;
									throw new Error(
										typeof createError === 'string'
											? createError
											: JSON.stringify(createError ?? 'missing session id'),
									);
								}
								return recoveredChildSessionId;
							},
							revalidateExpiredClaim: async ({ authority }) => {
								if (isExactRecoveryClaimantStillActive(authority)) {
									return {
										ok: false,
										reason:
											'expired recovery claim still belongs to a live claimant session or dispatch',
									};
								}
								if (
									authority.immutable.laneBranch !== collision.existingBranch ||
									authority.immutable.lanePath !== collision.worktreePath
								) {
									return {
										ok: false,
										reason:
											'preserved lane coordinates drifted before claim transfer',
									};
								}
								try {
									await fs.stat(authority.immutable.lanePath);
								} catch {
									return {
										ok: false,
										reason: 'preserved lane path is no longer live',
									};
								}
								const laneHead = await runRecoveryGit(args.directory, [
									'rev-parse',
									`${authority.immutable.laneBranch}^{commit}`,
								]);
								if (
									laneHead.exitCode !== 0 ||
									laneHead.stdout.trim() !== authority.immutable.sourceHeadOid
								) {
									return {
										ok: false,
										reason:
											'preserved lane head changed since authority publication',
									};
								}
								return { ok: true };
							},
						} satisfies ClaimWorktreeRecoveryAuthorityRequest,
					);
				} catch (error) {
					// Complete the PREPARED rollback in-process; startup replay remains
					// the crash backstop. The child is ephemeral and never received a
					// prompt, so abort-then-delete is safe and bounded.
					_internals.replayWorktreeRecoveryClaimJournal(args.directory);
					if (recoveredChildSessionId) {
						// Issue #2599: verified teardown of the orphaned recovery
						// child; a survivor surfaces a typed advisory (the preserved
						// lane is recovery-protected — never scheduled for reclaim).
						const verification = await teardownEphemeralSessionVerified(
							client.session,
							recoveredChildSessionId,
						);
						if (!verification.ok) {
							pushAdvisory(
								ensureAgentSession(args.parentSessionID),
								`WORKTREE_RECOVERY_CHILD_SESSION_LEAKED: recovery child session ${recoveredChildSessionId} survived verified teardown (${verification.reason}); it holds the lane swarm.db at ${collision.worktreePath}. Retry the dispatch or restart the host to release it.`,
							);
						}
					}
					hardStopStandardWorktreeLifecycle(
						args.parentSessionID,
						`STANDARD_WORKTREE_RECOVERY_SESSION_CREATE_FAILED: ${error instanceof Error ? error.message : String(error)}. The PREPARED claim was rolled back and recovery re-dispatch was blocked.`,
					);
				}
				if (!claimed.ok) {
					hardStopStandardWorktreeLifecycle(
						args.parentSessionID,
						`STANDARD_WORKTREE_RECOVERY_CLAIM_FAILED: ${claimed.reason}. The recovery child session ${recoveredChildSessionId} was created but the preserved lane was not reassigned.`,
					);
				}
				recoveryLaunch = {
					childSessionId: recoveredChildSessionId,
					worktreePath: collision.worktreePath,
					branchName: collision.existingBranch,
					strategy: recoveryCandidate.authority.immutable.strategy,
					reservationId: recoveryCandidate.authority.immutable.reservationId,
					generation: recoveryCandidate.authority.immutable.generation,
					provisioningOwner: {
						reservationId: recoveryCandidate.authority.immutable.reservationId,
						generation: recoveryCandidate.authority.immutable.generation,
						branchName: collision.existingBranch,
					},
					canonicalBranch:
						recoveryCandidate.authority.immutable.canonicalBranch,
					canonicalPath: recoveryCandidate.authority.immutable.canonicalPath,
					recoveryClaim: {
						authorityDigest: recoveryCandidate.authority.authorityDigest,
						claimRevision:
							claimed.authority.claim?.claimRevision ??
							recoveryCandidate.authority.claimCursor?.lastClaimRevision ??
							1,
						rawToken: claimed.rawToken,
						coordinates: {
							sourceBaseOid:
								recoveryCandidate.authority.immutable.sourceBaseOid,
							sourceHeadOid:
								recoveryCandidate.authority.immutable.sourceHeadOid,
							targetHeadOid:
								recoveryCandidate.authority.immutable.targetHeadOid,
							strategy: recoveryCandidate.authority.immutable.strategy,
						},
					},
				};
			}

			if (!recoveryLaunch) {
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

					// Issue #2599 AC5: release the lane DB handle before deletion.
					closeProjectDb(collision.worktreePath);
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
		}

		_internals.recordWorktreeProvisioningOwner(args.directory, {
			callID: args.callID,
			parentSessionId: args.parentSessionID,
			worktreeSessionId: args.parentSessionID,
			taskId: args.taskId,
			...provisioningOwnerIdentity,
		});
	} catch (error) {
		if (error instanceof StandardWorktreeLifecycleError) {
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

	let childSessionId = '';
	let handle: WorktreeHandle;
	let mergeStrategy: StandardWorktreeDispatch['mergeStrategy'];
	let reservationId: string | undefined;
	let generation: number | undefined;
	let canonicalBranch: string | undefined;
	let canonicalPath: string | undefined;
	let recoveryClaim: StandardWorktreeDispatch['recoveryClaim'];

	if (recoveryLaunch) {
		childSessionId = recoveryLaunch.childSessionId;
		handle = {
			worktreePath: recoveryLaunch.worktreePath,
			branchName: recoveryLaunch.branchName,
			purpose: 'lane',
			id: sanitizeWorktreeTaskId(args.taskId),
			sessionId: args.parentSessionID,
		};
		mergeStrategy = recoveryLaunch.strategy;
		reservationId = recoveryLaunch.reservationId;
		generation = recoveryLaunch.generation;
		provisioningOwnerIdentity = recoveryLaunch.provisioningOwner;
		canonicalBranch = recoveryLaunch.canonicalBranch;
		canonicalPath = recoveryLaunch.canonicalPath;
		recoveryClaim = recoveryLaunch.recoveryClaim;
	} else {
		reservationId =
			args.reservationId ??
			`foreground:${args.parentSessionID}:${resolveRecoveryTaskId(args)}:${args.callID}`;
		generation = provisioningOwnerIdentity.generation;
		canonicalPath = args.directory;
		// The profile needs the actual lane path, so we compute it after provisioning.
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
			_internals.removeWorktreeProvisioningOwner(
				args.directory,
				args.callID,
				provisioningOwnerIdentity,
			);
			throw error;
		}
		if ('error' in provisionResult) {
			_internals.removeWorktreeProvisioningOwner(
				args.directory,
				args.callID,
				provisioningOwnerIdentity,
			);
			const message = `STANDARD_WORKTREE_PROVISION_FAILED: ${provisionResult.error}.`;
			handleStandardWorktreeFailure(
				args.parentSessionID,
				worktreeConfig.policy,
				message,
			);
			return;
		}
		handle = provisionResult;
		mergeStrategy = worktreeConfig.merge_strategy;
		// Issue #2527 F3: durable live-lane-owner record (lifetime = the
		// lane's; cleared by removeWorktree on both success returns and GC'd
		// on read). Only recorded AFTER a successful provision, mirroring the
		// provisioning-owner constraint.
		recordLiveLaneOwner(args.directory, {
			lanePath: handle.worktreePath,
			branchName: handle.branchName,
			sessionId: args.parentSessionID,
			taskId: args.taskId,
		});
	}

	const originalPrompt =
		typeof args.outputArgs.prompt === 'string' ? args.outputArgs.prompt : '';
	args.outputArgs.prompt = [
		'<worktree_lane_context>',
		`authoritative_lane_root: ${JSON.stringify(handle.worktreePath)}`,
		'All FILE declarations and scope-bound edit/write paths must be workspace-relative to authoritative_lane_root.',
		'Remain in authoritative_lane_root: do not change directory into, or edit/write through, the primary checkout or any other worktree.',
		'Example: FILE: src/example.ts means <authoritative_lane_root>/src/example.ts, never <primary-checkout>/src/example.ts.',
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
		handle.worktreePath,
	);
	if (laneProfile) {
		try {
			const { writeLaneProfileToDiskReal } = await import(
				'../../worktree/core'
			);
			await writeLaneProfileToDiskReal(
				handle.worktreePath,
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

	if (!recoveryLaunch) {
		let createResult:
			| Awaited<ReturnType<typeof client.session.create>>
			| undefined;
		try {
			createResult = await createSessionWithinBudget(
				client.session.create({
					body: {
						parentID: args.parentSessionID,
						title: `${args.description ?? args.taskId} (worktree lane)`,
					},
					query: { directory: handle.worktreePath },
				}),
				'STANDARD_WORKTREE_SESSION_CREATE',
				async (result) => {
					const lateChildSessionId = result.data?.id;
					if (lateChildSessionId) {
						// Issue #2599: the create settled after the deadline —
						// verified teardown of the late child, and a typed strand
						// record when it survives (its plugin activity holds the
						// lane's swarm.db WAL lock).
						const verification = await teardownEphemeralSessionVerified(
							client.session,
							lateChildSessionId,
						);
						if (!verification.ok) {
							await handleStrandedLane({
								directory: args.directory,
								parentSessionID: args.parentSessionID,
								lanePath: handle.worktreePath,
								branchName: handle.branchName,
								taskId: args.taskId,
								reason: `late child session ${lateChildSessionId} survived verified teardown (${verification.reason})`,
							});
						}
					}
				},
				resolveSessionCreateTimeoutMs(args),
			);
		} catch (error) {
			// Issue #2599 AC5: release this process's handle on the lane DB
			// BEFORE any deletion attempt (Windows WAL lock ⇒ EBUSY).
			closeProjectDb(handle.worktreePath);
			const removal = await _internals
				.removeWorktree(handle.worktreePath, args.directory, {
					force: true,
					worktreeDir: worktreeConfig.worktree_dir,
				})
				.catch((cleanupError: unknown) => ({
					error:
						cleanupError instanceof Error
							? cleanupError.message
							: String(cleanupError),
				}));
			const removalError =
				typeof removal === 'object' &&
				removal !== null &&
				'error' in removal &&
				typeof removal.error === 'string'
					? removal.error
					: undefined;
			if (removalError) {
				logger.log(
					`[worktree-isolation] session-create failure cleanup could not remove lane ${handle.worktreePath}: ${removalError}`,
				);
				await handleStrandedLane({
					directory: args.directory,
					parentSessionID: args.parentSessionID,
					lanePath: handle.worktreePath,
					branchName: handle.branchName,
					taskId: args.taskId,
					reason: removalError,
				});
			}
			_internals.removeWorktreeProvisioningOwner(
				args.directory,
				args.callID,
				provisioningOwnerIdentity,
			);
			const detail = error instanceof Error ? error.message : String(error);
			const message = `STANDARD_WORKTREE_SESSION_CREATE_FAILED: ${detail}.`;
			handleStandardWorktreeFailure(
				args.parentSessionID,
				worktreeConfig.policy,
				message,
			);
			return;
		}
		if (!createResult?.data?.id) {
			// Issue #2271 bug 1: an abandoned lane here feeds future collision
			// churn — surface the failed cleanup instead of swallowing it silently.
			// Issue #2599 AC5: close the lane DB handle before deletion.
			closeProjectDb(handle.worktreePath);
			const removal = await _internals
				.removeWorktree(handle.worktreePath, args.directory, {
					force: true,
					worktreeDir: worktreeConfig.worktree_dir,
				})
				.catch((cleanupError: unknown) => ({
					error:
						cleanupError instanceof Error
							? cleanupError.message
							: String(cleanupError),
				}));
			const removalError =
				typeof removal === 'object' &&
				removal !== null &&
				'error' in removal &&
				typeof removal.error === 'string'
					? removal.error
					: undefined;
			if (removalError) {
				logger.log(
					`[worktree-isolation] session-create failure cleanup could not remove lane ${handle.worktreePath}: ${removalError}`,
				);
				await handleStrandedLane({
					directory: args.directory,
					parentSessionID: args.parentSessionID,
					lanePath: handle.worktreePath,
					branchName: handle.branchName,
					taskId: args.taskId,
					reason: removalError,
				});
			}
			_internals.removeWorktreeProvisioningOwner(
				args.directory,
				args.callID,
				provisioningOwnerIdentity,
			);
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
		childSessionId = createResult.data.id;
	}
	if (!childSessionId) {
		throw new Error(
			'STANDARD_WORKTREE_SESSION_CREATE_FAILED: missing child session id.',
		);
	}

	args.outputArgs.task_id = childSessionId;
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
	// unconditionally. `handle.worktreePath` is provisionWorktree's own output
	// and is never reachable from a tool argument.
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
	ensureAgentSession(childSessionId, 'coder', handle.worktreePath);
	recordSessionWorkspaceRoot(childSessionId, handle.worktreePath);
	rememberStandardWorktreeDispatch({
		callID: args.callID,
		parentSessionID: args.parentSessionID,
		taskId: args.taskId,
		planTaskId: args.planTaskId,
		reservationId,
		generation,
		provisioningOwner: provisioningOwnerIdentity,
		canonicalBranch,
		canonicalPath,
		handle,
		mergeStrategy,
		recoveryClaim,
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

	// Issue #2236 (BL-1b): `_internals.resolveGitExecutable()` is called INSIDE
	// the guard, mirroring `runGit` in `src/worktree/core.ts`. Outside it, a
	// `GitBinaryMissingError` escaped this function instead of becoming the
	// typed `outcome` the signature promises. Preserving the worktree is the
	// protective action, so a resolution failure maps onto the SAME
	// `'preserve-failed'` contract a non-zero git exit already produces —
	// never onto a success path.
	let refProc: ReturnType<typeof _internals.bunSpawn>;
	try {
		refProc = _internals.bunSpawn(
			[
				_internals.resolveGitExecutable(),
				'-C',
				dispatch.handle.worktreePath,
				'rev-parse',
				'HEAD',
			],
			{
				stdin: 'ignore',
				stdout: 'pipe',
				stderr: 'pipe',
				timeout: PRESERVE_COMMIT_TIMEOUT_MS,
			},
		);
	} catch (error) {
		return {
			outcome: 'preserve-failed',
			error: `git rev-parse could not start: ${
				error instanceof Error ? error.message : String(error)
			}`,
		};
	}
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
	// Issue #2236 (BL-1b): same containment as the `rev-parse` spawn above. A
	// warm resolver cache does NOT make this site safe — negative cache entries
	// expire on a TTL, so resolution can begin failing between two spawns in
	// one call.
	let tagProc: ReturnType<typeof _internals.bunSpawn>;
	try {
		tagProc = _internals.bunSpawn(
			[
				_internals.resolveGitExecutable(),
				'-C',
				dispatch.handle.worktreePath,
				'tag',
				tag,
				ref,
			],
			{
				stdin: 'ignore',
				stdout: 'pipe',
				stderr: 'pipe',
				timeout: PRESERVE_COMMIT_TIMEOUT_MS,
			},
		);
	} catch (error) {
		return {
			outcome: 'preserve-failed',
			error: `git tag could not start: ${
				error instanceof Error ? error.message : String(error)
			}`,
		};
	}
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
	// Issue #2236 (BL-1b): `_internals.resolveGitExecutable()` is called INSIDE
	// the guard, mirroring `runGit` in `src/worktree/core.ts`. Outside it, a
	// `GitBinaryMissingError` escaped this function instead of becoming the
	// typed `outcome` the signature promises. Preserving a worktree is the
	// protective action, so every resolution failure below maps onto the SAME
	// `'preserve-failed'` contract a non-zero git exit already produces — never
	// onto `clean` or `preserved`. Every spawn in this function is guarded, not
	// only the first: negative resolver cache entries expire on a TTL, so
	// resolution can begin failing between two spawns in one call.
	let statusProc: ReturnType<typeof _internals.bunSpawn>;
	try {
		statusProc = _internals.bunSpawn(
			[
				_internals.resolveGitExecutable(),
				'-C',
				worktreePath,
				'status',
				'--porcelain',
			],
			{
				stdin: 'ignore',
				stdout: 'pipe',
				stderr: 'pipe',
				timeout: PRESERVE_COMMIT_TIMEOUT_MS,
			},
		);
	} catch (error) {
		return {
			outcome: 'preserve-failed',
			preserved: false,
			error: `git status could not start: ${
				error instanceof Error ? error.message : String(error)
			}`,
		};
	}
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
	let addProc: ReturnType<typeof _internals.bunSpawn>;
	try {
		addProc = _internals.bunSpawn(
			[_internals.resolveGitExecutable(), '-C', worktreePath, 'add', '-A'],
			{
				stdin: 'ignore',
				stdout: 'pipe',
				stderr: 'pipe',
				timeout: PRESERVE_COMMIT_TIMEOUT_MS,
			},
		);
	} catch (error) {
		return {
			outcome: 'preserve-failed',
			preserved: false,
			error: `git add could not start: ${
				error instanceof Error ? error.message : String(error)
			}`,
		};
	}
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

	let commitProc: ReturnType<typeof _internals.bunSpawn>;
	try {
		commitProc = _internals.bunSpawn(
			[
				_internals.resolveGitExecutable(),
				'-C',
				worktreePath,
				'commit',
				'-m',
				commitMessage,
			],
			{
				stdin: 'ignore',
				stdout: 'pipe',
				stderr: 'pipe',
				timeout: PRESERVE_COMMIT_TIMEOUT_MS,
			},
		);
	} catch (error) {
		return {
			outcome: 'preserve-failed',
			preserved: false,
			error: `git commit could not start: ${
				error instanceof Error ? error.message : String(error)
			}`,
		};
	}
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
	let hashProc: ReturnType<typeof _internals.bunSpawn>;
	try {
		hashProc = _internals.bunSpawn(
			[
				_internals.resolveGitExecutable(),
				'-C',
				worktreePath,
				'rev-parse',
				'HEAD',
			],
			{
				stdin: 'ignore',
				stdout: 'pipe',
				stderr: 'pipe',
				timeout: PRESERVE_COMMIT_TIMEOUT_MS,
			},
		);
	} catch (error) {
		return {
			outcome: 'preserve-failed',
			preserved: false,
			error: `git rev-parse could not start: ${
				error instanceof Error ? error.message : String(error)
			}`,
		};
	}
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

	let tagProc: ReturnType<typeof _internals.bunSpawn>;
	try {
		tagProc = _internals.bunSpawn(
			[_internals.resolveGitExecutable(), '-C', worktreePath, 'tag', tagName],
			{
				stdin: 'ignore',
				stdout: 'pipe',
				stderr: 'pipe',
				timeout: PRESERVE_COMMIT_TIMEOUT_MS,
			},
		);
	} catch (error) {
		return {
			outcome: 'preserve-failed',
			preserved: false,
			error: `git tag could not start: ${
				error instanceof Error ? error.message : String(error)
			}`,
		};
	}
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
	// Issue #2236 (BL-1b): `_internals.resolveGitExecutable()` is called INSIDE
	// the guard, mirroring `runGit` in `src/worktree/core.ts`. Outside it, a
	// `GitBinaryMissingError` escaped this function instead of becoming the
	// typed `outcome` the signature promises. Preserving a worktree is the
	// protective action, so every resolution failure below maps onto the SAME
	// `'preserve-failed'` contract a non-zero git exit already produces — never
	// onto `clean` or `preserved`. Every spawn in this function is guarded, not
	// only the first: negative resolver cache entries expire on a TTL, so
	// resolution can begin failing between two spawns in one call.
	let statusProc: ReturnType<typeof _internals.bunSpawn>;
	try {
		statusProc = _internals.bunSpawn(
			[
				_internals.resolveGitExecutable(),
				'-C',
				worktreePath,
				'status',
				'--porcelain',
			],
			{
				stdin: 'ignore',
				stdout: 'pipe',
				stderr: 'pipe',
				timeout: PRESERVE_COMMIT_TIMEOUT_MS,
			},
		);
	} catch (error) {
		return {
			outcome: 'preserve-failed',
			preserved: false,
			error: `git status could not start: ${
				error instanceof Error ? error.message : String(error)
			}`,
		};
	}
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
	let addProc: ReturnType<typeof _internals.bunSpawn>;
	try {
		addProc = _internals.bunSpawn(
			[_internals.resolveGitExecutable(), '-C', worktreePath, 'add', '-A'],
			{
				stdin: 'ignore',
				stdout: 'pipe',
				stderr: 'pipe',
				timeout: PRESERVE_COMMIT_TIMEOUT_MS,
			},
		);
	} catch (error) {
		return {
			outcome: 'preserve-failed',
			preserved: false,
			error: `git add could not start: ${
				error instanceof Error ? error.message : String(error)
			}`,
		};
	}
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

	let commitProc: ReturnType<typeof _internals.bunSpawn>;
	try {
		commitProc = _internals.bunSpawn(
			[
				_internals.resolveGitExecutable(),
				'-C',
				worktreePath,
				'commit',
				'-m',
				commitMessage,
			],
			{
				stdin: 'ignore',
				stdout: 'pipe',
				stderr: 'pipe',
				timeout: PRESERVE_COMMIT_TIMEOUT_MS,
			},
		);
	} catch (error) {
		return {
			outcome: 'preserve-failed',
			preserved: false,
			error: `git commit could not start: ${
				error instanceof Error ? error.message : String(error)
			}`,
		};
	}
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
	let hashProc: ReturnType<typeof _internals.bunSpawn>;
	try {
		hashProc = _internals.bunSpawn(
			[
				_internals.resolveGitExecutable(),
				'-C',
				worktreePath,
				'rev-parse',
				'HEAD',
			],
			{
				stdin: 'ignore',
				stdout: 'pipe',
				stderr: 'pipe',
				timeout: PRESERVE_COMMIT_TIMEOUT_MS,
			},
		);
	} catch (error) {
		return {
			outcome: 'preserve-failed',
			preserved: false,
			error: `git rev-parse could not start: ${
				error instanceof Error ? error.message : String(error)
			}`,
		};
	}
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

	let tagProc: ReturnType<typeof _internals.bunSpawn>;
	try {
		tagProc = _internals.bunSpawn(
			[_internals.resolveGitExecutable(), '-C', worktreePath, 'tag', tagName],
			{
				stdin: 'ignore',
				stdout: 'pipe',
				stderr: 'pipe',
				timeout: PRESERVE_COMMIT_TIMEOUT_MS,
			},
		);
	} catch (error) {
		return {
			outcome: 'preserve-failed',
			preserved: false,
			error: `git tag could not start: ${
				error instanceof Error ? error.message : String(error)
			}`,
		};
	}
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
): Promise<CleanupStandardWorktreeResult> {
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
			return {
				removedWorktree: false,
				cleanedBranch: false,
				preservedRecoveryLane: false,
			};
		}
		worktreePath = awaiting.worktreePath;
		branchName = awaiting.branch;
		parentSessionID = awaiting.parentSessionID;
	}

	if (
		dispatch?.recoveryClaim &&
		(reason === 'denied' || reason === 'cancelled')
	) {
		const renewResult = _internals.renewWorktreeRecoveryClaim(directory, {
			authorityDigest: dispatch.recoveryClaim.authorityDigest,
			claimantCallID: callID,
			claimRevision: dispatch.recoveryClaim.claimRevision,
			rawToken: dispatch.recoveryClaim.rawToken,
			leaseMs: WORKTREE_RECOVERY_CLAIM_LEASE_MS,
		});
		if (!renewResult.ok) {
			const message =
				`STANDARD_WORKTREE_RECOVERY_ABORT_RELEASE_FAILED: dispatch ${callID} preserved lane ${worktreePath} (${branchName}) after ${reason}, ` +
				`but ${describeRecoveryMutationFailure({
					action: 'renew',
					code: renewResult.code,
					reason: renewResult.reason,
				})}. No tracking teardown was performed.`;
			const session = ensureAgentSession(parentSessionID);
			pushAdvisory(session, message);
			throw new Error(message);
		}
		const releaseResult = _internals.releaseWorktreeRecoveryClaim(directory, {
			authorityDigest: dispatch.recoveryClaim.authorityDigest,
			claimantCallID: callID,
			claimRevision: dispatch.recoveryClaim.claimRevision,
			rawToken: dispatch.recoveryClaim.rawToken,
		});
		if (!releaseResult.ok) {
			const message =
				`STANDARD_WORKTREE_RECOVERY_ABORT_RELEASE_FAILED: dispatch ${callID} preserved lane ${worktreePath} (${branchName}) after ${reason}, ` +
				`but ${describeRecoveryMutationFailure({
					action: 'release',
					code: releaseResult.code,
					reason: releaseResult.reason,
				})}. No tracking teardown was performed.`;
			const session = ensureAgentSession(parentSessionID);
			pushAdvisory(session, message);
			throw new Error(message);
		}
		standardWorktreeByCallID.delete(callID);
		awaitingMergeByCallID.delete(callID);
		const session = ensureAgentSession(parentSessionID);
		pushAdvisory(
			session,
			`STANDARD_WORKTREE_RECOVERY_ABORT_PRESERVED: dispatch ${callID} released its recovery claim and preserved lane ${worktreePath} (${branchName}) after ${reason}.`,
		);
		return {
			removedWorktree: false,
			cleanedBranch: false,
			preservedRecoveryLane: true,
		};
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
		return {
			removedWorktree: false,
			cleanedBranch: false,
			preservedRecoveryLane: false,
		};
	}

	// Remove the worktree directory.
	let removedWorktree = false;
	try {
		// Issue #2599 AC5: release this process's handle on the lane DB
		// before deletion (Windows WAL lock ⇒ EBUSY), covering the residual
		// fs.rm fallback below as well.
		closeProjectDb(worktreePath);
		const result = await _internals.removeWorktree(worktreePath, directory, {
			force: true,
			worktreeDir: worktree_dir,
		});
		if (!('error' in result)) {
			removedWorktree = true;
		} else if (
			result.error.includes('is not a working tree') &&
			(await pathExists(worktreePath)) &&
			isPathUnderSwarmWorktreeBase(
				worktreePath,
				directory,
				worktree_dir ? [worktree_dir] : [],
			)
		) {
			try {
				await fs.rm(worktreePath, { recursive: true, force: true });
				removedWorktree = !(await pathExists(worktreePath));
			} catch (err) {
				logger.log(
					`[swarm] cleanupStandardWorktreeForCallId: residual directory cleanup failed for ${callID}: ${err}`,
				);
			}
		}
	} catch (err) {
		logger.log(
			`[swarm] cleanupStandardWorktreeForCallId: removeWorktree failed for ${callID}: ${err}`,
		);
	}

	// BRANCH DELETION: unconditionally on every dispatch outcome.
	// The branch is deleted on success (merge-back completed cleanly), denied
	// (orchestrator denied the dispatch), and cancelled (user/system cancelled).
	// Branch deletion is safe in all cases — the user's work is preserved in
	// the commit history via the lane branch reflog until GC.
	let cleanedBranch = false;
	try {
		const result = await _internals.postMergeCleanup(directory, branchName);
		cleanedBranch = !('error' in result);
	} catch (err) {
		logger.log(
			`[swarm] cleanupStandardWorktreeForCallId: postMergeCleanup failed for ${callID}: ${err}`,
		);
	}

	// Remove entries from in-memory tracking maps.
	standardWorktreeByCallID.delete(callID);
	awaitingMergeByCallID.delete(callID);

	const session = ensureAgentSession(parentSessionID);
	pushAdvisory(
		session,
		`STANDARD_WORKTREE_CLEANUP: dispatch ${callID} cleaned up (reason: ${reason}); worktree=${worktreePath}; branch=${branchName}.`,
	);
	return {
		removedWorktree,
		cleanedBranch,
		preservedRecoveryLane: false,
	};
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
		const statusKey = dispatch.planTaskId ?? dispatch.taskId;
		const failRecoverySettlement = (
			stage:
				| 'recovery-claim-renew'
				| 'recovery-claim-release'
				| 'recovery-claim-finalize'
				| 'recovery-authority-publish',
			message: string,
			provenance?: MergeOperationProvenance,
		): StandardWorktreeFailedSettlement => {
			recordWorktreeMergeFailure(statusKey, {
				outcome: 'failed',
				stage,
				message,
				worktreePath: dispatch.handle.worktreePath,
				branch: dispatch.handle.branchName,
				completedAt: Date.now(),
			});
			const session = ensureAgentSession(dispatch.parentSessionID);
			pushAdvisory(
				session,
				`STANDARD_WORKTREE_RECOVERY_MUTATION_FAILED: task ${dispatch.taskId} preserved at ${dispatch.handle.worktreePath}; ${message}.`,
			);
			return {
				outcome: 'failed',
				stage,
				message,
				provenance,
			};
		};
		const renewRecoveryClaimLease = (
			phase: 'before merge-back' | 'before cleanup/finalization',
			provenance?: MergeOperationProvenance,
		): StandardWorktreeFailedSettlement | undefined => {
			if (!dispatch.recoveryClaim) return undefined;
			const renewed = _internals.renewWorktreeRecoveryClaim(directory, {
				authorityDigest: dispatch.recoveryClaim.authorityDigest,
				claimantCallID: resolvedCallID,
				claimRevision: dispatch.recoveryClaim.claimRevision,
				rawToken: dispatch.recoveryClaim.rawToken,
				leaseMs: WORKTREE_RECOVERY_CLAIM_LEASE_MS,
			});
			if (renewed.ok) return undefined;
			return failRecoverySettlement(
				'recovery-claim-renew',
				`The live recovery lane could not extend its lease ${phase}; ${describeRecoveryMutationFailure(
					{
						action: 'renew',
						code: renewed.code,
						reason: renewed.reason,
					},
				)}`,
				provenance,
			);
		};
		const releaseRecoveryClaim = (
			provenance?: MergeOperationProvenance,
		): StandardWorktreeFailedSettlement | undefined => {
			if (!dispatch.recoveryClaim) return undefined;
			const released = _internals.releaseWorktreeRecoveryClaim(directory, {
				authorityDigest: dispatch.recoveryClaim.authorityDigest,
				claimantCallID: resolvedCallID,
				claimRevision: dispatch.recoveryClaim.claimRevision,
				rawToken: dispatch.recoveryClaim.rawToken,
			});
			if (released.ok) return undefined;
			return failRecoverySettlement(
				'recovery-claim-release',
				`The preserved recovery lane could not release its exact claim after settlement; ${describeRecoveryMutationFailure(
					{
						action: 'release',
						code: released.code,
						reason: released.reason,
					},
				)}`,
				provenance,
			);
		};
		const publishRecoveryAuthority = async (
			provenance: MergeOperationProvenance | undefined,
			conflictFiles?: string[],
		): Promise<StandardWorktreeFailedSettlement | undefined> => {
			const published = await publishRecoveryAuthorityForSettlement({
				directory,
				dispatch,
				taskId: statusKey,
				provenance,
				conflictFiles,
			});
			if (published.ok) return undefined;
			return failRecoverySettlement(
				'recovery-authority-publish',
				`The preserved original lane could not publish recoverable authority; ${describeRecoveryMutationFailure(
					{
						action: 'publish',
						code: published.code,
						reason: published.reason,
					},
				)}`,
				provenance,
			);
		};
		const preMergeRenewFailure = renewRecoveryClaimLease('before merge-back');
		if (preMergeRenewFailure) {
			return preMergeRenewFailure;
		}
		const mergeResult = await (async () => {
			if (!dispatch.recoveryClaim) {
				return _internals.attemptMergeBackFromDirty(
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
			}
			const coordinates = dispatch.recoveryClaim.coordinates;
			if (!coordinates) {
				return {
					failed: true as const,
					stage: 'recovery-coordinates',
					message: 'Claimed recovery lane is missing immutable Git coordinates',
				};
			}
			const provenance: MergeOperationProvenance = {
				operationId:
					settlement.operationId ??
					`recovery:${dispatch.recoveryClaim.authorityDigest}`,
				sourceHead: coordinates.sourceHeadOid,
				targetHeadBefore: coordinates.targetHeadOid,
				branchName: dispatch.handle.branchName,
				strategy: coordinates.strategy,
			};
			if (settlement.onBeforeMerge) {
				await settlement.onBeforeMerge(provenance);
			}
			const recovered =
				await _internals.recoverMergeBackFromImmutableCoordinates(
					directory,
					coordinates,
				);
			if ('merged' in recovered && recovered.merged) {
				if (recovered.sourceCommitOrder && recovered.rewrittenCommitOrder) {
					dispatch.recoveryClaim.settlement = {
						sourceCommitOrder: recovered.sourceCommitOrder,
						rewrittenCommitOrder: recovered.rewrittenCommitOrder,
					};
				}
				return {
					merged: true as const,
					strategy: recovered.strategy,
					autoCommitted: false,
					cleaned: true,
					reconciled: false,
					provenance,
				};
			}
			if ('conflict' in recovered && recovered.conflict) {
				return {
					partial: true as const,
					stage: 'conflict',
					autoCommitted: false,
					cleaned: true,
					message: recovered.message,
					conflictFiles: recovered.files,
					provenance,
				};
			}
			return {
				failed: true as const,
				stage: 'recovery',
				message:
					'error' in recovered
						? recovered.error
						: 'Immutable recovery returned an unexpected result',
				provenance,
			};
		})();
		if ('merged' in mergeResult && mergeResult.merged) {
			const mergedSettlement: StandardWorktreeMergedSettlement = {
				outcome: 'merged',
				strategy: mergeResult.strategy,
				autoCommitted: mergeResult.autoCommitted ?? false,
				cleaned: mergeResult.cleaned ?? false,
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
					const publishFailure = await publishRecoveryAuthority(
						mergeResult.provenance,
					);
					if (publishFailure) {
						failedSettlement.message = `${failedSettlement.message} ${publishFailure.message}`;
					}
					const releaseFailure = releaseRecoveryClaim(mergeResult.provenance);
					if (releaseFailure) {
						failedSettlement.message = `${failedSettlement.message} ${releaseFailure.message}`;
					}
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
			const preCleanupRenewFailure = renewRecoveryClaimLease(
				'before cleanup/finalization',
				mergeResult.provenance,
			);
			if (preCleanupRenewFailure) {
				return preCleanupRenewFailure;
			}

			// Clean merge supersedes any earlier failure for this task so a
			// successful re-dispatch re-enables Rule 2's marker commit.
			const cleanupResult = await cleanupStandardWorktreeForCallId(
				resolvedCallID,
				'success',
				directory,
				dispatch.worktree_dir,
			);
			if (dispatch.recoveryClaim) {
				const request = {
					authorityDigest: dispatch.recoveryClaim.authorityDigest,
					claimantCallID: resolvedCallID,
					claimRevision: dispatch.recoveryClaim.claimRevision,
					rawToken: dispatch.recoveryClaim.rawToken,
					settlement: dispatch.recoveryClaim.settlement,
				};
				if (cleanupResult.removedWorktree && cleanupResult.cleanedBranch) {
					const finalized = _internals.finalizeWorktreeRecoveryAuthority(
						directory,
						request,
					);
					if (!finalized.ok) {
						return failRecoverySettlement(
							'recovery-claim-finalize',
							`The merged recovery lane was cleaned up but could not finalize its exact claim; ${describeRecoveryMutationFailure(
								{
									action: 'finalize',
									code: finalized.code,
									reason: finalized.reason,
								},
							)}`,
							mergeResult.provenance,
						);
					}
				} else {
					const releaseFailure = releaseRecoveryClaim(mergeResult.provenance);
					if (releaseFailure) {
						return releaseFailure;
					}
				}
			}
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

			// Issue #2100: verify the primary checkout now matches the lane's
			// reviewer manifest before lane teardown — this is what publishes the
			// generation as reviewable from the primary root. Reads from the
			// primary directory only; best-effort and never breaks settlement.
			try {
				verifyReviewerScopeGenerationMergeBack({
					parentSessionID: dispatch.parentSessionID,
					taskId: statusKey,
					coderCallID: resolvedCallID,
					primaryDirectory: directory,
				});
			} catch {
				// Best-effort; a verification failure retains the generation.
			}

			return mergedSettlement;
		}
		if ('partial' in mergeResult) {
			const publishFailure = await publishRecoveryAuthority(
				mergeResult.provenance,
				mergeResult.conflictFiles,
			);
			if (publishFailure) {
				return publishFailure;
			}
			const releaseFailure = releaseRecoveryClaim(mergeResult.provenance);
			if (releaseFailure) {
				return releaseFailure;
			}
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
			// Issue #2100: the reviewer generation stays mergeback_pending — a
			// conflict is a typed recoverable state, never reviewer-stale.
			try {
				markReviewerScopeGenerationMergebackPending({
					parentSessionID: dispatch.parentSessionID,
					taskId: statusKey,
					coderCallID: resolvedCallID,
				});
			} catch {
				// Best-effort; generation retention is advisory here.
			}

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
			const publishFailure = await publishRecoveryAuthority(
				mergeResult.provenance,
			);
			if (publishFailure) {
				return publishFailure;
			}
			const releaseFailure = releaseRecoveryClaim(mergeResult.provenance);
			if (releaseFailure) {
				return releaseFailure;
			}
			recordWorktreeMergeFailure(statusKey, {
				outcome: 'failed',
				stage: mergeResult.stage,
				message: mergeResult.message,
				worktreePath: dispatch.handle.worktreePath,
				branch: dispatch.handle.branchName,
				completedAt: Date.now(),
			});
			const session = ensureAgentSession(dispatch.parentSessionID);
			// #2236: for the two "source worktree is gone" stages there is nothing
			// preserved at that path — the directory is exactly what disappeared.
			// Saying "preserved at <gone path>" would send the reader looking for
			// a worktree that does not exist, which is the same class of
			// misleading message this change removes.
			const location =
				mergeResult.stage === SOURCE_WORKTREE_GONE_STAGE ||
				mergeResult.stage === SOURCE_WORKTREE_UNCERTAIN_STAGE
					? `lane worktree ${dispatch.handle.worktreePath} no longer exists`
					: `preserved at ${dispatch.handle.worktreePath}`;
			pushAdvisory(
				session,
				`STANDARD_WORKTREE_MERGE_FAILED: task ${dispatch.taskId} ${location}; stage: ${mergeResult.stage}; ${mergeResult.message}.`,
			);

			// F-C004: retain failed merge lanes for recovery. In particular, a
			// cleanup-stage failure can leave dirty or untracked work that has not
			// been safely committed yet.
			// Issue #2100: the reviewer generation stays mergeback_pending — a
			// failed merge is a typed recoverable state, never reviewer-stale.
			try {
				markReviewerScopeGenerationMergebackPending({
					parentSessionID: dispatch.parentSessionID,
					taskId: statusKey,
					coderCallID: resolvedCallID,
				});
			} catch {
				// Best-effort; generation retention is advisory here.
			}
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
	let result: StandardWorktreeSettlementResult;
	try {
		result = await queuedRun;
	} catch (error) {
		// A dependency failure must not strand either the in-memory awaiting
		// registry or a durable recovery claim. Preserve the lane for a later
		// retry, release only this exact claim, and return a typed settlement
		// failure to the completion observer instead of rejecting into a log-only
		// path.
		standardWorktreeByCallID.delete(resolvedCallID);
		awaitingMergeByCallID.delete(resolvedCallID);
		if (dispatch.recoveryClaim) {
			try {
				_internals.releaseWorktreeRecoveryClaim(directory, {
					authorityDigest: dispatch.recoveryClaim.authorityDigest,
					claimantCallID: resolvedCallID,
					claimRevision: dispatch.recoveryClaim.claimRevision,
					rawToken: dispatch.recoveryClaim.rawToken,
				});
			} catch {
				// Startup replay remains the durable backstop when release itself fails.
			}
		}
		const message = `Unexpected worktree settlement failure: ${error instanceof Error ? error.message : String(error)}`;
		recordWorktreeMergeFailure(dispatch.planTaskId ?? dispatch.taskId, {
			outcome: 'failed',
			stage: 'merge',
			message,
			worktreePath: dispatch.handle.worktreePath,
			branch: dispatch.handle.branchName,
			completedAt: Date.now(),
		});
		const session = ensureAgentSession(dispatch.parentSessionID);
		pushAdvisory(
			session,
			`STANDARD_WORKTREE_SETTLEMENT_FAILED: task ${dispatch.taskId} preserved at ${dispatch.handle.worktreePath}; ${message}.`,
		);
		return {
			outcome: 'failed',
			stage: 'merge',
			message,
		};
	}

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
 * - Drops `GIT_*` / `LD_*` / `DYLD_*` keys via `isUntrustedEnvKey` (#2263):
 *   the file is repo-resident, so its contents are attacker-controlled. The
 *   `GIT_*` family is git's control plane (`GIT_SSH_COMMAND`,
 *   `GIT_CONFIG_*`, …) and `LD_*`/`DYLD_*` are loader-hijack vectors — none
 *   belong in a lane profile (PORT / TMPDIR / cache redirects).
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
		if (isUntrustedEnvKey(k)) continue; // #2263: reject GIT_*/LD_*/DYLD_* control-plane keys
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
	recoverMergeBackFromImmutableCoordinates,
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
	lookupWorktreeRecoveryAuthoritiesByTask,
	claimWorktreeRecoveryAuthority,
	renewWorktreeRecoveryClaim,
	releaseWorktreeRecoveryClaim,
	finalizeWorktreeRecoveryAuthority,
	publishWorktreeRecoveryAuthority,
	replayWorktreeRecoveryClaimJournal,
	buildWorktreeRecoveryPublishIdentity,
	/** FR-001b SC-004: path-based dirty worktree preservation for stale-lane fallback. */
	preserveDirtyWorktreeAtPath,
	/** Bounded lane session.create timeout (tests may override). */
	worktreeSessionCreateTimeoutMs: WORKTREE_SESSION_CREATE_TIMEOUT_MS,
	/**
	 * Issue #2599 AC4: bound on how long the deadline path waits for the
	 * create promise to settle before proceeding to lane cleanup. Tests
	 * override this to keep never-settling-create cases fast.
	 */
	worktreeSessionCreateSettleGraceMs: WORKTREE_SESSION_CREATE_SETTLE_GRACE_MS,
	/**
	 * Issue #2599: the settle-state-machine budget wrapper, exposed so tests
	 * can drive both late-settle interleavings directly with controlled
	 * promises (no racy shared flag is involved).
	 */
	createSessionWithinBudget,
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
	/**
	 * Issue #2236 hardening (F1/F4/F5) — resolves the absolute git executable
	 * path instead of spawning the bare `'git'` name. Exposed for test
	 * injection following the `src/worktree/core.ts` convention.
	 */
	resolveGitExecutable,
};
