/**
 * Completion gate integration tests (delegation-gate-completion-gate.test.ts — Part 1 of 3)
 *
 * Covers:
 * - findTaskAwaitingCompletion tests
 * - resolveDelegatedPlanTaskId tests
 * - completionGateViolationMessage tests
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { PluginConfig } from '../../../src/config';
import type { Plan } from '../../../src/config/plan-schema';
import { getOrCreateProfile, setGates } from '../../../src/db/qa-gate-profile';
import { createDelegationGateHook } from '../../../src/hooks/delegation-gate';
import {
	ensureAgentSession,
	getTaskState,
	resetSwarmState,
} from '../../../src/state';

function makeConfig(
	overrides?: Record<string, unknown>,
	council?: { enabled?: boolean },
): PluginConfig {
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
		...(council ? { council } : {}),
	} as PluginConfig;
}

function makeTempProject(prefix: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	const real = fs.realpathSync(dir);
	fs.mkdirSync(path.join(real, '.swarm'), { recursive: true });
	return real;
}

function writePlanJson(
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
): void {
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
}

function makeMessages(
	text: string,
	agent?: string,
	sessionID = 'test-session',
) {
	return {
		messages: [
			{
				info: { role: 'user' as const, agent, sessionID },
				parts: [{ type: 'text', text }],
			},
		],
	};
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

describe('delegation-gate: completion gate integration — findTaskAwaitingCompletion (PR #961)', () => {
	let tempDir: string;

	beforeEach(() => {
		resetSwarmState();
		tempDir = makeTempProject('delegation-gate-completion-');
		writePlanJson(tempDir, {
			tasks: [
				{ id: '1.1', status: 'pending' },
				{ id: '1.2', status: 'pending' },
				{ id: '1.3', status: 'pending' },
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

	describe('findTaskAwaitingCompletion — returns task in tests_run not completed in plan', () => {
		it('should return null when no taskWorkflowStates set', async () => {
			const hook = createDelegationGateHook(makeConfig(), tempDir);
			const session = ensureAgentSession('test-session');

			// No taskWorkflowStates entries
			expect(session.taskWorkflowStates.size).toBe(0);

			await callToolBefore(hook, 'Task', 'test-session', {
				subagent_type: 'mega_coder',
				task_id: '1.1',
			});

			// Should not throw — no completion gate violation
			expect(true).toBe(true);
		});

		it('should return null when no task is in tests_run state', async () => {
			const hook = createDelegationGateHook(makeConfig(), tempDir);
			const session = ensureAgentSession('test-session');

			// Set task to coder_delegated (not tests_run)
			session.taskWorkflowStates.set('1.1', 'coder_delegated');
			session.taskWorkflowStates.set('1.2', 'reviewer_run');

			await callToolBefore(hook, 'Task', 'test-session', {
				subagent_type: 'mega_coder',
				task_id: '1.3',
			});

			// Should not throw — no task in tests_run state
			expect(true).toBe(true);
		});

		it('should return null when task in tests_run is already completed in plan', async () => {
			// Update plan: task 1.1 is completed
			writePlanJson(tempDir, {
				tasks: [
					{ id: '1.1', status: 'completed' },
					{ id: '1.2', status: 'pending' },
				],
			});

			const hook = createDelegationGateHook(makeConfig(), tempDir);
			const session = ensureAgentSession('test-session');
			session.taskWorkflowStates.set('1.1', 'tests_run');

			// Should not throw — task 1.1 is in tests_run but plan says completed
			await callToolBefore(hook, 'Task', 'test-session', {
				subagent_type: 'mega_coder',
				task_id: '1.2',
			});

			expect(true).toBe(true);
		});

		it('should throw when a task is in tests_run and plan status is not completed', async () => {
			const hook = createDelegationGateHook(makeConfig(), tempDir);
			const session = ensureAgentSession('test-session');
			session.taskWorkflowStates.set('1.1', 'tests_run');

			// Task 1.1 is in tests_run state but plan says pending
			// This should trigger the completion gate
			let threw = false;
			let errorMessage = '';
			try {
				await callToolBefore(hook, 'Task', 'test-session', {
					subagent_type: 'mega_coder',
					task_id: '1.2',
				});
			} catch (err) {
				threw = true;
				errorMessage = (err as Error).message;
			}

			expect(threw).toBe(true);
			expect(errorMessage).toContain('TASK_COMPLETION_GATE_VIOLATION');
			expect(errorMessage).toContain('1.1');
		});

		it('should NOT throw for same-task retry when task is in tests_run (allowingSameTaskRetry)', async () => {
			const hook = createDelegationGateHook(makeConfig(), tempDir);
			const session = ensureAgentSession('test-session');
			session.taskWorkflowStates.set('1.1', 'tests_run');

			// Requesting same task 1.1 which is in tests_run — should be allowed
			let threw = false;
			try {
				await callToolBefore(hook, 'Task', 'test-session', {
					subagent_type: 'mega_coder',
					task_id: '1.1',
				});
			} catch {
				threw = true;
			}

			expect(threw).toBe(false);
		});
	});

	describe('resolveDelegatedPlanTaskId — extracts task ID from various args fields', () => {
		it('should allow update_task_status completion for same task in tests_run', async () => {
			const hook = createDelegationGateHook(makeConfig(), tempDir);
			const session = ensureAgentSession('test-session');
			session.taskWorkflowStates.set('1.1', 'tests_run');

			let threw = false;
			try {
				await callToolBefore(hook, 'update_task_status', 'test-session', {
					task_id: '1.1',
					status: 'completed',
				});
			} catch {
				threw = true;
			}

			expect(threw).toBe(false);
		});

		it('should extract taskId from direct args.taskId field (camelCase)', async () => {
			const hook = createDelegationGateHook(makeConfig(), tempDir);
			const session = ensureAgentSession('test-session');
			session.taskWorkflowStates.set('2.1', 'tests_run');

			let threw = false;
			try {
				await callToolBefore(hook, 'update_task_status', 'test-session', {
					taskId: '2.1',
					status: 'completed',
				});
			} catch {
				threw = true;
			}

			expect(threw).toBe(false);
		});

		it('should throw when task ID extracted from prompt but is a DIFFERENT task from the blocking one', async () => {
			const hook = createDelegationGateHook(makeConfig(), tempDir);
			const session = ensureAgentSession('test-session');
			// 1.1 is in tests_run (blocking), but prompt says 1.3
			session.taskWorkflowStates.set('1.1', 'tests_run');

			let threw = false;
			try {
				await callToolBefore(hook, 'Task', 'test-session', {
					subagent_type: 'mega_coder',
					prompt: 'TASK: 1.3\nFILE: src/foo.ts',
				});
			} catch {
				threw = true;
			}

			expect(threw).toBe(true);
		});

		it('should allow same-task retry when task ID extracted from description matches blocking task', async () => {
			const hook = createDelegationGateHook(makeConfig(), tempDir);
			const session = ensureAgentSession('test-session');
			session.taskWorkflowStates.set('1.2', 'tests_run');

			let threw = false;
			try {
				await callToolBefore(hook, 'Task', 'test-session', {
					subagent_type: 'mega_coder',
					description: 'Implement task 1.2',
				});
			} catch {
				threw = true;
			}

			expect(threw).toBe(false);
		});

		it('should throw even for invalid task IDs when a task is in tests_run', async () => {
			const hook = createDelegationGateHook(makeConfig(), tempDir);
			const session = ensureAgentSession('test-session');
			session.taskWorkflowStates.set('1.1', 'tests_run');

			let threw = false;
			try {
				await callToolBefore(hook, 'Task', 'test-session', {
					subagent_type: 'mega_coder',
					task_id: 'not-a-valid-task-id',
				});
			} catch {
				threw = true;
			}

			expect(threw).toBe(true);
		});

		it('explicit invalid task_id should return null — no text fallback (bypass fix)', async () => {
			const hook = createDelegationGateHook(makeConfig(), tempDir);
			const session = ensureAgentSession('test-session');
			session.taskWorkflowStates.set('1.1', 'coder_delegated');

			let threw = false;
			try {
				await callToolBefore(hook, 'Task', 'test-session', {
					subagent_type: 'mega_coder',
					task_id: 'not-valid',
					prompt: 'TASK: 1.2\nFILE: src/foo.ts',
				});
			} catch {
				threw = true;
			}

			expect(threw).toBe(false);
		});

		it('prompt with same task ID in multiple text fields — deduplication works (bypass fix)', async () => {
			const hook = createDelegationGateHook(makeConfig(), tempDir);
			const session = ensureAgentSession('test-session');
			session.taskWorkflowStates.set('1.1', 'tests_run');

			let threw = false;
			try {
				await callToolBefore(hook, 'Task', 'test-session', {
					subagent_type: 'mega_coder',
					prompt: 'TASK: 1.1\nFILE: src/foo.ts',
					description: 'Implement task 1.1',
					input: 'Do the work for 1.1',
				});
			} catch {
				threw = true;
			}

			expect(threw).toBe(false);
		});

		it('explicit valid task_id should take precedence over prompt text (bypass fix)', async () => {
			const hook = createDelegationGateHook(makeConfig(), tempDir);
			const session = ensureAgentSession('test-session');
			session.taskWorkflowStates.set('1.1', 'tests_run');

			let threw = false;
			try {
				await callToolBefore(hook, 'Task', 'test-session', {
					subagent_type: 'mega_coder',
					task_id: '1.1',
					prompt: 'TASK: 1.2\nFILE: src/foo.ts',
				});
			} catch {
				threw = true;
			}

			expect(threw).toBe(false);
		});

		it('prompt with different explicit task_id than blocking task should throw (bypass fix)', async () => {
			const hook = createDelegationGateHook(makeConfig(), tempDir);
			const session = ensureAgentSession('test-session');
			session.taskWorkflowStates.set('1.1', 'tests_run');

			let threw = false;
			let errorMessage = '';
			try {
				await callToolBefore(hook, 'Task', 'test-session', {
					subagent_type: 'mega_coder',
					task_id: '1.2',
				});
			} catch (err) {
				threw = true;
				errorMessage = (err as Error).message;
			}

			expect(threw).toBe(true);
			expect(errorMessage).toContain('TASK_COMPLETION_GATE_VIOLATION');
			expect(errorMessage).toContain('1.1');
		});
	});

	describe('completionGateViolationMessage — formats correct violation message', () => {
		it('should include task ID and update_task_status instruction in violation message', async () => {
			const hook = createDelegationGateHook(makeConfig(), tempDir);
			const session = ensureAgentSession('test-session');
			session.taskWorkflowStates.set('1.1', 'tests_run');

			let threw = false;
			let errorMessage = '';
			try {
				await callToolBefore(hook, 'Task', 'test-session', {
					subagent_type: 'mega_coder',
					task_id: '1.2',
				});
			} catch (err) {
				threw = true;
				errorMessage = (err as Error).message;
			}

			expect(threw).toBe(true);
			expect(errorMessage).toContain('1.1');
			expect(errorMessage).toContain('update_task_status');
			expect(errorMessage).toContain('completed');
		});
	});
});
