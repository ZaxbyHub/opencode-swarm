/**
 * Issue #2280 Part B — the pending-lane liveness advisory on
 * `collect_lane_results`, driven through the real collect entry point.
 *
 * The #2251 probe already knew how to contradict staleness, but it ran only
 * inside the terminal 30-minute presumed-stale sweep, so a lane pending for
 * 20+ minutes was indistinguishable from a healthy one until abort time.
 * These integration tests pin the surfaced `pending_liveness` field: attached
 * only when a past-threshold advisory exists, alert-only in every scenario
 * (the durable lane record is byte-identical after each), and degraded — never
 * blocking — when the probe fails or the caller's budget is exhausted.
 *
 * The unit-layer classification matrix lives in
 * dispatch-lanes-pending-liveness-advisory.test.ts; the two suites share the
 * seam-harness shape on purpose (each file keeps its own seams).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { recordPendingDelegation } from '../../../src/background/pending-delegations.js';
import { _test_exports as gateInternals } from '../../../src/hooks/pr-workflow-gate.js';
import {
	_internals,
	executeCollectLaneResults,
} from '../../../src/tools/dispatch-lanes.js';
import {
	backdatePrWorkflowLane,
	laneStatusOnDisk,
} from '../../helpers/pr-workflow-lane-fixtures.js';
import { freezeClock } from '../../helpers/test-clock.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const FIVE_MINUTES_MS = 300_000;

let directory = '';
let restoreClock: () => void = () => {};
let statusCalls = 0;

/** Install a fake host `session.status` behind the gate seam, counting calls. */
function installGateStatus(
	map: Record<string, { type?: string }>,
	error: Error | null = null,
): void {
	statusCalls = 0;
	gateInternals.getSessionOps = () => ({
		status: async () => {
			statusCalls += 1;
			if (error) throw error;
			return { data: map };
		},
	});
}

const originalDispatchSessionOps = _internals.getSessionOps;

beforeEach(() => {
	restoreClock = freezeClock();
	directory = canonicalMkdtemp('pr-pending-liveness-collect-');
	mkdirSync(path.join(directory, '.git'), { recursive: true });
	gateInternals.resetTrackedStateCache();
	gateInternals.pendingLaneLivenessThresholdMs = 60_000;
});

afterEach(async () => {
	restoreClock();
	gateInternals.resetTrackedStateCache();
	_internals.getSessionOps = originalDispatchSessionOps;
	await fs.rm(directory, { recursive: true, force: true });
});

