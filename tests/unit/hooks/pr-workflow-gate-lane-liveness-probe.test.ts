/**
 * Issue #2251 — the PR-workflow lane liveness probe's outcome mapping.
 *
 * Nothing heartbeats a delegation's `updatedAt`, so the age-only settlement
 * introduced by #2242 discards a genuinely-running lane past the 30-minute
 * horizon and its transcript is never fetched. The probe contradicts staleness
 * — but only when it can actually RUN and affirmatively names a live session.
 *
 * Every test here drives the REAL probe through the `getSessionOps` seam. None
 * of them stubs `probeLaneLivenessAsync`: stubbing the probe would assert only
 * that settlement calls something, and the entire risk of this change lives in
 * the fail-OPEN mapping below — which is the exact inverse of the fail-CLOSED
 * `isLaneReadyForCollection` in `src/tools/dispatch-lanes.ts`.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import { closeProjectDb } from '../../../src/db/project-db.js';
import {
	_test_exports as gateInternals,
	settlePresumedStalePrWorkflowLanes,
} from '../../../src/hooks/pr-workflow-gate.js';
import {
	backdatePrWorkflowLane,
	laneStatusOnDisk,
	laneSubagentSessionId,
	recordOpenPrWorkflowLane,
	STALE_LANE_AGE_MS,
} from '../../helpers/pr-workflow-lane-fixtures.js';
import { freezeClock } from '../../helpers/test-clock.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

let directory = '';
let restoreClock: () => void = () => {};

type SessionStatusMap = Record<string, { type?: string }>;
type StatusResult = { data?: SessionStatusMap | null; error?: unknown };

/** Install a fake host `session.status` implementation behind the seam. */
function installStatus(
	impl: (args: { query?: { directory?: string } }) => Promise<StatusResult>,
): void {
	gateInternals.getSessionOps = () => ({ status: impl });
}

/** Install a host that reports exactly these session ids with these types. */
function installStatusMap(map: SessionStatusMap): void {
	installStatus(async () => ({ data: map }));
}

beforeEach(() => {
	// Staleness is a pure function of Date.now() - updatedAt; freezing the clock
	// makes every backdated age margin exact (issue #1782 class 1).
	restoreClock = freezeClock();
	directory = canonicalMkdtemp('pr-workflow-lane-probe-');
	gateInternals.resetTrackedStateCache();
	// Default to "no host": each test opts in to the outcome it exercises, and a
	// test that forgets gets the fail-open (settle) direction, never a spare.
	gateInternals.getSessionOps = () => null;
});

afterEach(async () => {
	restoreClock();
	// Restores getSessionOps and laneLivenessProbeTimeoutMs to their real
	// bindings — never to a hand-rewritten literal.
	gateInternals.resetTrackedStateCache();
	closeProjectDb(directory);
	await fs.rm(directory, { recursive: true, force: true });
});

async function seedStaleLane(
	sessionID: string,
	laneId: string,
	correlationId: string,
): Promise<void> {
	await recordOpenPrWorkflowLane(directory, sessionID, laneId, correlationId);
	await backdatePrWorkflowLane(directory, correlationId, STALE_LANE_AGE_MS);
}

describe('lane liveness probe — a live session contradicts staleness', () => {
	test('a `busy` session past the horizon is retained, not settled', async () => {
		// The #2251 defect: this lane is genuinely running, age says otherwise,
		// and before the probe it went terminal `stale` with its work unrecoverable.
		await seedStaleLane('sess-busy', 'intent-architecture', 'c-busy');
		installStatusMap({
			[laneSubagentSessionId('c-busy')]: { type: 'busy' },
		});

		const settlement = await settlePresumedStalePrWorkflowLanes(
			directory,
			'sess-busy',
		);

		expect(settlement.presumedStaleLaneIds).toEqual([]);
		expect(settlement.openLanes).toBe(1);
		expect(settlement.openLaneIds).toEqual(['intent-architecture']);
		expect(settlement.freshOpenLanes).toBe(0);
		expect(settlement.probedAliveLaneIds).toEqual(['intent-architecture']);
		expect(settlement.probeDegradedReason).toBeUndefined();
		expect(settlement.disclosure).toContain(
			'liveness probe reports still running: intent-architecture',
		);
		// Nothing was settled, so no settlement audit record may claim otherwise.
		expect(laneStatusOnDisk(directory, 'c-busy')).toBe('pending');
		await expect(
			fs.readFile(`${directory}/.swarm/events.jsonl`, 'utf-8'),
		).rejects.toThrow();
	});

	test('a `retry` session past the horizon is retained (pins the allowlist’s second member)', async () => {
		// `retry` is a transient-failure backoff, not a dead lane. A future
		// narrowing of the allowlist to `busy` alone would resurrect #2251 for
		// every lane that happened to be mid-retry at the horizon.
		await seedStaleLane('sess-retry', 'risk-security', 'c-retry');
		installStatusMap({
			[laneSubagentSessionId('c-retry')]: { type: 'retry' },
		});

		const settlement = await settlePresumedStalePrWorkflowLanes(
			directory,
			'sess-retry',
		);

		expect(settlement.presumedStaleLaneIds).toEqual([]);
		expect(settlement.openLanes).toBe(1);
		expect(settlement.probedAliveLaneIds).toEqual(['risk-security']);
		expect(laneStatusOnDisk(directory, 'c-retry')).toBe('pending');
	});
});

