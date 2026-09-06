/**
 * Issue #2506 acceptance check C3 (AC3, NEW-SURFACE) — the five typed lane
 * liveness conditions and the no-fabrication contract of execution_deadline
 * settlement.
 *
 * Frozen contract pinned here:
 * - `classifyLaneLivenessCondition({ sessionStatusType, recordStatus,
 *   waitBudgetExpired, exceededEffectiveHorizon })` maps to exactly
 *   'observer_deadline' | 'provider_retry_in_flight' | 'completed_failure' |
 *   'idle_failed_child' | 'execution_deadline', with precedence
 *   completed_failure > observer_deadline > provider_retry_in_flight >
 *   execution_deadline > idle_failed_child.
 * - Execution-deadline settlement aborts the lane's session (best-effort,
 *   via the session-ops seam), settles through the SHARED settlement path,
 *   and the terminal event carries the REAL outcome ("no output observed"
 *   when no transcript exists) — never a fabricated review verdict or
 *   coverage. Reviewer lanes still require their exact retry receipts
 *   before any terminal publication: no receipt may materialize from a
 *   watchdog settlement.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { closeProjectDb } from '../../../src/db/project-db.js';
import { classifyLaneLivenessCondition } from '../../../src/hooks/lane-liveness-watchdog.js';
import {
	completePrWorkflow,
	_test_exports as gateInternals,
	settlePresumedStalePrWorkflowLanes,
} from '../../../src/hooks/pr-workflow-gate.js';
import { readAllReceipts } from '../../../src/hooks/review-receipt.js';
import {
	backdatePrWorkflowLane,
	laneStatusOnDisk,
	laneSubagentSessionId,
	recordOpenPrWorkflowLane,
	writeRawPrWorkflowGateState,
} from '../../helpers/pr-workflow-lane-fixtures.js';
import { freezeClock } from '../../helpers/test-clock.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const WATCHDOG_TIMEOUT_MS = 60_000;
const LANE_AGE_MS = 5 * 60_000; // past the 60s watchdog horizon

const enabledWatchdog = {
	enabled: true,
	timeout_ms: WATCHDOG_TIMEOUT_MS,
	stall_threshold_ms: 300_000,
	stall_min_steps: 5,
	stall_token_threshold: 200,
};

type ClassifyInput = Parameters<typeof classifyLaneLivenessCondition>[0];

const classify = (input: ClassifyInput) => classifyLaneLivenessCondition(input);

let directory = '';
let restoreClock: () => void = () => {};
const originals = {
	resolveCurrentGitHead: gateInternals.resolveCurrentGitHead,
	resolveCurrentGitHeadAsync: gateInternals.resolveCurrentGitHeadAsync,
	resolveIsWorkingTreeClean: gateInternals.resolveIsWorkingTreeClean,
	resolveIsWorkingTreeCleanAsync: gateInternals.resolveIsWorkingTreeCleanAsync,
};

beforeEach(() => {
	restoreClock = freezeClock();
	directory = canonicalMkdtemp('lane-liveness-outcomes-');
	gateInternals.resetTrackedStateCache();
	gateInternals.getSessionOps = () => null;
	gateInternals.resolveCurrentGitHead = () => 'abc123';
	gateInternals.resolveCurrentGitHeadAsync = async () => 'abc123';
	gateInternals.resolveIsWorkingTreeClean = () => true;
	gateInternals.resolveIsWorkingTreeCleanAsync = async () => true;
});

afterEach(async () => {
	restoreClock();
	gateInternals.resetTrackedStateCache();
	gateInternals.resolveCurrentGitHead = originals.resolveCurrentGitHead;
	gateInternals.resolveCurrentGitHeadAsync =
		originals.resolveCurrentGitHeadAsync;
	gateInternals.resolveIsWorkingTreeClean = originals.resolveIsWorkingTreeClean;
	gateInternals.resolveIsWorkingTreeCleanAsync =
		originals.resolveIsWorkingTreeCleanAsync;
	closeProjectDb(directory);
	await fs.rm(directory, { recursive: true, force: true });
});

describe('C3 — the five typed conditions', () => {
	test('completed_failure: a terminal-error record wins over every other signal', () => {
		expect(
			classify({
				recordStatus: 'error',
				sessionStatusType: 'busy',
				waitBudgetExpired: true,
				exceededEffectiveHorizon: true,
			}),
		).toBe('completed_failure');
		expect(
			classify({
				recordStatus: 'error',
				sessionStatusType: 'retry',
				waitBudgetExpired: false,
				exceededEffectiveHorizon: false,
			}),
		).toBe('completed_failure');
	});

	test('observer_deadline: an expired observation budget with a live-or-unknown session', () => {
		expect(
			classify({
				recordStatus: 'pending',
				sessionStatusType: 'busy',
				waitBudgetExpired: true,
				exceededEffectiveHorizon: true,
			}),
		).toBe('observer_deadline');
		expect(
			classify({
				recordStatus: 'running',
				sessionStatusType: undefined,
				waitBudgetExpired: true,
				exceededEffectiveHorizon: false,
			}),
		).toBe('observer_deadline');
	});

	test('provider_retry_in_flight: a retrying session is provider latency, not lane death', () => {
		expect(
			classify({
				recordStatus: 'pending',
				sessionStatusType: 'retry',
				waitBudgetExpired: false,
				exceededEffectiveHorizon: false,
			}),
		).toBe('provider_retry_in_flight');
	});

	test('execution_deadline: busy past the effective horizon', () => {
		expect(
			classify({
				recordStatus: 'pending',
				sessionStatusType: 'busy',
				waitBudgetExpired: false,
				exceededEffectiveHorizon: true,
			}),
		).toBe('execution_deadline');
	});

	test('execution_deadline: not alive (idle) past the effective horizon', () => {
		expect(
			classify({
				recordStatus: 'running',
				sessionStatusType: 'idle',
				waitBudgetExpired: false,
				exceededEffectiveHorizon: true,
			}),
		).toBe('execution_deadline');
	});

	test('idle_failed_child: open record, idle/absent session, below the horizon', () => {
		expect(
			classify({
				recordStatus: 'pending',
				sessionStatusType: 'idle',
				waitBudgetExpired: false,
				exceededEffectiveHorizon: false,
			}),
		).toBe('idle_failed_child');
		expect(
			classify({
				recordStatus: 'running',
				sessionStatusType: undefined,
				waitBudgetExpired: false,
				exceededEffectiveHorizon: false,
			}),
		).toBe('idle_failed_child');
	});
});

describe('C3 — precedence: completed_failure > observer_deadline > provider_retry_in_flight > execution_deadline > idle_failed_child', () => {
	test('observer_deadline beats provider_retry_in_flight', () => {
		expect(
			classify({
				recordStatus: 'pending',
				sessionStatusType: 'retry',
				waitBudgetExpired: true,
				exceededEffectiveHorizon: true,
			}),
		).toBe('observer_deadline');
	});

	test('observer_deadline beats execution_deadline', () => {
		expect(
			classify({
				recordStatus: 'pending',
				sessionStatusType: 'busy',
				waitBudgetExpired: true,
				exceededEffectiveHorizon: true,
			}),
		).toBe('observer_deadline');
	});

	test('provider_retry_in_flight beats execution_deadline (retry past the horizon is still provider latency)', () => {
		expect(
			classify({
				recordStatus: 'pending',
				sessionStatusType: 'retry',
				waitBudgetExpired: false,
				exceededEffectiveHorizon: true,
			}),
		).toBe('provider_retry_in_flight');
	});

	test('execution_deadline beats idle_failed_child', () => {
		expect(
			classify({
				recordStatus: 'pending',
				sessionStatusType: 'idle',
				waitBudgetExpired: false,
				exceededEffectiveHorizon: true,
			}),
		).toBe('execution_deadline');
	});
});

describe('C3 — execution_deadline settlement retains the real outcome and fabricates nothing', () => {
	test('abort once, settle through the shared path, event carries the real outcome', async () => {
		await recordOpenPrWorkflowLane(
			directory,
			'sess-outcome',
			'reviewer-correctness',
			'c-outcome',
		);
		await backdatePrWorkflowLane(directory, 'c-outcome', LANE_AGE_MS);
		const abortCalls: unknown[] = [];
		gateInternals.getSessionOps = () =>
			({
				status: async () => ({
					data: { [laneSubagentSessionId('c-outcome')]: { type: 'busy' } },
				}),
				abort: async (args: unknown) => {
					abortCalls.push(args);
					return {};
				},
			}) as unknown as ReturnType<typeof gateInternals.getSessionOps>;

		const settlement = await settlePresumedStalePrWorkflowLanes(
			directory,
			'sess-outcome',
			{ laneLivenessWatchdog: enabledWatchdog },
		);

		// The lane's subagent session was aborted exactly once, and the abort
		// targeted THIS lane's session id.
		expect(abortCalls.length).toBe(1);
		expect(JSON.stringify(abortCalls[0])).toContain('c-outcome');
		// Shared-path settlement: the record is terminal `stale`, never
		// `completed` (a completion without a result would be fabrication).
		expect(settlement.presumedStaleLaneIds).toEqual(['reviewer-correctness']);
		expect(laneStatusOnDisk(directory, 'c-outcome')).toBe('stale');
		expect(laneStatusOnDisk(directory, 'c-outcome')).not.toBe('completed');

		// The watchdog event discloses the typed condition and the real
		// outcome. The fixture wrote no transcript, so the only truthful
		// outcome is the explicit "no output observed" marker.
		const eventsText = await fs.readFile(
			path.join(directory, '.swarm', 'events.jsonl'),
			'utf-8',
		);
		const watchdogEvents = eventsText
			.trim()
			.split('\n')
			.map((line) => JSON.parse(line) as Record<string, unknown>)
			.filter((event) => event.type === 'pr_workflow_lane_watchdog');
		expect(watchdogEvents.length).toBeGreaterThanOrEqual(1);
		// No fabricated review verdict or coverage on ANY watchdog event.
		for (const event of watchdogEvents) {
			expect(event.verdict).toBeUndefined();
			expect(event.coverage).toBeUndefined();
			expect(event.effectiveHorizonMs).toBe(WATCHDOG_TIMEOUT_MS);
			expect(event.horizonSource).toBe('watchdog-timeout');
			expect(event.sessionID).toBe('sess-outcome');
			expect(typeof event.timestamp).toBe('string');
		}
		const deadline = watchdogEvents.find(
			(event) => event.condition === 'execution_deadline',
		) as Record<string, unknown>;
		expect(deadline).toBeDefined();
		expect(deadline.escalated).toBe(false);
		expect(deadline.laneIds).toEqual(['reviewer-correctness']);
		expect(`${deadline.disclosure}`).toMatch(/no output observed/i);
	});

	test('a watchdog settlement fabricates no review receipt for a reviewer lane', async () => {
		await recordOpenPrWorkflowLane(
			directory,
			'sess-receipt',
			'reviewer-critic',
			'c-receipt',
		);
		await backdatePrWorkflowLane(directory, 'c-receipt', LANE_AGE_MS);
		gateInternals.getSessionOps = () =>
			({
				status: async () => ({
					data: { [laneSubagentSessionId('c-receipt')]: { type: 'busy' } },
				}),
				abort: async () => ({}),
			}) as unknown as ReturnType<typeof gateInternals.getSessionOps>;

		await settlePresumedStalePrWorkflowLanes(directory, 'sess-receipt', {
			laneLivenessWatchdog: enabledWatchdog,
		});

		// Reviewer/critic lanes require their EXACT retry receipts before any
		// terminal publication; a watchdog settlement must not mint one.
		expect(await readAllReceipts(directory)).toEqual([]);
		expect(laneStatusOnDisk(directory, 'c-receipt')).not.toBe('completed');
	});

	test('completion still fails on real coverage after a watchdog settlement (no verdict invented)', async () => {
		await writeRawPrWorkflowGateState(directory, 'sess-cover', {
			mode: 'PR_REVIEW',
			prHeadSha: 'abc123',
			revision: 2,
		});
		await recordOpenPrWorkflowLane(
			directory,
			'sess-cover',
			'reviewer-tests',
			'c-cover',
		);
		await backdatePrWorkflowLane(directory, 'c-cover', LANE_AGE_MS);
		gateInternals.getSessionOps = () =>
			({
				status: async () => ({
					data: { [laneSubagentSessionId('c-cover')]: { type: 'busy' } },
				}),
				abort: async () => ({}),
			}) as unknown as ReturnType<typeof gateInternals.getSessionOps>;

		await settlePresumedStalePrWorkflowLanes(directory, 'sess-cover', {
			laneLivenessWatchdog: enabledWatchdog,
		});
		expect(laneStatusOnDisk(directory, 'c-cover')).toBe('stale');

		// The lane no longer blocks completion as "unsettled" — but the
		// settled lane grants NO coverage: completion must still refuse on
		// real coverage grounds, proving nothing was invented for it.
		const error = await completePrWorkflow(
			directory,
			'sess-cover',
			'PR_REVIEW',
			'abc123',
		).then(
			() => null,
			(err: unknown) => (err instanceof Error ? err.message : String(err)),
		);
		expect(error).not.toBeNull();
		expect(error).not.toMatch(/unsettled PR workflow lane/i);
	});
});
