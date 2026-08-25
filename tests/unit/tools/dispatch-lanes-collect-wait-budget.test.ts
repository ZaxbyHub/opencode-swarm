import { afterEach, expect, mock, test } from 'bun:test';
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
	recordPending,
	restoreInternals,
	withTestDeadline,
} = createCollectLaneTimeoutFixture();

afterEach(async () => {
	restoreInternals();
	_test_exports.resetDeliveredLaneOutputs();
	await cleanupTempDirs();
});

test('wait=true timeout_ms=0 terminates an expired PR-review lane without spending host calls', async () => {
	const directory = makeTempDir();
	const batchId = 'wait-zero-budget';
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
	const status = mock(async () => ({
		data: { [`${batchId}-session`]: { type: 'idle' } },
		error: undefined,
	}));
	const messages = mock(async () => ({
		data: [assistantMessage('terminal output that must not be harvested')],
		error: undefined,
	}));
	_internals.getSessionOps = () => ({ ...baseOps(), status, messages });

	const result = await executeCollectLaneResults(
		{ batch_id: batchId, wait: true, timeout_ms: 0, include_pending: true },
		directory,
	);

	// Prior behavior left the lane wedged pending and surfaced only a collector
	// timeout diagnostic. The runtime deadline fix should synthesize a terminal
	// PR-review error even when no host-call budget remains.
	expect(result.success).toBe(false);
	expect(result.completed).toBe(0);
	expect(result.failed).toBe(1);
	expect(result.pending).toBe(0);
	expect(result.lane_results[0]?.status).toBe('failed');
	expect(result.lane_results[0]?.error).toContain('runtime deadline');
	expect(result.message).toBeUndefined();
	expect(result.errors).toBeUndefined();
	expect(status).not.toHaveBeenCalled();
	expect(messages).not.toHaveBeenCalled();
});

test('wait=true on a busy PR-review lane performs one bounded salvage attempt, aborts, and records a terminal runtime-deadline error', async () => {
	const directory = makeTempDir();
	const batchId = 'wait-busy-no-harvest';
	let now = 2_000_000_000_000;
	const sleeps: number[] = [];

	await recordPending({
		directory,
		batchId,
		mode: 'swarm-pr-review:base',
		workflowLane: 'security-trust',
		workspace: {
			directory,
			gitHead: 'head-1',
			dirtyHash: null,
			prHeadSha: 'head-1',
			scope: 'complete PR diff base-1...head-1',
		},
	});
	const status = mock(async () => ({
		data: { [`${batchId}-session`]: { type: 'busy' } },
		error: undefined,
	}));
	const messages = mock(async () => ({
		data: [assistantMessage('late terminal candidate salvage')],
		error: undefined,
	}));
	const abort = mock(async () => undefined);
	_internals.now = () => now;
	_internals.sleep = mock(async (ms: number) => {
		sleeps.push(ms);
		now += ms;
	});
	_internals.getSessionOps = () => ({ ...baseOps(), status, messages, abort });

	const result = await executeCollectLaneResults(
		{ batch_id: batchId, wait: true, timeout_ms: 25, include_pending: true },
		directory,
	);

	// Prior behavior kept the lane pending forever if status stayed busy through
	// the wait budget. The runtime deadline fix should take one bounded transcript
	// salvage shot, best-effort abort the wedged lane, and persist a terminal error.
	expect(result.success).toBe(false);
	expect(result.completed).toBe(0);
	expect(result.failed).toBe(1);
	expect(result.pending).toBe(0);
	expect(result.lane_results[0]?.status).toBe('failed');
	expect(result.lane_results[0]?.transcript_incomplete).toBe(true);
	expect(result.lane_results[0]?.error).toContain('runtime deadline');
	expect(messages).toHaveBeenCalledTimes(1);
	expect(abort).toHaveBeenCalledTimes(1);
	expect(sleeps).toEqual([]);
});

test('repeat waited collect on a settled lane uses the durable delivery cache and skips host calls, including after restart', async () => {
	const directory = makeTempDir();
	const batchId = 'wait-repeat-settled';
	await recordPending({ directory, batchId });

	const status = mock(async () => ({
		data: { [`${batchId}-session`]: { type: 'idle' } },
		error: undefined,
	}));
	const messages = mock(async () => ({
		data: [assistantMessage('durable settled output')],
		error: undefined,
	}));
	_internals.getSessionOps = () => ({ ...baseOps(), status, messages });

	const first = await withTestDeadline(
		executeCollectLaneResults(
			{ batch_id: batchId, wait: false, include_pending: true },
			directory,
		),
	);

	expect(first.completed).toBe(1);
	expect(first.pending).toBe(0);
	expect(first.lane_results[0]?.output).toBe('durable settled output');
	expect(first.lane_results[0]?.output_ref).toMatch(/^L1:/);
	expect(first.lane_results[0]?.output_digest).toMatch(/^[a-f0-9]{64}$/);
	expect(status).toHaveBeenCalledTimes(1);
	expect(messages).toHaveBeenCalledTimes(1);

	status.mockClear();
	messages.mockClear();
	const second = await executeCollectLaneResults(
		{ batch_id: batchId, wait: true, include_pending: true },
		directory,
	);

	expect(second.success).toBe(true);
	expect(second.completed).toBe(1);
	expect(second.pending).toBe(0);
	expect(second.lane_results[0]?.output).toBeUndefined();
	expect(second.lane_results[0]?.output_omitted_repeat).toBe(true);
	expect(second.lane_results[0]?.output_ref).toBe(
		first.lane_results[0]?.output_ref,
	);
	expect(second.lane_results[0]?.output_digest).toBe(
		first.lane_results[0]?.output_digest,
	);
	expect(status).not.toHaveBeenCalled();
	expect(messages).not.toHaveBeenCalled();

	_test_exports.resetDeliveredLaneOutputs();
	const third = await executeCollectLaneResults(
		{ batch_id: batchId, wait: true, timeout_ms: 0, include_pending: true },
		directory,
	);

	expect(third.success).toBe(true);
	expect(third.completed).toBe(1);
	expect(third.pending).toBe(0);
	expect(third.lane_results[0]?.output).toBeUndefined();
	expect(third.lane_results[0]?.output_omitted_repeat).toBe(true);
	expect(third.lane_results[0]?.output_ref).toBe(
		first.lane_results[0]?.output_ref,
	);
	expect(third.lane_results[0]?.output_digest).toBe(
		first.lane_results[0]?.output_digest,
	);
	expect(third.message).toBeUndefined();
	expect(third.errors).toBeUndefined();
	expect(status).not.toHaveBeenCalled();
	expect(messages).not.toHaveBeenCalled();
});
