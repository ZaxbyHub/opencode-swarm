import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ToolContext } from '@opencode-ai/plugin/tool';
import { transitionTaskWorkflowEvidence } from '../../../src/gate-evidence';
import {
	ensureAgentSession,
	getTaskState,
	resetSwarmState,
} from '../../../src/state';
import {
	_internals,
	executeUpdateTaskStatus,
} from '../../../src/tools/update-task-status';
import { canonicalTmpDir } from '../../helpers/tmpdir.js';

function planFixture() {
	return {
		schema_version: '1.0.0',
		title: 'Transactional status test',
		swarm: 'test-swarm',
		current_phase: 1,
		phases: [
			{
				id: 1,
				name: 'Phase 1',
				status: 'in_progress',
				tasks: [
					{
						id: '1.1',
						phase: 1,
						status: 'pending',
						size: 'small',
						description: 'Exact task',
						depends: [],
						files_touched: ['src/exact.ts'],
					},
				],
			},
		],
	};
}

function seedSettledRepairState(directory: string): void {
	const plan = planFixture();
	plan.phases[0].status = 'complete';
	plan.phases[0].tasks[0].status = 'completed';
	fs.writeFileSync(
		path.join(directory, '.swarm', 'plan.json'),
		JSON.stringify(plan, null, 2),
	);
	fs.mkdirSync(path.join(directory, '.swarm', 'evidence'), { recursive: true });
	fs.writeFileSync(
		path.join(directory, '.swarm', 'evidence', '1.1.json'),
		JSON.stringify(
			{
				taskId: '1.1',
				required_gates: ['reviewer', 'test_engineer'],
				gates: {
					pre_check: {
						sessionId: 'system',
						timestamp: '2026-01-01T00:00:00Z',
						agent: 'pre_check',
					},
					reviewer: {
						sessionId: 'review',
						timestamp: '2026-01-01T00:00:01Z',
						agent: 'reviewer',
					},
					test_engineer: {
						sessionId: 'test',
						timestamp: '2026-01-01T00:00:02Z',
						agent: 'test_engineer',
					},
				},
				workflow: {
					schema: 'exact-task-v1',
					state: 'tests_run',
					generation: 3,
					retryCount: 0,
					lastOutcome: 'stage_b_completed',
					updatedAt: '2026-01-01T00:00:02Z',
				},
			},
			null,
			2,
		),
	);
}

function seedPreparedRepairWal(directory: string): void {
	fs.mkdirSync(path.join(directory, '.swarm', 'task-repairs'), {
		recursive: true,
	});
	fs.writeFileSync(
		path.join(directory, '.swarm', 'task-repairs', '1.1.json'),
		JSON.stringify({
			version: 1,
			state: 'PREPARED',
			taskId: '1.1',
			transitionId: 'crash-repair',
			reason: 'recover crash window',
			actor: 'architect',
			oldPlanStatus: 'completed',
			newPlanStatus: 'in_progress',
			oldWorkflowState: 'tests_run',
			newWorkflowState: 'idle',
			oldGeneration: 3,
			generation: 4,
			recordedAt: '2026-08-14T00:00:00.000Z',
		}),
	);
}

