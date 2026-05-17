import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { GuardrailsConfig } from '../../../src/config/schema';
import {
	_internals,
	createGuardrailsHooks,
} from '../../../src/hooks/guardrails';
import {
	ensureAgentSession,
	getActiveWindow,
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
	max_transient_retries: 5,
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

/**
 * Sets up a subagent session with a window for messagesTransform testing.
 * Architect sessions are identified by activeAgent === 'architect' (ORCHESTRATOR_NAME).
 * Subagent sessions use 'coder', 'reviewer', etc.
 */
async function setupSubagentSession(
	hooks: ReturnType<typeof createGuardrailsHooks>,
	sessionId: string,
	agentName = 'coder',
) {
	ensureAgentSession(sessionId, agentName);
	swarmState.activeAgent.set(sessionId, agentName);

	// Call toolBefore to create the window (getOrCreateWindow is called in toolBefore)
	const input = { tool: 'Task', sessionID: sessionId, callID: 'call-init' };
	const output = {
		args: { subagent_type: agentName, prompt: 'Initial setup' },
	};
	await hooks.toolBefore(input as any, output as any);

	return swarmState.agentSessions.get(sessionId)!;
}

describe('guardrails subagent advisory injection (messagesTransform)', () => {
	let hooks: ReturnType<typeof createGuardrailsHooks>;

	beforeEach(() => {
		resetSwarmState();
		hooks = createGuardrailsHooks(TEST_DIR, defaultConfig);
	});

	afterEach(() => {
		resetSwarmState();
	});

	// -------------------------------------------------------------------------
	// Test 1: Subagent session with TRANSIENT ERROR advisory → injected into system message
	// -------------------------------------------------------------------------
	test('subagent with TRANSIENT ERROR advisory → injected into system message', async () => {
		const sessionId = 'session-transient-error';
		const session = await setupSubagentSession(hooks, sessionId, 'coder');

		// Pre-populate a TRANSIENT ERROR advisory (as would be set by toolAfter)
		session.pendingAdvisoryMessages = [
			'TRANSIENT ERROR: HTTP 503 Service Unavailable',
		];

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

		// Advisory should be injected
		const textPart = output.messages[0].parts[0] as {
			type: string;
			text: string;
		};
		expect(textPart.text).toContain('[ADVISORIES]');
		expect(textPart.text).toContain(
			'TRANSIENT ERROR: HTTP 503 Service Unavailable',
		);
		expect(textPart.text).toContain('[/ADVISORIES]');

		// Queue should be drained
		expect(session.pendingAdvisoryMessages).toHaveLength(0);
	});

	// -------------------------------------------------------------------------
	// Test 2: Subagent session with MODEL FALLBACK advisory → injected into system message
	// -------------------------------------------------------------------------
	test('subagent with MODEL FALLBACK advisory → injected into system message', async () => {
		const sessionId = 'session-model-fallback';
		const session = await setupSubagentSession(hooks, sessionId, 'reviewer');

		// Pre-populate a MODEL FALLBACK advisory
		session.pendingAdvisoryMessages = [
			'MODEL FALLBACK: Switched to model-a due to context length exceeded',
		];

		const systemMessage = {
			info: { role: 'system', sessionID: sessionId },
			parts: [{ type: 'text' as const, text: 'You are a reviewer agent.' }],
		};

		const output = {
			messages: [
				systemMessage,
				{
					info: { role: 'user', sessionID: sessionId },
					parts: [{ type: 'text' as const, text: 'Review the code' }],
				},
			],
		};

		await hooks.messagesTransform({}, output as any);

		// Advisory should be injected
		const textPart = output.messages[0].parts[0] as {
			type: string;
			text: string;
		};
		expect(textPart.text).toContain('[ADVISORIES]');
		expect(textPart.text).toContain(
			'MODEL FALLBACK: Switched to model-a due to context length exceeded',
		);
		expect(textPart.text).toContain('[/ADVISORIES]');

		// Queue should be drained
		expect(session.pendingAdvisoryMessages).toHaveLength(0);
	});

	// -------------------------------------------------------------------------
	// Test 3: Subagent session with DEGRADED advisory → injected into system message
	// -------------------------------------------------------------------------
	test('subagent with DEGRADED advisory → injected into system message', async () => {
		const sessionId = 'session-degraded';
		const session = await setupSubagentSession(hooks, sessionId, 'coder');

		// Pre-populate a DEGRADED advisory
		session.pendingAdvisoryMessages = [
			'DEGRADED: context length exceeded, Fallback model 1/2 considered',
		];

		const systemMessage = {
			info: { role: 'system', sessionID: sessionId },
			parts: [{ type: 'text' as const, text: 'You are a coder agent.' }],
		};

		const output = {
			messages: [
				systemMessage,
				{
					info: { role: 'user', sessionID: sessionId },
					parts: [{ type: 'text' as const, text: 'Implement the feature' }],
				},
			],
		};

		await hooks.messagesTransform({}, output as any);

		// Advisory should be injected
		const textPart = output.messages[0].parts[0] as {
			type: string;
			text: string;
		};
		expect(textPart.text).toContain('[ADVISORIES]');
		expect(textPart.text).toContain(
			'DEGRADED: context length exceeded, Fallback model 1/2 considered',
		);
		expect(textPart.text).toContain('[/ADVISORIES]');

		// Queue should be drained
		expect(session.pendingAdvisoryMessages).toHaveLength(0);
	});

	// -------------------------------------------------------------------------
	// Test 4: Subagent session with non-transient advisory → drained silently, NOT injected
	// -------------------------------------------------------------------------
	test('subagent with non-transient advisory (SLOP DETECTED) → drained silently, NOT injected', async () => {
		const sessionId = 'session-slop-drained';
		const session = await setupSubagentSession(hooks, sessionId, 'coder');

		// Pre-populate a non-transient advisory
		session.pendingAdvisoryMessages = [
			'SLOP DETECTED: abstraction_bloat in src/utils.ts',
		];

		const systemMessage = {
			info: { role: 'system', sessionID: sessionId },
			parts: [{ type: 'text' as const, text: 'You are a coder agent.' }],
		};

		const output = {
			messages: [
				systemMessage,
				{
					info: { role: 'user', sessionID: sessionId },
					parts: [{ type: 'text' as const, text: 'Refactor the code' }],
				},
			],
		};

		await hooks.messagesTransform({}, output as any);

		// System message text should be UNCHANGED — non-transient advisories are NOT injected
		const textPart = output.messages[0].parts[0] as {
			type: string;
			text: string;
		};
		expect(textPart.text).toBe('You are a coder agent.');
		expect(textPart.text).not.toContain('[ADVISORIES]');
		expect(textPart.text).not.toContain('SLOP DETECTED');

		// Queue should still be drained
		expect(session.pendingAdvisoryMessages).toHaveLength(0);
	});

	// -------------------------------------------------------------------------
	// Test 5: Subagent session with mix of transient + non-transient advisories → only transient injected
	// -------------------------------------------------------------------------
	test('subagent with mix of transient + non-transient advisories → only transient injected', async () => {
		const sessionId = 'session-mixed-advisories';
		const session = await setupSubagentSession(hooks, sessionId, 'coder');

		// Mix of transient and non-transient advisories
		session.pendingAdvisoryMessages = [
			'TRANSIENT ERROR: HTTP 502 Bad Gateway',
			'SLOP DETECTED: abstraction_bloat in src/utils.ts',
			'MODEL FALLBACK: context length exceeded, Fallback model 2/3 considered',
		];

		const systemMessage = {
			info: { role: 'system', sessionID: sessionId },
			parts: [{ type: 'text' as const, text: 'You are a coder agent.' }],
		};

		const output = {
			messages: [
				systemMessage,
				{
					info: { role: 'user', sessionID: sessionId },
					parts: [{ type: 'text' as const, text: 'Work on the task' }],
				},
			],
		};

		await hooks.messagesTransform({}, output as any);

		// Only transient advisories should be injected
		const textPart = output.messages[0].parts[0] as {
			type: string;
			text: string;
		};
		expect(textPart.text).toContain('[ADVISORIES]');
		expect(textPart.text).toContain('TRANSIENT ERROR: HTTP 502 Bad Gateway');
		expect(textPart.text).toContain(
			'MODEL FALLBACK: context length exceeded, Fallback model 2/3 considered',
		);

		// Non-transient SLOP should NOT be injected
		expect(textPart.text).not.toContain('SLOP DETECTED');

		// Queue should be fully drained (both transient and non-transient)
		expect(session.pendingAdvisoryMessages).toHaveLength(0);
	});

	// -------------------------------------------------------------------------
	// Test 6: Subagent session with no system message → new system message created for injection
	// -------------------------------------------------------------------------
	test('subagent with no system message → new system message created for injection', async () => {
		const sessionId = 'session-no-system-msg';
		const session = await setupSubagentSession(hooks, sessionId, 'coder');

		// Pre-populate a transient advisory
		session.pendingAdvisoryMessages = ['TRANSIENT ERROR: connection refused'];

		// NO system message in the messages array (only a user message)
		const output = {
			messages: [
				{
					info: { role: 'user', sessionID: sessionId },
					parts: [{ type: 'text' as const, text: 'Do the work' }],
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
		expect(textPart.text).toContain('TRANSIENT ERROR: connection refused');
		expect(textPart.text).toContain('[/ADVISORIES]');

		// Queue should be drained
		expect(session.pendingAdvisoryMessages).toHaveLength(0);
	});

	// -------------------------------------------------------------------------
	// Additional edge cases
	// -------------------------------------------------------------------------

	test('subagent with DEGRADED: prefix variation (caps) → still injected', async () => {
		const sessionId = 'session-degraded-caps';
		const session = await setupSubagentSession(hooks, sessionId, 'coder');

		session.pendingAdvisoryMessages = [
			'DEGRADED: token limit exceeded, Fallback model 1/2 considered',
		];

		const systemMessage = {
			info: { role: 'system', sessionID: sessionId },
			parts: [{ type: 'text' as const, text: 'You are a coder.' }],
		};

		const output = {
			messages: [systemMessage],
		};

		await hooks.messagesTransform({}, output as any);

		const textPart = output.messages[0].parts[0] as {
			type: string;
			text: string;
		};
		expect(textPart.text).toContain('DEGRADED:');
	});

	test('subagent with MODEL FALLBACK: prefix (caps) → still injected', async () => {
		const sessionId = 'session-model-fallback-caps';
		const session = await setupSubagentSession(hooks, sessionId, 'reviewer');

		session.pendingAdvisoryMessages = ['MODEL FALLBACK: Switched to model-b'];

		const systemMessage = {
			info: { role: 'system', sessionID: sessionId },
			parts: [{ type: 'text' as const, text: 'You are a reviewer.' }],
		};

		const output = {
			messages: [systemMessage],
		};

		await hooks.messagesTransform({}, output as any);

		const textPart = output.messages[0].parts[0] as {
			type: string;
			text: string;
		};
		expect(textPart.text).toContain('MODEL FALLBACK:');
	});

	test('subagent with empty pendingAdvisoryMessages → no changes to system message', async () => {
		const sessionId = 'session-empty-advisories';
		const session = await setupSubagentSession(hooks, sessionId, 'coder');

		session.pendingAdvisoryMessages = [];

		const systemMessage = {
			info: { role: 'system', sessionID: sessionId },
			parts: [{ type: 'text' as const, text: 'You are a coder agent.' }],
		};

		const output = {
			messages: [systemMessage],
		};

		await hooks.messagesTransform({}, output as any);

		const textPart = output.messages[0].parts[0] as {
			type: string;
			text: string;
		};
		expect(textPart.text).toBe('You are a coder agent.');
		expect(textPart.text).not.toContain('[ADVISORIES]');
	});

	test('subagent pendingAdvisoryMessages undefined → no crash, no injection', async () => {
		const sessionId = 'session-undefined-advisories';
		const session = await setupSubagentSession(hooks, sessionId, 'coder');

		// Ensure pendingAdvisoryMessages is undefined/null
		session.pendingAdvisoryMessages = undefined;

		const systemMessage = {
			info: { role: 'system', sessionID: sessionId },
			parts: [{ type: 'text' as const, text: 'You are a coder agent.' }],
		};

		const output = {
			messages: [systemMessage],
		};

		// Should not throw
		await hooks.messagesTransform({}, output as any);

		const textPart = output.messages[0].parts[0] as {
			type: string;
			text: string;
		};
		expect(textPart.text).toBe('You are a coder agent.');
	});
});
