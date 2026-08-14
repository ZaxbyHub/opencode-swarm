import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Plan, TaskStatus } from '../../../src/config/plan-schema';
import { closeAllProjectDbs } from '../../../src/db/project-db.js';
import { savePlan } from '../../../src/plan/manager.js';
import { checkpoint } from '../../../src/tools/checkpoint.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const GIT_TIMEOUT_MS = 30_000;
const GIT_MAX_BUFFER_BYTES = 5 * 1024 * 1024;

function runGit(directory: string, args: string[]): string {
	const result = childProcess.spawnSync('git', args, {
		cwd: directory,
		encoding: 'utf-8',
		timeout: GIT_TIMEOUT_MS,
		stdio: ['ignore', 'pipe', 'pipe'],
		windowsHide: true,
		maxBuffer: GIT_MAX_BUFFER_BYTES,
	});
	if (result.error) throw result.error;
	if (result.status !== 0) {
		throw new Error(result.stderr?.trim() || `git exited ${result.status}`);
	}
	return result.stdout ?? '';
}

function makePlan(status: TaskStatus, taskId = '1.1'): Plan {
	return {
		schema_version: '1.0.0',
		title: 'Eligibility Plan',
		swarm: 'checkpoint-swarm',
		current_phase: 1,
		phases: [
			{
				id: 1,
				name: 'Phase 1',
				status: status === 'completed' ? 'complete' : 'in_progress',
				tasks: [
					{
						id: taskId,
						phase: 1,
						status,
						size: 'small',
						description: `Task ${taskId}`,
						depends: [],
						files_touched: [],
					},
				],
			},
		],
		migration_status: 'native',
	};
}

describe('checkpoint save_task_completion eligibility guards', () => {
	let tempDir: string;
	let originalCwd: string;

	beforeEach(() => {
		tempDir = canonicalMkdtemp('checkpoint-task-eligibility-');
		originalCwd = process.cwd();
		runGit(tempDir, ['init']);
		runGit(tempDir, ['config', '--local', 'commit.gpgsign', 'false']);
		runGit(tempDir, ['config', 'user.email', 'test@test.com']);
		runGit(tempDir, ['config', 'user.name', 'Test']);
		fs.writeFileSync(path.join(tempDir, 'initial.txt'), 'initial');
		runGit(tempDir, ['add', '--', 'initial.txt']);
		runGit(tempDir, ['commit', '-m', 'initial']);
		process.chdir(tempDir);
	});

	afterEach(() => {
		process.chdir(originalCwd);
		closeAllProjectDbs();
		try {
			fs.rmSync(tempDir, { recursive: true, force: true });
		} catch {
			// Ignore cleanup errors.
		}
	});

	test('TF-004: rejects a missing task_id before any receipt work begins', async () => {
		const result = JSON.parse(
			await checkpoint.execute({
				action: 'save_task_completion',
			}),
		);

		expect(result.success).toBe(false);
		expect(result.error).toBe(
			'task_id is required for save_task_completion action',
		);
	});

	test('TF-004: rejects save_task_completion when no durable plan exists', async () => {
		const result = JSON.parse(
			await checkpoint.execute({
				action: 'save_task_completion',
				task_id: '1.1',
			}),
		);

		expect(result.success).toBe(false);
		expect(result.error).toContain(
			'no durable plan is available under .swarm/plan.json',
		);
	});

	test('TF-004: rejects save_task_completion when the task is missing from the current plan', async () => {
		await savePlan(tempDir, makePlan('completed', '2.1'), {
			preserveCompletedStatuses: false,
		});

		const result = JSON.parse(
			await checkpoint.execute({
				action: 'save_task_completion',
				task_id: '1.1',
			}),
		);

		expect(result.success).toBe(false);
		expect(result.error).toContain('task "1.1" was not found');
	});

	test('TF-004: rejects save_task_completion when the task is not completed', async () => {
		await savePlan(tempDir, makePlan('in_progress'), {
			preserveCompletedStatuses: false,
		});

		const result = JSON.parse(
			await checkpoint.execute({
				action: 'save_task_completion',
				task_id: '1.1',
			}),
		);

		expect(result.success).toBe(false);
		expect(result.error).toContain('task "1.1" is in_progress, not completed');
	});
});