describe('issue #2098 transactional update_task_status', () => {
	let directory: string;
	let originalTryAcquireLock: typeof _internals.tryAcquireLock;
	let originalUpdateTaskStatus: typeof _internals.updateTaskStatus;

	beforeEach(() => {
		resetSwarmState();
		directory = fs.realpathSync(
			fs.mkdtempSync(path.join(canonicalTmpDir(), 'uts-transactional-2098-')),
		);
		fs.mkdirSync(path.join(directory, '.swarm'), { recursive: true });
		fs.writeFileSync(
			path.join(directory, '.swarm', 'plan.json'),
			JSON.stringify(planFixture(), null, 2),
		);
		originalTryAcquireLock = _internals.tryAcquireLock;
		originalUpdateTaskStatus = _internals.updateTaskStatus;
	});

	afterEach(() => {
		_internals.tryAcquireLock = originalTryAcquireLock;
		_internals.updateTaskStatus = originalUpdateTaskStatus;
		resetSwarmState();
		fs.rmSync(directory, { recursive: true, force: true });
	});

	test('nonexistent task leaves plan, ledger, evidence, and every session unchanged', async () => {
		const caller = ensureAgentSession('caller');
		const peer = ensureAgentSession('peer');
		const planPath = path.join(directory, '.swarm', 'plan.json');
		const beforePlan = fs.readFileSync(planPath, 'utf-8');

		const result = await executeUpdateTaskStatus(
			{ task_id: '9.9', status: 'in_progress' },
			directory,
			{ sessionID: 'caller' } as ToolContext,
		);

		expect(result.success).toBe(false);
		expect(result.errors?.join(' ')).toContain('Task not found');
		expect(fs.readFileSync(planPath, 'utf-8')).toBe(beforePlan);
		expect(
			fs.existsSync(path.join(directory, '.swarm', 'plan-ledger.jsonl')),
		).toBe(false);
		expect(
			fs.existsSync(path.join(directory, '.swarm', 'evidence', '9.9.json')),
		).toBe(false);
		expect(caller.currentTaskId).toBeNull();
		expect(peer.currentTaskId).toBeNull();
		expect(getTaskState(caller, '9.9')).toBe('idle');
		expect(getTaskState(peer, '9.9')).toBe('idle');
	});

	test('lock refusal has no derived side effects', async () => {
		const caller = ensureAgentSession('caller');
		_internals.tryAcquireLock = mock(async () => ({
			acquired: false as const,
			existing: {
				filePath: 'plan.json',
				agent: 'peer',
				taskId: 'peer-write',
				timestamp: '2026-08-14T00:00:00.000Z',
				expiresAt: Number.MAX_SAFE_INTEGER,
			},
		})) as typeof _internals.tryAcquireLock;

		const result = await executeUpdateTaskStatus(
			{ task_id: '1.1', status: 'in_progress' },
			directory,
			{ sessionID: 'caller' } as ToolContext,
		);

		expect(result.success).toBe(false);
		expect(caller.currentTaskId).toBeNull();
		expect(getTaskState(caller, '1.1')).toBe('idle');
		expect(
			fs.existsSync(path.join(directory, '.swarm', 'evidence', '1.1.json')),
		).toBe(false);
	});

	test('plan write failure has no derived side effects', async () => {
		const release = mock(async () => {});
		_internals.tryAcquireLock = mock(async () => ({
			acquired: true as const,
			lock: {
				filePath: 'plan.json',
				agent: 'caller',
				taskId: 'write',
				timestamp: '2026-08-14T00:00:00.000Z',
				expiresAt: Number.MAX_SAFE_INTEGER,
				_release: release,
			},
		})) as typeof _internals.tryAcquireLock;
		_internals.updateTaskStatus = mock(async () => {
			throw new Error('injected plan write failure');
		}) as typeof _internals.updateTaskStatus;
		const caller = ensureAgentSession('caller');

		const result = await executeUpdateTaskStatus(
			{ task_id: '1.1', status: 'in_progress' },
			directory,
			{ sessionID: 'caller' } as ToolContext,
		);

		expect(result.success).toBe(false);
		expect(result.errors).toContain('injected plan write failure');
		expect(caller.currentTaskId).toBeNull();
		expect(getTaskState(caller, '1.1')).toBe('idle');
		expect(
			fs.existsSync(path.join(directory, '.swarm', 'evidence', '1.1.json')),
		).toBe(false);
		expect(release).toHaveBeenCalledTimes(1);
	});

	test('successful in_progress correlates only the caller and creates no coder debt', async () => {
		const caller = ensureAgentSession('caller');
		const peer = ensureAgentSession('peer');

		const result = await executeUpdateTaskStatus(
			{ task_id: '1.1', status: 'in_progress' },
			directory,
			{ sessionID: 'caller' } as ToolContext,
		);

		expect(result.success).toBe(true);
		expect(caller.currentTaskId).toBe('1.1');
		expect(getTaskState(caller, '1.1')).toBe('idle');
		expect(peer.currentTaskId).toBeNull();
		expect(getTaskState(peer, '1.1')).toBe('idle');
		expect(
			fs.existsSync(path.join(directory, '.swarm', 'evidence', '1.1.json')),
		).toBe(false);
	});

	test('force repair is exact-generation, backward-only, audited, and idempotent', async () => {
		seedSettledRepairState(directory);
		const caller = ensureAgentSession('caller');
		const peer = ensureAgentSession('peer');
		for (const session of [caller, peer]) {
			session.taskWorkflowStates.set('1.1', 'tests_run');
			session.stageBCompletion?.set('1.1', {
				reviewer: true,
				test_engineer: true,
			});
		}
		const args = {
			task_id: '1.1',
			status: 'in_progress',
			force: true,
			expected_state: 'tests_run',
			expected_generation: 3,
			target_state: 'idle' as const,
			reason: 'Reviewer found a post-completion defect',
			transition_id: 'repair-1.1-generation-3',
		};

		const first = await executeUpdateTaskStatus(args, directory, {
			sessionID: 'caller',
		} as ToolContext);
		const second = await executeUpdateTaskStatus(args, directory, {
			sessionID: 'caller',
		} as ToolContext);

		expect(first.success).toBe(true);
		expect(second.success).toBe(true);
		const plan = JSON.parse(
			fs.readFileSync(path.join(directory, '.swarm', 'plan.json'), 'utf-8'),
		);
		expect(plan.phases[0].tasks[0].status).toBe('in_progress');
		const evidence = JSON.parse(
			fs.readFileSync(
				path.join(directory, '.swarm', 'evidence', '1.1.json'),
				'utf-8',
			),
		);
		expect(evidence.workflow.state).toBe('idle');
		expect(evidence.workflow.generation).toBe(4);
		expect(evidence.workflow.lastTransitionId).toBe(args.transition_id);
		expect(evidence.gates.pre_check).toBeUndefined();
		expect(evidence.gates.reviewer).toBeUndefined();
		expect(evidence.gates.test_engineer).toBeUndefined();
		expect(caller.taskWorkflowStates.get('1.1')).toBe('idle');
		expect(caller.stageBCompletion?.has('1.1')).toBe(false);
		expect(caller.taskWorkflowCache?.get('1.1')?.generation).toBe(4);
		// Session projections are not globally keyed by workspace. Exact durable
		// evidence wins on rehydration; unrelated live sessions are never mutated.
		expect(peer.taskWorkflowStates.get('1.1')).toBe('tests_run');
		expect(peer.stageBCompletion?.has('1.1')).toBe(true);
		expect(peer.taskWorkflowCache?.get('1.1')).toBeUndefined();
		const auditEvents = fs
			.readFileSync(path.join(directory, '.swarm', 'events.jsonl'), 'utf-8')
			.trim()
			.split('\n')
			.map((line) => JSON.parse(line))
			.filter((event) => event.type === 'task_workflow_repaired');
		expect(auditEvents).toHaveLength(1);
	});

	test('force repair rejects stale generation and forward targets without mutation', async () => {
		seedSettledRepairState(directory);
		const planBefore = fs.readFileSync(
			path.join(directory, '.swarm', 'plan.json'),
			'utf-8',
		);

		const stale = await executeUpdateTaskStatus(
			{
				task_id: '1.1',
				status: 'in_progress',
				force: true,
				expected_state: 'tests_run',
				expected_generation: 2,
				target_state: 'idle',
				reason: 'stale request',
				transition_id: 'stale-repair',
			},
			directory,
			{ sessionID: 'caller' } as ToolContext,
		);
		const forward = await executeUpdateTaskStatus(
			{
				task_id: '1.1',
				status: 'in_progress',
				force: true,
				expected_state: 'tests_run',
				expected_generation: 3,
				target_state: 'complete',
				reason: 'invalid forward repair',
				transition_id: 'forward-repair',
			} as never,
			directory,
			{ sessionID: 'caller' } as ToolContext,
		);

		expect(stale.success).toBe(false);
		expect(stale.errors?.join(' ')).toContain('TASK_REPAIR_CAS_MISMATCH');
		expect(forward.success).toBe(false);
		expect(forward.errors?.join(' ')).toContain('target_state="idle"');
		expect(
			fs.readFileSync(path.join(directory, '.swarm', 'plan.json'), 'utf-8'),
		).toBe(planBefore);
	});

	test('PREPARED repair WAL resumes after an injected plan-write failure', async () => {
		seedSettledRepairState(directory);
		_internals.updateTaskStatus = mock(async () => {
			throw new Error('injected plan failure after PREPARED WAL');
		}) as typeof _internals.updateTaskStatus;
		const args = {
			task_id: '1.1',
			status: 'in_progress',
			force: true,
			expected_state: 'tests_run',
			expected_generation: 3,
			target_state: 'idle' as const,
			reason: 'resume repair',
			transition_id: 'resume-repair',
		};

		const failed = await executeUpdateTaskStatus(args, directory, {
			sessionID: 'caller',
		} as ToolContext);
		expect(failed.success).toBe(false);
		expect(
			JSON.parse(
				fs.readFileSync(
					path.join(directory, '.swarm', 'task-repairs', '1.1.json'),
					'utf-8',
				),
			).state,
		).toBe('PREPARED');
		const evidencePath = path.join(directory, '.swarm', 'evidence', '1.1.json');
		const evidenceBeforeLateCoder = fs.readFileSync(evidencePath, 'utf-8');
		await expect(
			transitionTaskWorkflowEvidence(directory, '1.1', {
				type: 'accepted_mutation',
				agentType: 'coder',
				expectedGeneration: 3,
				transitionId: 'late-coder-after-repair-prepare',
			}),
		).rejects.toThrow('TASK_REPAIR_PREPARED');
		expect(fs.readFileSync(evidencePath, 'utf-8')).toBe(
			evidenceBeforeLateCoder,
		);

		_internals.updateTaskStatus = originalUpdateTaskStatus;
		const recovered = await executeUpdateTaskStatus(args, directory, {
			sessionID: 'caller',
		} as ToolContext);
		expect(recovered.success).toBe(true);
		expect(
			JSON.parse(
				fs.readFileSync(
					path.join(directory, '.swarm', 'task-repairs', '1.1.json'),
					'utf-8',
				),
			).state,
		).toBe('COMMITTED');
	});

	test('lazy recovery aborts PREPARED repair when plan and evidence are untouched', async () => {
		seedSettledRepairState(directory);
		seedPreparedRepairWal(directory);
		const planBefore = fs.readFileSync(
			path.join(directory, '.swarm', 'plan.json'),
			'utf-8',
		);
		const evidenceBefore = fs.readFileSync(
			path.join(directory, '.swarm', 'evidence', '1.1.json'),
			'utf-8',
		);

		const result = await executeUpdateTaskStatus(
			{ task_id: '1.1', status: 'blocked' },
			directory,
			{ sessionID: 'caller' } as ToolContext,
		);

		expect(result.success).toBe(false);
		expect(
			JSON.parse(
				fs.readFileSync(
					path.join(directory, '.swarm', 'task-repairs', '1.1.json'),
					'utf-8',
				),
			).state,
		).toBe('ABORTED');
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

	test('lazy recovery finishes the new-plan old-evidence PREPARED window', async () => {
		seedSettledRepairState(directory);
		seedPreparedRepairWal(directory);
		const plan = JSON.parse(
			fs.readFileSync(path.join(directory, '.swarm', 'plan.json'), 'utf-8'),
		);
		plan.phases[0].status = 'in_progress';
		plan.phases[0].tasks[0].status = 'in_progress';
		fs.writeFileSync(
			path.join(directory, '.swarm', 'plan.json'),
			JSON.stringify(plan, null, 2),
		);
		const caller = ensureAgentSession('caller');
		caller.taskWorkflowStates.set('1.1', 'tests_run');
		caller.stageBCompletion?.set('1.1', {
			reviewer: true,
			test_engineer: true,
		});

		const result = await executeUpdateTaskStatus(
			{ task_id: '1.1', status: 'in_progress' },
			directory,
			{ sessionID: 'caller' } as ToolContext,
		);

		expect(result.success).toBe(true);
		const evidence = JSON.parse(
			fs.readFileSync(
				path.join(directory, '.swarm', 'evidence', '1.1.json'),
				'utf-8',
			),
		);
		expect(evidence.workflow).toMatchObject({ state: 'idle', generation: 4 });
		expect(caller.taskWorkflowStates.get('1.1')).toBe('idle');
		expect(caller.stageBCompletion?.has('1.1')).toBe(false);
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
