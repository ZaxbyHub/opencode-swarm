import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Plan } from '../config/plan-schema';
import {
	_internals as mergeStatus,
	recordWorktreeMergeFailure,
} from '../hooks/delegation-gate/worktree-merge-status';
import {
	_internals,
	loadPlanJsonOnly,
	savePlan,
	updateTaskStatus,
} from './manager';

/**
 * Tests for the Epic Mode Rule 2 worktree-isolation guard: when a
 * Task-dispatched coder's worktree merge-back failed, completing the task
 * must NOT fire the `swarm(task <id>):` marker commit (which would give
 * Rule 3 false evidence that the task's work landed in the main tree).
 */
function makePlan(): Plan {
	return {
		schema_version: '1.0.0',
		title: 'Rule 2 Guard Test Plan',
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
						status: 'in_progress',
						size: 'small',
						description: 'Guarded task',
						depends: [],
						files_touched: [],
					},
				],
			},
		],
		migration_status: 'native',
	};
}

describe('updateTaskStatus — Rule 2 worktree merge-back guard', () => {
	let tempDir: string;
	// Save originals to restore the module seam after each test.
	const orig = {
		isGitRepo: _internals.isGitRepo,
		isEpicModeActiveForProject: _internals.isEpicModeActiveForProject,
		readTaskScopes: _internals.readTaskScopes,
		commitTaskCompletion: _internals.commitTaskCompletion,
	};
	let commitCalls: string[];

	beforeEach(async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rule2-guard-'));
		fs.mkdirSync(path.join(tempDir, '.swarm'), { recursive: true });
		await savePlan(tempDir, makePlan());

		commitCalls = [];
		// Force the Rule 2 preconditions on (git repo + Epic active) and stub
		// the commit so we can observe whether it fires.
		_internals.isGitRepo = () => true;
		_internals.isEpicModeActiveForProject = () => true;
		_internals.readTaskScopes = () => undefined;
		_internals.commitTaskCompletion = async (_dir, taskId) => {
			commitCalls.push(taskId);
		};
		mergeStatus.failuresByTask.clear();
	});

	afterEach(() => {
		_internals.isGitRepo = orig.isGitRepo;
		_internals.isEpicModeActiveForProject = orig.isEpicModeActiveForProject;
		_internals.readTaskScopes = orig.readTaskScopes;
		_internals.commitTaskCompletion = orig.commitTaskCompletion;
		mergeStatus.failuresByTask.clear();
		if (fs.existsSync(tempDir)) {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it('fires Rule 2 commit when no worktree merge failure is recorded', async () => {
		await updateTaskStatus(tempDir, '1.1', 'completed');
		expect(commitCalls).toEqual(['1.1']);
	});

	it('SKIPS Rule 2 commit when the task worktree merge-back FAILED', async () => {
		recordWorktreeMergeFailure('1.1', {
			outcome: 'failed',
			stage: 'merge',
			message: 'conflict',
		});
		await updateTaskStatus(tempDir, '1.1', 'completed');
		expect(commitCalls).toEqual([]); // no marker written
	});

	it('SKIPS Rule 2 commit when the task worktree merge-back was PARTIAL', async () => {
		recordWorktreeMergeFailure('1.1', {
			outcome: 'partial',
			stage: 'rebase',
			message: 'partial apply',
		});
		await updateTaskStatus(tempDir, '1.1', 'completed');
		expect(commitCalls).toEqual([]);
	});

	it('still persists the task status update even when the commit is skipped', async () => {
		recordWorktreeMergeFailure('1.1', {
			outcome: 'failed',
			stage: 'merge',
			message: 'conflict',
		});
		const updated = await updateTaskStatus(tempDir, '1.1', 'completed');
		// Plan ledger is authoritative: the status advance must still happen.
		const task = updated.phases[0].tasks.find((t) => t.id === '1.1');
		expect(task?.status).toBe('completed');
		// And the marker was NOT written (guard skipped it).
		expect(commitCalls).toEqual([]);
		// Durability: re-load from disk to prove the LEDGER persisted the
		// status, not merely the in-memory return value — this is the
		// "ledger is authoritative" property the guard depends on.
		const reloaded = await loadPlanJsonOnly(tempDir);
		const reloadedTask = reloaded?.phases[0].tasks.find((t) => t.id === '1.1');
		expect(reloadedTask?.status).toBe('completed');
	});

	it('a different task’s recorded failure does not block this task', async () => {
		recordWorktreeMergeFailure('9.9', {
			outcome: 'failed',
			stage: 'merge',
			message: 'unrelated',
		});
		await updateTaskStatus(tempDir, '1.1', 'completed');
		expect(commitCalls).toEqual(['1.1']);
	});
});
