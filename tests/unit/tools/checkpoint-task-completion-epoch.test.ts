import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Plan, TaskStatus } from '../../../src/config/plan-schema';
import {
	closeAllProjectDbs,
	getProjectDb,
} from '../../../src/db/project-db.js';
import { readLedgerEvents } from '../../../src/plan/ledger.js';
import { savePlan } from '../../../src/plan/manager.js';
import { derivePlanIdentityHash } from '../../../src/plan/utils.js';
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

function makePlan(status: TaskStatus): Plan {
	return {
		schema_version: '1.0.0',
		title: 'Completion Epoch Plan',
		swarm: 'checkpoint-swarm',
		current_phase: 1,
		phases: [
			{
				id: 1,
				name: 'Phase 1',
				status: status === 'completed' ? 'complete' : 'in_progress',
				tasks: [
					{
						id: '1.1',
						phase: 1,
						status,
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

describe('checkpoint completion ledger epoch reconciliation', () => {
	let tempDir: string;
	let originalCwd: string;

	beforeEach(() => {
		tempDir = canonicalMkdtemp('checkpoint-completion-epoch-');
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

	test('IA-001: ledger epoch repairs missed reopen and recomplete lifecycle sync', async () => {
		const completedPlan = makePlan('completed');
		await savePlan(tempDir, completedPlan, {
			preserveCompletedStatuses: false,
		});
		const first = JSON.parse(
			await checkpoint.execute({
				action: 'save_task_completion',
				task_id: '1.1',
			}),
		);
		expect(first.success).toBe(true);

		const planIdentityHash = derivePlanIdentityHash(completedPlan);
		const db = getProjectDb(tempDir);
		const originalReceipt = db
			.query<
				{
					label: string;
					state: string;
					sha: string;
					generation: number;
					completion_active: number;
					completion_ledger_seq: number;
				},
				[string, string]
			>(
				`SELECT label, state, sha, generation, completion_active,
					completion_ledger_seq
				 FROM task_checkpoint_receipt
				 WHERE plan_identity_hash = ? AND task_id = ?`,
			)
			.get(planIdentityHash, '1.1');
		expect(originalReceipt?.state).toBe('logged');

		const restoreStaleReceipt = () => {
			if (!originalReceipt) throw new Error('missing original receipt');
			db.run(
				`UPDATE task_checkpoint_receipt
				 SET label = ?, state = ?, sha = ?, generation = ?,
					completion_active = ?, completion_ledger_seq = ?
				 WHERE plan_identity_hash = ? AND task_id = ?`,
				[
					originalReceipt.label,
					originalReceipt.state,
					originalReceipt.sha,
					originalReceipt.generation,
					originalReceipt.completion_active,
					originalReceipt.completion_ledger_seq,
					planIdentityHash,
					'1.1',
				],
			);
		};

		await savePlan(tempDir, makePlan('pending'), {
			preserveCompletedStatuses: false,
		});
		// Fault injection: the authoritative reopen reached the ledger, but the
		// advisory SQLite lifecycle update was lost in a crash.
		restoreStaleReceipt();
		await savePlan(tempDir, completedPlan, {
			preserveCompletedStatuses: false,
		});
		// Fault injection: the recompletion reached the ledger, but its lifecycle
		// repair was also lost. The old logged row must not suppress this epoch.
		restoreStaleReceipt();

		const events = await readLedgerEvents(tempDir);
		const latestCompletionSeq = [...events]
			.reverse()
			.find(
				(event) =>
					event.event_type === 'task_status_changed' &&
					event.task_id === '1.1' &&
					event.to_status === 'completed',
			)?.seq;
		expect(latestCompletionSeq).toBeNumber();
		expect(latestCompletionSeq).not.toBe(
			originalReceipt?.completion_ledger_seq,
		);

		const countBefore = Number(
			runGit(tempDir, ['rev-list', '--count', 'HEAD']).trim(),
		);
		const repaired = JSON.parse(
			await checkpoint.execute({
				action: 'save_task_completion',
				task_id: '1.1',
			}),
		);
		const countAfter = Number(
			runGit(tempDir, ['rev-list', '--count', 'HEAD']).trim(),
		);

		expect(repaired.success).toBe(true);
		expect(repaired.idempotent).not.toBe(true);
		expect(repaired.label).not.toBe(first.label);
		expect(countAfter).toBe(countBefore + 1);
		const repairedReceipt = db
			.query<
				{
					state: string;
					generation: number;
					completion_ledger_seq: number;
				},
				[string, string]
			>(
				`SELECT state, generation, completion_ledger_seq
				 FROM task_checkpoint_receipt
				 WHERE plan_identity_hash = ? AND task_id = ?`,
			)
			.get(planIdentityHash, '1.1');
		expect(repairedReceipt).toEqual({
			state: 'logged',
			generation: (originalReceipt?.generation ?? 0) + 1,
			completion_ledger_seq: latestCompletionSeq,
		});

		const retry = JSON.parse(
			await checkpoint.execute({
				action: 'save_task_completion',
				task_id: '1.1',
			}),
		);
		expect(retry.idempotent).toBe(true);
		expect(
			Number(runGit(tempDir, ['rev-list', '--count', 'HEAD']).trim()),
		).toBe(countAfter);
	});

	test('IA-001: migrated logged receipt binds its epoch without duplicating a checkpoint', async () => {
		const completedPlan = makePlan('completed');
		await savePlan(tempDir, completedPlan, {
			preserveCompletedStatuses: false,
		});
		const first = JSON.parse(
			await checkpoint.execute({
				action: 'save_task_completion',
				task_id: '1.1',
			}),
		);
		expect(first.success).toBe(true);

		const planIdentityHash = derivePlanIdentityHash(completedPlan);
		const db = getProjectDb(tempDir);
		// v13 migration intentionally leaves existing v12 rows unbound. The first
		// retry binds the durable epoch without invalidating a completed receipt.
		db.run(
			`UPDATE task_checkpoint_receipt
			 SET completion_ledger_seq = NULL
			 WHERE plan_identity_hash = ? AND task_id = ?`,
			[planIdentityHash, '1.1'],
		);
		const countBefore = Number(
			runGit(tempDir, ['rev-list', '--count', 'HEAD']).trim(),
		);

		const retry = JSON.parse(
			await checkpoint.execute({
				action: 'save_task_completion',
				task_id: '1.1',
			}),
		);

		expect(retry.success).toBe(true);
		expect(retry.idempotent).toBe(true);
		expect(retry.label).toBe(first.label);
		expect(
			Number(runGit(tempDir, ['rev-list', '--count', 'HEAD']).trim()),
		).toBe(countBefore);
		const receipt = db
			.query<
				{ state: string; completion_ledger_seq: number | null },
				[string, string]
			>(
				`SELECT state, completion_ledger_seq
				 FROM task_checkpoint_receipt
				 WHERE plan_identity_hash = ? AND task_id = ?`,
			)
			.get(planIdentityHash, '1.1');
		expect(receipt?.state).toBe('logged');
		expect(receipt?.completion_ledger_seq).toBe(1);
	});
});
