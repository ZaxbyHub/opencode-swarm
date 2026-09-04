/**
 * Core [NEXT] guidance injection + task completion gate tests (delegation-gate-task-1-5.test.ts — Part 1 of 3)
 *
 * Covers:
 * - [NEXT] guidance injection as model-only guidance carrier (issue #2526:
 *   user-role carrier, since the host drops role:'system' entries)
 * - Last-gate context handling (broken context, null values)
 * - Task completion gate blocking behavior before next work
 * - Regression: original user message preservation
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { PluginConfig } from '../../../src/config';
import { createDelegationGateHook } from '../../../src/hooks/delegation-gate';
import {
	findGuidanceCarriers,
	isGuidanceCarrier,
} from '../../../src/hooks/system-guidance-carrier';
import { ensureAgentSession, resetSwarmState } from '../../../src/state';
import {
	makeConfig,
	makeMessages,
	seedAuthoritativeTaskWorkflow,
} from './_delegation-gate-helpers';

/** The real user message — role 'user' but NOT a guidance carrier. */
function findRealUserMessage(messages: { messages: unknown[] }) {
	return messages.messages.find(
		(m) =>
			(m as { info?: { role?: string } })?.info?.role === 'user' &&
			!isGuidanceCarrier(m),
	);
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
		executionProfile?: Record<string, unknown>;
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
	const plan = {
		schema_version: '1.0.0',
		title: 'Parallel Test Plan',
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
					size: 'small',
					description: `Task ${task.id}`,
					depends: task.depends ?? [],
					files_touched: [],
				})),
			},
		],
		...(options.executionProfile
			? { execution_profile: options.executionProfile }
			: {}),
	};
	fs.writeFileSync(
		path.join(dir, '.swarm', 'plan.json'),
		JSON.stringify(plan, null, 2),
	);
}

describe('Task 1.5: [NEXT] Guidance — Core', () => {
	let tempDir: string;

	beforeEach(() => {
		resetSwarmState();
		// Create an isolated temp directory without plan.json so parallel
		// execution guidance does not interfere with [NEXT] guidance tests.
		tempDir = makeTempProject('delegation-gate-next-');
	});

	afterEach(() => {
		resetSwarmState();
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	describe('[NEXT] guidance injection', () => {
		it('should inject [NEXT] guidance as a guidance carrier (not visible in user message)', async () => {
			const config = makeConfig();
			const hook = createDelegationGateHook(config, tempDir);

			// Architect message with no prior gate context
			const messages = makeMessages(
				'TASK: Implement feature X\nFILE: src/x.ts',
				'architect',
			);

			await hook.messagesTransform({}, messages);

			// Find the guidance carriers that were inserted (issue #2526:
			// model-only guidance rides a user-role carrier, never role:'system')
			const carriers = findGuidanceCarriers(messages.messages);

			// Should have exactly one guidance carrier with [NEXT] guidance
			expect(carriers.length).toBe(1);
			expect(carriers[0].info?.role).toBe('user');
			expect(carriers[0].info?.id).toBe('swarm-guidance:delegation');
			expect(carriers[0].parts[0]?.text).toContain('[NEXT]');

			// No role:'system' entries may survive on this surface
			expect(
				messages.messages.filter((m) => m?.info?.role === 'system').length,
			).toBe(0);

			// The user message should still contain original text (carrier is
			// a separate entry — the real user message is untouched)
			const userMessage = findRealUserMessage(messages);
			expect(userMessage?.parts[0].text).toContain('TASK: Implement feature X');
		});

		it('should include last-gate context in [NEXT] guidance when available', async () => {
			const config = makeConfig();
			const hook = createDelegationGateHook(config, tempDir);

			// Set up lastGateOutcome
			const session = ensureAgentSession('test-session');
			session.lastGateOutcome = {
				gate: 'lint',
				taskId: '1.1',
				passed: true,
				timestamp: Date.now(),
			};

			const messages = makeMessages(
				'TASK: Continue with next task\nFILE: src/y.ts',
				'architect',
			);

			await hook.messagesTransform({}, messages);

			// Find the guidance carrier
			const carriers = findGuidanceCarriers(messages.messages);

			// Should contain last gate info
			expect(carriers.length).toBeGreaterThan(0);
			expect(carriers[0].parts[0]?.text).toContain('lint');
			expect(carriers[0].parts[0]?.text).toContain('PASSED');
			expect(carriers[0].parts[0]?.text).toContain('1.1');
		});

		it('should show FAILED when last gate failed', async () => {
			const config = makeConfig();
			const hook = createDelegationGateHook(config, tempDir);

			const session = ensureAgentSession('test-session');
			session.lastGateOutcome = {
				gate: 'reviewer',
				taskId: '2.3',
				passed: false,
				timestamp: Date.now(),
			};

			const messages = makeMessages(
				'TASK: Fix issues\nFILE: src/fix.ts',
				'architect',
			);

			await hook.messagesTransform({}, messages);

			const carriers = findGuidanceCarriers(messages.messages);

			expect(carriers.length).toBeGreaterThan(0);
			expect(carriers[0].parts[0]?.text).toContain('FAILED');
		});

		it('directs task completion status update before next work when QA gates finished', async () => {
			const tempDir = makeTempProject('delegation-gate-completion-next-');
			try {
				writePlanJson(tempDir, {
					tasks: [
						{ id: '1.1', status: 'in_progress' },
						{ id: '1.2', status: 'pending' },
					],
				});

				const config = makeConfig();
				const hook = createDelegationGateHook(config, tempDir);
				const session = ensureAgentSession('completion-next-session');
				session.taskWorkflowStates.set('1.1', 'tests_run');
				await seedAuthoritativeTaskWorkflow(tempDir, '1.1', 'tests_run');
				session.lastGateOutcome = {
					gate: 'test_engineer',
					taskId: '1.1',
					passed: true,
					timestamp: Date.now(),
				};

				const messages = makeMessages(
					'TASK: Continue with next task 1.2\nFILE: src/y.ts',
					'architect',
					'completion-next-session',
				);

				await hook.messagesTransform({}, messages);

				const systemText = findGuidanceCarriers(messages.messages)
					.map((m) => m.parts.map((p) => p.text ?? '').join('\n'))
					.join('\n');

				expect(systemText).toContain('TASK COMPLETION REQUIRED');
				expect(systemText).toContain('Task 1.1');
				expect(systemText).toContain('update_task_status');
				expect(systemText).toContain(
					'before declare_scope or starting another task',
				);
			} finally {
				fs.rmSync(tempDir, { recursive: true, force: true });
			}
		});
	});
});
