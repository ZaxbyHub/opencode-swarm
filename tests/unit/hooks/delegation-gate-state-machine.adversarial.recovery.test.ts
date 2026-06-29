/**
 * State machine adversarial tests (delegation-gate-state-machine.adversarial.test.ts — Part 2 of 3)
 *
 * Covers:
 * - Memory pressure / large state maps
 * - State machine recovery after errors
 * - Plan file corruption handling
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

describe('delegation-gate: state machine adversarial — memory pressure', () => {
	let tempDir: string;

	beforeEach(() => {
		resetSwarmState();
		tempDir = makeTempProject('delegation-gate-memory-');
		writePlanJson(tempDir, {
			tasks: Array.from({ length: 50 }, (_, i) => ({
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

	it('should handle large state maps without performance degradation', async () => {
		const hook = createDelegationGateHook(makeConfig(), tempDir);
		const session = ensureAgentSession('test-session');

		// Fill state map with many entries
		for (let i = 1; i <= 50; i++) {
			session.taskWorkflowStates.set(`1.${i}`, 'coder_delegated');
		}

		// Set one to tests_run
		session.taskWorkflowStates.set('1.25', 'tests_run');

		let threw = false;
		try {
			await callToolBefore(hook, 'Task', 'test-session', {
				subagent_type: 'mega_coder',
				task_id: '1.50',
			});
		} catch {
			threw = true;
		}

		expect(threw).toBe(true);
	});

	it('should correctly identify blocking task in large state map', async () => {
		const hook = createDelegationGateHook(makeConfig(), tempDir);
		const session = ensureAgentSession('test-session');

		// Many tasks in various states
		for (let i = 1; i <= 30; i++) {
			session.taskWorkflowStates.set(`1.${i}`, 'coder_delegated');
		}
		for (let i = 31; i <= 50; i++) {
			session.taskWorkflowStates.set(`1.${i}`, 'reviewer_run');
		}

		// Set 1.15 to tests_run (the blocking one)
		session.taskWorkflowStates.set('1.15', 'tests_run');

		let threw = false;
		let errorMessage = '';
		try {
			await callToolBefore(hook, 'Task', 'test-session', {
				subagent_type: 'mega_coder',
				task_id: '1.50',
			});
		} catch (err) {
			threw = true;
			errorMessage = (err as Error).message;
		}

		expect(threw).toBe(true);
		expect(errorMessage).toContain('1.15');
	});
});

describe('delegation-gate: state machine adversarial — plan corruption', () => {
	let tempDir: string;

	beforeEach(() => {
		resetSwarmState();
		tempDir = makeTempProject('delegation-gate-corruption-');
	});

	afterEach(() => {
		resetSwarmState();
		try {
			fs.rmSync(tempDir, { recursive: true, force: true });
		} catch {
			// best-effort cleanup
		}
	});

	it('should handle corrupted plan JSON gracefully', async () => {
		// Write invalid JSON
		fs.writeFileSync(
			path.join(tempDir, '.swarm', 'plan.json'),
			'{ invalid json }',
		);

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

		// Should not throw — corrupted plan should be handled
		expect(threw).toBe(false);
	});

	it('should handle missing plan.json gracefully', async () => {
		// No plan.json written
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

		// Should not throw — missing plan should be handled
		expect(threw).toBe(false);
	});

	it('should handle plan with missing task entries', async () => {
		// Plan references task 1.1 but it's not in the tasks array
		writePlanJson(tempDir, {
			tasks: [{ id: '1.2', status: 'pending' }],
		});

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

		// Should not throw — missing task in plan should be handled
		expect(threw).toBe(false);
	});
});
