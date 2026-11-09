/**
 * REGRESSION GUARD — issue #660 FR-004, finding F-09 (behavioral form).
 *
 * Pins the BOUNDED INTERNAL RETRY contract of `tryAcquireLock`
 * (src/parallel/file-locks.ts) — preserved verbatim by the #2967 wx
 * owner-payload substrate migration, which replaced the historical
 * proper-lockfile `retries` option with an equivalent in-process loop
 * (5 attempts, 10-500 ms backoff ≈ 310 ms worst case).
 *
 * Prior buggy behavior (what F-09 corrected): lock acquisition used
 * `retries: 0` — transient contention immediately surfaced as
 * `acquired: false`, forcing a manual LLM-driven retry of the whole tool
 * call. The contract, pinned here behaviorally rather than by intercepting
 * library options (the plain path no longer passes any):
 *
 *   1. Under SUSTAINED contention a single tryAcquireLock call absorbs the
 *      whole internal retry budget (measurably slower than one shot) and
 *      still returns bounded in time with `{ acquired: false }`.
 *   2. Under TRANSIENT contention (holder releases mid-call) the internal
 *      retries absorb it: ONE call returns `{ acquired: true }` with no
 *      caller-side retry.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tryAcquireLock } from '../../../src/parallel/file-locks.js';
import { canonicalMkdtemp, removeTreeWithRetry } from '../../helpers/tmpdir.js';

let tmpDir = '';

beforeEach(() => {
	tmpDir = canonicalMkdtemp('file-locks-retry-guard-');
});

afterEach(() => {
	if (tmpDir !== '') removeTreeWithRetry(tmpDir);
});

describe('file-locks — regression: tryAcquireLock bounded internal retries (F-09)', () => {
	test('sustained contention: one call spends the retry budget, bounded, then reports contention', async () => {
		// Live holder (same-process wx exclusion) for the whole call.
		const holder = await tryAcquireLock(tmpDir, 'target.ts', 'holder', 'h');
		expect(holder.acquired).toBe(true);
		if (!holder.acquired) return;

		const t0 = performance.now(); // elapsed bound idiom (check:test-clock)
		const result = await tryAcquireLock(tmpDir, 'target.ts', 'agent', 'task');
		const elapsed = performance.now() - t0;

		// Contention reported (never an unbounded wait or a steal).
		expect(result.acquired).toBe(false);
		// The internal bounded retry loop actually ran: a single failed
		// attempt returns in ~5 ms, while the four inter-attempt backoffs
		// (10+20+40+80 ms before the final attempt) push one sustained
		// call well past 100 ms — yet far inside the F-09 budget.
		expect(elapsed).toBeGreaterThan(100);
		expect(elapsed).toBeLessThan(4000);

		await holder.lock._release?.();
		// The contender left no residue behind.
		const locksDir = path.join(tmpDir, '.swarm', 'locks');
		expect(fs.readdirSync(locksDir)).toHaveLength(0);
	}, 10_000);

	test('transient contention: one call absorbs it internally and acquires', async () => {
		const holder = await tryAcquireLock(tmpDir, 'target.ts', 'holder', 'h');
		expect(holder.acquired).toBe(true);
		if (!holder.acquired) return;

		// Holder releases 60 ms in — between the 2nd and 3rd internal
		// attempts (10+20 ms) — so only the internal retry loop can see
		// the freed lock. No caller-side retry happens in this test.
		setTimeout(() => {
			void holder.lock._release?.();
		}, 60);

		const t0 = performance.now(); // elapsed bound idiom (check:test-clock)
		const result = await tryAcquireLock(tmpDir, 'target.ts', 'agent', 'task');
		const elapsed = performance.now() - t0;

		expect(result.acquired).toBe(true);
		// Fast absorption: bounded backoffs only, no busy spin.
		expect(elapsed).toBeLessThan(4000);
		if (result.acquired) await result.lock._release?.();
	}, 10_000);
});
