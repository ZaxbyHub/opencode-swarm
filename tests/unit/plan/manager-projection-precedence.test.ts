/**
 * Regression test for issue #1729 production bug #1: savePlan projection
 * precedence. Encodes BOTH directions of the status-merge invariant so a
 * future regression of either side is caught.
 *
 *   Scenario A — a concurrent writer's newer completion (recorded only in the
 *   ledger) survives a stale-caller savePlan that still has the task pending.
 *   Encoded today in manager-ledger-projection-regression.test.ts; mirrored
 *   here so the precedence contract has a single canonical home.
 *
 *   Scenario B — a disk-truth completion (written to plan.json WITHOUT a
 *   corresponding task_status_changed ledger event) survives a savePlan
 *   re-call. Before the fix, the replay path overrode the disk-truth
 *   completion with the stale ledger status, reverting completed work.
 *
 * The merge at src/plan/manager.ts (mergeStatusesTakingPrecedence) must
 * satisfy BOTH: only override the validated/disk status when the replayed
 * status is strictly more terminal.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Plan, TaskStatus } from '../../../src/config/plan-schema';
import {
	appendLedgerEvent,
	computePlanLedgerHash,
} from '../../../src/plan/ledger';
import { savePlan } from '../../../src/plan/manager';
import { derivePlanId } from '../../../src/plan/utils';

let tmpDir: string;

beforeEach(async () => {
	tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'projection-precedence-'));
	await fs.mkdir(path.join(tmpDir, '.swarm'), { recursive: true });
	await fs.writeFile(path.join(tmpDir, '.swarm', 'spec.md'), '# Test Spec\n');
});

afterEach(async () => {
	await fs.rm(tmpDir, { recursive: true, force: true });
});

function makePlan(status1: TaskStatus, status2: TaskStatus): Plan {
	return {
		schema_version: '1.0.0',
		title: 'Projection Precedence Test',
		swarm: 'precedence',
		current_phase: 1,
		phases: [
			{
				id: 1,
				name: 'Phase 1',
				status: 'in_progress',
				tasks: [
					{
						id: '1.1',
						phase: 1,
						description: 'Task 1.1',
						status: status1,
						size: 'small',
						depends: [],
						files_touched: [],
					},
					{
						id: '1.2',
						phase: 1,
						description: 'Task 1.2',
						status: status2,
						size: 'small',
						depends: [],
						files_touched: [],
					},
				],
			},
		],
	};
}

async function readPlanJson(): Promise<Plan> {
	return JSON.parse(
		await fs.readFile(path.join(tmpDir, '.swarm', 'plan.json'), 'utf-8'),
	) as Plan;
}

/**
 * Simulate a completion landing on plan.json WITHOUT a corresponding ledger
 * event — the production hazard at the heart of Scenario B (e.g. an external
 * tool or a crash-window writes plan.json but not the ledger).
 */
async function forceCompleteOnDisk(taskId: string): Promise<void> {
	const planPath = path.join(tmpDir, '.swarm', 'plan.json');
	const plan = JSON.parse(await fs.readFile(planPath, 'utf-8')) as Plan;
	for (const phase of plan.phases) {
		for (const task of phase.tasks) {
			if (task.id === taskId) task.status = 'completed';
		}
	}
	await fs.writeFile(planPath, JSON.stringify(plan, null, 2));
}

