import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Plan } from '../../../src/config/plan-schema';
import {
	closeAllProjectDbs,
	getProjectDb,
} from '../../../src/db/project-db.js';
import { savePlan } from '../../../src/plan/manager.js';
import { derivePlanIdentityHash } from '../../../src/plan/utils.js';
import {
	checkpoint,
	_internals as checkpointInternals,
	saveCheckpointRecord,
} from '../../../src/tools/checkpoint.js';
import { freezeClock, type Restore } from '../../helpers/test-clock.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const GIT_TIMEOUT_MS = 30_000;
const GIT_MAX_BUFFER_BYTES = 5 * 1024 * 1024;

function makePlan(title: string): Plan {
	return {
		schema_version: '1.0.0',
		title,
		swarm: 'checkpoint-locking-swarm',
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

function setupGitRepo(directory: string): void {
	runGit(directory, ['init']);
	runGit(directory, ['config', '--local', 'commit.gpgsign', 'false']);
	runGit(directory, ['config', 'user.email', 'test@test.com']);
	runGit(directory, ['config', 'user.name', 'Test']);
	fs.writeFileSync(path.join(directory, 'initial.txt'), 'initial');
	runGit(directory, ['add', '--', 'initial.txt']);
	runGit(directory, ['commit', '-m', 'initial']);
}

describe('checkpoint locking and exact-subject helpers', () => {
	let tempDir: string;
	let originalCwd: string;
	let restoreClock: Restore | null = null;
	const originalInternals = {
		tryAcquireLock: checkpointInternals.tryAcquireLock,
		sleep: checkpointInternals.sleep,
		loadPlan: checkpointInternals.loadPlan,
		gitExec: checkpointInternals.gitExec,
		findCommitByExactSubject: checkpointInternals.findCommitByExactSubject,
		stageAllExcludingSwarm: checkpointInternals.stageAllExcludingSwarm,
	};

	beforeEach(async () => {
		restoreClock = freezeClock({
			fixedNow: 1_768_305_600_000,
			isoNow: '2026-08-01T00:00:00.000Z',
		});
		tempDir = canonicalMkdtemp('checkpoint-locking-');
		originalCwd = process.cwd();
		setupGitRepo(tempDir);
		process.chdir(tempDir);
		await savePlan(tempDir, makePlan('Locking Plan'), {
			preserveCompletedStatuses: false,
		});
		checkpointInternals.tryAcquireLock = originalInternals.tryAcquireLock;
		checkpointInternals.sleep = originalInternals.sleep;
		checkpointInternals.loadPlan = originalInternals.loadPlan;
		checkpointInternals.gitExec = originalInternals.gitExec;
		checkpointInternals.findCommitByExactSubject =
			originalInternals.findCommitByExactSubject;
		checkpointInternals.stageAllExcludingSwarm =
			originalInternals.stageAllExcludingSwarm;
	});

	afterEach(() => {
		restoreClock?.();
		restoreClock = null;
		process.chdir(originalCwd);
		checkpointInternals.tryAcquireLock = originalInternals.tryAcquireLock;
		checkpointInternals.sleep = originalInternals.sleep;
		checkpointInternals.loadPlan = originalInternals.loadPlan;
		checkpointInternals.gitExec = originalInternals.gitExec;
		checkpointInternals.findCommitByExactSubject =
			originalInternals.findCommitByExactSubject;
		checkpointInternals.stageAllExcludingSwarm =
			originalInternals.stageAllExcludingSwarm;
		closeAllProjectDbs();
		try {
			fs.rmSync(tempDir, { recursive: true, force: true });
		} catch {
			// Ignore cleanup errors.
		}
	});

	test('findCommitByExactSubject uses fixed-string bounded git log and rejects prefix matches', () => {
		const subject = 'checkpoint(task-complete abc plan def): 1.1';
		let capturedArgs: string[] | undefined;
		checkpointInternals.gitExec = mock((args: string[]) => {
			capturedArgs = args;
			return `aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\0${subject}-extra\nbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\0${subject}`;
		}) as unknown as typeof checkpointInternals.gitExec;

		const match = checkpointInternals.findCommitByExactSubject(
			tempDir,
			subject,
		);

		expect(match).toBe('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
		expect(capturedArgs).toEqual([
			'log',
			'HEAD',
			'--format=%H%x00%s',
			'--fixed-strings',
			`--grep=${subject}`,
			'-n',
			'25',
		]);
	});

	test('save returns checkpoint_busy after bounded lock exhaustion', async () => {
		let attempts = 0;
		checkpointInternals.tryAcquireLock = mock(async () => {
			attempts++;
			return { acquired: false };
		}) as unknown as typeof checkpointInternals.tryAcquireLock;
		checkpointInternals.sleep = mock(
			async () => {},
		) as typeof checkpointInternals.sleep;

		const result = JSON.parse(
			await checkpoint.execute({
				action: 'save',
				label: 'busy-save',
			}),
		);

		expect(result.success).toBe(false);
		expect(result.status).toBe('checkpoint_busy');
		expect(attempts).toBe(20);
	});

	test('save retries after one contended primitive attempt and then succeeds', async () => {
		let attempts = 0;
		const release = mock(async () => {});
		fs.writeFileSync(path.join(tempDir, 'retry-success.txt'), 'dirty');
		checkpointInternals.tryAcquireLock = mock(async () => {
			attempts++;
			if (attempts === 1) {
				return { acquired: false };
			}
			return {
				acquired: true,
				lock: {
					filePath: '.swarm/checkpoints.json',
					agent: 'checkpoint',
					taskId: 'save-retry-success',
					timestamp: new Date().toISOString(),
					expiresAt: Date.now() + 60_000,
					_release: release,
				},
			};
		}) as unknown as typeof checkpointInternals.tryAcquireLock;
		checkpointInternals.sleep = mock(
			async () => {},
		) as typeof checkpointInternals.sleep;

		const result = JSON.parse(
			await checkpoint.execute({
				action: 'save',
				label: 'retry-success',
			}),
		);

		expect(result.success).toBe(true);
		expect(result.label).toBe('retry-success');
		expect(attempts).toBe(2);
		expect(release).toHaveBeenCalledTimes(1);
	});

	test('save_task_completion still reports checkpoint_busy under permanent lock contention even with a logged receipt', async () => {
		const plan = makePlan('Locking Plan');
		const planIdentityHash = derivePlanIdentityHash(plan);
		getProjectDb(tempDir).run(
			'INSERT INTO task_checkpoint_receipt (plan_identity_hash, task_id, label, state, sha) VALUES (?, ?, ?, ?, ?)',
			[
				planIdentityHash,
				'1.1',
				'task-1.1-complete-existing',
				'logged',
				runGit(tempDir, ['rev-parse', 'HEAD']).trim(),
			],
		);
		checkpointInternals.tryAcquireLock = mock(async () => {
			return { acquired: false };
		}) as unknown as typeof checkpointInternals.tryAcquireLock;

		const result = JSON.parse(
			await checkpoint.execute({
				action: 'save_task_completion',
				task_id: '1.1',
			}),
		);

		expect(result.success).toBe(false);
		expect(result.status).toBe('checkpoint_busy');
	});

	test('releases the mutation lock when save_task_completion fails after acquisition', async () => {
		const planRelease = mock(async () => {});
		const checkpointRelease = mock(async () => {});
		let acquireCount = 0;
		checkpointInternals.tryAcquireLock = mock(async () => {
			acquireCount++;
			const release = acquireCount === 1 ? planRelease : checkpointRelease;
			return {
				acquired: true,
				lock: {
					filePath: '.swarm/checkpoints.json',
					agent: 'checkpoint',
					taskId: 'save-task-completion',
					timestamp: new Date().toISOString(),
					expiresAt: Date.now() + 60_000,
					_release: release,
				},
			};
		}) as unknown as typeof checkpointInternals.tryAcquireLock;
		const realGitExec = checkpointInternals.gitExec;
		checkpointInternals.gitExec = mock((args: string[], cwd: string) => {
			if (args[0] === 'commit') {
				throw new Error('forced commit failure');
			}
			return realGitExec(args, cwd);
		}) as unknown as typeof checkpointInternals.gitExec;
		checkpointInternals.findCommitByExactSubject = mock(
			() => null,
		) as unknown as typeof checkpointInternals.findCommitByExactSubject;

		const result = JSON.parse(
			await checkpoint.execute({
				action: 'save_task_completion',
				task_id: '1.1',
			}),
		);

		expect(result.success).toBe(false);
		expect(result.error).toContain('forced commit failure');
		expect(planRelease).toHaveBeenCalledTimes(1);
		expect(checkpointRelease).toHaveBeenCalledTimes(1);
	});

	test('save_task_completion commit path does not pass --no-verify', async () => {
		const realGitExec = checkpointInternals.gitExec;
		const commitArgs: string[][] = [];
		fs.writeFileSync(path.join(tempDir, 'commit-target.txt'), 'changed');
		checkpointInternals.gitExec = mock((args: string[], cwd: string) => {
			if (args[0] === 'commit') {
				commitArgs.push(args);
			}
			return realGitExec(args, cwd);
		}) as unknown as typeof checkpointInternals.gitExec;

		const result = JSON.parse(
			await checkpoint.execute({
				action: 'save_task_completion',
				task_id: '1.1',
			}),
		);

		expect(result.success).toBe(true);
		expect(commitArgs).toHaveLength(1);
		expect(commitArgs[0]).toContain('--allow-empty');
		expect(commitArgs[0]).not.toContain('--no-verify');
	});

	test('CS-003: revalidates task completion eligibility after waiting on the plan lock', async () => {
		const reopenedPlan = makePlan('Locking Plan');
		reopenedPlan.phases[0].status = 'in_progress';
		reopenedPlan.phases[0].tasks[0].status = 'in_progress';

		let releasePlanLockGate!: () => void;
		const planLockGate = new Promise<void>((resolve) => {
			releasePlanLockGate = resolve;
		});
		let gated = false;
		checkpointInternals.tryAcquireLock = mock(
			async (
				directory: string,
				filePath: string,
				agent: string,
				taskId: string,
			) => {
				if (!gated && filePath === 'plan.json') {
					gated = true;
					await planLockGate;
				}
				return originalInternals.tryAcquireLock(
					directory,
					filePath,
					agent,
					taskId,
				);
			},
		) as unknown as typeof checkpointInternals.tryAcquireLock;

		const pending = checkpoint.execute({
			action: 'save_task_completion',
			task_id: '1.1',
		});
		await savePlan(tempDir, reopenedPlan, {
			preserveCompletedStatuses: false,
		});
		releasePlanLockGate();

		const result = JSON.parse(await pending);

		expect(result.success).toBe(false);
		expect(result.error).toContain('is in_progress, not completed');
	});

	test('TF-003: real concurrent callers serialize through the plan and checkpoint locks', async () => {
		let releaseFirstLoad!: () => void;
		const firstLoadGate = new Promise<void>((resolve) => {
			releaseFirstLoad = resolve;
		});
		let signalFirstLoadEntered!: () => void;
		const firstLoadEntered = new Promise<void>((resolve) => {
			signalFirstLoadEntered = resolve;
		});
		let firstLoadPending = true;
		checkpointInternals.loadPlan = mock(async (directory: string) => {
			const plan = await originalInternals.loadPlan(directory);
			if (firstLoadPending) {
				firstLoadPending = false;
				signalFirstLoadEntered();
				await firstLoadGate;
			}
			return plan;
		}) as unknown as typeof checkpointInternals.loadPlan;

		const first = checkpoint.execute({
			action: 'save_task_completion',
			task_id: '1.1',
		});
		await firstLoadEntered;
		const second = checkpoint.execute({
			action: 'save_task_completion',
			task_id: '1.1',
		});
		releaseFirstLoad();

		const [firstResult, secondResult] = (
			await Promise.all([first, second])
		).map((result) => JSON.parse(result));

		expect(firstResult.success).toBe(true);
		expect(secondResult.success).toBe(true);
		expect(secondResult.idempotent).toBe(true);
		expect(secondResult.sha).toBe(firstResult.sha);

		const log = JSON.parse(
			fs.readFileSync(
				path.join(tempDir, '.swarm', 'checkpoints.json'),
				'utf-8',
			),
		);
		expect(log.checkpoints).toHaveLength(1);
		expect(log.checkpoints[0].sha).toBe(firstResult.sha);
	});

	test('saveCheckpointRecord uses the shared lock path and reports busy contention', async () => {
		let attempts = 0;
		checkpointInternals.tryAcquireLock = mock(async () => {
			attempts++;
			return { acquired: false };
		}) as unknown as typeof checkpointInternals.tryAcquireLock;
		checkpointInternals.sleep = mock(
			async () => {},
		) as typeof checkpointInternals.sleep;

		const result = await saveCheckpointRecord('spiral-lock-test', tempDir);

		expect(result.success).toBe(false);
		expect(result.error).toContain('checkpoint_busy');
		expect(attempts).toBe(20);
	});

	test.each([
		['restore', { action: 'restore', label: 'missing-under-lock' }],
		['delete', { action: 'delete', label: 'missing-under-lock' }],
	] as const)('%s returns checkpoint_busy under the shared mutation lock', async (_action, args) => {
		let attempts = 0;
		checkpointInternals.tryAcquireLock = mock(async () => {
			attempts++;
			return { acquired: false };
		}) as unknown as typeof checkpointInternals.tryAcquireLock;
		checkpointInternals.sleep = mock(
			async () => {},
		) as typeof checkpointInternals.sleep;

		const result = JSON.parse(await checkpoint.execute(args));

		expect(result.success).toBe(false);
		expect(result.status).toBe('checkpoint_busy');
		expect(attempts).toBe(20);
	});
});
