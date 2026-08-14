/**
 * Plan identity verification gate tests (FR-001)
 * Covers mismatch rejection, match passthrough, confirmation override,
 * first-save bypass, and ordering relative to task-removal checks.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type {
	SavePlanArgs,
	SavePlanResult,
} from '../../../src/tools/save-plan';
import { executeSavePlan } from '../../../src/tools/save-plan';

describe('save_plan identity verification gate (FR-001)', () => {
	let tmpDir: string;

	const baseArgs: SavePlanArgs = {
		title: 'Alpha Project',
		swarm_id: 'mega',
		phases: [
			{
				id: 1,
				name: 'Phase 1',
				tasks: [
					{ id: '1.1', description: 'Do the thing' },
					{ id: '1.2', description: 'Do another thing' },
				],
			},
		],
	};

	beforeEach(async () => {
		process.env.SWARM_SKIP_GATE_SELECTION = '1';
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'identity-gate-test-'));
		await fs.mkdir(path.join(tmpDir, '.swarm'), { recursive: true });
		await fs.writeFile(path.join(tmpDir, '.swarm', 'spec.md'), '# Test Spec\n');
		await fs.writeFile(
			path.join(tmpDir, '.swarm', 'context.md'),
			'## Pending QA Gate Selection\n',
		);
	});

	afterEach(async () => {
		delete process.env.SWARM_SKIP_GATE_SELECTION;
		try {
			await fs.rm(tmpDir, { recursive: true, force: true });
		} catch {
			// Ignore cleanup errors
		}
	});

	// Test 1: Mismatch rejection — different title
	it('rejects with PLAN_IDENTITY_MISMATCH when incoming title differs from existing', async () => {
		// First save establishes the plan
		const firstSave: SavePlanResult = await executeSavePlan({
			...baseArgs,
			working_directory: tmpDir,
		});
		expect(firstSave.success).toBe(true);

		// Second save with a different title should be rejected
		const secondSave: SavePlanResult = await executeSavePlan({
			...baseArgs,
			title: 'Completely Different Title',
			working_directory: tmpDir,
		});

		expect(secondSave.success).toBe(false);
		expect(secondSave.message).toContain('PLAN_IDENTITY_MISMATCH');
		expect(secondSave.errors).toBeDefined();
		expect(secondSave.errors!.length).toBeGreaterThanOrEqual(2);
		expect(secondSave.recovery_guidance).toContain('confirm_identity_change');

		// Verify the existing plan was NOT overwritten
		const planJsonPath = path.join(tmpDir, '.swarm', 'plan.json');
		const planContent = JSON.parse(await fs.readFile(planJsonPath, 'utf-8'));
		expect(planContent.title).toBe('Alpha Project');
		expect(planContent.swarm).toBe('mega');
	});

	// Test 2: Mismatch rejection — different swarm_id
	it('rejects with PLAN_IDENTITY_MISMATCH when incoming swarm_id differs from existing', async () => {
		const firstSave: SavePlanResult = await executeSavePlan({
			...baseArgs,
			working_directory: tmpDir,
		});
		expect(firstSave.success).toBe(true);

		const secondSave: SavePlanResult = await executeSavePlan({
			...baseArgs,
			swarm_id: 'local',
			working_directory: tmpDir,
		});

		expect(secondSave.success).toBe(false);
		expect(secondSave.message).toContain('PLAN_IDENTITY_MISMATCH');
		expect(secondSave.errors).toBeDefined();
		// Error messages should reference both swarm IDs
		const allErrors = secondSave.errors!.join(' ');
		expect(allErrors).toContain('mega');
		expect(allErrors).toContain('local');

		// Verify the existing plan was NOT overwritten
		const planJsonPath = path.join(tmpDir, '.swarm', 'plan.json');
		const planContent = JSON.parse(await fs.readFile(planJsonPath, 'utf-8'));
		expect(planContent.swarm).toBe('mega');
	});

	// Test 3: Match passthrough — same title + swarm_id
	it('rejects raw identity changes even when the sanitized plan id would match', async () => {
		const firstSave: SavePlanResult = await executeSavePlan({
			...baseArgs,
			swarm_id: 'mega one',
			title: 'Plan / 1',
			working_directory: tmpDir,
		});
		expect(firstSave.success).toBe(true);

		const secondSave: SavePlanResult = await executeSavePlan({
			...baseArgs,
			swarm_id: 'mega?one',
			title: 'Plan ? 1',
			working_directory: tmpDir,
		});

		expect(secondSave.success).toBe(false);
		expect(secondSave.message).toContain('PLAN_IDENTITY_MISMATCH');
		expect(secondSave.errors?.join(' ')).toContain('mega one');
		expect(secondSave.errors?.join(' ')).toContain('mega?one');
		expect(secondSave.errors?.join(' ')).toContain('Plan / 1');
		expect(secondSave.errors?.join(' ')).toContain('Plan ? 1');
	});

	it('succeeds when incoming title and swarm_id match the existing plan', async () => {
		const firstSave: SavePlanResult = await executeSavePlan({
			...baseArgs,
			working_directory: tmpDir,
		});
		expect(firstSave.success).toBe(true);

		// Second save with identical identity but modified task descriptions
		const secondSave: SavePlanResult = await executeSavePlan({
			...baseArgs,
			phases: [
				{
					id: 1,
					name: 'Phase 1 Revised',
					tasks: [
						{ id: '1.1', description: 'Do the thing (updated)' },
						{ id: '1.2', description: 'Do another thing (updated)' },
						{ id: '1.3', description: 'Brand new task' },
					],
				},
			],
			removed_task_ids: [],
			working_directory: tmpDir,
		});

		expect(secondSave.success).toBe(true);
	});

	// Test 4: Explicit confirmation override
	it('succeeds with confirm_identity_change: true even when identity differs', async () => {
		const firstSave: SavePlanResult = await executeSavePlan({
			...baseArgs,
			working_directory: tmpDir,
		});
		expect(firstSave.success).toBe(true);

		const secondSave: SavePlanResult = await executeSavePlan({
			...baseArgs,
			title: 'Beta Project',
			swarm_id: 'mega',
			confirm_identity_change: true,
			working_directory: tmpDir,
		});

		expect(secondSave.success).toBe(true);

		// Verify the plan WAS overwritten with the new identity
		const planJsonPath = path.join(tmpDir, '.swarm', 'plan.json');
		const planContent = JSON.parse(await fs.readFile(planJsonPath, 'utf-8'));
		expect(planContent.title).toBe('Beta Project');
		expect(planContent.swarm).toBe('mega');
	});

	// Test 5: No existing plan — first save bypasses identity check
	it('succeeds on first save without identity check (no existing plan)', async () => {
		const result: SavePlanResult = await executeSavePlan({
			...baseArgs,
			working_directory: tmpDir,
		});

		expect(result.success).toBe(true);
		expect(result.plan_path).toBeDefined();
		expect(result.tasks_count).toBe(2);
	});

	// Test 6: Identity gate fires before task-removal acknowledgement check
	it('identity gate fires before task-removal acknowledgement check', async () => {
		// First save with tasks that will later be "missing"
		const firstSave: SavePlanResult = await executeSavePlan({
			...baseArgs,
			working_directory: tmpDir,
		});
		expect(firstSave.success).toBe(true);

		// Second save with different identity AND missing task IDs
		// If identity check runs first, we get PLAN_IDENTITY_MISMATCH.
		// If task-removal check runs first, we get PLAN_TASK_REMOVAL_NOT_ACKNOWLEDGED.
		const secondSave: SavePlanResult = await executeSavePlan({
			...baseArgs,
			title: 'Different Title For Ordering Test',
			phases: [
				{
					id: 1,
					name: 'Phase 1',
					tasks: [{ id: '2.1', description: 'Completely new task' }],
				},
			],
			// NOT providing removed_task_ids — task-removal check would fail
			// NOT providing confirm_identity_change — identity check would fail
			working_directory: tmpDir,
		});

		// Identity gate should fire first
		expect(secondSave.success).toBe(false);
		expect(secondSave.message).toContain('PLAN_IDENTITY_MISMATCH');
		expect(secondSave.message).not.toContain('PLAN_TASK_REMOVAL');
	});

	// Test 7: Identity mismatch with special characters in title
	it('handles special characters in title for identity comparison', async () => {
		const firstSave: SavePlanResult = await executeSavePlan({
			...baseArgs,
			title: 'Project (v2) — Final',
			working_directory: tmpDir,
		});
		expect(firstSave.success).toBe(true);

		const secondSave: SavePlanResult = await executeSavePlan({
			...baseArgs,
			title: 'Project (v3) — Revised',
			working_directory: tmpDir,
		});

		expect(secondSave.success).toBe(false);
		expect(secondSave.message).toContain('PLAN_IDENTITY_MISMATCH');
	});

	// Test 8: Matching identity with different task structure succeeds (identity only checks title+swarm)
	it('succeeds when identity matches but task structure differs completely', async () => {
		const firstSave: SavePlanResult = await executeSavePlan({
			...baseArgs,
			working_directory: tmpDir,
		});
		expect(firstSave.success).toBe(true);

		// Completely different task structure — new phases, new task IDs
		const secondSave: SavePlanResult = await executeSavePlan({
			...baseArgs,
			phases: [
				{
					id: 1,
					name: 'Entirely New Phase',
					tasks: [
						{
							id: '10.1',
							description: 'Brand new task in new numbering scheme',
						},
						{ id: '10.2', description: 'Another brand new task' },
						{ id: '10.3', description: 'Third brand new task' },
						{ id: '10.4', description: 'Fourth brand new task' },
						{ id: '10.5', description: 'Fifth brand new task' },
					],
				},
				{
					id: 2,
					name: 'Second Phase',
					tasks: [{ id: '20.1', description: 'Task in phase 2' }],
				},
			],
			removed_task_ids: ['1.1', '1.2'],
			removal_reason: 'Replaced with entirely new task structure',
			working_directory: tmpDir,
		});

		expect(secondSave.success).toBe(true);
		expect(secondSave.tasks_count).toBe(6);

		// Verify the plan was actually overwritten with new structure
		const planJsonPath = path.join(tmpDir, '.swarm', 'plan.json');
		const planContent = JSON.parse(await fs.readFile(planJsonPath, 'utf-8'));
		expect(planContent.phases.length).toBe(2);
		expect(planContent.phases[0].tasks.length).toBe(5);
		expect(planContent.title).toBe('Alpha Project');
		expect(planContent.swarm).toBe('mega');
	});

	// Test 9: Explicit confirm_identity_change: false still rejects (not just undefined)
	it('rejects with PLAN_IDENTITY_MISMATCH when confirm_identity_change is explicitly false', async () => {
		const firstSave: SavePlanResult = await executeSavePlan({
			...baseArgs,
			working_directory: tmpDir,
		});
		expect(firstSave.success).toBe(true);

		// Explicitly pass false — should still reject mismatched identity
		const secondSave: SavePlanResult = await executeSavePlan({
			...baseArgs,
			title: 'Completely Different Title',
			confirm_identity_change: false,
			working_directory: tmpDir,
		});

		expect(secondSave.success).toBe(false);
		expect(secondSave.message).toContain('PLAN_IDENTITY_MISMATCH');
		expect(secondSave.recovery_guidance).toContain('confirm_identity_change');

		// Verify the plan was NOT overwritten
		const planJsonPath = path.join(tmpDir, '.swarm', 'plan.json');
		const planContent = JSON.parse(await fs.readFile(planJsonPath, 'utf-8'));
		expect(planContent.title).toBe('Alpha Project');
	});

	// Test 10: Changing ONLY the title (keeping swarm_id same) triggers mismatch
	it('rejects when only title changes (swarm_id identical)', async () => {
		const firstSave: SavePlanResult = await executeSavePlan({
			...baseArgs,
			working_directory: tmpDir,
		});
		expect(firstSave.success).toBe(true);

		// Change title but keep swarm_id the same
		const secondSave: SavePlanResult = await executeSavePlan({
			...baseArgs,
			title: 'New Title But Same Swarm',
			// swarm_id: 'mega' — unchanged
			working_directory: tmpDir,
		});

		expect(secondSave.success).toBe(false);
		expect(secondSave.message).toContain('PLAN_IDENTITY_MISMATCH');
		// Verify error references the title change
		const allErrors = secondSave.errors!.join(' ');
		expect(allErrors).toContain('Alpha Project');
		expect(allErrors).toContain('New Title But Same Swarm');

		// Verify the plan was NOT overwritten
		const planJsonPath = path.join(tmpDir, '.swarm', 'plan.json');
		const planContent = JSON.parse(await fs.readFile(planJsonPath, 'utf-8'));
		expect(planContent.title).toBe('Alpha Project');
		expect(planContent.swarm).toBe('mega');
	});

	// Test 11: Changing ONLY the swarm_id (keeping title same) triggers mismatch
	it('rejects when only swarm_id changes (title identical)', async () => {
		const firstSave: SavePlanResult = await executeSavePlan({
			...baseArgs,
			working_directory: tmpDir,
		});
		expect(firstSave.success).toBe(true);

		// Keep title the same but change swarm_id
		const secondSave: SavePlanResult = await executeSavePlan({
			...baseArgs,
			// title: 'Alpha Project' — unchanged
			swarm_id: 'local',
			working_directory: tmpDir,
		});

		expect(secondSave.success).toBe(false);
		expect(secondSave.message).toContain('PLAN_IDENTITY_MISMATCH');
		// Verify error references the swarm_id change
		const allErrors = secondSave.errors!.join(' ');
		expect(allErrors).toContain('mega');
		expect(allErrors).toContain('local');

		// Verify the plan was NOT overwritten
		const planJsonPath = path.join(tmpDir, '.swarm', 'plan.json');
		const planContent = JSON.parse(await fs.readFile(planJsonPath, 'utf-8'));
		expect(planContent.title).toBe('Alpha Project');
		expect(planContent.swarm).toBe('mega');
	});
});
