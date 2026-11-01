/**
 * Evidence write-lock helper (PR 1 — dark foundation; #2967 owner-payload
 * substrate).
 *
 * Wraps every evidence read-modify-write path with an exclusive lock so that
 * concurrent writers cannot interleave their read-modify-write cycles.  The
 * underlying temp-file-plus-rename atomic write is preserved; this lock adds
 * a coordinating layer on top. Since #2967 the lock artifact is a wx-file
 * whose owner payload lives INSIDE the lock file, and a stale lock whose
 * owner process is provably dead is broken bounded by the fenced breaker in
 * `src/parallel/file-locks.ts` instead of wedging writers for the 5-minute
 * TTL.
 *
 * Telemetry events emitted:
 *   evidence_lock_acquired   — lock obtained, fn executing
 *   evidence_lock_contended  — lock busy, backing off before retry
 *   evidence_lock_stale_recovered — emitted ONLY after the fenced breaker
 *       confirmed a dead-owner break (#2967: truthful — success-after-
 *       contention alone proved nothing about WHY the lock became free)
 *   (timeout path emits nothing extra; EvidenceLockTimeoutError is thrown instead)
 */

import {
	breakStaleLockIfOwnerDead,
	getOwnerLockPath,
	readOwnerLockPayload,
	tryAcquireLock,
} from '../parallel/file-locks.js';
import { emit } from '../telemetry.js';
import { assertProjectRoot } from '../utils/project-boundary.js';

/** Contention-side helpers: derive the same artifact path the acquire path
 *  uses, and read the raw payload for break-class selection. */
function getEvidenceOwnerLockPath(directory: string, evidencePath: string) {
	return getOwnerLockPath(directory, evidencePath);
}

function readEvidenceOwnerPayload(ownerLockPath: string) {
	return readOwnerLockPayload(ownerLockPath);
}

/** Plan 05 v8 §1.2 (r6-#3) class selection: a PARSABLE payload names a pid
 *  whose liveness can be judged (`dead-owner`); an unparsable/absent payload
 *  (empty file, torn write, legacy ownerless artifact) must route to
 *  `ttl-cleanup` so a past-TTL ownerless lock RECOVERS through the fenced
 *  protocol while a fresh one times out exactly as today (AC4). Mirrors the
 *  events store's selection shape (core-events.ts `withCoreEventStoreLock`)
 *  and `parseOwnerPayload`'s validation (v === 1 + integer ownerPid). */
function ownerPayloadParsable(raw: string | null): boolean {
	if (raw === null || raw.length === 0) return false;
	try {
		const parsed = JSON.parse(raw) as { v?: unknown; ownerPid?: unknown };
		return parsed?.v === 1 && Number.isSafeInteger(parsed.ownerPid);
	} catch {
		return false;
	}
}

export class EvidenceLockTimeoutError extends Error {
	readonly directory: string;
	readonly evidencePath: string;
	readonly agent: string;
	readonly taskId: string;

	constructor(
		directory: string,
		evidencePath: string,
		agent: string,
		taskId: string,
		timeoutMs: number,
	) {
		super(
			`Evidence lock timeout after ${timeoutMs}ms for ${evidencePath} (agent=${agent}, task=${taskId})`,
		);
		this.name = 'EvidenceLockTimeoutError';
		this.directory = directory;
		this.evidencePath = evidencePath;
		this.agent = agent;
		this.taskId = taskId;
	}
}

const BACKOFF_START_MS = 50;
const BACKOFF_MAX_MS = 2000;
const BACKOFF_JITTER_RATIO = 0.25;

function backoffMs(attempt: number): number {
	const base = Math.min(BACKOFF_START_MS * 2 ** attempt, BACKOFF_MAX_MS);
	const jitter = base * BACKOFF_JITTER_RATIO * (Math.random() * 2 - 1);
	return Math.max(1, Math.round(base + jitter));
}

/**
 * Acquire an exclusive evidence lock, execute `fn`, then release the lock.
 *
 * Retries with exponential backoff until `evidenceLockTimeoutMs` elapses,
 * then throws `EvidenceLockTimeoutError`.  Always releases the lock in a
 * `finally` block even if `fn` throws.
 *
 * @param directory    Project root directory
 * @param evidencePath Relative path of the evidence file to lock
 * @param agent        Acquiring agent name (for diagnostics)
 * @param taskId       Task identifier (for diagnostics)
 * @param fn           Callback that performs the read-modify-write
 * @param timeoutMs    Maximum wait time before EvidenceLockTimeoutError (default 60 000)
 */
