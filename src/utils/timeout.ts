/**
 * Timeout primitives used by the plugin init path.
 *
 * Deadline timers must call `unref()` and every Promise.race must clear its
 * timer in `finally`, so timeouts never pin or leak a process handle. Awaited
 * cooperative-yield timers are deliberately ref'ed: unref'ing the only handle
 * can strand their caller before the awaited promise resolves.
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
		// Never keep the process alive solely for this timer.
		if (typeof (timer as { unref?: () => void }).unref === 'function') {
			(timer as { unref: () => void }).unref();
		}
	});
	try {
		return await Promise.race([promise, timeoutPromise]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

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
