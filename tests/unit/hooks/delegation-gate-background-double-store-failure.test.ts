import { afterEach, describe, expect, mock, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { BackgroundDelegationRecord } from '../../../src/background/pending-delegations';
import type { PluginConfig } from '../../../src/config';
import {
	_internals,
	createDelegationGateHook,
} from '../../../src/hooks/delegation-gate';
import {
	resetStandardWorktreeIsolationState,
	type StandardWorktreeDispatch,
	standardWorktreeByCallID,
} from '../../../src/hooks/delegation-gate/worktree-isolation';
import {
	getWorktreeMergeFailure,
	_internals as mergeStatusInternals,
} from '../../../src/hooks/delegation-gate/worktree-merge-status';
import { runInitOrphanRecovery } from '../../../src/hooks/init-orphan-recovery';
import { ensureAgentSession, resetSwarmState } from '../../../src/state';
import type { WorktreeHandle } from '../../../src/worktree';
import { writeApprovedPlan } from '../../helpers/approved-plan';
import { createSafeTestDir } from '../../helpers/safe-test-dir';

const originalRecord = _internals.recordPendingDelegationForBackground;
const originalFallback = _internals.writeDelegationFallbackForBackground;
const originalPreserve =
	_internals.preserveBackgroundWorktreeOwnershipForCallId;
const originalBind = _internals.bindBackgroundCoderReservationForDispatch;

const existingRecord: BackgroundDelegationRecord = {
	schemaVersion: 1,
	correlationId: 'child-session',
	jobId: 'existing-job',
	subagentSessionId: 'child-session',
	parentSessionId: 'different-parent',
	callID: 'different-call',
	normalizedAgent: 'coder',
	swarmPrefixedAgent: 'coder',
	planTaskId: 'other-task',
	evidenceTaskId: 'other-task',
	status: 'pending',
	createdAt: 1,
	updatedAt: 1,
	generation: 1,
};

function git(directory: string, args: string[]): string {
	const result = spawnSync('git', ['-C', directory, ...args], {
		cwd: directory,
		stdin: 'ignore',
		stdout: 'pipe',
		stderr: 'pipe',
		encoding: 'utf8',
		timeout: 5_000,
		maxBuffer: 128 * 1024,
	});
	if (result.status !== 0) throw new Error(result.stderr || result.stdout);
	return result.stdout.trim();
}

describe('background dispatch double-store recovery', () => {
	afterEach(() => {
		_internals.recordPendingDelegationForBackground = originalRecord;
		_internals.writeDelegationFallbackForBackground = originalFallback;
		_internals.preserveBackgroundWorktreeOwnershipForCallId = originalPreserve;
		_internals.bindBackgroundCoderReservationForDispatch = originalBind;
		resetStandardWorktreeIsolationState();
		mergeStatusInternals.resetForTest();
		resetSwarmState();
	});

	test('awaits an ownership tag and persists restart protection', async () => {
		const { dir, cleanup } = createSafeTestDir('swarm-bg-double-store-');
		try {
			const session = ensureAgentSession('parent', 'architect', dir);
			session.currentTaskId = '7.1';
			const callID = 'background-call';
			standardWorktreeByCallID.set(callID, {
				callID,
				parentSessionID: 'parent',
				taskId: '7.1',
				planTaskId: '7.1',
				handle: {
					worktreePath: dir,
					branchName: 'swarm/lane/child/lane-1',
					purpose: 'lane',
					id: 'lane-1',
					sessionId: 'child',
				} as WorktreeHandle,
				mergeStrategy: 'merge',
				laneIndex: 0,
			} satisfies StandardWorktreeDispatch);
			_internals.recordPendingDelegationForBackground = mock(async () => ({
				status: 'failed',
				record: null,
			}));
			_internals.writeDelegationFallbackForBackground = mock(async () => null);
			const preserve = mock(async () => ({
				outcome: 'preserved' as const,
				tag: 'swarm-preserved-owner-child-lane-1',
				ref: 'abc123',
			}));
			_internals.preserveBackgroundWorktreeOwnershipForCallId = preserve;
			const hook = createDelegationGateHook(
				{
					max_iterations: 5,
					qa_retry_limit: 3,
					inject_phase_reminders: true,
					hooks: {
						delegation_gate: true,
						background_subagents: true,
					},
				} as PluginConfig,
				dir,
			);

			await hook.toolAfter(
				{
					tool: 'Task',
					sessionID: 'parent',
					callID,
					args: {
						subagent_type: 'coder',
						background: true,
						task_id: '7.1',
					},
				},
				{
					state: 'running',
					output:
						'<task id="child-session" state="running">Background task started</task>',
					metadata: { background: true, jobId: 'child-job' },
				},
			);

			expect(preserve).toHaveBeenCalledTimes(1);
			expect(getWorktreeMergeFailure('7.1')).toMatchObject({
				stage: 'background-correlation-persist',
				worktreePath: dir,
			});
			expect(session.pendingAdvisoryMessages?.at(-1)).toContain(
				'ownership tag swarm-preserved-owner-child-lane-1 at abc123',
			);
		} finally {
			cleanup();
		}
	});

	test('actual toolAfter ownership tag protects the worktree after disk-state loss', async () => {
		const { dir: root, cleanup } = createSafeTestDir(
			'swarm-bg-double-store-restart-',
		);
		const project = path.join(root, 'project');
		const worktreePath = path.join(root, '.swarm-worktrees', 'child', 'lane-1');
		try {
			fs.mkdirSync(project, { recursive: true });
			git(project, ['init']);
			git(project, ['config', 'user.email', 'tests@example.com']);
			git(project, ['config', 'user.name', 'Tests']);
			fs.writeFileSync(path.join(project, 'base.txt'), 'base\n');
			git(project, ['add', 'base.txt']);
			git(project, ['commit', '-m', 'seed']);
			fs.mkdirSync(path.join(project, '.swarm'), { recursive: true });
			git(project, [
				'worktree',
				'add',
				'-b',
				'swarm/lane/child/lane-1',
				worktreePath,
			]);
			fs.writeFileSync(path.join(worktreePath, 'valuable.txt'), 'keep\n');
			const session = ensureAgentSession('parent', 'architect', project);
			session.currentTaskId = '8.1';
			const callID = 'restart-background-call';
			standardWorktreeByCallID.set(callID, {
				callID,
				parentSessionID: 'parent',
				taskId: '8.1',
				planTaskId: '8.1',
				handle: {
					worktreePath,
					branchName: 'swarm/lane/child/lane-1',
					purpose: 'lane',
					id: 'lane-1',
					sessionId: 'child',
				} as WorktreeHandle,
				mergeStrategy: 'merge',
				laneIndex: 0,
			});
			_internals.recordPendingDelegationForBackground = mock(async () => ({
				status: 'failed',
				record: null,
			}));
			_internals.writeDelegationFallbackForBackground = mock(async () => null);
			_internals.preserveBackgroundWorktreeOwnershipForCallId =
				originalPreserve;
			const hook = createDelegationGateHook(
				{
					max_iterations: 5,
					qa_retry_limit: 3,
					inject_phase_reminders: true,
					hooks: {
						delegation_gate: true,
						background_subagents: true,
					},
				} as PluginConfig,
				project,
			);
			await hook.toolAfter(
				{
					tool: 'Task',
					sessionID: 'parent',
					callID,
					args: {
						subagent_type: 'coder',
						background: true,
						task_id: '8.1',
					},
				},
				{
					state: 'running',
					output:
						'<task id="child-session" state="running">Background task started</task>',
					metadata: { background: true, jobId: 'child-job' },
				},
			);
			expect(
				git(project, ['tag', '--list', 'swarm-preserved-owner/*']),
			).not.toBe('');

			// Prove tag ownership is independent of the fail-open status registry.
			fs.rmSync(path.join(project, '.swarm', 'worktree-merge-status.json'), {
				force: true,
			});
			mergeStatusInternals.resetForTest();
			resetStandardWorktreeIsolationState();
			resetSwarmState();
			const recovery = await runInitOrphanRecovery(project);

			// Issue #2527: the legacy parent-level lane is MIGRATED into the
			// project-internal base (git worktree move — nothing is deleted),
			// and the ownership tag keeps the migrated lane protected there.
			const migratedPath = path.join(
				project,
				'.swarm-worktrees',
				'child',
				'lane-1',
			);
			expect(recovery.removedWorktrees).not.toContain(worktreePath);
			expect(recovery.removedWorktrees).not.toContain(migratedPath);
			expect(
				fs.readFileSync(path.join(migratedPath, 'valuable.txt'), 'utf8'),
			).toBe('keep\n');
		} finally {
			cleanup();
		}
	});

	test('correlation conflict fails closed without fallback or reservation binding', async () => {
		const { dir, cleanup } = createSafeTestDir('swarm-bg-conflict-');
		try {
			await writeApprovedPlan(dir, [{ id: '9.1', files: ['src/example.ts'] }]);
			const session = ensureAgentSession('parent', 'architect', dir);
			session.currentTaskId = '9.1';
			_internals.recordPendingDelegationForBackground = mock(async () => ({
				status: 'conflict',
				record: existingRecord,
			}));
			const fallback = mock(async () => null);
			const bind = mock(async () => null);
			_internals.writeDelegationFallbackForBackground = fallback;
			_internals.bindBackgroundCoderReservationForDispatch = bind;
			const hook = createDelegationGateHook(
				{
					max_iterations: 5,
					qa_retry_limit: 3,
					inject_phase_reminders: true,
					hooks: { delegation_gate: true, background_subagents: true },
				} as PluginConfig,
				dir,
			);
			const taskArgs = {
				subagent_type: 'coder',
				background: true,
				task_id: '9.1',
				prompt:
					'TASK: 9.1\nFILE: src/example.ts\nACCEPTANCE: preserve the conflicting reservation for safe recovery',
			};
			await hook.toolBefore(
				{ tool: 'Task', sessionID: 'parent', callID: 'conflicting-call' },
				{ args: taskArgs },
			);

			await hook.toolAfter(
				{
					tool: 'Task',
					sessionID: 'parent',
					callID: 'conflicting-call',
					args: taskArgs,
				},
				{
					state: 'running',
					output:
						'<task id="child-session" state="running">Background task started</task>',
					metadata: { background: true, jobId: 'new-job' },
				},
			);

			expect(fallback).not.toHaveBeenCalled();
			expect(bind).not.toHaveBeenCalled();
			expect(session.pendingAdvisoryMessages?.at(-1)).toContain(
				'BACKGROUND DELEGATION CORRELATION CONFLICT',
			);
			expect(session.pendingAdvisoryMessages?.at(-1)).toContain(
				'No fallback owner was written and no reservation was bound',
			);
			expect(session.pendingAdvisoryMessages ?? []).not.toContainEqual(
				expect.stringContaining('BACKGROUND DELEGATION UNTRACKED'),
			);
			await expect(
				hook.toolBefore(
					{ tool: 'Task', sessionID: 'parent', callID: 'second-call' },
					{ args: taskArgs },
				),
			).rejects.toThrow(
				/BACKGROUND_CODER_TASK_RESERVED|PARALLEL_SLOTS_EXHAUSTED/,
			);
		} finally {
			cleanup();
		}
	});

	test('exact duplicate remains durable without writing fallback', async () => {
		const { dir, cleanup } = createSafeTestDir('swarm-bg-duplicate-');
		try {
			const session = ensureAgentSession('parent', 'architect', dir);
			session.currentTaskId = '9.2';
			_internals.recordPendingDelegationForBackground = mock(async () => ({
				status: 'duplicate',
				record: {
					...existingRecord,
					parentSessionId: 'parent',
					callID: 'duplicate-call',
					normalizedAgent: 'reviewer',
					swarmPrefixedAgent: 'reviewer',
					planTaskId: '9.2',
					evidenceTaskId: '9.2',
				},
			}));
			const fallback = mock(async () => null);
			_internals.writeDelegationFallbackForBackground = fallback;
			const hook = createDelegationGateHook(
				{
					max_iterations: 5,
					qa_retry_limit: 3,
					inject_phase_reminders: true,
					hooks: { delegation_gate: true, background_subagents: true },
				} as PluginConfig,
				dir,
			);

			await hook.toolAfter(
				{
					tool: 'Task',
					sessionID: 'parent',
					callID: 'duplicate-call',
					args: {
						subagent_type: 'reviewer',
						background: true,
						task_id: '9.2',
					},
				},
				{
					state: 'running',
					output:
						'<task id="child-session" state="running">Background task started</task>',
					metadata: { background: true, jobId: 'existing-job' },
				},
			);

			expect(fallback).not.toHaveBeenCalled();
			expect(session.pendingAdvisoryMessages ?? []).not.toContainEqual(
				expect.stringContaining('CORRELATION CONFLICT'),
			);
		} finally {
			cleanup();
		}
	});
});
