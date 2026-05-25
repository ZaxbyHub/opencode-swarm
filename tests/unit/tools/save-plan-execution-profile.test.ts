/**
 * Tests for execution_profile enforcement in executeSavePlan:
 * - Setting a profile on a new plan
 * - Locked profile rejection (fail-closed)
 * - Profile preserved when omitted in subsequent call
 * - Schema validation errors for invalid profile fields
 * - Locked plan: result carries execution_profile
 * - Disk round-trip: profile persisted to .swarm/plan.json
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

let tmpDir: string;

beforeEach(async () => {
	tmpDir = await mkdtemp(join(tmpdir(), 'save-plan-ep-'));
	await mkdir(join(tmpDir, '.swarm'), { recursive: true });
	await writeFile(join(tmpDir, '.swarm', 'spec.md'), '# Spec\n');
	process.env.SWARM_SKIP_SPEC_GATE = '1';
	process.env.SWARM_SKIP_GATE_SELECTION = '1';
});

afterEach(async () => {
	delete process.env.SWARM_SKIP_SPEC_GATE;
	delete process.env.SWARM_SKIP_GATE_SELECTION;
	await rm(tmpDir, { recursive: true, force: true });
});

describe('execution_profile: setting a profile on a new plan', () => {
	test('accepts valid execution_profile and returns it in result', async () => {
		const args = makeArgs({
			working_directory: tmpDir,
			execution_profile: {
				parallelization_enabled: true,
				max_concurrent_tasks: 4,
				council_parallel: false,
				locked: false,
			},
		});
		const result = await executeSavePlan(args);
		expect(result.success).toBe(true);
		expect(result.execution_profile).toBeDefined();
		expect(result.execution_profile?.parallelization_enabled).toBe(true);
		expect(result.execution_profile?.max_concurrent_tasks).toBe(4);
		expect(result.execution_profile?.locked).toBe(false);
	});

	test('accepts partial execution_profile and applies defaults', async () => {
		const args = makeArgs({
			working_directory: tmpDir,
			execution_profile: {
				parallelization_enabled: true,
			},
		});
		const result = await executeSavePlan(args);
		expect(result.success).toBe(true);
		expect(result.execution_profile?.parallelization_enabled).toBe(true);
		expect(result.execution_profile?.max_concurrent_tasks).toBe(1);
		expect(result.execution_profile?.locked).toBe(false);
	});

	test('sets and locks profile in a single call', async () => {
		const args = makeArgs({
			working_directory: tmpDir,
			execution_profile: {
				parallelization_enabled: true,
				max_concurrent_tasks: 2,
				locked: true,
			},
		});
		const result = await executeSavePlan(args);
		expect(result.success).toBe(true);
		expect(result.execution_profile?.locked).toBe(true);
	});
});

describe('execution_profile: locked profile rejection (fail-closed)', () => {
	test('second call with changed execution_profile on a locked plan is rejected', async () => {
		// First call: set and lock the profile
		const firstResult = await executeSavePlan(
			makeArgs({
				working_directory: tmpDir,
				execution_profile: {
					parallelization_enabled: true,
					max_concurrent_tasks: 2,
					locked: true,
				},
			}),
		);
		expect(firstResult.success).toBe(true);

		// Second call: try to modify the locked profile
		const secondResult = await executeSavePlan(
			makeArgs({
				working_directory: tmpDir,
				execution_profile: {
					parallelization_enabled: false,
					max_concurrent_tasks: 1,
					locked: false,
				},
			}),
		);
		expect(secondResult.success).toBe(false);
		expect(secondResult.message).toContain('EXECUTION_PROFILE_LOCKED');
		expect(secondResult.errors).toBeDefined();
		expect(secondResult.errors?.some((e) => e.includes('locked'))).toBe(true);
	});

	test('second call with identical execution_profile on a locked plan succeeds as no-op', async () => {
		const profile = {
			parallelization_enabled: true,
			max_concurrent_tasks: 2,
			council_parallel: false,
			locked: true,
		};
		const firstResult = await executeSavePlan(
			makeArgs({
				working_directory: tmpDir,
				execution_profile: profile,
			}),
		);
		expect(firstResult.success).toBe(true);

		const secondResult = await executeSavePlan(
			makeArgs({
				working_directory: tmpDir,
				execution_profile: profile,
			}),
		);

		expect(secondResult.success).toBe(true);
		expect(secondResult.execution_profile).toEqual(profile);
	});

	test('second call with partial no-op execution_profile on a locked plan succeeds', async () => {
		const firstResult = await executeSavePlan(
			makeArgs({
				working_directory: tmpDir,
				execution_profile: {
					parallelization_enabled: false,
					max_concurrent_tasks: 1,
					council_parallel: false,
					locked: true,
				},
			}),
		);
		expect(firstResult.success).toBe(true);

		const secondResult = await executeSavePlan(
			makeArgs({
				working_directory: tmpDir,
				execution_profile: { locked: true },
			}),
		);

		expect(secondResult.success).toBe(true);
		expect(secondResult.execution_profile?.locked).toBe(true);
		expect(secondResult.execution_profile?.parallelization_enabled).toBe(false);
	});

	test('second call without execution_profile on a locked plan succeeds', async () => {
		// First call: lock
		await executeSavePlan(
			makeArgs({
				working_directory: tmpDir,
				execution_profile: {
					locked: true,
					parallelization_enabled: true,
					max_concurrent_tasks: 2,
				},
			}),
		);

		// Second call: no execution_profile in args — should succeed and preserve locked profile
		const result = await executeSavePlan(
			makeArgs({ working_directory: tmpDir }),
		);
		expect(result.success).toBe(true);
		expect(result.execution_profile?.locked).toBe(true);
		expect(result.execution_profile?.parallelization_enabled).toBe(true);
	});

	test('reset_statuses: true clears a locked profile (fresh start)', async () => {
		// First call: lock
		await executeSavePlan(
			makeArgs({
				working_directory: tmpDir,
				execution_profile: {
					locked: true,
					parallelization_enabled: true,
					max_concurrent_tasks: 2,
				},
			}),
		);

		// Second call: with reset_statuses: true AND execution_profile — should clear lock and apply new profile
		const result = await executeSavePlan(
			makeArgs({
				working_directory: tmpDir,
				reset_statuses: true,
				execution_profile: {
					parallelization_enabled: false,
					max_concurrent_tasks: 1,
					locked: false,
				},
			}),
		);
		expect(result.success).toBe(true);
		expect(result.execution_profile?.locked).toBe(false);
		expect(result.execution_profile?.parallelization_enabled).toBe(false);
	});

	test('reset_statuses: true without execution_profile clears locked profile (fresh start)', async () => {
		// First call: set and lock profile
		const firstResult = await executeSavePlan(
			makeArgs({
				working_directory: tmpDir,
				execution_profile: {
					locked: true,
					parallelization_enabled: true,
					max_concurrent_tasks: 3,
				},
			}),
		);
		expect(firstResult.success).toBe(true);
		expect(firstResult.execution_profile?.locked).toBe(true);

		// Second call: reset_statuses: true WITHOUT execution_profile — should clear locked profile
		const result = await executeSavePlan(
			makeArgs({
				working_directory: tmpDir,
				reset_statuses: true,
				// NOTE: no execution_profile in args
			}),
		);
		expect(result.success).toBe(true);
		// Profile should be cleared (not in result)
		expect(result.execution_profile).toBeUndefined();

		// Verify on disk: plan.json should not have execution_profile
		const planJson = await readFile(
			join(tmpDir, '.swarm', 'plan.json'),
			'utf8',
		);
		const planData = JSON.parse(planJson) as {
			execution_profile?: unknown;
		};
		expect(planData.execution_profile).toBeUndefined();
	});
});

describe('execution_profile: schema validation', () => {
	test('rejects max_concurrent_tasks: 0', async () => {
		const args = makeArgs({
			working_directory: tmpDir,
			execution_profile: { max_concurrent_tasks: 0 },
		});
		const result = await executeSavePlan(args);
		expect(result.success).toBe(false);
		expect(result.message).toContain('execution_profile');
	});

	test('rejects max_concurrent_tasks: 65', async () => {
		const args = makeArgs({
			working_directory: tmpDir,
			execution_profile: { max_concurrent_tasks: 65 },
		});
		const result = await executeSavePlan(args);
		expect(result.success).toBe(false);
	});
});

describe('execution_profile: not provided', () => {
	test('plan saved without execution_profile has no profile in result', async () => {
		const args = makeArgs({ working_directory: tmpDir });
		const result = await executeSavePlan(args);
		expect(result.success).toBe(true);
		expect(result.execution_profile).toBeUndefined();
	});

	test('second call without profile preserves previously set unlocked profile', async () => {
		// First: set unlocked profile
		await executeSavePlan(
			makeArgs({
				working_directory: tmpDir,
				execution_profile: {
					parallelization_enabled: true,
					max_concurrent_tasks: 3,
				},
			}),
		);

		// Second: no profile — should preserve the existing one
		const result = await executeSavePlan(
			makeArgs({ working_directory: tmpDir }),
		);
		expect(result.success).toBe(true);
		expect(result.execution_profile?.parallelization_enabled).toBe(true);
		expect(result.execution_profile?.max_concurrent_tasks).toBe(3);
	});
});

describe('execution_profile: disk round-trip', () => {
	test('profile is persisted to .swarm/plan.json on disk', async () => {
		const profile = {
			parallelization_enabled: true,
			max_concurrent_tasks: 4,
			council_parallel: true,
			locked: false,
		};
		const result = await executeSavePlan(
			makeArgs({ working_directory: tmpDir, execution_profile: profile }),
		);
		expect(result.success).toBe(true);

		// Read plan.json directly from disk and verify execution_profile persisted
		const planJson = await readFile(
			join(tmpDir, '.swarm', 'plan.json'),
			'utf8',
		);
		const planData = JSON.parse(planJson) as {
			execution_profile?: typeof profile;
		};
		expect(planData.execution_profile).toBeDefined();
		expect(planData.execution_profile?.parallelization_enabled).toBe(true);
		expect(planData.execution_profile?.max_concurrent_tasks).toBe(4);
		expect(planData.execution_profile?.council_parallel).toBe(true);
		expect(planData.execution_profile?.locked).toBe(false);
	});

	test('locked profile is persisted and survives a second read', async () => {
		const profile = {
			parallelization_enabled: true,
			max_concurrent_tasks: 2,
			locked: true,
		};
		await executeSavePlan(
			makeArgs({ working_directory: tmpDir, execution_profile: profile }),
		);

		const planJson = await readFile(
			join(tmpDir, '.swarm', 'plan.json'),
			'utf8',
		);
		const planData = JSON.parse(planJson) as {
			execution_profile?: { locked: boolean };
		};
		expect(planData.execution_profile?.locked).toBe(true);
	});
});
