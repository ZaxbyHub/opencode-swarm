import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
	access,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Plan } from '../../../src/config/plan-schema';
import { closeProjectDb } from '../../../src/db/project-db';
import { getProfileLookupForIdentity } from '../../../src/db/qa-gate-profile';
import {
	executeSavePlan,
	type SavePlanArgs,
} from '../../../src/tools/save-plan';

function makeArgs(overrides?: Partial<SavePlanArgs>): SavePlanArgs {
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
		...overrides,
	};
}

function legacyPlan(locked: boolean): Plan {
	return {
		schema_version: '1.0.0',
		title: 'My Project',
		swarm: 'test-swarm',
		current_phase: 1,
		migration_status: 'native',
		execution_profile: {
			parallelization_enabled: true,
			max_concurrent_tasks: 2,
			council_parallel: false,
			locked,
			auto_proceed: false,
			commit_after_each_completed_task: false,
		},
		phases: [
			{
				id: 1,
				name: 'Phase One',
				status: 'pending',
				tasks: [
					{
						id: '1.1',
						phase: 1,
						status: 'pending',
						size: 'small',
						description: 'First task',
						depends: [],
						files_touched: [],
					},
				],
			},
		],
	};
}

async function exists(path: string): Promise<boolean> {
	return access(path).then(
		() => true,
		() => false,
	);
}

describe('save_plan planning_profile', () => {
	let directory: string;

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), 'save-plan-profile-'));
		await mkdir(join(directory, '.swarm'), { recursive: true });
		await writeFile(join(directory, '.swarm', 'spec.md'), '# Spec\n');
		process.env.SWARM_SKIP_SPEC_GATE = '1';
		process.env.SWARM_SKIP_GATE_SELECTION = '1';
	});

	afterEach(async () => {
		delete process.env.SWARM_SKIP_SPEC_GATE;
		delete process.env.SWARM_SKIP_GATE_SELECTION;
		closeProjectDb(directory);
		await rm(directory, { recursive: true, force: true });
	});

	test('defaults new non-strict plans to balanced', async () => {
		const result = await executeSavePlan(
			makeArgs({ working_directory: directory }),
		);
		expect(result.success).toBe(true);
		expect(result.execution_profile?.planning_profile).toBe('balanced');
	});

	test('defaults new strict repositories to strict', async () => {
		await mkdir(join(directory, '.opencode'), { recursive: true });
		await writeFile(
			join(directory, '.opencode', 'opencode-swarm.json'),
			JSON.stringify({ execution_mode: 'strict' }),
		);
		const result = await executeSavePlan(
			makeArgs({ working_directory: directory }),
		);
		expect(result.success).toBe(true);
		expect(result.execution_profile?.planning_profile).toBe('strict');
	});

	test('balanced auto-creates an exact-bound QA profile', async () => {
		delete process.env.SWARM_SKIP_GATE_SELECTION;
		const result = await executeSavePlan(
			makeArgs({ working_directory: directory }),
		);
		expect(result.success).toBe(true);
		expect(
			getProfileLookupForIdentity(directory, {
				swarm: 'test-swarm',
				title: 'My Project',
			}).kind,
		).toBe('bound');
	});

	test('strict still requires an explicit exact-bound QA profile', async () => {
		delete process.env.SWARM_SKIP_GATE_SELECTION;
		const result = await executeSavePlan(
			makeArgs({
				working_directory: directory,
				execution_profile: { planning_profile: 'strict' },
			}),
		);
		expect(result.success).toBe(false);
		expect(result.message).toContain('QA_GATE_SELECTION_REQUIRED');
	});

	test('unlocked legacy profile materializes its resolved default on save', async () => {
		await writeFile(
			join(directory, '.swarm', 'plan.json'),
			JSON.stringify(legacyPlan(false), null, 2),
		);
		const result = await executeSavePlan(
			makeArgs({ working_directory: directory }),
		);
		expect(result.success).toBe(true);
		expect(result.execution_profile?.planning_profile).toBe('balanced');
	});

	test('locked balanced may ratchet to strict without changing other fields', async () => {
		await executeSavePlan(
			makeArgs({
				working_directory: directory,
				execution_profile: {
					parallelization_enabled: true,
					max_concurrent_tasks: 2,
					council_parallel: false,
					locked: true,
					planning_profile: 'balanced',
				},
			}),
		);
		const result = await executeSavePlan(
			makeArgs({
				working_directory: directory,
				execution_profile: { locked: true, planning_profile: 'strict' },
			}),
		);
		expect(result.success).toBe(true);
		expect(result.execution_profile?.planning_profile).toBe('strict');
	});

	test('locked strict cannot relax back to balanced', async () => {
		await executeSavePlan(
			makeArgs({
				working_directory: directory,
				execution_profile: { locked: true, planning_profile: 'strict' },
			}),
		);
		const result = await executeSavePlan(
			makeArgs({
				working_directory: directory,
				execution_profile: { locked: true, planning_profile: 'balanced' },
			}),
		);
		expect(result.success).toBe(false);
		expect(result.message).toContain('EXECUTION_PROFILE_LOCKED');
	});

	test('locked legacy strictness stays resolver-only', async () => {
		await writeFile(
			join(directory, '.swarm', 'plan.json'),
			JSON.stringify(legacyPlan(true), null, 2),
		);
		const result = await executeSavePlan(
			makeArgs({
				working_directory: directory,
				execution_profile: { locked: true, planning_profile: 'strict' },
			}),
		);
		expect(result.success).toBe(false);
		expect(result.message).toContain('EXECUTION_PROFILE_LOCKED');
	});

	test('forbidden locked change rejects before spec or QA mutations', async () => {
		const first = await executeSavePlan(
			makeArgs({
				working_directory: directory,
				execution_profile: {
					locked: true,
					planning_profile: 'balanced',
				},
			}),
		);
		expect(first.success).toBe(true);

		const planPath = join(directory, '.swarm', 'plan.json');
		const ledgerPath = join(directory, '.swarm', 'plan-ledger.jsonl');
		const planBefore = await readFile(planPath, 'utf8');
		const ledgerBefore = await readFile(ledgerPath, 'utf8');
		await rm(join(directory, '.swarm', 'spec-snapshot.md'), { force: true });
		closeProjectDb(directory);
		await rm(join(directory, '.swarm', 'swarm.db'), { force: true });
		delete process.env.SWARM_SKIP_SPEC_GATE;
		delete process.env.SWARM_SKIP_GATE_SELECTION;

		const rejected = await executeSavePlan(
			makeArgs({
				working_directory: directory,
				execution_profile: { max_concurrent_tasks: 7 },
			}),
		);
		expect(rejected.success).toBe(false);
		expect(rejected.message).toContain('EXECUTION_PROFILE_LOCKED');
		expect(await exists(join(directory, '.swarm', 'spec-snapshot.md'))).toBe(
			false,
		);
		expect(await exists(join(directory, '.swarm', 'swarm.db'))).toBe(false);
		expect(await readFile(planPath, 'utf8')).toBe(planBefore);
		expect(await readFile(ledgerPath, 'utf8')).toBe(ledgerBefore);
	});
});
