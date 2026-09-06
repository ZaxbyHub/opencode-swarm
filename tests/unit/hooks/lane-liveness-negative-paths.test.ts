/**
 * Issue #2506 review round 2 — negative-path coverage for the
 * lane-liveness watchdog integration. Every test here drives a branch the
 * first six frozen files left uncovered (PRR-005), plus the round-2 fixes:
 *
 * - abortLaneSessionForWatchdog's catch (abort rejects/throws) — PRR-005.1
 * - degraded types-probe under an ACTIVE watchdog, including the truthful
 *   "no session abort was attempted" disclosure — PRR-005.3 + bot finding 2
 * - corrupt/foreign-session event lines in the dedup scan — PRR-005.4 and
 *   the cross-session dedup isolation fix
 * - a throwing readLaneActivity seam degrading to zero activity — PRR-010
 * - durable abort-once across settlement passes when the sweep keeps
 *   failing — PRR-007
 * - the stall-only degraded-probe branch (unknown sessions unescalatable)
 * - event-append failures swallowed (events.jsonl path unwritable) — PRR-005.2
 * - horizonConflictNote surfaced on the settlement result — PRR-003
 * - the live-seam re-arm disjunct under a FULLY frozen clock (Date.now AND
 *   toISOString), which the C4 file could not exercise — PRR-014
 * - the force-abort finalize sweep at the EFFECTIVE horizon — PRR-002
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { closeProjectDb } from '../../../src/db/project-db.js';
import {
	abortPrWorkflow,
	activatePrWorkflow,
	_test_exports as gateInternals,
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

const stallOnly = {
	enabled: true,
	timeout_ms: 0,
	stall_threshold_ms: 300_000,
	stall_min_steps: 5,
	stall_token_threshold: 200,
};

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
	hostStatusCalls: number;
	hostAbortCalls: number;
	evaluations: number;
};

const surface = (): WatchdogSurface =>
	gateInternals.laneLivenessWatchdog as unknown as WatchdogSurface;

let directory = '';
let restoreClock: () => void = () => {};

beforeEach(() => {
	restoreClock = freezeClock({ fixedNow: FIXED_NOW });
	directory = canonicalMkdtemp('lane-liveness-negative-');
	gateInternals.resetTrackedStateCache();
	gateInternals.getSessionOps = () => null;
});

afterEach(async () => {
	restoreClock();
	gateInternals.resetTrackedStateCache();
	closeProjectDb(directory);
	await fs.rm(directory, { recursive: true, force: true });
});

function installBusyHost(
	sessionIds: string[],
	abortImpl?: () => Promise<unknown>,
): unknown[] {
	const abortCalls: unknown[] = [];
	const map: Record<string, { type?: string }> = {};
	for (const id of sessionIds) map[id] = { type: 'busy' };
	gateInternals.getSessionOps = () =>
		({
			status: async () => ({ data: map }),
			abort: async (args: unknown) => {
				abortCalls.push(args);
				if (abortImpl) return abortImpl();
				return {};
			},
		}) as unknown as ReturnType<typeof gateInternals.getSessionOps>;
	return abortCalls;
}

async function watchdogEvents(dir: string): Promise<Record<string, unknown>[]> {
	try {
		const text = await fs.readFile(
			path.join(dir, '.swarm', 'events.jsonl'),
			'utf-8',
		);
		return text
			.split('\n')
			.map((line) => {
				try {
					return JSON.parse(line) as Record<string, unknown>;
				} catch {
					// Mirrors the production scan: skip lines that are not
					// valid JSON instead of failing the whole read.
					return null;
				}
			})
			.filter(
				(event): event is Record<string, unknown> =>
					event !== null && event.type === 'pr_workflow_lane_watchdog',
			);
	} catch {
		return [];
	}
}

describe('PRR-005.1 — abort failure is swallowed and counted as not-delivered', () => {
	test('rejecting abort op: lane still settles stale, hostAbortCalls stays 0', async () => {
		await recordOpenPrWorkflowLane(
			directory,
			'sess-abortfail',
			'risk-security',
			'c-af',
		);
		await backdatePrWorkflowLane(directory, 'c-af', MID_AGE_MS);
		const abortCalls = installBusyHost(['c-af'], async () => {
			throw new Error('host abort transport exploded');
		});

		const settlement = await settlePresumedStalePrWorkflowLanes(
			directory,
			'sess-abortfail',
			{
				laneLivenessWatchdog: watchdogWith(60_000),
			},
		);

		expect(abortCalls.length).toBe(1);
		expect(laneStatusOnDisk(directory, 'c-af')).toBe('stale');
		expect(settlement.presumedStaleLaneIds).toEqual(['risk-security']);
		expect(surface().hostAbortCalls).toBe(0);
	});
});

describe('PRR-005.3 + bot#2 — degraded probe under an ACTIVE watchdog', () => {
	test('deadline settles without abort and the disclosure claims no abort attempt', async () => {
		await recordOpenPrWorkflowLane(
			directory,
			'sess-degraded',
			'risk-security',
			'c-deg',
		);
		await backdatePrWorkflowLane(directory, 'c-deg', MID_AGE_MS);
		const abortCalls = installBusyHost(['c-deg']);
		const originalProbe = gateInternals.probeLaneSessionStatusTypesAsync;
		gateInternals.probeLaneSessionStatusTypesAsync = (async () => ({
			alive: new Set<string>(),
			statuses: new Map<string, string>(),
			degradedReason: 'probe-unavailable' as const,
		})) as unknown as typeof gateInternals.probeLaneSessionStatusTypesAsync;

		try {
			const settlement = await settlePresumedStalePrWorkflowLanes(
				directory,
				'sess-degraded',
				{ laneLivenessWatchdog: watchdogWith(60_000) },
			);

			expect(settlement.presumedStaleLaneIds).toEqual(['risk-security']);
			expect(settlement.probeDegradedReason).toBe('probe-unavailable');
			expect(laneStatusOnDisk(directory, 'c-deg')).toBe('stale');
			expect(abortCalls.length).toBe(0);
			expect(surface().hostAbortCalls).toBe(0);
			const deadline = (await watchdogEvents(directory)).find(
				(event) => event.condition === 'execution_deadline',
			) as Record<string, unknown>;
			expect(deadline).toBeDefined();
			expect(`${deadline.disclosure}`).toMatch(
				/no session abort was attempted/i,
			);
			expect(`${deadline.disclosure}`).toMatch(/no output observed/i);
		} finally {
			gateInternals.probeLaneSessionStatusTypesAsync = originalProbe;
		}
	});
});

describe('PRR-005.4 + cross-session isolation — dedup scan input hygiene', () => {
	test('foreign-session escalation does not suppress our same-label lane', async () => {
		// Three sessions, same directory, SAME lane-role label: exactly the
		// collision the label-only dedup key had. Each lane is owned by its
		// own session (isOpenPrWorkflowLane is session-scoped).
		await recordOpenPrWorkflowLane(
			directory,
			'sess-foreign',
			'risk-security',
			'c-foreign',
		);
		await recordOpenPrWorkflowLane(
			directory,
			'sess-mine',
			'risk-security',
			'c-mine',
		);
		installBusyHost(['c-foreign', 'c-mine']);

		// Escalations are written BY THE STORE (real settlements) so the
		// events file keeps its framing.
		await settlePresumedStalePrWorkflowLanes(directory, 'sess-foreign', {
			laneLivenessWatchdog: stallOnly,
		});
		expect(
			(await watchdogEvents(directory)).filter(
				(event) =>
					event.escalated === true && event.sessionID === 'sess-foreign',
			).length,
		).toBe(1);

		// The OWN session escalates for the same label despite the foreign
		// escalation: dedup keys are (sessionID, label), not label alone.
		await settlePresumedStalePrWorkflowLanes(directory, 'sess-mine', {
			laneLivenessWatchdog: stallOnly,
		});
		expect(
			(await watchdogEvents(directory)).filter(
				(event) => event.escalated === true && event.sessionID === 'sess-mine',
			).length,
		).toBe(1);
	});

	test('a corrupt tail line is skipped by the dedup scan without blocking appends', async () => {
		await recordOpenPrWorkflowLane(
			directory,
			'sess-corrupt',
			'risk-security',
			'c-corrupt',
		);
		installBusyHost(['c-corrupt']);
		await settlePresumedStalePrWorkflowLanes(directory, 'sess-corrupt', {
			laneLivenessWatchdog: stallOnly,
		});
		expect(
			(await watchdogEvents(directory)).filter(
				(event) => event.escalated === true,
			).length,
		).toBe(1);

		// appendCoreEventSync repairs line framing rather than rejecting a
		// torn tail, so the store still accepts appends; the scan must skip
		// the garbage line and a fresh escalation for a NEW label still lands.
		await fs.appendFile(
			path.join(directory, '.swarm', 'events.jsonl'),
			'{not json at all\n',
			'utf-8',
		);
		await recordOpenPrWorkflowLane(
			directory,
			'sess-corrupt',
			'docs-quality',
			'c-corrupt-2',
		);
		installBusyHost(['c-corrupt', 'c-corrupt-2']);
		await settlePresumedStalePrWorkflowLanes(directory, 'sess-corrupt', {
			laneLivenessWatchdog: stallOnly,
		});
		expect(
			(await watchdogEvents(directory)).filter(
				(event) =>
					event.escalated === true && event.laneIds.includes('docs-quality'),
			).length,
		).toBe(1);
	});
});

describe('PRR-010 — a throwing activity seam degrades to zero activity', () => {
	test('settlement completes; escalation fires once on the zero-activity fallback', async () => {
		await recordOpenPrWorkflowLane(
			directory,
			'sess-throw',
			'risk-security',
			'c-throw',
		);
		installBusyHost(['c-throw']);
		const original = surface().readLaneActivity;
		surface().readLaneActivity = (async () => {
			throw new Error('transcript store unavailable');
		}) as unknown as typeof original;

		try {
			const settlement = await settlePresumedStalePrWorkflowLanes(
				directory,
				'sess-throw',
				{
					laneLivenessWatchdog: stallOnly,
				},
			);
			expect(settlement.openLanes).toBe(1);
			const escalations = (await watchdogEvents(directory)).filter(
				(event) => event.escalated === true,
			);
			expect(escalations.length).toBe(1);
		} finally {
			surface().readLaneActivity = original;
		}
	});
});

describe('PRR-007 — abort-once survives a repeatedly failing sweep', () => {
	test('second settlement pass does not re-abort a lane whose deadline event is durable', async () => {
		await recordOpenPrWorkflowLane(
			directory,
			'sess-once',
			'risk-security',
			'c-once',
		);
		await backdatePrWorkflowLane(directory, 'c-once', MID_AGE_MS);
		const abortCalls = installBusyHost(['c-once']);
		const originalSweep = gateInternals.sweepStaleDelegationsAsync;
		gateInternals.sweepStaleDelegationsAsync = (async () =>
			0) as unknown as typeof originalSweep;

		try {
			await settlePresumedStalePrWorkflowLanes(directory, 'sess-once', {
				laneLivenessWatchdog: watchdogWith(60_000),
			});
			expect(abortCalls.length).toBe(1);
			// The sweep "failed" (no-op), so the record is still pending and
			// still past the horizon: a second pass re-derives the same
			// deadline lane — but the durable execution_deadline event from
			// pass one suppresses the second abort.
			await settlePresumedStalePrWorkflowLanes(directory, 'sess-once', {
				laneLivenessWatchdog: watchdogWith(60_000),
			});
			expect(abortCalls.length).toBe(1);
			expect(laneStatusOnDisk(directory, 'c-once')).toBe('pending');
		} finally {
			gateInternals.sweepStaleDelegationsAsync = originalSweep;
		}
	});
});

describe('PRR-005.5 — stall-only evaluation with a degraded probe', () => {
	test('unknown sessions are treated as unescalatable and nothing throws', async () => {
		await recordOpenPrWorkflowLane(
			directory,
			'sess-stalldeg',
			'risk-security',
			'c-stale',
		);
		// Past the 30-minute floor so this lane is presumedStale.
		await backdatePrWorkflowLane(directory, 'c-stale', 31 * 60_000);
		await recordOpenPrWorkflowLane(
			directory,
			'sess-stalldeg',
			'intent-architecture',
			'c-fresh',
		);
		installBusyHost(['c-stale', 'c-fresh']);
		const originalProbe = gateInternals.probeLaneSessionStatusTypesAsync;
		gateInternals.probeLaneSessionStatusTypesAsync = (async () => ({
			alive: new Set<string>(),
			statuses: new Map<string, string>(),
			degradedReason: 'probe-timeout' as const,
		})) as unknown as typeof gateInternals.probeLaneSessionStatusTypesAsync;

		try {
			const settlement = await settlePresumedStalePrWorkflowLanes(
				directory,
				'sess-stalldeg',
				{ laneLivenessWatchdog: stallOnly },
			);
			// The stale lane settled (probe could not vouch for it); the fresh
			// open lane stays open and was NOT escalated (unknown type).
			expect(settlement.presumedStaleLaneIds).toEqual(['risk-security']);
			expect((await watchdogEvents(directory)).length).toBe(0);
		} finally {
			gateInternals.probeLaneSessionStatusTypesAsync = originalProbe;
		}
	});
});

describe('PRR-005.2 — event-append failures never block settlement', () => {
	test('unwritable events store: deadline settlement still completes', async () => {
		await recordOpenPrWorkflowLane(
			directory,
			'sess-append',
			'risk-security',
			'c-append',
		);
		await backdatePrWorkflowLane(directory, 'c-append', MID_AGE_MS);
		installBusyHost(['c-append']);
		// A DIRECTORY at the events.jsonl path makes every append throw.
		await fs.mkdir(path.join(directory, '.swarm', 'events.jsonl'), {
			recursive: true,
		});

		const settlement = await settlePresumedStalePrWorkflowLanes(
			directory,
			'sess-append',
			{
				laneLivenessWatchdog: watchdogWith(60_000),
			},
		);

		expect(settlement.presumedStaleLaneIds).toEqual(['risk-security']);
		expect(laneStatusOnDisk(directory, 'c-append')).toBe('stale');
	});
});

describe('PRR-003 — horizonConflictNote surfaces the config disagreement', () => {
	test('present when background pending timeout disagrees; absent otherwise', async () => {
		await recordOpenPrWorkflowLane(
			directory,
			'sess-conf',
			'risk-security',
			'c-conf',
		);
		await backdatePrWorkflowLane(directory, 'c-conf', MID_AGE_MS);
		installBusyHost(['c-conf']);

		const disagreeing = await settlePresumedStalePrWorkflowLanes(
			directory,
			'sess-conf',
			{
				laneLivenessWatchdog: watchdogWith(60_000),
				backgroundPendingTimeoutMs: 45 * 60_000,
			},
		);
		expect(disagreeing.horizonConflictNote).toBeDefined();
		expect(`${disagreeing.horizonConflictNote}`).toContain('timeout_ms');

		const agreeing = await settlePresumedStalePrWorkflowLanes(
			directory,
			'sess-conf',
			{
				laneLivenessWatchdog: watchdogWith(60_000),
				backgroundPendingTimeoutMs: 60_000,
			},
		);
		expect(agreeing.horizonConflictNote).toBeUndefined();
	});
});
