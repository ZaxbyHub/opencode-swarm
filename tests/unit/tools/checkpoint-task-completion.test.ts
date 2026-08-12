import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Plan } from '../../../src/config/plan-schema';
import {
	closeAllProjectDbs,
	getProjectDb,
} from '../../../src/db/project-db.js';
import { savePlan } from '../../../src/plan/manager.js';
import { derivePlanIdentityHash } from '../../../src/plan/utils.js';
import { checkpoint } from '../../../src/tools/checkpoint.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

function makePlan(title: string, taskId = '1.1'): Plan {
	return {
		schema_version: '1.0.0',
		title,
		swarm: 'checkpoint-swarm',
		current_phase: 1,
		phases: [
			{
				id: 1,
				name: 'Phase 1',
				status: 'complete',
				tasks: [
					{
						id: taskId,
						phase: 1,
						status: 'completed',
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

function setupGitRepo(directory: string): void {
	execSync('git init', { cwd: directory, encoding: 'utf-8' });
	execSync('git config --local commit.gpgsign false', {
		cwd: directory,
		encoding: 'utf-8',
	});
	execSync('git config user.email "test@test.com"', {
		cwd: directory,
		encoding: 'utf-8',
	});
	execSync('git config user.name "Test"', {
		cwd: directory,
		encoding: 'utf-8',
	});
	fs.writeFileSync(path.join(directory, 'initial.txt'), 'initial');
	execSync('git add .', { cwd: directory, encoding: 'utf-8' });
	execSync('git commit -m "initial"', { cwd: directory, encoding: 'utf-8' });
}

function descriptorFor(plan: Plan, taskId: string) {
	const planIdentityHash = derivePlanIdentityHash(plan);
	const suffix = createHash('sha256')
		.update(JSON.stringify([planIdentityHash, taskId]), 'utf8')
		.digest('hex')
		.slice(0, 16);
	return {
		planIdentityHash,
		label: `task-${taskId}-complete-${suffix}`,
		subject: `checkpoint(task-complete ${suffix} plan ${planIdentityHash}): ${taskId}`,
	};
}

describe('checkpoint save_task_completion', () => {
	let tempDir: string;
	let originalCwd: string;

	beforeEach(() => {
		tempDir = canonicalMkdtemp('checkpoint-task-complete-');
		originalCwd = process.cwd();
		setupGitRepo(tempDir);
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

	test('creates a plan-scoped receipt, commit, and checkpoint log entry', async () => {
		const plan = makePlan('Task Completion Plan');
		await savePlan(tempDir, plan, { preserveCompletedStatuses: false });
		fs.writeFileSync(path.join(tempDir, 'task-file.txt'), 'task change');

		const headBefore = execSync('git rev-parse HEAD', {
			cwd: tempDir,
			encoding: 'utf-8',
		}).trim();
		const result = JSON.parse(
			await checkpoint.execute({
				action: 'save_task_completion',
				task_id: '1.1',
			}),
		);
		const headAfter = execSync('git rev-parse HEAD', {
			cwd: tempDir,
			encoding: 'utf-8',
		}).trim();

		expect(result.success).toBe(true);
		expect(result.receipt_state).toBe('logged');
		expect(headAfter).not.toBe(headBefore);
		const committedFiles = execSync('git show --name-only --format="" HEAD', {
			cwd: tempDir,
			encoding: 'utf-8',
		});
		expect(committedFiles).toContain('task-file.txt');
		expect(committedFiles).not.toContain('.swarm');

		const { planIdentityHash } = descriptorFor(plan, '1.1');
		const receipt = getProjectDb(tempDir)
			.query<
				{
					state: string;
					label: string;
					sha: string;
				},
				[string, string]
			>(
				'SELECT state, label, sha FROM task_checkpoint_receipt WHERE plan_identity_hash = ? AND task_id = ?',
			)
			.get(planIdentityHash, '1.1');
		expect(receipt).toBeDefined();
		expect(receipt?.state).toBe('logged');
		expect(receipt?.label).toBe(result.label);
		expect(receipt?.sha).toBe(headAfter);

		const log = JSON.parse(
			fs.readFileSync(
				path.join(tempDir, '.swarm', 'checkpoints.json'),
				'utf-8',
			),
		);
		expect(log.checkpoints).toContainEqual({
			label: result.label,
			sha: headAfter,
			timestamp: log.checkpoints.find(
				(entry: { label: string }) => entry.label === result.label,
			).timestamp,
		});
	});

	test('logged receipts stay idempotent even after the checkpoint log entry is removed', async () => {
		const plan = makePlan('Retention Independence Plan');
		await savePlan(tempDir, plan, { preserveCompletedStatuses: false });

		const first = JSON.parse(
			await checkpoint.execute({
				action: 'save_task_completion',
				task_id: '1.1',
			}),
		);
		expect(first.success).toBe(true);

		fs.writeFileSync(
			path.join(tempDir, '.swarm', 'checkpoints.json'),
			JSON.stringify({ version: 1, checkpoints: [] }, null, 2),
			'utf-8',
		);

		const second = JSON.parse(
			await checkpoint.execute({
				action: 'save_task_completion',
				task_id: '1.1',
			}),
		);
		expect(second.success).toBe(true);
		expect(second.idempotent).toBe(true);

		const log = JSON.parse(
			fs.readFileSync(
				path.join(tempDir, '.swarm', 'checkpoints.json'),
				'utf-8',
			),
		);
		expect(log.checkpoints).toEqual([]);
	});

	test('pending receipts reconcile forward from an existing exact-subject commit without creating a second commit', async () => {
		const plan = makePlan('Pending Receipt Recovery Plan');
		await savePlan(tempDir, plan, { preserveCompletedStatuses: false });

		const descriptor = descriptorFor(plan, '1.1');
		execSync(`git commit --allow-empty -m "${descriptor.subject}"`, {
			cwd: tempDir,
			encoding: 'utf-8',
		});
		const existingSha = execSync('git rev-parse HEAD', {
			cwd: tempDir,
			encoding: 'utf-8',
		}).trim();
		getProjectDb(tempDir).run(
			'INSERT INTO task_checkpoint_receipt (plan_identity_hash, task_id, label, state, sha) VALUES (?, ?, ?, ?, NULL)',
			[descriptor.planIdentityHash, '1.1', descriptor.label, 'pending'],
		);

		const countBefore = execSync('git rev-list --count HEAD', {
			cwd: tempDir,
			encoding: 'utf-8',
		}).trim();
		const result = JSON.parse(
			await checkpoint.execute({
				action: 'save_task_completion',
				task_id: '1.1',
			}),
		);
		const countAfter = execSync('git rev-list --count HEAD', {
			cwd: tempDir,
			encoding: 'utf-8',
		}).trim();

		expect(result.success).toBe(true);
		expect(countAfter).toBe(countBefore);
		expect(result.sha).toBe(existingSha);

		const receipt = getProjectDb(tempDir)
			.query<{ state: string; sha: string }, [string, string]>(
				'SELECT state, sha FROM task_checkpoint_receipt WHERE plan_identity_hash = ? AND task_id = ?',
			)
			.get(descriptor.planIdentityHash, '1.1');
		expect(receipt).toEqual({ state: 'logged', sha: existingSha });
	});

	test('committed receipts with no checkpoint log reconcile without creating a second commit', async () => {
		const plan = makePlan('Committed Receipt No Log Plan');
		await savePlan(tempDir, plan, { preserveCompletedStatuses: false });

		const descriptor = descriptorFor(plan, '1.1');
		execSync(`git commit --allow-empty -m "${descriptor.subject}"`, {
			cwd: tempDir,
			encoding: 'utf-8',
		});
		const committedSha = execSync('git rev-parse HEAD', {
			cwd: tempDir,
			encoding: 'utf-8',
		}).trim();
		getProjectDb(tempDir).run(
			'INSERT INTO task_checkpoint_receipt (plan_identity_hash, task_id, label, state, sha) VALUES (?, ?, ?, ?, ?)',
			[
				descriptor.planIdentityHash,
				'1.1',
				descriptor.label,
				'committed',
				committedSha,
			],
		);
		fs.writeFileSync(
			path.join(tempDir, '.swarm', 'checkpoints.json'),
			JSON.stringify({ version: 1, checkpoints: [] }, null, 2),
			'utf-8',
		);

		const countBefore = execSync('git rev-list --count HEAD', {
			cwd: tempDir,
			encoding: 'utf-8',
		}).trim();
		const result = JSON.parse(
			await checkpoint.execute({
				action: 'save_task_completion',
				task_id: '1.1',
			}),
		);
		const countAfter = execSync('git rev-list --count HEAD', {
			cwd: tempDir,
			encoding: 'utf-8',
		}).trim();

		expect(result.success).toBe(true);
		expect(result.sha).toBe(committedSha);
		expect(result.receipt_state).toBe('logged');
		expect(countAfter).toBe(countBefore);

		const log = JSON.parse(
			fs.readFileSync(
				path.join(tempDir, '.swarm', 'checkpoints.json'),
				'utf-8',
			),
		);
		expect(log.checkpoints).toEqual([
			{
				label: descriptor.label,
				sha: committedSha,
				timestamp: log.checkpoints[0].timestamp,
			},
		]);
	});

	test('committed receipts with an existing checkpoint log advance to logged without duplicating the log entry', async () => {
		const plan = makePlan('Committed Receipt Existing Log Plan');
		await savePlan(tempDir, plan, { preserveCompletedStatuses: false });

		const descriptor = descriptorFor(plan, '1.1');
		execSync(`git commit --allow-empty -m "${descriptor.subject}"`, {
			cwd: tempDir,
			encoding: 'utf-8',
		});
		const committedSha = execSync('git rev-parse HEAD', {
			cwd: tempDir,
			encoding: 'utf-8',
		}).trim();
		getProjectDb(tempDir).run(
			'INSERT INTO task_checkpoint_receipt (plan_identity_hash, task_id, label, state, sha) VALUES (?, ?, ?, ?, ?)',
			[
				descriptor.planIdentityHash,
				'1.1',
				descriptor.label,
				'committed',
				committedSha,
			],
		);
		const existingTimestamp = '2026-08-12T00:00:00.000Z';
		fs.writeFileSync(
			path.join(tempDir, '.swarm', 'checkpoints.json'),
			JSON.stringify(
				{
					version: 1,
					checkpoints: [
						{
							label: descriptor.label,
							sha: committedSha,
							timestamp: existingTimestamp,
						},
					],
				},
				null,
				2,
			),
			'utf-8',
		);

		const countBefore = execSync('git rev-list --count HEAD', {
			cwd: tempDir,
			encoding: 'utf-8',
		}).trim();
		const result = JSON.parse(
			await checkpoint.execute({
				action: 'save_task_completion',
				task_id: '1.1',
			}),
		);
		const countAfter = execSync('git rev-list --count HEAD', {
			cwd: tempDir,
			encoding: 'utf-8',
		}).trim();

		expect(result.success).toBe(true);
		expect(result.sha).toBe(committedSha);
		expect(result.receipt_state).toBe('logged');
		expect(countAfter).toBe(countBefore);

		const log = JSON.parse(
			fs.readFileSync(
				path.join(tempDir, '.swarm', 'checkpoints.json'),
				'utf-8',
			),
		);
		expect(log.checkpoints).toEqual([
			{
				label: descriptor.label,
				sha: committedSha,
				timestamp: existingTimestamp,
			},
		]);
	});

	test('same task id under different plan identities stores separate receipts', async () => {
		const planA = makePlan('Cross Plan A');
		await savePlan(tempDir, planA, { preserveCompletedStatuses: false });
		const first = JSON.parse(
			await checkpoint.execute({
				action: 'save_task_completion',
				task_id: '1.1',
			}),
		);
		expect(first.success).toBe(true);

		const planB = makePlan('Cross Plan B');
		await savePlan(tempDir, planB, { preserveCompletedStatuses: false });
		const second = JSON.parse(
			await checkpoint.execute({
				action: 'save_task_completion',
				task_id: '1.1',
			}),
		);
		expect(second.success).toBe(true);

		const rows = getProjectDb(tempDir)
			.query<
				{
					plan_identity_hash: string;
					task_id: string;
					label: string;
				},
				[]
			>(
				'SELECT plan_identity_hash, task_id, label FROM task_checkpoint_receipt ORDER BY created_at',
			)
			.all();
		expect(rows).toHaveLength(2);
		expect(new Set(rows.map((row) => row.plan_identity_hash)).size).toBe(2);
		expect(rows.map((row) => row.task_id)).toEqual(['1.1', '1.1']);
	});
});
