import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
	BackgroundTaskChangeContext,
	BackgroundWorktreeDescriptor,
} from '../../../src/background/pending-delegations';
import { captureWorkspaceSnapshot } from '../../../src/background/workspace-snapshot';
import type { Plan } from '../../../src/config/plan-schema';
import {
	readTaskEvidenceRaw,
	transitionTaskWorkflowEvidence,
} from '../../../src/gate-evidence';
import { recordWorktreeProvisioningOwner } from '../../../src/hooks/delegation-gate/worktree-provisioning-owner';
import { loadPlanJsonOnly, savePlan } from '../../../src/plan/manager';
import { reconcileCloseTerminalState } from '../../../src/workflow/close-terminal';
import {
	beginCoderSettlement,
	settleCoderDispatch,
} from '../../../src/workflow/coder-settlement';
import { writeWorkflowWalFile } from '../../../src/workflow/workflow-wal-file';
import type { TaskRepairWal } from '../../../src/workflow/workflow-wal-schema';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

function plan(status: 'closed' | 'in_progress'): Plan {
	return {
		schema_version: '1.0.0',
		title: 'Close terminal service',
		swarm: 'test-swarm',
		current_phase: 1,
		phases: [
			{
				id: 1,
				name: 'Phase 1',
				status: status === 'in_progress' ? 'in_progress' : 'closed',
				tasks: [
					{
						id: '1.1',
						phase: 1,
						status,
						size: 'small',
						description: 'Reconcile terminal state',
						depends: [],
						files_touched: ['src/close.ts'],
					},
				],
			},
		],
	};
}

function git(directory: string, args: string[]): string {
	const result = spawnSync('git', ['-C', directory, ...args], {
		cwd: directory,
		stdio: ['ignore', 'pipe', 'pipe'],
		encoding: 'utf8',
		timeout: 10_000,
		maxBuffer: 256 * 1024,
		windowsHide: true,
	});
	if (result.error) throw result.error;
	if (result.status !== 0) throw new Error(result.stderr || result.stdout);
	return result.stdout.trim();
}

function branchExists(directory: string, branch: string): boolean {
	const result = spawnSync(
		'git',
		[
			'-C',
			directory,
			'show-ref',
			'--verify',
			'--quiet',
			`refs/heads/${branch}`,
		],
		{
			cwd: directory,
			stdio: ['ignore', 'ignore', 'ignore'],
			timeout: 10_000,
			windowsHide: true,
		},
	);
	if (result.error) throw result.error;
	return result.status === 0;
}

