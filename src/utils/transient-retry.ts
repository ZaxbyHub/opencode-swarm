/**
 * Maximum number of transient retries for spawn/subprocess calls.
 * Mirrors the guardrails `max_transient_retries` default (invariant 9).
 */
export const MAX_TRANSIENT_RETRIES = 5;

/**
 * Base backoff delay in milliseconds for exponential transient-retry.
 * Actual delay = RETRY_BASE_DELAY_MS * 2^attempt.
 */
export const RETRY_BASE_DELAY_MS = 200;

/**
 * Returns true only for ETIMEDOUT spawn errors — the only error class
 * considered transient (retryable) in this codebase.
 *
 * ENOENT is intentionally excluded: it means "binary not at this candidate
 * path," which is handled by the caller's candidate-iteration loop, not by
 * retrying the same path.
 */
export function isTransientSpawnError(error: unknown): boolean {
	if (!error || typeof error !== 'object') return false;
	const code = (error as { code?: string }).code;
	return code === 'ETIMEDOUT';
}

/**
 * Blocking exponential backoff for use inside synchronous retry loops
 * (e.g. spawnSync call sites).
 *
 * Uses Atomics.wait on a SharedArrayBuffer for an efficient sleep; falls
 * back to a busy-wait loop on platforms/threads where Atomics.wait is not
 * available (e.g. the main thread on some Node.js builds).
 *
 * @param attempt Zero-based retry attempt index. Delay = RETRY_BASE_DELAY_MS * 2^attempt.
 */
export function transientBackoff(attempt: number): void {
	const delay = RETRY_BASE_DELAY_MS * 2 ** attempt;
	try {
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
	} catch {
		const start = Date.now();
		while (Date.now() - start < delay) {
			// Best-effort busy-wait fallback when Atomics.wait is unavailable.
		}
	}
}
