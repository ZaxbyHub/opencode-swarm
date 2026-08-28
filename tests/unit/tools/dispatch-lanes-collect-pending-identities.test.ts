import { afterEach, describe, expect, mock, test } from 'bun:test';
import { findByCorrelationId } from '../../../src/background/pending-delegations';
import {
	_internals,
	_test_exports,
	executeCollectLaneResults,
} from '../../../src/tools/dispatch-lanes';
import { createCollectLaneTimeoutFixture } from './dispatch-lanes-collect-host-timeout.fixtures';

/**
 * Issue #2381: a collection that returns before every lane settles must say WHICH
 * lanes are still outstanding, without the caller having to opt in via
 * `include_pending`, and must not lose a settled lane's output reference on the
 * way. A wait budget expiring is not evidence that work died.
 *
 * Split from `dispatch-lanes-collect-nondestructive-observer.test.ts` (which owns
 * the non-destructiveness half) to stay under the FR-006 500-line cap.
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

function laneState(directory: string, correlationId: string) {
	const record = findByCorrelationId(directory, correlationId);
	return { status: record?.status, result: record?.result };
}

describe('pending lane identities are returned by default (#2381)', () => {
	test('pending_lanes is present without include_pending and carries identities', async () => {
		const directory = makeTempDir();
		const batchId = 'observer-pending-ids';
		await recordPending({
			directory,
			batchId,
			laneId: 'correctness-state',
			correlationId: `${batchId}-session`,
			mode: 'swarm-pr-review:base',
			workflowLane: 'correctness-state',
			workspace: PR_WORKSPACE(directory),
		});

		let now = 2_000_000_000_000;
		_internals.now = () => now;
		_internals.sleep = mock(async (ms: number) => {
			now += ms;
		});
		const status = mock(async () => ({
			data: { [`${batchId}-session`]: { type: 'busy' } },
			error: undefined,
		}));
		const messages = mock(async () => ({ data: [], error: undefined }));
		_internals.getSessionOps = () => ({ ...baseOps(), status, messages });

		const result = await executeCollectLaneResults(
			// Deliberately NOT passing include_pending, and using wait:true — the
			// combination under which lane_results omits pending lanes entirely.
			{ batch_id: batchId, wait: true, timeout_ms: 25 },
			directory,
		);

		expect(result.pending).toBe(1);
		expect(result.lane_results).toHaveLength(0);
		expect(result.pending_lanes).toHaveLength(1);
		expect(result.pending_lanes?.[0]).toMatchObject({
			batch_id: batchId,
			lane_id: 'correctness-state',
			status: 'pending',
		});
	});

	test('the no-client path also reports pending lane identities', async () => {
		const directory = makeTempDir();
		const batchId = 'observer-no-client-ids';
		await recordPending({
			directory,
			batchId,
			laneId: 'security-trust',
			correlationId: `${batchId}-session`,
			mode: 'swarm-pr-review:base',
			workflowLane: 'security-trust',
			workspace: PR_WORKSPACE(directory),
		});

		_internals.getSessionOps = () => ({ ...baseOps(), messages: undefined });

		const result = await executeCollectLaneResults(
			{ batch_id: batchId, wait: true },
			directory,
		);

		expect(result.failure_class).toBe('no_client');
		expect(result.pending_lanes).toHaveLength(1);
		expect(result.pending_lanes?.[0]).toMatchObject({
			batch_id: batchId,
			lane_id: 'security-trust',
			status: 'pending',
		});
	});

	test('the no-client path retains a settled lane output_ref alongside pending identities', async () => {
		// Issue #2381 required case 12. The no-client path now falls through to the
		// shared result assembly instead of returning zeroed counters, so it must
		// carry BOTH halves: an already-settled lane keeps its output reference,
		// and the still-open lane is named in pending_lanes.
		const directory = makeTempDir();
		const batchId = 'observer-mixed-no-client';
		await recordPending({
			directory,
			batchId,
			laneId: 'settled-lane',
			correlationId: `${batchId}-settled`,
		});
		await recordPending({
			directory,
			batchId,
			laneId: 'open-lane',
			correlationId: `${batchId}-open`,
		});

		// Settle the first lane through a normal collection so it owns a real
		// output_ref produced by production code, not a hand-built fixture.
		const status = mock(async () => ({
			data: {
				[`${batchId}-settled`]: { type: 'idle' },
				// Genuinely still running, so it cannot settle in this pass.
				[`${batchId}-open`]: { type: 'busy' },
			},
			error: undefined,
		}));
		const messages = mock(async () => ({
			data: [assistantMessage('settled output worth preserving')],
			error: undefined,
		}));
		_internals.getSessionOps = () => ({ ...baseOps(), status, messages });
		const settledPass = await executeCollectLaneResults(
			{ batch_id: batchId, wait: false, include_pending: true },
			directory,
		);
		const settledRef = settledPass.lane_results.find(
			(entry) => entry.id === 'settled-lane',
		)?.output_ref;
		expect(settledRef).toMatch(/^L1:/);

		// Now collect again with NO messages client at all.
		_internals.getSessionOps = () => ({ ...baseOps(), messages: undefined });
		const result = await executeCollectLaneResults(
			{ batch_id: batchId, wait: true, include_pending: true },
			directory,
		);

		expect(result.failure_class).toBe('no_client');
		// The settled lane's output reference survives the no-client path.
		expect(
			result.lane_results.find((entry) => entry.id === 'settled-lane')
				?.output_ref,
		).toBe(settledRef);
		// ...and the still-open lane is reported by identity.
		expect(result.pending_lanes).toHaveLength(1);
		expect(result.pending_lanes?.[0]).toMatchObject({
			batch_id: batchId,
			lane_id: 'open-lane',
			status: 'pending',
		});
	});

	test('an expiry path retains a settled lane output_ref alongside pending identities', async () => {
		// Issue #2381 required case 12, EXPIRY half (the sibling case covers the
		// no-client half). A wait budget running out must not lose a settled lane's
		// output reference any more than a missing client does.
		const directory = makeTempDir();
		const batchId = 'expiry-mixed';
		await recordPending({
			directory,
			batchId,
			laneId: 'settled-lane',
			correlationId: `${batchId}-settled`,
		});
		await recordPending({
			directory,
			batchId,
			laneId: 'open-lane',
			correlationId: `${batchId}-open`,
		});

		const status = mock(async () => ({
			data: {
				[`${batchId}-settled`]: { type: 'idle' },
				[`${batchId}-open`]: { type: 'busy' },
			},
			error: undefined,
		}));
		const messages = mock(async () => ({
			data: [assistantMessage('settled output worth preserving')],
			error: undefined,
		}));
		_internals.getSessionOps = () => ({ ...baseOps(), status, messages });

		const first = await executeCollectLaneResults(
			{ batch_id: batchId, wait: false, include_pending: true },
			directory,
		);
		const settledRef = first.lane_results.find(
			(entry) => entry.id === 'settled-lane',
		)?.output_ref;
		expect(settledRef).toMatch(/^L1:/);

		// Now a waited collection whose budget expires with one lane still running.
		let now = 2_000_000_000_000;
		_internals.now = () => now;
		_internals.sleep = mock(async (ms: number) => {
			now += ms;
		});
		const expired = await executeCollectLaneResults(
			{ batch_id: batchId, wait: true, timeout_ms: 25, include_pending: true },
			directory,
		);

		expect(expired.pending).toBe(1);
		expect(expired.failed).toBe(0);
		expect(
			expired.lane_results.find((entry) => entry.id === 'settled-lane')
				?.output_ref,
		).toBe(settledRef);
		expect(expired.pending_lanes).toHaveLength(1);
		expect(expired.pending_lanes?.[0]?.lane_id).toBe('open-lane');
	});
});
