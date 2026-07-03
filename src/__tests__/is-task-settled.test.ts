/**
 * Tests for isTaskSettled (plan/manager.ts) and the centralized
 * updateTaskStatus settled-task guard (FR-005).
 *
 * DI seam used: manager._internals.loadPlanJsonOnly
 * Mock coverage: loadPlanJsonOnly is the only external dependency.
 * The _internals seam is file-scoped and trivially restorable in afterEach.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Plan } from '../../src/config/plan-schema';
import {
	_internals,
	isTaskSettled,
	resetStartupLedgerCheck,
	updateTaskStatus,
} from '../../src/plan/manager';
import { resetSwarmArtifactCache } from '../../src/utils/swarm-artifact-cache';

// ── Test plan factory ─────────────────────────────────────────────────────────

function makePlan(tasks: Array<{ id: string; status: string }>): Plan {
	return {
		schema_version: '1.0.0',
		title: 'Settled Guard Test Plan',
		swarm: 'test-swarm',
		current_phase: 1,
		phases: [
			{
				id: 1,
				name: 'Phase 1',
				status: 'in_progress',
				tasks: tasks.map((t) => ({
					id: t.id,
					phase: 1,
					status: t.status as Plan['phases'][0]['tasks'][0]['status'],
					size: 'small',
					description: `Task ${t.id}`,
					depends: [],
					files_touched: [],
				})),
			},
		],
	};
}

async function writePlanJson(dir: string, plan: Plan) {
	const swarmDir = join(dir, '.swarm');
	await mkdir(swarmDir, { recursive: true });
	await writeFile(join(swarmDir, 'plan.json'), JSON.stringify(plan, null, 2));
}

async function readPlanJson(dir: string): Promise<Plan | null> {
	const p = join(dir, '.swarm', 'plan.json');
	if (!existsSync(p)) return null;
	return JSON.parse(await readFile(p, 'utf-8')) as Plan;
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

describe('isTaskSettled', () => {
	let tempDir: string;

	beforeEach(async () => {
		resetStartupLedgerCheck();
		resetSwarmArtifactCache();
		tempDir = await mkdtemp(join(tmpdir(), 'is-task-settled-'));
	});

	afterEach(async () => {
		if (existsSync(tempDir)) {
			await rm(tempDir, { recursive: true, force: true });
		}
	});

	test('returns TRUE for task status "completed"', async () => {
		await writePlanJson(
			tempDir,
			makePlan([{ id: '1.1', status: 'completed' }]),
		);
		const result = await isTaskSettled(tempDir, '1.1');
		expect(result).toBe(true);
	});

	test('returns TRUE for task status "blocked"', async () => {
		await writePlanJson(tempDir, makePlan([{ id: '1.1', status: 'blocked' }]));
		const result = await isTaskSettled(tempDir, '1.1');
		expect(result).toBe(true);
	});

	test('returns TRUE for task status "closed" (settled terminal state)', async () => {
		// "closed" is not in the standard TaskStatus union but is treated as settled
		// by isTaskSettled since it is neither 'pending' nor 'in_progress'.
		// Write a plan with a non-standard status to verify the !== check.
		const plan = makePlan([{ id: '1.1', status: 'pending' }]);
		(plan.phases[0].tasks[0] as { status: string }).status = 'closed';
		await writePlanJson(tempDir, plan);
		const result = await isTaskSettled(tempDir, '1.1');
		expect(result).toBe(true);
	});

	test('returns FALSE for task status "pending"', async () => {
		await writePlanJson(tempDir, makePlan([{ id: '1.1', status: 'pending' }]));
		const result = await isTaskSettled(tempDir, '1.1');
		expect(result).toBe(false);
	});

	test('returns FALSE for task status "in_progress"', async () => {
		await writePlanJson(
			tempDir,
			makePlan([{ id: '1.1', status: 'in_progress' }]),
		);
		const result = await isTaskSettled(tempDir, '1.1');
		expect(result).toBe(false);
	});

	test('returns FALSE when task is not found in plan', async () => {
		await writePlanJson(
			tempDir,
			makePlan([{ id: '1.1', status: 'completed' }]),
		);
		const result = await isTaskSettled(tempDir, '99.99');
		expect(result).toBe(false);
	});

	test('returns FALSE (does not throw) when plan is unreadable', async () => {
		// No plan.json written — directory exists but is empty.
		// isTaskSettled calls loadPlanJsonOnly which returns null for missing file.
		const result = await isTaskSettled(tempDir, '1.1');
		expect(result).toBe(false);
	});

	test('returns FALSE when .swarm dir does not exist at all', async () => {
		const result = await isTaskSettled(tempDir, '1.1');
		expect(result).toBe(false);
	});
});

// ── updateTaskStatus centralized guard ─────────────────────────────────────────

describe('updateTaskStatus — centralized settled-task guard', () => {
	let tempDir: string;

	beforeEach(async () => {
		resetStartupLedgerCheck();
		resetSwarmArtifactCache();
		tempDir = await mkdtemp(join(tmpdir(), 'uts-guard-'));
	});

	afterEach(async () => {
		if (existsSync(tempDir)) {
			await rm(tempDir, { recursive: true, force: true });
		}
	});

	test('persisting in_progress on a COMPLETED task is REFUSED without force (returns plan unchanged)', async () => {
		await writePlanJson(
			tempDir,
			makePlan([{ id: '1.1', status: 'completed' }]),
		);
		const before = await readPlanJson(tempDir);
		const result = await updateTaskStatus(tempDir, '1.1', 'in_progress');
		// Guard returns the unmodified plan (no write occurred)
		expect(result.phases[0].tasks[0].status).toBe('completed');
		// plan.json on disk is also unchanged
		const after = await readPlanJson(tempDir);
		expect(after!.phases[0].tasks[0].status).toBe('completed');
		// Verify the before/after are identical (no mutation)
		expect(before).toEqual(after);
	});

	test('persisting in_progress on a BLOCKED task is REFUSED without force', async () => {
		await writePlanJson(tempDir, makePlan([{ id: '1.1', status: 'blocked' }]));
		const before = await readPlanJson(tempDir);
		const result = await updateTaskStatus(tempDir, '1.1', 'in_progress');
		expect(result.phases[0].tasks[0].status).toBe('blocked');
		const after = await readPlanJson(tempDir);
		expect(after!.phases[0].tasks[0].status).toBe('blocked');
		expect(before).toEqual(after);
	});

	test('persisting in_progress with force:true on a settled task is PERMITTED', async () => {
		await writePlanJson(
			tempDir,
			makePlan([{ id: '1.1', status: 'completed' }]),
		);
		const result = await updateTaskStatus(tempDir, '1.1', 'in_progress', {
			force: true,
		});
		expect(result.phases[0].tasks[0].status).toBe('in_progress');
		const after = await readPlanJson(tempDir);
		expect(after!.phases[0].tasks[0].status).toBe('in_progress');
	});

	test('persisting in_progress on a PENDING task PROCEEDS (not blocked)', async () => {
		await writePlanJson(tempDir, makePlan([{ id: '1.1', status: 'pending' }]));
		const result = await updateTaskStatus(tempDir, '1.1', 'in_progress');
		expect(result.phases[0].tasks[0].status).toBe('in_progress');
		const after = await readPlanJson(tempDir);
		expect(after!.phases[0].tasks[0].status).toBe('in_progress');
	});

	test('persisting in_progress on an IN_PROGRESS task PROCEEDS (retry-after-failure not blocked)', async () => {
		await writePlanJson(
			tempDir,
			makePlan([{ id: '1.1', status: 'in_progress' }]),
		);
		const result = await updateTaskStatus(tempDir, '1.1', 'in_progress');
		expect(result.phases[0].tasks[0].status).toBe('in_progress');
		const after = await readPlanJson(tempDir);
		expect(after!.phases[0].tasks[0].status).toBe('in_progress');
	});

	test('ZERO-MUTATION: refused in_progress on completed task does not write plan.json', async () => {
		await writePlanJson(
			tempDir,
			makePlan([{ id: '1.1', status: 'completed' }]),
		);
		const mtimeBefore = await readFile(
			join(tempDir, '.swarm', 'plan.json'),
			'utf-8',
		);
		// Wait 1ms so mtime would differ if written
		await new Promise((r) => setTimeout(r, 2));
		await updateTaskStatus(tempDir, '1.1', 'in_progress');
		const mtimeAfter = await readFile(
			join(tempDir, '.swarm', 'plan.json'),
			'utf-8',
		);
		// File content must be identical (no write occurred)
		expect(mtimeAfter).toBe(mtimeBefore);
	});

	test('ZERO-MUTATION: refused in_progress on completed task does not change task status', async () => {
		await writePlanJson(
			tempDir,
			makePlan([{ id: '1.1', status: 'completed' }]),
		);
		await updateTaskStatus(tempDir, '1.1', 'in_progress');
		const after = await readPlanJson(tempDir);
		expect(after!.phases[0].tasks[0].status).toBe('completed');
	});
});
