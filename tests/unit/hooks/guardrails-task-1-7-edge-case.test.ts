import { beforeEach, describe, expect, it } from 'bun:test';
import { ORCHESTRATOR_NAME } from '../../../src/config/constants';
import type { GuardrailsConfig } from '../../../src/config/schema';
import { createGuardrailsHooks } from '../../../src/hooks/guardrails';
import {
	ensureAgentSession,
	resetSwarmState,
	startAgentSession,
	swarmState,
} from '../../../src/state';

function defaultConfig(
	overrides?: Partial<GuardrailsConfig>,
): GuardrailsConfig {
	return {
		enabled: true,
		max_tool_calls: 200,
		max_duration_minutes: 30,
		idle_timeout_minutes: 60,
		max_repetitions: 10,
		max_consecutive_errors: 5,
		warning_threshold: 0.75,
		profiles: undefined,
		...overrides,
	};
}

describe('ADVERSARIAL: Task 1.7 edge-case fix verification - missing system message', () => {
	beforeEach(() => {
		resetSwarmState();
	});

	describe('Attack Vector 1: No system message exists - edge case fix creates one', () => {
		it('self-coding warning: creates system message when none exists', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(config);

			// Set up architect session with write count
			const sessionId = 'test-session';
			swarmState.activeAgent.set(sessionId, ORCHESTRATOR_NAME);
			startAgentSession(sessionId, ORCHESTRATOR_NAME);
			const session = ensureAgentSession(sessionId);
			session.architectWriteCount = 1;

			// Create messages with NO system message (only user message)
			const messages = {
				messages: [
					{
						info: { role: 'user' as const, sessionID: sessionId },
						parts: [{ type: 'text' as const, text: 'Hello' }],
					},
				],
			};

			await hooks.messagesTransform({}, messages as any);

			// Verify system message was created and prepended
			expect(messages.messages.length).toBe(2);
			expect(messages.messages[0].info.role).toBe('system');
			expect(messages.messages[0].parts[0].text).toContain(
				'SELF-CODING DETECTED',
			);
			// Original user message should still be intact
			expect(messages.messages[1].info.role).toBe('user');
		});

		it('self-fix warning: creates system message when none exists', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(config);

			// Set up architect session with self-fix state
			const sessionId = 'test-session';
			swarmState.activeAgent.set(sessionId, ORCHESTRATOR_NAME);
			startAgentSession(sessionId, ORCHESTRATOR_NAME);
			const session = ensureAgentSession(sessionId);
			session.selfFixAttempted = true;
			session.lastGateFailure = {
				tool: 'lint',
				taskId: 'task-1',
				timestamp: Date.now(), // within 2 minutes
			};

			// Create messages with NO system message
			const messages = {
				messages: [
					{
						info: { role: 'user' as const, sessionID: sessionId },
						parts: [{ type: 'text' as const, text: 'Hello' }],
					},
				],
			};

			await hooks.messagesTransform({}, messages as any);

			// Verify system message was created and prepended
			expect(messages.messages.length).toBe(2);
			expect(messages.messages[0].info.role).toBe('system');
			expect(messages.messages[0].parts[0].text).toContain('SELF-FIX DETECTED');
		});
	});

	describe('Attack Vector 2: System message exists but has no parts array', () => {
		it('should NOT crash when existing system message has undefined parts', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(config);

			const sessionId = 'test-session';
			swarmState.activeAgent.set(sessionId, ORCHESTRATOR_NAME);
			startAgentSession(sessionId, ORCHESTRATOR_NAME);
			const session = ensureAgentSession(sessionId);
			session.architectWriteCount = 1;

			// System message with NO parts array (malformed)
			const messages = {
				messages: [
					{
						info: { role: 'system' as const, sessionID: sessionId },
						// parts is undefined/missing
					} as any,
					{
						info: { role: 'user' as const, sessionID: sessionId },
						parts: [{ type: 'text' as const, text: 'Hello' }],
					},
				],
			};

			// Should NOT throw - should handle gracefully
			await expect(
				hooks.messagesTransform({}, messages as any),
			).resolves.toBeUndefined();
		});

		it('should NOT crash when existing system message has empty parts array', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(config);

			const sessionId = 'test-session';
			swarmState.activeAgent.set(sessionId, ORCHESTRATOR_NAME);
			startAgentSession(sessionId, ORCHESTRATOR_NAME);
			const session = ensureAgentSession(sessionId);
			session.architectWriteCount = 1;

			// System message with empty parts array
			const messages = {
				messages: [
					{
						info: { role: 'system' as const, sessionID: sessionId },
						parts: [],
					},
					{
						info: { role: 'user' as const, sessionID: sessionId },
						parts: [{ type: 'text' as const, text: 'Hello' }],
					},
				],
			};

			// Should NOT throw - should handle gracefully
			await expect(
				hooks.messagesTransform({}, messages as any),
			).resolves.toBeUndefined();
		});
	});

	describe('Attack Vector 3: System message exists but has no text part', () => {
		it('should NOT crash when system message has no text part', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(config);

			const sessionId = 'test-session';
			swarmState.activeAgent.set(sessionId, ORCHESTRATOR_NAME);
			startAgentSession(sessionId, ORCHESTRATOR_NAME);
			const session = ensureAgentSession(sessionId);
			session.architectWriteCount = 1;

			// System message with only image part (no text)
			const messages = {
				messages: [
					{
						info: { role: 'system' as const, sessionID: sessionId },
						parts: [
							{ type: 'image' as const, url: 'https://example.com/image.png' },
						],
					},
					{
						info: { role: 'user' as const, sessionID: sessionId },
						parts: [{ type: 'text' as const, text: 'Hello' }],
					},
				],
			};

			// Should NOT throw - should handle gracefully
			await expect(
				hooks.messagesTransform({}, messages as any),
			).resolves.toBeUndefined();
		});
	});

	describe('Attack Vector 4: Both self-coding and self-fix trigger in same call', () => {
		it('should NOT create duplicate system messages', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(config);

			const sessionId = 'test-session';
			swarmState.activeAgent.set(sessionId, ORCHESTRATOR_NAME);
			startAgentSession(sessionId, ORCHESTRATOR_NAME);
			const session = ensureAgentSession(sessionId);
			session.architectWriteCount = 1;
			session.selfFixAttempted = true;
			session.lastGateFailure = {
				tool: 'lint',
				taskId: 'task-1',
				timestamp: Date.now(), // within 2 minutes
			};

			// No system message exists
			const messages = {
				messages: [
					{
						info: { role: 'user' as const, sessionID: sessionId },
						parts: [{ type: 'text' as const, text: 'Hello' }],
					},
				],
			};

			await hooks.messagesTransform({}, messages as any);

			// Should have exactly 2 messages: 1 system (created) + 1 original user
			expect(messages.messages.length).toBe(2);
			expect(messages.messages[0].info.role).toBe('system');

			// System message should contain BOTH warnings
			const systemText = messages.messages[0].parts[0].text;
			expect(systemText).toContain('SELF-CODING DETECTED');
			expect(systemText).toContain('SELF-FIX DETECTED');
		});
	});

	describe('Attack Vector 5: Duplicate injection prevention', () => {});

	describe('Attack Vector 6: Visible leakage check - MODEL_ONLY_GUIDANCE in system message only', () => {
		it('should NOT inject model-only guidance into user-visible messages', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(config);

			const sessionId = 'test-session';
			swarmState.activeAgent.set(sessionId, ORCHESTRATOR_NAME);
			startAgentSession(sessionId, ORCHESTRATOR_NAME);
			const session = ensureAgentSession(sessionId);
			session.architectWriteCount = 1;

			// Messages with no system message - edge case fix creates one
			const messages = {
				messages: [
					{
						info: { role: 'user' as const, sessionID: sessionId },
						parts: [{ type: 'text' as const, text: 'Hello' }],
					},
				],
			};

			await hooks.messagesTransform({}, messages as any);

			// Check user message does NOT contain MODEL_ONLY_GUIDANCE
			const userMessageText = messages.messages[1].parts[0].text;
			expect(userMessageText).not.toContain('MODEL_ONLY_GUIDANCE');
			expect(userMessageText).not.toContain('SELF-CODING DETECTED');

			// System message SHOULD contain MODEL_ONLY_GUIDANCE
			const systemMessageText = messages.messages[0].parts[0].text;
			expect(systemMessageText).toContain('MODEL_ONLY_GUIDANCE');
		});
	});

	describe('Attack Vector 7: Session ID edge cases', () => {
		it('should handle missing sessionID gracefully', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(config);

			// No session started - no architect session
			const messages = {
				messages: [
					{
						info: { role: 'user' as const }, // No sessionID
						parts: [{ type: 'text' as const, text: 'Hello' }],
					},
				],
			};

			// Should NOT throw
			await expect(
				hooks.messagesTransform({}, messages as any),
			).resolves.toBeUndefined();
		});
	});
});
