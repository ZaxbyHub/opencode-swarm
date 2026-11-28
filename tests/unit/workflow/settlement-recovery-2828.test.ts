/**
 * Settlement-backed Stage A recovery core (issue #2828).
 *
 * recoverStageATaskSupervised is the architect-only audited escape hatch for
 * the settlement wedge: workflow drifted to idle/blocked while a COMMITTED
 * accepted coder settlement plus green post-settlement pre-check bundles
 * still justify Stage A. Pins every fail-closed precondition, the audited
 * idempotent success path, and concurrency safety. The reducer admission +
 * marker lifecycle live in settlement-recovery-reducer-2828.test.ts.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
	getTaskWorkflowSnapshot,
	readTaskEvidence,
} from '../../../src/gate-evidence';
import { ensureAgentSession, resetSwarmState } from '../../../src/state';
import { recoverStageATaskSupervised } from '../../../src/workflow/settlement-recovery';
import { createSafeTestDir } from '../../helpers/safe-test-dir';
import {
	readRepairEvents,
	settleAt,
	stripRequirementsLedger,
	writeCommittedWal,
	writeGreenBundles,
} from './_settlement-recovery-2828-helpers';

let directory = '';
let cleanup = (): void => {};

beforeEach(() => {
	resetSwarmState();
	({ dir: directory, cleanup } = createSafeTestDir('settlement-recovery-'));
});

afterEach(() => {
	resetSwarmState();
	cleanup();
});

function architectSession(id: string, agent = 'architect'): string {
	ensureAgentSession(id, agent, directory);
	return id;
}

const REASON = 'issue-2828 settlement-backed supervised recovery';

describe('recoverStageATaskSupervised (issue #2828)', () => {
	test('repairs the idle post-force wedge and persists the audited marker', async () => {
		await settleAt(directory, '7.1', 'idle');
		writeCommittedWal(directory, '7.1');
		await writeGreenBundles(directory);

		const summary = await recoverStageATaskSupervised(
			directory,
			architectSession('arch-1'),
			{ taskId: '7.1', reason: REASON },
		);

		expect(summary.state).toBe('pre_check_passed');
		expect(summary.alreadyRecovered).toBe(false);
		expect(summary.auditEventRecorded).toBe(true);
		expect(summary.transitionId).toBe('stage-a-supervised:7.1:2');
		const evidence = await readTaskEvidence(directory, '7.1');
		const workflow = getTaskWorkflowSnapshot(evidence);
		expect(workflow.state).toBe('pre_check_passed');
		expect(workflow.generation).toBe(2);
		expect(workflow.settlementRecovery).toBe(true);
		expect(evidence?.gates?.pre_check).toBeDefined();
		const events = readRepairEvents(directory);
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({
			action: 'repaired',
			via: 'recover_stage_a_task',
			taskId: '7.1',
			settlementRecovery: true,
			reason: REASON,
		});
	});

	test('repairs the blocked wedge with Stage A proof present', async () => {
		await settleAt(directory, '7.2', 'blocked');
		writeCommittedWal(directory, '7.2');
		await writeGreenBundles(directory);

		const summary = await recoverStageATaskSupervised(
			directory,
			architectSession('arch-2'),
			{ taskId: '7.2', reason: REASON },
		);

		expect(summary.state).toBe('pre_check_passed');
		const workflow = getTaskWorkflowSnapshot(
			await readTaskEvidence(directory, '7.2'),
		);
		expect(workflow.state).toBe('pre_check_passed');
		expect(workflow.generation).toBe(1);
		expect(workflow.settlementRecovery).toBe(true);
	});

	test('refuses a non-architect session with the exact token, state untouched', async () => {
		await settleAt(directory, '7.3', 'idle');
		writeCommittedWal(directory, '7.3');
		await writeGreenBundles(directory);

		let message = '';
		try {
			await recoverStageATaskSupervised(
				directory,
				architectSession('coder-1', 'coder'),
				{ taskId: '7.3', reason: REASON },
			);
		} catch (error) {
			message = error instanceof Error ? error.message : String(error);
		}
		expect(message).toContain(
			'RECOVER_STAGE_A_ARCHITECT_REQUIRED: recover_stage_a_task requires an active architect session',
		);
		const workflow = getTaskWorkflowSnapshot(
			await readTaskEvidence(directory, '7.3'),
		);
		expect(workflow.state).toBe('idle');
	});

	test('requires a reason', async () => {
		await settleAt(directory, '7.4', 'idle');
		writeCommittedWal(directory, '7.4');
		await writeGreenBundles(directory);
		await expect(
			recoverStageATaskSupervised(directory, architectSession('arch-4'), {
				taskId: '7.4',
			}),
		).rejects.toThrow('RECOVER_STAGE_A_REASON_REQUIRED');
		await expect(
			recoverStageATaskSupervised(directory, architectSession('arch-4'), {
				taskId: '7.4',
				reason: '   ',
			}),
		).rejects.toThrow('RECOVER_STAGE_A_REASON_REQUIRED');
	});

	test('refuses a blank task id', async () => {
		await expect(
			recoverStageATaskSupervised(directory, architectSession('arch-5'), {
				taskId: ' ',
				reason: REASON,
			}),
		).rejects.toThrow('RECOVER_STAGE_A_UNKNOWN_TASK');
	});

	test('refuses a state outside the settlement wedge', async () => {
		const { transitionTaskWorkflowEvidence } = await import(
			'../../../src/gate-evidence'
		);
		await transitionTaskWorkflowEvidence(directory, '7.6', {
			type: 'accepted_mutation',
			agentType: 'coder',
			expectedGeneration: 0,
			transitionId: 'coder:setup-7.6',
		});
		await expect(
			recoverStageATaskSupervised(directory, architectSession('arch-6'), {
				taskId: '7.6',
				reason: REASON,
			}),
		).rejects.toThrow('RECOVER_STAGE_A_STATE_REQUIRED');
	});

	test('refuses without any durable settlement receipt (no WAL, no requirements receipt)', async () => {
		await settleAt(directory, '7.7', 'idle');
		stripRequirementsLedger(directory, '7.7');
		await writeGreenBundles(directory);
		await expect(
			recoverStageATaskSupervised(directory, architectSession('arch-7'), {
				taskId: '7.7',
				reason: REASON,
			}),
		).rejects.toThrow('RECOVER_STAGE_A_SETTLEMENT_REQUIRED');
	});

	test('refuses an accepted:false settlement WAL when no accepted_mutation receipt exists', async () => {
		await settleAt(directory, '7.8', 'idle');
		stripRequirementsLedger(directory, '7.8');
		writeCommittedWal(directory, '7.8', false);
		await writeGreenBundles(directory);
		await expect(
			recoverStageATaskSupervised(directory, architectSession('arch-8'), {
				taskId: '7.8',
				reason: REASON,
			}),
		).rejects.toThrow('RECOVER_STAGE_A_SETTLEMENT_REQUIRED');
	});

	test('refuses without green post-settlement pre-check proof', async () => {
		await settleAt(directory, '7.9', 'idle');
		writeCommittedWal(directory, '7.9');
		await writeGreenBundles(directory, true);
		await expect(
			recoverStageATaskSupervised(directory, architectSession('arch-9'), {
				taskId: '7.9',
				reason: REASON,
			}),
		).rejects.toThrow('RECOVER_STAGE_A_GREEN_PRECHECK_REQUIRED');
	});

	test('second call is an idempotent no-op', async () => {
		await settleAt(directory, '7.10', 'idle');
		writeCommittedWal(directory, '7.10');
		await writeGreenBundles(directory);
		await recoverStageATaskSupervised(directory, architectSession('arch-10'), {
			taskId: '7.10',
			reason: REASON,
		});

		const second = await recoverStageATaskSupervised(
			directory,
			architectSession('arch-10'),
			{ taskId: '7.10', reason: REASON },
		);

		expect(second.alreadyRecovered).toBe(true);
		expect(readRepairEvents(directory)).toHaveLength(1);
		const workflow = getTaskWorkflowSnapshot(
			await readTaskEvidence(directory, '7.10'),
		);
		expect(workflow.state).toBe('pre_check_passed');
		expect(workflow.generation).toBe(2);
	});

	test('concurrent calls never duplicate the durable transition', async () => {
		await settleAt(directory, '7.11', 'idle');
		writeCommittedWal(directory, '7.11');
		await writeGreenBundles(directory);

		const results = await Promise.allSettled([
			recoverStageATaskSupervised(directory, architectSession('arch-11a'), {
				taskId: '7.11',
				reason: REASON,
			}),
			recoverStageATaskSupervised(directory, architectSession('arch-11b'), {
				taskId: '7.11',
				reason: REASON,
			}),
		]);

		const settled = results.filter(
			(result): result is PromiseFulfilledResult<{ state: string }> =>
				result.status === 'fulfilled',
		);
		expect(settled.length).toBe(2);
		const workflow = getTaskWorkflowSnapshot(
			await readTaskEvidence(directory, '7.11'),
		);
		expect(workflow.state).toBe('pre_check_passed');
		expect(workflow.generation).toBe(2);
		// Exactly one settlement-backed transition id can ever exist per
		// generation; the deterministic transitionId makes the loser a
		// duplicate no-op rather than a second write.
		const transitionEvents = readRepairEvents(directory).filter(
			(event) => event.action === 'repaired',
		);
		for (const event of transitionEvents) {
			expect(event.transitionId).toBe('stage-a-supervised:7.11:2');
		}
	});
});
