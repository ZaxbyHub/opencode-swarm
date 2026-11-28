/**
 * Background-settlement-backed Stage A recovery (the 2026-11-26 task 2.14
 * wedge).
 *
 * A background-dispatched coder round that ran to a completed terminal,
 * settled its coder settlement, and was durably consumed with ingestion
 * outcome 'accepted' can attribute ZERO files: the deliverable landed
 * outside the delegation lane (observed live: the user committed it after a
 * liveness-stale predecessor round). For that verification-only shape NO
 * COMMITTED settlement WAL exists (background dispatches ABORT-by-transfer)
 * and NO accepted_mutation requirements receipt is ever written (nothing
 * mutated) — the supervised recovery and the /swarm recover scan therefore
 * refused with RECOVER_STAGE_A_SETTLEMENT_REQUIRED forever while retry
 * dispatches just re-settled as dispatch_no_mutation.
 *
 * The settled+accepted background delegation record is the same durable
 * settlement fact. Pins: the background_settlement justification (tool +
 * scan), the verification-only accepted:false surfacing in the audit, the
 * fail-closed refusal on a platform-rejected ingestion outcome, and the
 * green-bundle bar.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { freezeClock, type Restore } from '../../helpers/test-clock.js';
import {
	buildBackgroundCompletionEventId,
	claimCoderSettlement,
	claimDelegationIngestion,
	claimTerminalResult,
	type RecordPendingInput,
	recordDelegationIngestionResult,
	recordPendingDelegation,
	updateCoderSettlement,
} from '../../../src/background/pending-delegations';
import { saveEvidence } from '../../../src/evidence/manager';
import {
	getTaskWorkflowSnapshot,
	readTaskEvidence,
	transitionTaskWorkflowEvidence,
} from '../../../src/gate-evidence';
import { ensureAgentSession, resetSwarmState } from '../../../src/state';
import { recoverStageATaskSupervised } from '../../../src/workflow/settlement-recovery';
import { repairWedgedStageA } from '../../../src/workflow/stage-a-repair';
import { createSafeTestDir } from '../../helpers/safe-test-dir';
import { readRepairEvents } from './_settlement-recovery-2828-helpers';

let directory = '';
let cleanup = (): void => {};

let restoreClock: Restore;

beforeEach(() => {
	restoreClock = freezeClock({ fixedNow: Date.now() });
	resetSwarmState();
	({ dir: directory, cleanup } = createSafeTestDir('stage-a-bg-settle-'));
});

afterEach(() => {
	restoreClock();
	resetSwarmState();
	cleanup();
});

function architectSession(id: string): string {
	ensureAgentSession(id, 'architect', directory);
	return id;
}

const REASON =
	'task 2.14 wedge: settled background verification round, deliverable landed outside the delegation lane';

/**
 * The durable 2.14 shape: generation-0 idle, last transition a
 * background-coder `dispatch_no_mutation` carrying a NON-empty declared
 * scope (the task's real files), retryCount 1. No accepted_mutation
 * receipt is written by this transition, so the fixture stays
 * receipt-less — the ONLY durable settlement fact is the background
 * record seeded alongside it.
 */
async function wedgeAtIdleNoMutation(taskId: string): Promise<void> {
	await transitionTaskWorkflowEvidence(directory, taskId, {
		type: 'dispatch_no_mutation',
		agentType: 'coder',
		expectedGeneration: 0,
		transitionId: `background-coder:ses-bg-${taskId}`,
		context: {
			declaredFiles: ['src/credit.ts', 'tests/credit.test.ts'],
			testEngineerExempt: false,
		},
	});
	const snapshot = getTaskWorkflowSnapshot(
		await readTaskEvidence(directory, taskId),
	);
	expect(snapshot.state).toBe('idle');
	expect(snapshot.lastOutcome).toBe('dispatch_no_mutation');
	expect(snapshot.retryCount).toBe(1);
}

