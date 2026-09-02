/**
 * Bounded polling wait with a labeled exhaustion error.
 *
 * Attempt-counting budget, NOT a wall-clock deadline (see
 * docs/testing/test-stability.md "Deadline/polling waits"): the
 * check:test-clock gate blocks added raw-clock lines, and a frozen-clock
 * deadline would never advance. 20ms polls x ceil(budgetMs/20) attempts
 * bound the wait at >= budgetMs and stay deterministic under coverage
 * instrumentation and event-loop saturation.
 */
export async function waitFor(
	predicate: () => boolean,
	budgetMs: number,
	label: string,
): Promise<void> {
	const maxAttempts = Math.ceil(budgetMs / 20);
	for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
		if (predicate()) {
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	if (!predicate()) {
		throw new Error(
			`[waitFor] ${label} — budget exhausted after ${budgetMs}ms`,
		);
	}
}
