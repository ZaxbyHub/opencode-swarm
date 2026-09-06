/**
 * Issue #2506 acceptance check C4 (AC4, NEW-SURFACE) — stall escalation:
 * actionable content, per-lane dedup, re-escalation after new activity, the
 * `pr_workflow_lane_watchdog` event shape, and evidence preserved through
 * abort/settle.
 *
 * Frozen contract pinned here:
 * - A lane whose session is busy/retry that produced fewer than
 *   `stall_min_steps` observable transcript steps AND fewer than
 *   `stall_token_threshold` estimated tokens within the last
 *   `stall_threshold_ms` gets exactly ONE escalation: a
 *   `pr_workflow_lane_watchdog` event plus a disclosure naming the lane, the
 *   observed steps/tokens, and a recommended operator action.
 * - Escalation is deduped per lane by a persisted last-escalation timestamp:
 *   no re-escalation unless new activity was observed since.
 * - `laneIds` on every watchdog event is bounded (<= 10).
 * - The activity observation is overridable through the gate seam
 *   (`_test_exports.laneLivenessWatchdog.readLaneActivity`), the repo's
 *   standard DI-seam pattern; the default is transcript-derived.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { closeProjectDb } from '../../../src/db/project-db.js';
import { LANE_LIVENESS_WATCHDOG_DEFAULTS } from '../../../src/hooks/lane-liveness-watchdog.js';
import {
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

/** Below the 30-minute horizon so only the stall path can fire. */
const STALLED_AGE_MS = 10 * 60_000;

const enabledWatchdog = {
	enabled: true,
	timeout_ms: 1_800_000,
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
};

const surface = (): WatchdogSurface =>
	gateInternals.laneLivenessWatchdog as unknown as WatchdogSurface;

let directory = '';
let restoreClock: () => void = () => {};
let originalReadLaneActivity: WatchdogSurface['readLaneActivity'];

beforeEach(() => {
	// A positive epoch (not 0) so the activity seam's lastActivityAtMs
	// offsets never produce negative timestamps.
	restoreClock = freezeClock({ fixedNow: 1_750_000_000_000 });
	directory = canonicalMkdtemp('lane-liveness-escalation-');
	gateInternals.resetTrackedStateCache();
	gateInternals.getSessionOps = () => null;
	originalReadLaneActivity = surface().readLaneActivity;
});

afterEach(async () => {
	restoreClock();
	surface().readLaneActivity = originalReadLaneActivity;
	gateInternals.resetTrackedStateCache();
	closeProjectDb(directory);
	await fs.rm(directory, { recursive: true, force: true });
});

