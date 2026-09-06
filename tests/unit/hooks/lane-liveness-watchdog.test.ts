/**
 * Issue #2506 acceptance check C1 (AC1, NEW-SURFACE) — the lane-liveness
 * watchdog configuration surface, the gate seam surface, and the default-off
 * no-op contract for the watchdog evaluation itself.
 *
 * Frozen contract pinned here:
 * - `src/config/schema.ts` gains a top-level `lane_liveness_watchdog` section
 *   backed by `LaneLivenessWatchdogConfigSchema` with the exact defaults and
 *   bounds (0 accepted everywhere; out-of-range rejected; `enabled` defaults
 *   to false).
 * - `src/hooks/lane-liveness-watchdog.ts` exports
 *   `LANE_LIVENESS_WATCHDOG_DEFAULTS` carrying those same five defaults.
 * - `src/hooks/pr-workflow-gate.ts` `_test_exports.laneLivenessWatchdog`
 *   exposes `resolveEffectivePrLaneHorizonMs`,
 *   `classifyLaneLivenessCondition`, `evaluateLaneLivenessWatchdog`, and the
 *   budget counters `hostStatusCalls` / `hostAbortCalls` / `evaluations`.
 * - With the watchdog disabled (the default), the watchdog evaluation is a
 *   NO-OP: existing settlement behavior is unchanged and the watchdog emits
 *   no events and records no activity of its own.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
	LaneLivenessWatchdogConfigSchema,
	PluginConfigSchema,
} from '../../../src/config/schema.js';
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
	STALE_LANE_AGE_MS,
} from '../../helpers/pr-workflow-lane-fixtures.js';
import { freezeClock } from '../../helpers/test-clock.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

/**
 * Structural view of the gate seam surface. Cast through `unknown` on
 * purpose: the contract freezes the MEMBER NAMES, not the declared TS types,
 * so this file must not depend on how the implementation types them.
 */
type WatchdogSurface = {
	resolveEffectivePrLaneHorizonMs: (...args: unknown[]) => unknown;
	classifyLaneLivenessCondition: (...args: unknown[]) => unknown;
	evaluateLaneLivenessWatchdog: (...args: unknown[]) => unknown;
	hostStatusCalls: number;
	hostAbortCalls: number;
	evaluations: number;
};

const surface = (): WatchdogSurface =>
	gateInternals.laneLivenessWatchdog as unknown as WatchdogSurface;

/** The five frozen defaults from issue #2506 AC1 (0 disables the feature). */
const CONTRACT_DEFAULTS = {
	enabled: false,
	timeout_ms: 1_800_000,
	stall_threshold_ms: 300_000,
	stall_min_steps: 5,
	stall_token_threshold: 200,
};

let directory = '';
let restoreClock: () => void = () => {};

beforeEach(() => {
	restoreClock = freezeClock();
	directory = canonicalMkdtemp('lane-liveness-watchdog-');
	gateInternals.resetTrackedStateCache();
	gateInternals.getSessionOps = () => null;
});

afterEach(async () => {
	restoreClock();
	gateInternals.resetTrackedStateCache();
	closeProjectDb(directory);
	await fs.rm(directory, { recursive: true, force: true });
});

