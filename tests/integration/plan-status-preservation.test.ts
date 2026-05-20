/**
 * Integration regression test: plan status preservation across save_plan calls.
 *
 * Before the fix, executeSavePlan reset all task statuses to 'pending' on every
 * call. The merge-mode fix reads existing statuses and preserves them. This file
 * validates the exact 5-step failure sequence described in the bug analysis:
 *
 *   1. save_plan with 2-phase plan → all tasks pending
 *   2. update_task_status('1.1', 'in_progress') → task is in_progress
 *   3. Complete task 1.1 (bypass gate for test purposes via direct plan mutation)
 *   4. save_plan again with same structure → 1.1 is STILL completed (merge-mode preserved it)
 *   5. save_plan with restructured plan (same 1.1, new 1.2 added) → 1.1 still completed, 1.2 pending
 *
 * Before the fix, step 4 would have reset 1.1 to 'pending', causing "old plan in
 * context / can't mark work complete" failures in production.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { executeSavePlan, type SavePlanArgs } from '../../src/tools/save-plan';
import { executeUpdateTaskStatus } from '../../src/tools/update-task-status';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function readPlanJson(tmpDir: string) {
	const raw = await fs.readFile(
		path.join(tmpDir, '.swarm', 'plan.json'),
		'utf-8',
	);
	return JSON.parse(raw) as {
		phases: Array<{
			tasks: Array<{ id: string; status: string; description: string }>;
		}>;
	};
}

async function forceCompleteTask(
	tmpDir: string,
	taskId: string,
): Promise<void> {
	// Bypass the gate pipeline for test purposes by mutating plan.json directly.
	// This simulates the completed state that would result from a full gate cycle.
	const planPath = path.join(tmpDir, '.swarm', 'plan.json');
	const plan = JSON.parse(await fs.readFile(planPath, 'utf-8'));
	for (const phase of plan.phases) {
		for (const task of phase.tasks) {
			if (task.id === taskId) {
				task.status = 'completed';
			}
		}
	}
	await fs.writeFile(planPath, JSON.stringify(plan, null, 2));
}

// ---------------------------------------------------------------------------
// Base plan (2 phases, matches the plan described in the bug analysis)
// ---------------------------------------------------------------------------

function basePlan(tmpDir: string): SavePlanArgs {
	return {
		title: 'Status Preservation Test',
		swarm_id: 'regression',
		phases: [
			{
				id: 1,
				name: 'Phase 1',
				tasks: [
					{ id: '1.1', description: 'Setup database' },
					{ id: '1.2', description: 'Create API endpoints', depends: ['1.1'] },
				],
			},
			{
				id: 2,
				name: 'Phase 2',
				tasks: [{ id: '2.1', description: 'Add auth' }],
			},
		],
		working_directory: tmpDir,
	};
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Plan status preservation: merge-mode save_plan regression', () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'plan-preserve-test-'));
		await fs.mkdir(path.join(tmpDir, '.swarm'), { recursive: true });
		await fs.writeFile(
			path.join(tmpDir, '.swarm', 'spec.md'),
			'# Test Spec\nIntegration test specification.',
		);
		// Create context.md with the QA gate selection section required by the gate-selection check
		await fs.writeFile(
			path.join(tmpDir, '.swarm', 'context.md'),
			'## Pending QA Gate Selection\n',
		);
	});

	afterEach(async () => {
		try {
			await fs.rm(tmpDir, { recursive: true, force: true });
		} catch {
			// Ignore cleanup errors
		}
	});

	// -----------------------------------------------------------------------
	// The exact 5-step failure sequence from the bug analysis
	// -----------------------------------------------------------------------

	it('5-step round-trip: completed status survives save_plan re-calls', async () => {
		// Step 1: save_plan with 2-phase plan — all tasks must start as pending
		const save1 = await executeSavePlan(basePlan(tmpDir));
		expect(save1.success).toBe(true);

		const afterSave1 = await readPlanJson(tmpDir);
		expect(afterSave1.phases[0].tasks[0].status).toBe('pending'); // 1.1
		expect(afterSave1.phases[0].tasks[1].status).toBe('pending'); // 1.2
		expect(afterSave1.phases[1].tasks[0].status).toBe('pending'); // 2.1

		// Step 2: update_task_status('1.1', 'in_progress') → task is in_progress
		const update1 = await executeUpdateTaskStatus(
			{ task_id: '1.1', status: 'in_progress' },
			tmpDir,
		);
		expect(update1.success).toBe(true);

		const afterUpdate = await readPlanJson(tmpDir);
		expect(afterUpdate.phases[0].tasks[0].status).toBe('in_progress');

		// Step 3: Complete task 1.1 (gate bypass for test — simulates full gate cycle)
		await forceCompleteTask(tmpDir, '1.1');

		const afterComplete = await readPlanJson(tmpDir);
		expect(afterComplete.phases[0].tasks[0].status).toBe('completed');

		// Step 4: [REGRESSION] save_plan again with same structure
		// Before fix: task 1.1 would be reset to 'pending'
		// After fix: merge-mode preserves 'completed'
		const save2 = await executeSavePlan(basePlan(tmpDir));
		expect(save2.success).toBe(true);

		const afterSave2 = await readPlanJson(tmpDir);
		expect(afterSave2.phases[0].tasks[0].status).toBe('completed'); // preserved ✓
		expect(afterSave2.phases[0].tasks[1].status).toBe('pending'); // unchanged
		expect(afterSave2.phases[1].tasks[0].status).toBe('pending'); // unchanged

		// Step 5: save_plan with restructured plan — same task 1.1, new task 1.3 added
		const restructuredPlan: SavePlanArgs = {
			title: 'Status Preservation Test v2',
			swarm_id: 'regression',
			phases: [
				{
					id: 1,
					name: 'Phase 1 Revised',
					tasks: [
						{ id: '1.1', description: 'Setup database (revised)' },
						{
							id: '1.2',
							description: 'Create API endpoints',
							depends: ['1.1'],
						},
						{ id: '1.3', description: 'Add migration scripts' }, // new task
					],
				},
				{
					id: 2,
					name: 'Phase 2',
					tasks: [{ id: '2.1', description: 'Add auth' }],
				},
			],
			working_directory: tmpDir,
		};

		const save3 = await executeSavePlan(restructuredPlan);
		expect(save3.success).toBe(true);

		const afterSave3 = await readPlanJson(tmpDir);
		expect(afterSave3.phases[0].tasks[0].status).toBe('completed'); // 1.1 still completed ✓
		expect(afterSave3.phases[0].tasks[1].status).toBe('pending'); // 1.2 unchanged
		expect(afterSave3.phases[0].tasks[2].status).toBe('pending'); // 1.3 new → pending ✓
		expect(afterSave3.phases[1].tasks[0].status).toBe('pending'); // 2.1 unchanged
	});

	// -----------------------------------------------------------------------
	// First-ever save: all tasks default to pending (no existing plan)
	// -----------------------------------------------------------------------

	it('first save_plan call produces all-pending tasks when no plan.json exists', async () => {
		const result = await executeSavePlan(basePlan(tmpDir));
		expect(result.success).toBe(true);

		const plan = await readPlanJson(tmpDir);
		const allPending = plan.phases
			.flatMap((p) => p.tasks)
			.every((t) => t.status === 'pending');
		expect(allPending).toBe(true);
	});

	// -----------------------------------------------------------------------
	// New task IDs: tasks with IDs not in the old plan start as pending
	// -----------------------------------------------------------------------

	it('new task IDs (not in old plan) start as pending — no false status carry-over', async () => {
		// Save initial plan with tasks 1.1 and 1.2, complete 1.1
		await executeSavePlan(basePlan(tmpDir));
		await executeUpdateTaskStatus(
			{ task_id: '1.1', status: 'in_progress' },
			tmpDir,
		);
		await forceCompleteTask(tmpDir, '1.1');

		// Re-save with entirely different task IDs in the same phase
		// Task IDs must match N.M pattern — using 1.3, 1.4 as "brand new" IDs.
		// Issue #853: dropping the basePlan's three tasks (1.1, 1.2, 2.1) must
		// now be acknowledged via removed_task_ids + removal_reason.
		const newIdsPlan: SavePlanArgs = {
			title: 'New IDs Plan',
			swarm_id: 'regression',
			phases: [
				{
					id: 1,
					name: 'Phase 1 Rewritten',
					tasks: [
						{ id: '1.3', description: 'Brand new task C' }, // new ID — no carry-over
						{ id: '1.4', description: 'Brand new task D' }, // new ID — no carry-over
					],
				},
			],
			working_directory: tmpDir,
			removed_task_ids: ['1.1', '1.2', '2.1'],
			removal_reason: 'regression test: replace task set entirely',
		};

		const result = await executeSavePlan(newIdsPlan);
		expect(result.success).toBe(true);

		const plan = await readPlanJson(tmpDir);
		// Neither 1.3 nor 1.4 existed in the old plan — both must start as pending
		expect(plan.phases[0].tasks[0].id).toBe('1.3');
		expect(plan.phases[0].tasks[0].status).toBe('pending');
		expect(plan.phases[0].tasks[1].id).toBe('1.4');
		expect(plan.phases[0].tasks[1].status).toBe('pending');
	});

	// -----------------------------------------------------------------------
	// Multiple statuses preserved: completed, in_progress, blocked
	// -----------------------------------------------------------------------

	it('preserves all non-pending statuses across a save_plan re-call', async () => {
		// Initial save
		await executeSavePlan(basePlan(tmpDir));

		// Set task 1.1 to completed
		await executeUpdateTaskStatus(
			{ task_id: '1.1', status: 'in_progress' },
			tmpDir,
		);
		await forceCompleteTask(tmpDir, '1.1');

		// Set task 1.2 to in_progress
		await executeUpdateTaskStatus(
			{ task_id: '1.2', status: 'in_progress' },
			tmpDir,
		);

		// Re-save with same IDs (descriptions changed)
		const revisedPlan: SavePlanArgs = {
			title: 'Status Preservation Test — Revised',
			swarm_id: 'regression',
			phases: [
				{
					id: 1,
					name: 'Phase 1',
					tasks: [
						{ id: '1.1', description: 'Setup database (updated description)' },
						{ id: '1.2', description: 'Create REST API endpoints' },
					],
				},
				{
					id: 2,
					name: 'Phase 2',
					tasks: [{ id: '2.1', description: 'Add OAuth2 auth' }],
				},
			],
			working_directory: tmpDir,
		};

		const result = await executeSavePlan(revisedPlan);
		expect(result.success).toBe(true);

		const plan = await readPlanJson(tmpDir);
		expect(plan.phases[0].tasks[0].status).toBe('completed'); // 1.1 preserved
		expect(plan.phases[0].tasks[1].status).toBe('in_progress'); // 1.2 preserved
		expect(plan.phases[1].tasks[0].status).toBe('pending'); // 2.1 unchanged

		// Descriptions must reflect the new save, not the old ones
		expect(plan.phases[0].tasks[0].description).toBe(
			'Setup database (updated description)',
		);
	});

	// -----------------------------------------------------------------------
	// Ledger snapshot: ledger contains a snapshot after save_plan
	// -----------------------------------------------------------------------

	it('a ledger snapshot is written after every save_plan call', async () => {
		await executeSavePlan(basePlan(tmpDir));

		// The ledger file must exist and contain a snapshot event
		// Filename is plan-ledger.jsonl (not ledger.jsonl)
		const ledgerPath = path.join(tmpDir, '.swarm', 'plan-ledger.jsonl');
		const ledgerExists = await fs
			.access(ledgerPath)
			.then(() => true)
			.catch(() => false);
		expect(ledgerExists).toBe(true);

		const ledgerRaw = await fs.readFile(ledgerPath, 'utf-8');
		const events = ledgerRaw
			.split('\n')
			.filter(Boolean)
			.map((line) => JSON.parse(line) as { event_type: string });

		const hasSnapshot = events.some((e) => e.event_type === 'snapshot');
		expect(hasSnapshot).toBe(true);
	});
});
