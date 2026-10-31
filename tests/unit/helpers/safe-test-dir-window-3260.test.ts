/**
 * Acceptance check C1 (issue #3260 section A / trace 3260-3252-teardown-hardening).
 *
 * The safeRmRecursive teardown window must provably cover the measured
 * handle-release tail that the production unlink schedule
 * (ACTIVE_STATE_UNLINK_RETRY_DELAYS_MS in src/commands/close/constants.ts,
 * summing 15,175 ms at base) was sized for. This check drives the retry loop
 * with a seam-stubbed permanently-held directory and sums the recorded wait
 * budget: RED at base (100 attempts x 100 ms = 9,900 ms recorded budget),
 * GREEN after the fix (the window covers >= the production schedule sum).
 */
import { afterEach, describe, expect, it } from 'bun:test';
import type * as fs from 'node:fs';
import { ACTIVE_STATE_UNLINK_RETRY_DELAYS_MS } from '../../../src/commands/close/constants.js';
import { _internals, safeRmRecursive } from '../../helpers/safe-test-dir.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const realRmSync = _internals.rmSync;
const realCollectGarbageBestEffort = _internals.collectGarbageBestEffort;
const realWait = _internals.wait;

afterEach(() => {
	// AGENTS.md invariant 7: restore every swapped _internals member.
	_internals.rmSync = realRmSync;
	_internals.collectGarbageBestEffort = realCollectGarbageBestEffort;
	_internals.wait = realWait;
});

describe('safeRmRecursive teardown window vs production schedule (3260-A)', () => {
	it('window covers the production unlink schedule tail (RED at base, GREEN after the fix)', () => {
		// The requirement is derived from the production schedule itself (RC-A:
		// the two literals were written in different PRs and nothing ties them).
		const requiredTailMs = ACTIVE_STATE_UNLINK_RETRY_DELAYS_MS.reduce(
			(total, delay) => total + delay,
			0,
		);
		expect(requiredTailMs).toBeGreaterThanOrEqual(15175);

		const dir = canonicalMkdtemp('safe-rm-window-3260-');
		const waits: number[] = [];
		_internals.rmSync = (() => {
			const error = new Error(
				'EBUSY: resource busy or locked, rm (probe-simulated permanent hold)',
			) as NodeJS.ErrnoException;
			error.code = 'EBUSY';
			throw error;
		}) as typeof fs.rmSync;
		_internals.collectGarbageBestEffort = () => {};
		// Record the budget instead of sleeping: the check measures the window's
		// shape, not its wall clock.
		_internals.wait = (ms: number) => {
			waits.push(ms);
		};

		try {
			expect(() => safeRmRecursive(dir)).toThrow(/EBUSY/);
			const totalWaitMs = waits.reduce((total, ms) => total + ms, 0);
			expect(
				totalWaitMs >= requiredTailMs,
				`window ${totalWaitMs} ms must cover the production schedule tail ${requiredTailMs} ms (waits=${waits.length})`,
			).toBe(true);
		} finally {
			_internals.rmSync = realRmSync;
			_internals.collectGarbageBestEffort = realCollectGarbageBestEffort;
			_internals.wait = realWait;
			safeRmRecursive(dir);
		}
	}, 30000);
});
