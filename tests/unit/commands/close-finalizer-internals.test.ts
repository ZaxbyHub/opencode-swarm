import { describe, expect, test } from 'bun:test';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createCloseFinalizerHarness } from './close-finalizer.fixture.js';

const { closeInternals } = await createCloseFinalizerHarness();

describe('guaranteeAllPlansComplete via _internals (FR-006b)', () => {
	test('marks in-progress tasks as closed with close_reason: session_terminated', async () => {
		const planData = {
			title: 'Test Plan',
			phases: [
				{
					id: 1,
					name: 'Phase 1',
					status: 'in_progress',
					tasks: [
						{ id: '1.1', status: 'in_progress' },
						{ id: '1.2', status: 'complete' },
					],
				},
			],
		};

		const result = closeInternals.guaranteeAllPlansComplete(planData);

		expect(planData.phases[0].tasks[0].status).toBe('closed');
		expect(planData.phases[0].tasks[0].close_reason).toBe('session_terminated');
		expect(planData.phases[0].tasks[1].status).toBe('complete');
		expect(planData.phases[0].tasks[1].close_reason).toBeUndefined();
		expect(result.closedTaskIds).toEqual(['1.1']);
		expect(result.closedPhaseIds).toEqual([1]);
	});

	test('marks in-progress phases as closed', async () => {
		const planData = {
			title: 'Test Plan',
			phases: [
				{
					id: 1,
					name: 'Phase 1',
					status: 'in_progress',
					tasks: [{ id: '1.1', status: 'complete' }],
				},
				{
					id: 2,
					name: 'Phase 2',
					status: 'pending',
					tasks: [],
				},
			],
		};

		const result = closeInternals.guaranteeAllPlansComplete(planData);

		expect(planData.phases[0].status).toBe('closed');
		expect(planData.phases[1].status).toBe('closed');
		expect(result.closedPhaseIds).toEqual([1, 2]);
		expect(result.closedTaskIds).toEqual([]);
	});

	test('is idempotent: second call returns empty sets', async () => {
		const planData = {
			title: 'Test Plan',
			phases: [
				{
					id: 1,
					name: 'Phase 1',
					status: 'in_progress',
					tasks: [{ id: '1.1', status: 'in_progress' }],
				},
			],
		};

		const first = closeInternals.guaranteeAllPlansComplete(planData);
		expect(first.closedPhaseIds).toEqual([1]);
		expect(first.closedTaskIds).toEqual(['1.1']);

		const second = closeInternals.guaranteeAllPlansComplete(planData);
		expect(second.closedPhaseIds).toEqual([]);
		expect(second.closedTaskIds).toEqual([]);

		expect(planData.phases[0].status).toBe('closed');
		expect(planData.phases[0].tasks[0].status).toBe('closed');
	});

	test('empty plan (no phases) returns empty sets', async () => {
		const planData = {
			title: 'Empty Plan',
			phases: [],
		};

		const result = closeInternals.guaranteeAllPlansComplete(planData);

		expect(result).toEqual({ closedPhaseIds: [], closedTaskIds: [] });
		expect(planData.phases).toEqual([]);
	});

	test('return value contains correct closedPhaseIds and closedTaskIds', async () => {
		const planData = {
			title: 'Mixed Plan',
			phases: [
				{
					id: 1,
					name: 'Phase 1',
					status: 'in_progress',
					tasks: [
						{ id: '1.1', status: 'in_progress' },
						{ id: '1.2', status: 'in_progress' },
					],
				},
				{
					id: 2,
					name: 'Phase 2',
					status: 'complete',
					tasks: [{ id: '2.1', status: 'in_progress' }],
				},
			],
		};

		const result = closeInternals.guaranteeAllPlansComplete(planData);

		expect(result.closedPhaseIds).toEqual([1]);
		expect(result.closedTaskIds).toEqual(['1.1', '1.2', '2.1']);
		expect(planData.phases[1].status).toBe('complete');
	});
});

describe('copyDirRecursive via _internals (FR-015b)', () => {
	test('copies a nested directory tree with files and subdirectories and returns the correct file count', async () => {
		const tmp = mkdtempSync(path.join(os.tmpdir(), 'copydir-recursive-test-'));
		try {
			const src = path.join(tmp, 'src');
			const dest = path.join(tmp, 'dest');

			mkdirSync(path.join(src, 'a', 'b'), { recursive: true });
			writeFileSync(path.join(src, 'file1.txt'), 'hello');
			writeFileSync(path.join(src, 'a', 'file2.txt'), 'world');
			writeFileSync(path.join(src, 'a', 'b', 'file3.txt'), 'deep');

			const count = await closeInternals.copyDirRecursive(src, dest);

			expect(count).toBe(3);
			expect(existsSync(path.join(dest, 'file1.txt'))).toBe(true);
			expect(readFileSync(path.join(dest, 'file1.txt'), 'utf8')).toBe('hello');
			expect(existsSync(path.join(dest, 'a', 'file2.txt'))).toBe(true);
			expect(readFileSync(path.join(dest, 'a', 'file2.txt'), 'utf8')).toBe(
				'world',
			);
			expect(existsSync(path.join(dest, 'a', 'b', 'file3.txt'))).toBe(true);
			expect(readFileSync(path.join(dest, 'a', 'b', 'file3.txt'), 'utf8')).toBe(
				'deep',
			);
			expect(existsSync(path.join(dest, 'a'))).toBe(true);
			expect(existsSync(path.join(dest, 'a', 'b'))).toBe(true);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});
});