describe('collect_lane_results surfaces the advisory (issue #2280 Part B)', () => {
	function installDispatchSession(liveSessionIds: readonly string[]): void {
		_internals.getSessionOps = () => ({
			status: async () => ({
				data: Object.fromEntries(
					liveSessionIds.map((sessionId) => [sessionId, { type: 'busy' }]),
				),
			}),
			messages: async () => ({ data: [] }),
		});
	}

	async function recordCriticLane(
		correlationId: string,
		ageMs: number,
	): Promise<void> {
		await recordPendingDelegation(directory, {
			correlationId,
			jobId: null,
			subagentSessionId: correlationId,
			parentSessionId: 'collect-parent',
			callID: `call-${correlationId}`,
			normalizedAgent: 'critic',
			swarmPrefixedAgent: 'mega_critic',
			planTaskId: null,
			evidenceTaskId: null,
			batchId: 'critic-batch',
			laneId: 'critic-lane-1',
			mode: 'swarm-pr-review:critic',
			workflowLane: 'critic-family',
			workspace: {
				directory,
				gitHead: 'abc123',
				dirtyHash: null,
				prHeadSha: 'abc123',
				scope: null,
			},
		});
		await backdatePrWorkflowLane(directory, correlationId, ageMs);
	}

	test('a long-pending live critic lane gets an advisory and is left completely untouched', async () => {
		await recordCriticLane('c-critic-1', FIVE_MINUTES_MS);
		installDispatchSession(['c-critic-1']);
		installGateStatus({ 'c-critic-1': { type: 'busy' } });

		const result = await executeCollectLaneResults(
			{ batch_id: 'critic-batch', wait: false },
			directory,
		);

		expect(result.pending).toBe(1);
		expect(result.pending_liveness).toEqual([
			{
				laneId: 'critic-lane-1',
				pendingMs: FIVE_MINUTES_MS,
				hostStatus: 'busy',
				stalledSuspect: false,
			},
		]);
		// ALERT-ONLY pinned: the advisory changed nothing about the lane.
		expect(laneStatusOnDisk(directory, 'c-critic-1')).toBe('pending');
		expect(result.message).toBeUndefined();
	});

	test('a fresh pending critic lane produces no probe and no advisory field', async () => {
		await recordCriticLane('c-fresh-1', 0);
		installDispatchSession(['c-fresh-1']);
		installGateStatus({});

		const result = await executeCollectLaneResults(
			{ batch_id: 'critic-batch', wait: false },
			directory,
		);

		expect(result.pending).toBe(1);
		expect(result.pending_liveness).toBeUndefined();
		expect(statusCalls).toBe(0);
	});

	test('a stalled-suspect advisory leaves the lane untouched too (alert-only pinned at the risky value)', async () => {
		// The AC pins "no automatic cancellation/replacement in ANY scenario".
		// The benign case is pinned above; this drives the riskiest value —
		// past threshold with the host affirmatively idle — and proves the
		// durable record is still byte-identical pending, with no sweep, no
		// cancel, and no message injected.
		await recordCriticLane('c-stalled-1', FIVE_MINUTES_MS);
		installDispatchSession(['c-stalled-1']);
		installGateStatus({ 'c-stalled-1': { type: 'idle' } });

		const result = await executeCollectLaneResults(
			{ batch_id: 'critic-batch', wait: false },
			directory,
		);

		expect(result.pending).toBe(1);
		expect(result.pending_liveness).toEqual([
			{
				laneId: 'critic-lane-1',
				pendingMs: FIVE_MINUTES_MS,
				hostStatus: 'idle',
				stalledSuspect: true,
			},
		]);
		expect(laneStatusOnDisk(directory, 'c-stalled-1')).toBe('pending');
		expect(result.message).toBeUndefined();
		expect(result.errors).toBeUndefined();
	});

	test('a degraded probe never blocks collection (integration layer)', async () => {
		// The unit layer pins the degraded classification; this proves the
		// collect call itself completes normally with the degraded advisory
		// attached — the advisory can fail without failing its host.
		await recordCriticLane('c-degraded-1', FIVE_MINUTES_MS);
		installDispatchSession(['c-degraded-1']);
		installGateStatus({}, new Error('session.status exploded'));

		const result = await executeCollectLaneResults(
			{ batch_id: 'critic-batch', wait: false },
			directory,
		);

		expect(result.pending).toBe(1);
		expect(result.pending_liveness).toEqual([
			{
				laneId: 'critic-lane-1',
				pendingMs: FIVE_MINUTES_MS,
				hostStatus: 'unknown',
				stalledSuspect: true,
				degradedReason: 'probe-error',
			},
		]);
		expect(laneStatusOnDisk(directory, 'c-degraded-1')).toBe('pending');
	});

	test('a zero collection budget still answers, with the advisory degraded instead of probing (RP-001)', async () => {
		await recordCriticLane('c-zbudget-1', FIVE_MINUTES_MS);
		installDispatchSession(['c-zbudget-1']);
		installGateStatus({ 'c-zbudget-1': { type: 'busy' } });

		const result = await executeCollectLaneResults(
			{ batch_id: 'critic-batch', wait: false, timeout_ms: 0 },
			directory,
		);

		expect(result.pending).toBe(1);
		expect(result.pending_liveness).toEqual([
			{
				laneId: 'critic-lane-1',
				pendingMs: FIVE_MINUTES_MS,
				hostStatus: 'unknown',
				stalledSuspect: true,
				degradedReason: 'probe-timeout',
			},
		]);
		// The gate probe was never called: no host round-trip beyond the
		// caller's (exhausted) budget.
		expect(statusCalls).toBe(0);
	});

	test('the no-client path still runs the liveness advisory (issue #2381)', async () => {
		// Issue #2381 made the missing-messages-client branch fall through to the
		// shared result assembly instead of returning early, so liveness is now
		// evaluated on a path that previously returned before it ever ran. The
		// advisory stays alert-only here too: the lane must be untouched.
		await recordCriticLane('c-noclient-1', FIVE_MINUTES_MS);
		// A session object with NO `messages` function at all.
		_internals.getSessionOps = () => ({
			status: async () => ({ data: { 'c-noclient-1': { type: 'busy' } } }),
		});
		installGateStatus({ 'c-noclient-1': { type: 'busy' } });

		const result = await executeCollectLaneResults(
			{ batch_id: 'critic-batch', wait: true },
			directory,
		);

		expect(result.failure_class).toBe('no_client');
		expect(result.pending).toBe(1);
		expect(result.failed).toBe(0);
		expect(result.pending_liveness).toEqual([
			{
				laneId: 'critic-lane-1',
				pendingMs: FIVE_MINUTES_MS,
				hostStatus: 'busy',
				stalledSuspect: false,
			},
		]);
		// Alert-only, and non-destructive: an unavailable observer transport says
		// nothing about the child.
		expect(laneStatusOnDisk(directory, 'c-noclient-1')).toBe('pending');
	});

	test('no-client with an unavailable probe degrades rather than terminalizing (issue #2381)', async () => {
		await recordCriticLane('c-noclient-2', FIVE_MINUTES_MS);
		_internals.getSessionOps = () => ({});
		// The gate-side probe has no host either.
		gateInternals.getSessionOps = () => ({});

		const result = await executeCollectLaneResults(
			{ batch_id: 'critic-batch', wait: true },
			directory,
		);

		expect(result.failure_class).toBe('no_client');
		expect(result.pending).toBe(1);
		expect(result.failed).toBe(0);
		expect(result.pending_liveness?.[0]?.stalledSuspect).toBe(true);
		expect(result.pending_liveness?.[0]?.degradedReason).toBe(
			'probe-unavailable',
		);
		// A degraded probe is an observer diagnostic, never terminal evidence.
		expect(laneStatusOnDisk(directory, 'c-noclient-2')).toBe('pending');
	});
});
