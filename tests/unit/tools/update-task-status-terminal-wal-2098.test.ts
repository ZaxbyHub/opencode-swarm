import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ToolContext } from '@opencode-ai/plugin/tool';
import {
	assertTaskEvidenceWriteAllowed,
	transitionTaskWorkflowEvidence,
} from '../../../src/gate-evidence';
import { ensureAgentSession, resetSwarmState } from '../../../src/state';
import {
	executeUpdateTaskStatus,
	_internals as statusInternals,
} from '../../../src/tools/update-task-status';
import { _internals as terminalInternals } from '../../../src/workflow/task-terminal';
import { canonicalTmpDir } from '../../helpers/tmpdir.js';

function seedReadyTask(directory: string): void {
	fs.mkdirSync(path.join(directory, '.swarm', 'evidence'), { recursive: true });
	fs.writeFileSync(
		path.join(directory, '.swarm', 'plan.json'),
		JSON.stringify({
			schema_version: '1.0.0',
			title: 'Terminal WAL test',
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

describe('issue #2098 terminal status WAL', () => {
	let directory: string;
	let originalApply: typeof terminalInternals.applyTerminalEvidence;
	let originalUpdate: typeof statusInternals.updateTaskStatus;

	beforeEach(() => {
		resetSwarmState();
		directory = fs.realpathSync(
			fs.mkdtempSync(path.join(canonicalTmpDir(), 'task-terminal-wal-2098-')),
		);
		seedReadyTask(directory);
		originalApply = terminalInternals.applyTerminalEvidence;
		originalUpdate = statusInternals.updateTaskStatus;
	});

	afterEach(() => {
		terminalInternals.applyTerminalEvidence = originalApply;
		statusInternals.updateTaskStatus = originalUpdate;
		resetSwarmState();
		fs.rmSync(directory, { recursive: true, force: true });
	});

	test('recovers plan-completed old-evidence crash window before the next exact-task operation', async () => {
		terminalInternals.applyTerminalEvidence = mock(async () => {
			throw new Error('injected terminal evidence failure');
		}) as typeof terminalInternals.applyTerminalEvidence;

		const failed = await executeUpdateTaskStatus(
			{ task_id: '1.1', status: 'completed' },
			directory,
			{ sessionID: 'caller' } as ToolContext,
		);

		expect(failed.success).toBe(false);
		expect(
			JSON.parse(
				fs.readFileSync(path.join(directory, '.swarm', 'plan.json'), 'utf-8'),
			).phases[0].tasks[0].status,
		).toBe('completed');
		expect(
			JSON.parse(
				fs.readFileSync(
					path.join(directory, '.swarm', 'evidence', '1.1.json'),
					'utf-8',
				),
			).workflow.state,
		).toBe('tests_run');
		expect(
			JSON.parse(
				fs.readFileSync(
					path.join(directory, '.swarm', 'task-terminals', '1.1.json'),
					'utf-8',
				),
			).state,
		).toBe('PREPARED');
		const evidenceBeforeLateCoder = fs.readFileSync(
			path.join(directory, '.swarm', 'evidence', '1.1.json'),
			'utf-8',
		);
		await expect(
			transitionTaskWorkflowEvidence(directory, '1.1', {
				type: 'accepted_mutation',
				agentType: 'coder',
				expectedGeneration: 1,
				transitionId: 'late-coder-after-terminal-prepare',
			}),
		).rejects.toThrow('TASK_TERMINAL_PREPARED');
		expect(
			fs.readFileSync(
				path.join(directory, '.swarm', 'evidence', '1.1.json'),
				'utf-8',
			),
		).toBe(evidenceBeforeLateCoder);

		terminalInternals.applyTerminalEvidence = originalApply;
		const caller = ensureAgentSession('caller');
		caller.taskWorkflowStates.set('1.1', 'tests_run');
		await executeUpdateTaskStatus(
			{ task_id: '1.1', status: 'completed' },
			directory,
			{ sessionID: 'caller' } as ToolContext,
		);

		const evidence = JSON.parse(
			fs.readFileSync(
				path.join(directory, '.swarm', 'evidence', '1.1.json'),
				'utf-8',
			),
		);
		expect(evidence.workflow.state).toBe('complete');
		expect(caller.taskWorkflowStates.get('1.1')).toBe('complete');
		expect(
			JSON.parse(
				fs.readFileSync(
					path.join(directory, '.swarm', 'task-terminals', '1.1.json'),
					'utf-8',
				),
			).state,
		).toBe('COMMITTED');
	});

	test('aborts PREPARED terminal WAL when plan and evidence both remain old', async () => {
		statusInternals.updateTaskStatus = mock(async () => {
			throw new Error('injected plan failure after PREPARED');
		}) as typeof statusInternals.updateTaskStatus;

		const failed = await executeUpdateTaskStatus(
			{ task_id: '1.1', status: 'blocked' },
			directory,
			{ sessionID: 'caller' } as ToolContext,
		);
		expect(failed.success).toBe(false);
		statusInternals.updateTaskStatus = originalUpdate;

		await executeUpdateTaskStatus(
			{ task_id: '1.1', status: 'in_progress' },
			directory,
			{ sessionID: 'caller' } as ToolContext,
		);

		expect(
			JSON.parse(
				fs.readFileSync(
					path.join(directory, '.swarm', 'task-terminals', '1.1.json'),
					'utf-8',
				),
			).state,
		).toBe('ABORTED');
	});

	test('uses authoritative ledger state when projection and evidence are both old', async () => {
		// Consume the manager's one-time startup replay first. Recovery must not
		// rely on that cache because the ledger-first crash occurs later in the
		// same long-lived process.
		await statusInternals.loadPlan(directory);
		const oldProjection = fs.readFileSync(
			path.join(directory, '.swarm', 'plan.json'),
			'utf-8',
		);
		await originalUpdate(directory, '1.1', 'completed', {
			planLockAlreadyHeld: true,
		});
		fs.writeFileSync(
			path.join(directory, '.swarm', 'plan.json'),
			oldProjection,
		);
		const terminalDirectory = path.join(directory, '.swarm', 'task-terminals');
		fs.mkdirSync(terminalDirectory, { recursive: true });
		fs.writeFileSync(
			path.join(terminalDirectory, '1.1.json'),
			JSON.stringify({
				version: 1,
				state: 'PREPARED',
				taskId: '1.1',
				transitionId: 'ledger-first-completion',
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

		await executeUpdateTaskStatus(
			{ task_id: '1.1', status: 'completed' },
			directory,
			{ sessionID: 'caller' } as ToolContext,
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
				fs.readFileSync(path.join(terminalDirectory, '1.1.json'), 'utf-8'),
			).state,
		).toBe('COMMITTED');
	});

	test('finishes an old-plan/new-evidence PREPARED terminal transition', async () => {
		const evidencePath = path.join(directory, '.swarm', 'evidence', '1.1.json');
		const evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf-8'));
		evidence.workflow.state = 'complete';
		evidence.workflow.lastOutcome = 'task_completed';
		evidence.workflow.lastTransitionId = 'evidence-first-completion';
		fs.writeFileSync(evidencePath, JSON.stringify(evidence));

		const terminalDirectory = path.join(directory, '.swarm', 'task-terminals');
		fs.mkdirSync(terminalDirectory, { recursive: true });
		fs.writeFileSync(
			path.join(terminalDirectory, '1.1.json'),
			JSON.stringify({
				version: 1,
				state: 'PREPARED',
				taskId: '1.1',
				transitionId: 'evidence-first-completion',
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

		await executeUpdateTaskStatus(
			{ task_id: '1.1', status: 'completed' },
			directory,
			{ sessionID: 'caller' } as ToolContext,
		);

		expect(
			JSON.parse(
				fs.readFileSync(path.join(directory, '.swarm', 'plan.json'), 'utf-8'),
			).phases[0].tasks[0].status,
		).toBe('completed');
		expect(
			JSON.parse(
				fs.readFileSync(path.join(terminalDirectory, '1.1.json'), 'utf-8'),
			).state,
		).toBe('COMMITTED');
	});

	test('evidence fence uses the shared terminal WAL validator diagnostics', () => {
		const terminalDirectory = path.join(directory, '.swarm', 'task-terminals');
		const walPath = path.join(terminalDirectory, '1.1.json');
		fs.mkdirSync(terminalDirectory, { recursive: true });
		fs.writeFileSync(walPath, '{');

		expect(() => assertTaskEvidenceWriteAllowed(directory, '1.1')).toThrow(
			`TASK_TERMINAL_WAL_UNREADABLE: ${walPath}`,
		);
		expect(() => assertTaskEvidenceWriteAllowed(directory, '1.1')).toThrow(
			'Preserve this file and reconcile the task terminal transition before moving it aside.',
		);
	});

	test('terminal update path surfaces the same shared malformed WAL error', async () => {
		const planBefore = fs.readFileSync(
			path.join(directory, '.swarm', 'plan.json'),
			'utf-8',
		);
		const evidenceBefore = fs.readFileSync(
			path.join(directory, '.swarm', 'evidence', '1.1.json'),
			'utf-8',
		);
		const terminalDirectory = path.join(directory, '.swarm', 'task-terminals');
		const walPath = path.join(terminalDirectory, '1.1.json');
		fs.mkdirSync(terminalDirectory, { recursive: true });
		fs.writeFileSync(walPath, '{');

		const result = await executeUpdateTaskStatus(
			{ task_id: '1.1', status: 'completed' },
			directory,
			{ sessionID: 'caller' } as ToolContext,
		);

		expect(result.success).toBe(false);
		expect(result.errors?.[0]).toContain(
			`TASK_TERMINAL_WAL_UNREADABLE: ${walPath}`,
		);
		expect(result.errors?.[0]).toContain(
			'Preserve this file and reconcile the task terminal transition before moving it aside.',
		);
		expect(
			fs.readFileSync(path.join(directory, '.swarm', 'plan.json'), 'utf-8'),
		).toBe(planBefore);
		expect(
			fs.readFileSync(
				path.join(directory, '.swarm', 'evidence', '1.1.json'),
				'utf-8',
			),
		).toBe(evidenceBefore);
	});
});
