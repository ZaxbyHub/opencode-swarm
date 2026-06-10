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
