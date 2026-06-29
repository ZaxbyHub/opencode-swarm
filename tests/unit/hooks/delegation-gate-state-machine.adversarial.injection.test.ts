/**
 * State machine adversarial tests (delegation-gate-state-machine.adversarial.test.ts — Part 3 of 3)
 *
 * Covers:
 * - Malformed inputs and injection attempts
 * - Timing and ordering edge cases
 * - Stress tests
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

describe('delegation-gate: state machine adversarial — injection attempts', () => {
	let tempDir: string;

	beforeEach(() => {
		resetSwarmState();
		tempDir = makeTempProject('delegation-gate-injection-');
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

	it('should handle task_id with null characters', async () => {
		const hook = createDelegationGateHook(makeConfig(), tempDir);
		const session = ensureAgentSession('test-session');

		let threw = false;
		try {
			await callToolBefore(hook, 'Task', 'test-session', {
				subagent_type: 'mega_coder',
				task_id: '1.1\x00null',
			});
		} catch {
			threw = true;
		}

		// Should not throw — null chars should be sanitized
		expect(threw).toBe(false);
	});

	it('should handle very long task_id strings', async () => {
		const hook = createDelegationGateHook(makeConfig(), tempDir);
		const session = ensureAgentSession('test-session');

		let threw = false;
		try {
			await callToolBefore(hook, 'Task', 'test-session', {
				subagent_type: 'mega_coder',
				task_id: '1.' + 'a'.repeat(10000),
			});
		} catch {
			threw = true;
		}

		// Should not throw — extremely long IDs should be handled
		expect(threw).toBe(false);
	});

	it('should handle prompt with embedded null bytes', async () => {
		const hook = createDelegationGateHook(makeConfig(), tempDir);
		const session = ensureAgentSession('test-session');
		session.taskWorkflowStates.set('1.1', 'tests_run');

		let threw = false;
		try {
			await callToolBefore(hook, 'Task', 'test-session', {
				subagent_type: 'mega_coder',
				task_id: '1.2',
				prompt: 'TASK: 1.1\x00null\x00bytes',
			});
		} catch {
			threw = true;
		}

		expect(threw).toBe(true);
	});

	it('should handle unicode in task identifiers', async () => {
		const hook = createDelegationGateHook(makeConfig(), tempDir);
		const session = ensureAgentSession('test-session');
		session.taskWorkflowStates.set('1.1', 'tests_run');

		let threw = false;
		try {
			await callToolBefore(hook, 'Task', 'test-session', {
				subagent_type: 'mega_coder',
				task_id: '1.2',
				prompt: 'TASK: 1.1\nFILE: src/文件.ts',
			});
		} catch {
			threw = true;
		}

		expect(threw).toBe(true);
	});
});

describe('delegation-gate: state machine adversarial — stress tests', () => {
	let tempDir: string;

	beforeEach(() => {
		resetSwarmState();
		tempDir = makeTempProject('delegation-gate-stress-');
		writePlanJson(tempDir, {
			tasks: Array.from({ length: 20 }, (_, i) => ({
				id: `1.${i + 1}`,
				status: 'pending',
			})),
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

	it('should handle many tasks in various states', async () => {
		const hook = createDelegationGateHook(makeConfig(), tempDir);
		const session = ensureAgentSession('test-session');

		const states = [
			'coder_delegated',
			'reviewer_run',
			'tests_run',
			'completed',
		] as const;

		for (let i = 1; i <= 20; i++) {
			const state = states[i % states.length];
			session.taskWorkflowStates.set(`1.${i}`, state);
		}

		let threw = false;
		try {
			await callToolBefore(hook, 'Task', 'test-session', {
				subagent_type: 'mega_coder',
				task_id: '1.20',
			});
		} catch {
			threw = true;
		}

		// 1.16 is in tests_run (index 15, 15 % 4 = 3 → wait, let me recalculate)
		// Index 0 = 1.1 → coder_delegated (0 % 4 = 0)
		// Index 1 = 1.2 → reviewer_run (1 % 4 = 1)
		// Index 2 = 1.3 → tests_run (2 % 4 = 2) ← blocking
		// Index 3 = 1.4 → completed (3 % 4 = 3)
		// So 1.3 is in tests_run
		expect(threw).toBe(true);
	});

	it('should handle repeated set/clear cycles', async () => {
		const hook = createDelegationGateHook(makeConfig(), tempDir);
		const session = ensureAgentSession('test-session');

		// Rapidly cycle through states
		for (let cycle = 0; cycle < 10; cycle++) {
			session.taskWorkflowStates.set('1.1', 'coder_delegated');
			session.taskWorkflowStates.set('1.1', 'reviewer_run');
			session.taskWorkflowStates.set('1.1', 'tests_run');
			session.taskWorkflowStates.delete('1.1');
		}

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
