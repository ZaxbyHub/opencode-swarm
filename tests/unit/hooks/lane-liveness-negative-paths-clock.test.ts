/**
 * Issue #2506 review round 2, negative-path coverage (companion file to
 * lane-liveness-negative-paths.test.ts, split to stay under the FR-006
 * 500-line cap): the force-abort finalize sweep at the EFFECTIVE horizon
 * (PRR-002) and the live-seam re-arm disjunct under a FULLY frozen clock
 * (Date.now AND toISOString), which the C4 file cannot exercise (PRR-014).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { closeProjectDb } from '../../../src/db/project-db.js';
import {
	_test_exports as gateInternals,
	activatePrWorkflow,
	abortPrWorkflow,
	settlePresumedStalePrWorkflowLanes,
} from '../../../src/hooks/pr-workflow-gate.js';
import {
	backdatePrWorkflowLane,
	laneStatusOnDisk,
	laneSubagentSessionId,
	recordOpenPrWorkflowLane,
} from '../../helpers/pr-workflow-lane-fixtures.js';
import { freezeClock } from '../../helpers/test-clock.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

/** Between a 60s watchdog horizon and the 30-minute floor. */
const MID_AGE_MS = 5 * 60_000;
const FIXED_NOW = 1_750_000_000_000;

const watchdogWith = (timeoutMs: number) => ({
	enabled: true,
	timeout_ms: timeoutMs,
	stall_threshold_ms: 300_000,
	stall_min_steps: 5,
	stall_token_threshold: 200,
});

type LaneActivity = {
	stepsObserved: number;
	estimatedTokens: number;
	lastActivityAtMs?: number;
};

type WatchdogSurface = {
	readLaneActivity?: (
		directory: string,
		subagentSessionId: string,
	) => LaneActivity | null | Promise<LaneActivity | null>;
};

const surface = (): WatchdogSurface =>
	gateInternals.laneLivenessWatchdog as unknown as WatchdogSurface;

const stallOnly = {
	enabled: true,
	timeout_ms: 0,
	stall_threshold_ms: 300_000,
	stall_min_steps: 5,
	stall_token_threshold: 200,
};

let directory = '';
let restoreClock: () => void = () => {};

beforeEach(() => {
	restoreClock = freezeClock({ fixedNow: FIXED_NOW });
	directory = canonicalMkdtemp('lane-liveness-rearm-fin-');
	gateInternals.resetTrackedStateCache();
	gateInternals.getSessionOps = () => null;
});

afterEach(async () => {
	restoreClock();
	gateInternals.resetTrackedStateCache();
	closeProjectDb(directory);
	await fs.rm(directory, { recursive: true, force: true });
});

async function watchdogEvents(dir: string): Promise<Record<string, unknown>[]> {
	try {
		const text = await fs.readFile(
			path.join(dir, '.swarm', 'events.jsonl'),
			'utf-8',
		);
		return text
			.split(String.fromCharCode(10))
			.filter((line) => line.trim().length > 0)
			.map((line) => JSON.parse(line) as Record<string, unknown>)
			.filter((event) => event.type === 'pr_workflow_lane_watchdog');
	} catch {
		return [];
	}
}

function installBusyHost(
	sessionIds: string[],
	type: 'busy' | 'retry' = 'busy',
): unknown[] {
	return installTypedHost(sessionIds, type);
}

function installTypedHost(
	sessionIds: string[],
	type: 'busy' | 'retry',
): unknown[] {
	const abortCalls: unknown[] = [];
	const map: Record<string, { type?: string }> = {};
	for (const id of sessionIds) map[id] = { type };
	gateInternals.getSessionOps = () =>
		({
			status: async () => ({ data: map }),
			abort: async (args: unknown) => {
				abortCalls.push(args);
				return {};
			},
		}) as unknown as ReturnType<typeof gateInternals.getSessionOps>;
	return abortCalls;
}

