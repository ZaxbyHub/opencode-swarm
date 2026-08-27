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

test('wait=true timeout_ms=0 is a non-destructive snapshot that spends no host calls', async () => {
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
		data: [assistantMessage('output that must not be discarded')],
		error: undefined,
	}));
	_internals.getSessionOps = () => ({ ...baseOps(), status, messages });

	const result = await executeCollectLaneResults(
		{ batch_id: batchId, wait: true, timeout_ms: 0, include_pending: true },
		directory,
	);

	// Issue #2381: a zero wait budget bounds THIS OBSERVER CALL only. It used to
	// synthesize a terminal PR-review error; it must now leave the lane exactly as
	// it found it. The lane is still the child's to finish.
	expect(result.failed).toBe(0);
	expect(result.pending).toBe(1);
	expect(result.all_settled).toBe(false);
	expect(result.lane_results[0]?.status).toBe('pending');
	// Pending identities are reported so the caller knows what is outstanding.
	expect(result.pending_lanes).toHaveLength(1);
	// A zero budget short-circuits before any host call is issued.
	expect(status).not.toHaveBeenCalled();
	expect(messages).not.toHaveBeenCalled();
});

test('wait=true on a busy PR-review lane leaves it running and never aborts it', async () => {
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
		data: [assistantMessage('partial in-flight output')],
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

	// Issue #2381: the host still reports the turn BUSY, so the child is alive.
	// The observer's expired budget must not salvage-and-terminalize it, and must
	// not abort the session either.
	expect(result.failed).toBe(0);
	expect(result.pending).toBe(1);
	expect(result.lane_results[0]?.status).toBe('pending');
	expect(result.pending_lanes?.[0]?.status).toBe('pending');
	expect(abort).not.toHaveBeenCalled();
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
