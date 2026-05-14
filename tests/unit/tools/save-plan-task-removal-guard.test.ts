/**
 * Regression tests for issue #853: save_plan must not silently drop tasks.
 *
 * Before this fix, save_plan replaced a plan's phases verbatim — any task
 * present in the prior plan but absent from the new args.phases was silently
 * deleted. After the fix, savePlan and executeSavePlan reject such saves
 * unless the caller explicitly enumerates the missing IDs via
 * removed_task_ids + a non-empty removal_reason.
 *
 * The guard lives at the manager layer (savePlan); the save_plan tool
 * translates removed_task_ids + removal_reason into acknowledged_removals.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type {
	SavePlanArgs,
	SavePlanResult,
} from '../../../src/tools/save-plan';
import { executeSavePlan } from '../../../src/tools/save-plan';

let tmpDir: string;

beforeEach(async () => {
	tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'save-plan-removal-'));
	await fs.mkdir(path.join(tmpDir, '.swarm'), { recursive: true });
	await fs.writeFile(path.join(tmpDir, '.swarm', 'spec.md'), '# Test Spec\n');
	await fs.writeFile(
		path.join(tmpDir, '.swarm', 'context.md'),
		'## Pending QA Gate Selection\n',
	);
});

afterEach(async () => {
	try {
		await fs.rm(tmpDir, { recursive: true, force: true });
	} catch {
		// best effort
	}
});

/**
 * Seed a 3-task plan with mixed statuses on disk:
 *   1.1 (Phase 1) → completed
 *   1.2 (Phase 1) → in_progress
 *   2.1 (Phase 2) → pending
 */
async function seedThreeTaskPlan(): Promise<void> {
	const args: SavePlanArgs = {
		title: 'Task Removal Guard Test',
		swarm_id: 'regression',
		phases: [
			{
				id: 1,
				name: 'Phase 1',
				tasks: [
					{ id: '1.1', description: 'Task 1.1' },
					{ id: '1.2', description: 'Task 1.2' },
				],
			},
			{
				id: 2,
				name: 'Phase 2',
				tasks: [{ id: '2.1', description: 'Task 2.1' }],
			},
		],
		working_directory: tmpDir,
	};
	const seed = await executeSavePlan(args, tmpDir);
	expect(seed.success).toBe(true);

	// Mutate statuses on disk to exercise the guard against non-pending tasks.
	const planPath = path.join(tmpDir, '.swarm', 'plan.json');
	const raw = await fs.readFile(planPath, 'utf-8');
	const plan = JSON.parse(raw);
	plan.phases[0].tasks[0].status = 'completed';
	plan.phases[0].tasks[1].status = 'in_progress';
	plan.phases[1].tasks[0].status = 'pending';
	await fs.writeFile(planPath, JSON.stringify(plan, null, 2));
}

async function readPlan(): Promise<{
	phases: Array<{ tasks: Array<{ id: string; status: string }> }>;
}> {
	const planPath = path.join(tmpDir, '.swarm', 'plan.json');
	const raw = await fs.readFile(planPath, 'utf-8');
	return JSON.parse(raw);
}

async function readTaskRemovedEvents(): Promise<
	Array<Record<string, unknown>>
> {
	const ledgerPath = path.join(tmpDir, '.swarm', 'plan-ledger.jsonl');
	const raw = await fs.readFile(ledgerPath, 'utf-8');
	const events: Array<Record<string, unknown>> = [];
	for (const line of raw.split('\n')) {
		if (line.trim() === '') continue;
		try {
			const event = JSON.parse(line) as Record<string, unknown>;
			if (event.event_type === 'task_removed') events.push(event);
		} catch {
			// skip malformed
		}
	}
	return events;
}

