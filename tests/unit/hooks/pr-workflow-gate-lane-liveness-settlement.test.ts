/**
 * Issue #2251 — what the liveness probe's verdict is allowed to change.
 *
 * The probe spares a lane; this file pins that the spare SURVIVES (the durable
 * directory-wide sweep must not flip it back), that the escape hatch stays
 * reachable when the probe cannot run, and that a permanently-retained lane
 * still has exactly one human exit.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { handleAbortPrWorkflowCommand } from '../../../src/commands/abort-pr-workflow.js';
import {
	abortPrWorkflow,
	activatePrWorkflow,
	completePrWorkflow,
	_test_exports as gateInternals,
	readPrWorkflowGateState,
	settlePresumedStalePrWorkflowLanes,
} from '../../../src/hooks/pr-workflow-gate.js';
import { executeAbortPrWorkflow } from '../../../src/tools/abort-pr-workflow.js';
import { executeCompletePrWorkflow } from '../../../src/tools/complete-pr-workflow.js';
import {
	backdatePrWorkflowLane,
	laneStatusOnDisk,
	laneSubagentSessionId,
	recordOpenPrWorkflowLane,
	STALE_LANE_AGE_MS,
	writeRawPrWorkflowGateState,
} from '../../helpers/pr-workflow-lane-fixtures.js';
import { freezeClock } from '../../helpers/test-clock.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

let directory = '';
let restoreClock: () => void = () => {};
const originals = {
	resolveCurrentGitHead: gateInternals.resolveCurrentGitHead,
	resolveCurrentGitHeadAsync: gateInternals.resolveCurrentGitHeadAsync,
	resolveIsWorkingTreeClean: gateInternals.resolveIsWorkingTreeClean,
	resolveIsWorkingTreeCleanAsync: gateInternals.resolveIsWorkingTreeCleanAsync,
};

/** Report exactly these subagent session ids as live/idle to the real probe. */
function installStatusMap(map: Record<string, { type?: string }>): void {
	gateInternals.getSessionOps = () => ({ status: async () => ({ data: map }) });
}

beforeEach(() => {
	restoreClock = freezeClock();
	directory = canonicalMkdtemp('pr-workflow-lane-settle-');
	gateInternals.resetTrackedStateCache();
	gateInternals.resolveCurrentGitHead = () => 'abc123';
	gateInternals.resolveCurrentGitHeadAsync = async () => 'abc123';
	gateInternals.resolveIsWorkingTreeClean = () => true;
	gateInternals.resolveIsWorkingTreeCleanAsync = async () => true;
	gateInternals.getSessionOps = () => null;
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
	await fs.rm(directory, { recursive: true, force: true });
});

async function seedStaleLane(
	sessionID: string,
	laneId: string,
	correlationId: string,
): Promise<void> {
	await recordOpenPrWorkflowLane(directory, sessionID, laneId, correlationId);
	backdatePrWorkflowLane(directory, correlationId, STALE_LANE_AGE_MS);
}