describe('C1 — lane_liveness_watchdog config schema (AC1)', () => {
	test('the section exists on PluginConfigSchema and parses to the frozen defaults', () => {
		expect(PluginConfigSchema.shape.lane_liveness_watchdog).toBeDefined();
		const parsed = PluginConfigSchema.parse({
			lane_liveness_watchdog: {},
		});
		expect(parsed.lane_liveness_watchdog).toEqual(CONTRACT_DEFAULTS);
	});

	test('LANE_LIVENESS_WATCHDOG_DEFAULTS equals the five frozen contract values', () => {
		expect(LANE_LIVENESS_WATCHDOG_DEFAULTS).toEqual(CONTRACT_DEFAULTS);
	});

	test('the standalone schema and the section agree on the defaults', () => {
		expect(LaneLivenessWatchdogConfigSchema.parse({})).toEqual(
			PluginConfigSchema.parse({ lane_liveness_watchdog: {} })
				.lane_liveness_watchdog,
		);
	});

	test('default-off: an omitted or empty section is never enabled', () => {
		const omitted = PluginConfigSchema.parse({});
		expect(omitted.lane_liveness_watchdog?.enabled ?? false).toBe(false);
		const empty = PluginConfigSchema.parse({ lane_liveness_watchdog: {} });
		expect(empty.lane_liveness_watchdog?.enabled).toBe(false);
	});

	test('every knob accepts 0 (0 disables the relevant feature)', () => {
		const zeros = {
			enabled: true,
			timeout_ms: 0,
			stall_threshold_ms: 0,
			stall_min_steps: 0,
			stall_token_threshold: 0,
		};
		expect(LaneLivenessWatchdogConfigSchema.safeParse(zeros).success).toBe(
			true,
		);
		expect(
			PluginConfigSchema.safeParse({ lane_liveness_watchdog: zeros }).success,
		).toBe(true);
	});

	test('out-of-range and mistyped values are rejected', () => {
		const bad = [
			{ timeout_ms: -1 },
			{ timeout_ms: 86_400_001 },
			{ timeout_ms: 1.5 },
			{ stall_threshold_ms: -1 },
			{ stall_threshold_ms: 86_400_001 },
			{ stall_min_steps: -1 },
			{ stall_min_steps: 10_001 },
			{ stall_token_threshold: -1 },
			{ stall_token_threshold: 1_000_001 },
			{ enabled: 'yes' },
		];
		for (const override of bad) {
			expect(
				LaneLivenessWatchdogConfigSchema.safeParse({
					...CONTRACT_DEFAULTS,
					...override,
				}).success,
			).toBe(false);
		}
	});

	test('the boundary maximum values are accepted', () => {
		expect(
			LaneLivenessWatchdogConfigSchema.safeParse({
				enabled: true,
				timeout_ms: 86_400_000,
				stall_threshold_ms: 86_400_000,
				stall_min_steps: 10_000,
				stall_token_threshold: 1_000_000,
			}).success,
		).toBe(true);
	});
});

describe('C1 — watchdog surface reachable from the gate _test_exports seam', () => {
	test('the surface exposes the three functions and the three budget counters', () => {
		const s = surface();
		expect(gateInternals.laneLivenessWatchdog).toBeDefined();
		expect(typeof s.resolveEffectivePrLaneHorizonMs).toBe('function');
		expect(typeof s.classifyLaneLivenessCondition).toBe('function');
		expect(typeof s.evaluateLaneLivenessWatchdog).toBe('function');
		expect(typeof s.hostStatusCalls).toBe('number');
		expect(typeof s.hostAbortCalls).toBe('number');
		expect(typeof s.evaluations).toBe('number');
	});

	test('the gate surface behaves like the module exports (no stale copy)', async () => {
		const { resolveEffectivePrLaneHorizonMs, classifyLaneLivenessCondition } =
			await import('../../../src/hooks/lane-liveness-watchdog.js');
		const enabled = {
			...CONTRACT_DEFAULTS,
			enabled: true,
			timeout_ms: 600_000,
		};
		expect(
			surface().resolveEffectivePrLaneHorizonMs(enabled, 1_200_000),
		).toEqual(resolveEffectivePrLaneHorizonMs(enabled, 1_200_000));
		expect(
			surface().classifyLaneLivenessCondition({
				sessionStatusType: 'busy',
				recordStatus: 'pending',
				waitBudgetExpired: false,
				exceededEffectiveHorizon: true,
			}),
		).toBe(
			classifyLaneLivenessCondition({
				sessionStatusType: 'busy',
				recordStatus: 'pending',
				waitBudgetExpired: false,
				exceededEffectiveHorizon: true,
			}),
		);
	});
});

