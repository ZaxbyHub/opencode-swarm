import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { PluginConfig } from '../../../src/config';
import type { Plan } from '../../../src/config/plan-schema';
import { createDelegationGateHook } from '../../../src/hooks/delegation-gate';
import { resetSwarmState } from '../../../src/state';
import { recordPlanCriticApproval } from './_delegation-gate-helpers';

const config = {
	max_iterations: 5,
	qa_retry_limit: 3,
	inject_phase_reminders: true,
	hooks: {
		system_enhancer: true,
		compaction: true,
		agent_activity: true,
		delegation_tracker: false,
		agent_awareness_max_chars: 300,
		delegation_gate: true,
		delegation_max_chars: 4_000,
	},
} as PluginConfig;

function evidence(taskId: string) {
	return {
		taskId,
		required_gates: ['pre_check', 'reviewer', 'test_engineer'],
		gates: {
			pre_check: {
				sessionId: 'pre',
				agent: 'pre_check',
				timestamp: '2026-08-14T00:00:00.000Z',
			},
			reviewer: {
				sessionId: 'review',
				agent: 'reviewer',
				timestamp: '2026-08-14T00:00:01.000Z',
			},
			test_engineer: {
				sessionId: 'test',
				agent: 'test_engineer',
				timestamp: '2026-08-14T00:00:02.000Z',
			},
		},
		workflow: {
			schema: 'exact-task-v1',
			generation: 1,
			state: 'tests_run',
			retryCount: 0,
			retryHistory: [],
			retryEpoch: 0,
			lastOutcome: 'stage_b_completed',
			lastTransitionId: `tested-${taskId}`,
			updatedAt: '2026-08-14T00:00:02.000Z',
		},
	};
}

describe('issue #2098 exact completion capability selection', () => {
	let directory = '';

	beforeEach(async () => {
		resetSwarmState();
		directory = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), 'completion-exact-task-2098-')),
		);
		fs.mkdirSync(path.join(directory, '.swarm', 'evidence'), {
			recursive: true,
		});
		const plan: Plan = {
			schema_version: '1.0.0',
			title: 'Exact completion selection',
			swarm: 'test-swarm',
			current_phase: 1,
			phases: [
				{
					id: 1,
					name: 'Phase 1',
					status: 'in_progress',
					required_agents: ['reviewer'],
					tasks: ['1.1', '1.2'].map((id) => ({
						id,
						phase: 1,
						status: 'in_progress' as const,
						size: 'small' as const,
						description: id,
						depends: [],
						files_touched: [`src/${id}.ts`],
					})),
				},
			],
		};
		fs.writeFileSync(
			path.join(directory, '.swarm', 'plan.json'),
			JSON.stringify(plan),
		);
		for (const taskId of ['1.1', '1.2']) {
			fs.writeFileSync(
				path.join(directory, '.swarm', 'evidence', `${taskId}.json`),
				JSON.stringify(evidence(taskId)),
			);
		}
		await recordPlanCriticApproval(directory, plan);
	});

	afterEach(() => {
		resetSwarmState();
		fs.rmSync(directory, { recursive: true, force: true });
	});

	test('prefers the requested ready task over the first plan-order ready task', async () => {
		const hook = createDelegationGateHook(config, directory);
		await expect(
			hook.toolBefore(
				{
					tool: 'update_task_status',
					sessionID: 'caller',
					callID: 'complete-b',
				},
				{ args: { task_id: '1.2', status: 'completed' } },
			),
		).resolves.toBeUndefined();
	});
});
