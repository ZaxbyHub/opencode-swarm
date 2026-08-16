import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ToolContext } from '@opencode-ai/plugin/tool';
import { resetSwarmState } from '../../../src/state';
import {
	executeUpdateTaskStatus,
	_internals as statusInternals,
} from '../../../src/tools/update-task-status';
import { _internals as terminalInternals } from '../../../src/workflow/task-terminal';
import { canonicalTmpDir } from '../../helpers/tmpdir.js';

function seedRepairCrashState(directory: string): void {
	fs.mkdirSync(path.join(directory, '.swarm', 'evidence'), { recursive: true });
	fs.writeFileSync(
		path.join(directory, '.swarm', 'plan.json'),
		JSON.stringify({
			schema_version: '1.0.0',
			title: 'Repair recovery race',
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
							files_touched: ['src/exact.ts'],
						},
					],
				},
			],
		}),
	);
	fs.writeFileSync(
		path.join(directory, '.swarm', 'evidence', '1.1.json'),
		JSON.stringify({
			taskId: '1.1',
			required_gates: ['reviewer', 'test_engineer'],
			gates: {
				pre_check: {
					sessionId: 'system',
					timestamp: '2026-08-14T00:00:00.000Z',
					agent: 'pre_check',
				},
				reviewer: {
					sessionId: 'reviewer',
					timestamp: '2026-08-14T00:00:01.000Z',
					agent: 'reviewer',
				},
				test_engineer: {
					sessionId: 'test',
					timestamp: '2026-08-14T00:00:02.000Z',
					agent: 'test_engineer',
				},
			},
			workflow: {
				schema: 'exact-task-v1',
				state: 'tests_run',
				generation: 3,
				retryCount: 0,
				lastOutcome: 'stage_b_completed',
				updatedAt: '2026-08-14T00:00:02.000Z',
			},
		}),
	);
}

function seedReadyTask(directory: string): void {
	fs.mkdirSync(path.join(directory, '.swarm', 'evidence'), { recursive: true });
	fs.writeFileSync(
		path.join(directory, '.swarm', 'plan.json'),
		JSON.stringify({
			schema_version: '1.0.0',
			title: 'Terminal recovery race',
			swarm: 'test-swarm',
			current_phase: 1,
			phases: [
				{
					id: 1,
					name: 'Phase 1',
					status: 'in_progress',
					required_agents: ['reviewer'],
					tasks: [
						{
							id: '1.1',
							phase: 1,
							status: 'in_progress',
							size: 'small',
							description: 'Ready task',
							depends: [],
							files_touched: ['src/ready.ts'],
						},
					],
				},
			],
		}),
	);
	fs.writeFileSync(
		path.join(directory, '.swarm', 'evidence', '1.1.json'),
		JSON.stringify({
			taskId: '1.1',
			required_gates: ['reviewer', 'test_engineer'],
			gates: {
				pre_check: {
					sessionId: 'stage-a',
					timestamp: '2026-08-14T00:00:00.000Z',
					agent: 'pre_check',
				},
				reviewer: {
					sessionId: 'reviewer',
					timestamp: '2026-08-14T00:00:01.000Z',
					agent: 'reviewer',
				},
				test_engineer: {
					sessionId: 'test',
					timestamp: '2026-08-14T00:00:02.000Z',
					agent: 'test_engineer',
				},
			},
			workflow: {
				schema: 'exact-task-v1',
				generation: 1,
				state: 'tests_run',
				retryCount: 0,
				lastOutcome: 'stage_b_completed',
				lastTransitionId: 'tested',
				updatedAt: '2026-08-14T00:00:02.000Z',
			},
		}),
	);
}

