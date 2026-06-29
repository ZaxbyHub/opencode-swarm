/**
 * Security, validation, and regression tests (delegation-gate-task-1-5.test.ts — Part 3 of 3)
 *
 * Covers:
 * - sessionID validation (security)
 * - null/undefined lastGateOutcome handling
 * - Duplicate guidance insertion (violation + deliberation)
 * - Empty agent handling (regression from Task 1.4)
 * - Batch detection regression
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { PluginConfig } from '../../../src/config';
import { createDelegationGateHook } from '../../../src/hooks/delegation-gate';
import { ensureAgentSession, resetSwarmState } from '../../../src/state';
import { makeConfig, makeMessages } from './_delegation-gate-helpers';

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

describe('delegation-gate task 1.5: sessionID validation (security)', () => {
	beforeEach(() => {
		resetSwarmState();
	});

	afterEach(() => {
		resetSwarmState();
	});

	it('should reject sessionID with invalid characters', async () => {
		const config = makeConfig();
		const hook = createDelegationGateHook(config, process.cwd());

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
		const hook = createDelegationGateHook(config, process.cwd());

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

describe('delegation-gate task 1.5: null/undefined lastGateOutcome handling', () => {
	beforeEach(() => {
		resetSwarmState();
	});

	afterEach(() => {
		resetSwarmState();
	});

	it('should handle null lastGateOutcome gracefully', async () => {
		const config = makeConfig();
		const hook = createDelegationGateHook(config, process.cwd());

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
		const hook = createDelegationGateHook(config, process.cwd());

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
		const hook = createDelegationGateHook(config, process.cwd());

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
		const hook = createDelegationGateHook(config, process.cwd());

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

describe('delegation-gate task 1.5: duplicate guidance insertion (violation + deliberation)', () => {
	beforeEach(() => {
		resetSwarmState();
	});

	afterEach(() => {
		resetSwarmState();
	});

	it('should handle both zero-coder violation and deliberation guidance', async () => {
		const config = makeConfig();
		const hook = createDelegationGateHook(config, process.cwd());

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
		const hook = createDelegationGateHook(config, process.cwd());

		const session = ensureAgentSession('test-session');
		session.architectWriteCount = 1;
		session.lastCoderDelegationTaskId = '1.1';

		const originalText = 'TASK: 1.2\nFILE: src/new.ts';
		const messages = makeMessages(originalText, 'architect');

		await hook.messagesTransform({}, messages);

		// Find user message - should be preserved
		const userMessage = messages.messages.find((m) => m?.info?.role === 'user');

		expect(userMessage?.parts[0].text).toContain(originalText);
	});
});

describe('delegation-gate task 1.5: empty agent handling (regression from Task 1.4)', () => {
	beforeEach(() => {
		resetSwarmState();
	});

	afterEach(() => {
		resetSwarmState();
	});

	it('should skip guidance injection for empty string agent', async () => {
		const config = makeConfig();
		const hook = createDelegationGateHook(config, process.cwd());

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
		const hook = createDelegationGateHook(config, process.cwd());

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
		const hook = createDelegationGateHook(config, process.cwd());

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

describe('delegation-gate task 1.5: batch detection regression', () => {
	beforeEach(() => {
		resetSwarmState();
	});

	afterEach(() => {
		resetSwarmState();
	});

	it('should still detect batching language after [NEXT] guidance change', async () => {
		const config = makeConfig();
		const hook = createDelegationGateHook(config, process.cwd());

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
		const hook = createDelegationGateHook(config, process.cwd());

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
