/**
 * True only for genuine cancellation errors (a native `AbortError` /
 * `TimeoutError` raised when a forwarded `AbortSignal` fires). Used to map
 * cancellation — and only cancellation — onto timeout sentinels, so a real
 * failure that merely coincides with an aborted signal still surfaces as
 * itself rather than being misclassified as a timeout.
 */
export function isAbortError(err: unknown): boolean {
	if (typeof err !== 'object' || err === null) return false;
	const name = (err as { name?: unknown }).name;
	return name === 'AbortError' || name === 'TimeoutError';
}
