/**
 * Tests for completion gate integration in delegation-gate.ts (PR #961)
 *
 * Tests the four new helper functions and three integration points:
 * 1. getPlanTaskStatus — plan task status lookup
 * 2. resolveDelegatedPlanTaskId — task ID extraction from tool args
 * 3. findTaskAwaitingCompletion — find tasks in tests_run not completed
 * 4. completionGateViolationMessage — violation message formatting
 * 5. toolBefore completion gate — blocks ALL tools when task awaits completion
 * 6. toolAfter state advancement — advances state on update_task_status completion
 * 7. messagesTransform advisory — surfaces completion requirement message
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
	advanceTaskState,
	ensureAgentSession,
	getTaskState,
	resetSwarmState,
	startAgentSession,
	swarmState,
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

// Helper to call toolBefore completion gate
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

// Helper to call toolAfter for update_task_status tool
async function callToolAfterCompletion(
	hook: ReturnType<typeof createDelegationGateHook>,
	sessionID: string,
	args: Record<string, unknown>,
): Promise<void> {
	await hook.toolAfter(
		{
			tool: 'tool.execute.update_task_status',
			sessionID,
			callID: `call-${Date.now()}`,
			args,
		},
		{},
	);
}

// Helper to call toolAfter for Task tool
async function callToolAfterTask(
	hook: ReturnType<typeof createDelegationGateHook>,
	sessionID: string,
	args: Record<string, unknown>,
): Promise<void> {
	await hook.toolAfter(
		{
			tool: 'tool.execute.Task',
			sessionID,
			callID: `call-${Date.now()}`,
			args,
		},
		{},
	);
}

describe('delegation-gate: completion gate integration (PR #961)', () => {
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

	// ============================================================
	// getPlanTaskStatus tests — verified via findTaskAwaitingCompletion
	// ============================================================

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
			// (findTaskAwaitingCompletion returns null when no states set)
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
			// (allowingSameTaskRetry = requestedTaskId === taskAwaitingCompletion)
			let threw = false;
			try {
				await callToolBefore(hook, 'Task', 'test-session', {
					subagent_type: 'mega_coder',
					task_id: '1.1',
				});
			} catch {
				threw = true;
			}

			// Should not throw — same task retry is allowed
			expect(threw).toBe(false);
		});
	});

	// ============================================================
	// resolveDelegatedPlanTaskId — verified via toolBefore gate behavior
	// ============================================================

	describe('resolveDelegatedPlanTaskId — extracts task ID from various args fields', () => {
		it('should allow update_task_status completion for same task in tests_run', async () => {
			const hook = createDelegationGateHook(makeConfig(), tempDir);
			const session = ensureAgentSession('test-session');
			session.taskWorkflowStates.set('1.1', 'tests_run');

			// task_id in direct args — should allow same-task completion
			let threw = false;
			try {
				await callToolBefore(hook, 'update_task_status', 'test-session', {
					task_id: '1.1',
					status: 'completed',
				});
			} catch {
				threw = true;
			}

			// Should not throw — same task is allowed for update_task_status completion
			expect(threw).toBe(false);
		});

		it('should extract taskId from direct args.taskId field (camelCase)', async () => {
			const hook = createDelegationGateHook(makeConfig(), tempDir);
			const session = ensureAgentSession('test-session');
			session.taskWorkflowStates.set('2.1', 'tests_run');

			// taskId camelCase variant — should allow same-task
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

			// Task ID '1.3' extracted from prompt is DIFFERENT from blocking task '1.1'
			let threw = false;
			try {
				await callToolBefore(hook, 'Task', 'test-session', {
					subagent_type: 'mega_coder',
					prompt: 'TASK: 1.3\nFILE: src/foo.ts',
				});
			} catch {
				threw = true;
			}

			// Should throw because 1.3 != 1.1 (allowingSameTaskRetry=false)
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

			// Same-task retry: requested task 1.2 matches blocking task 1.2 → allowed
			expect(threw).toBe(false);
		});

		it('should throw even for invalid task IDs when a task is in tests_run', async () => {
			const hook = createDelegationGateHook(makeConfig(), tempDir);
			const session = ensureAgentSession('test-session');
			session.taskWorkflowStates.set('1.1', 'tests_run');

			// Invalid task ID returns null from resolveDelegatedPlanTaskId
			// But completion gate still fires because 1.1 is in tests_run
			// Since requestedTaskId=null, allowingSameTaskRetry=false (null !== '1.1')
			let threw = false;
			try {
				await callToolBefore(hook, 'Task', 'test-session', {
					subagent_type: 'mega_coder',
					task_id: 'not-a-valid-task-id',
				});
			} catch {
				threw = true;
			}

			// Should throw because the completion gate fires when any task is in tests_run
			expect(threw).toBe(true);
		});

		// ============================================================
		// resolveDelegatedPlanTaskId bypass-fix tests (PR #961 tighten)
		// ============================================================

		it('explicit invalid task_id should return null — no text fallback (bypass fix)', async () => {
			const hook = createDelegationGateHook(makeConfig(), tempDir);
			const session = ensureAgentSession('test-session');
			// 1.1 is NOT in tests_run, so no completion gate firing
			session.taskWorkflowStates.set('1.1', 'coder_delegated');

			// Invalid task_id provided — should return null, not fall back to prompt
			// Prompt mentions 1.2 but explicit invalid task_id should take precedence
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

			// Should NOT throw because 1.1 is not in tests_run
			// The bypass fix: explicit invalid task_id returns null (fail closed)
			// and doesn't fall back to extracting from prompt text
			expect(threw).toBe(false);
		});

		it('prompt with same task ID in multiple text fields — deduplication works (bypass fix)', async () => {
			const hook = createDelegationGateHook(makeConfig(), tempDir);
			const session = ensureAgentSession('test-session');
			// 1.1 is in tests_run (blocking), prompt has 1.1 in multiple places
			session.taskWorkflowStates.set('1.1', 'tests_run');

			// Both prompt and description mention 1.1 — Set deduplication should yield 1
			// AllowingSameTaskRetry: requestedTaskId === taskAwaitingCompletion (1.1 === 1.1) → true
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

			// Should NOT throw because requestedTaskId=1.1 === taskAwaitingCompletion=1.1
			// (allowingSameTaskRetry=true, so completion gate allows same task)
			expect(threw).toBe(false);
		});

		it('explicit valid task_id should take precedence over prompt text (bypass fix)', async () => {
			const hook = createDelegationGateHook(makeConfig(), tempDir);
			const session = ensureAgentSession('test-session');
			// 1.1 is in tests_run (blocking), but explicit task_id=1.1 is provided
			session.taskWorkflowStates.set('1.1', 'tests_run');

			// Explicit task_id=1.1 should win over prompt mentioning 1.2
			// allowingSameTaskRetry: requestedTaskId=1.1 === taskAwaitingCompletion=1.1 → true
			let threw = false;
			try {
				await callToolBefore(hook, 'Task', 'test-session', {
					subagent_type: 'mega_coder',
					task_id: '1.1', // Explicit valid — should take precedence
					prompt: 'TASK: 1.2\nFILE: src/foo.ts', // Different ID in prompt
				});
			} catch {
				threw = true;
			}

			// Should NOT throw because explicit task_id takes precedence
			expect(threw).toBe(false);
		});

		it('prompt with different explicit task_id than blocking task should throw (bypass fix)', async () => {
			const hook = createDelegationGateHook(makeConfig(), tempDir);
			const session = ensureAgentSession('test-session');
			// 1.1 is in tests_run (blocking), but explicit task_id=1.2 is provided
			session.taskWorkflowStates.set('1.1', 'tests_run');

			// Explicit task_id=1.2 is DIFFERENT from blocking task 1.1
			// allowingSameTaskRetry: requestedTaskId=1.2 !== taskAwaitingCompletion=1.1 → false
			// allowCompletionUpdate: false (not update_task_status with status=completed)
			// → should throw
			let threw = false;
			let errorMessage = '';
			try {
				await callToolBefore(hook, 'Task', 'test-session', {
					subagent_type: 'mega_coder',
					task_id: '1.2', // Different from blocking task 1.1
				});
			} catch (err) {
				threw = true;
				errorMessage = (err as Error).message;
			}

			// Should throw because explicit task_id differs from blocking task
			expect(threw).toBe(true);
			expect(errorMessage).toContain('TASK_COMPLETION_GATE_VIOLATION');
			expect(errorMessage).toContain('1.1'); // The blocking task
		});
	});

	// ============================================================
	// completionGateViolationMessage
	// ============================================================

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
			expect(errorMessage).toContain('1.1'); // The blocking task
			expect(errorMessage).toContain('update_task_status');
			expect(errorMessage).toContain('completed');
		});
	});

	// ============================================================
	// toolBefore completion gate — blocks new tasks
	// ============================================================

	describe('toolBefore completion gate — blocks ALL tools when task awaits completion', () => {
		it('should block Task tool for new task when 1.1 is in tests_run', async () => {
			const hook = createDelegationGateHook(makeConfig(), tempDir);
			const session = ensureAgentSession('test-session');
			session.taskWorkflowStates.set('1.1', 'tests_run');

			let threw = false;
			try {
				await callToolBefore(hook, 'Task', 'test-session', {
					subagent_type: 'mega_coder',
					task_id: '1.2',
				});
			} catch {
				threw = true;
			}

			expect(threw).toBe(true);
		});

		it('should block declare_scope when task awaits completion', async () => {
			const hook = createDelegationGateHook(makeConfig(), tempDir);
			const session = ensureAgentSession('test-session');
			session.taskWorkflowStates.set('1.1', 'tests_run');

			let threw = false;
			try {
				await callToolBefore(hook, 'declare_scope', 'test-session', {
					task_id: '1.2',
					files: ['src/a.ts'],
				});
			} catch {
				threw = true;
			}

			expect(threw).toBe(true);
		});

		it('should block update_task_status for a different task when completion is pending', async () => {
			const hook = createDelegationGateHook(makeConfig(), tempDir);
			const session = ensureAgentSession('test-session');
			session.taskWorkflowStates.set('1.1', 'tests_run');

			// Trying to complete a different task (1.2) should be blocked
			let threw = false;
			try {
				await callToolBefore(hook, 'update_task_status', 'test-session', {
					task_id: '1.2',
					status: 'completed',
				});
			} catch {
				threw = true;
			}

			expect(threw).toBe(true);
		});

		it('should allow update_task_status completion for the same task awaiting completion', async () => {
			const hook = createDelegationGateHook(makeConfig(), tempDir);
			const session = ensureAgentSession('test-session');
			session.taskWorkflowStates.set('1.1', 'tests_run');

			// Same task 1.1 with status=completed should be allowed through
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

		it('should allow same-task retry (Task tool) for the task awaiting completion', async () => {
			const hook = createDelegationGateHook(makeConfig(), tempDir);
			const session = ensureAgentSession('test-session');
			session.taskWorkflowStates.set('1.1', 'tests_run');

			// Same task 1.1 retry should be allowed
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

		it('should NOT block when no task is in tests_run state', async () => {
			const hook = createDelegationGateHook(makeConfig(), tempDir);
			const session = ensureAgentSession('test-session');
			session.taskWorkflowStates.set('1.1', 'coder_delegated'); // Not tests_run

			let threw = false;
			try {
				await callToolBefore(hook, 'Task', 'test-session', {
					subagent_type: 'mega_coder',
					task_id: '1.2',
				});
			} catch {
				threw = true;
			}

			expect(threw).toBe(false);
		});

		it('should block when first task in tests_run but requesting second task', async () => {
			const hook = createDelegationGateHook(makeConfig(), tempDir);
			const session = ensureAgentSession('test-session');
			session.taskWorkflowStates.set('1.1', 'tests_run');

			// 1.1 is waiting for completion, trying to start 1.2
			let threw = false;
			try {
				await callToolBefore(hook, 'Task', 'test-session', {
					subagent_type: 'mega_coder',
					task_id: '1.2',
				});
			} catch {
				threw = true;
			}

			expect(threw).toBe(true);
		});

		it('should block update_task_status(in_progress) for a different task when current task awaits completion', async () => {
			const hook = createDelegationGateHook(makeConfig(), tempDir);
			const session = ensureAgentSession('test-session');
			session.taskWorkflowStates.set('1.1', 'tests_run');

			let threw = false;
			try {
				await callToolBefore(hook, 'update_task_status', 'test-session', {
					task_id: '1.2',
					status: 'in_progress',
				});
			} catch {
				threw = true;
			}

			// The completion gate blocks all tool calls for a different task (1.2)
			// when the current task (1.1) hasn't been durably marked completed.
			expect(threw).toBe(true);
		});
	});

	// ============================================================
	// toolAfter state advancement
	// ============================================================

	describe('toolAfter — advances state when update_task_status marks task completed', () => {
		it('should advance task state to complete when update_task_status is called with status=completed', async () => {
			const hook = createDelegationGateHook(makeConfig(), tempDir);
			const session = ensureAgentSession('test-session');
			session.taskWorkflowStates.set('1.1', 'tests_run');

			await callToolAfterCompletion(hook, 'test-session', {
				task_id: '1.1',
				status: 'completed',
			});

			// State should advance to complete
			expect(getTaskState(session, '1.1')).toBe('complete');
		});

		it('should advance state via toolAfter when task_id is camelCase', async () => {
			const hook = createDelegationGateHook(makeConfig(), tempDir);
			const session = ensureAgentSession('test-session');
			session.taskWorkflowStates.set('1.2', 'tests_run');

			await callToolAfterCompletion(hook, 'test-session', {
				taskId: '1.2',
				status: 'completed',
			});

			expect(getTaskState(session, '1.2')).toBe('complete');
		});

		it('should NOT advance state when status is not completed', async () => {
			const hook = createDelegationGateHook(makeConfig(), tempDir);
			const session = ensureAgentSession('test-session');
			session.taskWorkflowStates.set('1.1', 'tests_run');

			await callToolAfterCompletion(hook, 'test-session', {
				task_id: '1.1',
				status: 'in_progress', // Not 'completed'
			});

			// State should remain at tests_run (not advanced)
			expect(getTaskState(session, '1.1')).toBe('tests_run');
		});

		it('should NOT crash when task_id is not a valid task ID', async () => {
			const hook = createDelegationGateHook(makeConfig(), tempDir);
			const session = ensureAgentSession('test-session');
			session.taskWorkflowStates.set('1.1', 'tests_run');

			// Invalid task ID should not crash
			await callToolAfterCompletion(hook, 'test-session', {
				task_id: 'not-a-valid-id',
				status: 'completed',
			});

			// State should remain unchanged
			expect(getTaskState(session, '1.1')).toBe('tests_run');
		});

		it('should advance task state from tests_run to complete after full QA cycle', async () => {
			const hook = createDelegationGateHook(makeConfig(), tempDir);
			const session = ensureAgentSession('test-session');

			// Simulate: task 1.1 has completed reviewer + test_engineer (tests_run)
			session.taskWorkflowStates.set('1.1', 'tests_run');

			// Architect calls update_task_status to mark as completed
			await callToolAfterCompletion(hook, 'test-session', {
				task_id: '1.1',
				status: 'completed',
			});

			// State should be complete
			expect(getTaskState(session, '1.1')).toBe('complete');
		});
	});

	// ============================================================
	// messagesTransform advisory
	// ============================================================

	describe('messagesTransform — surfaces advisory when task awaits completion', () => {
		it('should inject advisory message when task is in tests_run and not completed in plan', async () => {
			// Plan: 1.1 is pending (not completed)
			writePlanJson(tempDir, {
				tasks: [{ id: '1.1', status: 'pending' }],
			});

			const hook = createDelegationGateHook(makeConfig(), tempDir);
			const session = ensureAgentSession('test-session');
			session.taskWorkflowStates.set('1.1', 'tests_run');

			const messages = makeMessages('TASK: Continue work', 'architect');

			await hook.messagesTransform({}, messages);

			const systemMessages = messages.messages.filter(
				(m) => m?.info?.role === 'system',
			);
			const systemText = systemMessages
				.map((m) => m.parts?.[0]?.text ?? '')
				.join('\n');

			expect(systemText).toContain('1.1');
			expect(systemText).toContain('update_task_status');
		});

		it('should inject TASK COMPLETION REQUIRED advisory with task ID', async () => {
			writePlanJson(tempDir, {
				tasks: [{ id: '2.5', status: 'in_progress' }],
			});

			const hook = createDelegationGateHook(makeConfig(), tempDir);
			const session = ensureAgentSession('test-session');
			session.taskWorkflowStates.set('2.5', 'tests_run');

			const messages = makeMessages('TASK: Next task', 'architect');

			await hook.messagesTransform({}, messages);

			const systemMessages = messages.messages.filter(
				(m) => m?.info?.role === 'system',
			);
			const systemText = systemMessages
				.map((m) => m.parts?.[0]?.text ?? '')
				.join('\n');

			expect(systemText).toContain('TASK COMPLETION REQUIRED');
			expect(systemText).toContain('2.5');
		});

		it('should NOT inject completion advisory when no task is in tests_run', async () => {
			const hook = createDelegationGateHook(makeConfig(), tempDir);
			const session = ensureAgentSession('test-session');
			// Set task to a state other than tests_run
			session.taskWorkflowStates.set('1.1', 'coder_delegated');

			const messages = makeMessages('TASK: Work', 'architect');

			await hook.messagesTransform({}, messages);

			const systemMessages = messages.messages.filter(
				(m) => m?.info?.role === 'system',
			);
			const systemText = systemMessages
				.map((m) => m.parts?.[0]?.text ?? '')
				.join('\n');

			// Should NOT contain TASK COMPLETION REQUIRED
			expect(systemText).not.toContain('TASK COMPLETION REQUIRED');
		});

		it('should inject advisory ONLY for task in tests_run state', async () => {
			const hook = createDelegationGateHook(makeConfig(), tempDir);
			const session = ensureAgentSession('test-session');

			// 1.1 is in tests_run (should trigger advisory)
			session.taskWorkflowStates.set('1.1', 'tests_run');
			// 1.2 is in coder_delegated (should NOT trigger)
			session.taskWorkflowStates.set('1.2', 'coder_delegated');

			const messages = makeMessages('TASK: Continue', 'architect');

			await hook.messagesTransform({}, messages);

			const systemMessages = messages.messages.filter(
				(m) => m?.info?.role === 'system',
			);
			const systemText = systemMessages
				.map((m) => m.parts?.[0]?.text ?? '')
				.join('\n');

			// Should contain advisory for 1.1 (in tests_run)
			expect(systemText).toContain('1.1');
			expect(systemText).toContain('update_task_status');
		});

		it('should take PRIORITY over lastGate guidance in messagesTransform', async () => {
			writePlanJson(tempDir, {
				tasks: [{ id: '1.1', status: 'pending' }],
			});

			const hook = createDelegationGateHook(makeConfig(), tempDir);
			const session = ensureAgentSession('test-session');
			session.taskWorkflowStates.set('1.1', 'tests_run');
			session.lastGateOutcome = {
				gate: 'lint',
				taskId: '1.1',
				passed: true,
				timestamp: Date.now(),
			};

			const messages = makeMessages('TASK: Continue', 'architect');

			await hook.messagesTransform({}, messages);

			const systemMessages = messages.messages.filter(
				(m) => m?.info?.role === 'system',
			);
			const systemText = systemMessages
				.map((m) => m.parts?.[0]?.text ?? '')
				.join('\n');

			// Completion message takes PRIORITY over lastGate
			// The guidance starts with "[TASK COMPLETION REQUIRED]" not "[Last gate:]"
			expect(systemText).toContain('TASK COMPLETION REQUIRED');
			expect(systemText).not.toContain('[Last gate:');
		});

		it('should handle missing plan.json gracefully (advisory not injected)', async () => {
			// Remove the .swarm directory to simulate missing plan.json
			fs.rmSync(path.join(tempDir, '.swarm'), { recursive: true, force: true });

			const hook = createDelegationGateHook(makeConfig(), tempDir);
			const session = ensureAgentSession('test-session');
			session.taskWorkflowStates.set('1.1', 'tests_run');

			const messages = makeMessages('TASK: Work', 'architect');

			// Should not throw
			await hook.messagesTransform({}, messages);

			const systemMessages = messages.messages.filter(
				(m) => m?.info?.role === 'system',
			);
			const systemText = systemMessages
				.map((m) => m.parts?.[0]?.text ?? '')
				.join('\n');

			// No completion advisory when plan.json is missing
			expect(systemText).not.toContain('TASK COMPLETION REQUIRED');
		});
	});

	// ============================================================
	// Integration: full completion gate flow
	// ============================================================

	describe('integration: full completion gate flow', () => {
		it('should allow the full flow: tests_run → update_task_status completion → next task', async () => {
			const hook = createDelegationGateHook(makeConfig(), tempDir);
			const session = ensureAgentSession('test-session');

			// Step 1: Task 1.1 is in tests_run (after reviewer + test_engineer completed)
			session.taskWorkflowStates.set('1.1', 'tests_run');

			// Step 2: Architect tries to start a new task — should be blocked
			let threw = false;
			try {
				await callToolBefore(hook, 'Task', 'test-session', {
					subagent_type: 'mega_coder',
					task_id: '1.2',
				});
			} catch {
				threw = true;
			}
			expect(threw).toBe(true);

			// Step 3: Architect marks 1.1 as completed — should be allowed by toolBefore
			threw = false;
			try {
				await callToolBefore(hook, 'update_task_status', 'test-session', {
					task_id: '1.1',
					status: 'completed',
				});
			} catch {
				threw = true;
			}
			expect(threw).toBe(false);

			// Step 4: toolAfter advances state
			await callToolAfterCompletion(hook, 'test-session', {
				task_id: '1.1',
				status: 'completed',
			});

			expect(getTaskState(session, '1.1')).toBe('complete');

			// Step 5: Now task 1.2 can start (no task in tests_run blocking it)
			threw = false;
			try {
				await callToolBefore(hook, 'Task', 'test-session', {
					subagent_type: 'mega_coder',
					task_id: '1.2',
				});
			} catch {
				threw = true;
			}
			expect(threw).toBe(false);
		});

		it('should handle multiple tasks in tests_run state — blocks next new task', async () => {
			const hook = createDelegationGateHook(makeConfig(), tempDir);
			const session = ensureAgentSession('test-session');

			// Two tasks in tests_run
			session.taskWorkflowStates.set('1.1', 'tests_run');
			session.taskWorkflowStates.set('1.2', 'tests_run');

			// Trying to start 1.3 should be blocked
			let threw = false;
			try {
				await callToolBefore(hook, 'Task', 'test-session', {
					subagent_type: 'mega_coder',
					task_id: '1.3',
				});
			} catch {
				threw = true;
			}
			expect(threw).toBe(true);
		});

		it('should allow completing one task while another remains in tests_run', async () => {
			const hook = createDelegationGateHook(makeConfig(), tempDir);
			const session = ensureAgentSession('test-session');

			session.taskWorkflowStates.set('1.1', 'tests_run');
			session.taskWorkflowStates.set('1.2', 'tests_run');

			// Complete 1.1
			await callToolAfterCompletion(hook, 'test-session', {
				task_id: '1.1',
				status: 'completed',
			});

			expect(getTaskState(session, '1.1')).toBe('complete');
			// 1.2 is still in tests_run, so 1.3 should still be blocked
			let threw = false;
			try {
				await callToolBefore(hook, 'Task', 'test-session', {
					subagent_type: 'mega_coder',
					task_id: '1.3',
				});
			} catch {
				threw = true;
			}
			expect(threw).toBe(true);
		});
	});

	// ============================================================
	// Edge cases
	// ============================================================

	describe('edge cases: completion gate boundary conditions', () => {
		it('should handle undefined sessionID gracefully (no throw)', async () => {
			const hook = createDelegationGateHook(makeConfig(), tempDir);

			await callToolBefore(hook, 'Task', '', {
				subagent_type: 'mega_coder',
				task_id: '1.1',
			});

			expect(true).toBe(true);
		});

		it('should handle null args gracefully', async () => {
			const hook = createDelegationGateHook(makeConfig(), tempDir);
			const session = ensureAgentSession('test-session');
			session.taskWorkflowStates.set('1.1', 'tests_run');

			await hook.toolBefore(
				{ tool: 'Task', sessionID: 'test-session', callID: 'call-1' },
				{ args: null as unknown },
			);

			expect(true).toBe(true);
		});

		it('should throw when empty args but a task is in tests_run', async () => {
			const hook = createDelegationGateHook(makeConfig(), tempDir);
			const session = ensureAgentSession('test-session');
			session.taskWorkflowStates.set('1.1', 'tests_run');

			// Empty args — no task ID resolved, so allowingSameTaskRetry=false
			// Completion gate fires because 1.1 is in tests_run
			let threw = false;
			try {
				await callToolBefore(hook, 'Task', 'test-session', {});
			} catch {
				threw = true;
			}

			expect(threw).toBe(true);
		});

		it('should not interfere with tasks that are completed in plan', async () => {
			writePlanJson(tempDir, {
				tasks: [
					{ id: '1.1', status: 'completed' }, // Already done
					{ id: '1.2', status: 'pending' },
				],
			});

			const hook = createDelegationGateHook(makeConfig(), tempDir);
			const session = ensureAgentSession('test-session');

			// Even if in-memory state incorrectly has 1.1 as tests_run,
			// plan status is completed so it should be skipped
			session.taskWorkflowStates.set('1.1', 'tests_run');

			// 1.2 should be allowed (1.1 is completed in plan, not blocking)
			let threw = false;
			try {
				await callToolBefore(hook, 'Task', 'test-session', {
					subagent_type: 'mega_coder',
					task_id: '1.2',
				});
			} catch {
				threw = true;
			}
			expect(threw).toBe(false);
		});

		it('should handle plan with closed status same as completed', async () => {
			writePlanJson(tempDir, {
				tasks: [{ id: '1.1', status: 'closed' }],
			});

			const hook = createDelegationGateHook(makeConfig(), tempDir);
			const session = ensureAgentSession('test-session');
			session.taskWorkflowStates.set('1.1', 'tests_run');

			// 1.1 has status 'closed' which should be treated same as 'completed'
			let threw = false;
			try {
				await callToolBefore(hook, 'Task', 'test-session', {
					subagent_type: 'mega_coder',
					task_id: '1.2',
				});
			} catch {
				threw = true;
			}
			expect(threw).toBe(false);
		});
	});

	// ============================================================
	// Multi-task completion (parallel execution)
	// ============================================================

	describe('multi-task completion (parallel execution)', () => {
		it('should allow update_task_status completion for task 1.1 when both 1.1 and 1.2 are in tests_run', async () => {
			writePlanJson(tempDir, {
				tasks: [
					{ id: '1.1', status: 'in_progress' },
					{ id: '1.2', status: 'in_progress' },
				],
			});
			const session = ensureAgentSession('test-session');
			advanceTaskState(session, '1.1', 'coder_delegated');
			advanceTaskState(session, '1.1', 'pre_check_passed');
			advanceTaskState(session, '1.1', 'reviewer_run');
			advanceTaskState(session, '1.1', 'tests_run');
			advanceTaskState(session, '1.2', 'coder_delegated');
			advanceTaskState(session, '1.2', 'pre_check_passed');
			advanceTaskState(session, '1.2', 'reviewer_run');
			advanceTaskState(session, '1.2', 'tests_run');

			const hook = createDelegationGateHook(makeConfig(), tempDir);

			// Completing 1.1 should NOT throw even though 1.2 is also awaiting
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

		it('should still block declare_scope for a different task when multiple are awaiting', async () => {
			writePlanJson(tempDir, {
				tasks: [
					{ id: '1.1', status: 'in_progress' },
					{ id: '1.2', status: 'in_progress' },
					{ id: '1.3', status: 'pending' },
				],
			});
			const session = ensureAgentSession('test-session');
			advanceTaskState(session, '1.1', 'coder_delegated');
			advanceTaskState(session, '1.1', 'pre_check_passed');
			advanceTaskState(session, '1.1', 'reviewer_run');
			advanceTaskState(session, '1.1', 'tests_run');
			advanceTaskState(session, '1.2', 'coder_delegated');
			advanceTaskState(session, '1.2', 'pre_check_passed');
			advanceTaskState(session, '1.2', 'reviewer_run');
			advanceTaskState(session, '1.2', 'tests_run');

			const hook = createDelegationGateHook(makeConfig(), tempDir);

			// declare_scope for 1.3 (a different, non-awaiting task) should throw
			let threw = false;
			try {
				await callToolBefore(hook, 'declare_scope', 'test-session', {
					task_id: '1.3',
					files: ['src/foo.ts'],
				});
			} catch {
				threw = true;
			}
			expect(threw).toBe(true);
		});

		it('should allow completing task 1.2 after 1.1 is already completed', async () => {
			writePlanJson(tempDir, {
				tasks: [
					{ id: '1.1', status: 'completed' },
					{ id: '1.2', status: 'in_progress' },
				],
			});
			const session = ensureAgentSession('test-session');
			advanceTaskState(session, '1.1', 'coder_delegated');
			advanceTaskState(session, '1.1', 'pre_check_passed');
			advanceTaskState(session, '1.1', 'reviewer_run');
			advanceTaskState(session, '1.1', 'tests_run');
			advanceTaskState(session, '1.1', 'complete');
			advanceTaskState(session, '1.2', 'coder_delegated');
			advanceTaskState(session, '1.2', 'pre_check_passed');
			advanceTaskState(session, '1.2', 'reviewer_run');
			advanceTaskState(session, '1.2', 'tests_run');

			const hook = createDelegationGateHook(makeConfig(), tempDir);

			// 1.1 is completed, so only 1.2 is awaiting — should be allowed
			let threw = false;
			try {
				await callToolBefore(hook, 'update_task_status', 'test-session', {
					task_id: '1.2',
					status: 'completed',
				});
			} catch {
				threw = true;
			}
			expect(threw).toBe(false);
		});
	});

	// ============================================================
	// Regression tests: FR-010
	// ============================================================

	describe('regression: toolAfter is defined and callable', () => {
		it('should have toolAfter as a function on the hook', () => {
			const hook = createDelegationGateHook(makeConfig(), tempDir);
			expect(typeof hook.toolAfter).toBe('function');
		});

		it('should not throw when toolAfter is called with valid input for Task tool', async () => {
			const hook = createDelegationGateHook(makeConfig(), tempDir);
			await expect(
				hook.toolAfter(
					{
						tool: 'tool.execute.Task',
						sessionID: 'test-session',
						callID: 'call-1',
						args: { subagent_type: 'mega_coder' },
					},
					{},
				),
			).resolves.toBeUndefined();
		});
	});

	describe('regression: coder re-delegation guard still works', () => {
		it('should throw REVIEWER_GATE_VIOLATION when same coder is delegated twice without reviewer', async () => {
			const hook = createDelegationGateHook(makeConfig(), tempDir);
			const session = ensureAgentSession('test-session');

			// First coder delegation — should succeed
			await callToolBefore(hook, 'Task', 'test-session', {
				subagent_type: 'mega_coder',
				task_id: '1.1',
				prompt: 'Implement feature X for task 1.1',
			});

			// Simulate toolAfter: advance state to coder_delegated
			advanceTaskState(session, '1.1', 'coder_delegated');

			// Add a delegation chain entry so the guard sees a current coder delegation
			swarmState.delegationChains.set('test-session', [
				{
					from: 'architect',
					to: 'mega_coder',
					timestamp: Date.now(),
				},
			]);

			// Second coder delegation without reviewer — should throw
			let threw = false;
			let errorMessage = '';
			try {
				await callToolBefore(hook, 'Task', 'test-session', {
					subagent_type: 'mega_coder',
					task_id: '1.1',
					prompt: 'Implement feature X for task 1.1 again',
				});
			} catch (err) {
				threw = true;
				errorMessage = (err as Error).message;
			}

			expect(threw).toBe(true);
			expect(errorMessage).toContain('REVIEWER_GATE_VIOLATION');
		});
	});

	describe('regression: council verdicts advance task state', () => {
		const planId = 'test-swarm-Test_Plan';

		it('should advance task state to complete when council verdict is submitted', async () => {
			// Enable council gate via QA gate profile (SQLite-backed)
			getOrCreateProfile(tempDir, planId);
			setGates(tempDir, planId, { council_mode: true });

			const config = makeConfig(undefined, { enabled: true });
			const hook = createDelegationGateHook(config, tempDir);

			startAgentSession('test-session-council', 'architect');
			const session = ensureAgentSession('test-session-council');

			// Council fast-path requires pre_check_passed (Stage A)
			advanceTaskState(session, '1.1', 'coder_delegated');
			advanceTaskState(session, '1.1', 'pre_check_passed');

			// Simulate council verdict submission via toolAfter
			await hook.toolAfter(
				{
					tool: 'submit_council_verdicts',
					sessionID: 'test-session-council',
					callID: 'call-council-1',
					args: { taskId: '1.1' },
				},
				{
					success: true,
					overallVerdict: 'APPROVE',
					allCriteriaMet: true,
					requiredFixesCount: 0,
					roundNumber: 1,
					quorumSize: 3,
				},
			);

			// Verify state advanced to complete via council verdict path
			const state = getTaskState(session, '1.1');
			expect(state).toBe('complete');

			// Verdict metadata should be recorded on the session
			expect(session.taskCouncilApproved?.get('1.1')).toEqual({
				verdict: 'APPROVE',
				roundNumber: 1,
				quorumSize: 3,
			});
		});

		it('should also allow update_task_status completion as fallback', async () => {
			const hook = createDelegationGateHook(makeConfig(), tempDir);
			const session = ensureAgentSession('test-session');

			// Simulate full QA cycle without council
			advanceTaskState(session, '1.1', 'coder_delegated');
			advanceTaskState(session, '1.1', 'pre_check_passed');
			advanceTaskState(session, '1.1', 'reviewer_run');
			advanceTaskState(session, '1.1', 'tests_run');

			// Update task status to completed
			await callToolAfterCompletion(hook, 'test-session', {
				task_id: '1.1',
				status: 'completed',
			});

			// Verify state advanced to complete
			const state = getTaskState(session, '1.1');
			expect(state).toBe('complete');

			// Next task should now be allowed (no completion gate block)
			let threw = false;
			try {
				await callToolBefore(hook, 'Task', 'test-session', {
					subagent_type: 'mega_coder',
					task_id: '1.2',
					prompt: 'Implement task 1.2',
				});
			} catch {
				threw = true;
			}
			expect(threw).toBe(false);
		});
	});
});
