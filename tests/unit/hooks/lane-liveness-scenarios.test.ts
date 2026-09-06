/**
 * Issue #2506 acceptance check C8 (AC8, NEW-SURFACE) — the six end-to-end
 * scenarios:
 *   1. slow live provider (busy past horizon, watchdog disabled → retained,
 *      unchanged),
 *   2. deadline expiry (enabled → abort + settle with the real outcome),
 *   3. mid-write settlement (settlement concurrent with an in-flight ledger
 *      append leaves a consistent ledger and events log),
 *   4. user response to escalation (force-abort override still human-only
 *      and reachable),
 *   5. disabled no-op (no new events or transitions),
 *   6. conflicting horizons (exactly one effective horizon governs).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
	appendDelegationTransition,
	readDelegations,
} from '../../../src/background/pending-delegations.js';
import { closeProjectDb } from '../../../src/db/project-db.js';
import { resolveEffectivePrLaneHorizonMs } from '../../../src/hooks/lane-liveness-watchdog.js';
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
	STALE_LANE_AGE_MS,
} from '../../helpers/pr-workflow-lane-fixtures.js';
import { freezeClock } from '../../helpers/test-clock.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const STALE_AGE_MS = STALE_LANE_AGE_MS; // 30min floor + 60s

const enabledWith = (timeout_ms: number) => ({
	enabled: true,
	timeout_ms,
	stall_threshold_ms: 300_000,
	stall_min_steps: 5,
	stall_token_threshold: 200,
});

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
	directory = canonicalMkdtemp('lane-liveness-scenarios-');
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

function installBusyHost(correlationIds: string[]): unknown[] {
	const abortCalls: unknown[] = [];
	const map: Record<string, { type?: string }> = {};
	for (const id of correlationIds)
		map[laneSubagentSessionId(id)] = { type: 'busy' };
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

describe('C8 scenario 1 — slow live provider, watchdog disabled', () => {
	test('busy past the horizon is retained, unchanged: no abort, no watchdog events', async () => {
		await recordOpenPrWorkflowLane(
			directory,
			'sess-slow',
			'intent-architecture',
			'c-slow',
		);
		await backdatePrWorkflowLane(directory, 'c-slow', STALE_AGE_MS);
		const abortCalls = installBusyHost(['c-slow']);

		const settlement = await settlePresumedStalePrWorkflowLanes(
			directory,
			'sess-slow',
		);

		expect(settlement.openLanes).toBe(1);
		expect(settlement.probedAliveLaneIds).toEqual(['intent-architecture']);
		expect(laneStatusOnDisk(directory, 'c-slow')).toBe('pending');
		expect(abortCalls).toEqual([]);
		expect(await watchdogEvents(directory)).toEqual([]);
	});
});

describe('C8 scenario 2 — deadline expiry, watchdog enabled', () => {
	test('busy past the effective horizon is aborted once and settled with the real outcome', async () => {
		await recordOpenPrWorkflowLane(
			directory,
			'sess-expire',
			'risk-security',
			'c-expire',
		);
		await backdatePrWorkflowLane(directory, 'c-expire', 5 * 60_000);
		const abortCalls = installBusyHost(['c-expire']);

		const settlement = await settlePresumedStalePrWorkflowLanes(
			directory,
			'sess-expire',
			{ laneLivenessWatchdog: enabledWith(60_000) },
		);

		expect(abortCalls.length).toBe(1);
		expect(JSON.stringify(abortCalls[0])).toContain('c-expire');
		expect(settlement.presumedStaleLaneIds).toEqual(['risk-security']);
		expect(laneStatusOnDisk(directory, 'c-expire')).toBe('stale');
		const events = await watchdogEvents(directory);
		expect(events.length).toBeGreaterThanOrEqual(1);
		for (const event of events) {
			expect(event.effectiveHorizonMs).toBe(60_000);
			expect(event.horizonSource).toBe('watchdog-timeout');
		}
		const deadline = events.find(
			(event) => event.condition === 'execution_deadline',
		) as Record<string, unknown>;
		expect(deadline).toBeDefined();
		expect(`${deadline.disclosure}`).toMatch(/no output observed/i);
	});
});

describe('C8 scenario 3 — settlement during an in-flight ledger append', () => {
	test('concurrent append + watchdog settlement leave a consistent ledger and events log', async () => {
		await recordOpenPrWorkflowLane(
			directory,
			'sess-midwrite',
			'reviewer-correctness',
			'c-midwrite',
		);
		await backdatePrWorkflowLane(directory, 'c-midwrite', 5 * 60_000);
		// An unrelated lane whose ledger transition is IN FLIGHT while the
		// watchdog settles the first lane.
		await recordOpenPrWorkflowLane(
			directory,
			'sess-midwrite',
			'writer-lane',
			'c-writer',
		);
		installBusyHost(['c-midwrite', 'c-writer']);

		const inFlightAppend = appendDelegationTransition(directory, 'c-writer', {
			status: 'running',
			updatedAt: Date.now(),
		});
		const settlement = await settlePresumedStalePrWorkflowLanes(
			directory,
			'sess-midwrite',
			{ laneLivenessWatchdog: enabledWith(60_000) },
		);
		await inFlightAppend;

		// Both writes survived; the ledger still parses and neither record
		// was torn.
		expect(settlement.presumedStaleLaneIds).toEqual(['reviewer-correctness']);
		const records = readDelegations(directory);
		const settled = records.find((r) => r.correlationId === 'c-midwrite');
		const writer = records.find((r) => r.correlationId === 'c-writer');
		expect(settled?.status).toBe('stale');
		expect(writer?.status).toBe('running');
		// Every events.jsonl line is intact, parseable JSON.
		const lines = (
			await fs.readFile(path.join(directory, '.swarm', 'events.jsonl'), 'utf-8')
		)
			.trim()
			.split('\n')
			.filter((line) => line.trim().length > 0);
		for (const line of lines) {
			expect(() => JSON.parse(line)).not.toThrow();
		}
		expect(
			lines.some((line) => line.includes('pr_workflow_lane_watchdog')),
		).toBe(true);
	});
});

describe('C8 scenario 4 — user response to escalation stays human-only', () => {
	test('escalated retained lane: recovery abort refused, human force abort succeeds', async () => {
		// timeout_ms = 0 disables the execution deadline, so the busy
		// past-floor lane is probe-retained (today's behavior) while the
		// stall detector surfaces the escalation for the operator.
		await activatePrWorkflow(directory, 'sess-respond', 'PR_REVIEW');
		await recordOpenPrWorkflowLane(
			directory,
			'sess-respond',
			'intent-architecture',
			'c-respond',
		);
		await backdatePrWorkflowLane(directory, 'c-respond', STALE_AGE_MS);
		installBusyHost(['c-respond']);

		const settled = await settlePresumedStalePrWorkflowLanes(
			directory,
			'sess-respond',
			{ laneLivenessWatchdog: enabledWith(0) },
		);
		// Retained (deadline disabled) AND escalated (stalled, zero output).
		expect(settled.probedAliveLaneIds).toEqual(['intent-architecture']);
		expect(laneStatusOnDisk(directory, 'c-respond')).toBe('pending');
		const escalations = (await watchdogEvents(directory)).filter(
			(event) => event.escalated === true,
		);
		expect(escalations.length).toBe(1);
		expect(escalations[0].laneIds).toContain('intent-architecture');

		// A machine-style recovery abort is still refused on the retention.
		await expect(
			abortPrWorkflow(directory, 'sess-respond', {
				kind: 'recovery',
				reason: 'automated response to escalation',
			}),
		).rejects.toThrow(/in flight|still running/i);

		// The human-only force override remains the one reachable exit.
		const summary = await abortPrWorkflow(directory, 'sess-respond', {
			kind: 'force',
			reason: 'operator inspected the escalated lane',
		});
		// #2251 semantics: force abort reports the PRE-finalization open-lane
		// count (fresh + probe-retained); the retained lane's ledger row is
		// finalized after this count is taken. The terminal row asserted below
		// is what proves the override actually landed.
		expect(summary.openLanes).toBe(1);
		expect(laneStatusOnDisk(directory, 'c-respond')).toBe('stale');
	});
});

describe('C8 scenario 5 — disabled watchdog is a strict no-op', () => {
	test("mixed fixture: no watchdog events, no aborts, today's settlement shape", async () => {
		await recordOpenPrWorkflowLane(
			directory,
			'sess-noop',
			'intent-architecture',
			'c-noop-stale',
		);
		await backdatePrWorkflowLane(directory, 'c-noop-stale', STALE_AGE_MS);
		await recordOpenPrWorkflowLane(
			directory,
			'sess-noop',
			'risk-security',
			'c-noop-fresh',
		);
		const abortCalls = installBusyHost(['c-noop-stale', 'c-noop-fresh']);

		const settlement = await settlePresumedStalePrWorkflowLanes(
			directory,
			'sess-noop',
		);

		// Exactly the substrate behavior: the busy stale lane is retained
		// (disclosed via probedAliveLaneIds), the fresh lane blocks, nothing
		// else happens. openLanes/openLaneIds keep the #2251 pinned semantics
		// (fresh open lanes PLUS probe-retained lanes; probe evidence:
		// repro/probe-openlanes.ts prints openLaneIds =
		// ["risk-security","intent-architecture"], openLanes = 2 for this
		// exact fixture on the pre-fix substrate).
		expect(settlement.openLanes).toBe(2);
		expect(settlement.openLaneIds).toEqual([
			'risk-security',
			'intent-architecture',
		]);
		expect(settlement.probedAliveLaneIds).toEqual(['intent-architecture']);
		expect(laneStatusOnDisk(directory, 'c-noop-stale')).toBe('pending');
		expect(laneStatusOnDisk(directory, 'c-noop-fresh')).toBe('pending');
		expect(abortCalls).toEqual([]);
		expect(await watchdogEvents(directory)).toEqual([]);
	});
});

describe('C8 scenario 6 — conflicting horizons resolve to exactly one', () => {
	test('watchdog 10min vs background 20min: the 10min horizon alone governs the lane', async () => {
		const config = enabledWith(600_000);
		const backgroundPendingTimeoutMs = 1_200_000;
		// Unit-level cross-check: the resolver discloses the conflict but
		// keeps a single effective horizon.
		const horizon = resolveEffectivePrLaneHorizonMs(
			config,
			backgroundPendingTimeoutMs,
		);
		expect(horizon.horizonMs).toBe(600_000);
		expect(horizon.source).toBe('watchdog-timeout');
		expect(horizon.conflictDisclosed).toBe(true);

		// Lane aged 700s: past the 10-minute effective horizon, below the
		// conflicting 20-minute background timeout and the 30-minute floor.
		// ONE horizon (the watchdog's) decides.
		await recordOpenPrWorkflowLane(
			directory,
			'sess-conflict',
			'reviewer-critic',
			'c-conflict',
		);
		await backdatePrWorkflowLane(directory, 'c-conflict', 700_000);
		const abortCalls = installBusyHost(['c-conflict']);

		const settlement = await settlePresumedStalePrWorkflowLanes(
			directory,
			'sess-conflict',
			{
				laneLivenessWatchdog: config,
				backgroundPendingTimeoutMs,
			},
		);

		expect(settlement.presumedStaleLaneIds).toEqual(['reviewer-critic']);
		expect(laneStatusOnDisk(directory, 'c-conflict')).toBe('stale');
		expect(abortCalls.length).toBe(1);
		// One decision, one terminal transition — the conflicting value did
		// not produce a second horizon: EVERY watchdog event reports the same
		// single effective horizon, and the lane settled exactly once.
		const events = await watchdogEvents(directory);
		expect(events.length).toBeGreaterThanOrEqual(1);
		for (const event of events) {
			expect(event.effectiveHorizonMs).toBe(600_000);
			expect(event.horizonSource).toBe('watchdog-timeout');
		}
		const deadline = events.find(
			(event) => event.condition === 'execution_deadline',
		);
		expect(deadline).toBeDefined();
		const settledTimes = readDelegations(directory).filter(
			(record) =>
				record.correlationId === 'c-conflict' && record.status === 'stale',
		).length;
		expect(settledTimes).toBe(1);
	});
});
