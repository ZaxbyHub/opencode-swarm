/**
 * Settling loop for autonomous PR babysitting (issue #2502; #1678 capstone).
 *
 * Composes the three existing legs — the pr_monitor event queue, the PR_FEEDBACK
 * workflow gate, and critic_oversight — into an OPT-IN (triple-gated) pipeline:
 *
 *   claim → classify → authorize (foreign/stale/replay/budgets/circuit)
 *         → oversight (fail-closed) → act (claim-first, exactly one wake)
 *         → settle (typed terminal, idempotent, restorable)
 *
 * TRIPLE OPT-IN (never a default flip): the loop runs only when
 * `pr_monitor.enabled` AND `pr_monitor.auto_pr_feedback` AND
 * `pr_feedback_loop.enabled` are all true.
 *
 * NO-PUBLICATION PROFILE: the only supported `publication` mode today is
 * `'none'` — the loop never arms publication and never pushes; the gate's own
 * armed-publication path remains the only route to a push.
 *
 * Terminal semantics: `completed` is DEFINED as "authorized feedback action
 * performed and recorded; downstream delivery/publication outcomes remain
 * owned by the PR workflow"
 * (the terminal reason string always states that scope); ladder/workflow
 * outcomes remain the PR workflow gate's business. `paused_for_human` covers budget exhaustion,
 * oversight denial, permanent performer failure, and ambiguous events.
 * `degraded` is the open circuit. `cancelled` is the operator stop.
 *
 * Provenance binding: each settled action records a sha256 digest over the
 * NUL-delimited `type\0repo\0pr\0head\0actionClass` (queueCacheKey precedent);
 * a replayed event is refused, and a foreign event (no matching subscription
 * correlation) or a stale head (event head ≠ freshly evaluated head) can never
 * authorize an action. Base-identity binding (baseRefOid) is deferred — the
 * poll snapshot does not capture base today (plan §OUT OF SCOPE).
 */
import { createHash, randomUUID } from 'node:crypto';
import type { BigIntStats } from 'node:fs';
import * as fsSync from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { z } from 'zod';
import { loadPluginConfig } from '../config/loader';
import {
	activatePrWorkflow,
	ensurePrWorkflowSafeParentDirectory,
	writePrWorkflowAtomicJson,
} from '../hooks/pr-workflow-gate';
import { validateSwarmPath } from '../hooks/utils';
import {
	canonicalRootKeyFresh,
	SESSION_KEY_SEPARATOR,
} from '../utils/canonical-root.js';
import { log, warn } from '../utils/logger';
import { withTimeout } from '../utils/timeout';
import {
	claimPrFeedbackMonitorEvents,
	clearPrFeedbackMonitorEvents,
	enqueuePrFeedbackMonitorEvent,
	type PrFeedbackMonitorEvent,
	readPrFeedbackMonitorQueue,
	releasePrFeedbackMonitorEventClaim,
} from './pr-feedback-event-queue';
import {
	dispatchPrFeedbackOversight,
	evaluatePrFeedbackCurrentHead,
	isPrFeedbackLoopEnabled,
} from './pr-feedback-loop-runtime.js';
import { listActive } from './pr-subscriptions';

export const PR_FEEDBACK_LOOP_STATE_REL = path.join(
	'.swarm',
	'pr-feedback-loop-state.json',
);
const PR_FEEDBACK_CLEANUP_DIR = 'pr-feedback-loop-cleanups';
const PR_FEEDBACK_EVIDENCE_DIR = path.join('.swarm', 'pr-feedback-evidence');
const PR_FEEDBACK_LOOP_STATE_LOCK_FILENAME = 'pr-feedback-loop-state.lock';
const PR_FEEDBACK_LOOP_STATE_LOCK_REL = path.join(
	'.swarm',
	PR_FEEDBACK_LOOP_STATE_LOCK_FILENAME,
);
const MAX_TRACKED_SESSIONS = 200;
const MAX_PROCESSED_DIGESTS = 64;
export const MAX_IN_FLIGHT_SESSIONS = 64;
export const MAX_CANCELLATION_REQUESTS = 64;
const MAX_PERFORM_ATTEMPTS = 3; // 1 initial + 2 bounded retries (transient only)
const SETTLE_TIMEOUT_MS = 10_000;
const LOOP_STATE_LOCK_MAX_ATTEMPTS = 50;
const LOOP_STATE_LOCK_RETRY_DELAY_MS = 10;
const LOOP_STATE_LOCK_UNINITIALIZED_STALE_MS = 30_000;

/** Supported monitor event types → feedback action classes (#2502 AC1). */
const SUPPORTED_EVENT_ACTION: Record<string, string> = {
	'pr.ci.failed': 'fix_ci',
	'pr.merge.conflict': 'resolve_conflict',
	'pr.new.comment': 'address_comment',
};

const TRANSIENT_MARKERS =
	/HTTP 5\d\d|HTTP 429|ETIMEDOUT|timeout|temporarily unavailable|ECONNRESET|ECONNREFUSED/i;

export interface PrFeedbackLoopClassification {
	type: string;
	actionClass: string;
	supported: boolean;
	ambiguous: boolean;
	reason: string;
}

export interface PrFeedbackLoopAuthorization {
	authorized: boolean;
	reason: string;
	stale: boolean;
	foreign: boolean;
	replay: boolean;
	oversight?: { dispatched: boolean; verdict?: string; decision?: string };
	budget?: {
		sessionActionsUsed: number;
		sessionActionsMax: number;
		prActionsUsed: number;
		prActionsMax: number;
		exhausted: boolean;
	};
}

export interface PrFeedbackLoopAction {
	kind: string;
	performed: boolean;
	recordPath?: string;
}

export interface PrFeedbackLoopTerminal {
	state:
		| 'completed'
		| 'paused_for_human'
		| 'cancelled'
		| 'degraded'
		| 'refused';
	reason: string;
	receiptPath?: string;
}

export interface PrFeedbackLoopResult {
	ran: boolean;
	reason?: string;
	dedupToken: string | null;
	event: {
		type: string;
		repoFullName: string;
		prNumber: number;
		prUrl: string;
	} | null;
	classification: PrFeedbackLoopClassification | null;
	authorization: PrFeedbackLoopAuthorization | null;
	action: PrFeedbackLoopAction | null;
	terminal: PrFeedbackLoopTerminal | null;
}

/**
 * Durable cancellation state exposed to the PR-event intake boundary.
 *
 * A read failure is deliberately distinct from "not cancelled": callers that
 * can create new queue work must fail closed when the stop barrier cannot be
 * read reliably.
 */
export interface PrFeedbackLoopCancellationStatus {
	cancelled: boolean;
	unavailable: boolean;
	reason?: string;
}

interface CircuitState {
	failures: number;
	openUntil: number;
	halfOpenProbes: number;
	halfOpenProbeStartedAt?: number;
	halfOpenProbeOwnerToken?: string;
	halfOpenProbeOwnerPid?: number;
}

interface InFlightClaim {
	dedupToken: string;
	workflowInstanceId: string;
	ownerPid: number;
	actionClass: string;
	head: string | null;
	performed: boolean;
	attempts: number;
	claimedAt: string;
	actionStartedAt?: number;
}

interface CorrelationState {
	/** Monotonic per-correlation CAS fence; legacy records normalize to zero. */
	revision: number;
	sessionID: string;
	repoFullName: string;
	prNumber: number;
	prActionsUsed: number;
	processedDigests: string[];
	circuit: CircuitState;
	inFlight: InFlightClaim | null;
	terminal: PrFeedbackLoopTerminal | null;
}

interface LoopStateV1 {
	schemaVersion: 1;
	updatedAt: string;
	/** Durable sequence for oversight evidence files (no collision across restarts). */
	oversightSeq: number;
	correlations: Record<string, CorrelationState>;
	/** Session-level terminal records (operator cancellation lands here even
	 * when the session has no prior settlement correlation). */
	sessionTerminals: Record<string, PrFeedbackLoopTerminal>;
}

interface LoopStateLockRecord {
	ownerToken: string;
	pid: number;
	createdAtMs: number;
}

interface LoopStateLockHandle {
	path: string;
	ownerToken: string;
}

const LoopStateSchema = z.object({
	schemaVersion: z.literal(1),
	updatedAt: z.string().min(1),
	oversightSeq: z.number().int().nonnegative(),
	correlations: z.record(z.string(), z.any()),
	sessionTerminals: z.record(z.string(), z.any()).default({}),
});

// ── DI seam (tests/checks inject; restore in afterEach) ──────────────────

export type EvaluateCurrentHead = (
	directory: string,
	repoFullName: string,
	prNumber: number,
) => Promise<string | null>;

export type DispatchOversightInput = {
	directory: string;
	sessionID: string;
	eventType: string;
	actionClass: string;
	repoFullName: string;
	prNumber: number;
	head: string | null;
};

export type DispatchOversightOutcome = {
	dispatched: boolean;
	verdict?: string;
	decision?: string;
};

export type PerformAuthorizedActionInput = {
	directory: string;
	sessionID: string;
	event: PrFeedbackMonitorEvent;
	actionClass: string;
	publication: 'none';
};

export type PerformAuthorizedActionOutcome = {
	performed: boolean;
	recordPath?: string;
	transient?: boolean;
	permanent?: boolean;
	error?: string;
};

export const _internals: {
	evaluateCurrentHead: EvaluateCurrentHead;
	dispatchOversight: (
		input: DispatchOversightInput,
	) => Promise<DispatchOversightOutcome>;
	performAuthorizedAction: (
		input: PerformAuthorizedActionInput,
	) => Promise<PerformAuthorizedActionOutcome>;
	now: () => number;
	readState: (directory: string) => Promise<LoopStateV1 | { corrupt: true }>;
	writeState: (directory: string, state: LoopStateV1) => Promise<void>;
	listActive: typeof listActive;
	isProcessAlive: (pid: number) => boolean;
	beforeLoopStateLockWrite?: () => Promise<void>;
	resetLoopStateLock: () => void;
	loopStateLockRelativePath: () => string;
} = {
	/** Default: fresh head via the authenticated gh poll snapshot. */
	async evaluateCurrentHead(directory, repoFullName, prNumber) {
		// The adapter binds polling to the registered canonical root. With no
		// registration it returns null, preserving the ambiguous/fail-closed path.
		return evaluatePrFeedbackCurrentHead(directory, repoFullName, prNumber);
	},
	/**
	 * Default oversight dispatch (#2502 B2): the loop's OWN critic_oversight
	 * child-session gate — never mutates full-auto state; evidence under
	 * .swarm/pr-feedback-evidence/{seq}-{uuid}.json from the durable counter in
	 * the loop state file. Fail-closed: an infrastructure failure returns
	 * dispatched:false (the loop pauses, never acts).
	 */
	async dispatchOversight(input) {
		// The adapter owns the host client/critic dispatch and returns an explicit
		// unavailable outcome when this root has no registered runtime.
		return dispatchPrFeedbackOversight(input);
	},
	/**
	 * Default authorized action (#2502 B1): claim-first is already done by the
	 * pipeline; activate the canonical PR_FEEDBACK gate. Prompt/advisory delivery
	 * is owned by the registered host delivery boundary and is not inferred by
	 * this loop.
	 */
	async performAuthorizedAction(input) {
		try {
			await activatePrWorkflow(
				input.directory,
				input.sessionID,
				'PR_FEEDBACK',
				{
					requireCheckoutPreflight: true,
					prUrl: input.event.prUrl,
				},
			);
			return {
				performed: true,
				recordPath: path.join('.swarm', 'pr-feedback-loop-state.json'),
			};
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			return {
				performed: false,
				transient: TRANSIENT_MARKERS.test(message),
				permanent: !TRANSIENT_MARKERS.test(message),
				error: message,
			};
		}
	},
	now: () => Date.now(),
	async readState(directory) {
		return readLoopState(directory);
	},
	async writeState(directory, state) {
		await writeLoopState(directory, state);
	},
	listActive,
	isProcessAlive,
	resetLoopStateLock() {
		_internals.beforeLoopStateLockWrite = undefined;
	},
	loopStateLockRelativePath: () => PR_FEEDBACK_LOOP_STATE_LOCK_REL,
};

const defaultLoopInternals = { ..._internals };

/** Restore the production dependency bindings after a DI-seam test. */
export function resetLoopInternalsForTests(): void {
	Object.assign(_internals, defaultLoopInternals);
}

// ── State I/O ────────────────────────────────────────────────────────────

function emptyState(): LoopStateV1 {
	return {
		schemaVersion: 1,
		updatedAt: new Date(0).toISOString(),
		oversightSeq: 0,
		correlations: {},
		sessionTerminals: {},
	};
}

function isCorruptState(
	value: LoopStateV1 | { corrupt: true },
): value is { corrupt: true } {
	return (value as { corrupt?: boolean }).corrupt === true;
}

