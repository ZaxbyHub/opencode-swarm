/**
 * Timeout primitives used by the plugin init path.
 *
 * Hard rule: every timer scheduled here must call `unref()` so it never holds
 * the process open, and every Promise.race must clear the timer in `finally`
 * so it does not leak the timer reference after the racer settles.
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
export declare function withTimeout<T>(promise: Promise<T>, ms: number, timeoutError: Error): Promise<T>;
/**
 * Yield to the macrotask queue. Works under both Node and Bun runtimes,
 * unlike `setImmediate` which is Node-only.
 */
export declare function yieldToEventLoop(): Promise<void>;
