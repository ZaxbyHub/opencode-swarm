/**
 * Timeout primitives used by the plugin init path.
 *
 * Every Promise.race clears its timer in `finally`, so completed operations do
 * not leak a process handle. A timer that is itself required to settle an
 * awaited promise remains ref'ed: Bun can strand that caller when its only
 * settlement handle is unref'ed.
 */

/**
 * Race a promise against a timeout. The timer is cleared in `finally` so the
 * Node event loop is not pinned open after the race resolves. The returned
 * promise resolves to the racer's value, or rejects with the supplied
 * `timeoutError` if the deadline elapses first.
 *
 * @param promise        Long-running operation to race.
 * @param ms             Deadline in milliseconds.
 * @param timeoutError   Error thrown when the deadline elapses.
 */
export async function withTimeout<T>(
	promise: Promise<T>,
	ms: number,
	timeoutError: Error,
): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeoutPromise = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(timeoutError), ms);
		// Keep this awaited deadline ref'ed. Bun may never run an unref'ed timer
		// when it is the only handle capable of settling the pending operation.
	});
	try {
		return await Promise.race([promise, timeoutPromise]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

/**
 * Race a cancellable operation against a timeout while also supplying an
 * `AbortSignal` that is tripped when the deadline elapses.
 *
 * This is the shared helper for cross-platform request/LLM timeouts: callers
 * get a real abort signal for cooperative cancellation, but the outer race
 * still returns if the callee ignores that signal.
 */
export async function withTimeoutSignal<T>(
	operation: (signal: AbortSignal) => Promise<T>,
	ms: number,
	timeoutError: Error,
): Promise<T> {
	if (!Number.isFinite(ms) || ms < 0) {
		throw new RangeError('timeout must be a finite non-negative number');
	}
	// Preserve the caller's error identity while ensuring both the rejection and
	// AbortSignal.reason are mechanically recognizable across Node and Bun.
	if (timeoutError.name === 'Error') {
		try {
			timeoutError.name = 'TimeoutError';
		} catch {
			// Frozen errors are rare but valid; the abort reason below is still the
			// exact supplied object and the message remains available.
		}
	}
	const controller = new AbortController();
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeoutPromise = new Promise<never>((_, reject) => {
		timer = _internals.setTimeout(() => {
			controller.abort(timeoutError);
			reject(timeoutError);
		}, ms);
		// Keep this awaited deadline ref'ed. Bun may never run an unref'ed timer
		// when it is the only handle capable of settling the pending operation.
	});
	try {
		return await Promise.race([
			Promise.resolve().then(() => operation(controller.signal)),
			timeoutPromise,
		]);
	} finally {
		if (timer !== undefined) _internals.clearTimeout(timer);
	}
}

/** Dependency-injection seam for deterministic timer-cleanup tests. */
export const _internals = {
	setTimeout,
	clearTimeout,
};

/**
 * Yield to the macrotask queue. Works under both Node and Bun runtimes,
 * unlike `setImmediate` which is Node-only. The timer intentionally remains
 * ref'ed: callers await this promise, so unref'ing its only handle can strand a
 * direct async caller when no unrelated host handle is active. Detached startup
 * work is made non-pinning at its outer scheduling boundary instead.
 */
export function yieldToEventLoop(): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, 0);
	});
}