function normalizeRevision(value: unknown): number {
	return typeof value === 'number' && Number.isInteger(value) && value >= 0
		? value
		: 0;
}

function normalizePositivePid(value: unknown): number {
	return typeof value === 'number' && Number.isInteger(value) && value > 0
		? value
		: 0;
}

function normalizeOptionalToken(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim().length > 0
		? value.trim()
		: undefined;
}

function normalizeInFlight(value: unknown): InFlightClaim | null {
	if (!value || typeof value !== 'object') return null;
	const source = value as Partial<InFlightClaim>;
	const workflowInstanceId = normalizeOptionalToken(source.workflowInstanceId);
	return {
		dedupToken: typeof source.dedupToken === 'string' ? source.dedupToken : '',
		workflowInstanceId: workflowInstanceId ?? '',
		ownerPid: normalizePositivePid(source.ownerPid),
		actionClass:
			typeof source.actionClass === 'string' ? source.actionClass : '',
		head: typeof source.head === 'string' ? source.head : null,
		performed: source.performed === true,
		attempts: normalizeRevision(source.attempts),
		claimedAt: typeof source.claimedAt === 'string' ? source.claimedAt : '',
		actionStartedAt:
			typeof source.actionStartedAt === 'number' &&
			Number.isFinite(source.actionStartedAt)
				? source.actionStartedAt
				: undefined,
	};
}

function normalizeCorrelation(value: unknown): CorrelationState {
	const source =
		value && typeof value === 'object'
			? (value as Partial<CorrelationState>)
			: {};
	const sourceCircuit =
		source.circuit && typeof source.circuit === 'object'
			? (source.circuit as Partial<CircuitState>)
			: {};
	return {
		revision: normalizeRevision(source.revision),
		sessionID: typeof source.sessionID === 'string' ? source.sessionID : '',
		repoFullName:
			typeof source.repoFullName === 'string' ? source.repoFullName : '',
		prNumber:
			typeof source.prNumber === 'number' && Number.isInteger(source.prNumber)
				? source.prNumber
				: 0,
		prActionsUsed: normalizeRevision(source.prActionsUsed),
		processedDigests: Array.isArray(source.processedDigests)
			? source.processedDigests.filter(
					(digest): digest is string => typeof digest === 'string',
				)
			: [],
		circuit: {
			failures: normalizeRevision(sourceCircuit.failures),
			openUntil:
				typeof sourceCircuit.openUntil === 'number' &&
				Number.isFinite(sourceCircuit.openUntil)
					? sourceCircuit.openUntil
					: 0,
			halfOpenProbes: normalizeRevision(sourceCircuit.halfOpenProbes),
			halfOpenProbeStartedAt:
				typeof sourceCircuit.halfOpenProbeStartedAt === 'number' &&
				Number.isFinite(sourceCircuit.halfOpenProbeStartedAt)
					? sourceCircuit.halfOpenProbeStartedAt
					: undefined,
			halfOpenProbeOwnerToken: normalizeOptionalToken(
				sourceCircuit.halfOpenProbeOwnerToken,
			),
			halfOpenProbeOwnerPid:
				normalizePositivePid(sourceCircuit.halfOpenProbeOwnerPid) || undefined,
		},
		inFlight: normalizeInFlight(source.inFlight),
		terminal: source.terminal ?? null,
	};
}

function normalizeLoopState(state: LoopStateV1): LoopStateV1 {
	state.correlations ??= {};
	for (const [key, value] of Object.entries(state.correlations)) {
		state.correlations[key] = normalizeCorrelation(value);
	}
	state.sessionTerminals ??= {};
	return state;
}

function bumpCorrelationRevision(correlation: CorrelationState): void {
	correlation.revision = normalizeRevision(correlation.revision) + 1;
}

function recordProcessedDigest(
	correlation: CorrelationState,
	digest: string,
): void {
	if (correlation.processedDigests.includes(digest)) return;
	correlation.processedDigests.push(digest);
	if (correlation.processedDigests.length > MAX_PROCESSED_DIGESTS) {
		correlation.processedDigests.splice(
			0,
			correlation.processedDigests.length - MAX_PROCESSED_DIGESTS,
		);
	}
}

function hasReservationIdentity(
	reservation: InFlightClaim | null | undefined,
): reservation is InFlightClaim {
	return Boolean(
		reservation?.workflowInstanceId.trim() &&
			Number.isInteger(reservation?.ownerPid) &&
			(reservation?.ownerPid ?? 0) > 0,
	);
}

function ownsReservation(
	reservation: InFlightClaim | null | undefined,
	workflowInstanceId: string,
	ownerPid: number,
): boolean {
	return Boolean(
		hasReservationIdentity(reservation) &&
			reservation.workflowInstanceId === workflowInstanceId &&
			reservation.ownerPid === ownerPid,
	);
}

function ownsExactReservation(
	reservation: InFlightClaim | null | undefined,
	dedupToken: string,
	workflowInstanceId: string,
	ownerPid: number,
): reservation is InFlightClaim {
	return Boolean(
		ownsReservation(reservation, workflowInstanceId, ownerPid) &&
			reservation?.dedupToken === dedupToken,
	);
}

function reservationIsLive(
	reservation: InFlightClaim | null | undefined,
): boolean {
	if (!reservation) return false;
	// Legacy/malformed reservations have no recoverable owner. Treat them as
	// busy forever rather than guessing from age and risking a duplicate action.
	if (!hasReservationIdentity(reservation)) return true;
	// Once the pre-performer marker is durable, a crashed process may have
	// already caused an external effect. Keep that reservation counted and busy
	// even when its PID is gone; only a reservation that never crossed this
	// marker may be recovered from a dead owner.
	if (
		typeof reservation.actionStartedAt === 'number' &&
		Number.isFinite(reservation.actionStartedAt)
	)
		return true;
	return _internals.isProcessAlive(reservation.ownerPid);
}

function clearHalfOpenProbeMarker(circuit: CircuitState): void {
	circuit.halfOpenProbes = 0;
	delete circuit.halfOpenProbeStartedAt;
	delete circuit.halfOpenProbeOwnerToken;
	delete circuit.halfOpenProbeOwnerPid;
}

async function readLoopState(
	directory: string,
): Promise<LoopStateV1 | { corrupt: true }> {
	const file = path.join(directory, PR_FEEDBACK_LOOP_STATE_REL);
	try {
		const raw = fsSync.readFileSync(file, 'utf-8');
		const parsed = LoopStateSchema.safeParse(JSON.parse(raw));
		if (!parsed.success) {
			return { corrupt: true };
		}
		const data = parsed.data as LoopStateV1;
		return normalizeLoopState(data);
	} catch (err) {
		// ENOENT = no loop has ever run here → legitimately empty. Any other read
		// error or unparseable content is CORRUPTION of the idempotency basis:
		// proceeding stateless would silently discard processed digests and let a
		// replayed event re-perform. Fail closed (corrupt flag) instead.
		const code = (err as NodeJS.ErrnoException | null)?.code;
		if (code === 'ENOENT') return emptyState();
		return { corrupt: true };
	}
}

async function writeLoopState(
	directory: string,
	state: LoopStateV1,
): Promise<void> {
	normalizeLoopState(state);
	// Bounded sessions: FIFO eviction past MAX_TRACKED_SESSIONS (invariant 8).
	const keys = Object.keys(state.correlations);
	if (keys.length > MAX_TRACKED_SESSIONS) {
		for (const key of keys.slice(0, keys.length - MAX_TRACKED_SESSIONS)) {
			delete state.correlations[key];
		}
	}
	// sessionTerminals is bounded the same way: keep the newest
	// MAX_TRACKED_SESSIONS cancel records (one per operator-cancelled session).
	const terminalKeys = Object.keys(state.sessionTerminals);
	if (terminalKeys.length > MAX_TRACKED_SESSIONS) {
		for (const key of terminalKeys.slice(
			0,
			terminalKeys.length - MAX_TRACKED_SESSIONS,
		)) {
			delete state.sessionTerminals[key];
		}
	}
	state.updatedAt = new Date().toISOString();
	// validateSwarmPath treats its filename as relative to <root>/.swarm (it
	// prepends the .swarm segment itself), so pass the name WITHOUT the .swarm
	// prefix — PR_FEEDBACK_LOOP_STATE_REL is the reader-facing public path.
	await writePrWorkflowAtomicJson(
		directory,
		validateSwarmPath(directory, path.basename(PR_FEEDBACK_LOOP_STATE_REL)),
		state,
	);
}

/**
 * Project-scoped state mutation lock. This deliberately mirrors the queue's
 * `wx` + owner token + PID-liveness recovery protocol. State callers acquire
 * it only after the per-session settlement lock and release it before any
 * external Git, model, prompt, workflow, or publication operation.
 */
async function withLoopStateLock<T>(
	directory: string,
	fn: () => Promise<T>,
): Promise<T> {
	const lock = await acquireLoopStateLock(directory);
	try {
		return await fn();
	} finally {
		await releaseLoopStateLock(lock);
	}
}

async function acquireLoopStateLock(
	directory: string,
): Promise<LoopStateLockHandle> {
	const lockPath = validateSwarmPath(
		directory,
		PR_FEEDBACK_LOOP_STATE_LOCK_FILENAME,
	);
	const verifiedStateDirectory = await ensurePrWorkflowSafeParentDirectory(
		directory,
		lockPath,
	);
	for (let attempt = 0; attempt < LOOP_STATE_LOCK_MAX_ATTEMPTS; attempt++) {
		try {
			const handle = await fs.open(lockPath, 'wx');
			const lock: LoopStateLockRecord = {
				ownerToken: randomUUID(),
				pid: process.pid,
				createdAtMs: _internals.now(),
			};
			let writeError: unknown;
			try {
				await _internals.beforeLoopStateLockWrite?.();
				const [openedStat, pathStat, realLockPath] = await Promise.all([
					handle.stat({ bigint: true }),
					fs.lstat(lockPath, { bigint: true }),
					fs.realpath(lockPath),
				]);
				if (
					!openedStat.isFile() ||
					pathStat.isSymbolicLink() ||
					!pathStat.isFile() ||
					!sameFileIdentity(openedStat, pathStat) ||
					normalizeComparablePath(path.dirname(realLockPath)) !==
						normalizeComparablePath(verifiedStateDirectory)
				) {
					throw new Error(
						'BLOCKED: PR feedback loop state lock changed or escaped before initialization',
					);
				}
				await handle.writeFile(JSON.stringify(lock), 'utf8');
			} catch (error) {
				writeError = error;
			} finally {
				await handle.close().catch(() => undefined);
			}
			if (writeError) {
				await removeLoopStateLockIfOwned(lockPath, lock.ownerToken);
				throw writeError;
			}
			return { path: lockPath, ownerToken: lock.ownerToken };
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
			if (await reclaimAbandonedLoopStateLock(lockPath)) continue;
			if (attempt < LOOP_STATE_LOCK_MAX_ATTEMPTS - 1) {
				await delay(LOOP_STATE_LOCK_RETRY_DELAY_MS);
			}
		}
	}
	throw new Error(
		'BLOCKED: PR feedback loop state is being mutated by another process; retry after that transition finishes',
	);
}

async function releaseLoopStateLock(lock: LoopStateLockHandle): Promise<void> {
	try {
		await removeLoopStateLockIfOwned(lock.path, lock.ownerToken);
	} catch {
		// best effort; stale PID recovery handles a process crash.
	}
}

async function reclaimAbandonedLoopStateLock(
	lockPath: string,
): Promise<boolean> {
	const lock = await readLoopStateLock(lockPath);
	if (lock) {
		if (_internals.isProcessAlive(lock.pid)) return false;
		return removeLoopStateLockIfOwned(lockPath, lock.ownerToken);
	}
	try {
		const stat = await fs.stat(lockPath);
		if (
			_internals.now() - stat.mtimeMs <
			LOOP_STATE_LOCK_UNINITIALIZED_STALE_MS
		) {
			return false;
		}
		await fs.rm(lockPath, { force: true });
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
		throw error;
	}
}

async function readLoopStateLock(
	lockPath: string,
): Promise<LoopStateLockRecord | null> {
	let raw: string;
	try {
		raw = await fs.readFile(lockPath, 'utf8');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
		throw error;
	}
	try {
		const parsed: unknown = JSON.parse(raw);
		if (
			typeof parsed === 'object' &&
			parsed !== null &&
			typeof (parsed as LoopStateLockRecord).ownerToken === 'string' &&
			(parsed as LoopStateLockRecord).ownerToken.length > 0 &&
			typeof (parsed as LoopStateLockRecord).pid === 'number' &&
			Number.isInteger((parsed as LoopStateLockRecord).pid) &&
			(parsed as LoopStateLockRecord).pid > 0 &&
			typeof (parsed as LoopStateLockRecord).createdAtMs === 'number' &&
			Number.isFinite((parsed as LoopStateLockRecord).createdAtMs)
		) {
			return parsed as LoopStateLockRecord;
		}
	} catch {
		// An old partially-written lock is recovered by the age guard below.
	}
	return null;
}

