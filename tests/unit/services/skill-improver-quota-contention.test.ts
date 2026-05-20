/**
 * F-003: Lockfile-acquisition contention tests for the skill_improver quota.
 *
 * The quota helpers wrap proper-lockfile in an overall acquisition timeout
 * (LOCK_ACQUIRE_TIMEOUT_MS, default 10 s). Without that ceiling a stuck
 * lock holder past the `stale` window combined with many concurrent
 * waiters can leave callers indefinitely awaiting.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import lockfile from 'proper-lockfile';
import { reserveQuota } from '../../../src/services/skill-improver-quota';

let tmp: string;

beforeEach(async () => {
	tmp = await mkdtemp(path.join(tmpdir(), 'skill-improver-quota-contend-'));
	await mkdir(path.join(tmp, '.swarm'), { recursive: true });
});

afterEach(async () => {
	await rm(tmp, { recursive: true, force: true });
});

describe('reserveQuota — concurrent contention', () => {
	it('serialises 8 concurrent reservations correctly under the cap', async () => {
		const N = 8;
		const results = await Promise.all(
			Array.from({ length: N }, () =>
				reserveQuota(tmp, {
					nCalls: 1,
					maxCalls: N,
					window: 'utc',
				}),
			),
		);
		const allowed = results.filter((r) => r.allowed).length;
		expect(allowed).toBe(N);
		// The final state should reflect every reservation (no lost updates)
		const final = results
			.map((r) => r.state.calls_used)
			.reduce((a, b) => Math.max(a, b), 0);
		expect(final).toBe(N);
	});

	it('rejects beyond max under contention with no lost updates', async () => {
		const N = 12;
		const MAX = 5;
		const results = await Promise.all(
			Array.from({ length: N }, () =>
				reserveQuota(tmp, {
					nCalls: 1,
					maxCalls: MAX,
					window: 'utc',
				}),
			),
		);
		const allowed = results.filter((r) => r.allowed).length;
		expect(allowed).toBe(MAX);
		const denied = results.filter((r) => !r.allowed).length;
		expect(denied).toBe(N - MAX);
	});
});

describe('reserveQuota — stuck-holder timeout', () => {
	it('eventually acquires once a stuck holder releases (within the retry budget)', async () => {
		const dir = path.join(tmp, '.swarm');
		const release = await lockfile.lock(dir, {
			stale: 60_000,
			realpath: true,
		});
		// Start the reserve while the lock is held; release after 600ms,
		// well inside the retry budget.
		const reservePromise = reserveQuota(tmp, {
			nCalls: 1,
			maxCalls: 5,
			window: 'utc',
		});
		setTimeout(() => {
			release().catch(() => {
				/* ignore */
			});
		}, 600);
		const r = await reservePromise;
		expect(r.allowed).toBe(true);
		expect(r.state.calls_used).toBe(1);
	}, 10_000);

	it('actually serialises 6 reservers waiting on a held lock (stress test)', async () => {
		const dir = path.join(tmp, '.swarm');
		// Hold the lock so all reservers must wait
		const release = await lockfile.lock(dir, {
			stale: 60_000,
			realpath: true,
		});
		const N = 6;
		const reservers = Array.from({ length: N }, () =>
			reserveQuota(tmp, { nCalls: 1, maxCalls: N, window: 'utc' }),
		);
		// Give them a moment to start contending, then release the holder
		await new Promise((r) => setTimeout(r, 200));
		await release();
		const results = await Promise.all(reservers);
		const allowed = results.filter((r) => r.allowed).length;
		expect(allowed).toBe(N);
		// No lost updates — the maximum calls_used across all observed states
		// equals the number of allowed reservations.
		const finalUsed = results
			.map((r) => r.state.calls_used)
			.reduce((a, b) => Math.max(a, b), 0);
		expect(finalUsed).toBe(N);
	}, 15_000);
});
