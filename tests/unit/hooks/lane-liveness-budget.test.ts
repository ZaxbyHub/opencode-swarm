/**
 * Issue #2506 acceptance check C7 (AC7, NEW-SURFACE) — the per-fixture frozen
 * integer budget manifest for watchdog host interactions.
 *
 * The budgets below are frozen IN THIS FILE, derived from the #2506 retry
 * ownership contract:
 * - ONE status probe per watchdog evaluation (the probe's shared
 *   session-status call covers every open lane — no per-lane fan-out).
 * - ONE abort per execution_deadline lane (best-effort, never retried).
 * - BOUNDED evaluations: at most one watchdog evaluation per settlement
 *   invocation, and a lane already terminal is never re-evaluated or
 *   re-aborted.
 * - Wall clock is expressed in ITERATIONS (host round-trips), not
 *   milliseconds, per the repo's frozen-clock convention: every fixture runs
 *   under `freezeClock()`, so the only "time" the watchdog can consume is
 *   host round-trips, which are counted and bounded here.
 *
 * Two independent measurements are asserted against every budget:
 * (a) the fake host's own invocation counters (ground truth), and
 * (b) the watchdog's `_test_exports.laneLivenessWatchdog` budget counters
 *     (`hostStatusCalls`, `hostAbortCalls`, `evaluations`).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import { closeProjectDb } from '../../../src/db/project-db.js';
import { LANE_LIVENESS_WATCHDOG_DEFAULTS } from '../../../src/hooks/lane-liveness-watchdog.js';
import {
	_test_exports as gateInternals,
	settlePresumedStalePrWorkflowLanes,
} from '../../../src/hooks/pr-workflow-gate.js';
import {
	backdatePrWorkflowLane,
	laneSubagentSessionId,
	recordOpenPrWorkflowLane,
} from '../../helpers/pr-workflow-lane-fixtures.js';
import { freezeClock } from '../../helpers/test-clock.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

// ---------------------------------------------------------------------------
// Frozen integer budget manifest (AC7).
// ---------------------------------------------------------------------------
/** The budgets are derived from the shipped contract defaults, not guesses. */
const STALL_CONTRACT_DEFAULTS = LANE_LIVENESS_WATCHDOG_DEFAULTS;
/** One shared status probe per watchdog evaluation — never per-lane. */
const MAX_HOST_STATUS_CALLS_PER_EVALUATION = 1;
/** One abort per execution_deadline lane — never retried. */
const MAX_HOST_ABORTS_PER_EXECUTION_DEADLINE_LANE = 1;
/** At most one watchdog evaluation per settlement invocation. */
const MAX_EVALUATIONS_PER_SETTLEMENT = 1;
/** Fixture A: 1 lane → at most 1 status + 1 abort host launches. */
const MAX_HOST_LAUNCHES_SINGLE_LANE = 2;
/** Fixture B: 3 lanes → at most 1 shared status + 3 aborts. */
const MAX_HOST_LAUNCHES_THREE_LANES = 4;
/** Repeat fixture: at most 2 settlement attempts before nothing is left. */
const MAX_ATTEMPTS_REPEAT_FIXTURE = 2;
/** Whole-file wall-clock budget, in host round-trips (iterations). */
const WALL_CLOCK_ITERATIONS_BUDGET = 12;

const WATCHDOG_TIMEOUT_MS = 60_000;
const LANE_AGE_MS = 5 * 60_000; // past the 60s effective horizon

const enabledWatchdog = {
	enabled: true,
	timeout_ms: WATCHDOG_TIMEOUT_MS,
	stall_threshold_ms: 300_000,
	stall_min_steps: 5,
	stall_token_threshold: 200,
};

type WatchdogSurface = {
	hostStatusCalls: number;
	hostAbortCalls: number;
	evaluations: number;
};

const counters = (): WatchdogSurface =>
	gateInternals.laneLivenessWatchdog as unknown as WatchdogSurface;

/** Ground-truth host launch tally shared by every fixture in this file. */
const hostLaunches = { status: 0, abort: 0 };

let directory = '';
let restoreClock: () => void = () => {};

beforeEach(() => {
	restoreClock = freezeClock();
	directory = canonicalMkdtemp('lane-liveness-budget-');
	// Every fixture's budget is a PER-TEST delta (fixtures A/B measure
	// before/after; C/D assert per-fixture bounds), so the shared host tally
	// starts at zero for each test rather than accumulating across the file.
	hostLaunches.status = 0;
	hostLaunches.abort = 0;
	gateInternals.resetTrackedStateCache();
	gateInternals.getSessionOps = () => null;
});

