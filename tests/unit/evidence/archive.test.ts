import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Evidence } from '../../../src/config/evidence-schema';
import {
	_internals,
	archiveEvidence,
	deleteEvidence,
	loadEvidence,
	saveEvidence,
} from '../../../src/evidence/manager';

const realLoadEvidence = _internals.loadEvidence;

describe('archiveEvidence', () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtemp();
		mkdirSync(path.join(tempDir, '.swarm'), { recursive: true });
	});

	afterEach(() => {
		_internals.loadEvidence = realLoadEvidence;
		cleanup(tempDir);
	});

	test('archiveEvidence with no evidence returns empty array', async () => {
		const archived = await archiveEvidence(tempDir, 90);
		expect(archived).toEqual([]);
	});

	test('skips a bundle whose read throws without aborting retention', async () => {
		const taskId = 'unreadable';
		await saveEvidence(
			tempDir,
			taskId,
			createNoteEvidence(taskId, 'Unreadable note'),
		);
		_internals.loadEvidence = async () => {
			throw new Error('simulated read failure');
		};
		expect(await archiveEvidence(tempDir, 90)).toEqual([]);
	});

	test('archiveEvidence deletes bundles older than maxAgeDays', async () => {
		// Create old bundle
		const taskId = 'task-1';
		await saveEvidence(tempDir, taskId, createNoteEvidence(taskId, 'Old note'));

		// Modify timestamp to be old (100 days ago)
		await makeBundleOld(tempDir, taskId, 100);

		// Archive with maxAgeDays=90
		const archived = await archiveEvidence(tempDir, 90);
		expect(archived).toEqual(['task-1']);

		// Verify deleted
		const loaded = await loadEvidence(tempDir, taskId);
		expect(loaded.status).toBe('not_found');
	});

	test('archiveEvidence keeps bundles newer than maxAgeDays', async () => {
		// Create recent bundle
		const taskId = 'task-1';
		await saveEvidence(
			tempDir,
			taskId,
			createNoteEvidence(taskId, 'Recent note'),
		);

		// Archive with maxAgeDays=90
		const archived = await archiveEvidence(tempDir, 90);
		expect(archived).toEqual([]);

		// Verify still exists
		const loaded = await loadEvidence(tempDir, taskId);
		expect(loaded.status).toBe('found');
		if (loaded.status !== 'found') throw new Error('Expected found');
		expect(loaded.bundle.task_id).toBe(taskId);
	});

	test('archiveEvidence with mixed old/new bundles only deletes old ones', async () => {
		// Create old bundle
		const oldTaskId = 'old-task';
		await saveEvidence(
			tempDir,
			oldTaskId,
			createNoteEvidence(oldTaskId, 'Old note'),
		);
		await makeBundleOld(tempDir, oldTaskId, 100);

		// Create new bundle
		const newTaskId = 'new-task';
		await saveEvidence(
			tempDir,
			newTaskId,
			createNoteEvidence(newTaskId, 'New note'),
		);

		// Archive with maxAgeDays=90
		const archived = await archiveEvidence(tempDir, 90);
		expect(archived).toEqual(['old-task']);
		expect(archived).not.toContain('new-task');

		// Verify old deleted, new exists
		const oldLoaded = await loadEvidence(tempDir, oldTaskId);
		expect(oldLoaded.status).toBe('not_found');
		const newLoaded = await loadEvidence(tempDir, newTaskId);
		expect(newLoaded.status).toBe('found');
	});

	test('archiveEvidence with maxBundles: if remaining > maxBundles, deletes oldest', async () => {
		// Create 5 bundles
		const taskIds = ['task-1', 'task-2', 'task-3', 'task-4', 'task-5'];
		for (const taskId of taskIds) {
			await saveEvidence(
				tempDir,
				taskId,
				createNoteEvidence(taskId, `Note for ${taskId}`),
			);
		}

		// Make task-1 oldest (updated 10 days ago), task-5 newest (updated 2 days ago)
		// All are recent (< 90 days), so age filter won't delete any
		await makeBundleOld(tempDir, 'task-1', 10);
		await makeBundleOld(tempDir, 'task-2', 8);
		await makeBundleOld(tempDir, 'task-3', 6);
		await makeBundleOld(tempDir, 'task-4', 4);
		await makeBundleOld(tempDir, 'task-5', 2);

		// Archive with maxAgeDays=90 (none deleted by age) and maxBundles=3
		const archived = await archiveEvidence(tempDir, 90, 3);

		// Should delete oldest 2 (task-1, task-2)
		expect(archived).toHaveLength(2);
		expect(archived).toContain('task-1');
		expect(archived).toContain('task-2');
		expect(archived).not.toContain('task-3');
		expect(archived).not.toContain('task-4');
		expect(archived).not.toContain('task-5');

		// Verify deleted
		const task1Loaded = await loadEvidence(tempDir, 'task-1');
		expect(task1Loaded.status).toBe('not_found');
		const task2Loaded = await loadEvidence(tempDir, 'task-2');
		expect(task2Loaded.status).toBe('not_found');
		const task3Loaded = await loadEvidence(tempDir, 'task-3');
		expect(task3Loaded.status).toBe('found');
		const task4Loaded = await loadEvidence(tempDir, 'task-4');
		expect(task4Loaded.status).toBe('found');
		const task5Loaded = await loadEvidence(tempDir, 'task-5');
		expect(task5Loaded.status).toBe('found');
	});

	test('archiveEvidence with maxBundles: if remaining <= maxBundles, does not delete extra', async () => {
		// Create 3 bundles
		const taskIds = ['task-1', 'task-2', 'task-3'];
		for (const taskId of taskIds) {
			await saveEvidence(
				tempDir,
				taskId,
				createNoteEvidence(taskId, `Note for ${taskId}`),
			);
		}

		// Archive with maxAgeDays=1 (none deleted by age) and maxBundles=10
		const archived = await archiveEvidence(tempDir, 1, 10);

		// Should delete nothing
		expect(archived).toEqual([]);

		// Verify all still exist
		for (const taskId of taskIds) {
			const result = await loadEvidence(tempDir, taskId);
			expect(result.status).toBe('found');
		}
	});

	test('archiveEvidence with both age and maxBundles: age first, then maxBundles', async () => {
		// Create 6 bundles with varying ages
		const taskIds = [
			'task-1',
			'task-2',
			'task-3',
			'task-4',
			'task-5',
			'task-6',
		];
		for (const taskId of taskIds) {
			await saveEvidence(
				tempDir,
				taskId,
				createNoteEvidence(taskId, `Note for ${taskId}`),
			);
		}

		// Make some old, some new
		// task-1: 100 days old (will be deleted by age)
		// task-2: 80 days old (will be deleted by age)
		// task-3: 60 days old (will be deleted by age)
		// task-4: 40 days old (kept by age, but oldest for maxBundles)
		// task-5: 20 days old (kept)
		// task-6: 10 days old (kept)
		await makeBundleOld(tempDir, 'task-1', 100);
		await makeBundleOld(tempDir, 'task-2', 80);
		await makeBundleOld(tempDir, 'task-3', 60);
		await makeBundleOld(tempDir, 'task-4', 40);
		await makeBundleOld(tempDir, 'task-5', 20);
		await makeBundleOld(tempDir, 'task-6', 10);

		// Archive with maxAgeDays=50 (deletes 1,2,3) and maxBundles=2 (after age, only 3 left: 4,5,6, delete oldest 1: task-4)
		const archived = await archiveEvidence(tempDir, 50, 2);

		// Should delete task-1, task-2, task-3 (age), and task-4 (maxBundles)
		expect(archived).toHaveLength(4);
		expect(archived).toContain('task-1');
		expect(archived).toContain('task-2');
		expect(archived).toContain('task-3');
		expect(archived).toContain('task-4');
		expect(archived).not.toContain('task-5');
		expect(archived).not.toContain('task-6');

		// Verify deleted
		const task1Result = await loadEvidence(tempDir, 'task-1');
		expect(task1Result.status).toBe('not_found');
		const task2Result = await loadEvidence(tempDir, 'task-2');
		expect(task2Result.status).toBe('not_found');
		const task3Result = await loadEvidence(tempDir, 'task-3');
		expect(task3Result.status).toBe('not_found');
		const task4Result = await loadEvidence(tempDir, 'task-4');
		expect(task4Result.status).toBe('not_found');
		const task5Result = await loadEvidence(tempDir, 'task-5');
		expect(task5Result.status).toBe('found');
		const task6Result = await loadEvidence(tempDir, 'task-6');
		expect(task6Result.status).toBe('found');
	});

	test('archiveEvidence with maxBundles=undefined: no bundle count enforcement', async () => {
		// Create 5 bundles
		const taskIds = ['task-1', 'task-2', 'task-3', 'task-4', 'task-5'];
		for (const taskId of taskIds) {
			await saveEvidence(
				tempDir,
				taskId,
				createNoteEvidence(taskId, `Note for ${taskId}`),
			);
		}

		// Archive with maxAgeDays=1 (none deleted by age) and maxBundles undefined
		const archived = await archiveEvidence(tempDir, 1, undefined);

		// Should delete nothing
		expect(archived).toEqual([]);

		// Verify all still exist
		for (const taskId of taskIds) {
			const result = await loadEvidence(tempDir, taskId);
			expect(result.status).toBe('found');
		}
	});
});