describe('savePlan projection precedence (issue #1729 production bug #1)', () => {
	test('Scenario A: concurrent-writer ledger completion wins over stale caller pending', async () => {
		const initial = makePlan('pending', 'pending');
		await savePlan(tmpDir, initial);

		const taskOneCompleted = makePlan('completed', 'pending');
		await appendLedgerEvent(
			tmpDir,
			{
				plan_id: derivePlanId(initial),
				event_type: 'task_status_changed',
				task_id: '1.1',
				phase_id: 1,
				from_status: 'pending',
				to_status: 'completed',
				source: 'test_concurrent_writer',
			},
			{ planHashAfter: computePlanLedgerHash(taskOneCompleted) },
		);

		// Stale caller still believes 1.1 is pending; 1.2 is being completed
		// by this caller's own diff loop.
		await savePlan(tmpDir, makePlan('pending', 'completed'));

		const projected = await readPlanJson();
		const statuses = new Map(
			projected.phases[0].tasks.map((task) => [task.id, task.status]),
		);
		// Scenario A: the concurrent writer's ledger-recorded completion
		// outranks the stale caller's pending.
		expect(statuses.get('1.1')).toBe('completed');
		expect(statuses.get('1.2')).toBe('completed');
	});

	test('Scenario B: disk-truth completion survives a stale ledger in_progress', async () => {
		// 1. Initial save: all pending.
		await savePlan(tmpDir, makePlan('pending', 'pending'));

		// 2. Move 1.1 to in_progress via a recorded ledger event (this mirrors
		//    update_task_status's path: status change persisted to BOTH ledger
		//    and plan.json).
		const inProgressPlan = makePlan('in_progress', 'pending');
		await appendLedgerEvent(
			tmpDir,
			{
				plan_id: derivePlanId(inProgressPlan),
				event_type: 'task_status_changed',
				task_id: '1.1',
				phase_id: 1,
				from_status: 'pending',
				to_status: 'in_progress',
				source: 'test_update_task_status',
			},
			{ planHashAfter: computePlanLedgerHash(inProgressPlan) },
		);
		// Reflect the same transition on disk so plan.json and the ledger
		// agree at this point.
		await savePlan(tmpDir, inProgressPlan);
		const afterProgress = await readPlanJson();
		expect(
			afterProgress.phases[0].tasks.find((t) => t.id === '1.1')?.status,
		).toBe('in_progress');

		// 3. Complete 1.1 ON DISK WITHOUT a ledger event — the hazard. (This
		//    is what forceCompleteTask simulates in the integration test, and
		//    the production crash-window / external-editor scenario.)
		await forceCompleteOnDisk('1.1');
		const afterComplete = await readPlanJson();
		expect(
			afterComplete.phases[0].tasks.find((t) => t.id === '1.1')?.status,
		).toBe('completed');

		// 4. savePlan again with a revised description (merge-mode re-save).
		//    Before the fix: replay returned in_progress (the last ledger
		//    event) and overrode the disk-truth completed — regressing
		//    completed work. After the fix: the merge keeps completed because
		//    completed outranks in_progress.
		const revised = makePlan('completed', 'pending');
		revised.phases[0].tasks[0].description = 'Task 1.1 (revised)';
		await savePlan(tmpDir, revised);

		const projected = await readPlanJson();
		const statuses = new Map(
			projected.phases[0].tasks.map((task) => [task.id, task.status]),
		);
		expect(statuses.get('1.1')).toBe('completed');
		expect(statuses.get('1.2')).toBe('pending');
		// Description revision lands.
		expect(projected.phases[0].tasks[0].description).toBe('Task 1.1 (revised)');
	});

	// -------------------------------------------------------------------------
	// statusRank coverage: exercise every rank arm with inputs that
	// observationally distinguish `>` from `<` and confirm upgrades/downgrades
	// route correctly. Each test names the (validated -> replayed) rank pair.
	// -------------------------------------------------------------------------

	test('rank coverage: validated closed (5) survives replayed completed (4) — downgrade rejected', async () => {
		// Disk says closed; ledger records a completed transition (downgrade).
		// Merge must keep closed: rank(completed=4) > rank(closed=5) is FALSE.
		// A `<` typo (override when replayed is LESS terminal) would let
		// completed win — caught here.
		await savePlan(tmpDir, makePlan('closed', 'pending'));
		const completedPlan = makePlan('completed', 'pending');
		await appendLedgerEvent(
			tmpDir,
			{
				plan_id: derivePlanId(completedPlan),
				event_type: 'task_status_changed',
				task_id: '1.1',
				phase_id: 1,
				from_status: 'closed',
				to_status: 'completed',
				source: 'test_downgrade_attempt',
			},
			{ planHashAfter: computePlanLedgerHash(completedPlan) },
		);

		await savePlan(tmpDir, makePlan('closed', 'pending'));
		const projected = await readPlanJson();
		expect(projected.phases[0].tasks.find((t) => t.id === '1.1')?.status).toBe(
			'closed',
		);
	});

	test('rank coverage: validated pending (1) upgrades to replayed blocked (3) — upgrade accepted', async () => {
		// Disk says pending; ledger records blocked. Merge must upgrade to
		// blocked: rank(blocked=3) > rank(pending=1) is TRUE. A `<`/`<=` flip
		// would block the upgrade — caught here. Also exercises the blocked
		// rank arm (rank 3) which was previously uncovered.
		await savePlan(tmpDir, makePlan('pending', 'pending'));
		const blockedPlan = makePlan('blocked', 'pending');
		await appendLedgerEvent(
			tmpDir,
			{
				plan_id: derivePlanId(blockedPlan),
				event_type: 'task_status_changed',
				task_id: '1.1',
				phase_id: 1,
				from_status: 'pending',
				to_status: 'blocked',
				source: 'test_concurrent_writer',
			},
			{ planHashAfter: computePlanLedgerHash(blockedPlan) },
		);

		// Caller still believes 1.1 is pending; merge must adopt blocked.
		await savePlan(tmpDir, makePlan('pending', 'pending'));
		const projected = await readPlanJson();
		expect(projected.phases[0].tasks.find((t) => t.id === '1.1')?.status).toBe(
			'blocked',
		);
	});

	test('rank coverage: validated blocked (3) survives replayed in_progress (2) — downgrade rejected', async () => {
		// Disk says blocked; ledger records in_progress (a LOWER rank). Merge
		// must keep blocked: rank(in_progress=2) > rank(blocked=3) is FALSE.
		// Confirms the blocked rank arm survives a downgrade attempt — the
		// mirror of the previous test.
		await savePlan(tmpDir, makePlan('blocked', 'pending'));
		const inProgressPlan = makePlan('in_progress', 'pending');
		await appendLedgerEvent(
			tmpDir,
			{
				plan_id: derivePlanId(inProgressPlan),
				event_type: 'task_status_changed',
				task_id: '1.1',
				phase_id: 1,
				from_status: 'blocked',
				to_status: 'in_progress',
				source: 'test_downgrade_attempt',
			},
			{ planHashAfter: computePlanLedgerHash(inProgressPlan) },
		);

		await savePlan(tmpDir, makePlan('blocked', 'pending'));
		const projected = await readPlanJson();
		expect(projected.phases[0].tasks.find((t) => t.id === '1.1')?.status).toBe(
			'blocked',
		);
	});
});
