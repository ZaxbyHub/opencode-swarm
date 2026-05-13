/**
 * Evidence write-lock helper (PR 1 — dark foundation).
 *
 * Wraps every evidence read-modify-write path with a proper-lockfile-backed
 * exclusive lock so that concurrent writers cannot interleave their
 * read-compute-write cycles.  The underlying temp-file-plus-rename atomic
 * write is preserved; this lock adds a coordinating layer on top.
 *
 * Telemetry events emitted:
 *   evidence_lock_acquired   — lock obtained, fn executing
 *   evidence_lock_contended  — lock busy, backing off before retry
 *   evidence_lock_stale_recovered — stale lock detected and recovered by proper-lockfile
 *   (timeout path emits nothing extra; EvidenceLockTimeoutError is thrown instead)
 */

import { tryAcquireLock } from '../parallel/file-locks.js';
import { emit } from '../telemetry.js';

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
	const deadline = Date.now() + timeoutMs;
	let attempt = 0;

	while (true) {
		const result = await tryAcquireLock(directory, evidencePath, agent, taskId);

		if (result.acquired) {
			const lock = result.lock;
			// Emit stale_recovered when proper-lockfile cleaned a stale lock and we
			// now hold it (heuristic: success after prior contention indicates recovery).
			if (attempt > 0) {
				emit('evidence_lock_stale_recovered', {
					directory,
					evidencePath,
					agent,
					taskId,
					attempt,
				});
			}
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

		// tryAcquireLock returns { acquired: false } with no `existing` field —
		// proper-lockfile handles stale cleanup internally and never surfaces it to
		// callers. Emit contended on every failed acquire; stale_recovered is emitted
		// on successful acquire after prior contention (attempt > 0 path above).
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
