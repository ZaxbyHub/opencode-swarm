import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	reduceTaskWorkflowSnapshot,
	type TaskWorkflowSnapshot,
	transitionTaskWorkflowEvidence,
} from '../../../src/gate-evidence';
import {
	advanceTaskState,
	canAdvanceTaskState,
	ensureAgentSession,
	resetSwarmState,
} from '../../../src/state';
import { commitTaskTerminalUnderPlanLock } from '../../../src/workflow/task-terminal';

function snapshot(state: TaskWorkflowSnapshot['state']): TaskWorkflowSnapshot {
	return {
		schema: 'exact-task-v1',
		authoritative: true,
		generation: 3,
		state,
		retryCount: 0,
		retryHistory: [],
		retryEpoch: 0,
		lastOutcome: 'stage_b_completed',
		lastTransitionId: 'before-close',
		updatedAt: '2026-08-15T00:00:00.000Z',
	};
}

const context = {
	requiredGates: ['reviewer', 'test_engineer'],
	gates: {},
	nowIso: '2026-08-15T00:00:01.000Z',
};

describe('issue #2098 truthful close workflow terminal', () => {
	test('task_closed records a non-success closed terminal from unfinished work', () => {
		const next = reduceTaskWorkflowSnapshot(
			snapshot('tests_run'),
			{
				type: 'task_closed',
				expectedGeneration: 3,
				transitionId: 'close-terminal:1.1',
			},
			context,
		);

		expect(next.state).toBe('closed');
		expect(next.lastOutcome).toBe('task_closed');
		expect(next.generation).toBe(3);
	});

	test('task_closed cannot erase authoritative successful completion', () => {
		expect(() =>
			reduceTaskWorkflowSnapshot(
				snapshot('complete'),
				{
					type: 'task_closed',
					expectedGeneration: 3,
					transitionId: 'close-terminal:1.1',
				},
				context,
			),
		).toThrow('TASK_WORKFLOW_TERMINAL');
	});

	test('task_closed truthfully settles an already-blocked non-success task', () => {
		const next = reduceTaskWorkflowSnapshot(
			snapshot('blocked'),
			{
				type: 'task_closed',
				expectedGeneration: 3,
				transitionId: 'close-terminal:blocked-1.1',
			},
			context,
		);

		expect(next).toMatchObject({
			state: 'closed',
			lastOutcome: 'task_closed',
		});
	});

	test('closed accepts only the identical task_closed transition retry', async () => {
		const directory = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), 'close-terminal-idempotency-')),
		);
		try {
			const event = {
				type: 'task_closed' as const,
				expectedGeneration: 0,
				transitionId: 'close-terminal:stable-1.1',
			};
			await transitionTaskWorkflowEvidence(directory, '1.1', event);
			const evidencePath = path.join(
				directory,
				'.swarm',
				'evidence',
				'1.1.json',
			);
			const committedBytes = fs.readFileSync(evidencePath);

			await transitionTaskWorkflowEvidence(directory, '1.1', event);
			expect(fs.readFileSync(evidencePath)).toEqual(committedBytes);

			await expect(
				transitionTaskWorkflowEvidence(directory, '1.1', {
					...event,
					transitionId: 'close-terminal:different-1.1',
				}),
			).rejects.toThrow('TASK_WORKFLOW_TERMINAL');
			expect(fs.readFileSync(evidencePath)).toEqual(committedBytes);
		} finally {
			fs.rmSync(directory, { recursive: true, force: true });
		}
	});

	test('plan-bound close commits v2 WAL and exact closed evidence', async () => {
		const directory = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), 'close-terminal-state-2098-')),
		);
		try {
			fs.mkdirSync(path.join(directory, '.swarm'), { recursive: true });
			const result = await commitTaskTerminalUnderPlanLock({
				directory,
				taskId: '1.1',
				actor: 'close-test',
				transitionId: 'close-terminal:epoch:1.1',
				currentPlanStatus: 'in_progress',
				targetStatus: 'closed',
				qaExempt: false,
				planIdentityHash: 'a'.repeat(64),
				planEpoch: '11111111-1111-4111-8111-111111111111',
				currentPlan: { status: 'in_progress' },
				updatePlan: async () => ({ status: 'closed' }),
			});

			expect(result.evidence.workflow?.state).toBe('closed');
			expect(result.evidence.workflow?.lastOutcome).toBe('task_closed');
			const wal = JSON.parse(
				fs.readFileSync(
					path.join(directory, '.swarm', 'task-terminals', '1.1.json'),
					'utf-8',
				),
			);
			expect(wal).toMatchObject({
				version: 2,
				state: 'COMMITTED',
				newPlanStatus: 'closed',
				newWorkflowState: 'closed',
				planEpoch: '11111111-1111-4111-8111-111111111111',
			});
		} finally {
			fs.rmSync(directory, { recursive: true, force: true });
		}
	});

	test('legacy linear helpers reject every non-linear source without mutation', () => {
		resetSwarmState();
		const session = ensureAgentSession('nonlinear-close-2098');
		for (const terminal of [
			'blocked',
			'rework_required',
			'closed',
			'complete',
		] as const) {
			session.taskWorkflowStates.set('1.1', terminal);
			const before = [...session.taskWorkflowStates];
			expect(canAdvanceTaskState(session, '1.1', 'reviewer_run')).toBe(false);
			expect(() => advanceTaskState(session, '1.1', 'reviewer_run')).toThrow(
				'INVALID_TASK_STATE_TRANSITION',
			);
			expect([...session.taskWorkflowStates]).toEqual(before);
		}
		resetSwarmState();
	});
});