/**
 * Seeds the real durable background flow exactly as the completion
 * observer drives it: pending record → typed completed terminal → coder
 * settlement claim → settled (shared-root) → ingestion claim → consumed
 * with the requested durable outcome.
 */
async function seedSettledBackgroundRound(
	taskId: string,
	options: { observedFiles?: string[]; ingestionOutcome?: string } = {},
): Promise<void> {
	const correlationId = `ses-bg-round-${taskId}`;
	const input: RecordPendingInput = {
		correlationId,
		jobId: null,
		subagentSessionId: correlationId,
		parentSessionId: 'ses-arch-bg',
		callID: `call-bg-${taskId}`,
		normalizedAgent: 'coder',
		swarmPrefixedAgent: 'astra_coder',
		planTaskId: taskId,
		evidenceTaskId: taskId,
		taskChangeContext: {
			declaredFiles: ['src/credit.ts', 'tests/credit.test.ts'],
			baseline: {
				directory,
				gitHead: 'b8c8890c1dbe828089be9f378e418950fcdd5c91',
				dirtyHash: 'clean',
				changedFiles: [],
				prHeadSha: null,
				scope: taskId,
			},
			workflowGeneration: 0,
		},
	};
	const recorded = await recordPendingDelegation(directory, input);
	expect(recorded).not.toBeNull();
	const eventId = buildBackgroundCompletionEventId({
		correlationId,
		jobId: null,
		status: 'completed',
		resultDigest: 'digest',
	});
	const claimedTerminal = await claimTerminalResult(directory, correlationId, {
		eventId,
		status: 'completed',
		recordedAt: Date.now(),
		result: { chars: 14, truncated: false, digest: 'digest' },
	});
	expect(claimedTerminal).not.toBeNull();
	const settlementClaim = await claimCoderSettlement(
		directory,
		correlationId,
		eventId,
	);
	expect(settlementClaim?.disposition).toBe('claimed');
	const settled = await updateCoderSettlement(directory, correlationId, {
		operationId: eventId,
		state: 'settled',
		observedFiles: options.observedFiles ?? [],
		outcome: { kind: 'shared-root', result: 'ready' },
	});
	expect(settled?.coderSettlement?.state).toBe('settled');
	const ingestionClaim = await claimDelegationIngestion(
		directory,
		correlationId,
		{ claimantId: eventId },
	);
	const claimToken = ingestionClaim?.record.ingestion?.claimToken;
	if (!claimToken) throw new Error('test setup failed to claim ingestion');
	const consumed = await recordDelegationIngestionResult(
		directory,
		correlationId,
		claimToken,
		true,
		{ outcome: (options.ingestionOutcome ?? 'accepted') as 'accepted' },
	);
	expect(consumed?.status).toBe('consumed');
}

/** Green post-settlement bundles stamped AFTER the settlement write. */
async function writeGreenBundlesAfterSettlement(): Promise<void> {
	const stamp = new Date(Date.now() + 1_000).toISOString();
	await saveEvidence(directory, 'secretscan', {
		task_id: 'secretscan',
		type: 'secretscan',
		timestamp: stamp,
		agent: 'pre_check_batch',
		verdict: 'pass',
		summary: 'no secrets found',
		findings_count: 0,
		files_scanned: 10,
		skipped_files: 0,
		incomplete_files: 0,
		incomplete_paths: [],
	});
	await saveEvidence(directory, 'sast_scan', {
		task_id: 'sast_scan',
		type: 'sast',
		timestamp: stamp,
		agent: 'pre_check_batch',
		verdict: 'pass',
		summary: 'no findings',
		findings: [],
		engine: 'tier_a',
		files_scanned: 5,
		findings_count: 0,
		findings_by_severity: { critical: 0, high: 0, medium: 0, low: 0 },
	});
}

