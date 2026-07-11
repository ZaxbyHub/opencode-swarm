import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Plan } from '../config/plan-schema';
import { loadPlan, savePlan, updateTaskStatus } from './manager';

function makePlan(): Plan {
	return {
		schema_version: '1.0.0',
		title: 'Status Derivation Test Plan',
		swarm: 'test-swarm',
		current_phase: 1,
		phases: [
			{
				id: 1,
				name: 'Phase 1',
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
					{
						id: '1.2',
						phase: 1,
						status: 'pending',
						size: 'small',
						description: 'Second task',
						depends: [],
						files_touched: [],
					},
				],
			},
		],
		migration_status: 'native',
	};
}

describe('updateTaskStatus phase status derivation', () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-status-test-'));
		fs.mkdirSync(path.join(tempDir, '.swarm'), { recursive: true });
		await savePlan(tempDir, makePlan());
	});

	afterEach(() => {
		if (fs.existsSync(tempDir)) {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it('sets phase to in_progress when first task becomes in_progress', async () => {
		const updated = await updateTaskStatus(tempDir, '1.1', 'in_progress');

		expect(updated.phases[0].status).toBe('in_progress');
	});

	it('sets phase to complete when all tasks are completed', async () => {
		await updateTaskStatus(tempDir, '1.1', 'completed');
		const updated = await updateTaskStatus(tempDir, '1.2', 'completed');

		expect(updated.phases[0].status).toBe('complete');
	});

	it('returns phase to pending when no task is in_progress/blocked and not all are completed', async () => {
		await updateTaskStatus(tempDir, '1.1', 'in_progress');
		const updated = await updateTaskStatus(tempDir, '1.1', 'pending');

		expect(updated.phases[0].status).toBe('pending');

		const reloaded = await loadPlan(tempDir);
		expect(reloaded?.phases[0].status).toBe('pending');
	});

	// Regression test: downgrading completed → pending must actually persist.
	//
	// Root cause: updateTaskStatus previously called savePlan with
	// preserveCompletedStatuses:true, which caused savePlan to re-read disk,
	// see the task as 'completed', and silently override the caller's explicit
	// request back to 'completed'.  The function returned success (with the
	// requested status in its return value) but disk still had 'completed',
	// producing a silent false-positive that confused LLM agents trying to
	// reset task status for re-planning.
	it('regression: downgrading completed → pending is persisted to disk (not silently overridden)', async () => {
		// Mark both tasks completed so phase becomes complete
		await updateTaskStatus(tempDir, '1.1', 'completed');
		await updateTaskStatus(tempDir, '1.2', 'completed');

		// Downgrade task 1.1 back to pending
		const returned = await updateTaskStatus(tempDir, '1.1', 'pending');

		// The returned plan must reflect the new status
		const task11Returned = returned.phases[0].tasks.find((t) => t.id === '1.1');
		expect(task11Returned?.status).toBe('pending');

		// CRITICAL: disk must also reflect the new status — not silently remain 'completed'
		const reloaded = await loadPlan(tempDir);
		const task11OnDisk = reloaded?.phases[0].tasks.find((t) => t.id === '1.1');
		expect(task11OnDisk?.status).toBe('pending');

		// Phase is 'pending': task 1.1 is pending, task 1.2 is completed, none are in_progress
		expect(reloaded?.phases[0].status).toBe('pending');
	});

	// Regression test: forced downgrade completed → in_progress must persist.
	//
	// The FR-005 settled-task guard refuses to re-open a settled task
	// (completed/closed/blocked) to in_progress unless the caller opts in via
	// { force: true } — an unforced call intentionally returns the settled plan
	// unchanged. This test exercises the legitimate re-open path (force) and
	// verifies the older savePlan silent-override bug stays fixed: the explicit
	// in_progress request must reach disk (savePlan must not re-read the
	// completed status and revert it).
	it('regression: forced downgrading completed → in_progress is persisted to disk', async () => {
		await updateTaskStatus(tempDir, '1.1', 'completed');

		const returned = await updateTaskStatus(tempDir, '1.1', 'in_progress', {
			force: true,
		});

		const task11Returned = returned.phases[0].tasks.find((t) => t.id === '1.1');
		expect(task11Returned?.status).toBe('in_progress');

		const reloaded = await loadPlan(tempDir);
		const task11OnDisk = reloaded?.phases[0].tasks.find((t) => t.id === '1.1');
		expect(task11OnDisk?.status).toBe('in_progress');
	});

	// Verify that other tasks' completed status is still preserved when a
	// DIFFERENT task is updated (no unintended regression on sibling tasks).
	it('downgrading one task does not reset sibling completed tasks', async () => {
		await updateTaskStatus(tempDir, '1.1', 'completed');
		await updateTaskStatus(tempDir, '1.2', 'completed');

		// Reset only 1.1 — 1.2 must remain completed
		await updateTaskStatus(tempDir, '1.1', 'pending');

		const reloaded = await loadPlan(tempDir);
		const task12OnDisk = reloaded?.phases[0].tasks.find((t) => t.id === '1.2');
		expect(task12OnDisk?.status).toBe('completed');
	});
});