async function readEvents(): Promise<Array<Record<string, unknown>>> {
	const raw = await fs.readFile(
		path.join(directory, '.swarm', 'events.jsonl'),
		'utf-8',
	);
	return raw
		.trim()
		.split('\n')
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('probe retention must survive the durable sweep (R1 regression)', () => {
	test('a mixed batch settles the dead lane and leaves the live one `pending` on disk', async () => {
		// THE regression. `sweepStaleLocked` re-reads from disk and filters on
		// status and age ONLY — no session or id filter — and a probe-retained lane
		// is `pending` and past the horizon BY CONSTRUCTION. Without the
		// `excludeCorrelationIds` exclusion this directory-wide sweep flips the very
		// lane the probe just spared, `isOpenPrWorkflowLane` stops counting it, and
		// the spare lasts exactly one call. `openLanes === 1` alone does NOT catch
		// that: the in-memory return value is computed before the sweep runs.
		await seedStaleLane('sess-mixed', 'lane-alive', 'c-alive');
		await seedStaleLane('sess-mixed', 'lane-dead', 'c-dead');
		installStatusMap({
			[laneSubagentSessionId('c-alive')]: { type: 'busy' },
			[laneSubagentSessionId('c-dead')]: { type: 'idle' },
		});

		const settlement = await settlePresumedStalePrWorkflowLanes(
			directory,
			'sess-mixed',
		);

		expect(settlement.openLanes).toBe(1);
		expect(settlement.openLaneIds).toEqual(['lane-alive']);
		expect(settlement.freshOpenLanes).toBe(0);
		expect(settlement.presumedStaleLaneIds).toEqual(['lane-dead']);
		expect(settlement.probedAliveLaneIds).toEqual(['lane-alive']);
		// The durable state, not just the return value.
		expect(laneStatusOnDisk(directory, 'c-alive')).toBe('pending');
		expect(laneStatusOnDisk(directory, 'c-dead')).toBe('stale');
		// And the audit record must describe both halves of that decision.
		const settled = (await readEvents()).find(
			(event) => event.type === 'pr_workflow_lanes_presumed_stale',
		);
		expect(settled).toMatchObject({
			presumedStaleLanes: ['lane-dead'],
			probedAliveLanes: ['lane-alive'],
			probeStatus: 'ok',
		});
	});

	test('a sweep failure cannot un-settle the decision already made in memory', async () => {
		// The sweep is a best-effort DURABILITY complement; reachability must never
		// depend on it. It cannot throw today (it catches internally and returns 0),
		// so the seam is what makes that guarantee testable rather than asserted.
		await seedStaleLane('sess-sweep', 'intent-architecture', 'c-sweep');
		gateInternals.sweepStaleDelegationsAsync = async () => {
			throw new Error('store lock exploded');
		};

		const settlement = await settlePresumedStalePrWorkflowLanes(
			directory,
			'sess-sweep',
		);

		expect(settlement.openLanes).toBe(0);
		expect(settlement.presumedStaleLaneIds).toEqual(['intent-architecture']);
		expect(settlement.disclosure).toContain('treated as settled');
		// The write failed, so the record is untouched — and settlement stood anyway.
		expect(laneStatusOnDisk(directory, 'c-sweep')).toBe('pending');
	});
});

describe('the escape hatch stays reachable when the probe cannot run', () => {
	test('recovery abort succeeds and discloses the probe failure', async () => {
		// The reachability floor: a probe that cannot run must degrade to the
		// age-only behaviour #2242 shipped, never block the one exit that exists to
		// resolve a stuck lane.
		await activatePrWorkflow(directory, 'sess-degraded', 'PR_REVIEW');
		await seedStaleLane('sess-degraded', 'intent-architecture', 'c-degraded');
		gateInternals.getSessionOps = () => ({
			status: async () => {
				throw new Error('host socket closed');
			},
		});

		const summary = await abortPrWorkflow(directory, 'sess-degraded', {
			kind: 'recovery',
			reason: 'probe unavailable, lane long dead',
		});

		expect(summary.openLanes).toBe(0);
		expect(summary.presumedStaleLanes).toEqual(['intent-architecture']);
		expect(summary.probeDegradedReason).toBe('probe-error');
		expect(summary.probeRetentionOverrideDisclosure).toBeUndefined();
		const aborted = (await readEvents()).find(
			(event) => event.type === 'pr_workflow_aborted',
		);
		expect(aborted).toMatchObject({ probeStatus: 'probe-error' });
	});

	test('the abort tool response surfaces probe_status', async () => {
		await activatePrWorkflow(directory, 'sess-tool-degraded', 'PR_REVIEW');
		await seedStaleLane('sess-tool-degraded', 'intent-architecture', 'c-tool');
		gateInternals.getSessionOps = () => ({
			status: async () => ({ data: null }),
		});

		const parsed = JSON.parse(
			await executeAbortPrWorkflow(
				{ kind: 'recovery', reason: 'probe returned nothing' },
				directory,
				{ sessionID: 'sess-tool-degraded' },
			),
		);

		expect(parsed.success).toBe(true);
		expect(parsed.probe_status).toBe('probe-no-data');
	});

	test('the completion tool response surfaces a retained lane and blocks on it', async () => {
		await writeRawPrWorkflowGateState(directory, 'sess-complete-live', {
			mode: 'PR_REVIEW',
			prHeadSha: 'abc123',
			revision: 2,
		});
		await seedStaleLane('sess-complete-live', 'lane-alive', 'c-live');
		installStatusMap({
			[laneSubagentSessionId('c-live')]: { type: 'busy' },
		});

		const parsed = JSON.parse(
			await executeCompletePrWorkflow(
				{
					mode: 'PR_REVIEW',
					pr_head_sha: 'abc123',
					report_verdict: 'INCOMPLETE',
				},
				directory,
				{ sessionID: 'sess-complete-live' },
			),
		);

		expect(parsed.success).toBe(false);
		expect(parsed.message).toMatch(/unsettled PR workflow lane/i);
		expect(parsed.message).toContain(
			'liveness probe reports still running: lane-alive',
		);
		expect(parsed.probe_retained_lanes).toEqual(['lane-alive']);
		expect(parsed.presumed_stale_lanes).toBeUndefined();
		// Retention is not settlement: the record must not have gone terminal.
		expect(laneStatusOnDisk(directory, 'c-live')).toBe('pending');
		await expect(
			completePrWorkflow(
				directory,
				'sess-complete-live',
				'PR_REVIEW',
				'abc123',
			),
		).rejects.toThrow(/unsettled PR workflow lane/i);
	});
});

describe('a permanently-retained lane still has exactly one human exit (S3)', () => {
	test('force abort overrides probe retention and says so, without stopping the lane', async () => {
		// Without this, the probe removes the eventual-exit guarantee age alone used
		// to provide: a session that never goes idle would make the workflow
		// unexitable through every tool, recoverable only by hand-editing
		// `.swarm/delegations.jsonl`.
		await activatePrWorkflow(directory, 'sess-force', 'PR_REVIEW');
		await seedStaleLane('sess-force', 'lane-alive', 'c-force-alive');
		installStatusMap({
			[laneSubagentSessionId('c-force-alive')]: { type: 'busy' },
		});

		const summary = await abortPrWorkflow(directory, 'sess-force', {
			kind: 'force',
			reason: 'lane wedged busy forever',
		});

		expect(summary.openLanes).toBe(1);
		expect(summary.probeRetainedLanes).toEqual(['lane-alive']);
		expect(summary.probeRetentionOverrideDisclosure).toContain(
			'force abort overrode 1 lane(s)',
		);
		expect(summary.probeRetentionOverrideDisclosure).toContain('lane-alive');
		// The override abandons the lane; it does not pretend the lane died — but it
		// MUST finalize the record. A cleared gate over a `pending` record is an
		// un-restartable session: `countOpenPrWorkflowLanes` is age-blind, so
		// `prepare_pr_workflow_checkout` would refuse forever (see
		// `pr-workflow-gate-force-override-restart.test.ts` for that end to end).
		expect(laneStatusOnDisk(directory, 'c-force-alive')).toBe('stale');
		expect(summary.probeRetentionOverrideDisclosure).toContain(
			'Their sessions were NOT stopped and their output was NOT collected.',
		);
		expect(summary.probeRetentionOverrideDisclosure).toContain(
			'delegation records were finalized',
		);
		// The two independent claims: the overridden record went terminal, AND the
		// session is restartable. Both are true here, so both must be stated.
		expect(summary.probeRetentionOverrideDisclosure).toContain(
			'A new PR workflow can now be started for this session.',
		);
		expect(summary.probeRetentionOverrideDisclosure).not.toContain('WARNING:');
		const aborted = (await readEvents()).find(
			(event) => event.type === 'pr_workflow_aborted',
		);
		// A DECISION, not an outcome: the record is appended before the CAS-guarded
		// clear, and the finalization it authorizes runs only if that clear
		// succeeds. The ledger (asserted above) is the authority on what went
		// terminal.
		expect(aborted).toMatchObject({
			kind: 'force',
			probeRetainedLanes: ['lane-alive'],
			probeRetentionOverrideLanes: ['c-force-alive'],
		});
		expect(aborted?.probeRetentionOverrideDisclosure).toContain('lane-alive');
		// The pre-clear record cannot carry the finalization outcome, so the
		// restartability sentence must not appear on it — only on the return value.
		expect(aborted?.probeRetentionOverrideDisclosure).not.toContain(
			'records were finalized',
		);
	});

	test('an override whose finalization fails still clears the gate and says which record is stuck', async () => {
		// Reachability must never depend on a durability write — that rule is why
		// the settlement sweep is best-effort, and it applies here too. But a
		// silently-unfinalized record leaves `prepare_pr_workflow_checkout` refusing
		// forever, so the failure has to reach the operator instead of being
		// swallowed. The seam stands in for a contended store lock (the real sweep
		// catches internally and returns 0, so it cannot be provoked directly).
		await activatePrWorkflow(directory, 'sess-force-stuck', 'PR_REVIEW');
		await seedStaleLane('sess-force-stuck', 'lane-alive', 'c-stuck');
		installStatusMap({
			[laneSubagentSessionId('c-stuck')]: { type: 'busy' },
		});
		gateInternals.sweepStaleDelegationsAsync = async () => {
			throw new Error('store lock exploded');
		};

		const summary = await abortPrWorkflow(directory, 'sess-force-stuck', {
			kind: 'force',
			reason: 'lane wedged busy forever',
		});

		expect(summary.probeRetentionOverrideDisclosure).toContain(
			'WARNING: 1 PR workflow delegation record(s) for this session are still open (correlationId: c-stuck)',
		);
		// And it must NOT claim the restartability it just failed to deliver, nor
		// claim a finalization that did not happen — the targeted record is the one
		// still open here, so BOTH claims are false.
		expect(summary.probeRetentionOverrideDisclosure).not.toContain(
			'records were finalized',
		);
		expect(summary.probeRetentionOverrideDisclosure).not.toContain(
			'A new PR workflow can now be started',
		);
		expect(laneStatusOnDisk(directory, 'c-stuck')).toBe('pending');
		// The gate cleared anyway: an exit that a failed write can veto is not an
		// exit. A second force abort is no longer possible, which is exactly why the
		// stuck correlationId is named.
		expect(
			await readPrWorkflowGateState(directory, 'sess-force-stuck'),
		).toBeNull();
		const aborted = (await readEvents()).find(
			(event) => event.type === 'pr_workflow_aborted',
		);
		expect(aborted).toMatchObject({
			probeRetentionOverrideLanes: ['c-stuck'],
		});
	});

	test('the /swarm abort-pr-workflow command surfaces the override to the human', async () => {
		await activatePrWorkflow(directory, 'sess-cmd', 'PR_REVIEW');
		await seedStaleLane('sess-cmd', 'lane-alive', 'c-cmd-alive');
		installStatusMap({
			[laneSubagentSessionId('c-cmd-alive')]: { type: 'retry' },
		});

		const output = await handleAbortPrWorkflowCommand(
			directory,
			['PR_REVIEW', 'wedged', 'lane'],
			'sess-cmd',
		);

		expect(output).toContain('Aborted active PR_REVIEW mechanical gate');
		expect(output).toContain('WARNING: force abort overrode 1 lane(s)');
		expect(output).toContain('lane-alive');
	});

	test('force does NOT override a lane that is merely fresh', async () => {
		// The boundary. A fresh `updatedAt` is a check that CAN run and reports
		// "still progressing" — force is an override of a PRESUMPTION, not a
		// licence to abandon a lane the age rule never doubted. Deliberately mixed:
		// a fresh-only fixture would also pass a buggy implementation that compared
		// lane-label array lengths, and `prWorkflowLaneLabel` falls back to
		// 'unknown', so labels are not unique.
		await activatePrWorkflow(directory, 'sess-force-fresh', 'PR_REVIEW');
		await seedStaleLane('sess-force-fresh', 'lane-alive', 'c-mix-alive');
		await recordOpenPrWorkflowLane(
			directory,
			'sess-force-fresh',
			'lane-fresh',
			'c-mix-fresh',
		);
		installStatusMap({
			[laneSubagentSessionId('c-mix-alive')]: { type: 'busy' },
		});

		const error = await abortPrWorkflow(directory, 'sess-force-fresh', {
			kind: 'force',
			reason: 'try to force past a young lane',
		}).then(
			() => null,
			(err: unknown) => (err instanceof Error ? err.message : String(err)),
		);

		// Asserted first so a regression that lets force through fails HERE with a
		// legible message, instead of tripping toContain on a null.
		expect(error).not.toBeNull();
		expect(error).toContain('abort refused while 2 PR workflow lane(s)');
		expect(error).toContain('lane-fresh');
		expect(error).toContain('liveness probe reports still running: lane-alive');
		expect(laneStatusOnDisk(directory, 'c-mix-alive')).toBe('pending');
		expect(laneStatusOnDisk(directory, 'c-mix-fresh')).toBe('pending');
	});

	test('a `recovery` abort does NOT override probe retention, even with no fresh lane', async () => {
		// The OTHER conjunct of the override gate. `freshOpenLanes === 0` is pinned
		// by the test above; this one pins `kind === 'force'`. Both hold here — the
		// single lane is stale-by-age and probe-retained, so the override would fire
		// on every condition EXCEPT the kind — which makes this the only fixture in
		// which deleting `options.kind === 'force'` is observable.
		//
		// It matters because `recovery` is the AGENT-reachable kind: `force` is
		// human-only (`/swarm abort-pr-workflow`), and the tool pins
		// `kind: z.literal('recovery')`. If the kind stopped gating the override, an
		// agent could abandon a provably-live lane and finalize its record to
		// terminal `stale` — the exact discard issue #2251 exists to prevent, reached
		// through the one caller that is never a human decision.
		await activatePrWorkflow(directory, 'sess-recovery-live', 'PR_REVIEW');
		await seedStaleLane('sess-recovery-live', 'lane-alive', 'c-recovery-alive');
		installStatusMap({
			[laneSubagentSessionId('c-recovery-alive')]: { type: 'busy' },
		});

		const error = await abortPrWorkflow(directory, 'sess-recovery-live', {
			kind: 'recovery',
			reason: 'recovery must not abandon a lane the probe says is running',
		}).then(
			() => null,
			(err: unknown) => (err instanceof Error ? err.message : String(err)),
		);

		// Asserted first so a regression that lets recovery through fails HERE with a
		// legible message rather than tripping toContain on a null.
		expect(error).not.toBeNull();
		expect(error).toContain('abort refused while 1 PR workflow lane(s)');
		// THE discriminator: the lane is blocking because the probe RETAINED it, not
		// because it is merely fresh. Without this the fixture could drift to a
		// fresh lane and the test would still pass, pinning the wrong conjunct.
		expect(error).toContain('liveness probe reports still running: lane-alive');
		// The two durable consequences a lost `kind` check would produce: the live
		// lane's record finalized to terminal `stale` (its output uncollectable
		// forever), and the gate cleared out from under it.
		expect(laneStatusOnDisk(directory, 'c-recovery-alive')).toBe('pending');
		expect(
			await readPrWorkflowGateState(directory, 'sess-recovery-live'),
		).not.toBeNull();
	});
});
