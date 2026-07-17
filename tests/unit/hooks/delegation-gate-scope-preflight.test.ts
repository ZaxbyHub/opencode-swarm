import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Plan } from '../../../src/config/plan-schema';
import { createScopeGuardHook } from '../../../src/hooks/scope-guard';
import {
	createScopeBinding,
	getAuthorizedScopeBinding,
	registerScopeBinding,
} from '../../../src/scope/scope-binding';
import { ensureAgentSession, resetSwarmState } from '../../../src/state';
import {
	createDelegationGateHook,
	makeConfig,
	recordPlanCriticApproval,
} from './_delegation-gate-helpers';

function planWith(files: string[]): Plan {
	return {
		schema_version: '1.0.0',
		title: 'Scope preflight',
		swarm: 'test',
		current_phase: 1,
		phases: [
			{
				id: 1,
				name: 'Implementation',
				status: 'in_progress',
				tasks: [
					{
						id: '1.1',
						phase: 1,
						status: 'pending',
						size: 'small',
						description: 'Implement',
						depends: [],
						files_touched: files,
					},
				],
			},
		],
	};
}

describe('coder scope preflight', () => {
	let directory: string;
	let plan: Plan;

	beforeEach(() => {
		resetSwarmState();
		directory = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), 'scope-preflight-')),
		);
		fs.mkdirSync(path.join(directory, '.swarm'), { recursive: true });
		ensureAgentSession('parent', 'architect', directory);
	});

	afterEach(() => {
		resetSwarmState();
		fs.rmSync(directory, { recursive: true, force: true });
	});

	async function dispatch(prompt: string, agent = 'coder'): Promise<void> {
		const hook = createDelegationGateHook(makeConfig(), directory);
		await hook.toolBefore(
			{ tool: 'Task', sessionID: 'parent', callID: 'task-call' },
			{
				args: {
					subagent_type: agent,
					prompt: `${prompt}\nACCEPTANCE: implemented and tested`,
				},
			},
		);
		if (agent.endsWith('coder')) {
			await hook.taskMetadata({
				callID: 'task-call',
				parentSessionID: 'parent',
				childSessionID: 'child',
			});
		}
	}

	async function writePlan(files: string[]): Promise<void> {
		plan = planWith(files);
		fs.writeFileSync(
			path.join(directory, '.swarm', 'plan.json'),
			JSON.stringify(plan),
		);
		await recordPlanCriticApproval(directory, plan);
	}

	test('blocks an empty plan scope before coder execution', async () => {
		await writePlan([]);
		await expect(dispatch('TASK: 1.1')).rejects.toThrow('SCOPE_NOT_DECLARED');
	});

	test('accepts a complete FILE-only scope and binds it to the Task call', async () => {
		await writePlan([]);
		await dispatch('TASK: 1.1\nFILE: src/index.ts');
		const binding = getAuthorizedScopeBinding({
			directory,
			plan,
			taskId: '1.1',
			activeSessionId: 'child',
		});
		expect(binding?.files).toEqual(['src/index.ts']);
		expect(binding?.ownerMessageId).toBe('task-call');
	});

	test('rejects FILE paths outside the authoritative plan scope', async () => {
		await writePlan(['src/index.ts']);
		await expect(dispatch('TASK: 1.1\nFILE: src/other.ts')).rejects.toThrow(
			'SCOPE_CONFLICT',
		);
	});

	test('a second declaration is the sole expanded preflight authority', async () => {
		await writePlan(['src/a.ts']);
		for (const [message, files] of [
			['declare-1', ['src/a.ts']],
			['declare-2', ['src/a.ts', 'src/b.ts']],
		] as const) {
			registerScopeBinding(
				createScopeBinding({
					directory,
					plan,
					taskId: '1.1',
					files,
					ownerSessionId: 'parent',
					ownerMessageId: message,
					source: 'declare_scope',
				})!,
			);
		}
		await expect(
			dispatch('TASK: 1.1\nFILE: src/b.ts'),
		).resolves.toBeUndefined();
		expect(
			getAuthorizedScopeBinding({
				directory,
				plan,
				taskId: '1.1',
				activeSessionId: 'child',
			})?.files,
		).toEqual(['src/a.ts', 'src/b.ts']);
	});

	test('applies the same preflight to prefixed coder names', async () => {
		await writePlan([]);
		await expect(dispatch('TASK: 1.1', 'mega_coder')).rejects.toThrow(
			'SCOPE_NOT_DECLARED',
		);
	});

	test('scope preflight remains mandatory when delegation_gate is disabled', async () => {
		await writePlan([]);
		const hook = createDelegationGateHook(
			makeConfig({ hooks: { delegation_gate: false } }),
			directory,
		);
		await expect(
			hook.toolBefore(
				{ tool: 'Task', sessionID: 'parent', callID: 'disabled-call' },
				{ args: { subagent_type: 'mega_coder', prompt: 'TASK: 1.1' } },
			),
		).rejects.toThrow('SCOPE_NOT_DECLARED');
	});

	test('disabled workflow gate still requires exact child activation', async () => {
		await writePlan(['src/index.ts']);
		const hook = createDelegationGateHook(
			makeConfig({ hooks: { delegation_gate: false } }),
			directory,
		);
		const input = { tool: 'Task', sessionID: 'parent', callID: 'disabled-ok' };
		const args = { subagent_type: 'mega_coder', prompt: 'TASK: 1.1' };
		await hook.toolBefore(input, { args });
		expect(
			getAuthorizedScopeBinding({
				directory,
				plan,
				taskId: '1.1',
				activeSessionId: 'parent',
			}),
		).toBeNull();
		await hook.taskMetadata({
			callID: input.callID,
			parentSessionID: input.sessionID,
			childSessionID: 'disabled-child',
		});
		expect(
			getAuthorizedScopeBinding({
				directory,
				plan,
				taskId: '1.1',
				activeSessionId: 'disabled-child',
			}),
		).not.toBeNull();
	});

	test('failed dispatch never publishes its staged scope', async () => {
		plan = planWith(['src/index.ts']);
		fs.writeFileSync(
			path.join(directory, '.swarm', 'plan.json'),
			JSON.stringify(plan),
		);
		const hook = createDelegationGateHook(makeConfig(), directory);
		await expect(
			hook.toolBefore(
				{ tool: 'Task', sessionID: 'parent', callID: 'failed-call' },
				{
					args: {
						subagent_type: 'coder',
						prompt: 'TASK: 1.1\nACCEPTANCE: task is complete',
					},
				},
			),
		).rejects.toThrow('PLAN_CRITIC_GATE_VIOLATION');
		expect(
			getAuthorizedScopeBinding({
				directory,
				plan,
				taskId: '1.1',
				activeSessionId: 'parent',
			}),
		).toBeNull();
	});

	test('Task completion revokes the exact published binding', async () => {
		await writePlan(['src/index.ts']);
		const hook = createDelegationGateHook(makeConfig(), directory);
		const input = {
			tool: 'Task',
			sessionID: 'parent',
			callID: 'completed-call',
		};
		const args = {
			subagent_type: 'coder',
			prompt: 'TASK: 1.1\nACCEPTANCE: task is complete',
		};
		await hook.toolBefore(input, { args });
		await hook.taskMetadata({
			callID: input.callID,
			parentSessionID: input.sessionID,
			childSessionID: 'completed-child',
		});
		expect(
			getAuthorizedScopeBinding({
				directory,
				plan,
				taskId: '1.1',
				activeSessionId: 'completed-child',
			}),
		).not.toBeNull();
		await hook.toolAfter({ ...input, args }, { output: 'done' });
		expect(
			getAuthorizedScopeBinding({
				directory,
				plan,
				taskId: '1.1',
				activeSessionId: 'completed-child',
			}),
		).toBeNull();
	});

	test('exact Task metadata activates only the real child and seeds write authorization', async () => {
		await writePlan(['src/index.ts']);
		const hook = createDelegationGateHook(makeConfig(), directory);
		const input = { tool: 'Task', sessionID: 'parent', callID: 'exact-call' };
		const args = {
			subagent_type: 'coder',
			prompt: 'TASK: 1.1\nACCEPTANCE: task is complete',
		};
		await hook.toolBefore(input, { args });
		await hook.taskMetadata({
			callID: 'different-call',
			parentSessionID: 'parent',
			childSessionID: 'wrong-child',
		});
		expect(
			getAuthorizedScopeBinding({
				directory,
				plan,
				taskId: '1.1',
				activeSessionId: 'wrong-child',
			}),
		).toBeNull();
		await hook.taskMetadata({
			callID: 'exact-call',
			parentSessionID: 'parent',
			childSessionID: 'actual-child',
		});
		expect(
			getAuthorizedScopeBinding({
				directory,
				plan,
				taskId: '1.1',
				activeSessionId: 'parent',
			}),
		).toBeNull();
		const child = ensureAgentSession('actual-child');
		expect(child.currentTaskId).toBe('1.1');
		expect(child.declaredCoderScope).toEqual(['src/index.ts']);
		const scopeGuard = createScopeGuardHook({ enabled: true }, directory);
		await expect(
			scopeGuard.toolBefore(
				{ tool: 'write', sessionID: 'actual-child', callID: 'write-1' },
				{ args: { path: 'src/index.ts', content: 'ok' } },
			),
		).resolves.toBeUndefined();
	});

	test('background running retains child authority until idle teardown', async () => {
		await writePlan(['src/index.ts']);
		const hook = createDelegationGateHook(
			makeConfig({ hooks: { background_subagents: true } }),
			directory,
		);
		const input = {
			tool: 'Task',
			sessionID: 'parent',
			callID: 'background-call',
		};
		const args = {
			subagent_type: 'coder',
			background: true,
			prompt: 'TASK: 1.1\nACCEPTANCE: task is complete',
		};
		await hook.toolBefore(input, { args });
		await hook.taskMetadata({
			callID: input.callID,
			parentSessionID: input.sessionID,
			childSessionID: 'background-child',
		});
		await hook.toolAfter({ ...input, args }, { state: 'running' });
		// The parent goes idle immediately after a background Task returns. Only
		// child terminal lifecycle may revoke the still-running child.
		hook.sessionEnded('parent');
		expect(
			getAuthorizedScopeBinding({
				directory,
				plan,
				taskId: '1.1',
				activeSessionId: 'background-child',
			}),
		).not.toBeNull();
		hook.sessionEnded('background-child');
		expect(
			getAuthorizedScopeBinding({
				directory,
				plan,
				taskId: '1.1',
				activeSessionId: 'background-child',
			}),
		).toBeNull();
	});

	test('failed background result revokes child authority immediately', async () => {
		await writePlan(['src/index.ts']);
		const hook = createDelegationGateHook(
			makeConfig({ hooks: { background_subagents: true } }),
			directory,
		);
		const input = {
			tool: 'Task',
			sessionID: 'parent',
			callID: 'failed-bg-call',
		};
		const args = {
			subagent_type: 'coder',
			background: true,
			prompt: 'TASK: 1.1\nACCEPTANCE: task is complete',
		};
		await hook.toolBefore(input, { args });
		await hook.taskMetadata({
			callID: input.callID,
			parentSessionID: input.sessionID,
			childSessionID: 'failed-bg-child',
		});
		await hook.toolAfter({ ...input, args }, { state: 'error' });
		expect(
			getAuthorizedScopeBinding({
				directory,
				plan,
				taskId: '1.1',
				activeSessionId: 'failed-bg-child',
			}),
		).toBeNull();
	});

	test('architect task completion revokes an active child binding', async () => {
		await writePlan(['src/index.ts']);
		const hook = createDelegationGateHook(makeConfig(), directory);
		const input = { tool: 'Task', sessionID: 'parent', callID: 'status-call' };
		const args = {
			subagent_type: 'coder',
			prompt: 'TASK: 1.1\nACCEPTANCE: task is complete',
		};
		await hook.toolBefore(input, { args });
		await hook.taskMetadata({
			callID: input.callID,
			parentSessionID: input.sessionID,
			childSessionID: 'status-child',
		});
		await hook.toolAfter(
			{
				tool: 'update_task_status',
				sessionID: 'parent',
				callID: 'status-update',
				args: { task_id: '1.1', status: 'completed' },
			},
			{},
		);
		expect(
			getAuthorizedScopeBinding({
				directory,
				plan,
				taskId: '1.1',
				activeSessionId: 'status-child',
			}),
		).toBeNull();
		expect(ensureAgentSession('status-child').currentTaskId).toBeNull();
	});
});