describe('PRR-014 — the live-seam re-arm disjunct fires under a fully frozen clock', () => {
	test('activity since the durable escalation (same frozen ms) re-arms the lane', async () => {
		// The C4 file freezes Date.now only, so the escalation events it writes
		// carry REAL-clock timestamps and the live-seam disjunct
		// (lastActivityAtMs >= lastEscalation) is structurally always false
		// there. This test re-freezes WITH isoNow so event timestamps share the
		// frozen clock and the disjunct becomes exercisable.
		restoreClock();
		restoreClock = freezeClock({
			fixedNow: FIXED_NOW,
			isoNow: new Date(FIXED_NOW).toISOString(),
		});
		await recordOpenPrWorkflowLane(
			directory,
			'sess-rearm',
			'risk-security',
			'c-rearm',
		);
		installBusyHost(['c-rearm']);
		const original = surface().readLaneActivity;
		surface().readLaneActivity = (async () => ({
			stepsObserved: 0,
			estimatedTokens: 0,
		})) as unknown as typeof original;
		try {
			// Pass 1: zero activity -> escalated once. Event timestamp is
			// frozen to FIXED_NOW (isoNow frozen too, unlike the C4 file).
			await settlePresumedStalePrWorkflowLanes(directory, 'sess-rearm', {
				laneLivenessWatchdog: stallOnly,
			});
			expect(
				(await watchdogEvents(directory)).filter(
					(event) => event.escalated === true,
				).length,
			).toBe(1);

			// Pass 2: the seam itself reports activity AT the frozen now —
			// lastActivityAtMs >= lastEscalation (same millisecond), so the
			// live-seam disjunct alone must re-arm the lane.
			surface().readLaneActivity = (async () => ({
				stepsObserved: 0,
				estimatedTokens: 0,
				lastActivityAtMs: FIXED_NOW,
			})) as unknown as typeof original;
			await settlePresumedStalePrWorkflowLanes(directory, 'sess-rearm', {
				laneLivenessWatchdog: stallOnly,
			});
			expect(
				(await watchdogEvents(directory)).filter(
					(event) => event.escalated === true,
				).length,
			).toBe(2);
		} finally {
			surface().readLaneActivity = original;
		}
	});
});

describe('PRR-002 — the force-abort finalize sweep runs at the effective horizon', () => {
	test('retained retry lane between the watchdog horizon and the floor IS finalized', async () => {
		await activatePrWorkflow(directory, 'sess-finalize', 'PR_REVIEW');
		await recordOpenPrWorkflowLane(
			directory,
			'sess-finalize',
			'intent-architecture',
			'c-fin',
		);
		await backdatePrWorkflowLane(directory, 'c-fin', MID_AGE_MS);
		// A RETRY-status lane past the 60s horizon is probe-retained (the
		// deadline never aborts provider retries) — the exact gap-window lane
		// the old floor-based finalize sweep left pending forever.
		const abortCalls: unknown[] = [];
		const map: Record<string, { type?: string }> = {
			[laneSubagentSessionId('c-fin')]: { type: 'retry' },
		};
		gateInternals.getSessionOps = () =>
			({
				status: async () => ({ data: map }),
				abort: async (args: unknown) => {
					abortCalls.push(args);
					return {};
				},
			}) as unknown as ReturnType<typeof gateInternals.getSessionOps>;

		const settled = await settlePresumedStalePrWorkflowLanes(
			directory,
			'sess-finalize',
			{
				laneLivenessWatchdog: watchdogWith(60_000),
			},
		);
		expect(settled.probedAliveLaneIds).toEqual(['intent-architecture']);
		expect(laneStatusOnDisk(directory, 'c-fin')).toBe('pending');

		// Human force abort WITH the same policy: the finalize sweep must run
		// at the 60s effective horizon (not the 30-minute floor), so the
		// 5-minute-old retained lane is finalized and the session restartable.
		await abortPrWorkflow(directory, 'sess-finalize', {
			kind: 'force',
			reason: 'operator override',
			laneLiveness: { laneLivenessWatchdog: watchdogWith(60_000) },
		});
		expect(laneStatusOnDisk(directory, 'c-fin')).toBe('stale');
	});
});
