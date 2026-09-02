import { afterEach, describe, expect, mock, test } from 'bun:test';
import { findByCorrelationId } from '../../../src/background/pending-delegations';
import {
	_internals,
	_test_exports,
	executeCollectLaneResults,
} from '../../../src/tools/dispatch-lanes';
import { createCollectLaneTimeoutFixture } from '../tools/dispatch-lanes-collect-host-timeout.fixtures';

/**
 * Issue #2385 replay corpus — historical failure shapes 1 and 2 from tracker
 * #2380, replayed through the REGISTERED `collect_lane_results` path:
 *
 *  1. waited-deadline terminalization shape (PR #2329 incident R1): the
 *     orchestrator's blocking-join budget expired and the finalizer wrote a
 *     durable `status: 'error'` transition for a lane that was still running.
 *  2. no-client terminalization shape (R1 sibling): an unavailable host
 *     messages client took the same terminalizing branch.
 *
 * Both must now observe without mutating: the durable record stays pending,
 * and the 30-minute presumed-stale sweep remains the only terminal backstop.
 */

const {
	assistantMessage,
	baseOps,
	cleanupTempDirs,
	makeTempDir,
	recordPending,
	restoreInternals,
} = createCollectLaneTimeoutFixture();

afterEach(async () => {
	restoreInternals();
	_test_exports.resetDeliveredLaneOutputs();
	await cleanupTempDirs();
});

const PR_WORKSPACE = (directory: string) => ({
	directory,
	gitHead: 'head-1',
	dirtyHash: null,
	prHeadSha: 'head-1',
	scope: 'complete PR diff base-1...head-1',
});

function laneStatus(directory: string, correlationId: string) {
	const record = findByCorrelationId(directory, correlationId);
	return record?.status;
}

describe('replay corpus: observer shapes never terminalize (#2380 shapes 1-2)', () => {
	test('shape 1 — waited-deadline expiry leaves a busy PR-review lane untouched', async () => {
		const directory = makeTempDir();
		const batchId = 'corpus-waited-deadline';
		const correlationId = `${batchId}-session`;
		await recordPending({
			directory,
			batchId,
			mode: 'swarm-pr-review:base',
			workflowLane: 'correctness-state',
			workspace: PR_WORKSPACE(directory),
		});
		expect(laneStatus(directory, correlationId)).toBe('pending');

		let now = 2_000_000_000_000;
		_internals.now = () => now;
		_internals.sleep = mock(async (ms: number) => {
			now += ms;
		});
		// The host reports the lane busy: it is genuinely still running.
		const status = mock(async () => ({
			data: { [correlationId]: { type: 'busy' } },
			error: undefined,
		}));
		const messages = mock(async () => ({
			data: [assistantMessage('still investigating')],
			error: undefined,
		}));
		const abort = mock(async () => undefined);
		_internals.getSessionOps = () =>
			({ ...baseOps(), status, messages, abort }) as never;

		const result = await executeCollectLaneResults(
			{
				batch_id: batchId,
				wait: true,
				timeout_ms: 1_000,
				include_pending: true,
			},
			directory,
		);

		expect(result.pending).toBeGreaterThanOrEqual(1);
		// The durable record is UNCHANGED: still pending, no terminal write.
		expect(laneStatus(directory, correlationId)).toBe('pending');
		const record = findByCorrelationId(directory, correlationId);
		expect(record?.result).toBeUndefined();
		expect(abort).not.toHaveBeenCalled();
	});

	test('shape 2 — an unavailable messages client observes without terminalizing', async () => {
		const directory = makeTempDir();
		const batchId = 'corpus-no-client';
		const correlationId = `${batchId}-session`;
		await recordPending({
			directory,
			batchId,
			mode: 'swarm-pr-review:base',
			workflowLane: 'security-trust',
			workspace: PR_WORKSPACE(directory),
		});
		expect(laneStatus(directory, correlationId)).toBe('pending');

		_internals.now = () => 2_000_000_000_000;
		// No `messages` function at all — the host client is unavailable.
		const status = mock(async () => ({
			data: { [correlationId]: { type: 'idle' } },
			error: undefined,
		}));
		const abort = mock(async () => undefined);
		_internals.getSessionOps = () =>
			({ ...baseOps(), status, messages: undefined, abort }) as never;

		const result = await executeCollectLaneResults(
			{ batch_id: batchId, wait: true, include_pending: true },
			directory,
		);

		expect(result.failure_class).toBe('no_client');
		// Stored status reported, no terminal transition, no invented result.
		expect(laneStatus(directory, correlationId)).toBe('pending');
		const record = findByCorrelationId(directory, correlationId);
		expect(record?.result).toBeUndefined();
		expect(abort).not.toHaveBeenCalled();
	});
});
