import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Plan } from '../../../src/config/plan-schema';
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

function makeCompletedPlan(): Plan {
	return {
		schema_version: '1.0.0',
		title: 'Staged Swarm Isolation Plan',
		swarm: 'checkpoint-swarm',
		current_phase: 1,
		phases: [
			{
				id: 1,
				name: 'Phase 1',
				status: 'complete',
				tasks: [
					{
						id: '1.1',
						phase: 1,
						status: 'completed',
						size: 'small',
						description: 'Task 1.1',
						depends: [],
						files_touched: [],
					},
				],
			},
		],
		migration_status: 'native',
	};
}

describe('checkpoint save_task_completion - pre-staged .swarm state is isolated', () => {
	let tempDir: string;
	let originalCwd: string;

	beforeEach(() => {
		tempDir = canonicalMkdtemp('checkpoint-staged-swarm-');
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
			// Ignore cleanup errors for a fully resolved system-temp child.
		}
	});

	test('excludes the staged runtime file, preserves its exact index entry, and commits non-swarm work', async () => {
		// Previous code only excluded .swarm from `git add`; an already-staged
		// runtime file remained in the index and leaked into the checkpoint commit.
		await savePlan(tempDir, makeCompletedPlan(), {
			preserveCompletedStatuses: false,
		});
		const runtimePath = path.join(tempDir, '.swarm', 'runtime.json');
		const runtimeContents = '{"private":"runtime-state"}\n';
		fs.writeFileSync(runtimePath, runtimeContents);
		runGit(tempDir, ['add', '--force', '--', '.swarm/runtime.json']);

		fs.writeFileSync(
			path.join(tempDir, 'already-staged.txt'),
			'staged user work',
		);
		runGit(tempDir, ['add', '--', 'already-staged.txt']);
		fs.writeFileSync(path.join(tempDir, 'task-output.txt'), 'task output');

		const result = JSON.parse(
			await checkpoint.execute({
				action: 'save_task_completion',
				task_id: '1.1',
			}),
		);
		expect(result.success).toBe(true);

		const committedFiles = runGit(tempDir, [
			'show',
			'--name-only',
			'--format=',
			'HEAD',
		]);
		expect(committedFiles).toContain('already-staged.txt');
		expect(committedFiles).toContain('task-output.txt');
		expect(committedFiles).not.toContain('.swarm/runtime.json');

		const stagedFiles = runGit(tempDir, ['diff', '--cached', '--name-only']);
		expect(stagedFiles.trim()).toBe('.swarm/runtime.json');
		expect(runGit(tempDir, ['show', ':.swarm/runtime.json'])).toBe(
			runtimeContents,
		);
		expect(fs.readFileSync(runtimePath, 'utf-8')).toBe(runtimeContents);
	});
});
