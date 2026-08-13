import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Plan } from '../../../src/config/plan-schema';
import {
	closeAllProjectDbs,
	getProjectDb,
} from '../../../src/db/project-db.js';
import { savePlan, updateTaskStatus } from '../../../src/plan/manager.js';
import { derivePlanIdentityHash } from '../../../src/plan/utils.js';
import { checkpoint } from '../../../src/tools/checkpoint.js';
import { executeSavePlan } from '../../../src/tools/save-plan.js';
import { executeSetQaGates } from '../../../src/tools/set-qa-gates.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

function runGit(directory: string, args: string[]): string {
	const result = childProcess.spawnSync('git', args, {
		cwd: directory,
		encoding: 'utf-8',
		timeout: 30_000,
		stdio: ['ignore', 'pipe', 'pipe'],
		windowsHide: true,
		maxBuffer: 5 * 1024 * 1024,
	});
	if (result.error) throw result.error;
	if (result.status !== 0) {
		throw new Error(result.stderr?.trim() || `git exited ${result.status}`);
	}
	return result.stdout ?? '';
}

function makePlan(status: 'pending' | 'completed'): Plan {
	return {
		schema_version: '1.0.0',
		title: 'Completion Epoch Plan',
		swarm: 'checkpoint-swarm',
		current_phase: 1,
		phases: [
			{
				id: 1,
				name: 'Phase 1',
				status: status === 'completed' ? 'complete' : 'pending',
				tasks: [
					{
						id: '1.1',
						phase: 1,
						status,
						size: 'small',
						description: 'Finish the epoch work',
						depends: [],
						files_touched: [],
					},
				],
			},
		],
		migration_status: 'native',
	};
}

async function saveCompletion(): Promise<Record<string, unknown>> {
	return JSON.parse(
		await checkpoint.execute({
			action: 'save_task_completion',
			task_id: '1.1',
		}),
	);
}

describe('task checkpoint completion epochs', () => {
	let tempDir: string;
	let originalCwd: string;

	beforeEach(() => {
		tempDir = canonicalMkdtemp('checkpoint-epoch-');
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
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	test('reopen/recomplete and reset_statuses each create a distinct recoverable epoch', async () => {
		const completed = makePlan('completed');
		await savePlan(tempDir, completed, { preserveCompletedStatuses: false });
		const first = await saveCompletion();
		expect(first.success).toBe(true);

		await updateTaskStatus(tempDir, '1.1', 'in_progress', { force: true });
		await updateTaskStatus(tempDir, '1.1', 'completed');
		const countBeforeSecond = Number(
			runGit(tempDir, ['rev-list', '--count', 'HEAD']).trim(),
		);
		const second = await saveCompletion();
		expect(second.success).toBe(true);
		expect(second.idempotent).not.toBe(true);
		expect(second.label).not.toBe(first.label);
		expect(second.sha).not.toBe(first.sha);
		expect(
			Number(runGit(tempDir, ['rev-list', '--count', 'HEAD']).trim()),
		).toBe(countBeforeSecond + 1);

		fs.writeFileSync(
			path.join(tempDir, '.swarm', 'spec.md'),
			'# Completion Epoch Spec\n',
		);
		const gates = await executeSetQaGates(
			{
				swarm_id: completed.swarm,
				plan_title: completed.title,
				reviewer: true,
			},
			tempDir,
		);
		expect(gates.success).toBe(true);
		const reset = await executeSavePlan(
			{
				title: completed.title,
				swarm_id: completed.swarm,
				working_directory: tempDir,
				reset_statuses: true,
				confirm_requirement_coverage_gaps: true,
				phases: [
					{
						id: 1,
						name: 'Phase 1',
						tasks: [
							{
								id: '1.1',
								description: 'Finish the epoch work',
							},
						],
					},
				],
			},
			tempDir,
		);
		if (!reset.success) {
			throw new Error(`reset_statuses failed: ${JSON.stringify(reset)}`);
		}
		await updateTaskStatus(tempDir, '1.1', 'completed');
		const third = await saveCompletion();
		expect(third.success).toBe(true);
		expect(third.label).not.toBe(second.label);
		expect(third.sha).not.toBe(second.sha);

		const receipt = getProjectDb(tempDir)
			.query<
				{
					generation: number;
					completion_active: number;
					state: string;
				},
				[string, string]
			>(
				`SELECT generation, completion_active, state
				 FROM task_checkpoint_receipt
				 WHERE plan_identity_hash = ? AND task_id = ?`,
			)
			.get(derivePlanIdentityHash(completed), '1.1');
		expect(receipt).toEqual({
			generation: 3,
			completion_active: 1,
			state: 'logged',
		});
	});
});
