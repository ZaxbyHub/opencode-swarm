import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ToolContext } from '@opencode-ai/plugin/tool';
import {
	_internals,
	executeUpdateTaskStatus,
} from '../../../src/tools/update-task-status';

describe('issue #2098 repair WAL ledger-first recovery', () => {
	let directory: string | undefined;

	afterEach(() => {
		if (directory) fs.rmSync(directory, { recursive: true, force: true });
		directory = undefined;
	});

	test('replays ledger directly after startup replay was already consumed', async () => {
		directory = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), 'repair-ledger-first-2098-')),
		);
		fs.mkdirSync(path.join(directory, '.swarm', 'evidence'), {
			recursive: true,
		});
		const oldPlan = {
			schema_version: '1.0.0',
			title: 'Repair ledger first',
			swarm: 'test-swarm',
			current_phase: 1,
			phases: [
				{
					id: 1,
					name: 'Phase 1',
					status: 'complete',
					tasks: [
						{
							id: '1.1',
							phase: 1,
							status: 'completed',
							size: 'small',
							description: 'Settled task',
							depends: [],
							files_touched: ['src/a.ts'],
						},
					],
				},
			],
		};
		fs.writeFileSync(
			path.join(directory, '.swarm', 'plan.json'),
			JSON.stringify(oldPlan),
		);
		fs.writeFileSync(
			path.join(directory, '.swarm', 'evidence', '1.1.json'),
			JSON.stringify({
				taskId: '1.1',
				required_gates: ['reviewer', 'test_engineer'],
				gates: {
					pre_check: {
						sessionId: 'a',
						timestamp: '2026-08-14T00:00:00.000Z',
						agent: 'pre_check',
					},
					reviewer: {
						sessionId: 'r',
						timestamp: '2026-08-14T00:00:01.000Z',
						agent: 'reviewer',
					},
					test_engineer: {
						sessionId: 't',
						timestamp: '2026-08-14T00:00:02.000Z',
						agent: 'test_engineer',
					},
				},
				workflow: {
					schema: 'exact-task-v1',
					generation: 3,
					state: 'tests_run',
					retryCount: 0,
					lastOutcome: 'stage_b_completed',
					lastTransitionId: 'tested',
					updatedAt: '2026-08-14T00:00:02.000Z',
				},
			}),
		);

		await _internals.loadPlan(directory);
		await _internals.updateTaskStatus(directory, '1.1', 'in_progress', {
			force: true,
			planLockAlreadyHeld: true,
		});
		fs.writeFileSync(
			path.join(directory, '.swarm', 'plan.json'),
			JSON.stringify(oldPlan),
		);
		fs.mkdirSync(path.join(directory, '.swarm', 'task-repairs'), {
			recursive: true,
		});
		fs.writeFileSync(
			path.join(directory, '.swarm', 'task-repairs', '1.1.json'),
			JSON.stringify({
				version: 1,
				state: 'PREPARED',
				taskId: '1.1',
				transitionId: 'ledger-first-repair',
				reason: 'recover ledger-first repair',
				actor: 'architect',
				oldPlanStatus: 'completed',
				newPlanStatus: 'in_progress',
				oldWorkflowState: 'tests_run',
				newWorkflowState: 'idle',
				oldGeneration: 3,
				generation: 4,
				recordedAt: '2026-08-14T00:00:03.000Z',
			}),
		);

		await executeUpdateTaskStatus(
			{ task_id: '1.1', status: 'in_progress' },
			directory,
			{ sessionID: 'caller' } as ToolContext,
		);

		const evidence = JSON.parse(
			fs.readFileSync(
				path.join(directory, '.swarm', 'evidence', '1.1.json'),
				'utf-8',
			),
		);
		expect(evidence.workflow).toMatchObject({ state: 'idle', generation: 4 });
		expect(
			JSON.parse(
				fs.readFileSync(
					path.join(directory, '.swarm', 'task-repairs', '1.1.json'),
					'utf-8',
				),
			).state,
		).toBe('COMMITTED');
	});
});
