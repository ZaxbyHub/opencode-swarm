import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ToolContext } from '@opencode-ai/plugin/tool';
import { resetStartupLedgerCheck } from '../../../src/plan/manager';
import { resetSwarmState } from '../../../src/state';
import { executeUpdateTaskStatus } from '../../../src/tools/update-task-status';
import { resetSwarmArtifactCache } from '../../../src/utils/swarm-artifact-cache';

const TASK_ID = '1.1';
const REPAIR_ARGS = {
	task_id: TASK_ID,
	status: 'in_progress',
	force: true,
	expected_state: 'tests_run',
	expected_generation: 3,
	target_state: 'idle' as const,
	reason: 'Reviewer found a post-completion defect',
	transition_id: 'repair-1.1-generation-3',
};

interface ArtifactSnapshot {
	plan: string;
	evidence: string;
	wal: string;
	events: string;
}

function seedSettledRepairState(directory: string): void {
	const swarmDir = path.join(directory, '.swarm');
	fs.mkdirSync(path.join(swarmDir, 'evidence'), { recursive: true });
	fs.writeFileSync(
		path.join(swarmDir, 'plan.json'),
		JSON.stringify(
			{
				schema_version: '1.0.0',
				title: 'Repair idempotency conflict',
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

function snapshotArtifacts(directory: string): ArtifactSnapshot {
	const swarmDir = path.join(directory, '.swarm');
	return {
		plan: fs.readFileSync(path.join(swarmDir, 'plan.json'), 'utf8'),
		evidence: fs.readFileSync(
			path.join(swarmDir, 'evidence', `${TASK_ID}.json`),
			'utf8',
		),
		wal: fs.readFileSync(
			path.join(swarmDir, 'task-repairs', `${TASK_ID}.json`),
			'utf8',
		),
		events: fs.readFileSync(path.join(swarmDir, 'events.jsonl'), 'utf8'),
	};
}

describe('issue #2098 repair transition payload immutability', () => {
	let directory: string;
	const context = { sessionID: 'repair-idempotency-caller' } as ToolContext;

	beforeEach(() => {
		resetStartupLedgerCheck();
		resetSwarmArtifactCache();
		resetSwarmState();
		directory = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), 'repair-idempotency-2098-')),
		);
		seedSettledRepairState(directory);
	});

	afterEach(() => {
		resetSwarmState();
		fs.rmSync(directory, { recursive: true, force: true });
	});

	async function commitRepair(): Promise<ArtifactSnapshot> {
		const result = await executeUpdateTaskStatus(
			REPAIR_ARGS,
			directory,
			context,
		);
		expect(result.success).toBe(true);
		return snapshotArtifacts(directory);
	}

	test('the exact same transition payload is byte-stable and idempotent', async () => {
		const committed = await commitRepair();

		const retry = await executeUpdateTaskStatus(
			REPAIR_ARGS,
			directory,
			context,
		);

		expect(retry.success).toBe(true);
		expect(snapshotArtifacts(directory)).toEqual(committed);
	});

	test.each([
		{
			label: 'reason',
			override: { reason: 'Different post-completion defect' },
		},
		{
			label: 'expected generation',
			override: { expected_generation: 4 },
		},
	])('rejects the same transition_id with a changed $label without any artifact write', async ({
		override,
	}) => {
		const committed = await commitRepair();

		const conflict = await executeUpdateTaskStatus(
			{ ...REPAIR_ARGS, ...override },
			directory,
			context,
		);

		expect(conflict.success).toBe(false);
		expect(conflict.errors?.join(' ')).toContain(
			'TASK_REPAIR_IDEMPOTENCY_CONFLICT',
		);
		expect(snapshotArtifacts(directory)).toEqual(committed);
	});
});