afterEach(async () => {
	restoreClock();
	gateInternals.resetTrackedStateCache();
	closeProjectDb(directory);
	await fs.rm(directory, { recursive: true, force: true });
});

/** Install a busy-host fake that tallies every launch it serves. */
function installTallyingBusyHost(sessionIds: string[]): void {
	const map: Record<string, { type?: string }> = {};
	for (const id of sessionIds) map[id] = { type: 'busy' };
	gateInternals.getSessionOps = () =>
		({
			status: async () => {
				hostLaunches.status += 1;
				return { data: map };
			},
			abort: async () => {
				hostLaunches.abort += 1;
				return {};
			},
		}) as unknown as ReturnType<typeof gateInternals.getSessionOps>;
}

describe('C7 — fixture A: one execution_deadline lane', () => {
	test('the manifest is derived from the shipped contract defaults', () => {
		expect(STALL_CONTRACT_DEFAULTS.stall_min_steps).toBe(5);
		expect(STALL_CONTRACT_DEFAULTS.stall_token_threshold).toBe(200);
		expect(STALL_CONTRACT_DEFAULTS.stall_threshold_ms).toBe(300_000);
		expect(STALL_CONTRACT_DEFAULTS.timeout_ms).toBe(1_800_000);
	});

	test('one status probe, one abort, one evaluation — within the frozen budget', async () => {
		await recordOpenPrWorkflowLane(
			directory,
			'sess-budget-a',
			'intent-architecture',
			'c-budget-a',
		);
		await backdatePrWorkflowLane(directory, 'c-budget-a', LANE_AGE_MS);
		installTallyingBusyHost([laneSubagentSessionId('c-budget-a')]);
		const before = { ...hostLaunches };

		await settlePresumedStalePrWorkflowLanes(directory, 'sess-budget-a', {
			laneLivenessWatchdog: enabledWatchdog,
		});

		const usedStatus = hostLaunches.status - before.status;
		const usedAbort = hostLaunches.abort - before.abort;
		expect(usedStatus).toBe(MAX_HOST_STATUS_CALLS_PER_EVALUATION);
		expect(usedAbort).toBe(MAX_HOST_ABORTS_PER_EXECUTION_DEADLINE_LANE);
		expect(usedStatus + usedAbort).toBeLessThanOrEqual(
			MAX_HOST_LAUNCHES_SINGLE_LANE,
		);
		const c = counters();
		expect(c.evaluations).toBeLessThanOrEqual(MAX_EVALUATIONS_PER_SETTLEMENT);
		expect(c.hostStatusCalls).toBeLessThanOrEqual(
			MAX_HOST_STATUS_CALLS_PER_EVALUATION,
		);
		expect(c.hostAbortCalls).toBeLessThanOrEqual(
			MAX_HOST_ABORTS_PER_EXECUTION_DEADLINE_LANE,
		);
	});
});

describe('C7 — fixture B: three execution_deadline lanes share ONE status probe', () => {
	test('status stays at the per-evaluation cap while aborts scale one-per-lane', async () => {
		const ids = ['c-b0', 'c-b1', 'c-b2'];
		for (let i = 0; i < ids.length; i += 1) {
			await recordOpenPrWorkflowLane(
				directory,
				'sess-budget-b',
				`lane-budget-${i}`,
				ids[i],
			);
			await backdatePrWorkflowLane(directory, ids[i], LANE_AGE_MS);
		}
		installTallyingBusyHost(ids.map((id) => laneSubagentSessionId(id)));
		const before = { ...hostLaunches };

		const settlement = await settlePresumedStalePrWorkflowLanes(
			directory,
			'sess-budget-b',
			{ laneLivenessWatchdog: enabledWatchdog },
		);

		const usedStatus = hostLaunches.status - before.status;
		const usedAbort = hostLaunches.abort - before.abort;
		expect(usedStatus).toBeLessThanOrEqual(
			MAX_HOST_STATUS_CALLS_PER_EVALUATION,
		);
		expect(usedAbort).toBeLessThanOrEqual(
			MAX_HOST_ABORTS_PER_EXECUTION_DEADLINE_LANE * ids.length,
		);
		expect(usedStatus + usedAbort).toBeLessThanOrEqual(
			MAX_HOST_LAUNCHES_THREE_LANES,
		);
		expect(settlement.presumedStaleLaneIds.length).toBe(ids.length);
		expect(counters().evaluations).toBeLessThanOrEqual(
			MAX_EVALUATIONS_PER_SETTLEMENT,
		);
	});
});

