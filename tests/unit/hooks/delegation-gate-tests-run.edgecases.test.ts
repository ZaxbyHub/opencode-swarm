/**
 * tests_run state tests (delegation-gate-tests-run.test.ts — Part 2 of 2)
 *
 * Covers:
 * - tests_run edge cases and regression scenarios
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { PluginConfig } from '../../../src/config';
import type { Plan } from '../../../src/config/plan-schema';
import { createDelegationGateHook } from '../../../src/hooks/delegation-gate';
import { ensureAgentSession, resetSwarmState } from '../../../src/state';
import { withFrozenClock } from '../../helpers/test-clock.js';
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
			filesTouched?: string[];
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
					files_touched: task.filesTouched ?? [
						`src/tasks/${task.id.replace('.', '-')}.ts`,
					],
				})),
			},
		],
	};
	fs.writeFileSync(
		path.join(dir, '.swarm', 'plan.json'),
		JSON.stringify(plan, null, 2),
	);
	await recordPlanCriticApproval(dir, plan);
}

async function callToolBefore(
	hook: ReturnType<typeof createDelegationGateHook>,
	tool: string,
	sessionID: string,
	args: Record<string, unknown>,
): Promise<void> {
	// Issue #1687 FR-003: coder/reviewer Task dispatches require a non-empty
	// ACCEPTANCE: line or toolBefore throws ACCEPTANCE_FIELD_REQUIRED before
	// reaching the tests_run-state logic under test here. The mega_coder Task
	// dispatches in this file carry no prompt text field at all, so add an
	// inert ACCEPTANCE-only prompt (no N.M-shaped tokens, no other KEY:
	// headers).
	const argsWithAcceptance = {
		...args,
		prompt:
			typeof args.prompt === 'string'
				? `${args.prompt}\nACCEPTANCE: task complete and covered by tests`
				: 'ACCEPTANCE: task complete and covered by tests',
	};
	await hook.toolBefore(
		{ tool, sessionID, callID: `call-${withFrozenClock(() => Date.now())}` },
		{ args: argsWithAcceptance },
	);
}

describe('delegation-gate: tests_run regression edge cases', () => {
	let tempDir: string;

	beforeEach(() => {
		resetSwarmState();
		tempDir = makeTempProject('delegation-gate-testsrun-edge-');
	});

	afterEach(() => {
		resetSwarmState();
		try {
			fs.rmSync(tempDir, { recursive: true, force: true });
		} catch {
			// best-effort cleanup
		}
	});

	it('should handle tests_run state with missing plan entry', async () => {
		await writePlanJson(tempDir, {
			tasks: [{ id: '1.2', status: 'pending' }],
		});

		const hook = createDelegationGateHook(makeConfig(), tempDir);
		const session = ensureAgentSession('test-session');
		// 1.1 has no plan entry but is in tests_run
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

		// Should not throw — missing plan entry should be handled gracefully
		expect(threw).toBe(false);
	});

	it('should handle multiple tasks in tests_run simultaneously', async () => {
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
		session.taskWorkflowStates.set('1.2', 'tests_run');

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

	it('should handle rapid tests_run transitions', async () => {
		await writePlanJson(tempDir, {
			tasks: [
				{ id: '1.1', status: 'pending' },
				{ id: '1.2', status: 'pending' },
			],
		});

		const hook = createDelegationGateHook(makeConfig(), tempDir);
		const session = ensureAgentSession('test-session');

		// Rapid transitions
		session.taskWorkflowStates.set('1.1', 'tests_run');
		session.taskWorkflowStates.delete('1.1');
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