describe('Stage A recovery from a settled background coder settlement (task 2.14)', () => {
	test('recover_stage_a_task repairs the verification-only wedge and surfaces accepted:false in the audit', async () => {
		await wedgeAtIdleNoMutation('2.14');
		await seedSettledBackgroundRound('2.14', { observedFiles: [] });
		await writeGreenBundlesAfterSettlement();

		const summary = await recoverStageATaskSupervised(
			directory,
			architectSession('arch-bg-1'),
			{ taskId: '2.14', reason: REASON },
		);

		expect(summary.state).toBe('pre_check_passed');
		expect(summary.alreadyRecovered).toBe(false);
		expect(summary.justification).toBe('background_settlement');
		const workflow = getTaskWorkflowSnapshot(
			await readTaskEvidence(directory, '2.14'),
		);
		expect(workflow.state).toBe('pre_check_passed');
		expect(workflow.settlementRecovery).toBe(true);
		const events = readRepairEvents(directory);
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({
			action: 'repaired',
			via: 'recover_stage_a_task',
			justification: 'background_settlement',
			justificationAccepted: false,
			justificationCorrelationId: 'ses-bg-round-2.14',
			settlementRecovery: true,
		});
	});

	test('the /swarm recover scan (repairWedgedStageA) repairs the same wedge', async () => {
		await wedgeAtIdleNoMutation('3.7');
		await seedSettledBackgroundRound('3.7', { observedFiles: [] });
		await writeGreenBundlesAfterSettlement();

		const result = await repairWedgedStageA(directory, { taskIds: ['3.7'] });

		expect(result.results).toHaveLength(1);
		expect(result.results[0]).toMatchObject({
			taskId: '3.7',
			outcome: 'repaired',
		});
		const workflow = getTaskWorkflowSnapshot(
			await readTaskEvidence(directory, '3.7'),
		);
		expect(workflow.state).toBe('pre_check_passed');
		const events = readRepairEvents(directory);
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({
			action: 'repaired',
			via: 'swarm-recover',
			justification: 'background_settlement',
			justificationAccepted: false,
		});
	});

	test('a mutation-attributing settled round justifies with accepted:true', async () => {
		await wedgeAtIdleNoMutation('4.2');
		await seedSettledBackgroundRound('4.2', {
			observedFiles: ['src/credit.ts'],
		});
		await writeGreenBundlesAfterSettlement();

		const summary = await recoverStageATaskSupervised(
			directory,
			architectSession('arch-bg-2'),
			{ taskId: '4.2', reason: REASON },
		);

		expect(summary.state).toBe('pre_check_passed');
		expect(summary.justification).toBe('background_settlement');
		expect(readRepairEvents(directory)[0]?.justificationAccepted).toBe(true);
	});

	test('fail-closed: a platform-rejected ingestion outcome never justifies recovery', async () => {
		await wedgeAtIdleNoMutation('5.1');
		await seedSettledBackgroundRound('5.1', {
			observedFiles: [],
			ingestionOutcome: 'rejected',
		});
		await writeGreenBundlesAfterSettlement();

		await expect(
			recoverStageATaskSupervised(directory, architectSession('arch-bg-3'), {
				taskId: '5.1',
				reason: REASON,
			}),
		).rejects.toThrow(/RECOVER_STAGE_A_SETTLEMENT_REQUIRED/);
		const scan = await repairWedgedStageA(directory, { taskIds: ['5.1'] });
		expect(scan.results[0]).toMatchObject({
			outcome: 'skipped_not_wedged',
			state: 'idle',
		});
		// Nothing was written: the wedge is untouched.
		const workflow = getTaskWorkflowSnapshot(
			await readTaskEvidence(directory, '5.1'),
		);
		expect(workflow.state).toBe('idle');
		expect(readRepairEvents(directory)).toHaveLength(0);
	});

	test('the green-bundle bar still applies: no fresh pre-check evidence refuses the repair', async () => {
		await wedgeAtIdleNoMutation('6.3');
		await seedSettledBackgroundRound('6.3', { observedFiles: [] });

		await expect(
			recoverStageATaskSupervised(directory, architectSession('arch-bg-4'), {
				taskId: '6.3',
				reason: REASON,
			}),
		).rejects.toThrow(/RECOVER_STAGE_A_GREEN_PRECHECK_REQUIRED/);
	});
});
