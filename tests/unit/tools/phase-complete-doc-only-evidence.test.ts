import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { recordGateEvidence } from '../../../src/gate-evidence';
import { swarmState } from '../../../src/state';
import { _test_exports } from '../../../src/tools/phase-complete';
import { seedStageAPassed } from '../../helpers/task-workflow-evidence';

describe('phase_complete doc-only durable fallback', () => {
	let directory: string;

	beforeEach(() => {
		directory = fs.mkdtempSync(path.join(os.tmpdir(), 'phase-doc-gate-'));
	});

	afterEach(() => {
		fs.rmSync(directory, { recursive: true, force: true });
	});

	test('phase review runtime prefers its immutable instance registry', () => {
		const alpha = Object.freeze([
			'alpha_reviewer',
			'alpha_critic_finding_validator',
		]);
		const beta = Object.freeze([
			'beta_reviewer',
			'beta_critic_finding_validator',
		]);
		const originalNames = swarmState.generatedAgentNames;
		try {
			swarmState.generatedAgentNames = ['global_reviewer'];
			expect([
				..._test_exports.resolvePhaseReviewAgentNames({
					generatedAgentNames: alpha,
				}),
			]).toEqual(alpha);
			expect([
				..._test_exports.resolvePhaseReviewAgentNames({
					generatedAgentNames: beta,
				}),
			]).toEqual(beta);
		} finally {
			swarmState.generatedAgentNames = originalNames;
		}
	});

	test('accepts completed reviewer-only doc evidence after restart', async () => {
		const generation = await seedStageAPassed(directory, '1.1', {
			testEngineerExempt: true,
		});
		await recordGateEvidence(
			directory,
			'1.1',
			'reviewer',
			'review-session',
			false,
			{ expectedGeneration: generation },
		);

		expect(
			await _test_exports.allCompletedTasksHavePassedGateEvidence(directory, [
				{ id: '1.1', status: 'completed' },
			]),
		).toBe(true);
	});

	test('rejects completed code evidence missing test_engineer', async () => {
		const generation = await seedStageAPassed(directory, '1.2');
		await recordGateEvidence(
			directory,
			'1.2',
			'reviewer',
			'review-session',
			false,
			{ expectedGeneration: generation },
		);

		expect(
			await _test_exports.allCompletedTasksHavePassedGateEvidence(directory, [
				{ id: '1.2', status: 'completed' },
			]),
		).toBe(false);
	});

	test('revokes empty-scope settlement when the completed task scope expands', async () => {
		const evidenceDirectory = path.join(directory, '.swarm', 'evidence');
		fs.mkdirSync(evidenceDirectory, { recursive: true });
		fs.writeFileSync(
			path.join(evidenceDirectory, '1.3.json'),
			JSON.stringify({
				taskId: '1.3',
				required_gates: [],
				gates: {},
				workflow: {
					schema: 'exact-task-v1',
					generation: 0,
					state: 'idle',
					retryCount: 1,
					retryHistory: ['dispatch_no_mutation'],
					retryEpoch: 1,
					lastOutcome: 'dispatch_no_mutation',
					lastTransitionId: 'settlement-1.3',
					updatedAt: '2026-09-14T00:00:00.000Z',
					noMutationSettlement: {
						generation: 0,
						transitionId: 'settlement-1.3',
						declaredFiles: [],
					},
				},
			}),
		);

		const completedTask = {
			id: '1.3',
			status: 'completed',
			files_touched: [] as string[],
		};
		expect(
			await _test_exports.allCompletedTasksHavePassedGateEvidence(directory, [
				completedTask,
			]),
		).toBe(true);
		expect(
			await _test_exports.allCompletedTasksHavePassedGateEvidence(directory, [
				{ id: '1.3', status: 'completed' },
			]),
		).toBe(false);

		completedTask.files_touched = ['src/expanded.ts'];
		expect(
			await _test_exports.allCompletedTasksHavePassedGateEvidence(directory, [
				completedTask,
			]),
		).toBe(false);
	});
});