async function removeLoopStateLockIfOwned(
	lockPath: string,
	ownerToken: string,
): Promise<boolean> {
	const lock = await readLoopStateLock(lockPath);
	if (!lock || lock.ownerToken !== ownerToken) return false;
	try {
		await fs.rm(lockPath);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
		throw error;
	}
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== 'ESRCH';
	}
}

interface HalfOpenProbeAdmission {
	state: LoopStateV1;
	correlation: CorrelationState;
	allowed: boolean;
	probeStarted: boolean;
	probeOwnerToken?: string;
	probeOwnerPid?: number;
	open: boolean;
}

async function admitHalfOpenProbe(
	directory: string,
	key: string,
	now: number,
	stateFallback: LoopStateV1,
	correlationFallback: CorrelationState,
): Promise<HalfOpenProbeAdmission> {
	return withLoopStateLock(directory, async () => {
		const readResult = await _internals.readState(directory);
		if (isCorruptState(readResult)) {
			throw new Error(
				'BLOCKED: loop state is corrupt during half-open admission',
			);
		}
		const state = readResult;
		const persistedCorrelation = state.correlations[key];
		const fallbackCorrelation =
			correlationFallback ?? stateFallback.correlations[key];
		if (
			!persistedCorrelation &&
			fallbackCorrelation &&
			normalizeRevision(fallbackCorrelation.revision) > 0
		) {
			throw new Error(
				'BLOCKED: loop correlation insert lost its expected revision-0 CAS',
			);
		}
		const correlation = persistedCorrelation ?? fallbackCorrelation;
		if (!correlation) {
			throw new Error(
				'BLOCKED: loop correlation is unavailable during half-open admission',
			);
		}
		state.correlations[key] = normalizeCorrelation(correlation);
		const currentCorrelation = state.correlations[key];
		if (currentCorrelation.circuit.openUntil > now) {
			return {
				state,
				correlation: currentCorrelation,
				allowed: false,
				probeStarted: false,
				open: true,
			};
		}
		if (currentCorrelation.circuit.openUntil <= 0) {
			return {
				state,
				correlation: currentCorrelation,
				allowed: true,
				probeStarted: false,
				open: false,
			};
		}
		const markerPresent = currentCorrelation.circuit.halfOpenProbes >= 1;
		if (markerPresent) {
			const markerPid = currentCorrelation.circuit.halfOpenProbeOwnerPid;
			const markerToken = currentCorrelation.circuit.halfOpenProbeOwnerToken;
			if (!markerToken || !markerPid || _internals.isProcessAlive(markerPid)) {
				// A legacy marker without an owner is deliberately unrecoverable. The
				// process cannot prove that it is dead, so age alone must not authorize
				// another oversight probe.
				return {
					state,
					correlation: currentCorrelation,
					allowed: false,
					probeStarted: false,
					open: false,
				};
			}
			// A properly identified dead owner is the only safe recovery path.
			clearHalfOpenProbeMarker(currentCorrelation.circuit);
		}
		if (currentCorrelation.circuit.halfOpenProbes >= 1) {
			return {
				state,
				correlation: currentCorrelation,
				allowed: false,
				probeStarted: false,
				open: false,
			};
		}
		currentCorrelation.circuit.halfOpenProbes = 1;
		currentCorrelation.circuit.halfOpenProbeStartedAt = now;
		currentCorrelation.circuit.halfOpenProbeOwnerToken = randomUUID();
		currentCorrelation.circuit.halfOpenProbeOwnerPid = process.pid;
		bumpCorrelationRevision(currentCorrelation);
		await _internals.writeState(directory, state);
		return {
			state,
			correlation: currentCorrelation,
			allowed: true,
			probeStarted: true,
			probeOwnerToken: currentCorrelation.circuit.halfOpenProbeOwnerToken,
			probeOwnerPid: currentCorrelation.circuit.halfOpenProbeOwnerPid,
			open: false,
		};
	});
}

async function finishHalfOpenProbe(
	directory: string,
	key: string,
	success: boolean,
	probeOwnerToken: string | undefined,
	probeOwnerPid: number | undefined,
): Promise<LoopStateV1 | null> {
	return withLoopStateLock(directory, async () => {
		const readResult = await _internals.readState(directory);
		if (isCorruptState(readResult)) return null;
		const state = readResult;
		const correlation = state.correlations[key];
		if (!correlation) return state;
		if (
			correlation.circuit.halfOpenProbeOwnerToken !== probeOwnerToken ||
			correlation.circuit.halfOpenProbeOwnerPid !== probeOwnerPid
		) {
			// A dead owner may have been recovered and replaced before this late
			// result arrived. Never clear or reopen a newer worker's probe.
			return state;
		}
		if (success) {
			correlation.circuit = { failures: 0, openUntil: 0, halfOpenProbes: 0 };
		} else {
			correlation.circuit.openUntil = _internals.now() + 60_000;
			clearHalfOpenProbeMarker(correlation.circuit);
		}
		bumpCorrelationRevision(correlation);
		await _internals.writeState(directory, state);
		return state;
	});
}

/**
 * Abandon an admitted probe before oversight/action starts. This is distinct
 * from `finishHalfOpenProbe(false)`: an admission that never reached an
 * external effect must release its exclusive marker without manufacturing a
 * circuit failure or cooldown.
 */
async function releaseHalfOpenProbe(
	directory: string,
	key: string,
	probeOwnerToken: string | undefined,
	probeOwnerPid: number | undefined,
): Promise<LoopStateV1 | null> {
	return withLoopStateLock(directory, async () => {
		const readResult = await _internals.readState(directory);
		if (isCorruptState(readResult)) return null;
		const state = readResult;
		const correlation = state.correlations[key];
		if (!correlation) return state;
		if (
			correlation.circuit.halfOpenProbeOwnerToken !== probeOwnerToken ||
			correlation.circuit.halfOpenProbeOwnerPid !== probeOwnerPid
		) {
			// A newer worker may have recovered and replaced this marker. Never
			// clear another worker's probe during cleanup of a late exit.
			return state;
		}
		clearHalfOpenProbeMarker(correlation.circuit);
		bumpCorrelationRevision(correlation);
		await _internals.writeState(directory, state);
		return state;
	});
}

/**
 * Persist one correlation through the project lock without allowing a stale
 * action-side snapshot to overwrite an operator stop.  Session settlement
 * serialization is local-process only; this is the cross-process fence.
 */
async function persistCorrelation(
	directory: string,
	key: string,
	correlation: CorrelationState,
): Promise<{ state: LoopStateV1; correlation: CorrelationState }> {
	return withLoopStateLock(directory, async () => {
		const readResult = await _internals.readState(directory);
		if (isCorruptState(readResult)) {
			throw new Error('BLOCKED: loop state is corrupt during settlement');
		}
		const state = readResult;
		const durableCancellation = state.sessionTerminals[correlation.sessionID];
		const persisted = state.correlations[key];
		const expectedRevision = normalizeRevision(correlation.revision);
		if (
			persisted &&
			normalizeRevision(persisted.revision) !== expectedRevision
		) {
			// The caller's correlation is stale. Do not assign its whole object over
			// a newer reservation, cancellation, digest, or circuit transition. The
			// durable record remains authoritative and the caller observes it.
			return { state, correlation: normalizeCorrelation(persisted) };
		}
		const nextCorrelation = normalizeCorrelation(persisted ?? correlation);
		// Equal revisions mean the caller and durable record describe the same
		// generation. Apply only this generation's intended terminal transition;
		// never retain a stale object reference after the lock read.
		if (persisted) {
			nextCorrelation.terminal = correlation.terminal;
			nextCorrelation.inFlight = correlation.inFlight;
		}
		if (
			durableCancellation?.state === 'cancelled' ||
			nextCorrelation.terminal?.state === 'cancelled'
		) {
			const reason =
				durableCancellation?.reason ||
				nextCorrelation.terminal?.reason ||
				'operator cancellation';
			nextCorrelation.terminal = { state: 'cancelled', reason };
			if (nextCorrelation.inFlight?.actionStartedAt === undefined) {
				nextCorrelation.inFlight = null;
			}
		}
		bumpCorrelationRevision(nextCorrelation);
		state.correlations[key] = nextCorrelation;
		await _internals.writeState(directory, state);
		return { state, correlation: nextCorrelation };
	});
}

function sameFileIdentity(
	left: Pick<BigIntStats, 'dev' | 'ino'>,
	right: Pick<BigIntStats, 'dev' | 'ino'>,
): boolean {
	return left.dev === right.dev && left.ino === right.ino;
}