describe('issue #2098 close terminal preflight', () => {
	let directory: string;

	beforeEach(async () => {
		directory = canonicalMkdtemp('close-terminal-preflight-2098-');
		fs.mkdirSync(path.join(directory, '.git'));
		await savePlan(directory, plan('in_progress'));
	});

	afterEach(() => {
		fs.rmSync(directory, { recursive: true, force: true });
	});

	test('preflights and aborts a PREPARED task-repair fence before close terminalization', async () => {
		const closedPlan = plan('closed');
		const blockedPlan = plan('in_progress');
		blockedPlan.phases[0]!.tasks[0]!.status = 'blocked';
		await savePlan(directory, blockedPlan);
		await transitionTaskWorkflowEvidence(directory, '1.1', {
			type: 'task_blocked',
			expectedGeneration: 0,
			transitionId: 'already-blocked',
		});
		const repairWal: TaskRepairWal = {
			version: 1,
			state: 'PREPARED',
			taskId: '1.1',
			transitionId: 'repair-close-1.1',
			reason: 'Resume task after earlier close',
			actor: 'architect',
			oldPlanStatus: 'blocked',
			newPlanStatus: 'in_progress',
			oldWorkflowState: 'blocked',
			newWorkflowState: 'idle',
			oldGeneration: 0,
			generation: 1,
			recordedAt: '2026-08-16T00:00:00.000Z',
		};
		await writeWorkflowWalFile(
			'task-repair',
			path.join(directory, '.swarm', 'task-repairs', '1.1.json'),
			repairWal,
		);

		const result = await reconcileCloseTerminalState(directory, closedPlan, {
			actor: 'close-test',
			requestedClosedTaskIds: ['1.1'],
			closedPhaseIds: [1],
		});

		expect(result.plan.phases[0]?.tasks[0]?.status).toBe('closed');
		expect(
			JSON.parse(
				fs.readFileSync(
					path.join(directory, '.swarm', 'task-repairs', '1.1.json'),
					'utf8',
				),
			).state,
		).toBe('ABORTED');
		expect(readTaskEvidenceRaw(directory, '1.1')?.workflow).toMatchObject({
			state: 'closed',
			lastOutcome: 'task_closed',
		});
	});

	test('completes pending coder-settlement cleanup before close terminalization', async () => {
		const root = canonicalMkdtemp('close-terminal-coder-cleanup-');
		const repo = path.join(root, 'repo');
		const worktree = path.join(root, 'lane');
		try {
			fs.mkdirSync(repo);
			git(repo, ['init']);
			git(repo, ['config', 'user.email', 'tests@example.com']);
			git(repo, ['config', 'user.name', 'Tests']);
			fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
			fs.writeFileSync(
				path.join(repo, 'src', 'feature.ts'),
				'export const x = 1;\n',
			);
			git(repo, ['add', '.']);
			git(repo, ['commit', '-m', 'seed']);
			git(repo, [
				'worktree',
				'add',
				'-b',
				'swarm-lane/close-cleanup',
				worktree,
			]);
			await savePlan(repo, plan('in_progress'));

			const context: BackgroundTaskChangeContext = {
				declaredFiles: ['src'],
				baseline: captureWorkspaceSnapshot(worktree),
				workflowGeneration: 0,
			};
			const descriptor: BackgroundWorktreeDescriptor = {
				callID: 'call-close-cleanup',
				parentSessionId: 'parent-close-cleanup',
				taskId: '1.1',
				planTaskId: '1.1',
				worktreePath: worktree,
				branchName: 'swarm-lane/close-cleanup',
				worktreeId: 'lane-1',
				worktreeSessionId: 'lane-session-close-cleanup',
				mergeStrategy: 'merge',
				laneIndex: 1,
				worktreeDir: null,
			};
			recordWorktreeProvisioningOwner(repo, {
				callID: descriptor.callID,
				parentSessionId: descriptor.parentSessionId,
				worktreeSessionId: descriptor.worktreeSessionId,
				taskId: '1.1',
			});
			await beginCoderSettlement({
				directory: repo,
				taskId: '1.1',
				transitionId: 'coder-close-cleanup',
				actor: 'architect',
				expectedGeneration: 0,
				context,
				worktree: descriptor,
			});
			await settleCoderDispatch({
				directory: repo,
				taskId: '1.1',
				transitionId: 'coder-close-cleanup',
				accepted: true,
				testEngineerExempt: false,
			});

			const result = await reconcileCloseTerminalState(repo, plan('closed'), {
				actor: 'close-test',
				requestedClosedTaskIds: ['1.1'],
				closedPhaseIds: [1],
			});

			expect(result.closedTaskIds).toEqual(['1.1']);
			expect(fs.existsSync(worktree)).toBe(false);
			expect(branchExists(repo, descriptor.branchName)).toBe(false);
			expect(
				JSON.parse(
					fs.readFileSync(
						path.join(repo, '.swarm', 'coder-settlements', '1.1.json'),
						'utf8',
					),
				),
			).toMatchObject({
				state: 'COMMITTED',
				cleanupComplete: true,
			});
			expect((await loadPlanJsonOnly(repo))?.phases[0]?.tasks[0]?.status).toBe(
				'closed',
			);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
