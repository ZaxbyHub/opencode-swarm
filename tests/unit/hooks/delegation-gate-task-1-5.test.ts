/**
 * Adversarial tests for Task 1.5 - Delegation Gate [NEXT] Guidance
 *
 * Tests focus on:
 * - [NEXT] guidance injection as model-only system message
 * - Last-gate context handling (broken context, null values)
 * - SessionID validation bypass attempts
 * - Duplicate guidance insertion when both violation warning and deliberation run
 * - Empty/null lastGateOutcome handling
 * - Regression: original user message preservation
 * - Regression: batch detection still works
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { PluginConfig } from '../../../src/config';
import { createDelegationGateHook } from '../../../src/hooks/delegation-gate';
import {
	advanceTaskState,
	ensureAgentSession,
	resetSwarmState,
	swarmState,
} from '../../../src/state';

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

function makeMessages(
	text: string,
	agent?: string,
	sessionID = 'test-session',
) {
	return {
		messages: [
			{
				info: { role: 'user' as const, agent, sessionID },
				parts: [{ type: 'text', text }],
			},
		],
	};
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

describe('Task 1.5: [NEXT] Guidance - Model-Only System Message', () => {
	beforeEach(() => {
		resetSwarmState();
	});

	afterEach(() => {
		resetSwarmState();
	});

	describe('[NEXT] guidance injection', () => {
		it('should inject [NEXT] guidance as system message (not visible in user message)', async () => {
			const config = makeConfig();
			const hook = createDelegationGateHook(config);

			// Architect message with no prior gate context
			const messages = makeMessages(
				'TASK: Implement feature X\nFILE: src/x.ts',
				'architect',
			);

			await hook.messagesTransform({}, messages);

			// Find the system message that was inserted
			const systemMessages = messages.messages.filter(
				(m) => m?.info?.role === 'system',
			);

			// Should have exactly one system message with [NEXT] guidance
			expect(systemMessages.length).toBe(1);
			expect(systemMessages[0].parts[0].text).toContain('[NEXT]');

			// The user message should still contain original text
			const userMessage = messages.messages.find(
				(m) => m?.info?.role === 'user',
			);
			expect(userMessage?.parts[0].text).toContain('TASK: Implement feature X');
		});

		it('should include last-gate context in [NEXT] guidance when available', async () => {
			const config = makeConfig();
			const hook = createDelegationGateHook(config);

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

			// Find the system message
			const systemMessages = messages.messages.filter(
				(m) => m?.info?.role === 'system',
			);

			// Should contain last gate info
			expect(systemMessages[0].parts[0].text).toContain('lint');
			expect(systemMessages[0].parts[0].text).toContain('PASSED');
			expect(systemMessages[0].parts[0].text).toContain('1.1');
		});

		it('should show FAILED when last gate failed', async () => {
			const config = makeConfig();
			const hook = createDelegationGateHook(config);

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

			const systemMessages = messages.messages.filter(
				(m) => m?.info?.role === 'system',
			);

			expect(systemMessages[0].parts[0].text).toContain('FAILED');
		});
	});

	describe('parallel execution_profile [NEXT] guidance', () => {
		let tempDir: string;

		beforeEach(() => {
			tempDir = makeTempProject('delegation-gate-parallel-next-');
		});

		afterEach(() => {
			try {
				fs.rmSync(tempDir, { recursive: true, force: true });
			} catch {
				// best-effort cleanup
			}
		});

		it('should list eligible pending tasks up to available parallel slots', async () => {
			writePlanJson(tempDir, {
				executionProfile: {
					parallelization_enabled: true,
					max_concurrent_tasks: 4,
					locked: true,
				},
				tasks: [
					{ id: '1.1', status: 'pending' },
					{ id: '1.2', status: 'pending' },
					{ id: '1.3', status: 'pending' },
					{ id: '1.4', status: 'pending' },
				],
			});

			const hook = createDelegationGateHook(makeConfig(), tempDir);
			const messages = makeMessages('TASK: Continue work', 'architect');

			await hook.messagesTransform({}, messages);

			const systemText = messages.messages
				.filter((m) => m?.info?.role === 'system')
				.map((m) => m.parts[0].text)
				.join('\n');

			expect(systemText).toContain('PARALLEL EXECUTION PROFILE');
			expect(systemText).toContain('max_concurrent_tasks=4');
			expect(systemText).toContain('dispatch up to 4');
			expect(systemText).toContain('Eligible now: 1.1, 1.2, 1.3, 1.4');
		});

		it('should keep serial guidance when profile is disabled or serial', async () => {
			writePlanJson(tempDir, {
				executionProfile: {
					parallelization_enabled: false,
					max_concurrent_tasks: 4,
					locked: true,
				},
			});

			const hook = createDelegationGateHook(makeConfig(), tempDir);
			const messages = makeMessages('TASK: Continue work', 'architect');

			await hook.messagesTransform({}, messages);

			const systemText = messages.messages
				.filter((m) => m?.info?.role === 'system')
				.map((m) => m.parts[0].text)
				.join('\n');

			expect(systemText).toContain('run gates sequentially');
			expect(systemText).not.toContain('PARALLEL EXECUTION PROFILE');
		});

		it('should count in-progress tasks as occupied and exclude blocked/dependent tasks', async () => {
			writePlanJson(tempDir, {
				executionProfile: {
					parallelization_enabled: true,
					max_concurrent_tasks: 3,
					locked: true,
				},
				tasks: [
					{ id: '1.1', status: 'in_progress' },
					{ id: '1.2', status: 'pending', depends: ['1.1'] },
					{ id: '1.3', status: 'pending' },
					{ id: '1.4', status: 'blocked' },
				],
			});

			const hook = createDelegationGateHook(makeConfig(), tempDir);
			const messages = makeMessages('TASK: Continue work', 'architect');

			await hook.messagesTransform({}, messages);

			const systemText = messages.messages
				.filter((m) => m?.info?.role === 'system')
				.map((m) => m.parts[0].text)
				.join('\n');

			expect(systemText).toContain('dispatch up to 2');
			expect(systemText).toContain('Eligible now: 1.3');
			expect(systemText).not.toContain('Eligible now: 1.2');
			expect(systemText).not.toContain('Eligible now: 1.4');
		});

		it('should count active in-memory workflow states as occupied slots', async () => {
			writePlanJson(tempDir, {
				executionProfile: {
					parallelization_enabled: true,
					max_concurrent_tasks: 4,
					locked: true,
				},
				tasks: [
					{ id: '1.1', status: 'pending' },
					{ id: '1.2', status: 'pending' },
					{ id: '1.3', status: 'pending' },
					{ id: '1.4', status: 'pending' },
				],
			});
			const session = ensureAgentSession('test-session');
			advanceTaskState(session, '1.1', 'coder_delegated');
			advanceTaskState(session, '1.2', 'coder_delegated');
			advanceTaskState(session, '1.2', 'pre_check_passed');
			advanceTaskState(session, '1.3', 'coder_delegated');
			advanceTaskState(session, '1.3', 'pre_check_passed');
			advanceTaskState(session, '1.3', 'reviewer_run');

			const hook = createDelegationGateHook(makeConfig(), tempDir);
			const messages = makeMessages('TASK: Continue work', 'architect');

			await hook.messagesTransform({}, messages);

			const systemText = messages.messages
				.filter((m) => m?.info?.role === 'system')
				.map((m) => m.parts[0].text)
				.join('\n');

			expect(systemText).toContain('3 slot(s) occupied');
			expect(systemText).toContain('dispatch up to 1');
			expect(systemText).toContain('Eligible now: 1.4');
			expect(systemText).not.toContain('Eligible now: 1.1');
		});

		it('should count tests_run bridge state as an occupied slot', async () => {
			writePlanJson(tempDir, {
				executionProfile: {
					parallelization_enabled: true,
					max_concurrent_tasks: 2,
					locked: true,
				},
				tasks: [
					{ id: '1.1', status: 'pending' },
					{ id: '1.2', status: 'pending' },
					{ id: '1.3', status: 'pending' },
				],
			});
			const session = ensureAgentSession('test-session');
			advanceTaskState(session, '1.1', 'coder_delegated');
			advanceTaskState(session, '1.1', 'pre_check_passed');
			advanceTaskState(session, '1.1', 'reviewer_run');
			advanceTaskState(session, '1.1', 'tests_run');

			const hook = createDelegationGateHook(makeConfig(), tempDir);
			const messages = makeMessages('TASK: Continue work', 'architect');

			await hook.messagesTransform({}, messages);

			const systemText = messages.messages
				.filter((m) => m?.info?.role === 'system')
				.map((m) => m.parts[0].text)
				.join('\n');

			expect(systemText).toContain('1 slot(s) occupied');
			expect(systemText).toContain('dispatch up to 1');
			expect(systemText).toContain('Eligible now: 1.2');
			expect(systemText).not.toContain('Eligible now: 1.1');
			expect(systemText).not.toContain('Eligible now: 1.3');
		});

		it('should count active work across phases against the plan-level slot budget', async () => {
			const plan = {
				schema_version: '1.0.0',
				title: 'Cross Phase Occupancy Test Plan',
				swarm: 'test-swarm',
				current_phase: 2,
				execution_profile: {
					parallelization_enabled: true,
					max_concurrent_tasks: 2,
					locked: true,
				},
				phases: [
					{
						id: 1,
						name: 'Phase 1',
						status: 'in_progress',
						tasks: [
							{
								id: '1.1',
								phase: 1,
								status: 'in_progress',
								size: 'small',
								description: 'Active earlier-phase task',
								depends: [],
								files_touched: [],
							},
						],
					},
					{
						id: 2,
						name: 'Phase 2',
						status: 'in_progress',
						tasks: [
							{
								id: '2.1',
								phase: 2,
								status: 'pending',
								size: 'small',
								description: 'Ready task one',
								depends: [],
								files_touched: [],
							},
							{
								id: '2.2',
								phase: 2,
								status: 'pending',
								size: 'small',
								description: 'Ready task two',
								depends: [],
								files_touched: [],
							},
						],
					},
				],
			};
			fs.writeFileSync(
				path.join(tempDir, '.swarm', 'plan.json'),
				JSON.stringify(plan, null, 2),
			);

			const hook = createDelegationGateHook(makeConfig(), tempDir);
			const messages = makeMessages('TASK: Continue work', 'architect');

			await hook.messagesTransform({}, messages);

			const systemText = messages.messages
				.filter((m) => m?.info?.role === 'system')
				.map((m) => m.parts[0].text)
				.join('\n');

			expect(systemText).toContain('1 slot(s) occupied');
			expect(systemText).toContain('dispatch up to 1');
			expect(systemText).toContain('Eligible now: 2.1');
			expect(systemText).not.toContain('Eligible now: 2.2');
		});

		it('should treat completed dependencies from earlier phases as eligible inputs', async () => {
			const plan = {
				schema_version: '1.0.0',
				title: 'Cross Phase Parallel Test Plan',
				swarm: 'test-swarm',
				current_phase: 2,
				execution_profile: {
					parallelization_enabled: true,
					max_concurrent_tasks: 2,
					locked: true,
				},
				phases: [
					{
						id: 1,
						name: 'Phase 1',
						status: 'complete',
						tasks: [
							{
								id: '1.1',
								phase: 1,
								status: 'completed',
								size: 'small',
								description: 'Completed prerequisite',
								depends: [],
								files_touched: [],
							},
						],
					},
					{
						id: 2,
						name: 'Phase 2',
						status: 'in_progress',
						tasks: [
							{
								id: '2.1',
								phase: 2,
								status: 'pending',
								size: 'small',
								description: 'Ready task',
								depends: ['1.1'],
								files_touched: [],
							},
							{
								id: '2.2',
								phase: 2,
								status: 'pending',
								size: 'small',
								description: 'Blocked by unmet dependency',
								depends: ['2.9'],
								files_touched: [],
							},
						],
					},
				],
			};
			fs.writeFileSync(
				path.join(tempDir, '.swarm', 'plan.json'),
				JSON.stringify(plan, null, 2),
			);

			const hook = createDelegationGateHook(makeConfig(), tempDir);
			const messages = makeMessages('TASK: Continue work', 'architect');

			await hook.messagesTransform({}, messages);

			const systemText = messages.messages
				.filter((m) => m?.info?.role === 'system')
				.map((m) => m.parts[0].text)
				.join('\n');

			expect(systemText).toContain('Eligible now: 2.1');
			expect(systemText).not.toContain('Eligible now: 2.2');
		});

		it('should fail open to serial guidance when plan.json is missing', async () => {
			const hook = createDelegationGateHook(makeConfig(), tempDir);
			const messages = makeMessages('TASK: Continue work', 'architect');

			await hook.messagesTransform({}, messages);

			const systemText = messages.messages
				.filter((m) => m?.info?.role === 'system')
				.map((m) => m.parts[0].text)
				.join('\n');

			expect(systemText).toContain('run gates sequentially');
			expect(systemText).not.toContain('PARALLEL EXECUTION PROFILE');
		});

		it('should fail open to serial guidance when plan.json is malformed', async () => {
			fs.writeFileSync(path.join(tempDir, '.swarm', 'plan.json'), '{nope');

			const hook = createDelegationGateHook(makeConfig(), tempDir);
			const messages = makeMessages('TASK: Continue work', 'architect');

			await hook.messagesTransform({}, messages);

			const systemText = messages.messages
				.filter((m) => m?.info?.role === 'system')
				.map((m) => m.parts[0].text)
				.join('\n');

			expect(systemText).toContain('run gates sequentially');
			expect(systemText).not.toContain('PARALLEL EXECUTION PROFILE');
		});

		it('should suppress standard slot-filling guidance when Lean Turbo is active', async () => {
			writePlanJson(tempDir, {
				executionProfile: {
					parallelization_enabled: true,
					max_concurrent_tasks: 4,
					locked: true,
				},
				tasks: [
					{ id: '1.1', status: 'pending' },
					{ id: '1.2', status: 'pending' },
				],
			});
			const session = ensureAgentSession('test-session');
			session.turboMode = true;
			session.turboStrategy = 'lean';
			session.leanTurboActive = true;

			const hook = createDelegationGateHook(makeConfig(), tempDir);
			const messages = makeMessages('TASK: Continue work', 'architect');

			await hook.messagesTransform({}, messages);

			const systemText = messages.messages
				.filter((m) => m?.info?.role === 'system')
				.map((m) => m.parts[0].text)
				.join('\n');

			expect(systemText).toContain('Lean Turbo is active');
			expect(systemText).not.toContain('Eligible now:');
		});
	});

	describe('sessionID validation (security)', () => {
		it('should reject sessionID with invalid characters', async () => {
			const config = makeConfig();
			const hook = createDelegationGateHook(config);

			// Try injection attempts
			const invalidSessionIDs = [
				'../../etc/passwd',
				'../admin',
				'; rm -rf /',
				'$(whoami)',
				'`ls`',
				'\n<script>',
				'a'.repeat(200), // Too long
			];

			for (const invalidID of invalidSessionIDs) {
				const messages = {
					messages: [
						{
							info: {
								role: 'user' as const,
								agent: 'architect',
								sessionID: invalidID,
							},
							parts: [{ type: 'text', text: 'TASK: test' }],
						},
					],
				};

				// Should not throw - should skip guidance injection
				await hook.messagesTransform({}, messages);

				// No system message should be inserted for invalid sessionID
				const systemMessages = messages.messages.filter(
					(m) => m?.info?.role === 'system',
				);
				expect(systemMessages.length).toBe(0);
			}
		});

		it('should accept valid sessionID formats', async () => {
			const config = makeConfig();
			const hook = createDelegationGateHook(config);

			const validSessionIDs = [
				'test-session',
				'session-123',
				'ABC_123_xyz',
				'a'.repeat(128), // Exactly 128 chars - max allowed
			];

			for (const validID of validSessionIDs) {
				const messages = {
					messages: [
						{
							info: {
								role: 'user' as const,
								agent: 'architect',
								sessionID: validID,
							},
							parts: [{ type: 'text', text: 'TASK: test' }],
						},
					],
				};

				await hook.messagesTransform({}, messages);

				// System message should be inserted for valid sessionID
				const systemMessages = messages.messages.filter(
					(m) => m?.info?.role === 'system',
				);
				expect(systemMessages.length).toBe(1);
			}
		});
	});

	describe('null/undefined lastGateOutcome handling', () => {
		it('should handle null lastGateOutcome gracefully', async () => {
			const config = makeConfig();
			const hook = createDelegationGateHook(config);

			const session = ensureAgentSession('test-session');
			expect(session.lastGateOutcome).toBeNull();

			const messages = makeMessages(
				'TASK: First task\nFILE: src/a.ts',
				'architect',
			);

			// Should not throw
			await hook.messagesTransform({}, messages);

			// Should still inject [NEXT] guidance
			const systemMessages = messages.messages.filter(
				(m) => m?.info?.role === 'system',
			);
			expect(systemMessages.length).toBe(1);
			expect(systemMessages[0].parts[0].text).toContain('[NEXT]');
		});

		it('should handle undefined lastGateOutcome', async () => {
			const config = makeConfig();
			const hook = createDelegationGateHook(config);

			const session = ensureAgentSession('test-session');
			// lastGateOutcome starts as null, not undefined

			const messages = makeMessages(
				'TASK: Second task\nFILE: src/b.ts',
				'architect',
			);

			await hook.messagesTransform({}, messages);

			const systemMessages = messages.messages.filter(
				(m) => m?.info?.role === 'system',
			);
			expect(systemMessages.length).toBe(1);
		});

		it('should handle malformed lastGateOutcome (missing fields)', async () => {
			const config = makeConfig();
			const hook = createDelegationGateHook(config);

			const session = ensureAgentSession('test-session');
			// @ts-expect-error - intentionally malformed
			session.lastGateOutcome = { gate: 'lint' }; // Missing passed, taskId, timestamp

			const messages = makeMessages(
				'TASK: Third task\nFILE: src/c.ts',
				'architect',
			);

			// Should not throw - should handle gracefully
			await hook.messagesTransform({}, messages);

			// Should still inject guidance
			const systemMessages = messages.messages.filter(
				(m) => m?.info?.role === 'system',
			);
			expect(systemMessages.length).toBe(1);
		});

		it('should sanitize gate name with special characters', async () => {
			const config = makeConfig();
			const hook = createDelegationGateHook(config);

			const session = ensureAgentSession('test-session');
			session.lastGateOutcome = {
				gate: 'test[ ]gate<script>',
				taskId: '1.1',
				passed: true,
				timestamp: Date.now(),
			};

			const messages = makeMessages('TASK: Test\nFILE: src/t.ts', 'architect');

			await hook.messagesTransform({}, messages);

			const systemMessages = messages.messages.filter(
				(m) => m?.info?.role === 'system',
			);

			// Should NOT contain raw [ ] or <script>
			const guidanceText = systemMessages[0].parts[0].text;
			expect(guidanceText).not.toContain('<script>');
			// The [] should be replaced with ()
			expect(guidanceText).toContain('test()gate');
		});
	});

	describe('duplicate guidance insertion (violation + deliberation)', () => {
		it('should handle both zero-coder violation and deliberation guidance', async () => {
			const config = makeConfig();
			const hook = createDelegationGateHook(config);

			// Set up state to trigger zero-coder violation warning
			const session = ensureAgentSession('test-session');
			session.architectWriteCount = 1; // Architect has written files

			// Message is NOT a coder delegation but has a task ID different from last coder delegation
			const messages = makeMessages('TASK: 1.2\nFILE: src/new.ts', 'architect');
			// Set last coder delegation to different task
			session.lastCoderDelegationTaskId = '1.1';

			await hook.messagesTransform({}, messages);

			// Should have TWO system messages: violation warning + [NEXT] guidance
			const systemMessages = messages.messages.filter(
				(m) => m?.info?.role === 'system',
			);

			expect(systemMessages.length).toBe(2);

			// Check for violation warning
			const allGuidance = systemMessages.map((m) => m.parts[0].text).join(' ');
			expect(allGuidance).toContain('DELEGATION VIOLATION');
			expect(allGuidance).toContain('[NEXT]');
		});

		it('should preserve original message when both warnings insert system messages', async () => {
			const config = makeConfig();
			const hook = createDelegationGateHook(config);

			const session = ensureAgentSession('test-session');
			session.architectWriteCount = 1;
			session.lastCoderDelegationTaskId = '1.1';

			const originalText = 'TASK: 1.2\nFILE: src/new.ts';
			const messages = makeMessages(originalText, 'architect');

			await hook.messagesTransform({}, messages);

			// Find user message - should be preserved
			const userMessage = messages.messages.find(
				(m) => m?.info?.role === 'user',
			);

			expect(userMessage?.parts[0].text).toContain(originalText);
		});
	});

	describe('empty agent handling (regression from Task 1.4)', () => {
		it('should skip guidance injection for empty string agent', async () => {
			const config = makeConfig();
			const hook = createDelegationGateHook(config);

			// Empty string agent - should be skipped
			const messages = makeMessages('TASK: test\nFILE: src/t.ts', '');

			await hook.messagesTransform({}, messages);

			// No system message should be inserted
			const systemMessages = messages.messages.filter(
				(m) => m?.info?.role === 'system',
			);
			expect(systemMessages.length).toBe(0);
		});

		it('should skip guidance injection for non-architect agent', async () => {
			const config = makeConfig();
			const hook = createDelegationGateHook(config);

			// Non-architect agent - should be skipped
			const messages = makeMessages('TASK: test\nFILE: src/t.ts', 'mega_coder');

			await hook.messagesTransform({}, messages);

			const systemMessages = messages.messages.filter(
				(m) => m?.info?.role === 'system',
			);
			expect(systemMessages.length).toBe(0);
		});

		it('should inject guidance for undefined agent (main session = architect)', async () => {
			const config = makeConfig();
			const hook = createDelegationGateHook(config);

			// No agent specified - should be treated as architect (main session)
			const messages = {
				messages: [
					{
						info: { role: 'user' as const, sessionID: 'test-session' }, // No agent field
						parts: [{ type: 'text', text: 'TASK: test\nFILE: src/t.ts' }],
					},
				],
			};

			await hook.messagesTransform({}, messages);

			// Should inject guidance
			const systemMessages = messages.messages.filter(
				(m) => m?.info?.role === 'system',
			);
			expect(systemMessages.length).toBe(1);
		});
	});

	describe('batch detection regression', () => {
		it('should still detect batching language after [NEXT] guidance change', async () => {
			const config = makeConfig();
			const hook = createDelegationGateHook(config);

			// Set up properly for architect
			const messages2 = makeMessages(
				'coder\nTASK: Add feature X and also add feature Y\nFILE: src/x.ts',
				'architect',
			);

			await hook.messagesTransform({}, messages2);

			// Batch warning is injected as a system message (not prepended to user message text)
			const systemMessages = messages2.messages.filter(
				(m) => m?.info?.role === 'system',
			);
			const systemText = systemMessages
				.map((m) => m.parts?.[0]?.text ?? '')
				.join('\n');
			expect(systemText).toContain('BATCH DETECTED');
			expect(systemText).toContain('and also');
		});

		it('should still detect multiple FILE: directives', async () => {
			const config = makeConfig();
			const hook = createDelegationGateHook(config);

			const messages = {
				messages: [
					{
						info: {
							role: 'user' as const,
							agent: 'architect',
							sessionID: 'test-session',
						},
						parts: [
							{
								type: 'text',
								text: 'coder\nTASK: Fix both\nFILE: a.ts\nFILE: b.ts',
							},
						],
					},
				],
			};

			await hook.messagesTransform({}, messages);

			// Batch warning is injected as a system message (not into user message text)
			const systemMessages = messages.messages.filter(
				(m) => m?.info?.role === 'system',
			);
			const systemText = systemMessages
				.map((m) => m.parts?.[0]?.text ?? '')
				.join('\n');
			expect(systemText).toContain('Multiple FILE: directives');
		});
	});

	describe('original message preservation (critical regression test)', () => {
		it('should preserve entire original user message text', async () => {
			const config = makeConfig();
			const hook = createDelegationGateHook(config);

			const originalText =
				'coder\nTASK: Implement login\nFILE: src/auth/login.ts\nACCEPTANCE: User can log in';
			const messages = makeMessages(originalText, 'architect');

			await hook.messagesTransform({}, messages);

			// Find the user message - original text must be preserved
			const userMessage = messages.messages.find(
				(m) => m?.info?.role === 'user',
			);

			expect(userMessage).toBeDefined();
			expect(userMessage?.parts[0].text).toContain('TASK: Implement login');
			expect(userMessage?.parts[0].text).toContain('FILE: src/auth/login.ts');
			expect(userMessage?.parts[0].text).toContain(
				'ACCEPTANCE: User can log in',
			);
		});

		it('should not replace user message text with [NEXT] guidance', async () => {
			const config = makeConfig();
			const hook = createDelegationGateHook(config);

			const originalText = 'Important user message that must not be modified';
			const messages = makeMessages(originalText, 'architect');

			await hook.messagesTransform({}, messages);

			// Find user message
			const userMessage = messages.messages.find(
				(m) => m?.info?.role === 'user',
			);

			// Original text must be present
			expect(userMessage?.parts[0].text).toContain(originalText);

			// [NEXT] should be in a system message, NOT in user message
			expect(userMessage?.parts[0].text).not.toContain('[NEXT]');
		});

		it('should have system message with [NEXT] separate from user message', async () => {
			const config = makeConfig();
			const hook = createDelegationGateHook(config);

			const messages = makeMessages(
				'TASK: test\nFILE: src/test.ts',
				'architect',
			);

			await hook.messagesTransform({}, messages);

			// Check that there's a system message with [NEXT]
			const systemMessages = messages.messages.filter(
				(m) => m?.info?.role === 'system',
			);
			expect(systemMessages.length).toBeGreaterThan(0);

			const hasNextInSystem = systemMessages.some((m) =>
				m.parts[0].text?.includes('[NEXT]'),
			);
			expect(hasNextInSystem).toBe(true);

			// User message should NOT have [NEXT]
			const userMessage = messages.messages.find(
				(m) => m?.info?.role === 'user',
			);
			expect(userMessage?.parts[0].text).not.toContain('[NEXT]');
		});
	});

	describe('message index after splice (structural test)', () => {
		it('should have user message at correct index after system message insertion', async () => {
			const config = makeConfig();
			const hook = createDelegationGateHook(config);

			const messages = makeMessages('TASK: test', 'architect');

			// Before transformation - user message is at index 0
			expect(messages.messages[0].info.role).toBe('user');

			await hook.messagesTransform({}, messages);

			// After transformation - system message should be at index 0, user at index 1
			expect(messages.messages[0].info.role).toBe('system');
			expect(messages.messages[1].info.role).toBe('user');
		});

		it('should handle multiple transformations without corruption', async () => {
			const config = makeConfig();
			const hook = createDelegationGateHook(config);

			let messages = makeMessages('TASK: task1\nFILE: src/1.ts', 'architect');
			await hook.messagesTransform({}, messages);

			// First transformation
			expect(messages.messages[0].info.role).toBe('system');
			expect(messages.messages[1].info.role).toBe('user');

			// Second transformation with new messages array
			messages = makeMessages('TASK: task2\nFILE: src/2.ts', 'architect');
			await hook.messagesTransform({}, messages);

			// Should still work correctly
			expect(messages.messages[0].info.role).toBe('system');
			expect(messages.messages[1].info.role).toBe('user');
		});
	});
});
