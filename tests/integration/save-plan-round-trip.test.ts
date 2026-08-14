/**
 * Integration test: save_plan + update_task_status round-trip.
 * Verifies that merge-mode preserves statuses across plan revisions.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { executeSavePlan, type SavePlanArgs } from '../../src/tools/save-plan';
import { executeUpdateTaskStatus } from '../../src/tools/update-task-status';

describe('save_plan + update_task_status round-trip integration', () => {
	let tmpDir: string;

	beforeEach(async () => {
		process.env.SWARM_SKIP_GATE_SELECTION = '1';
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'round-trip-test-'));
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
		delete process.env.SWARM_SKIP_GATE_SELECTION;
		try {
			await fs.rm(tmpDir, { recursive: true, force: true });
		} catch {
			// Ignore cleanup errors
		}
	});

	it('full round-trip: save → update → re-save preserves in_progress status', async () => {
		// Step 1: Save initial plan
		const initialPlan: SavePlanArgs = {
			title: 'Round Trip Test',
			swarm_id: 'integration',
			phases: [
				{
					id: 1,
					name: 'Phase 1',
					tasks: [
						{ id: '1.1', description: 'Setup database' },
						{
							id: '1.2',
							description: 'Create API endpoints',
							depends: ['1.1'],
						},
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

		const saveResult = await executeSavePlan(initialPlan);
		expect(saveResult.success).toBe(true);

		// Step 2: Update task 1.1 to in_progress
		const updateResult1 = await executeUpdateTaskStatus(
			{ task_id: '1.1', status: 'in_progress' },
			tmpDir,
		);
		expect(updateResult1.success).toBe(true);

		// Step 3: Manually set task to completed in plan.json to test merge-mode
		// (completing via executeUpdateTaskStatus requires full gate pipeline)
		const planJsonPath = path.join(tmpDir, '.swarm', 'plan.json');
		const planData = JSON.parse(await fs.readFile(planJsonPath, 'utf-8'));
		planData.phases[0].tasks[0].status = 'completed';
		await fs.writeFile(planJsonPath, JSON.stringify(planData, null, 2));

		// Step 4: Re-save plan with revised descriptions (merge mode)
		const revisedPlan: SavePlanArgs = {
			title: 'Round Trip Test',
			swarm_id: 'integration',
			phases: [
				{
					id: 1,
					name: 'Phase 1 Revised',
					tasks: [
						{ id: '1.1', description: 'Setup database (PostgreSQL)' },
						{
							id: '1.2',
							description: 'Create REST API endpoints',
							depends: ['1.1'],
						},
						{ id: '1.3', description: 'Add migration scripts' },
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

		const reSaveResult = await executeSavePlan(revisedPlan);
		expect(reSaveResult.success).toBe(true);

		// Step 5: Verify statuses were preserved
		const savedPlan = JSON.parse(await fs.readFile(planJsonPath, 'utf-8'));

		// Task 1.1 was completed — should be preserved by merge-mode
		expect(savedPlan.phases[0].tasks[0].status).toBe('completed');
		expect(savedPlan.phases[0].tasks[0].description).toBe(
			'Setup database (PostgreSQL)',
		);

		// Task 1.2 was never updated — should still be pending
		expect(savedPlan.phases[0].tasks[1].status).toBe('pending');

		// Task 1.3 is new — should be pending
		expect(savedPlan.phases[0].tasks[2].status).toBe('pending');

		// Task 2.1 was never updated — should still be pending
		expect(savedPlan.phases[1].tasks[0].status).toBe('pending');
	});

	it('plan.json and plan.md both exist after round-trip', async () => {
		const plan: SavePlanArgs = {
			title: 'File Check Test',
			swarm_id: 'integration',
			phases: [
				{
					id: 1,
					name: 'Phase 1',
					tasks: [{ id: '1.1', description: 'Task A' }],
				},
			],
			working_directory: tmpDir,
		};

		await executeSavePlan(plan);
		await executeUpdateTaskStatus(
			{ task_id: '1.1', status: 'in_progress' },
			tmpDir,
		);

		const planJsonExists = await fs
			.access(path.join(tmpDir, '.swarm', 'plan.json'))
			.then(() => true)
			.catch(() => false);
		const planMdExists = await fs
			.access(path.join(tmpDir, '.swarm', 'plan.md'))
			.then(() => true)
			.catch(() => false);

		expect(planJsonExists).toBe(true);
		expect(planMdExists).toBe(true);
	});

	it('in_progress is ledger-backed without fabricating workflow evidence', async () => {
		const plan: SavePlanArgs = {
			title: 'Evidence Seed Test',
			swarm_id: 'integration',
			phases: [
				{
					id: 1,
					name: 'Phase 1',
					tasks: [{ id: '1.1', description: 'Task A' }],
				},
			],
			working_directory: tmpDir,
		};

		await executeSavePlan(plan);
		await executeUpdateTaskStatus(
			{ task_id: '1.1', status: 'in_progress' },
			tmpDir,
		);

		// Status projection changes are not coder settlements and must not fabricate
		// exact-task workflow evidence.
		const evidenceExists = await fs
			.access(path.join(tmpDir, '.swarm', 'evidence', '1.1.json'))
			.then(() => true)
			.catch(() => false);
		expect(evidenceExists).toBe(false);

		const ledgerEvents = (
			await fs.readFile(
				path.join(tmpDir, '.swarm', 'plan-ledger.jsonl'),
				'utf-8',
			)
		)
			.trim()
			.split('\n')
			.map((line) => JSON.parse(line));
		expect(ledgerEvents).toContainEqual(
			expect.objectContaining({
				event_type: 'task_status_changed',
				task_id: '1.1',
				from_status: 'pending',
				to_status: 'in_progress',
			}),
		);
	});
});
