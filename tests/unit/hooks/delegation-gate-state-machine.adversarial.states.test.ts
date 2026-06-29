/**
 * State machine adversarial tests (delegation-gate-state-machine.adversarial.test.ts — Part 1 of 3)
 *
 * Covers:
 * - Invalid state transitions (tests_run → unknown states)
 * - Concurrent delegation attempts
 * - State machine corruption scenarios
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

describe('delegation-gate: state machine adversarial — invalid transitions', () => {
	let tempDir: string;

	beforeEach(() => {
		resetSwarmState();
		tempDir = makeTempProject('delegation-gate-adv-');
		writePlanJson(tempDir, {
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

	it('should handle unknown state transitions gracefully', async () => {
		const hook = createDelegationGateHook(makeConfig(), tempDir);
		const session = ensureAgentSession('test-session');

		// Set an invalid/unknown state
		// @ts-expect-error — intentionally invalid state for testing
		session.taskWorkflowStates.set('1.1', 'unknown_invalid_state');

		let threw = false;
		try {
			await callToolBefore(hook, 'Task', 'test-session', {
				subagent_type: 'mega_coder',
				task_id: '1.2',
			});
		} catch {
			threw = true;
		}

		// Should not throw — unknown states should be handled gracefully
		expect(threw).toBe(false);
	});

	it('should not allow tasks in tests_run to be re-delegated without completion', async () => {
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

	it('should clear tests_run state after update_task_status to completed', async () => {
		const hook = createDelegationGateHook(makeConfig(), tempDir);
		const session = ensureAgentSession('test-session');
		session.taskWorkflowStates.set('1.1', 'tests_run');

		// Complete the task
		await callToolBefore(hook, 'update_task_status', 'test-session', {
			task_id: '1.1',
			status: 'completed',
		});

		// Now delegate 1.2 — should not be blocked
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

	it('should handle rapid state transitions without corruption', async () => {
		const hook = createDelegationGateHook(makeConfig(), tempDir);
		const session = ensureAgentSession('test-session');

		// Rapid transitions
		session.taskWorkflowStates.set('1.1', 'coder_delegated');
		session.taskWorkflowStates.set('1.1', 'reviewer_run');
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
});

describe('delegation-gate: state machine adversarial — concurrent operations', () => {
	let tempDir: string;

	beforeEach(() => {
		resetSwarmState();
		tempDir = makeTempProject('delegation-gate-concurrent-');
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

	it('should handle concurrent delegation attempts from same session', async () => {
		const hook = createDelegationGateHook(makeConfig(), tempDir);
		const session = ensureAgentSession('test-session');

		// Set up a blocking state
		session.taskWorkflowStates.set('1.1', 'tests_run');

		// Try multiple concurrent delegations
		const results: boolean[] = [];
		for (const taskId of ['1.2', '1.3', '1.2']) {
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

		// All should throw — state is still tests_run
		expect(results.every((r) => r === true)).toBe(true);
	});

	it('should isolate state across parallel sessions', async () => {
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
			});
		} catch {
			threw = true;
		}

		expect(threw).toBe(false);
	});
});
