/**
 * Council tests (delegation-gate-council.test.ts — Part 2 of 2)
 *
 * Covers:
 * - Council verdict enforcement
 * - Multi-member council delegation
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { PluginConfig } from '../../../src/config';
import type { Plan } from '../../../src/config/plan-schema';
import { createDelegationGateHook } from '../../../src/hooks/delegation-gate';
import { ensureAgentSession, resetSwarmState } from '../../../src/state';

function makeConfig(council?: { enabled?: boolean }): PluginConfig {
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
		},
		council: council ?? { enabled: true },
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

describe('delegation-gate: council verdict enforcement', () => {
	let tempDir: string;

	beforeEach(() => {
		resetSwarmState();
		tempDir = makeTempProject('delegation-gate-council-verdict-');
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

	it('should handle critic delegation for plan review', async () => {
		const hook = createDelegationGateHook(
			makeConfig({ enabled: true }),
			tempDir,
		);

		let threw = false;
		try {
			await callToolBefore(hook, 'Task', 'test-session', {
				subagent_type: 'mega_critic',
				task_id: '1.1',
			});
		} catch {
			threw = true;
		}

		expect(threw).toBe(false);
	});

	it('should handle multiple council members in parallel', async () => {
		const hook = createDelegationGateHook(
			makeConfig({ enabled: true }),
			tempDir,
		);

		const members = ['mega_critic', 'mega_reviewer', 'mega_sme'];

		for (const member of members) {
			let threw = false;
			try {
				await callToolBefore(hook, 'Task', `session-${member}`, {
					subagent_type: member,
					task_id: '1.1',
				});
			} catch {
				threw = true;
			}
			expect(threw).toBe(false);
		}
	});

	it('should enforce completion gate for coder after council review starts', async () => {
		const hook = createDelegationGateHook(
			makeConfig({ enabled: true }),
			tempDir,
		);
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

	it('should allow council member delegation when other council member is in tests_run', async () => {
		const hook = createDelegationGateHook(
			makeConfig({ enabled: true }),
			tempDir,
		);
		const session = ensureAgentSession('test-session');
		session.taskWorkflowStates.set('1.1', 'tests_run');

		let threw = false;
		try {
			await callToolBefore(hook, 'Task', 'test-session', {
				subagent_type: 'mega_reviewer',
				task_id: '1.2',
			});
		} catch {
			threw = true;
		}

		expect(threw).toBe(false);
	});
});
