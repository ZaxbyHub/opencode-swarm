import { afterEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs';
import { findByCorrelationId } from '../../../src/background/pending-delegations';
import {
	_internals,
	_test_exports,
	executeCollectLaneResults,
} from '../../../src/tools/dispatch-lanes';
import { createCollectLaneTimeoutFixture } from './dispatch-lanes-collect-host-timeout.fixtures';

/**
 * Issue #2381 item 4: one bounded revision context per unique
 * (project root, PR head) per collection invocation.
 *
 * The snapshot is invocation-local, never a module-global cache, and never keyed
 * by `prHeadSha` alone. Failure to resolve it leaves affected lanes PENDING with
 * a typed diagnostic — it is never converted into a child failure.
 */

const {
	assistantMessage,
	baseOps,
	cleanupTempDirs,
	makeTempDir,
	recordPending,
	restoreInternals,
	// Real clock deliberately (see the wait:true scenarios below): these tests
	// exercise multi-poll deadline progression against the record's real
	// updatedAt, so the fixture's deterministic collection clock (issue #2572)
	// must stay off here.
} = createCollectLaneTimeoutFixture({ deterministicClock: false });

afterEach(async () => {
	restoreInternals();
	_test_exports.resetDeliveredLaneOutputs();
	await cleanupTempDirs();
});

function workspaceFor(directory: string, prHeadSha: string) {
	return {
		directory,
		gitHead: prHeadSha,
		dirtyHash: null,
		prHeadSha,
		scope: `complete PR diff base-1...${prHeadSha}`,
	};
}

describe('collection resolves one revision snapshot per root+head (#2381)', () => {
	test('physical root aliases share one live snapshot resolution', async () => {
		const directory = makeTempDir();
		const alias = `${directory}-snapshot-alias`;
		try {
			fs.symlinkSync(
				directory,
				alias,
				process.platform === 'win32' ? 'junction' : 'dir',
			);
			const batchId = 'snapshot-physical-alias';
			await recordPending({
				directory,
				batchId,
				laneId: 'lane-a',
				correlationId: `${batchId}-lane-a`,
				workspace: workspaceFor(directory, 'head-1'),
			});
			await recordPending({
				directory,
				batchId,
				laneId: 'lane-b',
				correlationId: `${batchId}-lane-b`,
				workspace: workspaceFor(alias, 'head-1'),
			});

			const digest = mock(async () => 'd'.repeat(64));
			_internals.resolvePrWorkflowRevisionDigestAsync = digest;
			const status = mock(async () => ({
				data: {
					[`${batchId}-lane-a`]: { type: 'idle' },
					[`${batchId}-lane-b`]: { type: 'idle' },
				},
				error: undefined,
			}));
			const messages = mock(async () => ({
				data: [assistantMessage('settled lane output')],
				error: undefined,
			}));
			_internals.getSessionOps = () => ({ ...baseOps(), status, messages });

			const result = await executeCollectLaneResults(
				{ batch_id: batchId, wait: true, include_pending: true },
				directory,
			);

			expect(result.completed).toBe(2);
			expect(digest).toHaveBeenCalledTimes(1);
		} finally {
			fs.rmSync(alias, { recursive: true, force: true });
		}
	});

	test('multiple lanes sharing a head resolve the digest exactly once', async () => {
		const directory = makeTempDir();
		const batchId = 'snapshot-shared-head';
		for (const lane of ['lane-a', 'lane-b', 'lane-c']) {
			await recordPending({
				directory,
				batchId,
				laneId: lane,
				correlationId: `${batchId}-${lane}`,
				workspace: workspaceFor(directory, 'head-1'),
			});
		}

		const digest = mock(async () => 'd'.repeat(64));
		_internals.resolvePrWorkflowRevisionDigestAsync = digest;
		const status = mock(async (args: unknown) => ({
			data: Object.fromEntries(
				['lane-a', 'lane-b', 'lane-c'].map((lane) => [
					`${batchId}-${lane}`,
					{ type: 'idle' },
				]),
			),
			error: undefined,
		}));
		const messages = mock(async () => ({
			data: [assistantMessage('settled lane output')],
			error: undefined,
		}));
		_internals.getSessionOps = () => ({ ...baseOps(), status, messages });

		const result = await executeCollectLaneResults(
			{ batch_id: batchId, wait: true, include_pending: true },
			directory,
		);

		expect(result.completed).toBe(3);
		// Three lanes, ONE host digest resolution.
		expect(digest).toHaveBeenCalledTimes(1);
		expect(digest.mock.calls[0]?.[1]).toBe('head-1');
	});

	test('lanes with DIFFERENT heads resolve one digest each', async () => {
		// Issue #2381 / critic NB-5: the issue phrases this case as "once per
		// root/generation", which is only equivalent to once-per-head under
		// per-batch SHA uniformity — and that is NOT enforced, since `batch_id` is
		// caller-supplied. Asserted per distinct (directory, prHeadSha) instead, so
		// this test would FAIL against a key that dropped `prHeadSha`.
		const directory = makeTempDir();
		const batchId = 'snapshot-split-head';
		await recordPending({
			directory,
			batchId,
			laneId: 'lane-a',
			correlationId: `${batchId}-lane-a`,
			workspace: workspaceFor(directory, 'head-1'),
		});
		await recordPending({
			directory,
			batchId,
			laneId: 'lane-b',
			correlationId: `${batchId}-lane-b`,
			workspace: workspaceFor(directory, 'head-2'),
		});

		const digest = mock(async (_dir: string, sha: string) => `${sha}-digest`);
		_internals.resolvePrWorkflowRevisionDigestAsync = digest;
		const status = mock(async () => ({
			data: {
				[`${batchId}-lane-a`]: { type: 'idle' },
				[`${batchId}-lane-b`]: { type: 'idle' },
			},
			error: undefined,
		}));
		const messages = mock(async () => ({
			data: [assistantMessage('settled lane output')],
			error: undefined,
		}));
		_internals.getSessionOps = () => ({ ...baseOps(), status, messages });

		const result = await executeCollectLaneResults(
			{ batch_id: batchId, wait: true, include_pending: true },
			directory,
		);

		expect(result.completed).toBe(2);
		expect(digest).toHaveBeenCalledTimes(2);
		expect(digest.mock.calls.map((call) => call[1]).sort()).toEqual([
			'head-1',
			'head-2',
		]);
	});

	test('a SUBSEQUENT collection invocation resolves a fresh digest', async () => {
		// Proves the snapshot is invocation-local, not a module-global cache: the
		// working tree is mutable, so a later collection must observe it again.
		const directory = makeTempDir();
		const batchId = 'snapshot-fresh-per-invocation';
		await recordPending({
			directory,
			batchId,
			laneId: 'lane-a',
			correlationId: `${batchId}-lane-a`,
			workspace: workspaceFor(directory, 'head-1'),
		});
		await recordPending({
			directory,
			batchId,
			laneId: 'lane-b',
			correlationId: `${batchId}-lane-b`,
			workspace: workspaceFor(directory, 'head-1'),
		});

		const digest = mock(async () => 'd'.repeat(64));
		_internals.resolvePrWorkflowRevisionDigestAsync = digest;
		// lane-b is explicitly BUSY on the first pass. An absent entry would be
		// treated as "unknown" and could still settle on terminal-assistant proof.
		let laneBReady = false;
		const status = mock(async () => ({
			data: {
				[`${batchId}-lane-a`]: { type: 'idle' },
				[`${batchId}-lane-b`]: { type: laneBReady ? 'idle' : 'busy' },
			},
			error: undefined,
		}));
		const messages = mock(async () => ({
			data: [assistantMessage('settled lane output')],
			error: undefined,
		}));
		_internals.getSessionOps = () => ({ ...baseOps(), status, messages });

		const first = await executeCollectLaneResults(
			{ batch_id: batchId, wait: false, include_pending: true },
			directory,
		);
		expect(first.completed).toBe(1);
		expect(digest).toHaveBeenCalledTimes(1);

		// Second invocation settles the remaining lane. A module-global cache would
		// reuse the first invocation's digest and leave this at 1.
		laneBReady = true;
		const second = await executeCollectLaneResults(
			{ batch_id: batchId, wait: false, include_pending: true },
			directory,
		);
		expect(second.completed).toBe(2);
		expect(digest).toHaveBeenCalledTimes(2);
	});
});

describe('revision snapshot failure leaves lanes pending with a diagnostic (#2381)', () => {
	test('a digest resolution error leaves the lane pending and reports it', async () => {
		const directory = makeTempDir();
		const batchId = 'snapshot-digest-error';
		await recordPending({
			directory,
			batchId,
			laneId: 'lane-a',
			correlationId: `${batchId}-lane-a`,
			workspace: workspaceFor(directory, 'head-1'),
		});
		const before = findByCorrelationId(directory, `${batchId}-lane-a`);

		_internals.resolvePrWorkflowRevisionDigestAsync = mock(async () => {
			throw new Error('git rev-parse exploded');
		});
		const status = mock(async () => ({
			data: { [`${batchId}-lane-a`]: { type: 'idle' } },
			error: undefined,
		}));
		const messages = mock(async () => ({
			data: [assistantMessage('output that cannot be safely correlated')],
			error: undefined,
		}));
		_internals.getSessionOps = () => ({ ...baseOps(), status, messages });

		const result = await executeCollectLaneResults(
			{ batch_id: batchId, wait: false, include_pending: true },
			directory,
		);

		// Pending, NOT failed — a snapshot failure is the observer's problem, never
		// the child's.
		expect(result.pending).toBe(1);
		expect(result.failed).toBe(0);
		expect(result.completed).toBe(0);
		expect(
			result.errors?.some((entry) =>
				entry.includes('revision snapshot unavailable for lane "lane-a"'),
			),
		).toBe(true);
		expect(result.pending_lanes?.[0]?.lane_id).toBe('lane-a');

		// The durable record is untouched.
		const after = findByCorrelationId(directory, `${batchId}-lane-a`);
		expect(after?.status).toBe('pending');
		expect(after?.status).toBe(before?.status);
		expect(after?.result).toEqual(before?.result);
	});

	test('a hung digest on one head does not block a lane bound to another head', async () => {
		// The previous version of this test was VACUOUS: it was named for budget
		// exhaustion but its digest mock resolved instantly, so no budget was ever
		// exhausted and it asserted the same thing as the happy-path case above.
		// This version actually starves one head and proves the other still settles.
		const directory = makeTempDir();
		const batchId = 'snapshot-starvation-isolation';
		await recordPending({
			directory,
			batchId,
			laneId: 'lane-hung',
			correlationId: `${batchId}-lane-hung`,
			workspace: workspaceFor(directory, 'head-hung'),
		});
		await recordPending({
			directory,
			batchId,
			laneId: 'lane-fast',
			correlationId: `${batchId}-lane-fast`,
			workspace: workspaceFor(directory, 'head-fast'),
		});

		let releaseHung: ((digest: string) => void) | undefined;
		const digest = mock(async (_dir: string, sha: string) => {
			if (sha === 'head-hung') {
				return new Promise<string>((resolve) => {
					releaseHung = resolve;
				});
			}
			return 'f'.repeat(64);
		});
		_internals.resolvePrWorkflowRevisionDigestAsync = digest;
		const status = mock(async () => ({
			data: {
				[`${batchId}-lane-hung`]: { type: 'idle' },
				[`${batchId}-lane-fast`]: { type: 'idle' },
			},
			error: undefined,
		}));
		const messages = mock(async () => ({
			data: [assistantMessage('settled lane output')],
			error: undefined,
		}));
		_internals.getSessionOps = () => ({ ...baseOps(), status, messages });

		const result = await executeCollectLaneResults(
			{ batch_id: batchId, wait: false, timeout_ms: 50, include_pending: true },
			directory,
		);

		// The starved head does not take the healthy one down with it, and the
		// collection still RETURNS rather than hanging on the wedged promise.
		expect(
			result.lane_results.find((lane) => lane.id === 'lane-fast')?.status,
		).toBe('completed');
		expect(
			result.lane_results.find((lane) => lane.id === 'lane-hung')?.status,
		).toBe('pending');
		expect(result.pending).toBe(1);
		expect(result.failed).toBe(0);
		expect(result.errors?.some((entry) => entry.includes('lane-hung'))).toBe(
			true,
		);

		releaseHung?.('late');
	});

	test('a REJECTED snapshot is retried on a later poll WITHIN one wait:true invocation', async () => {
		// Regression for the reviewer-found defect. The snapshot map is
		// invocation-scoped so `wait: true` does not re-resolve the digest on every
		// poll — but caching a REJECTION there made one transient git failure
		// terminal for the WHOLE invocation: every later poll re-awaited the same
		// rejected promise and the lane stayed pending until the caller's budget ran
		// out. This must therefore exercise multiple polls of a SINGLE call; two
		// separate invocations would pass even with the bug present, since each
		// invocation builds a fresh map.
		const directory = makeTempDir();
		const batchId = 'snapshot-rejection-retry';
		await recordPending({
			directory,
			batchId,
			laneId: 'lane-a',
			correlationId: `${batchId}-lane-a`,
			workspace: workspaceFor(directory, 'head-1'),
		});

		let calls = 0;
		const digest = mock(async () => {
			calls += 1;
			if (calls === 1) throw new Error('transient git failure');
			return 'a'.repeat(64);
		});
		_internals.resolvePrWorkflowRevisionDigestAsync = digest;

		// Real clock and real (short) sleeps deliberately: a mocked clock far from
		// the record's real `updatedAt` would trip the stale sweep and mask what is
		// being tested. The poll interval is 500ms, so a ~2s budget yields several
		// polls.
		const status = mock(async () => ({
			data: { [`${batchId}-lane-a`]: { type: 'idle' } },
			error: undefined,
		}));
		const messages = mock(async () => ({
			data: [assistantMessage('settled lane output')],
			error: undefined,
		}));
		_internals.getSessionOps = () => ({ ...baseOps(), status, messages });

		const result = await executeCollectLaneResults(
			{
				batch_id: batchId,
				wait: true,
				timeout_ms: 2_000,
				include_pending: true,
			},
			directory,
		);

		// Poll 1's digest rejected; poll 2 resolves a fresh one and the lane settles
		// inside the same call. With the rejection cached, this would be
		// completed: 0 / pending: 1 with exactly one digest call.
		expect(result.completed).toBe(1);
		expect(result.pending).toBe(0);
		expect(calls).toBe(2);
		// The poll-1 failure diagnostic must NOT survive onto a collection that
		// actually completed. The two producers key this set differently (a bare
		// lane label from `collectOnce`, a full sentence from `settleCollectedLane`),
		// so an exact-match delete cleared only one shape and left the other to be
		// reported alongside `success: true`.
		expect(result.success).toBe(true);
		expect(
			result.errors?.some((entry) => entry.includes('lane left pending')),
		).toBeFalsy();
	});
});
