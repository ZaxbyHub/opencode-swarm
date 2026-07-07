/**
 * Tests for plan-aware resolveDelegatedPlanTaskId filtering (PR #961 tighten)
 *
 * Tests that resolveDelegatedPlanTaskId with knownPlanTaskIds correctly filters
 * out version-like numeric patterns that aren't actual plan task IDs.
 *
 * Key scenarios:
 * 1. Version-like N.M pattern in prompt but NOT in plan → filtered → not ambiguous
 * 2. Version-like N.M.P pattern in prompt but NOT in plan → filtered → not ambiguous
 * 3. Multiple N.M patterns, ALL in plan → ambiguous → blocked
 * 4. Multiple N.M patterns, some NOT in plan → filtered → not ambiguous
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { PluginConfig } from '../../../src/config';
import type { Plan } from '../../../src/config/plan-schema';
import { createDelegationGateHook } from '../../../src/hooks/delegation-gate';
import { ensureAgentSession, resetSwarmState } from '../../../src/state';
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
					files_touched: [],
				})),
			},
		],
	};
	fs.writeFileSync(
		path.join(dir, '.swarm', 'plan.json'),
		JSON.stringify(plan, null, 2),
	);
	// PR #1706: any coder-role Task dispatch made while .swarm/plan.json exists now
	// requires a plan-critic-approval ledger snapshot or the gate throws
	// PLAN_CRITIC_GATE_VIOLATION. Record the matching approval for THIS plan after
	// every write (including mid-test rewrites) so the tests exercise the intended
	// downstream logic (completion/reviewer gate + resolveDelegatedPlanTaskId
	// ambiguity filtering) instead of failing at the plan-critic precondition.
	await recordPlanCriticApproval(dir, plan);
}

async function callToolBefore(
	hook: ReturnType<typeof createDelegationGateHook>,
	tool: string,
	sessionID: string,
	args: Record<string, unknown>,
): Promise<void> {
	await hook.toolBefore(
		{ tool, sessionID, callID: `call-${Date.now()}` },
		{ args },
	);
}

describe('resolveDelegatedPlanTaskId — plan-aware filtering (PR #961 tighten)', () => {
	let tempDir: string;

	beforeEach(async () => {
		resetSwarmState();
		tempDir = makeTempProject('delegation-gate-plan-aware-');
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

	// ============================================================
	// Test 1: knownPlanTaskIds filters out version-like N.M patterns
	// "Continue task 1.1 using package version 3.4"
	// 3.4 is NOT in the plan → filtered out → returns 1.1 → same-task allowed
	// ============================================================
	describe('knownPlanTaskIds filters out version-like N.M patterns', () => {
		it('N.M version "3.4" not in plan → filtered → same-task retry allowed', async () => {
			const hook = createDelegationGateHook(makeConfig(), tempDir);
			const session = ensureAgentSession('test-session');
			session.taskWorkflowStates.set('1.1', 'tests_run');

			// Prompt: "Task 1.1" + "version 3.4"
			// Plan: {1.1, 1.2}
			// 3.4 is NOT in plan → filtered out
			// Only 1.1 remains → not ambiguous → allowingSameTaskRetry=true
			let threw = false;
			try {
				await callToolBefore(hook, 'Task', 'test-session', {
					subagent_type: 'mega_coder',
					prompt: 'Continue task 1.1 using package version 3.4',
				});
			} catch {
				threw = true;
			}

			expect(threw).toBe(false);
		});

		it('N.M version "2.5" not in plan → filtered → same-task allowed', async () => {
			const hook = createDelegationGateHook(makeConfig(), tempDir);
			const session = ensureAgentSession('test-session');
			session.taskWorkflowStates.set('1.1', 'tests_run');

			let threw = false;
			try {
				await callToolBefore(hook, 'Task', 'test-session', {
					subagent_type: 'mega_coder',
					prompt: 'Task 1.1 requires dependency 2.5',
				});
			} catch {
				threw = true;
			}

			expect(threw).toBe(false);
		});

		it('multiple N.M versions all filtered → single task ID remains', async () => {
			const hook = createDelegationGateHook(makeConfig(), tempDir);
			const session = ensureAgentSession('test-session');
			session.taskWorkflowStates.set('1.1', 'tests_run');

			// Both 3.4 and 2.5 are NOT in the plan → both filtered out
			let threw = false;
			try {
				await callToolBefore(hook, 'Task', 'test-session', {
					subagent_type: 'mega_coder',
					prompt: 'Task 1.1 requires versions 3.4 and 2.5',
				});
			} catch {
				threw = true;
			}

			expect(threw).toBe(false);
		});

		it('N.M version that IS in plan → NOT filtered → causes ambiguity', async () => {
			// Plan has 3.4 as a task
			await writePlanJson(tempDir, {
				tasks: [
					{ id: '1.1', status: 'pending' },
					{ id: '3.4', status: 'pending' }, // 3.4 IS in the plan
				],
			});

			const hook = createDelegationGateHook(makeConfig(), tempDir);
			const session = ensureAgentSession('test-session');
			session.taskWorkflowStates.set('1.1', 'tests_run');

			// With plan filtering: both 1.1 and 3.4 are in the plan
			// seen = {1.1, 3.4} → ambiguous → null → blocked
			let threw = false;
			try {
				await callToolBefore(hook, 'Task', 'test-session', {
					subagent_type: 'mega_coder',
					prompt: 'Task 1.1 requires version 3.4',
				});
			} catch {
				threw = true;
			}

			// Should throw — 3.4 IS in plan, creates ambiguity with 1.1
			expect(threw).toBe(true);
		});
	});

	// ============================================================
	// Test 2: knownPlanTaskIds filters out N.M.P version-like patterns
	// ============================================================
	describe('knownPlanTaskIds filters out N.M.P version-like patterns', () => {
		it('N.M.P version "3.4.5" not in plan → filtered → same-task allowed', async () => {
			const hook = createDelegationGateHook(makeConfig(), tempDir);
			const session = ensureAgentSession('test-session');
			session.taskWorkflowStates.set('1.1', 'tests_run');

			let threw = false;
			try {
				await callToolBefore(hook, 'Task', 'test-session', {
					subagent_type: 'mega_coder',
					prompt: 'Task 1.1 requires version 3.4.5',
				});
			} catch {
				threw = true;
			}

			expect(threw).toBe(false);
		});

		it('N.M.P version "1.2.3" not in plan → filtered → same-task allowed', async () => {
			const hook = createDelegationGateHook(makeConfig(), tempDir);
			const session = ensureAgentSession('test-session');
			session.taskWorkflowStates.set('1.1', 'tests_run');

			let threw = false;
			try {
				await callToolBefore(hook, 'Task', 'test-session', {
					subagent_type: 'mega_coder',
					prompt: 'Task 1.1 with version 1.2.3',
				});
			} catch {
				threw = true;
			}

			expect(threw).toBe(false);
		});
	});

	// ============================================================
	// Test 3: Ambiguity when multiple N.M patterns ALL in plan
	// ============================================================
	describe('ambiguity when multiple task IDs are all in plan', () => {
		it('prompt with 1.1 and 1.2 (both in plan) → ambiguous → blocks', async () => {
			const hook = createDelegationGateHook(makeConfig(), tempDir);
			const session = ensureAgentSession('test-session');
			session.taskWorkflowStates.set('1.1', 'tests_run');

			// Both 1.1 and 1.2 are in knownPlanTaskIds
			// seen = {1.1, 1.2} → size=2 → null → allowingSameTaskRetry=false
			let threw = false;
			try {
				await callToolBefore(hook, 'Task', 'test-session', {
					subagent_type: 'mega_coder',
					prompt: 'Work on task 1.1 and task 1.2',
				});
			} catch {
				threw = true;
			}

			expect(threw).toBe(true);
		});

		it('prompt with three plan task IDs → ambiguous → blocks', async () => {
			await writePlanJson(tempDir, {
				tasks: [
					{ id: '1.1', status: 'pending' },
					{ id: '1.2', status: 'pending' },
					{ id: '1.3', status: 'pending' },
				],
			});

			const hook = createDelegationGateHook(makeConfig(), tempDir);
			const session = ensureAgentSession('test-session');
			session.taskWorkflowStates.set('1.1', 'tests_run');

			let threw = false;
			try {
				await callToolBefore(hook, 'Task', 'test-session', {
					subagent_type: 'mega_coder',
					prompt: 'Tasks 1.1, 1.2, and 1.3 are related',
				});
			} catch {
				threw = true;
			}

			expect(threw).toBe(true);
		});
	});

	// ============================================================
	// Test 4: Non-plan patterns filtered, single plan task remains
	// ============================================================
	describe('non-plan patterns are filtered, leaving single plan task', () => {
		it('two N.M patterns, one NOT in plan → filtered → not ambiguous', async () => {
			const hook = createDelegationGateHook(makeConfig(), tempDir);
			const session = ensureAgentSession('test-session');
			session.taskWorkflowStates.set('1.1', 'tests_run');

			// 1.1 is in plan, 3.4 is NOT → 3.4 filtered out
			// Only 1.1 remains → not ambiguous
			let threw = false;
			try {
				await callToolBefore(hook, 'Task', 'test-session', {
					subagent_type: 'mega_coder',
					prompt: 'Task 1.1 with version 3.4',
				});
			} catch {
				threw = true;
			}

			expect(threw).toBe(false);
		});

		it('three N.M patterns, two NOT in plan → filtered → not ambiguous', async () => {
			const hook = createDelegationGateHook(makeConfig(), tempDir);
			const session = ensureAgentSession('test-session');
			session.taskWorkflowStates.set('1.1', 'tests_run');

			// 1.1 is in plan, 3.4 and 2.5 are NOT → both filtered out
			// Only 1.1 remains → not ambiguous
			let threw = false;
			try {
				await callToolBefore(hook, 'Task', 'test-session', {
					subagent_type: 'mega_coder',
					prompt: 'Task 1.1 with versions 3.4 and 2.5',
				});
			} catch {
				threw = true;
			}

			expect(threw).toBe(false);
		});
	});

	// ============================================================
	// Test 5: Integration — plan filtering enables correct same-task retry
	// ============================================================
	describe('integration: plan filtering enables correct same-task retry', () => {
		it('same-task retry with N.M version → NOT blocked (version filtered)', async () => {
			const hook = createDelegationGateHook(makeConfig(), tempDir);
			const session = ensureAgentSession('test-session');
			session.taskWorkflowStates.set('1.1', 'tests_run');

			// Same task 1.1 with version 3.4 in prompt
			// 3.4 filtered (not in plan), 1.1 remains → allowingSameTaskRetry=true
			let threw = false;
			try {
				await callToolBefore(hook, 'Task', 'test-session', {
					subagent_type: 'mega_coder',
					prompt: 'Continue task 1.1 using package 3.4',
				});
			} catch {
				threw = true;
			}

			expect(threw).toBe(false);
		});

		it('same-task retry with N.M.P version → NOT blocked (version filtered)', async () => {
			const hook = createDelegationGateHook(makeConfig(), tempDir);
			const session = ensureAgentSession('test-session');
			session.taskWorkflowStates.set('1.1', 'tests_run');

			let threw = false;
			try {
				await callToolBefore(hook, 'Task', 'test-session', {
					subagent_type: 'mega_coder',
					prompt: 'Task 1.1 version 1.2.3',
				});
			} catch {
				threw = true;
			}

			expect(threw).toBe(false);
		});

		it('different task with version → IS blocked (not same-task)', async () => {
			const hook = createDelegationGateHook(makeConfig(), tempDir);
			const session = ensureAgentSession('test-session');
			session.taskWorkflowStates.set('1.1', 'tests_run');

			// Task 1.2 (different) with version 3.4
			// 3.4 filtered, only 1.2 remains → requestedTaskId=1.2
			// taskAwaitingCompletion=1.1 → allowingSameTaskRetry=false → blocked
			let threw = false;
			try {
				await callToolBefore(hook, 'Task', 'test-session', {
					subagent_type: 'mega_coder',
					prompt: 'Task 1.2 with version 3.4',
				});
			} catch {
				threw = true;
			}

			expect(threw).toBe(true);
		});

		it('same-task with ambiguous multi-ID prompt → IS blocked (ambiguity)', async () => {
			const hook = createDelegationGateHook(makeConfig(), tempDir);
			const session = ensureAgentSession('test-session');
			session.taskWorkflowStates.set('1.1', 'tests_run');

			// Prompt mentions both 1.1 and 1.2 — ambiguous
			// requestedTaskId = null (ambiguous)
			// allowingSameTaskRetry: null === 1.1 → false → blocked
			let threw = false;
			try {
				await callToolBefore(hook, 'Task', 'test-session', {
					subagent_type: 'mega_coder',
					prompt: 'Tasks 1.1 and 1.2',
				});
			} catch {
				threw = true;
			}

			expect(threw).toBe(true);
		});
	});
});