describe('issue #2098 lock-time exact-task recovery', () => {
	let directory: string;
	let originalTryAcquireLock: typeof statusInternals.tryAcquireLock;
	let originalUpdateTaskStatus: typeof statusInternals.updateTaskStatus;
	let originalApplyTerminalEvidence: typeof terminalInternals.applyTerminalEvidence;

	beforeEach(() => {
		resetSwarmState();
		directory = fs.realpathSync(
			fs.mkdtempSync(path.join(canonicalTmpDir(), 'uts-lock-recovery-2098-')),
		);
		originalTryAcquireLock = statusInternals.tryAcquireLock;
		originalUpdateTaskStatus = statusInternals.updateTaskStatus;
		originalApplyTerminalEvidence = terminalInternals.applyTerminalEvidence;
	});

	afterEach(() => {
		statusInternals.tryAcquireLock = originalTryAcquireLock;
		statusInternals.updateTaskStatus = originalUpdateTaskStatus;
		terminalInternals.applyTerminalEvidence = originalApplyTerminalEvidence;
		resetSwarmState();
		fs.rmSync(directory, { recursive: true, force: true });
	});

	test('rechecks and finishes a PREPARED repair WAL that appears only after the fast-path read for a different outer repair request', async () => {
		seedRepairCrashState(directory);

		statusInternals.tryAcquireLock = mock(async (...args) => {
			await originalUpdateTaskStatus(directory, '1.1', 'in_progress', {
				force: true,
				planLockAlreadyHeld: true,
			});
			fs.mkdirSync(path.join(directory, '.swarm', 'task-repairs'), {
				recursive: true,
			});
			fs.writeFileSync(
				path.join(directory, '.swarm', 'task-repairs', '1.1.json'),
				JSON.stringify({
					version: 1,
					state: 'PREPARED',
					taskId: '1.1',
					transitionId: 'race-repair',
					reason: 'repair raced into lock window',
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
			return originalTryAcquireLock(...args);
		}) as typeof statusInternals.tryAcquireLock;

		const result = await executeUpdateTaskStatus(
			{
				task_id: '1.1',
				status: 'in_progress',
				force: true,
				expected_state: 'tests_run',
				expected_generation: 3,
				target_state: 'idle',
				reason: 'outer repair request',
				transition_id: 'outer-repair',
			},
			directory,
			{ sessionID: 'caller' } as ToolContext,
		);

		expect(result.success).toBe(false);
		expect(result.errors?.join(' ')).toContain('TASK_REPAIR_NOT_BACKWARD');
		expect(
			JSON.parse(
				fs.readFileSync(
					path.join(directory, '.swarm', 'task-repairs', '1.1.json'),
					'utf-8',
				),
			),
		).toMatchObject({
			state: 'COMMITTED',
			transitionId: 'race-repair',
		});
		expect(
			JSON.parse(
				fs.readFileSync(path.join(directory, '.swarm', 'plan.json'), 'utf-8'),
			).phases[0].tasks[0].status,
		).toBe('in_progress');
		expect(
			JSON.parse(
				fs.readFileSync(
					path.join(directory, '.swarm', 'evidence', '1.1.json'),
					'utf-8',
				),
			).workflow,
		).toMatchObject({ state: 'idle', generation: 4 });
		const eventsPath = path.join(directory, '.swarm', 'events.jsonl');
		expect(fs.existsSync(eventsPath)).toBe(true);
		expect(fs.readFileSync(eventsPath, 'utf-8')).toContain('race-repair');
		expect(fs.readFileSync(eventsPath, 'utf-8')).not.toContain('outer-repair');
	});

	test('under-lock repair recovery uses the current PREPARED WAL transition, not stale pre-lock exact-retry state', async () => {
		seedRepairCrashState(directory);
		fs.mkdirSync(path.join(directory, '.swarm', 'task-repairs'), {
			recursive: true,
		});
		fs.writeFileSync(
			path.join(directory, '.swarm', 'task-repairs', '1.1.json'),
			JSON.stringify({
				version: 1,
				state: 'PREPARED',
				taskId: '1.1',
				transitionId: 'outer-repair',
				reason: 'stale pre-lock exact retry marker',
				actor: 'architect',
				oldPlanStatus: 'completed',
				newPlanStatus: 'in_progress',
				oldWorkflowState: 'tests_run',
				newWorkflowState: 'idle',
				oldGeneration: 3,
				generation: 4,
				recordedAt: '2026-08-14T00:00:02.000Z',
			}),
		);
		statusInternals.tryAcquireLock = mock(async (...args) => {
			await originalUpdateTaskStatus(directory, '1.1', 'in_progress', {
				force: true,
				planLockAlreadyHeld: true,
			});
			fs.writeFileSync(
				path.join(directory, '.swarm', 'task-repairs', '1.1.json'),
				JSON.stringify({
					version: 1,
					state: 'PREPARED',
					taskId: '1.1',
					transitionId: 'race-repair-b',
					reason: 'lock-gap replacement repair',
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
			return originalTryAcquireLock(...args);
		}) as typeof statusInternals.tryAcquireLock;

		const result = await executeUpdateTaskStatus(
			{
				task_id: '1.1',
				status: 'in_progress',
				force: true,
				expected_state: 'tests_run',
				expected_generation: 3,
				target_state: 'idle',
				reason: 'outer repair request',
				transition_id: 'outer-repair',
			},
			directory,
			{ sessionID: 'caller' } as ToolContext,
		);

		expect(result.success).toBe(false);
		expect(result.errors?.join(' ')).toContain('TASK_REPAIR_NOT_BACKWARD');
		expect(
			JSON.parse(
				fs.readFileSync(
					path.join(directory, '.swarm', 'task-repairs', '1.1.json'),
					'utf-8',
				),
			),
		).toMatchObject({
			state: 'COMMITTED',
			transitionId: 'race-repair-b',
		});
		expect(
			JSON.parse(
				fs.readFileSync(path.join(directory, '.swarm', 'plan.json'), 'utf-8'),
			).phases[0].tasks[0].status,
		).toBe('in_progress');
		expect(
			JSON.parse(
				fs.readFileSync(
					path.join(directory, '.swarm', 'evidence', '1.1.json'),
					'utf-8',
				),
			).workflow,
		).toMatchObject({ state: 'idle', generation: 4 });
		const eventsPath = path.join(directory, '.swarm', 'events.jsonl');
		expect(fs.readFileSync(eventsPath, 'utf-8')).toContain('race-repair-b');
		expect(fs.readFileSync(eventsPath, 'utf-8')).not.toContain(
			'"transitionId":"outer-repair"',
		);
	});

	test('matching transition_id on a non-repair request still recovers the late repair WAL before outer mutation', async () => {
		seedReadyTask(directory);
		statusInternals.tryAcquireLock = mock(async (...args) => {
			fs.mkdirSync(path.join(directory, '.swarm', 'task-repairs'), {
				recursive: true,
			});
			fs.writeFileSync(
				path.join(directory, '.swarm', 'task-repairs', '1.1.json'),
				JSON.stringify({
					version: 1,
					state: 'PREPARED',
					taskId: '1.1',
					transitionId: 'shared-transition',
					reason: 'late matching-id repair',
					actor: 'architect',
					oldPlanStatus: 'completed',
					newPlanStatus: 'in_progress',
					oldWorkflowState: 'tests_run',
					newWorkflowState: 'idle',
					oldGeneration: 1,
					generation: 2,
					recordedAt: '2026-08-14T00:00:03.000Z',
				}),
			);
			return originalTryAcquireLock(...args);
		}) as typeof statusInternals.tryAcquireLock;

		const result = await executeUpdateTaskStatus(
			{
				task_id: '1.1',
				status: 'blocked',
				transition_id: 'shared-transition',
			},
			directory,
			{ sessionID: 'caller' } as ToolContext,
		);

		expect(result.success).toBe(true);
		expect(
			JSON.parse(
				fs.readFileSync(
					path.join(directory, '.swarm', 'task-repairs', '1.1.json'),
					'utf-8',
				),
			),
		).toMatchObject({
			state: 'COMMITTED',
			transitionId: 'shared-transition',
		});
		expect(
			JSON.parse(
				fs.readFileSync(path.join(directory, '.swarm', 'plan.json'), 'utf-8'),
			).phases[0].tasks[0].status,
		).toBe('blocked');
		expect(
			JSON.parse(
				fs.readFileSync(
					path.join(directory, '.swarm', 'evidence', '1.1.json'),
					'utf-8',
				),
			).workflow,
		).toMatchObject({ state: 'blocked', generation: 2 });
		expect(
			JSON.parse(
				fs.readFileSync(
					path.join(directory, '.swarm', 'task-terminals', '1.1.json'),
					'utf-8',
				),
			).state,
		).toBe('COMMITTED');
	});

	test('reapplies settled authorization after terminal recovery changes the locked task to completed', async () => {
		seedReadyTask(directory);
		statusInternals.tryAcquireLock = mock(async (...args) => {
			const plan = JSON.parse(
				fs.readFileSync(path.join(directory, '.swarm', 'plan.json'), 'utf-8'),
			);
			plan.phases[0].status = 'complete';
			plan.phases[0].tasks[0].status = 'completed';
			fs.writeFileSync(
				path.join(directory, '.swarm', 'plan.json'),
				JSON.stringify(plan),
			);
			fs.mkdirSync(path.join(directory, '.swarm', 'task-terminals'), {
				recursive: true,
			});
			fs.writeFileSync(
				path.join(directory, '.swarm', 'task-terminals', '1.1.json'),
				JSON.stringify({
					version: 1,
					state: 'PREPARED',
					taskId: '1.1',
					transitionId: 'race-terminal',
					actor: 'caller',
					oldPlanStatus: 'in_progress',
					newPlanStatus: 'completed',
					oldWorkflowState: 'tests_run',
					newWorkflowState: 'complete',
					generation: 1,
					qaExempt: false,
					recordedAt: '2026-08-14T00:00:03.000Z',
				}),
			);
			return originalTryAcquireLock(...args);
		}) as typeof statusInternals.tryAcquireLock;

		const result = await executeUpdateTaskStatus(
			{ task_id: '1.1', status: 'blocked' },
			directory,
			{ sessionID: 'caller' } as ToolContext,
		);

		expect(result.success).toBe(false);
		expect(result.errors?.join(' ')).toContain(
			'use force:true with exact CAS and audit fields to repair it to in_progress',
		);
		expect(
			JSON.parse(
				fs.readFileSync(
					path.join(directory, '.swarm', 'evidence', '1.1.json'),
					'utf-8',
				),
			).workflow.state,
		).toBe('complete');
		expect(
			JSON.parse(
				fs.readFileSync(
					path.join(directory, '.swarm', 'task-terminals', '1.1.json'),
					'utf-8',
				),
			),
		).toMatchObject({
			state: 'COMMITTED',
			transitionId: 'race-terminal',
		});
	});
});
