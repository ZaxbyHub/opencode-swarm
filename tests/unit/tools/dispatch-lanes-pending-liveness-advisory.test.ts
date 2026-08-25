/**
 * Issue #2280 Part B — the pending-lane liveness advisory on
 * `collect_lane_results`.
 *
 * The #2251 probe already knew how to contradict staleness, but it ran only
 * inside the terminal 30-minute presumed-stale sweep, so a lane pending for
 * 20+ minutes was indistinguishable from a healthy one until abort time.
 * These tests pin the collection-time advisory: bounded (one probe call max,
 * zero below the threshold), fail-open (degrades to `unknown`, never throws,
 * never blocks), and ALERT-ONLY (no cancel/retry/replace in any scenario).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import {
	type BackgroundDelegationRecord,
	recordPendingDelegation,
} from '../../../src/background/pending-delegations.js';
import {
	collectPrWorkflowPendingLaneLiveness,
	_test_exports as gateInternals,
} from '../../../src/hooks/pr-workflow-gate.js';
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
let statusMap: Record<string, { type?: string }> = {};
let statusError: Error | null = null;

function installGateStatus(
	map: Record<string, { type?: string }>,
	error: Error | null = null,
): void {
	statusMap = map;
	statusError = error;
	statusCalls = 0;
	gateInternals.getSessionOps = () => ({
		status: async () => {
			statusCalls += 1;
			if (statusError) throw statusError;
			return { data: statusMap };
		},
	});
}

beforeEach(() => {
	restoreClock = freezeClock();
	directory = canonicalMkdtemp('pr-pending-liveness-');
	gateInternals.resetTrackedStateCache();
	gateInternals.pendingLaneLivenessThresholdMs = 60_000;
});

afterEach(async () => {
	restoreClock();
	gateInternals.resetTrackedStateCache();
	_internals.getSessionOps = originalDispatchSessionOps;
	await fs.rm(directory, { recursive: true, force: true });
});

const originalDispatchSessionOps = _internals.getSessionOps;

function unitRecord(overrides: {
	laneId: string;
	mode: string;
	ageMs: number;
	status?: BackgroundDelegationRecord['status'];
	subagentSessionId?: string;
}): BackgroundDelegationRecord {
	return {
		schemaVersion: 3,
		correlationId: `corr-${overrides.laneId}`,
		jobId: null,
		subagentSessionId: overrides.subagentSessionId ?? `sub-${overrides.laneId}`,
		parentSessionId: 'parent-session',
		callID: `call-${overrides.laneId}`,
		normalizedAgent: 'reviewer',
		swarmPrefixedAgent: 'reviewer',
		planTaskId: null,
		evidenceTaskId: null,
		status: overrides.status ?? 'pending',
		createdAt: -overrides.ageMs,
		updatedAt: -overrides.ageMs,
		batchId: 'batch-1',
		laneId: overrides.laneId,
		mode: overrides.mode,
	};
}

describe('collectPrWorkflowPendingLaneLiveness (issue #2280 Part B)', () => {
	test('past threshold with the host reporting busy → live advisory, not a stall suspect', async () => {
		installGateStatus({ 'sub-critic-1': { type: 'busy' } });

		const advisories = await collectPrWorkflowPendingLaneLiveness(directory, [
			unitRecord({
				laneId: 'critic-1',
				mode: 'swarm-pr-review:critic',
				ageMs: FIVE_MINUTES_MS,
			}),
		]);

		expect(statusCalls).toBe(1);
		expect(advisories).toEqual([
			{
				laneId: 'critic-1',
				pendingMs: FIVE_MINUTES_MS,
				hostStatus: 'busy',
				stalledSuspect: false,
			},
		]);
	});

	test('past threshold with the host reporting idle → stalled suspect with elapsed time named', async () => {
		installGateStatus({ 'sub-critic-1': { type: 'idle' } });

		const advisories = await collectPrWorkflowPendingLaneLiveness(directory, [
			unitRecord({
				laneId: 'critic-1',
				mode: 'swarm-pr-review:critic',
				ageMs: FIVE_MINUTES_MS,
			}),
		]);

		expect(advisories).toHaveLength(1);
		expect(advisories[0]?.hostStatus).toBe('idle');
		expect(advisories[0]?.stalledSuspect).toBe(true);
		expect(advisories[0]?.pendingMs).toBe(FIVE_MINUTES_MS);
	});

	test('past threshold with the session absent from the host map → affirmatively non-live', async () => {
		installGateStatus({ 'some-other-session': { type: 'busy' } });

		const advisories = await collectPrWorkflowPendingLaneLiveness(directory, [
			unitRecord({
				laneId: 'critic-1',
				mode: 'swarm-pr-review:reviewer',
				ageMs: FIVE_MINUTES_MS,
			}),
		]);

		expect(advisories).toEqual([
			{
				laneId: 'critic-1',
				pendingMs: FIVE_MINUTES_MS,
				hostStatus: 'absent',
				stalledSuspect: true,
			},
		]);
	});

	test('a record without a session id is unprobeable, not "absent"', async () => {
		// The host enumerated nothing about this lane — it never reached the
		// host at all — so 'absent' (sessions enumerated without ours) would
		// overclaim; 'unknown' is the honest reading (review finding).
		installGateStatus({});

		const advisories = await collectPrWorkflowPendingLaneLiveness(directory, [
			unitRecord({
				laneId: 'critic-1',
				mode: 'swarm-pr-review:reviewer',
				ageMs: FIVE_MINUTES_MS,
				subagentSessionId: '',
			}),
		]);

		expect(advisories).toEqual([
			{
				laneId: 'critic-1',
				pendingMs: FIVE_MINUTES_MS,
				hostStatus: 'unknown',
				stalledSuspect: true,
			},
		]);
	});

	test('a degraded probe degrades to unknown with the reason named, and never throws', async () => {
		installGateStatus({}, new Error('socket closed'));

		const advisories = await collectPrWorkflowPendingLaneLiveness(directory, [
			unitRecord({
				laneId: 'critic-1',
				mode: 'swarm-pr-review:council',
				ageMs: FIVE_MINUTES_MS,
			}),
		]);

		expect(advisories).toEqual([
			{
				laneId: 'critic-1',
				pendingMs: FIVE_MINUTES_MS,
				hostStatus: 'unknown',
				stalledSuspect: true,
				degradedReason: 'probe-error',
			},
		]);
	});

	test('no host session handle at all → probe-unavailable, still an advisory, still no throw', async () => {
		gateInternals.getSessionOps = () => null;

		const advisories = await collectPrWorkflowPendingLaneLiveness(directory, [
			unitRecord({
				laneId: 'critic-1',
				mode: 'swarm-pr-review:critic',
				ageMs: FIVE_MINUTES_MS,
			}),
		]);

		expect(advisories).toEqual([
			{
				laneId: 'critic-1',
				pendingMs: FIVE_MINUTES_MS,
				hostStatus: 'unknown',
				stalledSuspect: true,
				degradedReason: 'probe-unavailable',
			},
		]);
	});

	test('below the threshold → no probe round-trip and no advisory (zero hot-path cost)', async () => {
		installGateStatus({ 'sub-critic-1': { type: 'busy' } });

		const advisories = await collectPrWorkflowPendingLaneLiveness(directory, [
			unitRecord({
				laneId: 'critic-1',
				mode: 'swarm-pr-review:critic',
				ageMs: 59_999,
			}),
		]);

		expect(statusCalls).toBe(0);
		expect(advisories).toEqual([]);
	});

	test('exactly at the threshold is not past it (strict >, matching the stale sweep)', async () => {
		installGateStatus({ 'sub-critic-1': { type: 'busy' } });

		const advisories = await collectPrWorkflowPendingLaneLiveness(directory, [
			unitRecord({
				laneId: 'critic-1',
				mode: 'swarm-pr-review:critic',
				ageMs: 60_000,
			}),
		]);

		expect(statusCalls).toBe(0);
		expect(advisories).toEqual([]);
	});

	test('base and micro discovery lanes are covered; settled and non-pr-review lanes are not', async () => {
		installGateStatus({
			'sub-base-1': { type: 'busy' },
			'sub-micro-1': { type: 'idle' },
		});

		const advisories = await collectPrWorkflowPendingLaneLiveness(directory, [
			unitRecord({
				laneId: 'base-1',
				mode: 'swarm-pr-review:base',
				ageMs: FIVE_MINUTES_MS,
			}),
			unitRecord({
				laneId: 'micro-1',
				mode: 'swarm-pr-review:micro',
				ageMs: FIVE_MINUTES_MS,
			}),
			unitRecord({
				laneId: 'coder-1',
				mode: 'swarm-coder',
				ageMs: FIVE_MINUTES_MS,
			}),
			unitRecord({
				laneId: 'stale-1',
				mode: 'swarm-pr-review:critic',
				ageMs: FIVE_MINUTES_MS,
				status: 'stale',
			}),
		]);

		expect(statusCalls).toBe(1);
		expect(advisories).toHaveLength(2);
		expect(advisories.find((entry) => entry.laneId === 'base-1')).toEqual({
			laneId: 'base-1',
			pendingMs: FIVE_MINUTES_MS,
			hostStatus: 'busy',
			stalledSuspect: false,
		});
		expect(advisories.find((entry) => entry.laneId === 'micro-1')).toEqual({
			laneId: 'micro-1',
			pendingMs: FIVE_MINUTES_MS,
			hostStatus: 'idle',
			stalledSuspect: true,
		});
	});
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
			subagentSessionId: `sub-${correlationId}`,
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
		backdatePrWorkflowLane(directory, correlationId, ageMs);
	}

	test('a long-pending live critic lane gets an advisory and is left completely untouched', async () => {
		await recordCriticLane('c-critic-1', FIVE_MINUTES_MS);
		installDispatchSession(['sub-c-critic-1']);
		installGateStatus({ 'sub-c-critic-1': { type: 'busy' } });

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
		installDispatchSession(['sub-c-fresh-1']);
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
		installDispatchSession(['sub-c-stalled-1']);
		installGateStatus({ 'sub-c-stalled-1': { type: 'idle' } });

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
		installDispatchSession(['sub-c-degraded-1']);
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
});