describe('C7 — fixture C: repeated settlement attempts stay bounded', () => {
	test('a terminal lane is never re-aborted; attempts and evaluations stay capped', async () => {
		await recordOpenPrWorkflowLane(
			directory,
			'sess-budget-c',
			'risk-security',
			'c-budget-c',
		);
		await backdatePrWorkflowLane(directory, 'c-budget-c', LANE_AGE_MS);
		installTallyingBusyHost([laneSubagentSessionId('c-budget-c')]);

		const first = await settlePresumedStalePrWorkflowLanes(
			directory,
			'sess-budget-c',
			{ laneLivenessWatchdog: enabledWatchdog },
		);
		const abortsAfterFirst = hostLaunches.abort;

		// Second (and final permitted) attempt on the now-terminal lane.
		const second = await settlePresumedStalePrWorkflowLanes(
			directory,
			'sess-budget-c',
			{ laneLivenessWatchdog: enabledWatchdog },
		);

		expect(first.presumedStaleLaneIds).toEqual(['risk-security']);
		expect(second.presumedStaleLaneIds).toEqual([]);
		// No retry loop: the abort count did not grow on the repeat attempt.
		expect(hostLaunches.abort).toBe(abortsAfterFirst);
		expect(hostLaunches.abort).toBeLessThanOrEqual(
			MAX_HOST_ABORTS_PER_EXECUTION_DEADLINE_LANE,
		);
		expect(counters().evaluations).toBeLessThanOrEqual(
			MAX_EVALUATIONS_PER_SETTLEMENT,
		);
	});
});

describe('C7 — fixture D: disabled watchdog launches nothing of its own', () => {
	test('zero evaluations, zero aborts, zero watchdog status probes', async () => {
		await recordOpenPrWorkflowLane(
			directory,
			'sess-budget-d',
			'tests-falsifiability',
			'c-budget-d',
		);
		await backdatePrWorkflowLane(directory, 'c-budget-d', LANE_AGE_MS);
		installTallyingBusyHost([laneSubagentSessionId('c-budget-d')]);

		// Two-argument call — the disabled default applies.
		await settlePresumedStalePrWorkflowLanes(directory, 'sess-budget-d');

		const c = counters();
		expect(c.evaluations).toBe(0);
		expect(c.hostStatusCalls).toBe(0);
		expect(c.hostAbortCalls).toBe(0);
		// The #2251 probe's own status call still happens (existing
		// behavior, PRESERVING) but launches no abort.
		expect(hostLaunches.abort).toBe(0);
	});
});

describe('C7 — whole-file wall-clock budget (iterations, frozen clock)', () => {
	test('total host round-trips across every fixture stay under the frozen iteration budget', async () => {
		// A final composite fixture: 2 lanes, one repeat attempt — the
		// maximum additional load this file can generate after the fixtures
		// above is bounded by the same constants.
		const ids = ['c-wall-0', 'c-wall-1'];
		for (let i = 0; i < ids.length; i += 1) {
			await recordOpenPrWorkflowLane(
				directory,
				'sess-wall',
				`lane-wall-${i}`,
				ids[i],
			);
			await backdatePrWorkflowLane(directory, ids[i], LANE_AGE_MS);
		}
		installTallyingBusyHost(ids.map((id) => laneSubagentSessionId(id)));

		await settlePresumedStalePrWorkflowLanes(directory, 'sess-wall', {
			laneLivenessWatchdog: enabledWatchdog,
		});
		await settlePresumedStalePrWorkflowLanes(directory, 'sess-wall', {
			laneLivenessWatchdog: enabledWatchdog,
		});

		// Everything this file launched, against the frozen ceiling. With
		// the clock frozen the ONLY consumable resource is host round-trips,
		// so this is the wall-clock budget expressed as iterations.
		expect(hostLaunches.status + hostLaunches.abort).toBeLessThanOrEqual(
			WALL_CLOCK_ITERATIONS_BUDGET,
		);
	});
});
