import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { PluginConfig } from '../../../src/config';
import {
	_internals,
	createDelegationGateHook,
} from '../../../src/hooks/delegation-gate';
import {
	ensureAgentSession,
	resetSwarmState,
	swarmState,
} from '../../../src/state';
import type { WorktreeHandle } from '../../../src/worktree';

const realProvisionWorktree = _internals.provisionWorktree;
const realRemoveWorktree = _internals.removeWorktree;
const realAttemptMergeBackFromDirty = _internals.attemptMergeBackFromDirty;
const realPostMergeCleanup = _internals.postMergeCleanup;

function makeConfig(
	policy: 'auto' | 'required' | 'disabled' = 'required',
): PluginConfig {
	return {
		max_iterations: 5,
		qa_retry_limit: 3,
		inject_phase_reminders: true,
		hooks: {
			delegation_gate: true,
		},
		worktree: {
			policy,
			merge_strategy: 'merge',
			deps_strategy: 'skip',
		},
	} as PluginConfig;
}

function writeParallelPlan(directory: string): void {
	const swarmDir = path.join(directory, '.swarm');
	fs.mkdirSync(swarmDir, { recursive: true });
	fs.writeFileSync(
		path.join(swarmDir, 'plan.json'),
		JSON.stringify({
			schema_version: '1.0.0',
			title: 'Parallel plan',
			swarm: 'test',
			current_phase: 1,
			execution_profile: {
				parallelization_enabled: true,
				max_concurrent_tasks: 2,
				council_parallel: false,
			},
			phases: [
				{
					id: 1,
					name: 'Implementation',
					status: 'pending',
					tasks: [
						{
							id: '1.1',
							phase: 1,
							description: 'Implement isolated standard coder lane',
							status: 'pending',
							size: 'small',
							depends: [],
						},
					],
				},
			],
		}),
	);
}