describe('C1 — disabled watchdog is a no-op for the watchdog evaluation itself', () => {
	test('a stale busy lane with the watchdog off is retained and produces zero watchdog activity', async () => {
		// The #2251 substrate behavior must be observable unchanged: the lane
		// is past the 30-minute reachability floor, its session answers
		// `busy`, so the probe retains it.
		await recordOpenPrWorkflowLane(
			directory,
			'sess-c1-noop',
			'intent-architecture',
			'c-c1-noop',
		);
		await backdatePrWorkflowLane(directory, 'c-c1-noop', STALE_LANE_AGE_MS);
		let abortCalls = 0;
		gateInternals.getSessionOps = () =>
			({
				status: async () => ({
					data: { [laneSubagentSessionId('c-c1-noop')]: { type: 'busy' } },
				}),
				abort: async () => {
					abortCalls += 1;
					return {};
				},
			}) as unknown as ReturnType<typeof gateInternals.getSessionOps>;

		// Two-argument call: no watchdog options threaded, so the disabled
		// default applies. This is the exact call shape every existing caller
		// uses today.
		const settlement = await settlePresumedStalePrWorkflowLanes(
			directory,
			'sess-c1-noop',
		);

		expect(settlement.openLanes).toBe(1);
		expect(settlement.probedAliveLaneIds).toEqual(['intent-architecture']);
		expect(laneStatusOnDisk(directory, 'c-c1-noop')).toBe('pending');
		expect(abortCalls).toBe(0);
		const eventsText = await fs
			.readFile(path.join(directory, '.swarm', 'events.jsonl'), 'utf-8')
			.catch(() => '');
		const watchdogEvents = eventsText
			.split('\n')
			.filter((line) => line.includes('pr_workflow_lane_watchdog'));
		expect(watchdogEvents).toEqual([]);
		const s = surface();
		expect(s.evaluations).toBe(0);
		expect(s.hostStatusCalls).toBe(0);
		expect(s.hostAbortCalls).toBe(0);
	});

	test('an explicit enabled:false config threaded through settlement options is equally inert', async () => {
		await recordOpenPrWorkflowLane(
			directory,
			'sess-c1-off',
			'risk-security',
			'c-c1-off',
		);
		await backdatePrWorkflowLane(directory, 'c-c1-off', STALE_LANE_AGE_MS);
		gateInternals.getSessionOps = () => null;

		const settlement = await settlePresumedStalePrWorkflowLanes(
			directory,
			'sess-c1-off',
			{ laneLivenessWatchdog: { ...CONTRACT_DEFAULTS, enabled: false } },
		);

		// No host, no watchdog: the age-only reachability floor settles the
		// lane exactly as it does today.
		expect(settlement.presumedStaleLaneIds).toEqual(['risk-security']);
		expect(laneStatusOnDisk(directory, 'c-c1-off')).toBe('stale');
		expect(surface().evaluations).toBe(0);
		expect(surface().hostAbortCalls).toBe(0);
	});
});

/**
 * Plan-critic round 1 (HIGH): the enabled x 0-disables cross-product must be
 * pinned cell-by-cell, not implied by two endpoint fixtures. Semantics frozen
 * here — a feature knob at 0 disables THAT feature regardless of `enabled`,
 * and `enabled: false` disables the whole watchdog regardless of knobs:
 *
 * - deadlineActive(cell)  = cell.enabled && cell.timeout_ms > 0
 * - stallActive(cell)     = cell.enabled && cell.stall_threshold_ms > 0 &&
 *   cell.stall_min_steps > 0 && cell.stall_token_threshold > 0
 * - anyWatchdogWork(cell) = deadlineActive || stallActive; when false the
 *   evaluation is a no-op (0 evaluations, 0 watchdog events, 0 aborts).
 *
 * Scenario per cell: lane A is busy and past the 30-minute reachability floor
 * (deadline path); lane B is busy, below the horizon, zero activity (stall
 * path). Expected: exactly one `execution_deadline` watchdog event + one abort
 * + terminal `stale` for A when deadlineActive (the watchdog overrides probe
 * retention for lanes past the EFFECTIVE horizon); A retained `pending`
 * otherwise (busy lanes are never settled by the age-only substrate). Exactly
 * one escalation event for B when stallActive && !deadlineActive (a lane being
 * deadline-settled needs no stall escalation).
 */
