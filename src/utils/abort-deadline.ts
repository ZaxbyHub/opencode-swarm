/**
 * Cross-platform abort deadline utilities (issue #2103 workstream I, closes #1964).
 *
 * Bun on Windows has a native bug where `AbortSignal.timeout(...)`'s abort
 * event never fires when awaited by a plain JS Promise (oven-sh/bun#29546).
 * All runtime timeout signals must therefore route through a manually armed
 * `AbortController` plus `setTimeout`, with the timer cleared in `finally`.
 * `src/learning/admission.ts` demonstrated the pattern locally; this module
 * is the shared version. Do NOT reintroduce `AbortSignal.timeout(` at runtime
 * call sites — enforced by tests/unit/utils/abort-deadline.test.ts (source +
 * built-bundle scan).
 */

export interface AbortDeadline {
	/** Signal that aborts with a `TimeoutError` reason when the deadline fires. */
	signal: AbortSignal;
	/** Idempotently disarm the deadline timer. Always call in `finally`. */
	clear: () => void;
}

/**
 * Arm a manual abort deadline. The timer is `unref()`d so it cannot pin the
 * process open, and aborts with a `DOMException` named `TimeoutError` so the
 * reason stays recognizable upstream.
 */
export function abortDeadline(ms: number): AbortDeadline {
	const controller = new AbortController();
	const timer = setTimeout(() => {
		controller.abort(
			new DOMException('The operation timed out.', 'TimeoutError'),
		);
	}, ms);
	// Deliberately NOT unref'd: an unref'd timer can starve forever when it is
	// the only pending handle (observed under bun test — the #1964 hang class
	// in miniature). Every caller clears the timer via `clear()`/`finally`, so
	// it is short-lived and cannot pin the process.
	let cleared = false;
	return {
		signal: controller.signal,
		clear: () => {
			if (cleared) return;
			cleared = true;
			clearTimeout(timer);
		},
	};
}

/**
 * Run `fn(signal)` under an abort deadline. The controller is aborted and the
 * timer ALWAYS cleared — on success, on error, and on timeout — so it can
 * never leak. The caller returns at the deadline even if the delegate ignores
 * the signal: the operation is raced against the deadline, and the losing
 * delegate's rejection is swallowed.
 */
export async function withAbortDeadline<T>(
	ms: number,
	fn: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
	const controller = new AbortController();
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeoutError = new DOMException(
		'The operation timed out.',
		'TimeoutError',
	);
	const timeoutPromise = new Promise<never>((_, reject) => {
		timer = setTimeout(() => {
			controller.abort(timeoutError);
			reject(timeoutError);
		}, ms);
	});
	try {
		return await Promise.race([
			fn(controller.signal).catch((error) => {
				// If the deadline already fired, the timeout rejection wins.
				if (controller.signal.aborted) return timeoutPromise as Promise<T>;
				throw error;
			}),
			timeoutPromise,
		]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

/** Test seam (AGENTS.md invariant 7 — DI over `mock.module`). */
export const _internals = {
	abortDeadline,
	withAbortDeadline,
};