/** Install a fake host that reports every given session as `busy`. */
function installBusyHost(sessionIds: string[]): unknown[] {
	const abortCalls: unknown[] = [];
	const map: Record<string, { type?: string }> = {};
	for (const id of sessionIds) map[id] = { type: 'busy' };
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

async function watchdogEvents(dir: string): Promise<Record<string, unknown>[]> {
	try {
		const text = await fs.readFile(
			path.join(dir, '.swarm', 'events.jsonl'),
			'utf-8',
		);
		return text
			.trim()
			.split('\n')
			.filter((line) => line.trim().length > 0)
			.map((line) => JSON.parse(line) as Record<string, unknown>)
			.filter((event) => event.type === 'pr_workflow_lane_watchdog');
	} catch {
		return [];
	}
}

async function seedStalledLane(
	sessionID: string,
	laneId: string,
	correlationId: string,
): Promise<void> {
	await recordOpenPrWorkflowLane(directory, sessionID, laneId, correlationId);
	await backdatePrWorkflowLane(directory, correlationId, STALLED_AGE_MS);
	installBusyHost([laneSubagentSessionId(correlationId)]);
}

describe('C4 — stall escalation fires once, with actionable content', () => {
	test('busy lane, zero transcript activity → ONE escalation event naming lane, steps/tokens, and an operator action', async () => {
		// No readLaneActivity override: the fixture wrote no transcript, and
		// the transcript-derived default must read that as zero activity.
		await seedStalledLane('sess-stall', 'intent-architecture', 'c-stall');

		const settlement = await settlePresumedStalePrWorkflowLanes(
			directory,
			'sess-stall',
			{ laneLivenessWatchdog: enabledWatchdog },
		);

		// Escalation is advisory: the lane is below the horizon and stays
		// open — it must NOT be settled or aborted by the escalation itself.
		expect(settlement.openLanes).toBe(1);
		expect(settlement.presumedStaleLaneIds).toEqual([]);
		expect(laneStatusOnDisk(directory, 'c-stall')).toBe('pending');

		const events = await watchdogEvents(directory);
		const escalations = events.filter((event) => event.escalated === true);
		expect(escalations.length).toBe(1);
		const event = escalations[0];
		expect(event.laneIds).toContain('intent-architecture');
		expect(event.stall).toMatchObject({
			stepsObserved: 0,
			estimatedTokens: 0,
			stallThresholdMs: 300_000,
			stallMinSteps: 5,
			stallTokenThreshold: 200,
		});
		// The event's stall thresholds ARE the contract defaults, not copies.
		const stall = event.stall as {
			stallThresholdMs: number;
			stallMinSteps: number;
			stallTokenThreshold: number;
		};
		expect(stall.stallThresholdMs).toBe(
			LANE_LIVENESS_WATCHDOG_DEFAULTS.stall_threshold_ms,
		);
		expect(stall.stallMinSteps).toBe(
			LANE_LIVENESS_WATCHDOG_DEFAULTS.stall_min_steps,
		);
		expect(stall.stallTokenThreshold).toBe(
			LANE_LIVENESS_WATCHDOG_DEFAULTS.stall_token_threshold,
		);
		// Actionable: the disclosure names the lane, quantifies the stall,
		// and recommends an operator action (inspect or force-abort).
		expect(`${event.disclosure}`).toContain('intent-architecture');
		expect(`${event.disclosure}`).toMatch(/inspect|abort/i);
		expect(`${event.disclosure}`).toMatch(/step|token/i);
		expect(event.sessionID).toBe('sess-stall');
		expect(typeof event.timestamp).toBe('string');
	});

	test('a progressing lane (enough steps or tokens) is NOT escalated', async () => {
		await seedStalledLane('sess-active', 'risk-security', 'c-active');
		surface().readLaneActivity = () => ({
			stepsObserved: 7,
			estimatedTokens: 900,
			lastActivityAtMs: Date.now() - 1_000,
		});

		await settlePresumedStalePrWorkflowLanes(directory, 'sess-active', {
			laneLivenessWatchdog: enabledWatchdog,
		});

		const events = await watchdogEvents(directory);
		expect(events.filter((event) => event.escalated === true)).toEqual([]);
	});

	test('steps alone above stall_min_steps suppress the escalation (both thresholds must be missed)', async () => {
		await seedStalledLane('sess-steps', 'correctness-state', 'c-steps');
		surface().readLaneActivity = () => ({
			stepsObserved: 5,
			estimatedTokens: 0,
		});

		await settlePresumedStalePrWorkflowLanes(directory, 'sess-steps', {
			laneLivenessWatchdog: enabledWatchdog,
		});

		expect(
			(await watchdogEvents(directory)).filter(
				(event) => event.escalated === true,
			),
		).toEqual([]);
	});
});

describe('C4 — dedup without new activity, re-escalation after activity', () => {
	test('evaluation sequence: escalate → dedup (durable across cache reset) → activity → re-escalate', async () => {
		await seedStalledLane('sess-dedup', 'intent-architecture', 'c-dedup');
		let activity: LaneActivity = {
			stepsObserved: 0,
			estimatedTokens: 0,
		};
		surface().readLaneActivity = () => activity;

		// Eval 1: stalled → exactly one escalation.
		await settlePresumedStalePrWorkflowLanes(directory, 'sess-dedup', {
			laneLivenessWatchdog: enabledWatchdog,
		});
		expect(
			(await watchdogEvents(directory)).filter(
				(event) => event.escalated === true,
			).length,
		).toBe(1);

		// Eval 2: still zero activity → deduped. The last-escalation marker
		// must be PERSISTED, so it survives a tracked-state cache reset. The
		// reset also restores the default host and activity seams (its
		// cross-file isolation contract); reinstall this test's fakes so the
		// evaluations continue against the same lane — the DEDUP BASELINE is
		// the durable thing under test, not the seams.
		gateInternals.resetTrackedStateCache();
		installBusyHost([laneSubagentSessionId('c-dedup')]);
		surface().readLaneActivity = () => activity;
		await settlePresumedStalePrWorkflowLanes(directory, 'sess-dedup', {
			laneLivenessWatchdog: enabledWatchdog,
		});
		expect(
			(await watchdogEvents(directory)).filter(
				(event) => event.escalated === true,
			).length,
		).toBe(1);

		// Eval 3: the lane produced real activity — no escalation while it
		// is progressing, and the observation resets the dedup baseline.
		activity = {
			stepsObserved: 6,
			estimatedTokens: 250,
			lastActivityAtMs: Date.now() - 500,
		};
		await settlePresumedStalePrWorkflowLanes(directory, 'sess-dedup', {
			laneLivenessWatchdog: enabledWatchdog,
		});
		expect(
			(await watchdogEvents(directory)).filter(
				(event) => event.escalated === true,
			).length,
		).toBe(1);

		// Eval 4: activity stopped again → this is a NEW stall, and the
		// re-nudge suppression no longer applies (re-escalation).
		activity = { stepsObserved: 0, estimatedTokens: 0 };
		await settlePresumedStalePrWorkflowLanes(directory, 'sess-dedup', {
			laneLivenessWatchdog: enabledWatchdog,
		});
		expect(
			(await watchdogEvents(directory)).filter(
				(event) => event.escalated === true,
			).length,
		).toBe(2);
	});
});

describe('C4 — event shape and evidence preservation', () => {
	test('every pr_workflow_lane_watchdog event carries the full frozen field set', async () => {
		await seedStalledLane('sess-shape', 'tests-falsifiability', 'c-shape');

		await settlePresumedStalePrWorkflowLanes(directory, 'sess-shape', {
			laneLivenessWatchdog: enabledWatchdog,
		});

		const events = await watchdogEvents(directory);
		expect(events.length).toBeGreaterThanOrEqual(1);
		for (const event of events) {
			expect(typeof event.condition).toBe('string');
			expect(Array.isArray(event.laneIds)).toBe(true);
			expect(event.laneIds.length).toBeLessThanOrEqual(10);
			expect(Number.isInteger(event.effectiveHorizonMs)).toBe(true);
			expect(
				['watchdog-timeout', 'reachability-floor'].includes(
					`${event.horizonSource}`,
				),
			).toBe(true);
			expect(typeof event.escalated).toBe('boolean');
			expect(typeof event.disclosure).toBe('string');
			expect(event.sessionID).toBe('sess-shape');
			expect(typeof event.timestamp).toBe('string');
		}
	});

	test('11 stalled lanes: laneIds stay bounded (<= 10) per event', async () => {
		const sessionIds: string[] = [];
		for (let i = 0; i < 11; i += 1) {
			await recordOpenPrWorkflowLane(
				directory,
				'sess-bound',
				`lane-bound-${i}`,
				`c-bound-${i}`,
			);
			await backdatePrWorkflowLane(directory, `c-bound-${i}`, STALLED_AGE_MS);
			sessionIds.push(laneSubagentSessionId(`c-bound-${i}`));
		}
		installBusyHost(sessionIds);

		await settlePresumedStalePrWorkflowLanes(directory, 'sess-bound', {
			laneLivenessWatchdog: enabledWatchdog,
		});

		const events = await watchdogEvents(directory);
		expect(events.length).toBeGreaterThanOrEqual(1);
		for (const event of events) {
			expect((event.laneIds as unknown[]).length).toBeLessThanOrEqual(10);
		}
	});

	test('abort/settle preserves prior evidence: every prior events.jsonl line survives and still parses', async () => {
		// A deadline-expiry settlement appends its evidence; it must never
		// truncate or corrupt what the substrate already recorded.
		await recordOpenPrWorkflowLane(
			directory,
			'sess-evidence',
			'intent-architecture',
			'c-evidence',
		);
		await backdatePrWorkflowLane(
			directory,
			'c-evidence',
			35 * 60_000, // past the effective 30-minute horizon
		);
		installBusyHost([laneSubagentSessionId('c-evidence')]);

		await settlePresumedStalePrWorkflowLanes(directory, 'sess-evidence', {
			laneLivenessWatchdog: enabledWatchdog,
		});

		const lines = (
			await fs.readFile(path.join(directory, '.swarm', 'events.jsonl'), 'utf-8')
		)
			.trim()
			.split('\n')
			.filter((line) => line.trim().length > 0);
		const parsed = lines.map(
			(line) => JSON.parse(line) as Record<string, unknown>,
		);
		// The substrate's own settlement audit record is still there...
		expect(
			parsed.some((event) => event.type === 'pr_workflow_lanes_presumed_stale'),
		).toBe(true);
		// ...and the watchdog's typed event is present alongside it — both
		// survive the abort/settle with every line intact and parseable.
		expect(
			parsed.some((event) => event.type === 'pr_workflow_lane_watchdog'),
		).toBe(true);
		expect(laneStatusOnDisk(directory, 'c-evidence')).toBe('stale');
	});
});
