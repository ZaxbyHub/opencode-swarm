import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Plan } from '../../../src/config/plan-schema';
import { importCheckpoint } from '../../../src/plan/checkpoint';
import { loadPlanJsonOnly } from '../../../src/plan/manager';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

describe('checkpoint execution-profile durability', () => {
	let directory: string;

	beforeEach(async () => {
		directory = canonicalMkdtemp('checkpoint-profile-');
		await mkdir(join(directory, '.swarm', 'plan-export'), {
			recursive: true,
		});
	});

	afterEach(async () => {
		await rm(directory, { recursive: true, force: true });
	});

	test('imports and persists the complete execution profile', async () => {
		const plan: Plan = {
			schema_version: '1.0.0',
			title: 'Checkpoint Profile',
			swarm: 'checkpoint-profile',
			current_phase: 1,
			phases: [
				{
					id: 1,
					name: 'One',
					status: 'pending',
					tasks: [],
				},
			],
			execution_profile: {
				parallelization_enabled: true,
				max_concurrent_tasks: 2,
				council_parallel: false,
				locked: true,
				auto_proceed: true,
				commit_after_each_completed_task: true,
			},
		};
		await writeFile(
			join(directory, '.swarm', 'plan-export', 'SWARM_PLAN.json'),
			JSON.stringify(plan, null, 2),
			'utf8',
		);

		const imported = await importCheckpoint(directory, 'test');
		expect(imported.success).toBe(true);
		expect(imported.plan?.execution_profile).toEqual(plan.execution_profile);
		expect((await loadPlanJsonOnly(directory))?.execution_profile).toEqual(
			plan.execution_profile,
		);
	});
});