export async function withEvidenceLock<T>(
	directory: string,
	evidencePath: string,
	agent: string,
	taskId: string,
	fn: () => Promise<T>,
	timeoutMs = 60_000,
): Promise<T> {
	// The lock implementation creates durable state under `.swarm/locks` before
	// the caller callback runs. Guard that lowest-level mutation boundary so a
	// direct lock caller cannot bypass tool- or writer-layer root validation.
	assertProjectRoot(directory);
	const deadline = Date.now() + timeoutMs;
	let attempt = 0;
	let lastBreakWasConfirmed = false;

	while (true) {
		const result = await tryAcquireLock(
			directory,
			evidencePath,
			agent,
			taskId,
			{
				// The evidence path owns its own stale-recovery attribution (the
				// wrapper's breaker below reports store 'evidence'); the in-path
				// dead-owner probe (PRR-002) reports the same discriminator so the
				// break event is not misattributed to 'generic' when the probe
				// wins the race to a dead owner's artifact.
				breakStore: 'evidence',
			},
		);

		if (result.acquired) {
			const lock = result.lock;
			// #2967 (emit gate corrected per feedback PRR-010): emit
			// stale_recovered whenever a dead-owner break is confirmed — by
			// the wrapper's own breaker call (below) OR by the acquire path's
			// in-contention probe (PRR-002), which reports its break via
			// `brokeStale` so the event cannot be suppressed on the primary
			// recovery path. Plain success-after-contention (a live holder
			// releasing between retries) is NOT evidence of stale recovery.
			if (result.brokeStale) {
				lastBreakWasConfirmed = true;
			}
			if (lastBreakWasConfirmed) {
				emit('evidence_lock_stale_recovered', {
					directory,
					evidencePath,
					agent,
					taskId,
					attempt,
				});
			}
			lastBreakWasConfirmed = false;
			emit('evidence_lock_acquired', {
				directory,
				evidencePath,
				agent,
				taskId,
				attempt,
			});
			try {
				return await fn();
			} finally {
				if (lock._release) {
					try {
						await lock._release();
					} catch {
						// Release failure is non-fatal; proper-lockfile TTL will clean up.
					}
				}
			}
		}

		// Lock is held by another writer — check deadline before backing off.
		if (Date.now() >= deadline) {
			throw new EvidenceLockTimeoutError(
				directory,
				evidencePath,
				agent,
				taskId,
				timeoutMs,
			);
		}

		// tryAcquireLock returns { acquired: false } on contention. #2967:
		// every contention iteration re-probes the fenced liveness breaker —
		// its read-only verdicts consume no cooldown budget (review Finding 1
		// fix), so an owner dying mid-wait is picked up on the next attempt
		// instead of stalling the full deadline budget. A provably-dead
		// owner's lock is broken bounded (ms-scale) with one audited
		// telemetry event and a per-target mutation cooldown; a LIVE owner is
		// never touched and we fall through to the normal backoff below.
		{
			const ownerLockPath = getEvidenceOwnerLockPath(directory, evidencePath);
			const payloadRaw = readEvidenceOwnerPayload(ownerLockPath);
			const breakResult = breakStaleLockIfOwnerDead(ownerLockPath, {
				deadlineMs: deadline - Date.now(),
				// Parsable payload => liveness verdict; ownerless/legacy =>
				// TTL-only class (mtime past TTL breaks, otherwise today's
				// behaviour — AC4).
				class: ownerPayloadParsable(payloadRaw) ? 'dead-owner' : 'ttl-cleanup',
				store: 'evidence',
			});
			if (breakResult === 'broken') {
				lastBreakWasConfirmed = true;
				// The next loop iteration acquires the now-free lock.
				continue;
			}
		}

		emit('evidence_lock_contended', {
			directory,
			evidencePath,
			agent,
			taskId,
			attempt,
		});

		const delay = Math.min(backoffMs(attempt), deadline - Date.now());
		if (delay > 0) {
			await new Promise((resolve) => setTimeout(resolve, delay));
		}
		attempt++;
	}
}
