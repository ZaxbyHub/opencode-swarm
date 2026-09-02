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
	tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ledger-projection-'));
	await fs.mkdir(path.join(tmpDir, '.swarm'), { recursive: true });
	await fs.writeFile(path.join(tmpDir, '.swarm', 'spec.md'), '# Test Spec\n');
});

afterEach(async () => {
	await fs.rm(tmpDir, { recursive: true, force: true });
});

function makePlan(status1: TaskStatus, status2: TaskStatus): Plan {
	return {
		schema_version: '1.0.0',
		title: 'Projection Race Test',
		swarm: 'regression',
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

describe('savePlan ledger-derived projection regression', () => {
	test('does not overwrite a newer ledger transition with a stale caller projection', async () => {
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

		await savePlan(tmpDir, makePlan('pending', 'completed'));

		const projected = await readPlanJson();
		const statuses = new Map(
			projected.phases[0].tasks.map((task) => [task.id, task.status]),
		);
		expect(statuses.get('1.1')).toBe('completed');
		expect(statuses.get('1.2')).toBe('completed');

		const planMarkdown = await fs.readFile(
			path.join(tmpDir, '.swarm', 'plan.md'),
			'utf-8',
		);
		expect(planMarkdown).toContain('- [x] 1.1: Task 1.1');
		expect(planMarkdown).toContain('- [x] 1.2: Task 1.2');
	});
});
