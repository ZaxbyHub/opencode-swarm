import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Plan } from '../../../src/config/plan-schema';
import { takeSnapshotEvent } from '../../../src/plan/ledger';
import { loadPlanJsonOnly } from '../../../src/plan/manager';
import { executeGetApprovedPlan } from '../../../src/tools/get-approved-plan';
import {
	executeSavePlan,
	type SavePlanArgs,
} from '../../../src/tools/save-plan';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

function args(directory: string, filesTouched?: string[]): SavePlanArgs {
	return {
		title: 'Durable task scope',
		swarm_id: 'test-swarm',
		working_directory: directory,
		phases: [
			{
				id: 1,
				name: 'Implementation',
				tasks: [
					{
						id: '1.1',
						description: 'Implement the durable scope contract',
						...(filesTouched === undefined
							? {}
							: { files_touched: filesTouched }),
					},
				],
			},
		],
	};
}

function taskFiles(plan: Plan): string[] {
	return plan.phases[0]?.tasks[0]?.files_touched ?? [];
}

describe('save_plan files_touched durability', () => {
	let directory: string;

	beforeEach(async () => {
		directory = canonicalMkdtemp('save-plan-scope-');
		process.env.SWARM_SKIP_SPEC_GATE = '1';
		process.env.SWARM_SKIP_GATE_SELECTION = '1';
	});

	afterEach(async () => {
		delete process.env.SWARM_SKIP_SPEC_GATE;
		delete process.env.SWARM_SKIP_GATE_SELECTION;
		await rm(directory, { recursive: true, force: true });
	});

	test('normalizes once and remains lossless across all six plan surfaces', async () => {
		const result = await executeSavePlan(
			args(directory, ['src\\z.ts', './src/a.ts', 'src/a.ts']),
		);
		expect(result.success).toBe(true);

		const expected = ['src/a.ts', 'src/z.ts'];
		const plan = await loadPlanJsonOnly(directory);
		expect(plan).not.toBeNull();
		expect(taskFiles(plan as Plan)).toEqual(expected);

		const ledgerLines = (
			await readFile(join(directory, '.swarm', 'plan-ledger.jsonl'), 'utf8')
		)
			.trim()
			.split('\n')
			.map((line) => JSON.parse(line));
		const created = ledgerLines.find(
			(event) => event.event_type === 'plan_created',
		);
		expect(created.payload.plan.phases[0].tasks[0].files_touched).toEqual(
			expected,
		);

		const planMarkdown = await readFile(
			join(directory, '.swarm', 'plan.md'),
			'utf8',
		);
		expect(planMarkdown).toContain('files_touched: ["src/a.ts","src/z.ts"]');

		const checkpointJson = JSON.parse(
			await readFile(
				join(directory, '.swarm', 'plan-export', 'SWARM_PLAN.json'),
				'utf8',
			),
		);
		expect(checkpointJson.phases[0].tasks[0].files_touched).toEqual(expected);
		const checkpointMarkdown = await readFile(
			join(directory, '.swarm', 'plan-export', 'SWARM_PLAN.md'),
			'utf8',
		);
		expect(checkpointMarkdown).toContain(
			'files_touched: ["src/a.ts","src/z.ts"]',
		);

		await takeSnapshotEvent(directory, plan as Plan, {
			source: 'critic_approved',
			approvalMetadata: { verdict: 'APPROVED' },
		});
		const approved = await executeGetApprovedPlan({}, directory);
		expect(taskFiles(approved.approved_plan?.plan as Plan)).toEqual(expected);
	});

	test('omission preserves prior scope and explicit empty list clears it', async () => {
		expect(
			(await executeSavePlan(args(directory, ['src/owned.ts']))).success,
		).toBe(true);

		expect((await executeSavePlan(args(directory))).success).toBe(true);
		let plan = await loadPlanJsonOnly(directory);
		expect(taskFiles(plan as Plan)).toEqual(['src/owned.ts']);

		expect((await executeSavePlan(args(directory, []))).success).toBe(true);
		plan = await loadPlanJsonOnly(directory);
		expect(taskFiles(plan as Plan)).toEqual([]);
	});

	test('rejects an invalid scope atomically without creating a plan', async () => {
		const result = await executeSavePlan(args(directory, ['../escape.ts']));
		expect(result.success).toBe(false);
		expect(result.message).toContain('PLAN_TASK_SCOPE_INVALID');
		expect(await loadPlanJsonOnly(directory)).toBeNull();
	});

	test('rejects oversized scope text without replacing an existing plan', async () => {
		expect(
			(await executeSavePlan(args(directory, ['src/owned.ts']))).success,
		).toBe(true);
		const result = await executeSavePlan(
			args(directory, [`src/${'x'.repeat(4097)}.ts`]),
		);
		expect(result.success).toBe(false);
		expect(result.message).toContain('PLAN_TASK_SCOPE_INVALID');
		const aggregate = await executeSavePlan(
			args(
				directory,
				Array.from(
					{ length: 257 },
					(_, index) =>
						`src/${String(index).padStart(4, '0')}-${'x'.repeat(4075)}`,
				),
			),
		);
		expect(aggregate.success).toBe(false);
		expect(aggregate.message).toContain('PLAN_TASK_SCOPE_INVALID');
		const plan = await loadPlanJsonOnly(directory);
		expect(taskFiles(plan as Plan)).toEqual(['src/owned.ts']);
	});

	test('accepts benign dot names but rejects a parent traversal component', async () => {
		const accepted = await executeSavePlan(
			args(directory, ['src/foo..bar.ts', '..cache/dist']),
		);
		expect(accepted.success).toBe(true);
		expect(taskFiles((await loadPlanJsonOnly(directory)) as Plan)).toEqual([
			'..cache/dist',
			'src/foo..bar.ts',
		]);
		const rejected = await executeSavePlan(
			args(directory, ['src/../escape.ts']),
		);
		expect(rejected.success).toBe(false);
	});
});