describe('lane liveness probe — everything that is not affirmative life settles', () => {
	test('an `idle` session settles, with the NON-degraded wording', async () => {
		// The one outcome where the probe genuinely ran and found nothing. The
		// pre-existing suite runs with no host at all, so without this test the
		// "probe ran" wording would never be exercised.
		await seedStaleLane('sess-idle', 'intent-architecture', 'c-idle');
		installStatusMap({
			[laneSubagentSessionId('c-idle')]: { type: 'idle' },
		});

		const settlement = await settlePresumedStalePrWorkflowLanes(
			directory,
			'sess-idle',
		);

		expect(settlement.openLanes).toBe(0);
		expect(settlement.presumedStaleLaneIds).toEqual(['intent-architecture']);
		expect(settlement.probeDegradedReason).toBeUndefined();
		expect(settlement.probedAliveLaneIds).toBeUndefined();
		expect(settlement.disclosure).toContain('1 lane(s) stale >30min');
		expect(settlement.disclosure).toContain(
			'liveness probe found no live session',
		);
		expect(settlement.disclosure).not.toContain('probe failure');
		expect(laneStatusOnDisk(directory, 'c-idle')).toBe('stale');
	});

	test('a session absent from the status map settles, without degrading the whole probe', async () => {
		// A missing entry is per-lane evidence of absence, not a probe failure —
		// it must not relabel the disclosure as a failure for the other lanes.
		await seedStaleLane('sess-absent', 'intent-architecture', 'c-absent');
		installStatusMap({ 'some-other-session': { type: 'busy' } });

		const settlement = await settlePresumedStalePrWorkflowLanes(
			directory,
			'sess-absent',
		);

		expect(settlement.openLanes).toBe(0);
		expect(settlement.presumedStaleLaneIds).toEqual(['intent-architecture']);
		expect(settlement.probeDegradedReason).toBeUndefined();
		expect(settlement.disclosure).toContain(
			'liveness probe found no live session',
		);
		expect(laneStatusOnDisk(directory, 'c-absent')).toBe('stale');
	});

	test('mixed statuses: exactly the allowlisted members spare a lane (pins the alive-set projection)', async () => {
		// Since issue #2280 Part B the probe's host call is shared with the
		// pending-liveness advisory, which needs every session's status TYPE.
		// The stale sweep still consumes the alive-SET projection of that map —
		// this pins the filter: only `busy`/`retry` spare a lane, and a
		// fabricated future status type (`'cancelled'`) settles rather than
		// leaking through as alive.
		await seedStaleLane('sess-mixed', 'intent-architecture', 'c-mixed-busy');
		await seedStaleLane('sess-mixed', 'correctness-state', 'c-mixed-retry');
		await seedStaleLane('sess-mixed', 'tests-falsifiability', 'c-mixed-idle');
		await seedStaleLane('sess-mixed', 'security-trust', 'c-mixed-cancelled');
		installStatusMap({
			[laneSubagentSessionId('c-mixed-busy')]: { type: 'busy' },
			[laneSubagentSessionId('c-mixed-retry')]: { type: 'retry' },
			[laneSubagentSessionId('c-mixed-idle')]: { type: 'idle' },
			[laneSubagentSessionId('c-mixed-cancelled')]: { type: 'cancelled' },
		});

		const settlement = await settlePresumedStalePrWorkflowLanes(
			directory,
			'sess-mixed',
		);

		expect([...(settlement.probedAliveLaneIds ?? [])].sort()).toEqual([
			'correctness-state',
			'intent-architecture',
		]);
		expect([...(settlement.presumedStaleLaneIds ?? [])].sort()).toEqual([
			'security-trust',
			'tests-falsifiability',
		]);
		expect(laneStatusOnDisk(directory, 'c-mixed-busy')).toBe('pending');
		expect(laneStatusOnDisk(directory, 'c-mixed-retry')).toBe('pending');
		expect(laneStatusOnDisk(directory, 'c-mixed-idle')).toBe('stale');
		expect(laneStatusOnDisk(directory, 'c-mixed-cancelled')).toBe('stale');
	});

	test('a truthy `error` on the response settles with probe-error', async () => {
		await seedStaleLane('sess-err', 'intent-architecture', 'c-err');
		installStatus(async () => ({ error: { message: 'host refused' } }));

		const settlement = await settlePresumedStalePrWorkflowLanes(
			directory,
			'sess-err',
		);

		expect(settlement.openLanes).toBe(0);
		expect(settlement.presumedStaleLaneIds).toEqual(['intent-architecture']);
		expect(settlement.probeDegradedReason).toBe('probe-error');
		expect(settlement.disclosure).toContain(
			'settled despite liveness probe failure (probe-error)',
		);
		expect(laneStatusOnDisk(directory, 'c-err')).toBe('stale');
	});

	test('a null `data` payload settles with probe-no-data', async () => {
		// Distinct from an empty map: "the host answered with nothing" is not
		// evidence that every lane is dead, so it must be disclosed as degraded.
		await seedStaleLane('sess-nodata', 'intent-architecture', 'c-nodata');
		installStatus(async () => ({ data: null }));

		const settlement = await settlePresumedStalePrWorkflowLanes(
			directory,
			'sess-nodata',
		);

		expect(settlement.openLanes).toBe(0);
		expect(settlement.probeDegradedReason).toBe('probe-no-data');
		expect(settlement.disclosure).toContain(
			'settled despite liveness probe failure (probe-no-data)',
		);
		expect(laneStatusOnDisk(directory, 'c-nodata')).toBe('stale');
	});

	test('a throwing status call settles with probe-error', async () => {
		await seedStaleLane('sess-throw', 'intent-architecture', 'c-throw');
		installStatus(async () => {
			throw new Error('socket closed');
		});

		const settlement = await settlePresumedStalePrWorkflowLanes(
			directory,
			'sess-throw',
		);

		expect(settlement.openLanes).toBe(0);
		expect(settlement.probeDegradedReason).toBe('probe-error');
		expect(laneStatusOnDisk(directory, 'c-throw')).toBe('stale');
	});

	test('a status call that outlives the deadline settles with probe-timeout', async () => {
		// `freezeClock` patches Date.now, NOT setTimeout, so the only honest way
		// to reach this branch without a 5-second wall-clock test is to shorten
		// the real deadline through its seam.
		await seedStaleLane('sess-timeout', 'intent-architecture', 'c-timeout');
		gateInternals.laneLivenessProbeTimeoutMs = 5;
		installStatus(
			() =>
				new Promise<StatusResult>((resolve) => {
					setTimeout(() => resolve({ data: {} }), 250);
				}),
		);

		const settlement = await settlePresumedStalePrWorkflowLanes(
			directory,
			'sess-timeout',
		);

		expect(settlement.openLanes).toBe(0);
		expect(settlement.probeDegradedReason).toBe('probe-timeout');
		expect(settlement.disclosure).toContain(
			'settled despite liveness probe failure (probe-timeout)',
		);
		expect(laneStatusOnDisk(directory, 'c-timeout')).toBe('stale');
	});

	test('no session handle at all settles with probe-unavailable', async () => {
		// The plugin can run with no SDK client bound. "Cannot probe" must never
		// spare a lane — that is the reachability floor #2242 established.
		await seedStaleLane('sess-nohost', 'intent-architecture', 'c-nohost');
		gateInternals.getSessionOps = () => null;

		const settlement = await settlePresumedStalePrWorkflowLanes(
			directory,
			'sess-nohost',
		);

		expect(settlement.openLanes).toBe(0);
		expect(settlement.probeDegradedReason).toBe('probe-unavailable');
		expect(settlement.disclosure).toContain(
			'settled despite liveness probe failure (probe-unavailable)',
		);
		expect(laneStatusOnDisk(directory, 'c-nohost')).toBe('stale');
	});

	test('a session handle whose `status` is not a function settles with probe-unavailable', async () => {
		// An older or partial host build exposes `session` without `status`.
		await seedStaleLane('sess-nostatus', 'intent-architecture', 'c-nostatus');
		gateInternals.getSessionOps = () =>
			({ status: 'not-a-function' }) as unknown as ReturnType<
				typeof gateInternals.getSessionOps
			>;

		const settlement = await settlePresumedStalePrWorkflowLanes(
			directory,
			'sess-nostatus',
		);

		expect(settlement.openLanes).toBe(0);
		expect(settlement.probeDegradedReason).toBe('probe-unavailable');
		expect(laneStatusOnDisk(directory, 'c-nostatus')).toBe('stale');
	});
});

describe('lane liveness probe — not consulted below the horizon', () => {
	test('a fresh lane blocks on age alone and the host is never asked', async () => {
		// The probe is a contradiction check on a decision to SETTLE. A lane below
		// the horizon is already blocking, so a host round-trip here would be pure
		// latency on the common path — and a `busy` answer would change nothing.
		await recordOpenPrWorkflowLane(
			directory,
			'sess-fresh',
			'intent-architecture',
			'c-fresh',
		);
		let statusCalls = 0;
		installStatus(async () => {
			statusCalls += 1;
			return { data: { [laneSubagentSessionId('c-fresh')]: { type: 'busy' } } };
		});

		const settlement = await settlePresumedStalePrWorkflowLanes(
			directory,
			'sess-fresh',
		);

		expect(statusCalls).toBe(0);
		expect(settlement.openLanes).toBe(1);
		expect(settlement.freshOpenLanes).toBe(1);
		expect(settlement.openLaneIds).toEqual(['intent-architecture']);
		expect(settlement.presumedStaleLaneIds).toEqual([]);
		expect(settlement.probedAliveLaneIds).toBeUndefined();
		expect(settlement.probeDegradedReason).toBeUndefined();
		expect(settlement.disclosure).toBeUndefined();
	});
});
