import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { executeSavePlan } from '../../../src/tools/save-plan';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

function makeArgs(tmpDir: string, execution_profile: Record<string, unknown>) {
	return {
		title: 'My Project',
		swarm_id: 'test-swarm',
		phases: [
			{
				id: 1,
				name: 'Phase One',
				tasks: [{ id: '1.1', description: 'First task' }],
			},
		],
		working_directory: tmpDir,
		execution_profile,
	};
}

describe('execution_profile: commit-after-task durability', () => {
	let tmpDir: string;

	beforeEach(async () => {
		process.env.SWARM_SKIP_GATE_SELECTION = '1';
		tmpDir = canonicalMkdtemp('save-plan-commit-frequency-');
		await mkdir(join(tmpDir, '.swarm'), { recursive: true });
		await writeFile(join(tmpDir, '.swarm', 'spec.md'), '# Spec\n');
	});

	afterEach(async () => {
		delete process.env.SWARM_SKIP_GATE_SELECTION;
		await rm(tmpDir, { recursive: true, force: true });
	});

	test('persists commit_after_each_completed_task and rejects locked changes', async () => {
		const first = await executeSavePlan(
			makeArgs(tmpDir, {
				locked: true,
				commit_after_each_completed_task: false,
			}),
		);
		expect(first.success).toBe(true);
		expect(first.execution_profile?.commit_after_each_completed_task).toBe(
			false,
		);
		expect(first.warnings ?? []).not.toSatisfy((warnings: string[]) =>
			warnings.some((warning) => warning.includes('before plan save')),
		);

		const changed = await executeSavePlan(
			makeArgs(tmpDir, {
				commit_after_each_completed_task: true,
			}),
		);
		expect(changed.success).toBe(false);
		expect(changed.message).toContain('EXECUTION_PROFILE_LOCKED');
	});

	test('persists commit_after_each_completed_task to plan and checkpoint exports', async () => {
		const profile = {
			parallelization_enabled: true,
			max_concurrent_tasks: 4,
			council_parallel: true,
			locked: false,
			auto_proceed: true,
			commit_after_each_completed_task: true,
		};
		const result = await executeSavePlan(makeArgs(tmpDir, profile));
		expect(result.success).toBe(true);

		const planData = JSON.parse(
			await readFile(join(tmpDir, '.swarm', 'plan.json'), 'utf8'),
		) as { execution_profile?: typeof profile };
		expect(planData.execution_profile?.commit_after_each_completed_task).toBe(
			true,
		);

		const checkpointJson = JSON.parse(
			await readFile(
				join(tmpDir, '.swarm', 'plan-export', 'SWARM_PLAN.json'),
				'utf8',
			),
		) as { execution_profile?: { commit_after_each_completed_task?: boolean } };
		expect(
			checkpointJson.execution_profile?.commit_after_each_completed_task,
		).toBe(true);
		expect(
			await readFile(
				join(tmpDir, '.swarm', 'plan-export', 'SWARM_PLAN.md'),
				'utf8',
			),
		).toContain('Commit After Each Completed Task: yes');
	});
});