describe('save_plan task-removal guard (issue #853)', () => {
	test('rejects save that silently drops in_progress and pending tasks', async () => {
		await seedThreeTaskPlan();
		// Re-save with only 1.1, dropping 1.2 and 2.1
		const args: SavePlanArgs = {
			title: 'Task Removal Guard Test',
			swarm_id: 'regression',
			phases: [
				{
					id: 1,
					name: 'Phase 1',
					tasks: [{ id: '1.1', description: 'Task 1.1' }],
				},
			],
			working_directory: tmpDir,
		};
		const result = await executeSavePlan(args, tmpDir);
		expect(result.success).toBe(false);
		expect(result.message).toContain('PLAN_TASK_REMOVAL_NOT_ACKNOWLEDGED');
		// On-disk plan must be unchanged.
		const plan = await readPlan();
		const ids = plan.phases.flatMap((p) => p.tasks.map((t) => t.id));
		expect(ids).toEqual(['1.1', '1.2', '2.1']);
	});

	test('acknowledged removal proceeds and emits task_removed ledger events', async () => {
		await seedThreeTaskPlan();
		const args: SavePlanArgs = {
			title: 'Task Removal Guard Test',
			swarm_id: 'regression',
			phases: [
				{
					id: 1,
					name: 'Phase 1',
					tasks: [{ id: '1.1', description: 'Task 1.1' }],
				},
			],
			working_directory: tmpDir,
			removed_task_ids: ['1.2', '2.1'],
			removal_reason: 'test: dropping tasks intentionally',
		} as SavePlanArgs;
		const result = await executeSavePlan(args, tmpDir);
		expect(result.success).toBe(true);
		const plan = await readPlan();
		const ids = plan.phases.flatMap((p) => p.tasks.map((t) => t.id));
		expect(ids).toEqual(['1.1']);
		const removedEvents = await readTaskRemovedEvents();
		expect(removedEvents.length).toBe(2);
		const removedIds = new Set(removedEvents.map((e) => e.task_id));
		expect(removedIds.has('1.2')).toBe(true);
		expect(removedIds.has('2.1')).toBe(true);
	});

	test('removed_task_ids containing a nonexistent id is rejected', async () => {
		await seedThreeTaskPlan();
		const args: SavePlanArgs = {
			title: 'Task Removal Guard Test',
			swarm_id: 'regression',
			phases: [
				{
					id: 1,
					name: 'Phase 1',
					tasks: [{ id: '1.1', description: 'Task 1.1' }],
				},
			],
			working_directory: tmpDir,
			removed_task_ids: ['1.2', '2.1', '9.9'],
			removal_reason: 'test',
		} as SavePlanArgs;
		const result = await executeSavePlan(args, tmpDir);
		expect(result.success).toBe(false);
		expect(JSON.stringify(result)).toContain('9.9');
	});

	test('removed_task_ids overlapping args.phases is rejected (contradiction)', async () => {
		await seedThreeTaskPlan();
		const args: SavePlanArgs = {
			title: 'Task Removal Guard Test',
			swarm_id: 'regression',
			phases: [
				{
					id: 1,
					name: 'Phase 1',
					tasks: [
						{ id: '1.1', description: 'Task 1.1' },
						{ id: '1.2', description: 'Task 1.2' },
					],
				},
			],
			working_directory: tmpDir,
			removed_task_ids: ['1.2'], // 1.2 also present in args.phases
			removal_reason: 'test',
		} as SavePlanArgs;
		const result = await executeSavePlan(args, tmpDir);
		expect(result.success).toBe(false);
		expect(JSON.stringify(result)).toContain('1.2');
	});

	test('whitespace removal_reason is rejected', async () => {
		await seedThreeTaskPlan();
		const args: SavePlanArgs = {
			title: 'Task Removal Guard Test',
			swarm_id: 'regression',
			phases: [
				{
					id: 1,
					name: 'Phase 1',
					tasks: [{ id: '1.1', description: 'Task 1.1' }],
				},
			],
			working_directory: tmpDir,
			removed_task_ids: ['1.2', '2.1'],
			removal_reason: '   ',
		} as SavePlanArgs;
		const result = await executeSavePlan(args, tmpDir);
		expect(result.success).toBe(false);
	});

	test('removed_task_ids without removal_reason is rejected', async () => {
		await seedThreeTaskPlan();
		const args: SavePlanArgs = {
			title: 'Task Removal Guard Test',
			swarm_id: 'regression',
			phases: [
				{
					id: 1,
					name: 'Phase 1',
					tasks: [{ id: '1.1', description: 'Task 1.1' }],
				},
			],
			working_directory: tmpDir,
			removed_task_ids: ['1.2', '2.1'],
		} as SavePlanArgs;
		const result = await executeSavePlan(args, tmpDir);
		expect(result.success).toBe(false);
	});

	test('reset_statuses with removals requires confirm_destructive_reset', async () => {
		await seedThreeTaskPlan();
		const args: SavePlanArgs = {
			title: 'Task Removal Guard Test',
			swarm_id: 'regression',
			phases: [
				{
					id: 1,
					name: 'Phase 1',
					tasks: [{ id: '1.1', description: 'Task 1.1' }],
				},
			],
			working_directory: tmpDir,
			reset_statuses: true,
		} as SavePlanArgs;
		const result = await executeSavePlan(args, tmpDir);
		expect(result.success).toBe(false);
		expect(JSON.stringify(result)).toContain('confirm_destructive_reset');
	});

	test('reset_statuses + confirm_destructive_reset auto-acknowledges removals', async () => {
		await seedThreeTaskPlan();
		const args: SavePlanArgs = {
			title: 'Task Removal Guard Test',
			swarm_id: 'regression',
			phases: [
				{
					id: 1,
					name: 'Phase 1',
					tasks: [{ id: '1.1', description: 'Task 1.1' }],
				},
			],
			working_directory: tmpDir,
			reset_statuses: true,
			confirm_destructive_reset: true,
		} as SavePlanArgs;
		const result = await executeSavePlan(args, tmpDir);
		expect(result.success).toBe(true);
		const plan = await readPlan();
		const ids = plan.phases.flatMap((p) => p.tasks.map((t) => t.id));
		expect(ids).toEqual(['1.1']);
		const removedEvents = await readTaskRemovedEvents();
		const removedIds = new Set(removedEvents.map((e) => e.task_id));
		expect(removedIds.has('1.2')).toBe(true);
		expect(removedIds.has('2.1')).toBe(true);
	});

	test('no-removal path with same task set is unaffected', async () => {
		await seedThreeTaskPlan();
		const args: SavePlanArgs = {
			title: 'Task Removal Guard Test',
			swarm_id: 'regression',
			phases: [
				{
					id: 1,
					name: 'Phase 1',
					tasks: [
						{ id: '1.1', description: 'Task 1.1' },
						{ id: '1.2', description: 'Task 1.2 updated' },
					],
				},
				{
					id: 2,
					name: 'Phase 2',
					tasks: [{ id: '2.1', description: 'Task 2.1' }],
				},
			],
			working_directory: tmpDir,
		};
		const result = await executeSavePlan(args, tmpDir);
		expect(result.success).toBe(true);
	});

	test('first plan write (no existing plan) is unaffected', async () => {
		const args: SavePlanArgs = {
			title: 'First Save',
			swarm_id: 'regression',
			phases: [
				{
					id: 1,
					name: 'Phase 1',
					tasks: [{ id: '1.1', description: 'Task 1.1' }],
				},
			],
			working_directory: tmpDir,
		};
		const result = await executeSavePlan(args, tmpDir);
		expect(result.success).toBe(true);
	});

	test('removed_task_ids with duplicates is rejected', async () => {
		await seedThreeTaskPlan();
		const args: SavePlanArgs = {
			title: 'Task Removal Guard Test',
			swarm_id: 'regression',
			phases: [
				{
					id: 1,
					name: 'Phase 1',
					tasks: [{ id: '1.1', description: 'Task 1.1' }],
				},
			],
			working_directory: tmpDir,
			removed_task_ids: ['1.2', '1.2', '2.1'],
			removal_reason: 'test',
		} as SavePlanArgs;
		const result = await executeSavePlan(args, tmpDir);
		expect(result.success).toBe(false);
		expect(JSON.stringify(result)).toContain('1.2');
	});

	test('empty removed_task_ids with no missing tasks succeeds', async () => {
		await seedThreeTaskPlan();
		const args: SavePlanArgs = {
			title: 'Task Removal Guard Test',
			swarm_id: 'regression',
			phases: [
				{
					id: 1,
					name: 'Phase 1',
					tasks: [
						{ id: '1.1', description: 'Task 1.1' },
						{ id: '1.2', description: 'Task 1.2' },
					],
				},
				{
					id: 2,
					name: 'Phase 2',
					tasks: [{ id: '2.1', description: 'Task 2.1' }],
				},
			],
			working_directory: tmpDir,
			removed_task_ids: [],
		} as SavePlanArgs;
		const result = await executeSavePlan(args, tmpDir);
		expect(result.success).toBe(true);
	});

	test('phase present with empty tasks array drops those tasks (rejected unacknowledged)', async () => {
		await seedThreeTaskPlan();
		// Bypass the tool's input zod schema by calling executeSavePlan directly
		// with a phase that has an empty tasks array. PlanSchema.PhaseSchema.tasks
		// is z.array(...).default([]) — no .min(1) — so the manager-level schema
		// accepts it, and the task-removal guard must fire.
		const args = {
			title: 'Task Removal Guard Test',
			swarm_id: 'regression',
			phases: [
				{
					id: 1,
					name: 'Phase 1',
					tasks: [
						{ id: '1.1', description: 'Task 1.1' },
						{ id: '1.2', description: 'Task 1.2' },
					],
				},
				{
					id: 2,
					name: 'Phase 2',
					tasks: [] as Array<{ id: string; description: string }>,
				},
			],
			working_directory: tmpDir,
		} as SavePlanArgs;
		const result: SavePlanResult = await executeSavePlan(args, tmpDir);
		expect(result.success).toBe(false);
		expect(result.message).toContain('PLAN_TASK_REMOVAL_NOT_ACKNOWLEDGED');
	});
});
