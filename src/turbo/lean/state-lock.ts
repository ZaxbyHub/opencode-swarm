/**
 * Durable Lean Turbo state write-lock helper.
 *
 * ## Issue #2: Cross-Runner Durable State Race
 *
 * Multiple LeanTurboRunner instances with the same sessionID share turbo-state.json.
 * Each runner has its own in-process _stateLock promise chain, but without file-level
 * coordination, concurrent runners can race:
 *
 * - Runner A: load state → modify → write
 * - Runner B: load state (gets A's version) → modify → write (overwrites A's changes)
 *
 * This module adds file-based locking using proper-lockfile to coordinate read-modify-write
 * cycles across processes, preventing inter-runner write races.
 *
 * ## Pattern
 *
 * Mirrors the evidence-lock pattern (src/evidence/lock.ts) with:
 * - Exponential backoff (50ms start, 2000ms max) with jitter
 * - Timeout protection (default 30 seconds for state, 60 seconds for evidence)
 * - Best-effort lock release in finally block
 * - Non-fatal lock release failures (proper-lockfile TTL cleanup)
 *
 * ## Telemetry
 *
 * Events emitted (when integrated into runners):
 * - turbo_state_lock_acquired
 * - turbo_state_lock_contended
 * - turbo_state_lock_timeout (thrown as error)
 */

import { tryAcquireLock } from '../../parallel/file-locks.js';

export class TurboStateLockTimeoutError extends Error {
	readonly directory: string;
	readonly sessionID: string;

	constructor(directory: string, sessionID: string, timeoutMs: number) {
		super(
			`Turbo state lock timeout after ${timeoutMs}ms for session ${sessionID}`,
		);
		this.name = 'TurboStateLockTimeoutError';
		this.directory = directory;
		this.sessionID = sessionID;
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
 * Acquire an exclusive turbo-state lock, execute `fn`, then release the lock.
 *
 * Retries with exponential backoff until `timeoutMs` elapses,
 * then throws `TurboStateLockTimeoutError`. Always releases the lock in a
 * `finally` block even if `fn` throws.
 *
 * @param directory    Project root directory
 * @param sessionID    Session identifier (for lock metadata and diagnostics)
 * @param fn           Callback that performs the read-modify-write on turbo state
 * @param timeoutMs    Maximum wait time before TurboStateLockTimeoutError (default 30 000)
 */
export async function withTurboStateLock<T>(
	directory: string,
	sessionID: string,
	fn: () => Promise<T>,
	timeoutMs = 30_000,
): Promise<T> {
	const lockPath = '.swarm/turbo-state.json';
	const agent = 'lean-turbo-runner';
	const deadline = Date.now() + timeoutMs;
	let attempt = 0;

	while (true) {
		const result = await tryAcquireLock(directory, lockPath, agent, sessionID);

		if (result.acquired) {
			const lock = result.lock;
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
			throw new TurboStateLockTimeoutError(directory, sessionID, timeoutMs);
		}

		const delay = Math.min(backoffMs(attempt), deadline - Date.now());
		if (delay > 0) {
			await new Promise((resolve) => setTimeout(resolve, delay));
		}
		attempt++;
	}
}