describe('C1 — enabled x 0-disables cross-product (32 cells)', () => {
	const POSITIVE = {
		timeout_ms: 600_000,
		stall_threshold_ms: 60_000,
		stall_min_steps: 5,
		stall_token_threshold: 200,
	};

	const deadlineActive = (cell: typeof CONTRACT_DEFAULTS): boolean =>
		cell.enabled && cell.timeout_ms > 0;
	const stallActive = (cell: typeof CONTRACT_DEFAULTS): boolean =>
		cell.enabled &&
		cell.stall_threshold_ms > 0 &&
		cell.stall_min_steps > 0 &&
		cell.stall_token_threshold > 0;

	const CELLS: Array<typeof CONTRACT_DEFAULTS> = [];
	for (const enabled of [false, true]) {
		for (const timeoutZero of [true, false]) {
			for (const thresholdZero of [true, false]) {
				for (const stepsZero of [true, false]) {
					for (const tokensZero of [true, false]) {
						CELLS.push({
							enabled,
							timeout_ms: timeoutZero ? 0 : POSITIVE.timeout_ms,
							stall_threshold_ms: thresholdZero
								? 0
								: POSITIVE.stall_threshold_ms,
							stall_min_steps: stepsZero ? 0 : POSITIVE.stall_min_steps,
							stall_token_threshold: tokensZero
								? 0
								: POSITIVE.stall_token_threshold,
						});
					}
				}
			}
		}
	}

	test('every cell matches the frozen inertness truth table', async () => {
		expect(CELLS.length).toBe(32);
		for (const cell of CELLS) {
			const work = deadlineActive(cell) || stallActive(cell);
			const cellDirectory = canonicalMkdtemp('lane-liveness-cross-');
			try {
				gateInternals.resetTrackedStateCache();
				await recordOpenPrWorkflowLane(
					cellDirectory,
					'sess-cross',
					'intent-architecture',
					'c-cross-a',
				);
				await recordOpenPrWorkflowLane(
					cellDirectory,
					'sess-cross',
					'risk-security',
					'c-cross-b',
				);
				await backdatePrWorkflowLane(
					cellDirectory,
					'c-cross-a',
					STALE_LANE_AGE_MS,
				);
				let abortCalls = 0;
				gateInternals.getSessionOps = () =>
					({
						status: async () => ({
							data: {
								[laneSubagentSessionId('c-cross-a')]: { type: 'busy' },
								[laneSubagentSessionId('c-cross-b')]: { type: 'busy' },
							},
						}),
						abort: async () => {
							abortCalls += 1;
							return {};
						},
					}) as unknown as ReturnType<typeof gateInternals.getSessionOps>;

				await settlePresumedStalePrWorkflowLanes(cellDirectory, 'sess-cross', {
					laneLivenessWatchdog: cell,
				});

				const eventsText = await fs
					.readFile(path.join(cellDirectory, '.swarm', 'events.jsonl'), 'utf-8')
					.catch(() => '');
				const watchdogLines = eventsText
					.split('\n')
					.filter((line) => line.includes('pr_workflow_lane_watchdog'));
				// A deadline EVENT is a deadline settlement (escalated:false,
				// condition execution_deadline). An escalation may honestly
				// classify a past-horizon retained lane as execution_deadline
				// too — that is a stall escalation, not a settlement.
				const deadlineEvents = watchdogLines.filter(
					(line) =>
						line.includes('execution_deadline') &&
						!line.includes('"escalated":true'),
				);
				const escalationEvents = watchdogLines.filter((line) =>
					line.includes('"escalated":true'),
				);
				const label = JSON.stringify(cell);
				expect(surface().evaluations, label).toBe(work ? 1 : 0);
				expect(watchdogLines.length, label).toBe(
					(deadlineActive(cell) ? 1 : 0) +
						(stallActive(cell) && !deadlineActive(cell) ? 1 : 0),
				);
				expect(deadlineEvents.length, label).toBe(deadlineActive(cell) ? 1 : 0);
				expect(escalationEvents.length, label).toBe(
					stallActive(cell) && !deadlineActive(cell) ? 1 : 0,
				);
				expect(surface().hostAbortCalls, label).toBe(
					deadlineActive(cell) ? 1 : 0,
				);
				expect(abortCalls, label).toBe(deadlineActive(cell) ? 1 : 0);
				expect(laneStatusOnDisk(cellDirectory, 'c-cross-a'), label).toBe(
					deadlineActive(cell) ? 'stale' : 'pending',
				);
				expect(laneStatusOnDisk(cellDirectory, 'c-cross-b'), label).toBe(
					'pending',
				);
			} finally {
				gateInternals.resetTrackedStateCache();
				closeProjectDb(cellDirectory);
				await fs.rm(cellDirectory, { recursive: true, force: true });
			}
		}
	}, 120_000);
});
