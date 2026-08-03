/**
 * Regression tests: PlanSyncWorker's poll timer must not hold the Bun/Node
 * event loop open.
 *
 * Split out of plan-sync-worker.test.ts (already over the FR-006 500-line
 * cap — the ratchet in scripts/check-test-file-cap.sh blocks growth of that
 * file) rather than appended there.
 *
 * Deliberately does NOT touch fs.watch or wait on any watcher event — those
 * are the timing-sensitive paths that force plan-sync-worker.test.ts to
 * skip on non-Linux platforms. This file only asserts on the synchronous
 * setInterval call inside start(), so it runs on every platform.
 */
import { describe, expect, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { PlanSyncWorker } from '../../../src/background/plan-sync-worker';

describe('PlanSyncWorker poll timer — regression: unref (issue: event-loop leak)', () => {
	test('setupPolling() calls unref() on the interval timer so it cannot pin the event loop open', () => {
		// Previous code did `this.pollTimer = setInterval(...)` and never called
		// `.unref()` on the returned timer. A live, ref'd interval keeps the
		// Node/Bun event loop from draining naturally, so `process.on('exit', ...)`
		// cleanup never fires under normal (non-process.exit) shutdown.
		// Clock-free unique name. A wall-clock timestamp would be a uniqueness
		// source here, not a time-dependent assertion, so wrapping it in
		// `freezeClock` would be wrong — a frozen clock makes "unique" names
		// collide. `randomUUID` gives uniqueness without reading the clock at all,
		// which also keeps scripts/check-test-clock.sh satisfied.
		const directory = path.join(tmpdir(), `plan-sync-unref-${randomUUID()}`);
		const worker = new PlanSyncWorker({
			directory,
			// Long interval — this test asserts on the setInterval call itself,
			// never lets the callback fire.
			pollIntervalMs: 1_000_000,
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
