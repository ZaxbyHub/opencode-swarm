/**
 * Regression test for the PR #855 post-merge follow-up: a crash between the
 * task_removed ledger append and the plan.json atomic rename must not
 * resurrect the removed task on the next loadPlan().
 *
 * Before the fix, applyEventToPlan treated task_removed as audit-only, so
 * replayFromLedger would walk back to the prior snapshot (which still
 * contained the task) and apply the task_removed event as a no-op. The
 * rebuilt plan therefore brought the removed task back to life, breaking the
 * exact durability invariant the original PR was trying to strengthen.
 *
 * After the fix, replay applies task_removed by splicing the task out, so
 * the rebuilt plan matches the post-removal planHashAfter recorded in the
 * ledger and the removal is durable from the moment the ledger event commits.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Plan } from '../../../src/config/plan-schema';
import {
	appendLedgerEvent,
	computePlanHash,
	replayFromLedger,
} from '../../../src/plan/ledger';
import { loadPlan, savePlan } from '../../../src/plan/manager';
import { derivePlanId } from '../../../src/plan/utils';

let tmpDir: string;

beforeEach(async () => {
	tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ledger-removed-'));
	await fs.mkdir(path.join(tmpDir, '.swarm'), { recursive: true });
	await fs.writeFile(path.join(tmpDir, '.swarm', 'spec.md'), '# Test Spec\n');
});

afterEach(async () => {
	try {
		await fs.rm(tmpDir, { recursive: true, force: true });
	} catch {
		// best effort
	}
});

async function readPlanJson(): Promise<Plan> {
	const planPath = path.join(tmpDir, '.swarm', 'plan.json');
	return JSON.parse(await fs.readFile(planPath, 'utf-8')) as Plan;
}

describe('task_removed ledger replay (issue #853 follow-up)', () => {
	test('replayFromLedger drops a task that was removed via a task_removed event', async () => {
		// Seed a 2-task plan via savePlan so the ledger is bootstrapped properly.
		const initialPlan: Plan = {
			schema_version: '1.0.0',
			title: 'Replay Drop Test',
			swarm: 'regression',
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
							status: 'pending',
							size: 'small',
							depends: [],
							files_touched: [],
						},
						{
							id: '1.2',
							phase: 1,
							description: 'Task 1.2',
							status: 'pending',
							size: 'small',
							depends: [],
							files_touched: [],
						},
					],
				},
			],
		} as Plan;
		await savePlan(tmpDir, initialPlan);

		// Snapshot the pre-removal plan.json (this is what disk looks like
		// after a crash that lands the ledger append but loses the rename).
		const preRemovalPlan = await readPlanJson();
		expect(preRemovalPlan.phases[0].tasks.map((t) => t.id)).toEqual([
			'1.1',
			'1.2',
		]);

		// Compute the post-removal hash the way savePlan would.
		const postRemovalPlan: Plan = {
			...preRemovalPlan,
			phases: [
				{
					...preRemovalPlan.phases[0],
					tasks: preRemovalPlan.phases[0].tasks.filter((t) => t.id !== '1.2'),
				},
			],
		};
		const expectedHashAfter = computePlanHash(postRemovalPlan);

		// Append the task_removed event WITHOUT writing the new plan.json.
		// This is the precise interleaving that a process crash between the
		// ledger commit and the atomic rename produces.
		await appendLedgerEvent(
			tmpDir,
			{
				plan_id: derivePlanId(preRemovalPlan),
				event_type: 'task_removed',
				task_id: '1.2',
				phase_id: 1,
				from_status: 'pending',
				source: 'test_crash_simulation',
				payload: {
					reason: 'crash-window regression test',
					source: 'test_crash_simulation',
				},
			},
			{ planHashAfter: expectedHashAfter },
		);

		// Rebuild from the ledger as loadPlan() does on hash mismatch.
		const rebuilt = await replayFromLedger(tmpDir);
		expect(rebuilt).not.toBeNull();
		const rebuiltIds = (rebuilt as Plan).phases.flatMap((p) =>
			p.tasks.map((t) => t.id),
		);
		expect(rebuiltIds).toEqual(['1.1']);
		expect(computePlanHash(rebuilt as Plan)).toBe(expectedHashAfter);
	});

	test('replayFromLedger ignores task_removed events with no matching task', async () => {
		// A task_removed event for a task that does not exist in the snapshot
		// (e.g. already removed by an earlier replay step) must be a no-op
		// rather than corrupting the plan.
		const initialPlan: Plan = {
			schema_version: '1.0.0',
			title: 'Replay Noop Test',
			swarm: 'regression',
			phases: [
				{
					id: 1,
					name: 'Phase 1',
					status: 'pending',
					tasks: [
						{
							id: '1.1',
							phase: 1,
							description: 'Task 1.1',
							status: 'pending',
							size: 'small',
							depends: [],
							files_touched: [],
						},
					],
				},
			],
		} as Plan;
		await savePlan(tmpDir, initialPlan);

		const beforePlan = await readPlanJson();
		const beforeHash = computePlanHash(beforePlan);

		await appendLedgerEvent(
			tmpDir,
			{
				plan_id: derivePlanId(beforePlan),
				event_type: 'task_removed',
				task_id: '9.9',
				phase_id: 9,
				from_status: 'pending',
				source: 'test_noop',
				payload: { reason: 'no-op replay', source: 'test_noop' },
			},
			{ planHashAfter: beforeHash },
		);

		const rebuilt = await replayFromLedger(tmpDir);
		expect(rebuilt).not.toBeNull();
		const rebuiltIds = (rebuilt as Plan).phases.flatMap((p) =>
			p.tasks.map((t) => t.id),
		);
		expect(rebuiltIds).toEqual(['1.1']);
	});

	test('loadPlan transparently heals a crash-window stale plan.json', async () => {
		// End-to-end: prove loadPlan() does not resurrect the removed task.
		const initialPlan: Plan = {
			schema_version: '1.0.0',
			title: 'Replay Heal Test',
			swarm: 'regression',
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
							status: 'pending',
							size: 'small',
							depends: [],
							files_touched: [],
						},
						{
							id: '1.2',
							phase: 1,
							description: 'Task 1.2',
							status: 'pending',
							size: 'small',
							depends: [],
							files_touched: [],
						},
					],
				},
			],
		} as Plan;
		await savePlan(tmpDir, initialPlan);

		const preRemovalPlan = await readPlanJson();
		const postRemovalPlan: Plan = {
			...preRemovalPlan,
			phases: [
				{
					...preRemovalPlan.phases[0],
					tasks: preRemovalPlan.phases[0].tasks.filter((t) => t.id !== '1.2'),
				},
			],
		};
		const expectedHashAfter = computePlanHash(postRemovalPlan);

		// Simulate the crash: ledger event lands, plan.json rename is lost.
		await appendLedgerEvent(
			tmpDir,
			{
				plan_id: derivePlanId(preRemovalPlan),
				event_type: 'task_removed',
				task_id: '1.2',
				phase_id: 1,
				from_status: 'pending',
				source: 'test_crash_simulation',
				payload: {
					reason: 'crash-window regression test',
					source: 'test_crash_simulation',
				},
			},
			{ planHashAfter: expectedHashAfter },
		);

		const loaded = await loadPlan(tmpDir);
		expect(loaded).not.toBeNull();
		const loadedIds = (loaded as Plan).phases.flatMap((p) =>
			p.tasks.map((t) => t.id),
		);
		expect(loadedIds).toEqual(['1.1']);
	});
});
