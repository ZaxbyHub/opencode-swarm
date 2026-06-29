/**
 * Evidence task ID tests (delegation-gate-evidence-taskid.test.ts — Part 1 of 2)
 *
 * Covers:
 * - Task ID extraction from evidence files
 * - Evidence file path validation
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

describe('delegation-gate: evidence task ID extraction', () => {
	let tempDir: string;

	beforeEach(() => {
		resetSwarmState();
		tempDir = makeTempProject('delegation-gate-evidence-');
		writePlanJson(tempDir, {
			tasks: [
				{ id: '1.1', status: 'completed' },
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

	it('should extract task ID from evidence file path', async () => {
		const hook = createDelegationGateHook(makeConfig(), tempDir);

		// Create evidence directory with task subdirectory
		const evidenceDir = path.join(tempDir, '.swarm', 'evidence');
		fs.mkdirSync(path.join(evidenceDir, '1.1'), { recursive: true });

		const session = ensureAgentSession('test-session');
		session.taskWorkflowStates.set('1.2', 'tests_run');

		let threw = false;
		try {
			await callToolBefore(hook, 'Task', 'test-session', {
				subagent_type: 'mega_coder',
				task_id: '1.2',
			});
		} catch {
			threw = true;
		}

		// Evidence for 1.1 should not block 1.2
		expect(threw).toBe(false);
	});

	it('should validate evidence file belongs to non-completed task', async () => {
		const hook = createDelegationGateHook(makeConfig(), tempDir);

		// Create evidence for 1.2 (which is pending/not completed)
		const evidenceDir = path.join(tempDir, '.swarm', 'evidence');
		fs.mkdirSync(path.join(evidenceDir, '1.2'), { recursive: true });

		const session = ensureAgentSession('test-session');
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

		// Evidence exists for 1.2 but plan says pending — should this block?
		// The key is whether evidence task ID matches the blocking task
		expect(threw).toBe(false);
	});
});
