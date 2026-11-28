/**
 * Requirements-receipt-backed settlement recovery (campaign-rebuild wedge).
 *
 * Background-dispatched coder rounds never write a coder-settlement WAL, so
 * the #2828 settlement-wedge recovery used to be structurally unavailable to
 * them: a task whose delivery was committed before a campaign (plan-identity)
 * rebuild re-settles every later dispatch as dispatch_no_mutation, and no
 * sanctioned architect-side path existed at all. The chain-verified
 * accepted_mutation receipt in the task-gate-requirements ledger is the same
 * durable settlement fact, so the supervised recovery and the deterministic
 * /swarm recover scan now resolve their justification WAL-first and fall back
 * to that receipt. Pins: receipt-backed success (tool + scan), WAL precedence,
 * the honest refusal when neither receipt exists, the green-bundle bar, and
 * fail-closed behavior on a corrupt requirements chain.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { freezeClock, type Restore } from '../../helpers/test-clock.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { saveEvidence } from '../../../src/evidence/manager';
import { taskGateRequirementsReceiptPath } from '../../../src/evidence/task-gate-requirements';
import {
	getTaskWorkflowSnapshot,
	readTaskEvidence,
	transitionTaskWorkflowEvidence,
} from '../../../src/gate-evidence';
import { ensureAgentSession, resetSwarmState } from '../../../src/state';
import { recoverStageATaskSupervised } from '../../../src/workflow/settlement-recovery';
import {
	repairWedgedStageA,
	scanWedgedStageA,
} from '../../../src/workflow/stage-a-repair';
import { createSafeTestDir } from '../../helpers/safe-test-dir';
import {
	readRepairEvents,
	writeCommittedWal,
} from './_settlement-recovery-2828-helpers';

let directory = '';
let cleanup = (): void => {};

let restoreClock: Restore;

beforeEach(() => {
	restoreClock = freezeClock({ fixedNow: Date.now() });
	resetSwarmState();
	({ dir: directory, cleanup } = createSafeTestDir('settlement-receipt-'));
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

const REASON = 'campaign-rebuild wedge: background coder receipt recovery';

/**
 * The 1.8-shaped fixture: a coder mutation was accepted (durable
 * accepted_mutation receipt in the requirements ledger), the campaign
 * rebuild force-reopened the workflow to idle, and NO settlement WAL exists
 * because the coder round was background-dispatched.
 */
async function reopenAtIdleWithReceiptOnly(taskId: string): Promise<void> {
	await transitionTaskWorkflowEvidence(directory, taskId, {
		type: 'accepted_mutation',
		agentType: 'coder',
		context: { testEngineerExempt: true },
		expectedGeneration: 0,
		transitionId: `background-coder:setup-${taskId}`,
	});
	await transitionTaskWorkflowEvidence(directory, taskId, {
		type: 'repair_idle',
		expectedGeneration: 1,
		transitionId: `repair:setup-${taskId}`,
	});
}