// Helper functions
function mkdtemp(): string {
	return require('node:fs').realpathSync(
		require('node:fs').mkdtempSync(
			path.join(os.tmpdir(), 'evidence-archive-test-'),
		),
	);
}

function cleanup(dir: string): void {
	rmSync(dir, { recursive: true, force: true });
}

async function makeBundleOld(
	directory: string,
	taskId: string,
	daysOld: number,
): Promise<void> {
	const result = await loadEvidence(directory, taskId);
	if (result.status !== 'found') {
		throw new Error(`Bundle not found for task ${taskId}`);
	}
	const bundle = result.bundle;

	// Set updated_at and created_at to old date
	const oldDate = new Date();
	oldDate.setDate(oldDate.getDate() - daysOld);
	const oldIso = oldDate.toISOString();

	bundle.updated_at = oldIso;
	bundle.created_at = oldIso;

	// Write back
	const evidencePath = path.join(
		directory,
		'.swarm',
		'evidence',
		taskId,
		'evidence.json',
	);
	await Bun.write(evidencePath, JSON.stringify(bundle));
}

// Helper function to create note evidence with required fields
function createNoteEvidence(taskId: string, summary: string): Evidence {
	return {
		type: 'note',
		task_id: taskId,
		timestamp: new Date().toISOString(),
		agent: 'test-agent',
		verdict: 'info',
		summary,
	};
}
