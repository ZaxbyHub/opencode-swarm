/**
 * #1674 v8 default-flip regression tests.
 *
 * Verifies the migration guard: the v8 `parallelization_enabled: true` default
 * applies ONLY at new-plan creation (in `save_plan`'s Step 3.1), NOT when an
 * existing v7 plan is loaded via `loadPlanJsonOnly`/`PlanSchema.parse`. This is
 * the critic-mandated guarantee that upgrading opencode-swarm never silently
 * flips an existing plan's execution behavior.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadPlanJsonOnly } from '../../../src/plan/manager';
import { executeSavePlan } from '../../../src/tools/save-plan';

let tempDir: string;
let swarmDir: string;

beforeEach(() => {
	process.env.SWARM_SKIP_GATE_SELECTION = '1';
	tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-parallel-default-'));
	swarmDir = path.join(tempDir, '.swarm');
	fs.mkdirSync(swarmDir, { recursive: true });
	// executeSavePlan requires a spec.md (requirement-coverage gate) and a
	// context.md with the QA gate selection section (gate-selection check).
	fs.writeFileSync(
		path.join(swarmDir, 'spec.md'),
		'# Test Spec\nv8 default-flip regression spec.',
		'utf-8',
	);
	fs.writeFileSync(
		path.join(swarmDir, 'context.md'),
		'## Pending QA Gate Selection\n',
		'utf-8',
	);
});

afterEach(() => {
	delete process.env.SWARM_SKIP_GATE_SELECTION;
	try {
		fs.rmSync(tempDir, { recursive: true, force: true });
	} catch {
		// Ignore cleanup errors
	}
});

function makePlanArgs(): Parameters<typeof executeSavePlan>[0] {
	return {
		title: 'Test Plan',
		swarm_id: 'test-swarm',
		working_directory: tempDir,
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
	};
}

describe('v8 default-flip migration guard (#1674)', () => {
	test('NEW plan via save_plan (no existing profile, no incoming profile) → parallelization_enabled: true', async () => {
		const result = await executeSavePlan(makePlanArgs());
		expect(result.success).toBe(true);

		const loaded = await loadPlanJsonOnly(tempDir);
		expect(loaded).not.toBeNull();
		expect(loaded!.execution_profile?.parallelization_enabled).toBe(true);
		// Other profile fields keep their schema defaults.
		expect(loaded!.execution_profile?.max_concurrent_tasks).toBe(10);
		expect(loaded!.execution_profile?.council_parallel).toBe(true);
	});

	test('EXISTING v7 plan loaded via loadPlanJsonOnly (no execution_profile) → stays serial', async () => {
		// Simulate a v7-era plan.json: no execution_profile field at all.
		const v7Plan = {
			schema_version: '1.0.0',
			title: 'Legacy v7 Plan',
			swarm: 'legacy',
			phases: [
				{
					id: 1,
					name: 'Phase 1',
					tasks: [
						{
							id: '1.1',
							phase: 1,
							description: 'Legacy task',
							status: 'pending',
						},
					],
				},
			],
			// NOTE: no execution_profile — this is the v7 shape.
		};
		fs.writeFileSync(
			path.join(swarmDir, 'plan.json'),
			JSON.stringify(v7Plan),
			'utf-8',
		);

		const loaded = await loadPlanJsonOnly(tempDir);
		expect(loaded).not.toBeNull();
		// Schema default for parallelization_enabled is `false`; loading an
		// existing profile-less plan must NOT inject the v8 `true` default.
		expect(loaded!.execution_profile?.parallelization_enabled).not.toBe(true);
	});

	test('plan with explicit execution_profile.parallelization_enabled: false → stays false', async () => {
		const args = makePlanArgs();
		args.execution_profile = { parallelization_enabled: false };
		const result = await executeSavePlan(args);
		expect(result.success).toBe(true);

		const loaded = await loadPlanJsonOnly(tempDir);
		expect(loaded).not.toBeNull();
		// Explicit opt-out is preserved exactly.
		expect(loaded!.execution_profile?.parallelization_enabled).toBe(false);
	});

	test('revision of an existing profile-less plan → gets the v8 default (effectively-new)', async () => {
		// First, write a profile-less existing plan (v7 shape) directly.
		const v7Plan = {
			schema_version: '1.0.0',
			title: 'Test Plan',
			swarm: 'test-swarm',
			phases: [
				{
					id: 1,
					name: 'Phase 1',
					tasks: [
						{
							id: '1.1',
							phase: 1,
							description: 'Task 1.1',
							status: 'pending',
						},
					],
				},
			],
		};
		fs.writeFileSync(
			path.join(swarmDir, 'plan.json'),
			JSON.stringify(v7Plan),
			'utf-8',
		);

		// Now revise it via save_plan with NO execution_profile. Per the v8
		// contract, this reaches the `resolvedProfile === undefined` branch and
		// gets `true` (documented as effectively-new in the release fragment).
		const result = await executeSavePlan(makePlanArgs());
		expect(result.success).toBe(true);

		const loaded = await loadPlanJsonOnly(tempDir);
		expect(loaded).not.toBeNull();
		expect(loaded!.execution_profile?.parallelization_enabled).toBe(true);
	});
});
