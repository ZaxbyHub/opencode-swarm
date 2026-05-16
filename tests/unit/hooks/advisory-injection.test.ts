import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { GuardrailsConfig } from '../../../src/config/schema';
import {
	_internals,
	createGuardrailsHooks,
} from '../../../src/hooks/guardrails';
import {
	ensureAgentSession,
	resetSwarmState,
	swarmState,
} from '../../../src/state';

const TEST_DIR = '/test/project';

const defaultConfig: GuardrailsConfig = {
	enabled: true,
	max_tool_calls: 200,
	max_duration_minutes: 30,
	max_repetitions: 10,
	max_consecutive_errors: 5,
	warning_threshold: 0.75,
	idle_timeout_minutes: 60,
	qa_gates: {
		required_tools: [
			'diff',
			'syntax_check',
			'placeholder_scan',
			'lint',
			'pre_check_batch',
		],
		require_reviewer_test_engineer: true,
	},
};

describe('guardrails advisory injection', () => {
	let hooks: ReturnType<typeof createGuardrailsHooks>;

	beforeEach(() => {
		resetSwarmState();
		hooks = createGuardrailsHooks(TEST_DIR, defaultConfig);
	});

	afterEach(() => {
		resetSwarmState();
	});

	// -------------------------------------------------------------------------
	// Test (a): injects queued advisories into architect system message under [ADVISORIES] wrapper
	// -------------------------------------------------------------------------
	test('injects queued advisories into architect system message under [ADVISORIES] wrapper', async () => {
		const sessionId = 'session-advisory-a';
		ensureAgentSession(sessionId, 'architect');
		swarmState.activeAgent.set(sessionId, 'architect');

		// Pre-populate pendingAdvisoryMessages
		const session = swarmState.agentSessions.get(sessionId)!;
		session.pendingAdvisoryMessages = [
			'SLOP CHECK: abstraction_bloat detected',
		];

		const systemMessage = {
			info: { role: 'system', sessionID: sessionId },
			parts: [{ type: 'text' as const, text: 'You are a helpful assistant.' }],
		};

		const output = {
			messages: [
				systemMessage,
				{
					info: { role: 'user', sessionID: sessionId },
					parts: [{ type: 'text' as const, text: 'Hello' }],
				},
			],
		};

		await hooks.messagesTransform({}, output as any);

		// Check advisory was injected
		const textPart = output.messages[0].parts[0] as {
			type: string;
			text: string;
		};
		expect(textPart.text).toContain('[ADVISORIES]');
		expect(textPart.text).toContain('SLOP CHECK: abstraction_bloat detected');

		// Check queue is cleared after injection
		expect(session.pendingAdvisoryMessages).toHaveLength(0);
	});

	// -------------------------------------------------------------------------
	// Test (b): clears queue after injection
	// -------------------------------------------------------------------------
	test('clears queue after injection', async () => {
		const sessionId = 'session-advisory-b';
		ensureAgentSession(sessionId, 'architect');
		swarmState.activeAgent.set(sessionId, 'architect');

		// Pre-populate pendingAdvisoryMessages
		const session = swarmState.agentSessions.get(sessionId)!;
		session.pendingAdvisoryMessages = [
			'SLOP CHECK: abstraction_bloat detected',
		];

		const systemMessage = {
			info: { role: 'system', sessionID: sessionId },
			parts: [{ type: 'text' as const, text: 'You are a helpful assistant.' }],
		};

		const output = {
			messages: [
				systemMessage,
				{
					info: { role: 'user', sessionID: sessionId },
					parts: [{ type: 'text' as const, text: 'Hello' }],
				},
			],
		};

		await hooks.messagesTransform({}, output as any);

		// Check queue is cleared after injection
		expect(session.pendingAdvisoryMessages).toHaveLength(0);
	});

	// -------------------------------------------------------------------------
	// Test (c): does not inject for non-architect session
	// -------------------------------------------------------------------------
	test('does not inject for non-architect session', async () => {
		const sessionId = 'session-advisory-c';
		ensureAgentSession(sessionId, 'coder');
		swarmState.activeAgent.set(sessionId, 'coder');

		// Pre-populate pendingAdvisoryMessages on a non-architect session
		const session = swarmState.agentSessions.get(sessionId)!;
		session.pendingAdvisoryMessages = ['some advisory'];

		const systemMessage = {
			info: { role: 'system', sessionID: sessionId },
			parts: [{ type: 'text' as const, text: 'You are a coder agent.' }],
		};

		const output = {
			messages: [
				systemMessage,
				{
					info: { role: 'user', sessionID: sessionId },
					parts: [{ type: 'text' as const, text: 'Fix the bug' }],
				},
			],
		};

		await hooks.messagesTransform({}, output as any);

		// System message text should be unchanged — advisories are not injected for non-architect
		const textPart = output.messages[0].parts[0] as {
			type: string;
			text: string;
		};
		expect(textPart.text).toBe('You are a coder agent.');

		// Queue IS cleared even for non-architect sessions to prevent unbounded accumulation
		expect(session.pendingAdvisoryMessages).toHaveLength(0);
	});

	// -------------------------------------------------------------------------
	// Test (d): creates system message when none present and injects
	// -------------------------------------------------------------------------
	test('creates system message when none present and injects', async () => {
		const sessionId = 'session-advisory-d';
		ensureAgentSession(sessionId, 'architect');
		swarmState.activeAgent.set(sessionId, 'architect');

		// Pre-populate pendingAdvisoryMessages
		const session = swarmState.agentSessions.get(sessionId)!;
		session.pendingAdvisoryMessages = ['CONTEXT PRESSURE: 52.3% memory used'];

		// NO system message in the messages array (only a user message)
		const output = {
			messages: [
				{
					info: { role: 'user', sessionID: sessionId },
					parts: [{ type: 'text' as const, text: 'Hello' }],
				},
			],
		};

		await hooks.messagesTransform({}, output as any);

		// A new system message should have been prepended
		expect(output.messages.length).toBe(2);
		expect(output.messages[0].info.role).toBe('system');

		const textPart = output.messages[0].parts[0] as {
			type: string;
			text: string;
		};
		expect(textPart.text).toContain('[ADVISORIES]');
		expect(textPart.text).toContain('CONTEXT PRESSURE: 52.3% memory used');
	});

	// -------------------------------------------------------------------------
	// Test (e): multiple advisories joined with separator
	// -------------------------------------------------------------------------
	test('multiple advisories joined with separator', async () => {
		const sessionId = 'session-advisory-e';
		ensureAgentSession(sessionId, 'architect');
		swarmState.activeAgent.set(sessionId, 'architect');

		// Pre-populate with multiple advisories
		const session = swarmState.agentSessions.get(sessionId)!;
		session.pendingAdvisoryMessages = ['first advisory', 'second advisory'];

		const systemMessage = {
			info: { role: 'system', sessionID: sessionId },
			parts: [{ type: 'text' as const, text: 'You are a helpful assistant.' }],
		};

		const output = {
			messages: [
				systemMessage,
				{
					info: { role: 'user', sessionID: sessionId },
					parts: [{ type: 'text' as const, text: 'Hello' }],
				},
			],
		};

		await hooks.messagesTransform({}, output as any);

		// Check all three elements are present within [ADVISORIES] block
		const textPart = output.messages[0].parts[0] as {
			type: string;
			text: string;
		};
		expect(textPart.text).toContain('first advisory');
		expect(textPart.text).toContain('---');
		expect(textPart.text).toContain('second advisory');
	});

	test('injects recovery guidance after architect provider connection loss', async () => {
		const sessionId = 'session-openrouter-provider-loss';
		ensureAgentSession(sessionId, 'architect');
		swarmState.activeAgent.set(sessionId, 'architect');

		const output = {
			messages: [
				{
					info: { role: 'system', sessionID: sessionId },
					parts: [{ type: 'text' as const, text: 'You are the architect.' }],
				},
				{
					info: { role: 'assistant', sessionID: sessionId },
					parts: [
						{
							type: 'text' as const,
							text:
								'Partial analysis before interruption.\n' +
								'{"code":502,"message":"Network connection lost.","metadata":{"error_type":"provider_unavailable"}}',
						},
					],
				},
				{
					info: { role: 'user', sessionID: sessionId },
					parts: [{ type: 'text' as const, text: 'continue' }],
				},
			],
		};

		await hooks.messagesTransform({}, output as any);

		const textPart = output.messages[0].parts[0] as {
			type: string;
			text: string;
		};
		expect(textPart.text).toContain('[ADVISORIES]');
		expect(textPart.text).toContain('TRANSIENT PROVIDER RECOVERY');
		expect(textPart.text).toContain('continue from the last stable step');
	});

	test('does not duplicate provider recovery guidance for the same interrupted transcript', async () => {
		const sessionId = 'session-openrouter-provider-loss-dedupe';
		ensureAgentSession(sessionId, 'architect');
		swarmState.activeAgent.set(sessionId, 'architect');

		const output = {
			messages: [
				{
					info: { role: 'system', sessionID: sessionId },
					parts: [{ type: 'text' as const, text: 'You are the architect.' }],
				},
				{
					info: { role: 'assistant', sessionID: sessionId },
					parts: [
						{
							type: 'text' as const,
							text: '{"code":502,"message":"Network connection lost.","metadata":{"error_type":"provider_unavailable"}}',
						},
					],
				},
				{
					info: { role: 'user', sessionID: sessionId },
					parts: [{ type: 'text' as const, text: 'continue' }],
				},
			],
		};

		await hooks.messagesTransform({}, output as any);
		await hooks.messagesTransform({}, output as any);

		const textPart = output.messages[0].parts[0] as {
			type: string;
			text: string;
		};
		const occurrences = textPart.text.match(/TRANSIENT PROVIDER RECOVERY/g);
		expect(occurrences).toHaveLength(1);
	});

	test('does not duplicate provider recovery guidance when OpenCode supplies fresh message arrays', async () => {
		const sessionId = 'session-openrouter-provider-loss-fresh-dedupe';
		ensureAgentSession(sessionId, 'architect');
		swarmState.activeAgent.set(sessionId, 'architect');

		const makeOutput = () => ({
			messages: [
				{
					info: { role: 'system', sessionID: sessionId },
					parts: [{ type: 'text' as const, text: 'You are the architect.' }],
				},
				{
					info: { role: 'assistant', sessionID: sessionId },
					parts: [
						{
							type: 'text' as const,
							text: '{"code":502,"message":"Network connection lost.","metadata":{"error_type":"provider_unavailable"}}',
						},
					],
				},
				{
					info: { role: 'user', sessionID: sessionId },
					parts: [{ type: 'text' as const, text: 'continue' }],
				},
			],
		});

		const firstOutput = makeOutput();
		await hooks.messagesTransform({}, firstOutput as any);
		expect(firstOutput.messages[0].parts[0].text).toContain(
			'TRANSIENT PROVIDER RECOVERY',
		);

		const secondOutput = makeOutput();
		await hooks.messagesTransform({}, secondOutput as any);
		expect(secondOutput.messages[0].parts[0].text).not.toContain(
			'TRANSIENT PROVIDER RECOVERY',
		);
	});

	test('does not treat ordinary architect prose about connection loss as provider recovery', async () => {
		const sessionId = 'session-connection-lost-prose';
		ensureAgentSession(sessionId, 'architect');
		swarmState.activeAgent.set(sessionId, 'architect');

		const output = {
			messages: [
				{
					info: { role: 'system', sessionID: sessionId },
					parts: [{ type: 'text' as const, text: 'You are the architect.' }],
				},
				{
					info: { role: 'assistant', sessionID: sessionId },
					parts: [
						{
							type: 'text' as const,
							text: 'The application should handle a generic connection lost log line in its own UI.',
						},
					],
				},
				{
					info: { role: 'user', sessionID: sessionId },
					parts: [{ type: 'text' as const, text: 'continue' }],
				},
			],
		};

		await hooks.messagesTransform({}, output as any);
		expect(output.messages[0].parts[0].text).not.toContain(
			'TRANSIENT PROVIDER RECOVERY',
		);
	});

	test('does not inject provider recovery guidance for non-transient auth failures', async () => {
		const sessionId = 'session-provider-auth-failure';
		ensureAgentSession(sessionId, 'architect');
		swarmState.activeAgent.set(sessionId, 'architect');

		const output = {
			messages: [
				{
					info: { role: 'system', sessionID: sessionId },
					parts: [{ type: 'text' as const, text: 'You are the architect.' }],
				},
				{
					info: { role: 'assistant', sessionID: sessionId },
					parts: [
						{
							type: 'text' as const,
							text: '{"code":401,"message":"unauthorized: invalid API key","metadata":{"error_type":"auth_error"}}',
						},
					],
				},
				{
					info: { role: 'user', sessionID: sessionId },
					parts: [{ type: 'text' as const, text: 'continue' }],
				},
			],
		};

		await hooks.messagesTransform({}, output as any);
		expect(output.messages[0].parts[0].text).not.toContain(
			'TRANSIENT PROVIDER RECOVERY',
		);
	});

	test('provider recovery helpers classify, fingerprint, and select transcript text directly', () => {
		const messages = [
			{
				info: { role: 'assistant' },
				parts: [{ type: 'text' as const, text: 'older assistant text' }],
			},
			{
				info: { role: 'user' },
				parts: [{ type: 'text' as const, text: 'continue' }],
			},
			{
				info: { role: 'assistant' },
				parts: [
					{ type: 'tool_use' as const, text: 'ignored tool text' },
					{
						type: 'text' as const,
						text: '{"code":502,"message":"Network connection lost.","metadata":{"error_type":"provider_unavailable"}}',
					},
				],
			},
		];

		const latestAssistantText = _internals.getMostRecentAssistantText(messages);
		expect(latestAssistantText).toContain('Network connection lost');
		expect(latestAssistantText).not.toContain('older assistant text');
		expect(latestAssistantText).not.toContain('ignored tool text');
		expect(_internals.isTransientProviderFailureText(latestAssistantText)).toBe(
			true,
		);
		expect(
			_internals.isTransientProviderFailureText(
				'{"code":401,"message":"unauthorized: invalid API key","metadata":{"error_type":"auth_error"}}',
			),
		).toBe(false);
		expect(_internals.getProviderFailureFingerprint(latestAssistantText)).toBe(
			_internals.getProviderFailureFingerprint(latestAssistantText),
		);
		expect(_internals.getProviderFailureFingerprint('first')).not.toBe(
			_internals.getProviderFailureFingerprint('second'),
		);
	});
});