/** Green post-settlement bundles stamped AFTER the receipt was recorded. */
async function writeGreenBundlesAfterReceipt(): Promise<void> {
	// The transition writes the receipt at wall-clock now; stamp the bundles
	// one second later so the post-settlement recency predicate holds.
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

describe('recoverStageATaskSupervised (requirements-receipt justification)', () => {
	test('repairs the WAL-less background-coder wedge from the accepted_mutation receipt', async () => {
		await reopenAtIdleWithReceiptOnly('9.1');
		await writeGreenBundlesAfterReceipt();

		const summary = await recoverStageATaskSupervised(
			directory,
			architectSession('arch-receipt-1'),
			{ taskId: '9.1', reason: REASON },
		);

		expect(summary.state).toBe('pre_check_passed');
		expect(summary.alreadyRecovered).toBe(false);
		expect(summary.justification).toBe('requirements_receipt');
		const workflow = getTaskWorkflowSnapshot(
			await readTaskEvidence(directory, '9.1'),
		);
		expect(workflow.state).toBe('pre_check_passed');
		expect(workflow.settlementRecovery).toBe(true);
		const events = readRepairEvents(directory);
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({
			action: 'repaired',
			via: 'recover_stage_a_task',
			taskId: '9.1',
			settlementRecovery: true,
			justification: 'requirements_receipt',
			justificationTransitionId: 'background-coder:setup-9.1',
			reason: REASON,
		});
	});

	test('a COMMITTED settlement WAL still wins over the requirements receipt', async () => {
		await reopenAtIdleWithReceiptOnly('9.2');
		writeCommittedWal(directory, '9.2');
		await writeGreenBundlesAfterReceipt();

		const summary = await recoverStageATaskSupervised(
			directory,
			architectSession('arch-receipt-2'),
			{ taskId: '9.2', reason: REASON },
		);

		expect(summary.state).toBe('pre_check_passed');
		expect(summary.justification).toBe('settlement_wal');
	});

	test('refuses with the honest token when neither WAL nor receipt exists', async () => {
		// idle via repair_idle WITHOUT ever recording an accepted mutation
		await transitionTaskWorkflowEvidence(directory, '9.3', {
			type: 'accepted_mutation',
			agentType: 'coder',
			expectedGeneration: 0,
			transitionId: 'background-coder:setup-9.3',
		});
		await transitionTaskWorkflowEvidence(directory, '9.3', {
			type: 'repair_idle',
			expectedGeneration: 1,
			transitionId: 'repair:setup-9.3',
		});
		// Remove the requirements ledger: no durable settlement receipt at all.
		fs.rmSync(taskGateRequirementsReceiptPath(directory, '9.3'));

		let message = '';
		try {
			await recoverStageATaskSupervised(
				directory,
				architectSession('arch-receipt-3'),
				{ taskId: '9.3', reason: REASON },
			);
		} catch (error) {
			message = error instanceof Error ? error.message : String(error);
		}

		expect(message).toContain('RECOVER_STAGE_A_SETTLEMENT_REQUIRED');
		expect(message).toContain('no durable accepted coder settlement');
		const workflow = getTaskWorkflowSnapshot(
			await readTaskEvidence(directory, '9.3'),
		);
		expect(workflow.state).toBe('idle');
	});

	test('refuses when the post-receipt bundles are stale (green bar unchanged)', async () => {
		await reopenAtIdleWithReceiptOnly('9.4');
		// Green bundles dated BEFORE the receipt: no proof about the mutation.
		const stale = new Date(Date.now() - 3_600_000).toISOString();
		await saveEvidence(directory, 'secretscan', {
			task_id: 'secretscan',
			type: 'secretscan',
			timestamp: stale,
			agent: 'pre_check_batch',
			verdict: 'pass',
			summary: 'no secrets found',
			findings_count: 0,
			files_scanned: 10,
			skipped_files: 0,
			incomplete_files: 0,
			incomplete_paths: [],
		});

		let message = '';
		try {
			await recoverStageATaskSupervised(
				directory,
				architectSession('arch-receipt-4'),
				{ taskId: '9.4', reason: REASON },
			);
		} catch (error) {
			message = error instanceof Error ? error.message : String(error);
		}

		expect(message).toContain('RECOVER_STAGE_A_GREEN_PRECHECK_REQUIRED');
	});

	test('a corrupt requirements chain fails closed instead of justifying recovery', async () => {
		await reopenAtIdleWithReceiptOnly('9.5');
		await writeGreenBundlesAfterReceipt();
		const receiptPath = taskGateRequirementsReceiptPath(directory, '9.5');
		const tampered = fs
			.readFileSync(receiptPath, 'utf-8')
			.replace(
				'"sourceEvent":"accepted_mutation"',
				'"sourceEvent":"accepted_mutation "',
			);
		fs.writeFileSync(receiptPath, tampered);

		let message = '';
		try {
			await recoverStageATaskSupervised(
				directory,
				architectSession('arch-receipt-5'),
				{ taskId: '9.5', reason: REASON },
			);
		} catch (error) {
			message = error instanceof Error ? error.message : String(error);
		}

		expect(message).toContain('TASK_GATE_REQUIREMENTS_CHAIN_MISMATCH');
		const workflow = getTaskWorkflowSnapshot(
			await readTaskEvidence(directory, '9.5'),
		);
		expect(workflow.state).toBe('idle');
	});
});

describe('deterministic scan and repair (requirements-receipt justification)', () => {
	test('scanWedgedStageA classifies the WAL-less idle wedge as repairable, repairWedgedStageA writes the audited transition', async () => {
		await reopenAtIdleWithReceiptOnly('9.6');
		await writeGreenBundlesAfterReceipt();

		const scan = await scanWedgedStageA(directory, { taskIds: ['9.6'] });
		expect(scan.results).toHaveLength(1);
		expect(scan.results[0]).toMatchObject({
			taskId: '9.6',
			category: 'settlement_wedge',
		});

		const repair = await repairWedgedStageA(directory, {
			taskIds: ['9.6'],
		});
		expect(repair.results).toHaveLength(1);
		expect(repair.results[0]).toMatchObject({
			taskId: '9.6',
			outcome: 'repaired',
		});

		const workflow = getTaskWorkflowSnapshot(
			await readTaskEvidence(directory, '9.6'),
		);
		expect(workflow.state).toBe('pre_check_passed');
		expect(workflow.settlementRecovery).toBe(true);
		const events = readRepairEvents(directory);
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({
			action: 'repaired',
			via: 'swarm-recover',
			taskId: '9.6',
			settlementRecovery: true,
			justification: 'requirements_receipt',
		});
	});
});
