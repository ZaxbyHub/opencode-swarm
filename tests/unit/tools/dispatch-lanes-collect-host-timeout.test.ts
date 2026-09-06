import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import {
	_internals,
	_test_exports,
	executeCollectLaneResults,
} from '../../../src/tools/dispatch-lanes';
import { createCollectLaneTimeoutFixture } from './dispatch-lanes-collect-host-timeout.fixtures';

const {
	assistantMessage,
	baseOps,
	cleanupTempDirs,
	makeTempDir,
	pinCollectionClock,
	recordPending,
	restoreInternals,
	withTestDeadline,
} = createCollectLaneTimeoutFixture();

// Issue #2572: restoreInternals() (afterEach) puts the real clock back, so
// re-pin per test (the 8-lane test overrides _internals.now itself).
beforeEach(() => {
	pinCollectionClock();
});

afterEach(async () => {
	restoreInternals();
	await cleanupTempDirs();
});

describe('collect_lane_results host-call deadline', () => {
	test('bounds a hung session.status call by the remaining collection budget', async () => {
		const directory = makeTempDir();
		const batchId = 'hung-status';
		await recordPending({ directory, batchId });
		const status = mock(() => new Promise<never>(() => {}));
		const messages = mock(async () => ({ data: null }));
		_internals.getSessionOps = () => ({ ...baseOps(), status, messages });

		// Prior bug: one unresolved host status promise bypassed the outer poll
		// deadline because the deadline was checked only between iterations.
		const result = await withTestDeadline(
			executeCollectLaneResults(
				{
					batch_id: batchId,
					wait: false,
					include_pending: true,
					// Leave enough wall-clock room for both reserved host-call slices on
					// coarse Windows timers; the test still proves the hung call is bounded.
					timeout_ms: 90,
				},
				directory,
			),
		);

		expect(result.pending).toBe(1);
		expect(result.message).toContain('Collection deadline exhausted');
		expect(result.errors?.join('; ')).toContain('session.status');
		expect(status).toHaveBeenCalledTimes(1);
		expect(messages).toHaveBeenCalledTimes(1);
	});

	test('salvages transcript output when session.status times out', async () => {
		const directory = makeTempDir();
		const batchId = 'hung-status-salvage';
		await recordPending({ directory, batchId });
		const status = mock(() => new Promise<never>(() => {}));
		const messages = mock(async () => ({
			data: [assistantMessage('durable lane evidence')],
		}));
		_internals.getSessionOps = () => ({ ...baseOps(), status, messages });

		// Issue #2258 Mode 3: status is an optimization signal, not the only
		// evidence source. A bounded status failure must leave time to snapshot the
		// transcript and publish an output_ref when messages are already readable.
		const result = await withTestDeadline(
			executeCollectLaneResults(
				{
					batch_id: batchId,
					wait: false,
					include_pending: true,
					timeout_ms: 90,
				},
				directory,
			),
		);

		expect(status).toHaveBeenCalledTimes(1);
		expect(messages).toHaveBeenCalledTimes(1);
		expect(result.success).toBe(true);
		expect(result.completed).toBe(1);
		expect(result.pending).toBe(0);
		expect(result.message).toBe(
			'Collection recovered and settled all lanes despite bounded OpenCode host-call timeouts; no collection retry is required.',
		);
		expect(result.errors?.join('; ')).toContain('session.status');
		expect(result.lane_results[0]?.output_ref).toMatch(/^L1:/);
		expect(result.lane_results[0]?.output).toContain('durable lane evidence');
	});

	test('stays salvage-complete when the event loop stalls before the first host call', async () => {
		const directory = makeTempDir();
		const batchId = 'stall-before-first-host-call';
		await recordPending({ directory, batchId });
		const status = mock(() => new Promise<never>(() => {}));
		const messages = mock(async () => ({
			data: [assistantMessage('durable lane evidence through a stall')],
		}));
		let stallCount = 0;
		// Issue #2572 regression guard: a runner stall >= timeout_ms between the
		// deadline assignment and the first budget reservation used to zero every
		// slice and flip this outcome to pending. The fixture pins the collection
		// clock, so a true synchronous stall (Atomics.wait; no raw clock usage)
		// cannot consume the budget; reverting the fixture's pin turns this red.
		_internals.getSessionOps = () => {
			if (stallCount++ === 0) {
				Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 120);
			}
			return { ...baseOps(), status, messages };
		};

		const result = await withTestDeadline(
			executeCollectLaneResults(
				{
					batch_id: batchId,
					wait: false,
					include_pending: true,
					timeout_ms: 90,
				},
				directory,
			),
		);

		expect(status).toHaveBeenCalledTimes(1);
		expect(messages).toHaveBeenCalledTimes(1);
		expect(result.success).toBe(true);
		expect(result.completed).toBe(1);
		expect(result.pending).toBe(0);
		expect(result.message).toBe(
			'Collection recovered and settled all lanes despite bounded OpenCode host-call timeouts; no collection retry is required.',
		);
		expect(result.lane_results[0]?.output).toContain(
			'durable lane evidence through a stall',
		);
	});

	test('treats an absent session.status as unknown but still accepts terminal assistant proof', async () => {
		const directory = makeTempDir();
		const batchId = 'missing-status-terminal-proof';
		await recordPending({ directory, batchId });
		const messages = mock(async () => ({
			data: [assistantMessage('durable lane evidence without status API')],
		}));
		_internals.getSessionOps = () => ({ ...baseOps(), messages });

		const result = await withTestDeadline(
			executeCollectLaneResults(
				{
					batch_id: batchId,
					wait: false,
					include_pending: true,
					timeout_ms: 90,
				},
				directory,
			),
		);

		expect(messages).toHaveBeenCalledTimes(1);
		expect(result.completed).toBe(1);
		expect(result.pending).toBe(0);
		expect(result.lane_results[0]?.output_ref).toMatch(/^L1:/);
	});

	test('keeps readable unterminated output pending when session.status is absent', async () => {
		const directory = makeTempDir();
		const batchId = 'missing-status-nonterminal';
		await recordPending({ directory, batchId });
		const messages = mock(async () => ({
			data: [
				assistantMessage('mid-run snapshot without status API', {
					time: undefined,
					finish: 'tool-calls',
				}),
			],
		}));
		_internals.getSessionOps = () => ({ ...baseOps(), messages });

		const result = await withTestDeadline(
			executeCollectLaneResults(
				{
					batch_id: batchId,
					wait: false,
					include_pending: true,
					timeout_ms: 90,
				},
				directory,
			),
		);

		expect(result.completed).toBe(0);
		expect(result.failed).toBe(0);
		expect(result.pending).toBe(1);
		expect(result.lane_results[0]?.status).toBe('pending');
	});

	test('settles terminal PR-review contract violations when session.status is absent', async () => {
		const directory = makeTempDir();
		const batchId = 'missing-status-invalid-pr-review';
		await recordPending({
			directory,
			batchId,
			mode: 'swarm-pr-review:base',
			workflowLane: 'correctness-state',
			workspace: {
				directory,
				gitHead: 'head-1',
				dirtyHash: null,
				prHeadSha: 'head-1',
				scope: 'complete PR diff base-1...head-1',
			},
		});
		_internals.resolvePrWorkflowRevisionDigestAsync = async () => 'revision-1';
		const messages = mock(async () => ({
			data: [assistantMessage('plain prose with no review contract rows')],
		}));
		_internals.getSessionOps = () => ({ ...baseOps(), messages });

		const result = await withTestDeadline(
			executeCollectLaneResults(
				{
					batch_id: batchId,
					wait: false,
					include_pending: true,
					timeout_ms: 90,
				},
				directory,
			),
		);

		expect(result.completed).toBe(0);
		expect(result.failed).toBe(1);
		expect(result.pending).toBe(0);
		expect(result.lane_results[0]?.status).toBe('failed');
		expect(result.lane_results[0]?.error).toContain(
			'PR_REVIEW_DISCOVERY_CONTRACT_INVALID',
		);
	});

	test.each([
		'tool-calls',
		'unknown',
	])('keeps readable nonterminal output pending when status is unknown (%s)', async (finish) => {
		const directory = makeTempDir();
		const batchId = 'hung-status-nonterminal';
		await recordPending({ directory, batchId });
		const status = mock(() => new Promise<never>(() => {}));
		const messages = mock(async () => ({
			data: [
				assistantMessage('mid-run snapshot', {
					time: undefined,
					finish,
				}),
			],
		}));
		_internals.getSessionOps = () => ({ ...baseOps(), status, messages });

		const result = await withTestDeadline(
			executeCollectLaneResults(
				{
					batch_id: batchId,
					wait: false,
					include_pending: true,
					timeout_ms: 90,
				},
				directory,
			),
		);

		expect(result.completed).toBe(0);
		expect(result.failed).toBe(0);
		expect(result.pending).toBe(1);
		expect(result.lane_results[0]?.status).toBe('pending');
	});

	test('settles terminal PR-review contract violations when status times out', async () => {
		const directory = makeTempDir();
		const batchId = 'hung-status-invalid-pr-review';
		await recordPending({
			directory,
			batchId,
			mode: 'swarm-pr-review:base',
			workflowLane: 'correctness-state',
			workspace: {
				directory,
				gitHead: 'head-1',
				dirtyHash: null,
				prHeadSha: 'head-1',
				scope: 'complete PR diff base-1...head-1',
			},
		});
		_internals.resolvePrWorkflowRevisionDigestAsync = async () => 'revision-1';
		const status = mock(() => new Promise<never>(() => {}));
		const messages = mock(async () => ({
			data: [assistantMessage('plain prose with no review contract rows')],
		}));
		_internals.getSessionOps = () => ({ ...baseOps(), status, messages });

		const result = await withTestDeadline(
			executeCollectLaneResults(
				{
					batch_id: batchId,
					wait: false,
					include_pending: true,
					timeout_ms: 90,
				},
				directory,
			),
		);

		expect(result.completed).toBe(0);
		expect(result.failed).toBe(1);
		expect(result.pending).toBe(0);
		expect(result.lane_results[0]?.status).toBe('failed');
		expect(result.lane_results[0]?.error).toContain(
			'PR_REVIEW_DISCOVERY_CONTRACT_INVALID',
		);
	});

	test('continues collecting later lanes after an earlier status timeout', async () => {
		const directory = makeTempDir();
		const batchId = 'hung-status-fair-share';
		await recordPending({
			directory,
			batchId,
			laneId: 'lane-a',
			correlationId: 'lane-a-session',
		});
		await recordPending({
			directory,
			batchId,
			laneId: 'lane-b',
			correlationId: 'lane-b-session',
		});
		const status = mock(() => new Promise<never>(() => {}));
		const messages = mock(async ({ path }) => ({
			data:
				path.id === 'lane-b-session'
					? [assistantMessage('later lane settled output')]
					: null,
		}));
		_internals.getSessionOps = () => ({ ...baseOps(), status, messages });

		const result = await withTestDeadline(
			executeCollectLaneResults(
				{
					batch_id: batchId,
					wait: false,
					include_pending: true,
					timeout_ms: 90,
				},
				directory,
			),
		);

		expect(status).toHaveBeenCalledTimes(2);
		expect(messages).toHaveBeenCalledTimes(2);
		expect(result.completed).toBe(1);
		expect(result.pending).toBe(1);
		expect(
			result.lane_results.find((lane) => lane.id === 'lane-b')?.status,
		).toBe('completed');
		expect(
			result.lane_results.find((lane) => lane.id === 'lane-a')?.status,
		).toBe('pending');
	});

	test('gives every lane one bounded collection opportunity under an 8-lane 25ms budget', async () => {
		const directory = makeTempDir();
		const batchId = 'tiny-fair-share';
		const laneCount = 8;
		let now = 0;
		let statusCalls = 0;
		let messageCalls = 0;
		const seenMessages: string[] = [];

		for (let index = 1; index <= laneCount; index++) {
			await recordPending({
				directory,
				batchId,
				laneId: `lane-${index}`,
				correlationId: `lane-${index}-session`,
			});
		}

		_internals.now = () => now;
		const status = mock(async () => {
			const remainingLaneCount = laneCount - statusCalls;
			const budgets = _test_exports.reserveCollectionLaneCallBudgets(
				25,
				remainingLaneCount,
				true,
			);
			now += budgets.statusBudgetMs;
			statusCalls++;
			return { data: null, error: undefined };
		});
		const messages = mock(async ({ path }) => {
			const remainingLaneCount = laneCount - messageCalls;
			const budgets = _test_exports.reserveCollectionLaneCallBudgets(
				25,
				remainingLaneCount,
				true,
			);
			now += budgets.messagesBudgetMs;
			messageCalls++;
			seenMessages.push(path.id);
			return { data: null, error: undefined };
		});
		_internals.getSessionOps = () => ({ ...baseOps(), status, messages });

		const result = await executeCollectLaneResults(
			{
				batch_id: batchId,
				wait: false,
				include_pending: true,
				timeout_ms: 25,
			},
			directory,
		);

		expect(status).toHaveBeenCalledTimes(8);
		expect(messages).toHaveBeenCalledTimes(8);
		expect(seenMessages).toEqual(
			Array.from(
				{ length: laneCount },
				(_unused, index) => `lane-${index + 1}-session`,
			),
		);
		expect(result.pending).toBe(8);
		expect(result.completed).toBe(0);
		expect(now).toBeLessThanOrEqual(25);
	});

	test('bounds a hung session.messages call by the remaining collection budget', async () => {
		const directory = makeTempDir();
		const batchId = 'hung-messages';
		await recordPending({ directory, batchId });
		const messages = mock(() => new Promise<never>(() => {}));
		_internals.getSessionOps = () => ({ ...baseOps(), messages });

		// Prior bug: a ready lane could hang collection forever inside the
		// transcript fetch even when collect_lane_results had a finite timeout.
		const result = await withTestDeadline(
			executeCollectLaneResults(
				{
					batch_id: batchId,
					wait: false,
					include_pending: true,
					timeout_ms: 25,
				},
				directory,
			),
		);

		expect(result.pending).toBe(1);
		expect(result.message).toContain('Collection deadline exhausted');
		expect(result.errors?.join('; ')).toContain('session.messages');
		expect(messages).toHaveBeenCalledTimes(1);
	});

	test('bounds a hung session.abort call without claiming cancellation', async () => {
		const directory = makeTempDir();
		const batchId = 'hung-abort';
		await recordPending({ directory, batchId });
		const abort = mock(() => new Promise<never>(() => {}));
		_internals.getSessionOps = () => ({
			...baseOps(),
			abort,
			messages: mock(async () => ({ data: null })),
		});

		const result = await withTestDeadline(
			executeCollectLaneResults(
				{
					batch_id: batchId,
					cancel_pending: true,
					include_pending: true,
					timeout_ms: 25,
				},
				directory,
			),
		);
		expect(result.cancelled).toBe(0);
		expect(result.pending).toBe(1);
		expect(result.message).toContain('Collection deadline exhausted');
		expect(result.errors?.join('; ')).toContain('session.abort');
		expect(abort).toHaveBeenCalledTimes(1);
	});
});
