/**
 * Completion gate integration tests (delegation-gate-completion-gate.test.ts — Part 2 of 3)
 *
 * Covers:
 * - QA gate enforcement via completion gate (qa-gate-profile integration)
 * - QA gate violation message formatting
 * - update_task_status from tests_run state
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
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

describe('delegation-gate: completion gate — QA gate enforcement (PR #961)', () => {
	let tempDir: string;

	beforeEach(() => {
		resetSwarmState();
		tempDir = makeTempProject('delegation-gate-qagate-');
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

	describe('QA gate profile integration', () => {
		it('should NOT throw when qa_gate_profile is empty (no gates set)', async () => {
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

			expect(threw).toBe(false);
		});

		it('should throw when qa_gate_profile.reviewer is true but task not reviewed', async () => {
			// Set reviewer gate
			const profile = getOrCreateProfile();
			setGates({ reviewer: true });
			profile.gates = { reviewer: true };

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

		it('should NOT throw when reviewer gate is satisfied (task has review evidence)', async () => {
			const profile = getOrCreateProfile();
			setGates({ reviewer: true });
			profile.gates = { reviewer: true };

			// Mark task 1.1 as reviewed in qa-gate-profile
			const taskState = getTaskState(tempDir);
			taskState.taskReviewStatus.set('1.1', {
				status: 'approved',
				evidence: { files: ['tests/unit/foo.test.ts'] },
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

			expect(threw).toBe(false);
		});
	});
});

describe('delegation-gate: update_task_status from tests_run state', () => {
	let tempDir: string;

	beforeEach(() => {
		resetSwarmState();
		tempDir = makeTempProject('delegation-gate-updatestatus-');
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

	it('should allow update_task_status to completed for task in tests_run', async () => {
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

	it('should allow update_task_status to pending for task in tests_run', async () => {
		const hook = createDelegationGateHook(makeConfig(), tempDir);
		const session = ensureAgentSession('test-session');
		session.taskWorkflowStates.set('1.1', 'tests_run');

		let threw = false;
		try {
			await callToolBefore(hook, 'update_task_status', 'test-session', {
				task_id: '1.1',
				status: 'pending',
			});
		} catch {
			threw = true;
		}

		expect(threw).toBe(false);
	});

	it('should not affect completion gate when update_task_status is called for different task', async () => {
		const hook = createDelegationGateHook(makeConfig(), tempDir);
		const session = ensureAgentSession('test-session');
		// 1.1 is in tests_run (blocking)
		session.taskWorkflowStates.set('1.1', 'tests_run');
		// Updating task 1.2 status
		session.taskWorkflowStates.set('1.2', 'pending');

		let threw = false;
		try {
			await callToolBefore(hook, 'update_task_status', 'test-session', {
				task_id: '1.2',
				status: 'in_progress',
			});
		} catch {
			threw = true;
		}

		// Should not throw — we're not delegating a new task
		expect(threw).toBe(false);
	});
});
