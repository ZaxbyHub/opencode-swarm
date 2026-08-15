import * as fs from 'node:fs';
import * as path from 'node:path';

export const TASK_ID = '1.1';

export function repairArgs(overrides: Record<string, unknown> = {}) {
	return {
		task_id: TASK_ID,
		status: 'in_progress',
		force: true,
		expected_state: 'tests_run',
		expected_generation: 3,
		target_state: 'idle' as const,
		reason: 'Reviewer found a post-completion defect',
		transition_id: 'repair-1.1-generation-3',
		...overrides,
	};
}

export function seedSettledRepairState(directory: string): void {
	const swarmDir = path.join(directory, '.swarm');
	fs.mkdirSync(path.join(swarmDir, 'evidence'), { recursive: true });
	fs.writeFileSync(
		path.join(swarmDir, 'plan.json'),
		JSON.stringify(
			{
				schema_version: '1.0.0',
				title: 'Repair audit resilience',
				swarm: 'test-swarm',
				current_phase: 1,
				phases: [
					{
						id: 1,
						name: 'Phase 1',
						status: 'complete',
						tasks: [
							{
								id: TASK_ID,
								phase: 1,
								status: 'completed',
								size: 'small',
								description: 'Exact repaired task',
								depends: [],
								files_touched: ['src/exact.ts'],
							},
						],
					},
				],
			},
			null,
			2,
		),
	);
	fs.writeFileSync(
		path.join(swarmDir, 'evidence', `${TASK_ID}.json`),
		JSON.stringify(
			{
				taskId: TASK_ID,
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
