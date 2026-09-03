import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
	_internals,
	createGuardrailsHooks,
} from '../../../src/hooks/guardrails';
import {
	findGuidanceCarriers,
	isGuidanceCarrier,
	messageTextOf,
} from '../../../src/hooks/system-guidance-carrier';
import {
	ensureAgentSession,
	resetSwarmState,
	swarmState,
} from '../../../src/state';
import { defaultConfig } from './_advisory-injection-helpers';

const TEST_DIR = '/test/project';

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
	// Drain hygiene: all ~67 producers feed this one queue. Two rules here cover
	// every producer, including ones added later.
	// -------------------------------------------------------------------------

	test('collapses exact duplicate advisories to a single occurrence', async () => {
		const sessionId = 'session-advisory-dedupe';
		ensureAgentSession(sessionId, 'architect');
		swarmState.activeAgent.set(sessionId, 'architect');

		const session = swarmState.agentSessions.get(sessionId)!;
		// N parallel lanes reporting the identical condition. Only 5 of 67
		// producer sites dedupe today, each with its own ad-hoc key.
		session.pendingAdvisoryMessages = [
			'DEGRADED: Context-limit error detected. No fallback models available.',
			'DEGRADED: Context-limit error detected. No fallback models available.',
			'DEGRADED: Context-limit error detected. No fallback models available.',
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

		const textPart = output.messages[0].parts[0] as {
			type: string;
			text: string;
		};
		const occurrences =
			textPart.text.split('No fallback models available.').length - 1;
		expect(occurrences).toBe(1);
	});

	test('keeps near-identical advisories that differ in their details', async () => {
		// Only EXACT duplicates collapse. Advisories differing by task id, lane id
		// or count carry distinct information and must all survive.
		const sessionId = 'session-advisory-near-dupe';
		ensureAgentSession(sessionId, 'architect');
		swarmState.activeAgent.set(sessionId, 'architect');

		const session = swarmState.agentSessions.get(sessionId)!;
		session.pendingAdvisoryMessages = [
			'[PIPELINE] reviewer delegation complete for task 1.1',
			'[PIPELINE] reviewer delegation complete for task 1.2',
		];

		const systemMessage = {
			info: { role: 'system', sessionID: sessionId },
			parts: [{ type: 'text' as const, text: 'base' }],
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

		const textPart = output.messages[0].parts[0] as {
			type: string;
			text: string;
		};
		expect(textPart.text).toContain('task 1.1');
		expect(textPart.text).toContain('task 1.2');
	});

	test('drops blank advisories, and emits no [ADVISORIES] block when all are blank', async () => {
		const sessionId = 'session-advisory-blank';
		ensureAgentSession(sessionId, 'architect');
		swarmState.activeAgent.set(sessionId, 'architect');

		const session = swarmState.agentSessions.get(sessionId)!;
		session.pendingAdvisoryMessages = ['', '   ', '\n\t '];

		const systemMessage = {
			info: { role: 'system', sessionID: sessionId },
			parts: [{ type: 'text' as const, text: 'base text' }],
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

		// Issue #2526: guidance rides a user-role carrier unshifted at index 0; the
		// pre-seeded system message shifts to index 1 and is never touched.
		const carriers = findGuidanceCarriers(output.messages as any);
		expect(carriers).toHaveLength(1);
		// An empty [ADVISORIES] wrapper would itself be the content-free injection
		// this rule exists to remove.
		expect(messageTextOf(carriers[0])).not.toContain('[ADVISORIES]');
		// Deliberately NOT an exact-equality assertion: an unrelated injector
		// (the PARTIAL GATE VIOLATION detector, which fires on any fresh session
		// because an empty gateLog reads as "all gates missing") also prepends to
		// the same carrier body. That defect is tracked separately in #1976 and is
		// explicitly out of scope here. Asserting equality would couple this test
		// to a surface it does not control.
		expect(output.messages[1].parts[0]?.text).toContain('base text');
		// Still drained, so blanks cannot accumulate.
		expect(session.pendingAdvisoryMessages).toHaveLength(0);
	});

	test('a real advisory still survives alongside blanks and duplicates', async () => {
		// The hygiene rules must narrow, never silence.
		const sessionId = 'session-advisory-mixed';
		ensureAgentSession(sessionId, 'architect');
		swarmState.activeAgent.set(sessionId, 'architect');

		const session = swarmState.agentSessions.get(sessionId)!;
		session.pendingAdvisoryMessages = [
			'',
			'NON-TRANSIENT STOP (command_not_found, 1/1): STOP.',
			'   ',
			'NON-TRANSIENT STOP (command_not_found, 1/1): STOP.',
		];

		const systemMessage = {
			info: { role: 'system', sessionID: sessionId },
			parts: [{ type: 'text' as const, text: 'base' }],
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

		const textPart = output.messages[0].parts[0] as {
			type: string;
			text: string;
		};
		expect(textPart.text).toContain('[ADVISORIES]');
		const occurrences = textPart.text.split('NON-TRANSIENT STOP').length - 1;
		expect(occurrences).toBe(1);
	});

	test('the queue is NOT discarded unread when no injectable text surface pre-exists', async () => {
		// Pre-#2526, the clear sat outside the `if (textPart)` guard, so a system
		// message carrying no string text part silently destroyed the whole queue.
		// The guidance carrier removed that failure mode structurally: it is
		// find-or-created with its OWN text part, so delivery never depends on the
		// shapes of surrounding messages. The drain now clears unconditionally
		// AFTER emission (issue #2526 contract change — blank entries are dropped
		// by the hygiene rules, so keeping them would re-drain every turn).
		const sessionId = 'session-advisory-no-textpart';
		ensureAgentSession(sessionId, 'architect');
		swarmState.activeAgent.set(sessionId, 'architect');

		const session = swarmState.agentSessions.get(sessionId)!;
		session.pendingAdvisoryMessages = ['DEGRADED: something real happened'];

		const systemMessage = {
			info: { role: 'system', sessionID: sessionId },
			// No text part at all — must no longer matter to delivery.
			parts: [{ type: 'file' as const, text: undefined }],
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

		// The advisory was READ (delivered into the carrier), not silently destroyed.
		const carrier = findGuidanceCarriers(output.messages as any)[0];
		expect(carrier).toBeDefined();
		expect(messageTextOf(carrier)).toContain(
			'DEGRADED: something real happened',
		);
		// Intentional new contract (#2526): clearing is unconditional after the
		// drain block — the advisory above was delivered, so the queue is empty.
		expect(session.pendingAdvisoryMessages).toEqual([]);
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
	// Test (d): creates a guidance carrier when none present and injects
	// -------------------------------------------------------------------------
	test('creates a guidance carrier when none present and injects', async () => {
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

		// Issue #2526: a USER-role guidance carrier (id 'swarm-guidance:guardrails')
		// is prepended — the OpenCode host drops role:'system' entries from this
		// transform surface, so guidance must ride a user-role message instead.
		expect(output.messages.length).toBe(2);
		expect(isGuidanceCarrier(output.messages[0])).toBe(true);
		expect(output.messages[0].info.role).toBe('user');
		expect((output.messages[0].info as { id?: unknown }).id).toBe(
			'swarm-guidance:guardrails',
		);

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

	// -------------------------------------------------------------------------
	// FR-002 / FR-007: expanded isTransientProviderFailureText() — raw Node.js error codes
	// ECONNRESET, ECONNREFUSED, ETIMEDOUT, EPIPE, ENOTFOUND + connection phrases
	// -------------------------------------------------------------------------

	test('injects recovery guidance after architect ECONNRESET error', async () => {
		const sessionId = 'session-econnreset';
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
							text: 'Partial analysis.\nError: ECONNRESET',
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

	test('injects recovery guidance after architect ECONNREFUSED error', async () => {
		const sessionId = 'session-econnrefused';
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
							text: 'Partial analysis.\nError: ECONNREFUSED',
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

	test('injects recovery guidance after architect ETIMEDOUT error', async () => {
		const sessionId = 'session-etimedout';
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
							text: 'Partial analysis.\nError: ETIMEDOUT',
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

	test('injects recovery guidance after architect EPIPE error', async () => {
		const sessionId = 'session-epipe';
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
							text: 'Partial analysis.\nError: EPIPE',
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

	test('injects recovery guidance after architect ENOTFOUND error', async () => {
		const sessionId = 'session-enotfound';
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
							text: 'Partial analysis.\nError: ENOTFOUND',
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

	test('injects recovery guidance after architect "connection reset by peer" phrase', async () => {
		const sessionId = 'session-conn-reset-by-peer';
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
							text: 'Partial analysis.\nConnection reset by peer',
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

	test('injects recovery guidance after architect "connection refused" phrase', async () => {
		const sessionId = 'session-conn-refused';
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
							text: 'Partial analysis.\nConnection refused',
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

	test('does not inject recovery advisory for "timeout" in a coding context without provider failure marker', async () => {
		// providerFailureMarker gate prevents false positives from non-error prose
		const sessionId = 'session-timeout-coding-context';
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
							text: 'The function has a 500ms timeout for the API call.',
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
		expect(textPart.text).not.toContain('TRANSIENT PROVIDER RECOVERY');
	});

	test('deduplicates recovery advisory for the same raw error code across two turns', async () => {
		const sessionId = 'session-raw-code-dedupe';
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
							text: 'Partial analysis.\nError: ECONNRESET',
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

	test('does not inject provider recovery guidance for non-transient auth failures', async () => {
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
