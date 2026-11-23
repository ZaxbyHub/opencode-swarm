/**
 * Settlement-wedge leg of repairWedgedStageA (issue #2828).
 *
 * The deterministic /swarm recover repair additionally recognizes tasks whose
 * workflow drifted to idle (force-repair cleared the gate proofs) or blocked
 * while a COMMITTED accepted settlement plus green post-settlement pre-check
 * bundles still justify Stage A. Split from stage-a-repair.test.ts (FR-006);
 * the live_wedge (coder_delegated) leg stays pinned there. Fixtures are
 * shared with the other #2828 suites via _settlement-recovery-2828-helpers.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
	getTaskWorkflowSnapshot,
	readTaskEvidence,
	transitionTaskWorkflowEvidence,
} from '../../../src/gate-evidence';
import {
	repairWedgedStageA,
	scanWedgedStageA,
} from '../../../src/workflow/stage-a-repair';
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
	({ dir: directory, cleanup } = createSafeTestDir('settlement-wedge-'));
});

afterEach(() => {
	cleanup();
});

describe('repairWedgedStageA settlement wedge (issue #2828)', () => {
	test('repairs the idle post-force wedge without re-running the coder', async () => {
		await settleAt(directory, '5.1', 'idle');
		writeCommittedWal(directory, '5.1');
		await writeGreenBundles(directory);

		const { results } = await repairWedgedStageA(directory, {
			taskIds: ['5.1'],
		});

		expect(results).toEqual([
			{
				taskId: '5.1',
				outcome: 'repaired',
				generation: 2,
				transitionId: 'stage-a-repair:5.1:2',
			},
		]);
		const evidence = await readTaskEvidence(directory, '5.1');
		const workflow = getTaskWorkflowSnapshot(evidence);
		expect(workflow.state).toBe('pre_check_passed');
		expect(workflow.generation).toBe(2);
		expect(workflow.settlementRecovery).toBe(true);
		expect(evidence?.gates?.pre_check).toBeDefined();
	});

	test('repairs the blocked wedge and restores the Stage B precondition', async () => {
		await settleAt(directory, '5.2', 'blocked');
		writeCommittedWal(directory, '5.2');
		await writeGreenBundles(directory);

		const { results } = await repairWedgedStageA(directory, {
			taskIds: ['5.2'],
		});

		expect(results[0]).toMatchObject({
			taskId: '5.2',
			outcome: 'repaired',
			generation: 1,
		});
		const workflow = getTaskWorkflowSnapshot(
			await readTaskEvidence(directory, '5.2'),
		);
		expect(workflow.state).toBe('pre_check_passed');
		expect(workflow.generation).toBe(1);
		expect(workflow.settlementRecovery).toBe(true);
	});

	test('emits an audited settlement recovery event with predecessor linkage', async () => {
		await settleAt(directory, '5.3', 'idle');
		writeCommittedWal(directory, '5.3');
		await writeGreenBundles(directory);

		await repairWedgedStageA(directory, { taskIds: ['5.3'] });

		const events = readRepairEvents(directory);
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({
			action: 'repaired',
			taskId: '5.3',
			settlementRecovery: true,
			via: 'swarm-recover',
			predecessorTransitionId: 'repair:setup-5.3',
		});
	});

	test('second run is idempotent (skipped_not_wedged at pre_check_passed)', async () => {
		await settleAt(directory, '5.4', 'idle');
		writeCommittedWal(directory, '5.4');
		await writeGreenBundles(directory);
		await repairWedgedStageA(directory, { taskIds: ['5.4'] });

		const second = await repairWedgedStageA(directory, { taskIds: ['5.4'] });

		expect(second.results).toEqual([
			{
				taskId: '5.4',
				outcome: 'skipped_not_wedged',
				state: 'pre_check_passed',
			},
		]);
		expect(readRepairEvents(directory)).toHaveLength(1);
	});

	test('idle without any durable settlement receipt is still refused (nothing justifies repair)', async () => {
		await settleAt(directory, '5.5', 'idle');
		stripRequirementsLedger(directory, '5.5');
		await writeGreenBundles(directory);

		const { results } = await repairWedgedStageA(directory, {
			taskIds: ['5.5'],
		});

		expect(results).toEqual([
			{ taskId: '5.5', outcome: 'skipped_not_wedged', state: 'idle' },
		]);
		const workflow = getTaskWorkflowSnapshot(
			await readTaskEvidence(directory, '5.5'),
		);
		expect(workflow.state).toBe('idle');
		expect(readRepairEvents(directory)).toHaveLength(0);
	});

	test('idle with only a not-accepted settlement WAL and no receipt is still refused', async () => {
		await settleAt(directory, '5.6', 'idle');
		stripRequirementsLedger(directory, '5.6');
		writeCommittedWal(directory, '5.6', false);
		await writeGreenBundles(directory);

		const { results } = await repairWedgedStageA(directory, {
			taskIds: ['5.6'],
		});

		expect(results).toEqual([
			{ taskId: '5.6', outcome: 'skipped_not_wedged', state: 'idle' },
		]);
		const workflow = getTaskWorkflowSnapshot(
			await readTaskEvidence(directory, '5.6'),
		);
		expect(workflow.state).toBe('idle');
		expect(workflow.generation).toBe(2);
		expect(workflow.lastTransitionId).toBe('repair:setup-5.6');
		expect(readRepairEvents(directory)).toHaveLength(0);
	});

	test('wedge state with stale bundles reports skipped_not_green', async () => {
		await settleAt(directory, '5.7', 'idle');
		writeCommittedWal(directory, '5.7');
		await writeGreenBundles(directory, true);

		const { results } = await repairWedgedStageA(directory, {
			taskIds: ['5.7'],
		});

		expect(results).toEqual([
			{
				taskId: '5.7',
				outcome: 'skipped_not_green',
				reason: 'pre_check_failed_or_stale',
			},
		]);
	});

	test('the live_wedge leg stays marker-free so the modes stay distinguishable', async () => {
		await transitionTaskWorkflowEvidence(directory, '5.8', {
			type: 'accepted_mutation',
			agentType: 'coder',
			expectedGeneration: 0,
			transitionId: 'coder:setup-5.8',
		});
		writeCommittedWal(directory, '5.8');
		await writeGreenBundles(directory);

		const { results } = await repairWedgedStageA(directory, {
			taskIds: ['5.8'],
		});

		expect(results[0]).toMatchObject({ taskId: '5.8', outcome: 'repaired' });
		const workflow = getTaskWorkflowSnapshot(
			await readTaskEvidence(directory, '5.8'),
		);
		expect(workflow.state).toBe('pre_check_passed');
		expect(workflow.settlementRecovery).toBeUndefined();
		const events = readRepairEvents(directory);
		expect(events[0]).not.toHaveProperty('settlementRecovery');
	});

	test('an already-recorded identical Stage A write logs no second audit event', async () => {
		// Whether a racing writer recorded the transition first (duplicate
		// no-op inside the lock, pinned at the primitive level in
		// settlement-recovery-reducer-2828.test.ts) or the Stage A pass simply
		// already happened, a re-run of the repair over the same receipts must
		// never append a second `repaired` audit event.
		await settleAt(directory, '5.9', 'blocked');
		writeCommittedWal(directory, '5.9');
		await writeGreenBundles(directory);
		await transitionTaskWorkflowEvidence(directory, '5.9', {
			type: 'stage_a_passed',
			settlementRecovery: true,
			expectedGeneration: 1,
			transitionId: 'stage-a-repair:5.9:1',
		});
		expect(readRepairEvents(directory)).toHaveLength(0);

		const { results } = await repairWedgedStageA(directory, {
			taskIds: ['5.9'],
		});

		expect(results).toEqual([
			{
				taskId: '5.9',
				outcome: 'skipped_not_wedged',
				state: 'pre_check_passed',
			},
		]);
		const workflow = getTaskWorkflowSnapshot(
			await readTaskEvidence(directory, '5.9'),
		);
		expect(workflow.state).toBe('pre_check_passed');
		expect(workflow.generation).toBe(1);
		expect(readRepairEvents(directory)).toHaveLength(0);
	});
});

describe('scanWedgedStageA classification (issue #2828)', () => {
	test('classifies both wedge shapes as settlement_wedge with repair allowed', async () => {
		await settleAt(directory, '6.1', 'idle');
		writeCommittedWal(directory, '6.1');
		await writeGreenBundles(directory);
		await settleAt(directory, '6.2', 'blocked');
		writeCommittedWal(directory, '6.2');

		const scan = await scanWedgedStageA(directory, { taskIds: ['6.1', '6.2'] });

		const byTask = new Map(scan.results.map((row) => [row.taskId, row]));
		expect(byTask.get('6.1')).toMatchObject({
			category: 'settlement_wedge',
			repairAllowed: true,
		});
		expect(byTask.get('6.1')?.explanation).toContain(
			'workflow at idle while a COMMITTED accepted coder settlement',
		);
		expect(byTask.get('6.2')).toMatchObject({
			category: 'settlement_wedge',
			repairAllowed: true,
		});
	});

	test('classifies a receipt-less idle task healthy, not settlement_wedge', async () => {
		await settleAt(directory, '6.3', 'idle');
		stripRequirementsLedger(directory, '6.3');
		await writeGreenBundles(directory);

		const scan = await scanWedgedStageA(directory, { taskIds: ['6.3'] });

		expect(scan.results[0]).toMatchObject({
			category: 'healthy',
			repairAllowed: false,
		});
	});
});
