import { beforeEach, describe, expect, it } from 'bun:test';
import type { GuardrailsConfig } from '../../../src/config/schema';
import { createGuardrailsHooks } from '../../../src/hooks/guardrails';
import { ensureAgentSession, resetSwarmState } from '../../../src/state';

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

describe('guardrails prompt trimming for low-capability models (Task 4.5)', () => {
	beforeEach(() => {
		resetSwarmState();
	});

	// Helper to create a system message with BEHAVIORAL_GUIDANCE markers
	function makeSystemMessage(text: string) {
		return {
			info: { role: 'system' as const, sessionID: 'test-session' },
			parts: [{ type: 'text' as const, text }],
		};
	}

	// Helper to create an assistant message with modelID
	function makeAssistantMessage(modelID: string) {
		return {
			info: { role: 'assistant' as const, sessionID: 'test-session', modelID },
			parts: [{ type: 'text' as const, text: 'assistant response' }],
		};
	}

	// Helper to create a user message
	function makeUserMessage(text: string, agent?: string) {
		return {
			info: { role: 'user' as const, sessionID: 'test-session', agent },
			parts: [{ type: 'text' as const, text }],
		};
	}

	describe('behavioral guidance trimming', () => {
		it('Low-capability model trims all 3 marker pairs', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(config);

			const systemText = `System prompt start
Some content
<!-- BEHAVIORAL_GUIDANCE_START -->
Rule 1: Always delegate to coder
<!-- BEHAVIORAL_GUIDANCE_END -->
Middle content
<!-- BEHAVIORAL_GUIDANCE_START -->
Rule 2: Never write code directly
<!-- BEHAVIORAL_GUIDANCE_END -->
More content
<!-- BEHAVIORAL_GUIDANCE_START -->
Rule 3: Use programmatic gates
<!-- BEHAVIORAL_GUIDANCE_END -->
End of prompt`;

			const messages = [
				makeSystemMessage(systemText),
				makeAssistantMessage('gpt-4o-mini'),
			];

			await hooks.messagesTransform({}, { messages });

			// All 3 markers should be replaced
			const resultText = (
				messages[0].parts[0] as { type: string; text: string }
			).text;
			expect(resultText).not.toContain('<!-- BEHAVIORAL_GUIDANCE_START -->');
			expect(resultText).not.toContain('<!-- BEHAVIORAL_GUIDANCE_END -->');

			// Count replacements - should have 3 replacements
			const replacementCount = (
				resultText.match(/\[Enforcement: programmatic gates active\]/g) || []
			).length;
			expect(replacementCount).toBe(3);

			// Original content outside markers should be preserved
			expect(resultText).toContain('System prompt start');
			expect(resultText).toContain('Some content');
			expect(resultText).toContain('Middle content');
			expect(resultText).toContain('More content');
			expect(resultText).toContain('End of prompt');
		});

		it('High-capability model does NOT trim', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(config);

			const systemText = `System prompt
<!-- BEHAVIORAL_GUIDANCE_START -->
Rule 1: Always delegate
<!-- BEHAVIORAL_GUIDANCE_END -->
End`;

			const messages = [
				makeSystemMessage(systemText),
				makeAssistantMessage('gpt-4o'),
			];

			await hooks.messagesTransform({}, { messages });

			// Markers should still be present
			const resultText = (
				messages[0].parts[0] as { type: string; text: string }
			).text;
			expect(resultText).toContain('<!-- BEHAVIORAL_GUIDANCE_START -->');
			expect(resultText).toContain('<!-- BEHAVIORAL_GUIDANCE_END -->');
			expect(resultText).toContain('Rule 1: Always delegate');
		});

		it('uses the incoming configured model on its first handoff turn', async () => {
			const hooks = createGuardrailsHooks(
				'.',
				undefined,
				defaultConfig(),
				undefined,
				undefined,
				(agentName) =>
					agentName === 'small_coder' ? 'provider/gpt-4o-mini' : undefined,
			);
			const systemText = `System prompt
<!-- BEHAVIORAL_GUIDANCE_START -->
Rule for a high-capability model
<!-- BEHAVIORAL_GUIDANCE_END -->
End`;
			const messages = [
				makeSystemMessage(systemText),
				makeAssistantMessage('gpt-4o'),
				makeUserMessage('take over', 'small_coder'),
			];

			await hooks.messagesTransform({}, { messages });

			const resultText = (
				messages[0].parts[0] as { type: string; text: string }
			).text;
			expect(resultText).not.toContain('Rule for a high-capability model');
			expect(resultText).toContain('[Enforcement: programmatic gates active]');
		});

		it('does not trim when the incoming configured model is high-capability', async () => {
			// Previous coverage only proved high capability via assistant metadata;
			// this direction catches accidental over-trimming of the target resolver.
			const hooks = createGuardrailsHooks(
				'.',
				undefined,
				defaultConfig(),
				undefined,
				undefined,
				(agentName) =>
					agentName === 'large_coder' ? 'provider/gpt-4o' : undefined,
			);
			const systemText = `System prompt
<!-- BEHAVIORAL_GUIDANCE_START -->
Rule for a high-capability model
<!-- BEHAVIORAL_GUIDANCE_END -->
End`;
			const messages = [
				makeSystemMessage(systemText),
				makeAssistantMessage('gpt-4o-mini'),
				makeUserMessage('take over', 'large_coder'),
			];
			const session = ensureAgentSession('test-session', 'architect');
			session.architectWriteCount = 1;

			await hooks.messagesTransform({}, { messages });

			const resultText = (
				messages[0].parts[0] as { type: string; text: string }
			).text;
			expect(resultText).toContain('Rule for a high-capability model');
			expect(resultText).toContain('<!-- BEHAVIORAL_GUIDANCE_START -->');
			expect(resultText).toContain('SELF-CODING DETECTED');
		});

		it('No modelID → no trim', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(config);

			const systemText = `System prompt
<!-- BEHAVIORAL_GUIDANCE_START -->
Rule 1: Always delegate
<!-- BEHAVIORAL_GUIDANCE_END -->
End`;

			// No assistant message - extractModelInfo returns {}
			const messages = [makeSystemMessage(systemText)];

			await hooks.messagesTransform({}, { messages });

			// Markers should still be present
			const resultText = (
				messages[0].parts[0] as { type: string; text: string }
			).text;
			expect(resultText).toContain('<!-- BEHAVIORAL_GUIDANCE_START -->');
			expect(resultText).toContain('<!-- BEHAVIORAL_GUIDANCE_END -->');
		});

		it('Non-system message NOT trimmed', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(config);

			// User message with markers - should NOT be modified even with low-cap model
			const userText = `User message
<!-- BEHAVIORAL_GUIDANCE_START -->
This should not be removed
<!-- BEHAVIORAL_GUIDANCE_END -->
End`;

			const messages = [
				makeUserMessage(userText),
				makeAssistantMessage('gpt-4o-mini'),
			];

			await hooks.messagesTransform({}, { messages });

			// User message should remain unchanged
			const resultText = (
				messages[0].parts[0] as { type: string; text: string }
			).text;
			expect(resultText).toContain('<!-- BEHAVIORAL_GUIDANCE_START -->');
			expect(resultText).toContain('This should not be removed');
		});

		it('Case-insensitive: GPT-4O-NANO trims', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(config);

			const systemText = `System prompt
<!-- BEHAVIORAL_GUIDANCE_START -->
Rule to remove
<!-- BEHAVIORAL_GUIDANCE_END -->
End`;

			const messages = [
				makeSystemMessage(systemText),
				makeAssistantMessage('GPT-4O-NANO'),
			];

			await hooks.messagesTransform({}, { messages });

			// Should be trimmed (case-insensitive match on 'nano')
			const resultText = (
				messages[0].parts[0] as { type: string; text: string }
			).text;
			expect(resultText).not.toContain('<!-- BEHAVIORAL_GUIDANCE_START -->');
			expect(resultText).toContain('[Enforcement: programmatic gates active]');
		});

		it('Multiple system messages - both trimmed', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(config);

			const systemText1 = `First system
<!-- BEHAVIORAL_GUIDANCE_START -->
Rule 1
<!-- BEHAVIORAL_GUIDANCE_END -->
End 1`;

			const systemText2 = `Second system
<!-- BEHAVIORAL_GUIDANCE_START -->
Rule 2
<!-- BEHAVIORAL_GUIDANCE_END -->
End 2`;

			const messages = [
				makeSystemMessage(systemText1),
				makeSystemMessage(systemText2),
				makeAssistantMessage('gpt-4o-mini'),
			];

			await hooks.messagesTransform({}, { messages });

			// Both system messages should be trimmed
			const resultText1 = (
				messages[0].parts[0] as { type: string; text: string }
			).text;
			const resultText2 = (
				messages[1].parts[0] as { type: string; text: string }
			).text;

			expect(resultText1).not.toContain('BEHAVIORAL_GUIDANCE_START');
			expect(resultText2).not.toContain('BEHAVIORAL_GUIDANCE_START');

			// Each should have one replacement
			expect(
				(resultText1.match(/\[Enforcement: programmatic gates active\]/g) || [])
					.length,
			).toBe(1);
			expect(
				(resultText2.match(/\[Enforcement: programmatic gates active\]/g) || [])
					.length,
			).toBe(1);
		});

		it('System message WITHOUT markers - not modified', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(config);

			const systemText = `System prompt without any behavioral guidance markers.
Just regular content here.
End of prompt.`;

			const messages = [
				makeSystemMessage(systemText),
				makeAssistantMessage('gpt-4o-mini'),
			];

			await hooks.messagesTransform({}, { messages });

			// Text should remain unchanged
			const resultText = (
				messages[0].parts[0] as { type: string; text: string }
			).text;
			expect(resultText).toBe(systemText);
		});

		// Additional edge cases
		it('nano model triggers trimming', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(config);

			const systemText = `System
<!-- BEHAVIORAL_GUIDANCE_START -->
Rule
<!-- BEHAVIORAL_GUIDANCE_END -->
End`;

			const messages = [
				makeSystemMessage(systemText),
				makeAssistantMessage('claude-3-nano'),
			];

			await hooks.messagesTransform({}, { messages });

			const resultText = (
				messages[0].parts[0] as { type: string; text: string }
			).text;
			expect(resultText).toContain('[Enforcement: programmatic gates active]');
		});

		it('small model triggers trimming', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(config);

			const systemText = `System
<!-- BEHAVIORAL_GUIDANCE_START -->
Rule
<!-- BEHAVIORAL_GUIDANCE_END -->
End`;

			const messages = [
				makeSystemMessage(systemText),
				makeAssistantMessage('gpt-35-turbo-small'),
			];

			await hooks.messagesTransform({}, { messages });

			const resultText = (
				messages[0].parts[0] as { type: string; text: string }
			).text;
			expect(resultText).toContain('[Enforcement: programmatic gates active]');
		});

		it('free model triggers trimming', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(config);

			const systemText = `System
<!-- BEHAVIORAL_GUIDANCE_START -->
Rule
<!-- BEHAVIORAL_GUIDANCE_END -->
End`;

			const messages = [
				makeSystemMessage(systemText),
				makeAssistantMessage('gpt-4o-free'),
			];

			await hooks.messagesTransform({}, { messages });

			const resultText = (
				messages[0].parts[0] as { type: string; text: string }
			).text;
			expect(resultText).toContain('[Enforcement: programmatic gates active]');
		});

		it('empty messages array - no error, early return', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(config);

			// Should not throw
			await expect(
				hooks.messagesTransform({}, { messages: [] }),
			).resolves.toBeUndefined();
		});

		it('messages without sessionID - no trim (early return)', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(config);

			const systemText = `System
<!-- BEHAVIORAL_GUIDANCE_START -->
Rule
<!-- BEHAVIORAL_GUIDANCE_END -->
End`;

			// System message without sessionID
			const messages = [
				{
					info: { role: 'system' as const },
					parts: [{ type: 'text' as const, text: systemText }],
				},
				{
					info: { role: 'assistant' as const, modelID: 'gpt-4o-mini' },
					parts: [{ type: 'text' as const, text: 'response' }],
				},
			];

			await hooks.messagesTransform({}, { messages });

			// Should not be trimmed (early return due to missing sessionID)
			const resultText = (
				messages[0].parts[0] as { type: string; text: string }
			).text;
			expect(resultText).toContain('<!-- BEHAVIORAL_GUIDANCE_START -->');
		});

		it('multi-line content within markers is removed', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(config);

			const systemText = `System
<!-- BEHAVIORAL_GUIDANCE_START -->
Rule 1: Delegate all coding tasks
Rule 2: Never write code directly
Rule 3: Use automated gates
This is multi-line content
That should be removed
<!-- BEHAVIORAL_GUIDANCE_END -->
End`;

			const messages = [
				makeSystemMessage(systemText),
				makeAssistantMessage('gpt-4o-mini'),
			];

			await hooks.messagesTransform({}, { messages });

			const resultText = (
				messages[0].parts[0] as { type: string; text: string }
			).text;
			expect(resultText).toContain('[Enforcement: programmatic gates active]');
			expect(resultText).not.toContain('Rule 1: Delegate');
			expect(resultText).not.toContain('multi-line content');
			// Content after markers should remain
			expect(resultText).toContain('End');
		});
	});
});
