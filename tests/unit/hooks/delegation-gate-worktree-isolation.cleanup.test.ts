/**
 * Worktree isolation tests (delegation-gate-worktree-isolation.test.ts — Part 2 of 2)
 *
 * Covers:
 * - Worktree state cleanup
 * - Cross-session worktree isolation
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { PluginConfig } from '../../../src/config';
import type { Plan } from '../../../src/config/plan-schema';
import { createDelegationGateHook } from '../../../src/hooks/delegation-gate';
import {
	awaitingMergeByCallID,
	resetStandardWorktreeIsolationState,
	type StandardWorktreeDispatch,
	standardWorktreeByCallID,
	_internals as worktreeInternals,
} from '../../../src/hooks/delegation-gate/worktree-isolation';
import {
	clearWorktreeMergeStatus,
	getWorktreeMergeFailure,
} from '../../../src/hooks/delegation-gate/worktree-merge-status';
import { ensureAgentSession, resetSwarmState } from '../../../src/state';
import type { WorktreeHandle } from '../../../src/worktree';
import { withFrozenClock } from '../../helpers/test-clock.js';
import { recordPlanCriticApproval } from './_delegation-gate-helpers';

function makeConfig(overrides?: Record<string, unknown>): PluginConfig {
	return {
		max_iterations: 5,
		qa_retry_limit: 3,
		inject_phase_reminders: true,
		hooks: {
			system_enhancer: true,
			compaction: true,
			agent_activity: true,
			delegation_tracker: false,
			agent_awareness_max_chars: 300,
			delegation_gate: true,
			delegation_max_chars: 4000,
			...(overrides?.hooks as Record<string, unknown>),
		},
	} as PluginConfig;
}

function makeTempProject(prefix: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	const real = fs.realpathSync(dir);
	fs.mkdirSync(path.join(real, '.swarm'), { recursive: true });
	return real;
}

async function writePlanJson(
	dir: string,
	options: {
		tasks?: Array<{
			id: string;
			status?: string;
			depends?: string[];
			phase?: number;
		}>;
		currentPhase?: number;
	},
): Promise<void> {
	const phase = options.currentPhase ?? 1;
	const tasks = options.tasks ?? [
		{ id: '1.1', status: 'pending' },
		{ id: '1.2', status: 'pending' },
	];
	const plan: Plan = {
		schema_version: '1.0.0' as const,
		title: 'Test Plan',
		swarm: 'test-swarm',
		current_phase: phase,
		phases: [
			{
				id: phase,
				name: `Phase ${phase}`,
				status: 'in_progress',
				tasks: tasks.map((task) => ({
					id: task.id,
					phase: task.phase ?? phase,
					status: task.status ?? 'pending',
					size: 'small' as const,
					description: `Task ${task.id}`,
					depends: task.depends ?? [],
					files_touched: [`src/task-${task.id}.ts`],
				})),
			},
		],
	};
	fs.writeFileSync(
		path.join(dir, '.swarm', 'plan.json'),
		JSON.stringify(plan, null, 2),
	);
	await recordPlanCriticApproval(dir, plan);
}

async function callToolBefore(
	hook: ReturnType<typeof createDelegationGateHook>,
	tool: string,
	sessionID: string,
	args: Record<string, unknown>,
): Promise<void> {
	await hook.toolBefore(
		{ tool, sessionID, callID: `call-${withFrozenClock(() => Date.now())}` },
		{ args },
	);
}

describe('delegation-gate: worktree state cleanup', () => {
	let tempDir: string;

	beforeEach(async () => {
		resetSwarmState();
		tempDir = makeTempProject('delegation-gate-worktree-cleanup-');
		await writePlanJson(tempDir, {
			tasks: [
				{ id: '1.1', status: 'pending' },
				{ id: '1.2', status: 'pending' },
			],
		});
	});

	afterEach(() => {
		resetSwarmState();
		try {
			fs.rmSync(tempDir, { recursive: true, force: true });
		} catch {
			// best-effort cleanup
		}
	});

	it('should clear worktree state after task completion', async () => {
		const hook = createDelegationGateHook(makeConfig(), tempDir);
		const session = ensureAgentSession('test-session');
		session.taskWorkflowStates.set('1.1', 'tests_run');

		// Complete the task — state advancement to 'complete' happens in toolAfter,
		// not toolBefore, so we simulate it directly here (FB-003 fix).
		await callToolBefore(hook, 'update_task_status', 'test-session', {
			task_id: '1.1',
			status: 'completed',
		});
		session.taskWorkflowStates.set('1.1', 'complete');

		// Should not block anymore
		let threw = false;
		try {
			await callToolBefore(hook, 'Task', 'test-session', {
				subagent_type: 'mega_coder',
				task_id: '1.2',
				prompt: 'ACCEPTANCE: task complete and covered by tests',
			});
		} catch {
			threw = true;
		}

		expect(threw).toBe(false);
	});

	it('terminal coder failure preserves and cleans the lane without merge-back', async () => {
		const hook = createDelegationGateHook(makeConfig(), tempDir);
		const callID = 'failed-standard-coder';
		const worktreePath = path.join(tempDir, 'failed-lane');
		const branchName = 'swarm-lane/test-session/failed-lane';
		const dispatch: StandardWorktreeDispatch = {
			callID,
			parentSessionID: 'test-session',
			taskId: '1.1',
			planTaskId: '1.1',
			handle: {
				worktreePath,
				branchName,
				purpose: 'lane',
				id: 'failed-lane',
				sessionId: 'test-session',
			} as WorktreeHandle,
			mergeStrategy: 'merge',
			laneIndex: 0,
		};
		ensureAgentSession('test-session');
		standardWorktreeByCallID.set(callID, dispatch);
		const originalAttemptMerge = worktreeInternals.attemptMergeBackFromDirty;
		const originalPreserve = worktreeInternals.preserveDirtyWorktreeForCallId;
		const originalRemove = worktreeInternals.removeWorktree;
		const originalPostCleanup = worktreeInternals.postMergeCleanup;
		let mergeAttempts = 0;
		const preserveReasons: string[] = [];
		const removed: string[] = [];
		const cleanedBranches: string[] = [];
		try {
			worktreeInternals.attemptMergeBackFromDirty = mock(async () => {
				mergeAttempts += 1;
				return { merged: true, strategy: 'merge' };
			});
			worktreeInternals.preserveDirtyWorktreeForCallId = mock(
				async (_callID, reason) => {
					preserveReasons.push(reason);
					return {
						outcome: 'preserved' as const,
						preserved: true as const,
						ref: 'preserved-commit',
					};
				},
			);
			worktreeInternals.removeWorktree = mock(async (target) => {
				removed.push(target);
			});
			worktreeInternals.postMergeCleanup = mock(async (_directory, branch) => {
				cleanedBranches.push(branch);
			});

			await hook.toolAfter(
				{
					tool: 'Task',
					sessionID: 'test-session',
					callID,
					args: { subagent_type: 'coder', task_id: '1.1' },
				},
				{ state: 'cancelled', output: 'child cancelled' },
			);

			expect(mergeAttempts).toBe(0);
			expect(preserveReasons).toEqual(['cancelled']);
			expect(removed).toEqual([worktreePath]);
			expect(cleanedBranches).toEqual([branchName]);
			expect(standardWorktreeByCallID.has(callID)).toBe(false);
			expect(awaitingMergeByCallID.has(callID)).toBe(false);
			expect(getWorktreeMergeFailure('1.1')).toMatchObject({
				outcome: 'failed',
				stage: 'task-result',
			});
			expect(
				ensureAgentSession('test-session').pendingAdvisoryMessages?.join('\n'),
			).toContain('STANDARD_WORKTREE_TASK_FAILED');
		} finally {
			worktreeInternals.attemptMergeBackFromDirty = originalAttemptMerge;
			worktreeInternals.preserveDirtyWorktreeForCallId = originalPreserve;
			worktreeInternals.removeWorktree = originalRemove;
			worktreeInternals.postMergeCleanup = originalPostCleanup;
			clearWorktreeMergeStatus('1.1');
			resetStandardWorktreeIsolationState();
		}
	});

	it('should isolate state across sessions within same worktree', async () => {
		const hook = createDelegationGateHook(makeConfig(), tempDir);

		// Session 1 has blocking state
		const session1 = ensureAgentSession('session-1');
		session1.taskWorkflowStates.set('1.1', 'tests_run');

		// Session 2 should not be affected
		const session2 = ensureAgentSession('session-2');

		let threw = false;
		try {
			await callToolBefore(hook, 'Task', 'session-2', {
				subagent_type: 'mega_coder',
				task_id: '1.2',
				prompt: 'ACCEPTANCE: task complete and covered by tests',
			});
		} catch {
			threw = true;
		}

		expect(threw).toBe(false);
	});
});

describe('delegation-gate: cross-session worktree isolation edge cases', () => {
	let tempDir: string;

	beforeEach(async () => {
		resetSwarmState();
		tempDir = makeTempProject('delegation-gate-worktree-cross-');
		await writePlanJson(tempDir, {
			tasks: [
				{ id: '1.1', status: 'pending' },
				{ id: '1.2', status: 'pending' },
			],
		});
	});

	afterEach(() => {
		resetSwarmState();
		try {
			fs.rmSync(tempDir, { recursive: true, force: true });
		} catch {
			// best-effort cleanup
		}
	});

	it('should not leak state from deleted session', async () => {
		const hook = createDelegationGateHook(makeConfig(), tempDir);

		// Create and then "delete" a session by resetting state
		const session1 = ensureAgentSession('session-to-delete');
		session1.taskWorkflowStates.set('1.1', 'tests_run');

		// Reset all state
		resetSwarmState();

		// New session should not see old session's blocking state
		const session2 = ensureAgentSession('session-new');

		let threw = false;
		try {
			await callToolBefore(hook, 'Task', 'session-new', {
				subagent_type: 'mega_coder',
				task_id: '1.2',
				prompt: 'ACCEPTANCE: task complete and covered by tests',
			});
		} catch {
			threw = true;
		}

		expect(threw).toBe(false);
	});
});
