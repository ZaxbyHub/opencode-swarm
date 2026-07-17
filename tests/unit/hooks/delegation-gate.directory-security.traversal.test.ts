/**
 * Directory security tests (delegation-gate.directory-security.test.ts — Part 1 of 2)
 *
 * Covers:
 * - Directory traversal prevention
 * - Path validation
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
	await recordPlanCriticApproval(dir, plan);
}

async function callToolBefore(
	hook: ReturnType<typeof createDelegationGateHook>,
	tool: string,
	sessionID: string,
	args: Record<string, unknown>,
): Promise<void> {
	await hook.toolBefore(
		{ tool, sessionID, callID: `call-${withFrozenClock(() => Date.now())}` },
		{ args },
	);
}

describe('delegation-gate: directory traversal prevention', () => {
	let tempDir: string;

	beforeEach(async () => {
		resetSwarmState();
		tempDir = makeTempProject('delegation-gate-dirsec-');
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

	it('should not allow access outside project directory', async () => {
		const outsideDir = makeTempProject('delegation-gate-outside-');
		try {
			const hook2 = createDelegationGateHook(makeConfig(), outsideDir);
			ensureAgentSession('test-session');
			await expect(
				callToolBefore(hook2, 'Task', 'test-session', {
					subagent_type: 'mega_coder',
					task_id: '1.1',
					prompt: 'ACCEPTANCE: task complete and covered by tests',
				}),
			).rejects.toThrow('SCOPE_NOT_DECLARED');
		} finally {
			fs.rmSync(outsideDir, { recursive: true, force: true });
		}
	});

	it('should reject path with null bytes', async () => {
		const hook = createDelegationGateHook(makeConfig(), tempDir);
		ensureAgentSession('test-session');

		await expect(
			callToolBefore(hook, 'Task', 'test-session', {
				subagent_type: 'mega_coder',
				task_id: '1.1',
				prompt:
					'TASK: 1.1\nFILE: src/bad\u0000path.ts\nACCEPTANCE: task complete and covered by tests',
			}),
		).rejects.toThrow('SCOPE_NOT_DECLARED');
	});

	it('should reject absolute path attempts', async () => {
		const hook = createDelegationGateHook(makeConfig(), tempDir);
		ensureAgentSession('test-session');

		await expect(
			callToolBefore(hook, 'Task', 'test-session', {
				subagent_type: 'mega_coder',
				task_id: '1.1',
				prompt:
					'TASK: 1.1\nFILE: /absolute/path\nACCEPTANCE: task complete and covered by tests',
			}),
		).rejects.toThrow('SCOPE_NOT_DECLARED');
	});
});

describe('delegation-gate: path validation', () => {
	let tempDir: string;

	beforeEach(async () => {
		resetSwarmState();
		tempDir = makeTempProject('delegation-gate-pathval-');
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

	it('should handle very long paths', async () => {
		const hook = createDelegationGateHook(makeConfig(), tempDir);
		const session = ensureAgentSession('test-session');

		const longPath = 'a'.repeat(10000);

		let threw = false;
		try {
			await callToolBefore(hook, 'Task', 'test-session', {
				subagent_type: 'mega_coder',
				task_id: '1.1',
				prompt: `TASK: 1.1\nFILE: ${longPath}\nACCEPTANCE: task complete and covered by tests`,
			});
		} catch {
			threw = true;
		}

		expect(threw).toBe(false);
	});

	it('should handle paths with special characters', async () => {
		const hook = createDelegationGateHook(makeConfig(), tempDir);
		const session = ensureAgentSession('test-session');

		let threw = false;
		try {
			await callToolBefore(hook, 'Task', 'test-session', {
				subagent_type: 'mega_coder',
				task_id: '1.1',
				prompt:
					'TASK: 1.1\nFILE: src/file with spaces.txt\nACCEPTANCE: task complete and covered by tests',
			});
		} catch {
			threw = true;
		}

		expect(threw).toBe(false);
	});
});