function normalizeComparablePath(value: string): string {
	const normalized = path.normalize(path.resolve(value));
	return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function correlationKey(sessionID: string, repo: string, pr: number): string {
	return `${sessionID}::${repo}::${pr}`;
}

function digestFor(
	type: string,
	repo: string,
	pr: number,
	head: string | null,
	actionClass: string,
): string {
	return createHash('sha256')
		.update(`${type}\0${repo}\0${pr}\0${head ?? ''}\0${actionClass}`, 'utf-8')
		.digest('hex');
}

function classifyEvent(event: { type: string }): PrFeedbackLoopClassification {
	const actionClass = SUPPORTED_EVENT_ACTION[event.type];
	if (actionClass) {
		return {
			type: event.type,
			actionClass,
			supported: true,
			ambiguous: false,
			reason: `supported monitor event -> ${actionClass}`,
		};
	}
	return {
		type: event.type,
		actionClass: 'unsupported',
		supported: false,
		ambiguous: false,
		reason: `unsupported monitor event type: ${event.type}`,
	};
}

function isStrictOversightApproval(over: DispatchOversightOutcome): boolean {
	if (!over.dispatched) return false;
	const decision = over.decision?.trim().toLowerCase() ?? '';
	const verdict = over.verdict?.trim().toUpperCase() ?? '';
	const decisionAllows = decision === 'allow' || decision === 'approve';
	const verdictAllows = verdict === 'APPROVE' || verdict === 'APPROVED';
	// The runtime adapter maps an exact APPROVED verdict to decision=allow. The
	// loop itself requires that normalized decision, and any supplied verdict
	// must also be exact. This rejects missing decisions, DISAPPROVED, PENDING,
	// and free-form strings that merely contain "approved".
	return decisionAllows && (verdict.length === 0 || verdictAllows);
}

async function hasExactDurableClaim(
	directory: string,
	sessionID: string,
	dedupToken: string,
	workflowInstanceId: string,
	ownerPid: number,
): Promise<boolean> {
	const queue = await readPrFeedbackMonitorQueue(directory, sessionID);
	return Boolean(
		queue?.events.some(
			(event) =>
				event.dedupToken === dedupToken &&
				event.claimedWorkflowInstanceId === workflowInstanceId &&
				event.claimedOwnerPid === ownerPid,
		),
	);
}

/**
 * Remove one exact pre-start reservation without disturbing a replacement
 * owner or a reservation that has crossed the external-action boundary.
 */
async function clearExactPreStartReservation(
	directory: string,
	key: string,
	dedupToken: string,
	workflowInstanceId: string,
	ownerPid: number,
	expectedActionStartedAt: number | undefined,
): Promise<boolean> {
	return withLoopStateLock(directory, async () => {
		const readResult = await _internals.readState(directory);
		if (isCorruptState(readResult)) return false;
		const state = normalizeLoopState(readResult);
		const correlation = state.correlations[key];
		const inFlight = correlation?.inFlight;
		if (
			!correlation ||
			!ownsExactReservation(
				inFlight,
				dedupToken,
				workflowInstanceId,
				ownerPid,
			) ||
			inFlight.actionStartedAt !== expectedActionStartedAt
		) {
			return false;
		}
		correlation.inFlight = null;
		bumpCorrelationRevision(correlation);
		await _internals.writeState(directory, state);
		return true;
	});
}

interface ActionStartAdmission {
	state: LoopStateV1;
	correlation: CorrelationState;
	started: boolean;
	cancelReason?: string;
	blockedReason?: string;
	unavailable?: boolean;
	missingCorrelation?: boolean;
	actionStartedAt?: number;
}

/**
 * Cross the durable action-start boundary for one exact queue/reservation owner.
 * Cancellation is checked before the marker; a same-process cancellation that
 * arrives while the marker write awaits clears the marker before this returns.
 */
async function markExactReservationActionStarted(
	directory: string,
	key: string,
	sessionID: string,
	dedupToken: string,
	workflowInstanceId: string,
	ownerPid: number,
	fallbackState: LoopStateV1,
	fallbackCorrelation: CorrelationState,
): Promise<ActionStartAdmission> {
	let actionStartedAt: number | undefined;
	try {
		return await withLoopStateLock(directory, async () => {
			const freshRead = await _internals.readState(directory);
			if (isCorruptState(freshRead))
				return {
					state: fallbackState,
					correlation: fallbackCorrelation,
					started: false,
					unavailable: true,
				};
			const state = normalizeLoopState(freshRead);
			const correlation = state.correlations[key];
			if (!correlation)
				return {
					state,
					correlation: fallbackCorrelation,
					started: false,
					missingCorrelation: true,
					blockedReason:
						'durable correlation disappeared before action start; event remains retryable',
				};
			const inFlight = correlation.inFlight;
			if (
				!ownsExactReservation(
					inFlight,
					dedupToken,
					workflowInstanceId,
					ownerPid,
				) ||
				inFlight.actionStartedAt !== undefined
			)
				return {
					state,
					correlation,
					started: false,
					blockedReason:
						'exact no-action reservation was lost before action start; event remains retryable',
				};
			const durableCancellation = state.sessionTerminals[sessionID];
			const cancelReason =
				durableCancellation?.state === 'cancelled'
					? durableCancellation.reason || 'operator cancellation'
					: localCancellationReason(directory, sessionID);
			if (cancelReason) {
				correlation.inFlight = null;
				bumpCorrelationRevision(correlation);
				await _internals.writeState(directory, state);
				return {
					state,
					correlation: state.correlations[key] ?? correlation,
					started: false,
					cancelReason,
				};
			}
			const claimHeld = await hasExactDurableClaim(
				directory,
				sessionID,
				dedupToken,
				workflowInstanceId,
				ownerPid,
			);
			if (!claimHeld) {
				correlation.inFlight = null;
				bumpCorrelationRevision(correlation);
				await _internals.writeState(directory, state);
				return {
					state,
					correlation: state.correlations[key] ?? correlation,
					started: false,
					blockedReason:
						'durable claim was lost before action start; event remains retryable',
				};
			}

			actionStartedAt = _internals.now();
			inFlight.actionStartedAt = actionStartedAt;
			bumpCorrelationRevision(correlation);
			await _internals.writeState(directory, state);
			// writeState normalizes the state in place and replaces correlation
			// records, so the pre-await reference is stale after persistence.
			const correlationAfterWrite = state.correlations[key];
			const cancellationDuringWrite = localCancellationReason(
				directory,
				sessionID,
			);
			if (cancellationDuringWrite) {
				if (
					ownsExactReservation(
						correlationAfterWrite?.inFlight,
						dedupToken,
						workflowInstanceId,
						ownerPid,
					) &&
					correlationAfterWrite.inFlight.actionStartedAt === actionStartedAt
				) {
					correlationAfterWrite.inFlight = null;
					bumpCorrelationRevision(correlationAfterWrite);
					await _internals.writeState(directory, state);
				}
				return {
					state,
					correlation:
						state.correlations[key] ?? correlationAfterWrite ?? correlation,
					started: false,
					cancelReason: cancellationDuringWrite,
					actionStartedAt,
				};
			}
			return {
				state,
				correlation: correlationAfterWrite ?? correlation,
				started: true,
				actionStartedAt,
			};
		});
	} catch (err) {
		// If the marker write succeeded but a following operation failed, no
		// performer has run yet. Remove only this exact marker before propagating.
		if (actionStartedAt !== undefined) {
			await clearExactPreStartReservation(
				directory,
				key,
				dedupToken,
				workflowInstanceId,
				ownerPid,
				actionStartedAt,
			).catch(() => false);
		}
		throw err;
	}
}

interface SubscriptionSnapshotRead {
	success: boolean;
	record: {
		sessionID: string;
		repoFullName: string;
		prNumber: number;
		headRefOid?: string;
	} | null;
}

async function readMatchingSubscriptionSnapshot(
	directory: string,
	sessionID: string,
	repoFullName: string,
	prNumber: number,
): Promise<SubscriptionSnapshotRead> {
	try {
		const subs = await _internals.listActive(directory);
		return {
			success: true,
			record:
				subs.find(
					(sub) =>
						sub.sessionID === sessionID &&
						sub.repoFullName === repoFullName &&
						sub.prNumber === prNumber,
				) ?? null,
		};
	} catch {
		return { success: false, record: null };
	}
}

async function rereadMatchingSubscriptionSnapshot(
	directory: string,
	sessionID: string,
	repoFullName: string,
	prNumber: number,
): Promise<SubscriptionSnapshotRead> {
	// PrMonitorWorker emits the event before persisting its snapshot. Keep the
	// retry bounded and small while allowing that write to complete.
	await delay(25);
	return readMatchingSubscriptionSnapshot(
		directory,
		sessionID,
		repoFullName,
		prNumber,
	);
}

function emptyResult(reason?: string): PrFeedbackLoopResult {
	return {
		ran: false,
		reason,
		dedupToken: null,
		event: null,
		classification: null,
		authorization: null,
		action: null,
		terminal: null,
	};
}

/**
 * Per-session settlement serialization: the notify hook and explicit callers
 * can race (both read the queue before either claim lands). Concurrent runs
 * would double-perform the authorized action — the second caller instead waits
 * for the first, then observes the queue empty. Bounded (invariant 8).
 */
const settlementsInProgress = new Map<string, Promise<unknown>>();
/**
 * Active action invocations, keyed by the serialized settlement identity.
 *
 * Keep this accounting separate from `settlementsInProgress`: a cancellation
 * queued behind an action legitimately replaces that map's tail, but it must
 * not make the still-running action disappear from the bounded admission
 * count. The refcount also handles same-key action invocations queued behind
 * one another while capacity remains keyed by distinct identities.
 */
const activeActionSettlements = new Map<string, number>();
const cancellationRequests = new Map<string, string>();
/**
 * Saturation reserve for targeted stops whose action is currently active.
 * Its size is bounded by MAX_IN_FLIGHT_SESSIONS because entries are admitted
 * only for keys in activeActionSettlements.
 */
const activeActionCancellationReserve = new Map<string, string>();
let activeCancellationRequests = 0;
/** Roots whose own cancellation registry is saturated. Never cross-pause a
 * different project when one root has too many concurrent operator stops. */
const cancellationAdmissionOverflowRoots = new Set<string>();
const activeCancellationRequestsByRoot = new Map<string, number>();

function settlementKey(directory: string, sessionID: string): string {
	return `${canonicalRootKeyFresh(directory)}${SESSION_KEY_SEPARATOR}${sessionID}`;
}

function rememberCancellationRequest(
	directory: string,
	sessionID: string,
	reason: string,
): { key: string; rootKey: string } {
	const key = settlementKey(directory, sessionID);
	const rootKey = canonicalRootKeyFresh(directory);
	const activeForRoot = activeCancellationRequestsByRoot.get(rootKey) ?? 0;
	activeCancellationRequests += 1;
	activeCancellationRequestsByRoot.set(rootKey, activeForRoot + 1);
	if (
		!cancellationRequests.has(key) &&
		activeForRoot >= MAX_CANCELLATION_REQUESTS
	) {
		if (activeActionSettlements.has(key)) {
			// Preserve targeted cancellation for an action already admitted even
			// when unrelated cancellation requests have saturated the ordinary
			// bounded registry.
			activeActionCancellationReserve.delete(key);
			activeActionCancellationReserve.set(key, reason);
			return { key, rootKey };
		}
		// Never evict an active stop request: doing so could let a settlement
		// through while the corresponding cancellation is waiting on its lock.
		// Never evict an active stop. The overflow marker is a distinct capacity
		// condition for unrelated action admissions; it must never masquerade as
		// an operator cancellation.
		cancellationAdmissionOverflowRoots.add(rootKey);
		return { key, rootKey };
	}
	cancellationRequests.delete(key);
	cancellationRequests.set(key, reason);
	return { key, rootKey };
}

function localCancellationReason(
	directory: string,
	sessionID: string,
): string | null {
	const key = settlementKey(directory, sessionID);
	return (
		cancellationRequests.get(key) ??
		activeActionCancellationReserve.get(key) ??
		null
	);
}

function cancellationAdmissionCapacityExceeded(directory: string): boolean {
	return cancellationAdmissionOverflowRoots.has(
		canonicalRootKeyFresh(directory),
	);
}

function releaseCancellationRequest(
	key: string,
	rootKey: string,
	reason: string,
): void {
	if (cancellationRequests.get(key) === reason) {
		cancellationRequests.delete(key);
	}
	if (activeActionCancellationReserve.get(key) === reason) {
		activeActionCancellationReserve.delete(key);
	}
	activeCancellationRequests = Math.max(0, activeCancellationRequests - 1);
	const activeForRoot = Math.max(
		0,
		(activeCancellationRequestsByRoot.get(rootKey) ?? 0) - 1,
	);
	if (activeForRoot === 0) {
		activeCancellationRequestsByRoot.delete(rootKey);
		cancellationAdmissionOverflowRoots.delete(rootKey);
	} else {
		activeCancellationRequestsByRoot.set(rootKey, activeForRoot);
	}
	if (activeCancellationRequests === 0) {
		cancellationRequests.clear();
		activeActionCancellationReserve.clear();
		cancellationAdmissionOverflowRoots.clear();
		activeCancellationRequestsByRoot.clear();
	}
}

interface FreshCancellationStatus {
	reason: string | null;
	state?: LoopStateV1;
	unavailable: boolean;
}

async function readFreshCancellationStatus(
	directory: string,
	sessionID: string,
): Promise<FreshCancellationStatus> {
	const requested = localCancellationReason(directory, sessionID);
	if (requested) return { reason: requested, unavailable: false };
	try {
		const readResult = await _internals.readState(directory);
		if (isCorruptState(readResult)) {
			return { reason: null, unavailable: true };
		}
		const terminal = readResult.sessionTerminals[sessionID];
		return {
			reason:
				terminal?.state === 'cancelled'
					? terminal.reason || 'operator cancellation'
					: null,
			state: readResult,
			unavailable: false,
		};
	} catch {
		return { reason: null, unavailable: true };
	}
}

/**
 * Read the current cancellation barrier before admitting new monitor work.
 * This includes an in-process cancellation request while it is being durably
 * recorded, and the session terminal persisted by a completed cancellation.
 */
export async function readPrFeedbackLoopCancellation(
	directory: string,
	sessionID: string,
): Promise<PrFeedbackLoopCancellationStatus> {
	try {
		const status = await readFreshCancellationStatus(directory, sessionID);
		return {
			cancelled: status.reason !== null,
			unavailable: status.unavailable,
			...(status.reason ? { reason: status.reason } : {}),
		};
	} catch {
		return { cancelled: false, unavailable: true };
	}
}

/**
 * Admit a new monitor event while holding the loop-state lock. Cancellation
 * persists its stop barrier under this same lock before it clears the queue;
 * keeping the check and enqueue in the loop → queue order prevents a stop
 * from racing between the check and a queue write after cleanup.
 */
export async function enqueuePrFeedbackMonitorEventIfNotCancelled(
	directory: string,
	sessionID: string,
	event: Omit<
		PrFeedbackMonitorEvent,
		'claimedWorkflowInstanceId' | 'claimedAt' | 'claimedOwnerPid'
	>,
): Promise<boolean> {
	return withLoopStateLock(directory, async () => {
		const cancellation = await readPrFeedbackLoopCancellation(
			directory,
			sessionID,
		);
		if (cancellation.cancelled || cancellation.unavailable) return false;
		await enqueuePrFeedbackMonitorEvent(directory, sessionID, event);
		return true;
	});
}

function cancelledResult(
	reason: string,
	base?: PrFeedbackLoopResult,
): PrFeedbackLoopResult {
	const result = base ? { ...base } : emptyResult(`cancelled: ${reason}`);
	result.reason = `cancelled: ${reason}`;
	result.authorization = {
		authorized: false,
		reason: `cancelled: ${reason} — no action performed`,
		stale: false,
		foreign: false,
		replay: false,
	};
	result.action = {
		kind: result.classification?.actionClass ?? 'none',
		performed: false,
	};
	result.terminal = { state: 'cancelled', reason };
	return result;
}

async function withSettlementLock<T>(
	directory: string,
	sessionID: string,
	fn: () => Promise<T>,
	options: {
		kind?: 'action' | 'cancellation';
		onCapacity?: () => T;
	} = {},
): Promise<T> {
	const key = settlementKey(directory, sessionID);
	const kind = options.kind ?? 'action';
	const prior = settlementsInProgress.get(key) ?? Promise.resolve();
	const actionReserved = kind === 'action';
	if (actionReserved) {
		// Admission is based on the distinct union of active action keys and
		// reserved targeted-cancellation keys, not on the current serialization
		// tail (which a same-key cancellation may replace). A reserved stop keeps
		// its action key's slot until that cancellation releases its request.
		const occupiedActionKeys = new Set([
			...activeActionSettlements.keys(),
			...activeActionCancellationReserve.keys(),
		]);
		if (
			!activeActionSettlements.has(key) &&
			!activeActionCancellationReserve.has(key) &&
			occupiedActionKeys.size >= MAX_IN_FLIGHT_SESSIONS
		) {
			return options.onCapacity
				? Promise.resolve(options.onCapacity())
				: Promise.reject(
						new Error(
							'BLOCKED: PR feedback loop action settlement capacity exhausted',
						),
					);
		}
		activeActionSettlements.set(
			key,
			(activeActionSettlements.get(key) ?? 0) + 1,
		);
	}
	const run = prior.catch(() => {}).then(fn);
	settlementsInProgress.set(key, run);
	try {
		return await run;
	} finally {
		if (actionReserved) {
			const activeCount = activeActionSettlements.get(key) ?? 0;
			if (activeCount <= 1) {
				activeActionSettlements.delete(key);
			} else {
				activeActionSettlements.set(key, activeCount - 1);
			}
		}
		if (settlementsInProgress.get(key) === run) {
			settlementsInProgress.delete(key);
		}
	}
}

/**
 * Process ONE queued monitor event end-to-end for the session (the #2502
 * completion-fixture unit): claim → classify → authorize → oversight → act →
 * settle. Never throws for expected refusal paths. Serialized per session — a
 * concurrent invocation (notify hook racing an explicit call) waits, then sees
 * the queue empty rather than double-performing.
 */
export async function claimAndProcessPrFeedbackEvent(
	directory: string,
	sessionID: string,
): Promise<PrFeedbackLoopResult> {
	return withSettlementLock(
		directory,
		sessionID,
		() => claimAndProcessPrFeedbackEventUnlocked(directory, sessionID),
		{
			kind: 'action',
			onCapacity: () =>
				emptyResult(
					'paused: PR feedback action settlement capacity exhausted; event remains retryable',
				),
		},
	);
}

async function claimAndProcessPrFeedbackEventUnlocked(
	directory: string,
	sessionID: string,
): Promise<PrFeedbackLoopResult> {
	const requestedCancellation = localCancellationReason(directory, sessionID);
	if (requestedCancellation) return cancelledResult(requestedCancellation);
	if (cancellationAdmissionCapacityExceeded(directory)) {
		return emptyResult(
			'paused: cancellation admission capacity exhausted; retry after active stops finish',
		);
	}

	let config: ReturnType<typeof loadPluginConfig>;
	try {
		config = loadPluginConfig(directory);
	} catch {
		return emptyResult('disabled');
	}
	if (!isPrFeedbackLoopEnabled(config)) {
		// The disabled no-op still reports the classification/authorization
		// shape (authorized:false, reason naming the disabled gate) so callers
		// and checks can distinguish it from a queue miss.
		const queuePeek = await readPrFeedbackMonitorQueue(
			directory,
			sessionID,
		).catch(() => null);
		const peek = (queuePeek?.events ?? []).find(
			(e) => !e.claimedWorkflowInstanceId,
		);
		return {
			ran: false,
			reason: 'disabled',
			dedupToken: peek?.dedupToken ?? null,
			event: peek
				? {
						type: peek.type,
						repoFullName: peek.repoFullName,
						prNumber: peek.prNumber,
						prUrl: peek.prUrl,
					}
				: null,
			classification: peek ? classifyEvent(peek) : null,
			authorization: {
				authorized: false,
				reason:
					'disabled: pr_feedback_loop requires pr_monitor.enabled + pr_monitor.auto_pr_feedback + pr_feedback_loop.enabled (triple opt-in)',
				stale: false,
				foreign: false,
				replay: false,
			},
			action: { kind: 'none', performed: false },
			terminal: null,
		};
	}

	const queue = await readPrFeedbackMonitorQueue(directory, sessionID).catch(
		() => null,
	);
	const pending = (queue?.events ?? []).find(
		(e) => !e.claimedWorkflowInstanceId,
	);
	if (!pending) return emptyResult('queue-empty');
	const classification = classifyEvent(pending);

	if (!isPrFeedbackLoopEnabled(config)) {
		// Defensive re-check after the await (config could not change, but the
		// shape stays uniform for tests).
		return emptyResult('disabled');
	}

	// Claim FIRST (#2502 B1): the idle hook's later queue read finds this event
	// gone — the structural no-double-wake guarantee, independent of
	// event_delivery mode.
	const workflowInstanceId = randomUUID();
	const ownerPid = process.pid;
	let claimed: PrFeedbackMonitorEvent[] = [];
	try {
		claimed = await withLoopStateLock(directory, () =>
			claimPrFeedbackMonitorEvents(
				directory,
				sessionID,
				workflowInstanceId,
				pending.prUrl,
				[pending.dedupToken],
				ownerPid,
			),
		);
	} catch {
		claimed = [];
	}
	// A queue claim is the durable admission token. Never fall back to the
	// pre-claim peek: another worker may have claimed it, or the mutation may
	// have failed. Processing the peek would bypass claim-first idempotency.
	const event =
		claimed.length === 1 &&
		claimed[0]?.dedupToken === pending.dedupToken &&
		claimed[0]?.claimedWorkflowInstanceId === workflowInstanceId &&
		claimed[0]?.claimedOwnerPid === ownerPid
			? claimed[0]
			: null;
	if (!event) return emptyResult('claim-not-acquired');
	const dedupToken = event.dedupToken;

	let readResult: LoopStateV1 | { corrupt: true };
	try {
		readResult = await withLoopStateLock(directory, () =>
			_internals.readState(directory),
		);
	} catch {
		await releasePrFeedbackMonitorEventClaim(
			directory,
			sessionID,
			pending.dedupToken,
			workflowInstanceId,
			ownerPid,
		).catch(() => undefined);
		return emptyResult(
			'paused: PR feedback loop state lock unavailable; retry without claiming another action',
		);
	}
	if ('corrupt' in readResult && readResult.corrupt) {
		// Fail closed: the state file holds the idempotency digests and budgets.
		// Settle as paused_for_human WITHOUT writing (a stateless write would
		// wipe the digest ledger on the next successful read) and surface the
		// operator-visible reason.
		return {
			ran: true,
			dedupToken: event.dedupToken,
			event: {
				type: event.type,
				repoFullName: event.repoFullName,
				prNumber: event.prNumber,
				prUrl: event.prUrl,
			},
			classification,
			authorization: {
				authorized: false,
				reason:
					'corrupt loop state: .swarm/pr-feedback-loop-state.json is unreadable or fails schema validation — settle paused so the idempotency ledger is not silently wiped; repair or delete the file to resume',
				stale: false,
				foreign: false,
				replay: false,
			},
			action: { kind: classification.actionClass, performed: false },
			terminal: {
				state: 'paused_for_human',
				reason:
					'corrupt loop state — paused for a human; idempotency ledger preserved on disk',
			},
		};
	}
	let state = readResult as LoopStateV1;
	normalizeLoopState(state);
	const key = correlationKey(sessionID, event.repoFullName, event.prNumber);
	let correlation: CorrelationState = state.correlations[key] ?? {
		revision: 0,
		sessionID,
		repoFullName: event.repoFullName,
		prNumber: event.prNumber,
		prActionsUsed: 0,
		processedDigests: [],
		circuit: { failures: 0, openUntil: 0, halfOpenProbes: 0 },
		inFlight: null,
		terminal: null,
	};
	state.correlations[key] = correlation;

	const cancellationAfterClaim = await readFreshCancellationStatus(
		directory,
		sessionID,
	);
	if (cancellationAfterClaim.reason) {
		return cancelledResult(cancellationAfterClaim.reason, {
			ran: true,
			dedupToken,
			event: {
				type: event.type,
				repoFullName: event.repoFullName,
				prNumber: event.prNumber,
				prUrl: event.prUrl,
			},
			classification,
			authorization: null,
			action: null,
			terminal: null,
		});
	}
	if (cancellationAfterClaim.unavailable) {
		return {
			ran: true,
			dedupToken,
			event: {
				type: event.type,
				repoFullName: event.repoFullName,
				prNumber: event.prNumber,
				prUrl: event.prUrl,
			},
			classification,
			authorization: {
				authorized: false,
				reason:
					'cancellation admission state unavailable — no action performed',
				stale: false,
				foreign: false,
				replay: false,
			},
			action: { kind: classification.actionClass, performed: false },
			terminal: {
				state: 'paused_for_human',
				reason: 'cancellation admission state unavailable — paused for a human',
			},
		};
	}

	const base: PrFeedbackLoopResult = {
		ran: true,
		dedupToken,
		event: {
			type: event.type,
			repoFullName: event.repoFullName,
			prNumber: event.prNumber,
			prUrl: event.prUrl,
		},
		classification,
		authorization: null,
		action: null,
		terminal: null,
	};

	// Producer-side authorization is part of the durable event contract. An
	// unauthorized notification is intentionally claimed and refused so it
	// cannot sit ahead of a later authorized event forever.
	if (event.authorized !== true) {
		correlation.terminal = {
			state: 'refused',
			reason:
				'event is not authorized for autonomous PR feedback; no action performed',
		};
		({ state, correlation } = await persistCorrelation(
			directory,
			key,
			correlation,
		));
		return {
			...base,
			authorization: {
				authorized: false,
				reason:
					'event is not authorized for autonomous PR feedback — no action performed',
				stale: false,
				foreign: false,
				replay: false,
			},
			action: { kind: classification.actionClass, performed: false },
			terminal: correlation.terminal,
		};
	}

	const head = await _internals
		.evaluateCurrentHead(directory, event.repoFullName, event.prNumber)
		.catch(() => null);

	// ── Unsupported type: refused, recorded, no action (AC1). ──
	if (!classification.supported) {
		correlation.terminal = {
			state: 'refused',
			reason: classification.reason,
		};
		({ state, correlation } = await persistCorrelation(
			directory,
			key,
			correlation,
		));
		return {
			...base,
			authorization: {
				authorized: false,
				reason: classification.reason,
				stale: false,
				foreign: false,
				replay: false,
			},
			action: { kind: 'none', performed: false },
			terminal: correlation.terminal,
		};
	}

	// ── Foreign/stale correlation: one subscription snapshot supplies both. ──
	// A worker emits before persisting its snapshot, so a missing baseline or
	// head mismatch gets exactly one bounded delayed re-read. Only a successful
	// two-read no-match is a true foreign refusal; read failures and an
	// unsynchronized existing record release this claim for a later retry.
	let subscriptionSnapshot = await readMatchingSubscriptionSnapshot(
		directory,
		sessionID,
		event.repoFullName,
		event.prNumber,
	);
	let foreign = false;
	if (head === null || !subscriptionSnapshot.success) {
		const reread = await rereadMatchingSubscriptionSnapshot(
			directory,
			sessionID,
			event.repoFullName,
			event.prNumber,
		);
		if (
			head !== null &&
			reread.success &&
			reread.record !== null &&
			reread.record.headRefOid === head
		) {
			// The first listActive read can race the worker's snapshot write. A
			// successful delayed read with the matching head is synchronized and
			// may proceed normally.
			subscriptionSnapshot = reread;
		} else if (reread.success && reread.record === null && head !== null) {
			subscriptionSnapshot = reread;
			foreign = true;
		} else if (!reread.success || head === null) {
			await releasePrFeedbackMonitorEventClaim(
				directory,
				sessionID,
				dedupToken,
				workflowInstanceId,
				ownerPid,
			).catch(() => undefined);
			classification.ambiguous = true;
			classification.reason =
				'ambiguous: PR snapshot synchronization unavailable — event remains pending for retry';
			return {
				...base,
				authorization: {
					authorized: false,
					reason: classification.reason,
					stale: false,
					foreign: false,
					replay: false,
				},
				action: { kind: classification.actionClass, performed: false },
				terminal: null,
			};
		} else {
			// A successful record with no matching head is still an
			// unsynchronized baseline and must remain retryable.
			await releasePrFeedbackMonitorEventClaim(
				directory,
				sessionID,
				dedupToken,
				workflowInstanceId,
				ownerPid,
			).catch(() => undefined);
			return {
				...base,
				authorization: {
					authorized: false,
					reason:
						'snapshot synchronization pending: persisted subscription baseline did not match the authenticated head — retryable',
					stale: false,
					foreign: false,
					replay: false,
				},
				action: { kind: classification.actionClass, performed: false },
				terminal: null,
			};
		}
	} else if (
		subscriptionSnapshot.record === null ||
		subscriptionSnapshot.record.headRefOid !== head
	) {
		const reread = await rereadMatchingSubscriptionSnapshot(
			directory,
			sessionID,
			event.repoFullName,
			event.prNumber,
		);
		if (
			reread.success &&
			reread.record !== null &&
			reread.record.headRefOid === head
		) {
			subscriptionSnapshot = reread;
		} else if (
			subscriptionSnapshot.success &&
			subscriptionSnapshot.record === null &&
			reread.success &&
			reread.record === null
		) {
			foreign = true;
		} else {
			await releasePrFeedbackMonitorEventClaim(
				directory,
				sessionID,
				dedupToken,
				workflowInstanceId,
				ownerPid,
			).catch(() => undefined);
			return {
				...base,
				authorization: {
					authorized: false,
					reason:
						'snapshot synchronization pending: persisted subscription baseline did not match the authenticated head — retryable',
					stale: false,
					foreign: false,
					replay: false,
				},
				action: { kind: classification.actionClass, performed: false },
				terminal: null,
			};
		}
	}
	if (subscriptionSnapshot.success && subscriptionSnapshot.record === null) {
		foreign = true;
	}

	const digest = digestFor(
		event.type,
		event.repoFullName,
		event.prNumber,
		head,
		classification.actionClass,
	);
	const replay = correlation.processedDigests.includes(digest);
	let halfOpenProbe = false;
	let halfOpenProbeOwnerToken: string | undefined;
	let halfOpenProbeOwnerPid: number | undefined;
	let probeCleanupAttempted = false;
	const releaseAdmittedProbe = async (): Promise<void> => {
		if (!halfOpenProbe || probeCleanupAttempted) return;
		probeCleanupAttempted = true;
		try {
			const released = await releaseHalfOpenProbe(
				directory,
				key,
				halfOpenProbeOwnerToken,
				halfOpenProbeOwnerPid,
			);
			if (released) {
				state = released;
				correlation = state.correlations[key] ?? correlation;
			}
		} catch (err) {
			warn(
				`[pr-feedback-loop] half-open marker cleanup failed (fail-closed): ${
					err instanceof Error ? err.message : String(err)
				}`,
			);
		} finally {
			halfOpenProbe = false;
		}
	};

	// ── Ambiguity: head evaluation failed → pending, no write-class action (AC2). ──
	if (head === null) {
		classification.ambiguous = true;
		classification.reason =
			'ambiguous: current head evaluation unavailable — remaining pending for a human';
		if (replay && correlation.terminal) {
			({ state, correlation } = await persistCorrelation(
				directory,
				key,
				correlation,
			));
			return {
				...base,
				authorization: {
					authorized: false,
					reason: 'replay: action digest already settled',
					stale: false,
					foreign,
					replay: true,
				},
				terminal: correlation.terminal,
			};
		}
		// PENDING, not a terminal: an ambiguous event must remain unsettled
		// (recorded in state with no terminal) rather than choose a write or
		// claim a human pause — the next non-ambiguous event settles normally.
		correlation.terminal = null;
		({ state, correlation } = await persistCorrelation(
			directory,
			key,
			correlation,
		));
		return {
			...base,
			authorization: {
				authorized: false,
				reason:
					'ambiguous: head evaluation returned null — event remains pending',
				stale: false,
				foreign,
				replay,
			},
			action: { kind: classification.actionClass, performed: false },
			terminal: null,
		};
	}

	// ── Authorization: foreign / stale / replay / budgets / circuit. ──
	const now = _internals.now();
	const sessionActionsMax = config.pr_feedback_loop?.max_session_actions ?? 10;
	const prActionsMax = config.pr_feedback_loop?.max_actions_per_pr ?? 3;
	// The SESSION budget spans every PR correlation of this session (the
	// per-PR budget stays per-correlation) — the caps are independent.
	const sessionActionsUsed = Object.values(state.correlations)
		.filter((c) => c.sessionID === sessionID)
		.reduce((sum, c) => sum + c.prActionsUsed, 0);
	const budget = {
		sessionActionsUsed,
		sessionActionsMax,
		prActionsUsed: correlation.prActionsUsed,
		prActionsMax,
		exhausted:
			sessionActionsUsed >= sessionActionsMax ||
			correlation.prActionsUsed >= prActionsMax,
	};
	const circuitOpen = correlation.circuit.openUntil > now;

	const refuseAuthorization = async (
		reason: string,
		extra: { stale?: boolean; replay?: boolean } = {},
		terminal?: PrFeedbackLoopTerminal,
	): Promise<PrFeedbackLoopResult> => {
		await releaseAdmittedProbe();
		if (terminal) correlation.terminal = terminal;
		// Await so the terminal is durable before returning: a fire-and-forget
		// write here races the settlement lock release and a rapid follow-up
		// claimAndProcess could read stale state (or lose the terminal).
		try {
			({ state, correlation } = await persistCorrelation(
				directory,
				key,
				correlation,
			));
		} catch (err) {
			warn(
				`[pr-feedback-loop] refusal terminal write failed (state kept in memory): ${
					err instanceof Error ? err.message : String(err)
				}`,
			);
		}
		return {
			...base,
			authorization: {
				authorized: false,
				reason,
				stale: extra.stale ?? false,
				foreign,
				replay: extra.replay ?? replay,
				budget,
			},
			action: { kind: classification.actionClass, performed: false },
			terminal: terminal ?? correlation.terminal,
		};
	};

	if (foreign) {
		return await refuseAuthorization(
			'foreign: event does not match an active subscription correlation for this session',
		);
	}

	// Stale head: the same subscription snapshot used for foreign correlation
	// must equal the freshly evaluated head (AC7). A mismatch was already given
	// one delayed re-read above, so this is a defensive invariant check.
	const subscriptionHead = subscriptionSnapshot.record?.headRefOid ?? null;
	// Autonomous feedback events are bound to the authenticated head observed by
	// the monitor. Missing provenance is treated as stale (legacy/hand-crafted
	// queue rows must never gain authorization against a newer head).
	const eventHeadMismatch = event.headRefOid !== head;
	const stale =
		eventHeadMismatch ||
		(subscriptionHead !== null && subscriptionHead !== head);
	if (stale) {
		return await refuseAuthorization(
			eventHeadMismatch
				? 'stale: queued event head provenance is missing or does not match the freshly evaluated PR head'
				: 'stale: event head does not match the freshly evaluated PR head',
			{ stale: true },
		);
	}

	// Restoration (#2502 AC8 / R8): a processed digest with no recorded terminal
	// is an interrupted settlement — the digest is itself proof the action
	// settled, so re-record a truthful terminal WITHOUT re-performing.
	if (replay) {
		if (!correlation.terminal) {
			correlation.terminal = {
				state: 'completed',
				reason:
					'restored after interruption: authorized feedback action was performed and recorded; terminal re-recorded without re-performing',
			};
			correlation.inFlight = null;
			({ state, correlation } = await persistCorrelation(
				directory,
				key,
				correlation,
			));
			return {
				...base,
				authorization: {
					authorized: false,
					reason: 'replay: action digest already settled (terminal restored)',
					stale: false,
					foreign,
					replay: true,
					budget,
				},
				action: { kind: classification.actionClass, performed: false },
				terminal: correlation.terminal,
			};
		}
		return {
			...base,
			authorization: {
				authorized: false,
				reason: 'replay: action digest already settled',
				stale: false,
				foreign,
				replay: true,
				budget,
			},
			action: { kind: classification.actionClass, performed: false },
			terminal: correlation.terminal,
		};
	}

	if (budget.exhausted) {
		return await refuseAuthorization(
			'budget exhausted: per-session/per-PR action cap reached — pausing for a human',
			{},
			{
				state: 'paused_for_human',
				reason: `budget exhausted (session ${sessionActionsUsed}/${sessionActionsMax}, pr ${correlation.prActionsUsed}/${prActionsMax})`,
			},
		);
	}

	if (circuitOpen) {
		return await refuseAuthorization(
			'circuit open: repeated failures degraded the loop — probe again after the cooldown',
			{},
			{
				state: 'degraded',
				reason: `circuit open until ${correlation.circuit.openUntil} (failures: ${correlation.circuit.failures})`,
			},
		);
	}

	// Half-open probe admission (AC12) is durable and project-exclusive. The
	// fresh read under the lock prevents a process restart or another worker from
	// dispatching a second probe; only a marker whose owner PID is proven dead is
	// reclaimed there. Legacy ownerless markers remain fail-closed.
	try {
		const probe = await admitHalfOpenProbe(
			directory,
			key,
			now,
			state,
			correlation,
		);
		state = probe.state;
		correlation = probe.correlation;
		halfOpenProbe = probe.probeStarted;
		halfOpenProbeOwnerToken = probe.probeOwnerToken;
		halfOpenProbeOwnerPid = probe.probeOwnerPid;
		if (!probe.allowed) {
			return await refuseAuthorization(
				probe.open
					? 'circuit open: another probe is not yet eligible — pausing for a human'
					: 'circuit half-open probe already in progress — pausing for a human',
				{},
				{
					state: 'degraded',
					reason: probe.open
						? `circuit open until ${correlation.circuit.openUntil}`
						: 'half-open probe already in progress',
				},
			);
		}
	} catch (err) {
		warn(
			`[pr-feedback-loop] half-open admission failed (fail-closed): ${
				err instanceof Error ? err.message : String(err)
			}`,
		);
		return await refuseAuthorization(
			'half-open admission could not be durably recorded — no action performed',
			{},
			{
				state: 'paused_for_human',
				reason: 'half-open admission failed — paused for a human',
			},
		);
	}

	// Cancellation is an admission barrier, not merely a terminal annotation.
	// Re-read the durable session record immediately before dispatching an
	// oversight child so a concurrent `/swarm pr-feedback-loop stop` cannot
	// start new model work after its cancellation has landed.
	const cancellationBeforeOversight = await readFreshCancellationStatus(
		directory,
		sessionID,
	);
	if (cancellationBeforeOversight.reason) {
		await releaseAdmittedProbe();
		return cancelledResult(cancellationBeforeOversight.reason, base);
	}
	if (cancellationBeforeOversight.unavailable) {
		return await refuseAuthorization(
			'cancellation admission state unavailable — no action performed',
			{},
			{
				state: 'paused_for_human',
				reason: 'cancellation admission state unavailable — paused for a human',
			},
		);
	}

	// ── Oversight (AC11): fail-closed second-model gate. ──
	// Reserve the durable evidence sequence under the same project lock as the
	// half-open marker, then release before any model work.
	try {
		state = await withLoopStateLock(directory, async () => {
			const fresh = await _internals.readState(directory);
			if (isCorruptState(fresh)) {
				throw new Error('BLOCKED: loop state is corrupt before oversight');
			}
			fresh.oversightSeq += 1;
			await _internals.writeState(directory, fresh);
			return fresh;
		});
		correlation = state.correlations[key] ?? correlation;
	} catch (err) {
		return await refuseAuthorization(
			`oversight sequence admission failed: ${err instanceof Error ? err.message : String(err)}`,
			{},
			{
				state: 'paused_for_human',
				reason: 'oversight sequence admission failed — paused for a human',
			},
		);
	}
	const oversight = await Promise.resolve(
		_internals.dispatchOversight({
			directory,
			sessionID,
			eventType: event.type,
			actionClass: classification.actionClass,
			repoFullName: event.repoFullName,
			prNumber: event.prNumber,
			head,
		}),
	).catch(
		() =>
			({
				dispatched: false,
				verdict: 'error',
				decision: 'pending',
			}) as DispatchOversightOutcome,
	);

	// Durable evidence record for the dispatch (no full-auto state touched).
	try {
		fsSync.mkdirSync(path.join(directory, PR_FEEDBACK_EVIDENCE_DIR), {
			recursive: true,
		});
		fsSync.writeFileSync(
			path.join(
				directory,
				PR_FEEDBACK_EVIDENCE_DIR,
				`${state.oversightSeq}-${randomUUID()}.json`,
			),
			JSON.stringify(
				{
					schemaVersion: 1,
					at: new Date().toISOString(),
					sessionID,
					eventType: event.type,
					actionClass: classification.actionClass,
					repoFullName: event.repoFullName,
					prNumber: event.prNumber,
					head,
					dedupToken,
					outcome: oversight,
				},
				null,
				2,
			),
			'utf-8',
		);
	} catch (err) {
		warn(
			`[pr-feedback-loop] oversight evidence write failed (fail-closed): ${
				err instanceof Error ? err.message : String(err)
			}`,
		);
		return await refuseAuthorization(
			'oversight evidence could not be durably recorded — no action performed',
			{},
			{
				state: 'paused_for_human',
				reason: 'oversight evidence write failed — paused for a human',
			},
		);
	}

	// Approval vocabulary is deliberately exact: substring matches would let a
	// verdict such as "DISAPPROVED" authorize autonomous work.
	const oversightApproved = isStrictOversightApproval(oversight);
	const authorization: PrFeedbackLoopAuthorization = {
		authorized: oversightApproved,
		reason: oversightApproved
			? 'oversight approved the authorized feedback action'
			: `oversight did not approve (dispatched=${oversight.dispatched}, decision=${oversight.decision ?? 'none'}, verdict=${oversight.verdict ?? 'none'})`,
		stale: false,
		foreign,
		replay,
		oversight: {
			dispatched: oversight.dispatched,
			verdict: oversight.verdict,
			decision: oversight.decision,
		},
		budget,
	};

	if (!authorization.authorized) {
		if (halfOpenProbe) {
			try {
				const reopened = await finishHalfOpenProbe(
					directory,
					key,
					false,
					halfOpenProbeOwnerToken,
					halfOpenProbeOwnerPid,
				);
				if (reopened) {
					state = reopened;
					correlation = state.correlations[key] ?? correlation;
				}
			} catch (err) {
				// finishHalfOpenProbe may fail while writing its terminal circuit
				// transition. Retry cleanup through the exact admitted owner so a
				// transient denial-recovery failure cannot strand the probe marker.
				await releaseAdmittedProbe();
				warn(
					`[pr-feedback-loop] half-open denial recovery failed: ${
						err instanceof Error ? err.message : String(err)
					}`,
				);
			}
		}
		correlation.terminal = {
			state: 'paused_for_human',
			reason: `oversight denial/pending: ${authorization.reason} — no action performed, paused for a human`,
		};
		({ state, correlation } = await persistCorrelation(
			directory,
			key,
			correlation,
		));
		return {
			...base,
			authorization,
			action: { kind: classification.actionClass, performed: false },
			terminal: correlation.terminal,
		};
	}

	// Final performer admission is one critical section: fresh durable
	// cancellation/correlation read, exact claim revalidation, and in-flight
	// persistence. Queue reads are lock-free; any queue mutation follows this
	// lock in the fixed settlement → loop-state → queue order. The performer is
	// intentionally called only after the lock is released.
	let finalAdmission:
		| {
				state: LoopStateV1;
				correlation: CorrelationState;
				cancelReason: string | null;
				unavailable: boolean;
				claimHeld: boolean;
				retryableReason?: string;
		  }
		| undefined;
	try {
		finalAdmission = await withLoopStateLock(directory, async () => {
			const freshRead = await _internals.readState(directory);
			if (isCorruptState(freshRead)) {
				return {
					state,
					correlation,
					cancelReason: null,
					unavailable: true,
					claimHeld: false,
				};
			}
			const freshState = normalizeLoopState(freshRead);
			const durableCancellation = freshState.sessionTerminals[sessionID];
			const localCancellation = localCancellationReason(directory, sessionID);
			const cancelReason =
				durableCancellation?.state === 'cancelled'
					? durableCancellation.reason || 'operator cancellation'
					: localCancellation;
			const persistedCorrelation = freshState.correlations[key];
			// Once a correlation has any durable history, its disappearance is a
			// state-integrity failure. Never recreate it from this worker's stale
			// in-memory snapshot during final admission; doing so could resurrect a
			// completed action, digest ledger, reservation, or cancellation.
			if (
				!persistedCorrelation &&
				(normalizeRevision(correlation.revision) > 0 ||
					correlation.prActionsUsed > 0 ||
					correlation.processedDigests.length > 0 ||
					correlation.terminal !== null ||
					correlation.inFlight !== null ||
					correlation.circuit.failures > 0 ||
					correlation.circuit.openUntil > 0 ||
					correlation.circuit.halfOpenProbes > 0)
			) {
				return {
					state: freshState,
					correlation: normalizeCorrelation(correlation),
					cancelReason: null,
					unavailable: false,
					claimHeld: true,
					retryableReason:
						'paused: durable correlation disappeared before final action admission; event remains retryable (state repair required)',
				};
			}
			const freshCorrelation = normalizeCorrelation(
				persistedCorrelation ?? correlation,
			);
			freshState.correlations[key] = freshCorrelation;
			if (cancelReason) {
				return {
					state: freshState,
					correlation: freshCorrelation,
					cancelReason,
					unavailable: false,
					claimHeld: false,
				};
			}
			const claimHeld = await hasExactDurableClaim(
				directory,
				sessionID,
				dedupToken,
				workflowInstanceId,
				ownerPid,
			);
			if (!claimHeld) {
				return {
					state: freshState,
					correlation: freshCorrelation,
					cancelReason: null,
					unavailable: false,
					claimHeld: false,
				};
			}
			// A correlation admits at most one durable action reservation. A live
			// reservation is a retryable busy result; a dead, fully identified owner
			// may be recovered. Unknown/legacy owners are busy forever because age
			// cannot prove that their external action is no longer running.
			if (freshCorrelation.inFlight) {
				if (reservationIsLive(freshCorrelation.inFlight)) {
					return {
						state: freshState,
						correlation: freshCorrelation,
						cancelReason: null,
						unavailable: false,
						claimHeld: true,
						retryableReason:
							'paused: PR feedback loop correlation has a live action reservation; event remains retryable (busy)',
					};
				}
				freshCorrelation.inFlight = null;
				bumpCorrelationRevision(freshCorrelation);
			}
			// Recompute both caps from the fresh state. A pre-oversight budget check
			// is advisory only: another process may have reserved a different PR in
			// the meantime. Live reservations consume one action slot until their
			// exact owner settles or a dead PID is proven.
			const liveReservations = Object.values(freshState.correlations).filter(
				(entry) => reservationIsLive(entry.inFlight),
			);
			const sessionActionsUsed = Object.values(freshState.correlations)
				.filter((entry) => entry.sessionID === sessionID)
				.reduce((sum, entry) => sum + entry.prActionsUsed, 0);
			const liveSessionReservations = liveReservations.filter(
				(entry) => entry.sessionID === sessionID,
			).length;
			const livePrReservations = liveReservations.filter(
				(entry) =>
					entry.sessionID === sessionID &&
					entry.repoFullName === event.repoFullName &&
					entry.prNumber === event.prNumber,
			).length;
			const freshSessionActionsUsed =
				sessionActionsUsed + liveSessionReservations;
			const freshPrActionsUsed =
				freshCorrelation.prActionsUsed + livePrReservations;
			const sessionActionsMax =
				config.pr_feedback_loop?.max_session_actions ?? 10;
			const prActionsMax = config.pr_feedback_loop?.max_actions_per_pr ?? 3;
			if (
				freshSessionActionsUsed >= sessionActionsMax ||
				freshPrActionsUsed >= prActionsMax
			) {
				return {
					state: freshState,
					correlation: freshCorrelation,
					cancelReason: null,
					unavailable: false,
					claimHeld: true,
					retryableReason: `paused: PR feedback loop durable action capacity exhausted (session ${freshSessionActionsUsed}/${sessionActionsMax}, pr ${freshPrActionsUsed}/${prActionsMax}); event remains retryable (capacity)`,
				};
			}
			freshCorrelation.inFlight = {
				dedupToken,
				workflowInstanceId,
				ownerPid,
				actionClass: classification.actionClass,
				head,
				performed: false,
				attempts: 0,
				claimedAt: new Date().toISOString(),
			};
			bumpCorrelationRevision(freshCorrelation);
			await _internals.writeState(directory, freshState);
			return {
				state: freshState,
				correlation: freshCorrelation,
				cancelReason: null,
				unavailable: false,
				claimHeld: true,
			};
		});
	} catch (err) {
		warn(
			`[pr-feedback-loop] final action admission failed (fail-closed): ${
				err instanceof Error ? err.message : String(err)
			}`,
		);
		return await refuseAuthorization(
			'final action admission could not be durably verified — no action performed',
			{},
			{
				state: 'paused_for_human',
				reason: 'final action admission failed — paused for a human',
			},
		);
	}
	state = finalAdmission.state;
	correlation = finalAdmission.correlation;
	if (finalAdmission.retryableReason) {
		await releaseAdmittedProbe();
		// A retryable reservation conflict owns this exact queue claim only. Release
		// by the full workflow+PID identity; never clear another worker's claim.
		const released = await releasePrFeedbackMonitorEventClaim(
			directory,
			sessionID,
			dedupToken,
			workflowInstanceId,
			ownerPid,
		).catch(() => false);
		return emptyResult(
			released
				? finalAdmission.retryableReason
				: `${finalAdmission.retryableReason}; exact queue claim release failed — paused for a human`,
		);
	}
	if (finalAdmission.cancelReason) {
		await releaseAdmittedProbe();
		return cancelledResult(finalAdmission.cancelReason, base);
	}
	if (finalAdmission.unavailable) {
		return await refuseAuthorization(
			'cancellation admission state unavailable — no action performed',
			{},
			{
				state: 'paused_for_human',
				reason: 'cancellation admission state unavailable — paused for a human',
			},
		);
	}
	if (!finalAdmission.claimHeld) {
		return await refuseAuthorization(
			'durable claim was lost before action — no action performed',
			{},
			{
				state: 'paused_for_human',
				reason: 'durable claim was lost before action — paused for a human',
			},
		);
	}
	const admittedInFlight = correlation.inFlight;
	if (
		!admittedInFlight ||
		!ownsExactReservation(
			admittedInFlight,
			dedupToken,
			workflowInstanceId,
			ownerPid,
		)
	) {
		return await refuseAuthorization(
			'in-flight admission was not persisted — no action performed',
			{},
			{
				state: 'paused_for_human',
				reason: 'in-flight admission was not persisted — paused for a human',
			},
		);
	}
	// Final admission awaits both the project lock and a fresh queue claim
	// check. A same-process stop can land during those awaits, so perform one
	// synchronous local check before the durable action-start transition.
	const lateLocalCancellation = localCancellationReason(directory, sessionID);
	if (lateLocalCancellation) {
		await clearExactPreStartReservation(
			directory,
			key,
			dedupToken,
			workflowInstanceId,
			ownerPid,
			undefined,
		).catch((err) => {
			warn(
				`[pr-feedback-loop] pre-start cancellation cleanup failed: ${
					err instanceof Error ? err.message : String(err)
				}`,
			);
		});
		await releaseAdmittedProbe();
		return cancelledResult(lateLocalCancellation, base);
	}

	let actionStartAdmission: ActionStartAdmission;
	try {
		actionStartAdmission = await markExactReservationActionStarted(
			directory,
			key,
			sessionID,
			dedupToken,
			workflowInstanceId,
			ownerPid,
			state,
			correlation,
		);
	} catch (err) {
		warn(
			`[pr-feedback-loop] action-start transition failed (fail-closed): ${
				err instanceof Error ? err.message : String(err)
			}`,
		);
		return await refuseAuthorization(
			'action-start transition could not be durably verified — no action performed',
			{},
			{
				state: 'paused_for_human',
				reason: 'action-start transition failed — paused for a human',
			},
		);
	}
	state = actionStartAdmission.state;
	correlation = actionStartAdmission.correlation;
	if (actionStartAdmission.cancelReason) {
		await releaseAdmittedProbe();
		return cancelledResult(actionStartAdmission.cancelReason, base);
	}
	if (actionStartAdmission.unavailable) {
		return await refuseAuthorization(
			'action-start cancellation state unavailable — no action performed',
			{},
			{
				state: 'paused_for_human',
				reason: 'action-start state unavailable — paused for a human',
			},
		);
	}
	if (actionStartAdmission.missingCorrelation) {
		await releaseAdmittedProbe();
		const retryableReason =
			actionStartAdmission.blockedReason ??
			'durable correlation disappeared before action start; event remains retryable';
		const released = await releasePrFeedbackMonitorEventClaim(
			directory,
			sessionID,
			dedupToken,
			workflowInstanceId,
			ownerPid,
		).catch(() => false);
		return emptyResult(
			released
				? retryableReason
				: `${retryableReason}; exact queue claim release failed — paused for a human`,
		);
	}
	if (!actionStartAdmission.started) {
		return await refuseAuthorization(
			actionStartAdmission.blockedReason ??
				'exact action-start admission failed — no action performed',
			{},
			{
				state: 'paused_for_human',
				reason: 'exact action-start admission failed — paused for a human',
			},
		);
	}
	const performerInFlight = correlation.inFlight;
	if (
		!ownsExactReservation(
			performerInFlight,
			dedupToken,
			workflowInstanceId,
			ownerPid,
		) ||
		performerInFlight.actionStartedAt !== actionStartAdmission.actionStartedAt
	) {
		return await refuseAuthorization(
			'durable action-start marker was not retained by the exact owner — no action performed',
			{},
			{
				state: 'paused_for_human',
				reason: 'durable action-start marker was lost — paused for a human',
			},
		);
	}
	// Lock release also awaits I/O. Recheck the synchronous stop intent once
	// more, then invoke the performer without another await/yield in between.
	const cancellationBeforePerformer = localCancellationReason(
		directory,
		sessionID,
	);
	if (cancellationBeforePerformer) {
		await clearExactPreStartReservation(
			directory,
			key,
			dedupToken,
			workflowInstanceId,
			ownerPid,
			actionStartAdmission.actionStartedAt,
		).catch((err) => {
			warn(
				`[pr-feedback-loop] action-start cancellation cleanup failed: ${
					err instanceof Error ? err.message : String(err)
				}`,
			);
		});
		await releaseAdmittedProbe();
		return cancelledResult(cancellationBeforePerformer, base);
	}

	let outcome: PerformAuthorizedActionOutcome = { performed: false };
	for (let attempt = 0; attempt < MAX_PERFORM_ATTEMPTS; attempt++) {
		performerInFlight.attempts += 1;
		try {
			outcome = await _internals.performAuthorizedAction({
				directory,
				sessionID,
				event,
				actionClass: classification.actionClass,
				publication: 'none',
			});
		} catch (err) {
			// Performer throws carry the failure classification: transient markers
			// (HTTP 5xx/429/timeout/…) bound the retries; anything else is permanent.
			const message = err instanceof Error ? err.message : String(err);
			outcome = {
				performed: false,
				transient: TRANSIENT_MARKERS.test(message),
				permanent: !TRANSIENT_MARKERS.test(message),
				error: message,
			};
		}
		if (outcome.performed || outcome.permanent || !outcome.transient) break;
		// Bounded transient retry (max 2 retries) — no unbounded loops.
	}
	const action: PrFeedbackLoopAction = {
		kind: classification.actionClass,
		performed: outcome.performed,
		recordPath: outcome.recordPath,
	};

	// The performer ran outside every lock. Its result and a concurrent stop are
	// merged under the project lock so an action-side snapshot can never erase a
	// cancellation written by another process.
	let settledByOwner = true;
	try {
		({ state, correlation } = await withLoopStateLock(directory, async () => {
			const freshRead = await _internals.readState(directory);
			if (isCorruptState(freshRead)) {
				throw new Error('BLOCKED: loop state is corrupt after action');
			}
			const freshState = normalizeLoopState(freshRead);
			const freshCorrelation = normalizeCorrelation(
				freshState.correlations[key] ?? correlation,
			);
			const ownedReservation = freshCorrelation.inFlight;
			if (
				!hasReservationIdentity(ownedReservation) ||
				ownedReservation.workflowInstanceId !== workflowInstanceId ||
				ownedReservation.ownerPid !== ownerPid
			) {
				// The exact reservation may have been cancelled, recovered, or replaced
				// after this worker lost ownership. A late result must never settle over
				// the newer owner's state.
				settledByOwner = false;
				return { state: freshState, correlation: freshCorrelation };
			}
			const durableCancellation = freshState.sessionTerminals[sessionID];
			const cancellationReason =
				durableCancellation?.state === 'cancelled'
					? durableCancellation.reason || 'operator cancellation'
					: null;
			if (cancellationReason) {
				freshCorrelation.terminal = {
					state: 'cancelled',
					reason: cancellationReason,
				};
				if (outcome.performed) recordProcessedDigest(freshCorrelation, digest);
				if (
					halfOpenProbe &&
					freshCorrelation.circuit.halfOpenProbeOwnerToken ===
						halfOpenProbeOwnerToken &&
					freshCorrelation.circuit.halfOpenProbeOwnerPid ===
						halfOpenProbeOwnerPid
				) {
					clearHalfOpenProbeMarker(freshCorrelation.circuit);
				}
				freshCorrelation.inFlight = null;
			} else if (!outcome.performed) {
				freshCorrelation.circuit.failures += 1;
				// A failed half-open probe (including a permanent failure) must
				// re-open the cooldown and clear its exclusive marker.
				freshCorrelation.circuit.openUntil = _internals.now() + 60_000;
				clearHalfOpenProbeMarker(freshCorrelation.circuit);
				freshCorrelation.terminal = outcome.permanent
					? {
							state: 'paused_for_human',
							reason: `permanent action failure: ${outcome.error ?? 'unknown'} — no retry, paused for a human`,
						}
					: {
							state: 'degraded',
							reason: `transient action failures exhausted the retry budget: ${outcome.error ?? 'unknown'} — circuit open, probe again after cooldown`,
						};
				freshCorrelation.inFlight = null;
			} else {
				ownedReservation.performed = true;
				// Session budget is derived (sum of per-PR counters) — only the
				// per-PR counter increments here.
				freshCorrelation.prActionsUsed += 1;
				freshCorrelation.circuit = {
					failures: 0,
					openUntil: 0,
					halfOpenProbes: 0,
				};
				recordProcessedDigest(freshCorrelation, digest);
				freshCorrelation.terminal = {
					state: 'completed',
					reason:
						'authorized PR workflow action performed and recorded; downstream delivery and publication outcomes remain owned by the PR workflow',
				};
				freshCorrelation.inFlight = null;
			}
			bumpCorrelationRevision(freshCorrelation);
			freshState.correlations[key] = freshCorrelation;
			await _internals.writeState(directory, freshState);
			return { state: freshState, correlation: freshCorrelation };
		}));
		if (settledByOwner) halfOpenProbe = false;
	} catch (err) {
		warn(
			`[pr-feedback-loop] post-action settlement failed: ${
				err instanceof Error ? err.message : String(err)
			}`,
		);
		await releaseAdmittedProbe();
		return {
			...base,
			authorization,
			action,
			terminal: {
				state: 'paused_for_human',
				reason:
					'post-action state could not be durably settled — inspect before retrying',
			},
		};
	}
	if (!settledByOwner) {
		await releaseAdmittedProbe();
		return {
			...base,
			authorization,
			action,
			terminal: {
				state: 'paused_for_human',
				reason:
					'action result lost its exact durable reservation owner; newer state was preserved — inspect before retrying',
			},
		};
	}

	if (!outcome.performed || correlation.terminal?.state === 'cancelled') {
		return { ...base, authorization, action, terminal: correlation.terminal };
	}

	log(
		`[pr-feedback-loop] settled ${event.type} for ${event.repoFullName}#${event.prNumber} (${classification.actionClass})`,
	);
	return {
		...base,
		authorization: {
			...authorization,
			// Post-settle view: the budget the NEXT event will be checked against.
			budget: {
				...budget,
				sessionActionsUsed: sessionActionsUsed + 1,
				prActionsUsed: correlation.prActionsUsed,
			},
		},
		action,
		terminal: correlation.terminal,
	};
}

/**
 * Operator stop (#2502 AC10): terminal `cancelled` with the operator-visible
 * reason, #2584 publication cancellation first (no-op when unarmed,
 * fail-open), claimed-but-unsettled queue events cleared with an atomic
 * cleanup receipt. Idempotent: re-cancel returns the existing terminal.
 * Never issues NEW wakes (an in-flight wake may still surface in the session;
 * the gate's push admission refuses pushes against a cancelled generation).
 */
export async function cancelPrFeedbackLoop(
	directory: string,
	sessionID: string,
	reason: string,
): Promise<{
	terminalState: string;
	reason: string;
	cleanupReceipt: { path: string; clearedEvents: string[] };
}> {
	const cancellationRequest = rememberCancellationRequest(
		directory,
		sessionID,
		reason,
	);
	try {
		return await withSettlementLock(
			directory,
			sessionID,
			() => cancelPrFeedbackLoopUnlocked(directory, sessionID, reason),
			{ kind: 'cancellation' },
		);
	} finally {
		releaseCancellationRequest(
			cancellationRequest.key,
			cancellationRequest.rootKey,
			reason,
		);
	}
}

async function cancelPrFeedbackLoopUnlocked(
	directory: string,
	sessionID: string,
	reason: string,
): Promise<{
	terminalState: string;
	reason: string;
	cleanupReceipt: { path: string; clearedEvents: string[] };
}> {
	const receipt = {
		path: '',
		clearedEvents: [] as string[],
	};

	try {
		// Lazy import keeps this background module off the gate's static graph;
		// the #2584 route is now a typed public export on the gate.
		const { cancelPrFeedbackPublication } = await import(
			'../hooks/pr-workflow-gate.js'
		);
		await cancelPrFeedbackPublication(directory, sessionID, reason);
	} catch (err) {
		warn(
			`[pr-feedback-loop] cancelPrFeedbackPublication failed (fail-open): ${
				err instanceof Error ? err.message : String(err)
			}`,
		);
	}

	// Durable cancellation is the authoritative stop barrier. It is persisted
	// under the project loop-state lock before the queue is cleared, and the
	// lock is released before any queue mutation. This preserves the global
	// settlement → loop-state → queue ordering and makes the stop visible across
	// processes even when the in-memory intent registry is saturated.
	try {
		await withLoopStateLock(directory, async () => {
			const readResult = await _internals.readState(directory);
			if (isCorruptState(readResult)) {
				throw new Error(
					'BLOCKED: loop state is corrupt during durable cancellation admission',
				);
			}
			const nextState: LoopStateV1 = readResult;
			for (const correlation of Object.values(nextState.correlations)) {
				if (correlation.sessionID !== sessionID) continue;
				const alreadyCancelled = correlation.terminal?.state === 'cancelled';
				if (!alreadyCancelled) {
					correlation.terminal = { state: 'cancelled', reason };
				}
				// Keep an already-started reservation owned by a live performer so its
				// post-action exact-owner settlement can record a performed digest. A
				// dead owner cannot settle; cancellation is the explicit operator
				// decision that makes that otherwise-permanent reservation reclaimable.
				// Repeated operator cancellation rechecks liveness without replacing the
				// original terminal reason, so a later retry can reclaim a dead owner.
				const inFlight = correlation.inFlight;
				const ownerAlive =
					inFlight && hasReservationIdentity(inFlight)
						? _internals.isProcessAlive(inFlight.ownerPid)
						: false;
				const reclaimedReservation = Boolean(
					inFlight && (inFlight.actionStartedAt === undefined || !ownerAlive),
				);
				if (reclaimedReservation) {
					correlation.inFlight = null;
				}
				if (!alreadyCancelled || reclaimedReservation) {
					bumpCorrelationRevision(correlation);
				}
			}
			if (nextState.sessionTerminals[sessionID]?.state !== 'cancelled') {
				nextState.sessionTerminals[sessionID] = {
					state: 'cancelled',
					reason,
				};
			}
			await _internals.writeState(directory, nextState);
			return nextState;
		});
	} catch (err) {
		warn(
			`[pr-feedback-loop] durable cancellation admission failed: ${
				err instanceof Error ? err.message : String(err)
			}`,
		);
		return {
			terminalState: 'paused_for_human',
			reason: 'cancellation state could not be durably recorded',
			cleanupReceipt: receipt,
		};
	}

	const queue = await readPrFeedbackMonitorQueue(directory, sessionID).catch(
		() => null,
	);
	// Everything still in the queue is unsettled — claimed-but-unsettled
	// included (a claim alone never settles). The sanctioned queue-clear
	// primitive removes them so a cancelled loop leaves nothing claimable.
	const unsettled = queue?.events ?? [];
	if (unsettled.length > 0) {
		try {
			receipt.clearedEvents = await clearPrFeedbackMonitorEvents(
				directory,
				sessionID,
				unsettled.map((e) => e.dedupToken),
			);
		} catch {
			// Clearing is best-effort; the receipt still lists the tokens.
			receipt.clearedEvents = unsettled.map((e) => e.dedupToken);
		}
	}

	const stamp = new Date().toISOString().replace(/[:.]/g, '-');
	receipt.path = path.join(
		'.swarm',
		PR_FEEDBACK_CLEANUP_DIR,
		`cancel-${stamp}.json`,
	);
	try {
		fsSync.mkdirSync(path.join(directory, '.swarm', PR_FEEDBACK_CLEANUP_DIR), {
			recursive: true,
		});
		fsSync.writeFileSync(
			path.join(directory, receipt.path),
			JSON.stringify(
				{
					schemaVersion: 1,
					at: new Date().toISOString(),
					sessionID,
					reason,
					clearedEvents: receipt.clearedEvents,
				},
				null,
				2,
			),
			'utf-8',
		);
	} catch (err) {
		warn(
			`[pr-feedback-loop] cleanup receipt write failed (non-fatal): ${
				err instanceof Error ? err.message : String(err)
			}`,
		);
	}

	return { terminalState: 'cancelled', reason, cleanupReceipt: receipt };
}

/** Notify hook for pr-event-subscribers: fire-and-forget, fail-open. */
export function notifyPrFeedbackLoop(
	directory: string,
	sessionID: string,
): Promise<void> {
	// withTimeout is Promise.race: the timeout rejection is consumed by the
	// .catch below, but the SETTLE promise itself can still reject later (e.g.
	// a writeState I/O failure) and its rejection needs its own handler or it
	// becomes an unhandled rejection after the race already settled.
	const settle = claimAndProcessPrFeedbackEvent(directory, sessionID);
	settle.catch((err) => {
		warn(
			`[pr-feedback-loop] settle rejected (notify path, non-fatal): ${
				err instanceof Error ? err.message : String(err)
			}`,
		);
	});
	return withTimeout(
		settle,
		SETTLE_TIMEOUT_MS,
		new Error('pr-feedback-loop settlement timeout'),
	)
		.then(() => undefined)
		.catch(() => {});
}
