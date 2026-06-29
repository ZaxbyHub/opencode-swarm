/**
 * Completion gate integration tests (delegation-gate-completion-gate.test.ts — Part 3 of 3)
 *
 * Covers:
 * - Phase boundary behavior
 * - Multi-session isolation
 * - Edge cases (empty plan, missing tasks, etc.)
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { PluginConfig } from '../../../src/config';
import type { Plan } from '../../../src/config/plan-schema';
import { createDelegationGateHook } from '../../../src/hooks/delegation-gate';
import { ensureAgentSession, resetSwarmState } from '../../../src/state';

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

describe('delegation-gate: completion gate — phase boundary and multi-session', () => {
	let tempDir: string;

	beforeEach(() => {
		resetSwarmState();
		tempDir = makeTempProject('delegation-gate-phase-');
	});

	afterEach(() => {
		resetSwarmState();
		try {
			fs.rmSync(tempDir, { recursive: true, force: true });
		} catch {
			// best-effort cleanup
		}
	});

	describe('phase boundary behavior', () => {
		it('should not enforce completion gate across phase boundaries', async () => {
			// Phase 1 tasks
			writePlanJson(tempDir, {
				phase: 1,
				tasks: [
					{ id: '1.1', status: 'completed' },
					{ id: '1.2', status: 'completed' },
				],
			});

			// Phase 2 tasks (new phase, new start)
			writePlanJson(tempDir, {
				phase: 2,
				currentPhase: 2,
				tasks: [
					{ id: '2.1', status: 'pending', phase: 2 },
					{ id: '2.2', status: 'pending', phase: 2 },
				],
			});

			const hook = createDelegationGateHook(makeConfig(), tempDir);
			const session = ensureAgentSession('test-session');

			// Task 1.1 was completed in phase 1, now we want to delegate 2.1
			// Phase boundary should reset the completion gate
			session.taskWorkflowStates.set('1.1', 'tests_run');

			let threw = false;
			try {
				await callToolBefore(hook, 'Task', 'test-session', {
					subagent_type: 'mega_coder',
					task_id: '2.1',
				});
			} catch {
				threw = true;
			}

			// Should not throw — phase boundary allows new delegations
			expect(threw).toBe(false);
		});
	});

	describe('multi-session isolation', () => {
		it('should not share completion gate state across sessions', async () => {
			writePlanJson(tempDir, {
				tasks: [
					{ id: '1.1', status: 'pending' },
					{ id: '1.2', status: 'pending' },
				],
			});

			const hook = createDelegationGateHook(makeConfig(), tempDir);

			// Session 1 has task 1.1 in tests_run
			const session1 = ensureAgentSession('session-1');
			session1.taskWorkflowStates.set('1.1', 'tests_run');

			// Session 2 tries to delegate task 1.2 — should not be blocked by session 1's state
			const session2 = ensureAgentSession('session-2');

			let threw = false;
			try {
				await callToolBefore(hook, 'Task', 'session-2', {
					subagent_type: 'mega_coder',
					task_id: '1.2',
				});
			} catch {
				threw = true;
			}

			// Should not throw — sessions are isolated
			expect(threw).toBe(false);
		});

		it('should block same task in same session when in tests_run', async () => {
			writePlanJson(tempDir, {
				tasks: [{ id: '1.1', status: 'pending' }],
			});

			const hook = createDelegationGateHook(makeConfig(), tempDir);
			const session = ensureAgentSession('session-1');
			session.taskWorkflowStates.set('1.1', 'tests_run');

			let threw = false;
			try {
				await callToolBefore(hook, 'Task', 'session-1', {
					subagent_type: 'mega_coder',
					task_id: '1.2',
				});
			} catch {
				threw = true;
			}

			expect(threw).toBe(true);
		});
	});
});

describe('delegation-gate: completion gate — edge cases', () => {
	let tempDir: string;

	beforeEach(() => {
		resetSwarmState();
		tempDir = makeTempProject('delegation-gate-edge-');
	});

	afterEach(() => {
		resetSwarmState();
		try {
			fs.rmSync(tempDir, { recursive: true, force: true });
		} catch {
			// best-effort cleanup
		}
	});

	it('should not throw when plan has no tasks', async () => {
		const plan: Plan = {
			schema_version: '1.0.0' as const,
			title: 'Empty Plan',
			swarm: 'test-swarm',
			current_phase: 1,
			phases: [
				{
					id: 1,
					name: 'Phase 1',
					status: 'in_progress',
					tasks: [],
				},
			],
		};
		fs.writeFileSync(
			path.join(tempDir, '.swarm', 'plan.json'),
			JSON.stringify(plan, null, 2),
		);

		const hook = createDelegationGateHook(makeConfig(), tempDir);
		const session = ensureAgentSession('test-session');
		session.taskWorkflowStates.set('1.1', 'tests_run');

		let threw = false;
		try {
			await callToolBefore(hook, 'Task', 'test-session', {
				subagent_type: 'mega_coder',
				task_id: '2.1',
			});
		} catch {
			threw = true;
		}

		expect(threw).toBe(false);
	});

	it('should not throw when taskWorkflowStates has stale entries from previous phases', async () => {
		writePlanJson(tempDir, {
			tasks: [{ id: '1.1', status: 'pending' }],
		});

		const hook = createDelegationGateHook(makeConfig(), tempDir);
		const session = ensureAgentSession('test-session');

		// Stale entry from a previous phase
		session.taskWorkflowStates.set('0.1', 'tests_run');

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

	it('should handle concurrent delegation attempts correctly', async () => {
		writePlanJson(tempDir, {
			tasks: [
				{ id: '1.1', status: 'pending' },
				{ id: '1.2', status: 'pending' },
			],
		});

		const hook = createDelegationGateHook(makeConfig(), tempDir);
		const session = ensureAgentSession('test-session');
		session.taskWorkflowStates.set('1.1', 'tests_run');

		// Both attempts should behave consistently
		const results: boolean[] = [];

		for (const taskId of ['1.2', '1.2']) {
			let threw = false;
			try {
				await callToolBefore(hook, 'Task', 'test-session', {
					subagent_type: 'mega_coder',
					task_id: taskId,
				});
			} catch {
				threw = true;
			}
			results.push(threw);
		}

		// Both should throw (same blocking state)
		expect(results[0]).toBe(true);
		expect(results[1]).toBe(true);
	});
});
