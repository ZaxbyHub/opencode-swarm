/**
 * Regression test: PrMonitorWorker's poll timer must not hold the Bun/Node
 * event loop open.
 *
 * Split out of pr-monitor-worker.test.ts (already over the FR-006 500-line
 * cap — the ratchet in scripts/check-test-file-cap.sh blocks growth of that
 * file) rather than appended there.
 */
import { describe, expect, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import * as os from 'node:os';
import * as path from 'node:path';
import { PrMonitorWorker } from '../../../src/background/pr-monitor-worker';

function makeConfig(): Record<string, unknown> {
	return {
		enabled: true,
		// Long interval — this test asserts on the setInterval call itself,
		// never lets the poll callback fire.
		poll_interval_seconds: 100_000,
		max_subscriptions: 20,
		max_prs_per_cycle: 5,
		max_concurrent_pr_polls: 3,
		poll_timeout_ms: 30_000,
		failure_threshold: 5,
		cooldown_seconds: 30,
		max_cooldown_seconds: 300,
		cleanup_ttl_days: 7,
		auto_unsubscribe_on_merge: true,
		auto_unsubscribe_on_close: true,
		notify_ci_failure: true,
		notify_new_comments: true,
		notify_merge_conflict: true,
	};
}

describe('PrMonitorWorker poll timer — regression: unref (issue: event-loop leak)', () => {
	test('start() calls unref() on the interval timer so it cannot pin the event loop open', () => {
		// Previous code did `this.pollTimer = setInterval(...)` and never called
		// `.unref()` on the returned timer. A live, ref'd interval keeps the
		// Node/Bun event loop from draining naturally, so `process.on('exit', ...)`
		// cleanup never fires under normal (non-process.exit) shutdown — self-
		// defeating even though `cleanupAutomation` already calls
		// `prMonitorWorker?.stop()`.
		// Clock-free unique name. A wall-clock timestamp would be a uniqueness
		// source here, not a time-dependent assertion, so wrapping it in
		// `freezeClock` would be wrong — a frozen clock makes "unique" names
		// collide. `randomUUID` gives uniqueness without reading the clock at all,
		// which also keeps scripts/check-test-clock.sh satisfied.
		const directory = path.join(
			os.tmpdir(),
			`pr-monitor-unref-${randomUUID()}`,
		);
		const worker = new PrMonitorWorker({
			directory,
			config: makeConfig() as ConstructorParameters<
				typeof PrMonitorWorker
			>[0]['config'],
		});

		const realSetInterval = globalThis.setInterval;
		let capturedTimer: { unref?: () => unknown } | undefined;
		let unrefCallCount = 0;
		const setIntervalSpy = spyOn(globalThis, 'setInterval').mockImplementation(
			((fn: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
				const timer = realSetInterval(fn, ms, ...args) as unknown as {
					unref?: () => unknown;
				};
				const originalUnref = timer.unref?.bind(timer);
				timer.unref = (...unrefArgs: unknown[]) => {
					unrefCallCount++;
					return originalUnref?.(...unrefArgs);
				};
				capturedTimer = timer;
				return timer;
			}) as typeof globalThis.setInterval,
		);

		try {
			worker.start();

			expect(capturedTimer).toBeDefined();
			expect(unrefCallCount).toBe(1);
		} finally {
			worker.stop();
			setIntervalSpy.mockRestore();
		}
	});
});