describe('delegation gate standard worktree isolation', () => {
	let tempDir: string;

	beforeEach(() => {
		resetSwarmState();
		_internals.resetStandardWorktreeIsolationState();
		tempDir = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-wt-gate-')),
		);
		writeParallelPlan(tempDir);
	});

	afterEach(() => {
		_internals.provisionWorktree = realProvisionWorktree;
		_internals.removeWorktree = realRemoveWorktree;
		_internals.attemptMergeBackFromDirty = realAttemptMergeBackFromDirty;
		_internals.postMergeCleanup = realPostMergeCleanup;
		_internals.resetStandardWorktreeIsolationState();
		resetSwarmState();
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	test('precreates a worktree-backed Task session and merges it after completion', async () => {
		const worktreePath = path.join(tempDir, '..', 'wt-1-1');
		const handle: WorktreeHandle = {
			worktreePath,
			branchName: 'swarm/lane/parent-session/1.1',
			purpose: 'lane',
			id: '1.1',
			sessionId: 'parent-session',
		};
		const createCalls: unknown[] = [];
		const removeCalls: unknown[] = [];
		const mergeCalls: unknown[] = [];
		const cleanupCalls: unknown[] = [];

		_internals.provisionWorktree = async () => handle;
		_internals.removeWorktree = async (...args) => {
			removeCalls.push(args);
			return { removed: true };
		};
		_internals.attemptMergeBackFromDirty = async (...args) => {
			mergeCalls.push(args);
			return {
				merged: true,
				strategy: 'merge',
				autoCommitted: true,
				cleaned: true,
			};
		};
		_internals.postMergeCleanup = async (...args) => {
			cleanupCalls.push(args);
			return { cleaned: true };
		};
		swarmState.opencodeClient = {
			session: {
				create: async (input: unknown) => {
					createCalls.push(input);
					return { data: { id: 'child-session' } };
				},
			},
		} as typeof swarmState.opencodeClient;

		const hook = createDelegationGateHook(makeConfig(), tempDir);
		expect(await _internals.loadPlanJsonOnly(tempDir)).not.toBeNull();
		const args: Record<string, unknown> = {
			subagent_type: 'coder',
			description: 'Implement task 1.1',
			prompt: 'TASK: 1.1 implement the lane work',
		};

		await hook.toolBefore(
			{ tool: 'Task', sessionID: 'parent-session', callID: 'call-1' },
			{ args },
		);

		expect(args.task_id).toBe('child-session');
		expect(createCalls).toEqual([
			{
				body: {
					parentID: 'parent-session',
					title: 'Implement task 1.1 (worktree lane)',
				},
				query: { directory: worktreePath },
			},
		]);

		await hook.toolAfter(
			{
				tool: 'Task',
				sessionID: 'parent-session',
				callID: 'call-1',
				args,
			},
			{ ok: true },
		);

		expect(mergeCalls).toEqual([
			[worktreePath, 'swarm/lane/parent-session/1.1', tempDir, 'merge'],
		]);
		expect(removeCalls).toEqual([[worktreePath, tempDir]]);
		expect(cleanupCalls).toEqual([[tempDir, 'swarm/lane/parent-session/1.1']]);
		expect(
			ensureAgentSession('parent-session').pendingAdvisoryMessages ?? [],
		).toHaveLength(0);
	});

	test('required policy fails closed when worktree provisioning fails', async () => {
		const createCalls: unknown[] = [];
		_internals.provisionWorktree = async () => ({
			error: 'branch already exists',
		});
		swarmState.opencodeClient = {
			session: {
				create: async (input: unknown) => {
					createCalls.push(input);
					return { data: { id: 'child-session' } };
				},
			},
		} as typeof swarmState.opencodeClient;

		const hook = createDelegationGateHook(makeConfig('required'), tempDir);
		await expect(
			hook.toolBefore(
				{ tool: 'Task', sessionID: 'parent-session', callID: 'call-fail' },
				{
					args: {
						subagent_type: 'coder',
						description: 'Implement task 1.1',
						prompt: 'TASK: 1.1 implement the lane work',
					},
				},
			),
		).rejects.toThrow(/STANDARD_WORKTREE_PROVISION_FAILED/);

		expect(createCalls).toEqual([]);
	});

	test('auto policy blocks the triggering coder when a sibling worktree is already in-flight (F-008)', async () => {
		// First dispatch succeeds and stays in-flight (tracked, not yet merged back).
		const handle: WorktreeHandle = {
			worktreePath: path.join(tempDir, '..', 'wt-sibling'),
			branchName: 'swarm/lane/parent-session/1.1',
			purpose: 'lane',
			id: '1.1',
			sessionId: 'parent-session',
		};
		let provisionShouldFail = false;
		_internals.provisionWorktree = async () =>
			provisionShouldFail ? { error: 'branch already exists' } : handle;
		swarmState.opencodeClient = {
			session: {
				create: async () => ({ data: { id: 'sibling-session' } }),
			},
		} as typeof swarmState.opencodeClient;

		const hook = createDelegationGateHook(makeConfig('auto'), tempDir);
		const firstArgs: Record<string, unknown> = {
			subagent_type: 'coder',
			description: 'Implement task 1.1',
			prompt: 'TASK: 1.1 implement the lane work',
		};
		await hook.toolBefore(
			{ tool: 'Task', sessionID: 'parent-session', callID: 'call-sibling' },
			{ args: firstArgs },
		);
		expect(firstArgs.task_id).toBe('sibling-session');

		// Second dispatch: provisioning now fails. A sibling worktree is in-flight,
		// so the triggering coder must NOT silently run un-isolated in the main tree.
		provisionShouldFail = true;
		await expect(
			hook.toolBefore(
				{ tool: 'Task', sessionID: 'parent-session', callID: 'call-unsafe' },
				{
					args: {
						subagent_type: 'coder',
						description: 'Implement task 1.1 again',
						prompt: 'TASK: 1.1 implement the lane work',
					},
				},
			),
		).rejects.toThrow(/STANDARD_WORKTREE_ISOLATION_UNSAFE/);
	});

	test('auto policy degrades gracefully when provisioning fails with no sibling in-flight (F-008)', async () => {
		_internals.provisionWorktree = async () => ({
			error: 'branch already exists',
		});
		swarmState.opencodeClient = {
			session: { create: async () => ({ data: { id: 'unused' } }) },
		} as typeof swarmState.opencodeClient;

		const hook = createDelegationGateHook(makeConfig('auto'), tempDir);
		const args: Record<string, unknown> = {
			subagent_type: 'coder',
			description: 'Implement task 1.1',
			prompt: 'TASK: 1.1 implement the lane work',
		};
		// No sibling is in-flight, so the lone coder may degrade to un-isolated
		// serial execution — the intended best-effort behavior.
		await expect(
			hook.toolBefore(
				{ tool: 'Task', sessionID: 'parent-session', callID: 'call-degrade' },
				{ args },
			),
		).resolves.toBeUndefined();
		expect(args.task_id).toBeUndefined();
		expect(ensureAgentSession('parent-session').maxConcurrencyOverride).toBe(1);
		expect(
			ensureAgentSession('parent-session').pendingAdvisoryMessages?.some((m) =>
				m.includes('STANDARD_WORKTREE_PROVISION_FAILED'),
			),
		).toBe(true);
	});

	test('auto policy serializes before creating a worktree when dispatch tracking is full', async () => {
		const provisionCalls: unknown[] = [];
		const createCalls: unknown[] = [];
		_internals.provisionWorktree = async (directory, taskId, sessionId) => {
			provisionCalls.push([directory, taskId, sessionId]);
			return {
				worktreePath: path.join(tempDir, '..', `wt-${provisionCalls.length}`),
				branchName: `swarm/lane/${sessionId}/${taskId}`,
				purpose: 'lane',
				id: taskId,
				sessionId,
			};
		};
		swarmState.opencodeClient = {
			session: {
				create: async (input: unknown) => {
					createCalls.push(input);
					return { data: { id: `child-session-${createCalls.length}` } };
				},
			},
		} as typeof swarmState.opencodeClient;

		const hook = createDelegationGateHook(makeConfig('auto'), tempDir);
		for (let i = 0; i < 256; i++) {
			const args: Record<string, unknown> = {
				subagent_type: 'coder',
				description: `Implement task 1.1 attempt ${i}`,
				prompt: 'TASK: 1.1 implement the lane work',
			};
			await hook.toolBefore(
				{ tool: 'Task', sessionID: 'parent-session', callID: `call-${i}` },
				{ args },
			);
			expect(args.task_id).toBe(`child-session-${i + 1}`);
		}

		const overflowArgs: Record<string, unknown> = {
			subagent_type: 'coder',
			description: 'Implement task 1.1 overflow',
			prompt: 'TASK: 1.1 implement the lane work',
		};
		await hook.toolBefore(
			{ tool: 'Task', sessionID: 'parent-session', callID: 'call-overflow' },
			{ args: overflowArgs },
		);

		expect(overflowArgs.task_id).toBeUndefined();
		expect(provisionCalls).toHaveLength(256);
		expect(createCalls).toHaveLength(256);
		expect(ensureAgentSession('parent-session').maxConcurrencyOverride).toBe(1);
		expect(
			ensureAgentSession('parent-session').pendingAdvisoryMessages?.some(
				(message) =>
					message.includes('STANDARD_WORKTREE_TRACKING_CAP_EXCEEDED'),
			),
		).toBe(true);
	});

	test('resetSwarmState clears standard worktree serialization state', async () => {
		const hook = createDelegationGateHook(makeConfig('auto'), tempDir);
		const args: Record<string, unknown> = {
			subagent_type: 'coder',
			description: 'Implement task 1.1',
			prompt: 'TASK: 1.1 implement the lane work',
		};

		await hook.toolBefore(
			{ tool: 'Task', sessionID: 'parent-session', callID: 'call-no-client' },
			{ args },
		);
		await expect(
			hook.toolBefore(
				{
					tool: 'Task',
					sessionID: 'parent-session',
					callID: 'call-serialized',
				},
				{
					args: {
						subagent_type: 'coder',
						description: 'Implement task 1.1 again',
						prompt: 'TASK: 1.1 implement the lane work',
					},
				},
			),
		).rejects.toThrow(/STANDARD_WORKTREE_ISOLATION_SERIALIZED/);

		resetSwarmState();

		await expect(
			hook.toolBefore(
				{
					tool: 'Task',
					sessionID: 'parent-session',
					callID: 'call-after-reset',
				},
				{
					args: {
						subagent_type: 'coder',
						description: 'Implement task 1.1 after reset',
						prompt: 'TASK: 1.1 implement the lane work',
					},
				},
			),
		).resolves.toBeUndefined();
	});
});

/**
 * C4 — reviewer-gate parallel exemption.
 *
 * The reviewer gate blocks coder re-delegation while a prior coder task awaits
 * review. Before this change the ONLY bypass was Lean Turbo, so standard
 * `parallelization_enabled` sessions could not dispatch a second coder for a
 * different task — defeating the whole point of parallel coders + worktrees.
 *
 * These tests pin the corrected contract:
 *  - a DIFFERENT dependency-ready task is allowed while another awaits review
 *  - re-delegating the SAME unreviewed task still throws (review must run)
 *  - the slot cap (max_concurrent_tasks) still bounds in-flight coders
 *  - serial sessions keep the original "block any second coder" behavior
 *
 * Worktree policy is 'disabled' so the gate is exercised in isolation (no
 * worktree provisioning side effects).
 */
describe('delegation gate reviewer-gate parallel exemption (C4)', () => {
	let tempDir: string;

	function writeMultiTaskPlan(
		directory: string,
		opts: { parallel: boolean; maxConcurrent: number },
	): void {
		const swarmDir = path.join(directory, '.swarm');
		fs.mkdirSync(swarmDir, { recursive: true });
		fs.writeFileSync(
			path.join(swarmDir, 'plan.json'),
			JSON.stringify({
				schema_version: '1.0.0',
				title: 'Multi-task plan',
				swarm: 'test',
				current_phase: 1,
				execution_profile: {
					parallelization_enabled: opts.parallel,
					max_concurrent_tasks: opts.maxConcurrent,
					council_parallel: false,
				},
				phases: [
					{
						id: 1,
						name: 'Implementation',
						status: 'pending',
						tasks: ['1.1', '1.2', '1.3'].map((id) => ({
							id,
							phase: 1,
							description: `Implement ${id}`,
							status: 'pending',
							size: 'small',
							depends: [],
						})),
					},
				],
			}),
		);
	}

	function seedSession(
		sessionID: string,
		coderDelegatedTaskIds: string[],
	): void {
		const session = ensureAgentSession(sessionID);
		session.taskWorkflowStates = new Map(
			coderDelegatedTaskIds.map((id) => [id, 'coder_delegated'] as const),
		);
		// A fresh in-session coder delegation so the gate's staleness reset does
		// not wipe the coder_delegated state we are testing against.
		swarmState.delegationChains.set(sessionID, [
			{ from: 'architect', to: 'coder', timestamp: Date.now() },
		]);
	}

	function dispatchCoder(
		hook: ReturnType<typeof createDelegationGateHook>,
		sessionID: string,
		taskId: string,
	): Promise<void> {
		return hook.toolBefore(
			{ tool: 'Task', sessionID, callID: `call-${taskId}-${Date.now()}` },
			{
				args: {
					subagent_type: 'coder',
					task_id: taskId,
					description: `Implement ${taskId}`,
					prompt: `TASK: ${taskId} implement the work`,
				},
			},
		);
	}

	beforeEach(() => {
		resetSwarmState();
		_internals.resetStandardWorktreeIsolationState();
		tempDir = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-wt-c4-')),
		);
	});

	afterEach(() => {
		_internals.resetStandardWorktreeIsolationState();
		resetSwarmState();
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	test('parallel mode allows a coder for a DIFFERENT task while one awaits review', async () => {
		writeMultiTaskPlan(tempDir, { parallel: true, maxConcurrent: 2 });
		seedSession('parent-session', ['1.1']);
		const hook = createDelegationGateHook(makeConfig('disabled'), tempDir);

		await expect(
			dispatchCoder(hook, 'parent-session', '1.2'),
		).resolves.toBeUndefined();
	});

	test('parallel mode still blocks re-delegating the SAME unreviewed task', async () => {
		writeMultiTaskPlan(tempDir, { parallel: true, maxConcurrent: 2 });
		seedSession('parent-session', ['1.1']);
		const hook = createDelegationGateHook(makeConfig('disabled'), tempDir);

		await expect(dispatchCoder(hook, 'parent-session', '1.1')).rejects.toThrow(
			/REVIEWER_GATE_VIOLATION/,
		);
	});

	test('parallel mode blocks a new coder when concurrency slots are exhausted', async () => {
		writeMultiTaskPlan(tempDir, { parallel: true, maxConcurrent: 2 });
		seedSession('parent-session', ['1.1', '1.2']);
		const hook = createDelegationGateHook(makeConfig('disabled'), tempDir);

		await expect(dispatchCoder(hook, 'parent-session', '1.3')).rejects.toThrow(
			/PARALLEL_SLOTS_EXHAUSTED/,
		);
	});

	test('parallel mode does not let an unparseable task id bypass the slot cap (F-001)', async () => {
		writeMultiTaskPlan(tempDir, { parallel: true, maxConcurrent: 2 });
		seedSession('parent-session', ['1.1', '1.2']); // slots exhausted
		const hook = createDelegationGateHook(makeConfig('disabled'), tempDir);

		// No task_id field and an ambiguous prompt → incomingCoderTaskId is null.
		// The dispatch must still be blocked (by the reviewer gate or the slot cap),
		// never allowed through to oversubscribe the in-flight coders.
		await expect(
			hook.toolBefore(
				{ tool: 'Task', sessionID: 'parent-session', callID: 'call-ambiguous' },
				{
					args: {
						subagent_type: 'coder',
						description: 'do the thing',
						prompt: 'fix the bug',
					},
				},
			),
		).rejects.toThrow(/PARALLEL_SLOTS_EXHAUSTED|REVIEWER_GATE_VIOLATION/);
	});

	test('serial mode still blocks any second coder while one awaits review', async () => {
		writeMultiTaskPlan(tempDir, { parallel: false, maxConcurrent: 1 });
		seedSession('parent-session', ['1.1']);
		const hook = createDelegationGateHook(makeConfig('disabled'), tempDir);

		await expect(dispatchCoder(hook, 'parent-session', '1.2')).rejects.toThrow(
			/REVIEWER_GATE_VIOLATION/,
		);
	});
});
