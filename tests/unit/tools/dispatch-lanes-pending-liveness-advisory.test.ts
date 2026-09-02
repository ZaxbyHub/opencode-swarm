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
 *
 * The collect_entry-point integration cases (surfacing, alert-only disk pins,
 * budget clamping) live in dispatch-lanes-pending-liveness-collect.test.ts.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import type { BackgroundDelegationRecord } from '../../../src/background/pending-delegations.js';
import {
	collectPrWorkflowPendingLaneLiveness,
	_test_exports as gateInternals,
} from '../../../src/hooks/pr-workflow-gate.js';
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
	await fs.rm(directory, { recursive: true, force: true });
});

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

	test('empty records input returns no advisory and probes nothing', async () => {
		installGateStatus({});
		const advisories = await collectPrWorkflowPendingLaneLiveness(
			directory,
			[],
		);
		expect(advisories).toEqual([]);
		expect(statusCalls).toBe(0);
	});

	test('an unexpected accounting failure degrades per lane as advisory-unavailable (PRR-010)', async () => {
		// getSessionOps ITSELF throwing escapes the probe core's internal
		// handling; the outer catch must still name the past-threshold lanes so
		// an absent pending_liveness keeps meaning "nothing was past threshold".
		gateInternals.getSessionOps = () => {
			throw new Error('session handle exploded');
		};
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
				degradedReason: 'advisory-unavailable',
			},
		]);
	});

	test('a zero caller probe budget spends no host round-trip (RP-001)', async () => {
		installGateStatus({ 'sub-critic-1': { type: 'busy' } });
		const advisories = await collectPrWorkflowPendingLaneLiveness(
			directory,
			[
				unitRecord({
					laneId: 'critic-1',
					mode: 'swarm-pr-review:critic',
					ageMs: FIVE_MINUTES_MS,
				}),
			],
			{ probeBudgetMs: 0 },
		);
		expect(statusCalls).toBe(0);
		expect(advisories).toEqual([
			{
				laneId: 'critic-1',
				pendingMs: FIVE_MINUTES_MS,
				hostStatus: 'unknown',
				stalledSuspect: true,
				degradedReason: 'probe-timeout',
			},
		]);
	});

	// Issue #2349 widened the advisory from the five `swarm-pr-review:*` modes to
	// EVERY long-pending async lane: a generic lane wedges just as silently, and
	// the advisory is alert-only so covering it changes no lane's lifecycle. This
	// test previously asserted that a non-pr-review lane was excluded; that
	// expectation is realigned here rather than left as drift. What must still
	// hold — and is what this test now pins — is that SETTLED lanes are excluded.
	test('every pending lane is covered regardless of mode; settled lanes are not', async () => {
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
		// base-1, micro-1 AND the generic coder-1 lane (issue #2349); stale-1 is
		// settled and therefore still excluded.
		expect(advisories).toHaveLength(3);
		expect(advisories.some((entry) => entry.laneId === 'coder-1')).toBe(true);
		expect(advisories.some((entry) => entry.laneId === 'stale-1')).toBe(false);
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
