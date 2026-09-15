import { acquirePrFeedbackBackgroundLease } from './pr-feedback-background-lease';

/**
 * Serialize tests that mutate process-wide PR feedback queue internals.
 * The queue seam and in-memory cache are shared across Bun test files, so a
 * per-file snapshot/restore is not enough while a sibling test is awaiting.
 * This intentionally aliases the subscriber/delivery/runtime lease, giving
 * all PR-feedback process-global seams one mutex. Tests that also lease the
 * environment and loop seams acquire in this order: env, loop, then this
 * shared lease; release in reverse order.
 */
export async function acquirePrFeedbackQueueLease(): Promise<() => void> {
	return acquirePrFeedbackBackgroundLease();
}

export async function withPrFeedbackQueueLease<T>(
	work: () => T | Promise<T>,
): Promise<T> {
	const release = await acquirePrFeedbackQueueLease();
	try {
		return await work();
	} finally {
		release();
	}
}
