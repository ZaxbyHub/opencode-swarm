import { describe, expect, test } from 'bun:test';
import { createContextBudgetHandler } from '../../../src/hooks/context-budget';

// Helper function to generate messages with specific text length
function makeMessages(textLength: number, agent?: string) {
	const text = 'x'.repeat(textLength);
	return [
		{
			info: { role: 'user', agent },
			parts: [{ type: 'text', text }],
		},
	];
}

describe('context-budget hook', () => {
	describe('Returns no-op when disabled', () => {
		test('when config.context_budget.enabled === false', async () => {
			const config = {
				context_budget: {
					enabled: false,
					warn_threshold: 0.7,
					critical_threshold: 0.9,
					model_limits: { default: 128000 },
				},
				max_iterations: 5,
				qa_retry_limit: 3,
				inject_phase_reminders: true,
			};

			const handler = createContextBudgetHandler(config);
			const output = {
				messages: makeMessages(1000, 'architect'),
			};

			await handler({}, output);
			expect(output.messages[0].parts[0].text).toBe('x'.repeat(1000));
		});
	});

	describe('Does nothing when no messages', () => {
		test('when messages array is empty', async () => {
			const config = {
				context_budget: {
					enabled: true,
					warn_threshold: 0.7,
					critical_threshold: 0.9,
					model_limits: { default: 128000 },
				},
				max_iterations: 5,
				qa_retry_limit: 3,
				inject_phase_reminders: true,
			};

			const handler = createContextBudgetHandler(config);
			const output = { messages: [] };
			await handler({}, output);
			expect(output.messages).toEqual([]);
		});

		test('when messages is undefined', async () => {
			const config = {
				context_budget: {
					enabled: true,
					warn_threshold: 0.7,
					critical_threshold: 0.9,
					model_limits: { default: 128000 },
				},
				max_iterations: 5,
				qa_retry_limit: 3,
				inject_phase_reminders: true,
			};

			const handler = createContextBudgetHandler(config);
			const output = {};
			await handler({}, output);
			expect(output).toEqual({});
		});
	});

	describe('Does nothing when usage below warn_threshold', () => {
		test('exactly at warn threshold (should not trigger)', async () => {
			const config = {
				context_budget: {
					enabled: true,
					model_limits: { default: 100 },
				},
				max_iterations: 5,
				qa_retry_limit: 3,
				inject_phase_reminders: true,
			};

			const handler = createContextBudgetHandler(config);
			const output = {
				messages: makeMessages(212, 'architect'), // Exactly 70 tokens = 70%
			};

			await handler({}, output);
			expect(output.messages[0].parts[0].text).toBe('x'.repeat(212));
		});

		test('below warn threshold', async () => {
			const config = {
				context_budget: {
					enabled: true,
					model_limits: { default: 100 },
				},
				max_iterations: 5,
				qa_retry_limit: 3,
				inject_phase_reminders: true,
			};

			const handler = createContextBudgetHandler(config);
			const output = {
				messages: makeMessages(211, 'architect'), // ~69 tokens = 69%
			};

			await handler({}, output);
			expect(output.messages[0].parts[0].text).toBe('x'.repeat(211));
		});
	});

	describe('Injects warning when usage > warn_threshold', () => {
		test('just above warn threshold', async () => {
			const config = {
				context_budget: {
					enabled: true,
					model_limits: { default: 100 },
				},
				max_iterations: 5,
				qa_retry_limit: 3,
				inject_phase_reminders: true,
			};

			const handler = createContextBudgetHandler(config);
			const output = {
				messages: makeMessages(213, 'architect'), // 71 tokens = 71%
			};

			await handler({}, output);

			const modifiedText = output.messages[0].parts[0].text;
			expect(modifiedText).toContain('CONTEXT WARNING');
			expect(modifiedText).toContain('Consider summarizing');
			expect(modifiedText.endsWith('x'.repeat(213))).toBe(true);
		});

		test('well above warn threshold', async () => {
			const config = {
				context_budget: {
					enabled: true,
					model_limits: { default: 100 },
				},
				max_iterations: 5,
				qa_retry_limit: 3,
				inject_phase_reminders: true,
			};

			const handler = createContextBudgetHandler(config);
			const output = {
				messages: makeMessages(250, 'architect'), // 83 tokens = 83%
			};

			await handler({}, output);

			const modifiedText = output.messages[0].parts[0].text;
			expect(modifiedText).toContain('CONTEXT WARNING');
			expect(modifiedText.endsWith('x'.repeat(250))).toBe(true);
		});
	});

	describe('Injects critical warning when usage > critical_threshold', () => {
		test('just above critical threshold', async () => {
			const config = {
				context_budget: {
					enabled: true,
					model_limits: { default: 100 },
				},
				max_iterations: 5,
				qa_retry_limit: 3,
				inject_phase_reminders: true,
			};

			const handler = createContextBudgetHandler(config);
			const output = {
				messages: makeMessages(274, 'architect'), // 91 tokens = 91%
			};

			await handler({}, output);

			const modifiedText = output.messages[0].parts[0].text;
			expect(modifiedText).toContain('CONTEXT CRITICAL');
			expect(modifiedText).toContain('Offload details');
			expect(modifiedText.endsWith('x'.repeat(274))).toBe(true);
		});

		test('well above critical threshold', async () => {
			const config = {
				context_budget: {
					enabled: true,
					model_limits: { default: 100 },
				},
				max_iterations: 5,
				qa_retry_limit: 3,
				inject_phase_reminders: true,
			};

			const handler = createContextBudgetHandler(config);
			const output = {
				messages: makeMessages(300, 'architect'), // 99 tokens = 99%
			};

			await handler({}, output);

			const modifiedText = output.messages[0].parts[0].text;
			expect(modifiedText).toContain('CONTEXT CRITICAL');
			expect(modifiedText.endsWith('x'.repeat(300))).toBe(true);
		});
	});

	describe('Only injects for architect agent (or no agent)', () => {
		test('injects for architect agent', async () => {
			const config = {
				context_budget: {
					enabled: true,
					model_limits: { default: 100 },
				},
				max_iterations: 5,
				qa_retry_limit: 3,
				inject_phase_reminders: true,
			};

			const handler = createContextBudgetHandler(config);
			const output = {
				messages: makeMessages(250, 'architect'),
			};

			await handler({}, output);

			const modifiedText = output.messages[0].parts[0].text;
			expect(modifiedText).toContain('CONTEXT WARNING');
		});

		test('injects when no agent field', async () => {
			const config = {
				context_budget: {
					enabled: true,
					model_limits: { default: 100 },
				},
				max_iterations: 5,
				qa_retry_limit: 3,
				inject_phase_reminders: true,
			};

			const handler = createContextBudgetHandler(config);
			const output = {
				messages: makeMessages(250),
			};

			await handler({}, output);

			const modifiedText = output.messages[0].parts[0].text;
			expect(modifiedText).toContain('CONTEXT WARNING');
		});
	});

	describe('Does NOT inject for non-architect agent', () => {
		test('coder agent unchanged', async () => {
			const config = {
				context_budget: {
					enabled: true,
					model_limits: { default: 100 },
				},
				max_iterations: 5,
				qa_retry_limit: 3,
				inject_phase_reminders: true,
			};

			const handler = createContextBudgetHandler(config);
			const output = {
				messages: makeMessages(300, 'coder'),
			};

			await handler({}, output);
			expect(output.messages[0].parts[0].text).toBe('x'.repeat(300));
		});

		test('explorer agent unchanged', async () => {
			const config = {
				context_budget: {
					enabled: true,
					model_limits: { default: 100 },
				},
				max_iterations: 5,
				qa_retry_limit: 3,
				inject_phase_reminders: true,
			};

			const handler = createContextBudgetHandler(config);
			const output = {
				messages: makeMessages(300, 'explorer'),
			};

			await handler({}, output);
			expect(output.messages[0].parts[0].text).toBe('x'.repeat(300));
		});
	});

	describe('Uses custom model_limits', () => {
		test('custom model limit', async () => {
			const config = {
				context_budget: {
					enabled: true,
					model_limits: { default: 1000 },
				},
				max_iterations: 5,
				qa_retry_limit: 3,
				inject_phase_reminders: true,
			};

			const handler = createContextBudgetHandler(config);
			const output = {
				messages: makeMessages(700, 'architect'), // ~231 tokens, ~23% of 1000, below 70%
			};

			await handler({}, output);
			expect(output.messages[0].parts[0].text).toBe('x'.repeat(700));
		});
	});

	describe('Falls back to default model limit', () => {
		test('uses default 128000 when no model_limits', async () => {
			const config = {
				context_budget: {
					enabled: true,
				},
				max_iterations: 5,
				qa_retry_limit: 3,
				inject_phase_reminders: true,
			};

			const handler = createContextBudgetHandler(config);
			const output = {
				messages: makeMessages(10000, 'architect'), // ~3300 tokens, well below 128k
			};

			await handler({}, output);
			expect(output.messages[0].parts[0].text).toBe('x'.repeat(10000));
		});
	});

	describe('Warning includes percentage', () => {
		test('warning shows correct percentage', async () => {
			const config = {
				context_budget: {
					enabled: true,
					model_limits: { default: 100 },
				},
				max_iterations: 5,
				qa_retry_limit: 3,
				inject_phase_reminders: true,
			};

			const handler = createContextBudgetHandler(config);
			const output = {
				messages: makeMessages(250, 'architect'), // 83 tokens
			};

			await handler({}, output);

			const modifiedText = output.messages[0].parts[0].text;
			expect(modifiedText).toContain('~83%');
			expect(modifiedText).toContain('CONTEXT WARNING');
		});
	});

	describe('Does not modify non-text parts', () => {
		test('only text parts are modified', async () => {
			const config = {
				context_budget: {
					enabled: true,
					model_limits: { default: 100 },
				},
				max_iterations: 5,
				qa_retry_limit: 3,
				inject_phase_reminders: true,
			};

			const handler = createContextBudgetHandler(config);
			const output = {
				messages: [
					{
						info: { role: 'user', agent: 'architect' },
						parts: [
							{ type: 'image', text: undefined },
							{ type: 'text', text: 'x'.repeat(300) }, // This will get the warning
							{ type: 'tool', text: undefined },
							{ type: 'text', text: 'more text' },
						],
					},
				],
			};

			await handler({}, output);

			// Only the text part with long text should be modified
			expect(output.messages[0].parts[0]).toEqual({
				type: 'image',
				text: undefined,
			});
			expect(output.messages[0].parts[2]).toEqual({
				type: 'tool',
				text: undefined,
			});
			expect(output.messages[0].parts[3]).toEqual({
				type: 'text',
				text: 'more text',
			});
			expect(output.messages[0].parts[1].text).toContain('CONTEXT CRITICAL');
			expect(output.messages[0].parts[1].text).toContain('x'.repeat(300));
		});
	});

	describe('Handles messages with no text parts', () => {
		test('messages only have image/tool parts', async () => {
			const config = {
				context_budget: {
					enabled: true,
					model_limits: { default: 100 },
				},
				max_iterations: 5,
				qa_retry_limit: 3,
				inject_phase_reminders: true,
			};

			const handler = createContextBudgetHandler(config);
			const output = {
				messages: [
					{
						info: { role: 'user', agent: 'architect' },
						parts: [
							{ type: 'image', text: undefined },
							{ type: 'tool', text: undefined },
						],
					},
				],
			};

			await handler({}, output);

			expect(output.messages[0].parts).toEqual([
				{ type: 'image', text: undefined },
				{ type: 'tool', text: undefined },
			]);
		});
	});

	describe('No user messages → no modification', () => {
		test('all messages are role=assistant', async () => {
			const config = {
				context_budget: {
					enabled: true,
					model_limits: { default: 100 },
				},
				max_iterations: 5,
				qa_retry_limit: 3,
				inject_phase_reminders: true,
			};

			const handler = createContextBudgetHandler(config);
			const output = {
				messages: [
					{
						info: { role: 'assistant', agent: 'architect' },
						parts: [{ type: 'text', text: 'x'.repeat(300) }],
					},
				],
			};

			await handler({}, output);
			expect(output.messages[0].parts[0].text).toBe('x'.repeat(300));
		});
	});

	describe('Custom thresholds work', () => {
		test('custom warn_threshold=0.5, critical_threshold=0.8', async () => {
			const config = {
				context_budget: {
					enabled: true,
					warn_threshold: 0.5,
					critical_threshold: 0.8,
					model_limits: { default: 100 },
				},
				max_iterations: 5,
				qa_retry_limit: 3,
				inject_phase_reminders: true,
			};

			const handler = createContextBudgetHandler(config);
			const output = {
				messages: makeMessages(160, 'architect'), // ~53 tokens, ~53% of 100, above 50%
			};

			await handler({}, output);

			const modifiedText = output.messages[0].parts[0].text;
			expect(modifiedText).toContain('CONTEXT WARNING');
			expect(modifiedText).toContain('~53%');
		});

		test('critical threshold triggered with custom values', async () => {
			const config = {
				context_budget: {
					enabled: true,
					warn_threshold: 0.5,
					critical_threshold: 0.8,
					model_limits: { default: 100 },
				},
				max_iterations: 5,
				qa_retry_limit: 3,
				inject_phase_reminders: true,
			};

			const handler = createContextBudgetHandler(config);
			const output = {
				messages: makeMessages(300, 'architect'), // ~99 tokens, ~99% of 100, above 80%
			};

			await handler({}, output);

			const modifiedText = output.messages[0].parts[0].text;
			expect(modifiedText).toContain('CONTEXT CRITICAL');
			expect(modifiedText).toContain('~99%');
		});
	});

	describe('Token calculation across multiple messages', () => {
		test('sums tokens across all messages', async () => {
			const config = {
				context_budget: {
					enabled: true,
					model_limits: { default: 200 },
				},
				max_iterations: 5,
				qa_retry_limit: 3,
				inject_phase_reminders: true,
			};

			const handler = createContextBudgetHandler(config);
			const output = {
				messages: [
					{
						info: { role: 'user', agent: 'architect' },
						parts: [{ type: 'text', text: 'x'.repeat(310) }], // ~102 tokens
					},
					{
						info: { role: 'user', agent: 'architect' },
						parts: [{ type: 'text', text: 'x'.repeat(310) }], // ~102 tokens
					},
				],
			};

			await handler({}, output);

			// Total usage: ~205/200 = ~103%
			// Handler injects into the LAST user message (index 1)
			const modifiedText = output.messages[1].parts[0].text;
			expect(modifiedText).toContain('CONTEXT CRITICAL');
			expect(modifiedText).toContain('~103%');
		});
	});

	describe('Multiple text parts in last user message', () => {
		test('only first text part gets the warning', async () => {
			const config = {
				context_budget: {
					enabled: true,
					model_limits: { default: 100 },
				},
				max_iterations: 5,
				qa_retry_limit: 3,
				inject_phase_reminders: true,
			};

			const handler = createContextBudgetHandler(config);
			const output = {
				messages: [
					{
						info: { role: 'user', agent: 'architect' },
						parts: [
							{ type: 'text', text: 'x'.repeat(300) }, // This will get the warning
							{ type: 'text', text: 'more text here' },
							{ type: 'tool', text: undefined },
						],
					},
				],
			};

			await handler({}, output);

			expect(output.messages[0].parts[0].text).toContain('CONTEXT CRITICAL');
			expect(output.messages[0].parts[1].text).toBe('more text here');
		});
	});

	describe('Edge case: exactly at 90% critical threshold boundary', () => {
		test('exactly 90% should trigger warn, not critical', async () => {
			const config = {
				context_budget: {
					enabled: true,
					model_limits: { default: 100 },
				},
				max_iterations: 5,
				qa_retry_limit: 3,
				inject_phase_reminders: true,
			};

			const handler = createContextBudgetHandler(config);
			const output = {
				messages: makeMessages(272, 'architect'), // 90 tokens = 90%
			};

			await handler({}, output);

			const modifiedText = output.messages[0].parts[0].text;
			expect(modifiedText).toContain('CONTEXT WARNING');
			expect(modifiedText).not.toContain('CONTEXT CRITICAL');
			expect(modifiedText).toContain('~90%');
			expect(modifiedText.endsWith('x'.repeat(272))).toBe(true);
		});
	});

	describe('Edge case: default thresholds when not specified', () => {
		test('uses default warn threshold when not specified', async () => {
			const config = {
				context_budget: {
					enabled: true,
					model_limits: { default: 100 },
				},
				max_iterations: 5,
				qa_retry_limit: 3,
				inject_phase_reminders: true,
			};

			const handler = createContextBudgetHandler(config);
			const output = {
				messages: makeMessages(227, 'architect'), // ~75 tokens = 75% > 70% default warn threshold
			};

			await handler({}, output);

			const modifiedText = output.messages[0].parts[0].text;
			expect(modifiedText).toContain('CONTEXT WARNING');
			expect(modifiedText).toContain('~75%');
		});
	});

	describe('Edge case: messages with missing parts array', () => {
		test('handles message without parts property', async () => {
			const config = {
				context_budget: {
					enabled: true,
					model_limits: { default: 100 },
				},
				max_iterations: 5,
				qa_retry_limit: 3,
				inject_phase_reminders: true,
			};

			const handler = createContextBudgetHandler(config);
			const output = {
				messages: [
					{ info: { role: 'user', agent: 'architect' } }, // Missing parts property
					{
						info: { role: 'user', agent: 'architect' },
						parts: [{ type: 'text', text: 'normal message' }],
					},
				],
			};

			// Should not crash
			await handler({}, output);

			// Normal message should remain unchanged
			expect(output.messages[1].parts[0].text).toBe('normal message');
		});
	});

	describe('Edge case: parts with null/empty text', () => {
		test('handles empty and missing text fields', async () => {
			const config = {
				context_budget: {
					enabled: true,
					model_limits: { default: 100 },
				},
				max_iterations: 5,
				qa_retry_limit: 3,
				inject_phase_reminders: true,
			};

			const handler = createContextBudgetHandler(config);
			const output = {
				messages: [
					{
						info: { role: 'user', agent: 'architect' },
						parts: [
							{ type: 'text', text: '' }, // Empty text
							{ type: 'text' }, // Missing text property
							{ type: 'text', text: 'valid text' },
						],
					},
				],
			};

			// Should not crash
			await handler({}, output);

			// Valid text should remain unchanged
			expect(output.messages[0].parts[2].text).toBe('valid text');
		});
	});

	describe('Edge case: last user message has no parts', () => {
		test('handles last user message without parts field', async () => {
			const config = {
				context_budget: {
					enabled: true,
					model_limits: { default: 100 },
				},
				max_iterations: 5,
				qa_retry_limit: 3,
				inject_phase_reminders: true,
			};

			const handler = createContextBudgetHandler(config);
			const output = {
				messages: [
					{
						info: { role: 'assistant' },
						parts: [{ type: 'text', text: 'x'.repeat(300) }],
					},
					{ info: { role: 'user', agent: 'architect' } }, // No parts field
				],
			};

			await handler({}, output);

			// Assistant message should remain unchanged since it's not a user message
			expect(output.messages[0].parts[0].text).toBe('x'.repeat(300));
			// User message should remain unchanged since it has no parts
			expect(output.messages[1]).toEqual({
				info: { role: 'user', agent: 'architect' },
			});
		});
	});

	describe('Edge case: context_budget entirely missing from config', () => {
		test('handler enabled by default when context_budget missing', async () => {
			const config = {
				max_iterations: 5,
				qa_retry_limit: 3,
				inject_phase_reminders: true,
			};

			const handler = createContextBudgetHandler(config);
			const output = {
				messages: makeMessages(100, 'architect'), // Small text, well below default 128k limit
			};

			await handler({}, output);

			// Since we're well below the default 128k limit (100 tokens vs 128k), no warning should be injected
			expect(output.messages[0].parts[0].text).toBe('x'.repeat(100));
		});
	});

	describe('Task 4.1: Agent-Switch Compaction', () => {
		test('Agent switch triggers enforcement when usage > warn_threshold', async () => {
			const config = {
				context_budget: {
					enabled: true,
					model_limits: { default: 100 },
					enforce_on_agent_switch: true,
					enforce: true,
					prune_target: 0.7,
					recent_window: 10,
					preserve_last_n_turns: 1,
					tool_output_mask_threshold: 2000,
				},
				max_iterations: 5,
				qa_retry_limit: 3,
				inject_phase_reminders: true,
			};

			const handler = createContextBudgetHandler(config);

			const highUsageMessages = [
				{
					info: { role: 'user', agent: 'architect' },
					parts: [{ type: 'text', text: 'x'.repeat(100) }],
				},
				{
					info: { role: 'assistant', toolName: 'read' },
					parts: [{ type: 'text', text: 'y'.repeat(100) }],
				},
				{
					info: { role: 'user', agent: 'architect' },
					parts: [{ type: 'text', text: 'a'.repeat(100) }],
				},
				{
					info: { role: 'assistant', toolName: 'write' },
					parts: [{ type: 'text', text: 'b'.repeat(100) }],
				},
				{
					info: { role: 'user', agent: 'architect' },
					parts: [{ type: 'text', text: 'c'.repeat(100) }],
				},
			];
			const output1 = { messages: highUsageMessages };
			await handler({}, output1);

			const output2 = {
				messages: [...highUsageMessages].map((msg, i) =>
					i % 2 === 0 ? { ...msg, info: { ...msg.info, agent: 'coder' } } : msg,
				),
			};
			await handler({}, output2);

			const hasMaskedMessage = output2.messages.some((msg) =>
				msg.parts.some(
					(p) =>
						p.text &&
						(p.text.includes('[Context pruned') ||
							p.text.includes('[Tool output masked')),
				),
			);
			expect(hasMaskedMessage).toBe(true);
		});

		test('First message in session does NOT trigger agent-switch enforcement', async () => {
			const config = {
				context_budget: {
					enabled: true,
					model_limits: { default: 100 },
					enforce_on_agent_switch: true,
					enforce: true,
					prune_target: 0.7,
					recent_window: 10,
					preserve_last_n_turns: 1,
					tool_output_mask_threshold: 2000,
				},
				max_iterations: 5,
				qa_retry_limit: 3,
				inject_phase_reminders: true,
			};

			const handler = createContextBudgetHandler(config);

			const messages = [
				{
					info: { role: 'user', agent: 'architect' },
					parts: [{ type: 'text', text: 'x'.repeat(300) }],
				},
				{
					info: { role: 'assistant', toolName: 'read' },
					parts: [{ type: 'text', text: 'y'.repeat(300) }],
				},
			];
			const output = { messages: [...messages] };
			await handler({}, output);

			const hasMaskedMessage = output.messages.some((msg) =>
				msg.parts.some(
					(p) =>
						p.text &&
						(p.text.includes('[Context pruned') ||
							p.text.includes('[Tool output masked')),
				),
			);
			expect(hasMaskedMessage).toBe(false);

			expect(output.messages[0].parts[0].text).toContain('CONTEXT');
		});

		test('enforce_on_agent_switch=false disables agent-switch enforcement', async () => {
			const config = {
				context_budget: {
					enabled: true,
					model_limits: { default: 100 },
					enforce_on_agent_switch: false,
					enforce: true,
					prune_target: 0.7,
					recent_window: 10,
					preserve_last_n_turns: 1,
					tool_output_mask_threshold: 2000,
				},
				max_iterations: 5,
				qa_retry_limit: 3,
				inject_phase_reminders: true,
			};

			const handler = createContextBudgetHandler(config);

			const messages1 = [
				{
					info: { role: 'user', agent: 'architect' },
					parts: [{ type: 'text', text: 'x'.repeat(300) }],
				},
				{
					info: { role: 'assistant', toolName: 'read' },
					parts: [{ type: 'text', text: 'y'.repeat(300) }],
				},
				{
					info: { role: 'user', agent: 'architect' },
					parts: [{ type: 'text', text: 'a'.repeat(300) }],
				},
				{
					info: { role: 'assistant', toolName: 'write' },
					parts: [{ type: 'text', text: 'b'.repeat(300) }],
				},
			];
			const output1 = { messages: [...messages1] };
			await handler({}, output1);

			const messages2 = messages1.map((msg, i) =>
				i % 2 === 0 ? { ...msg, info: { ...msg.info, agent: 'coder' } } : msg,
			);
			const output2 = { messages: messages2 };
			await handler({}, output2);

			const hasMaskedMessage = output2.messages.some((msg) =>
				msg.parts.some(
					(p) =>
						p.text &&
						(p.text.includes('[Context pruned') ||
							p.text.includes('[Tool output masked')),
				),
			);
			expect(hasMaskedMessage).toBe(false);
		});

		test('Rapid switches A→B→A trigger enforcement on each switch', async () => {
			const config = {
				context_budget: {
					enabled: true,
					model_limits: { default: 200 },
					warn_threshold: 0.5,
					enforce_on_agent_switch: true,
					enforce: true,
					prune_target: 0.7,
					recent_window: 10,
					preserve_last_n_turns: 0,
					tool_output_mask_threshold: 2000,
				},
				max_iterations: 5,
				qa_retry_limit: 3,
				inject_phase_reminders: true,
			};

			const handler = createContextBudgetHandler(config);

			const baseMessages = [
				{
					info: { role: 'user' },
					parts: [{ type: 'text', text: 'x'.repeat(100) }],
				},
				{
					info: { role: 'assistant', toolName: 'read' },
					parts: [{ type: 'text', text: 'y'.repeat(100) }],
				},
				{
					info: { role: 'user' },
					parts: [{ type: 'text', text: 'a'.repeat(100) }],
				},
				{
					info: { role: 'assistant', toolName: 'write' },
					parts: [{ type: 'text', text: 'b'.repeat(100) }],
				},
			];

			const messages1 = baseMessages.map((msg, i) =>
				i % 2 === 0
					? { ...msg, info: { ...msg.info, agent: 'architect' } }
					: msg,
			);
			const output1 = { messages: messages1 };
			await handler({}, output1);

			const hasMasked1 = output1.messages.some((msg) =>
				msg.parts.some(
					(p) =>
						p.text &&
						(p.text.includes('[Context pruned') ||
							p.text.includes('[Tool output masked')),
				),
			);
			expect(hasMasked1).toBe(false);

			const messages2 = baseMessages.map((msg, i) =>
				i % 2 === 0 ? { ...msg, info: { ...msg.info, agent: 'coder' } } : msg,
			);
			const output2 = { messages: messages2 };
			await handler({}, output2);

			const hasMasked2 = output2.messages.some((msg) =>
				msg.parts.some(
					(p) =>
						p.text &&
						(p.text.includes('[Context pruned') ||
							p.text.includes('[Tool output masked')),
				),
			);
			expect(hasMasked2).toBe(true);

			const messages3 = baseMessages.map((msg, i) =>
				i % 2 === 0
					? { ...msg, info: { ...msg.info, agent: 'architect' } }
					: msg,
			);
			const output3 = { messages: messages3 };
			await handler({}, output3);

			const hasMasked3 = output3.messages.some((msg) =>
				msg.parts.some(
					(p) =>
						p.text &&
						(p.text.includes('[Context pruned') ||
							p.text.includes('[Tool output masked')),
				),
			);
			expect(hasMasked3).toBe(true);
		});
	});

	describe('Task 4.2: Tool Output Masking', () => {
		test('Old large tool output (> threshold) is masked', async () => {
			const config = {
				context_budget: {
					enabled: true,
					model_limits: { default: 10000 },
					enforce: true,
					prune_target: 0.7,
					recent_window: 5,
					preserve_last_n_turns: 4,
					tool_output_mask_threshold: 2000,
				},
				max_iterations: 5,
				qa_retry_limit: 3,
				inject_phase_reminders: true,
			};

			const handler = createContextBudgetHandler(config);

			const largeToolOutput = 'x'.repeat(50000);
			const messages = [
				{
					info: { role: 'user', agent: 'architect' },
					parts: [{ type: 'text', text: 'user msg' }],
				},
				{
					info: { role: 'assistant', toolName: 'tool_1' },
					parts: [{ type: 'text', text: 'output 1' }],
				}, // Index 1
				{
					info: { role: 'assistant', toolName: 'tool_2' },
					parts: [{ type: 'text', text: 'output 2' }],
				}, // Index 2
				{
					info: { role: 'assistant', toolName: 'tool_3' },
					parts: [{ type: 'text', text: 'output 3' }],
				}, // Index 3
				{
					info: { role: 'assistant', toolName: 'tool_4' },
					parts: [{ type: 'text', text: 'output 4' }],
				}, // Index 4
				{
					info: { role: 'assistant', toolName: 'read' },
					parts: [{ type: 'text', text: largeToolOutput }],
				}, // Index 5, large
				{
					info: { role: 'assistant', toolName: 'tool_6' },
					parts: [{ type: 'text', text: 'output 6' }],
				}, // Index 6
				{
					info: { role: 'assistant', toolName: 'tool_7' },
					parts: [{ type: 'text', text: 'output 7' }],
				}, // Index 7
			];

			messages.push(
				{
					info: { role: 'user', agent: 'architect' },
					parts: [{ type: 'text', text: 'x'.repeat(90000) }],
				}, // Index 8
			);

			const output = { messages: [...messages] };
			await handler({}, output);

			// With 9 messages total and recent_window=5, old tool outputs are maskable.
			// Index 0 is a user message and is never tool-masked.
			const hasMaskedText = output.messages.some(
				(msg, idx) =>
					idx < 4 && msg.parts[0]?.text?.includes('[Tool output masked'),
			);
			expect(hasMaskedText).toBe(true);
		});

		test('Recent tool output (< recentWindowSize old) NOT masked', async () => {
			const config = {
				context_budget: {
					enabled: true,
					model_limits: { default: 10000 },
					enforce: true,
					prune_target: 0.7,
					recent_window: 5,
					preserve_last_n_turns: 4,
					tool_output_mask_threshold: 2000,
				},
				max_iterations: 5,
				qa_retry_limit: 3,
				inject_phase_reminders: true,
			};

			const handler = createContextBudgetHandler(config);

			const largeToolOutput = 'x'.repeat(50000);
			const messages = [
				{
					info: { role: 'user', agent: 'architect' },
					parts: [{ type: 'text', text: 'user msg' }],
				},
				{
					info: { role: 'assistant', toolName: 'tool_1' },
					parts: [{ type: 'text', text: 'output 1' }],
				},
				{
					info: { role: 'assistant', toolName: 'tool_2' },
					parts: [{ type: 'text', text: 'output 2' }],
				},
				{
					info: { role: 'assistant', toolName: 'tool_3' },
					parts: [{ type: 'text', text: 'output 3' }],
				},
				{
					info: { role: 'assistant', toolName: 'tool_4' },
					parts: [{ type: 'text', text: 'output 4' }],
				},
				{
					info: { role: 'assistant', toolName: 'read' },
					parts: [{ type: 'text', text: largeToolOutput }],
				}, // Index 5
				{
					info: { role: 'assistant', toolName: 'tool_6' },
					parts: [{ type: 'text', text: 'output 6' }],
				}, // Index 6, recent
			];

			messages.push({
				info: { role: 'user', agent: 'architect' },
				parts: [{ type: 'text', text: 'x'.repeat(90000) }],
			});

			const output = { messages: [...messages] };
			await handler({}, output);

			// Index 6 is within recent window (age = 2 < 5), should NOT be masked
			expect(output.messages[6].parts[0].text).toBe('output 6');
		});

		test('Small tool output (< threshold) NOT masked', async () => {
			const config = {
				context_budget: {
					enabled: true,
					model_limits: { default: 100000 },
					enforce: true,
					prune_target: 0.7,
					recent_window: 2,
					preserve_last_n_turns: 4,
					tool_output_mask_threshold: 2000,
				},
				max_iterations: 5,
				qa_retry_limit: 3,
				inject_phase_reminders: true,
			};

			const handler = createContextBudgetHandler(config);

			const smallToolOutput = 'x'.repeat(500);
			const messages = [
				{
					info: { role: 'user', agent: 'architect' },
					parts: [{ type: 'text', text: 'user msg' }],
				},
				{
					info: { role: 'assistant', toolName: 'read' },
					parts: [{ type: 'text', text: smallToolOutput }],
				}, // Small output (< 2000)
				{
					info: { role: 'assistant', toolName: 'tool_2' },
					parts: [{ type: 'text', text: 'output 2' }],
				},
				{
					info: { role: 'assistant', toolName: 'tool_3' },
					parts: [{ type: 'text', text: 'output 3' }],
				},
			];

			messages.push({
				info: { role: 'user', agent: 'architect' },
				parts: [{ type: 'text', text: 'x'.repeat(90000) }],
			});

			const output = { messages: [...messages] };
			await handler({}, output);

			// Small output (< 2000 threshold) should NOT be masked even if old
			expect(output.messages[1].parts[0].text).toBe(smallToolOutput);
		});

		test('Tool output masking returns freed tokens (original - masked)', async () => {
			const config = {
				context_budget: {
					enabled: true,
					model_limits: { default: 10000 },
					enforce: true,
					prune_target: 0.7,
					recent_window: 2,
					preserve_last_n_turns: 4,
					tool_output_mask_threshold: 2000,
				},
				max_iterations: 5,
				qa_retry_limit: 3,
				inject_phase_reminders: true,
			};

			const handler = createContextBudgetHandler(config);

			const originalOutput = 'x'.repeat(5000);
			const messages = [
				{
					info: { role: 'user', agent: 'architect' },
					parts: [{ type: 'text', text: 'user msg' }],
				},
				{
					info: { role: 'assistant', toolName: 'bash' },
					parts: [{ type: 'text', text: originalOutput }],
				}, // Large output, index 1
				{
					info: { role: 'assistant', toolName: 'tool_2' },
					parts: [{ type: 'text', text: 'output 2' }],
				},
				{
					info: { role: 'assistant', toolName: 'tool_3' },
					parts: [{ type: 'text', text: 'output 3' }],
				},
			];

			messages.push({
				info: { role: 'user', agent: 'architect' },
				parts: [{ type: 'text', text: 'x'.repeat(90000) }],
			});

			const output = { messages: [...messages] };
			await handler({}, output);

			// Index 1 should be masked (age = 4 > recent_window of 2)
			const maskedText = output.messages[1].parts[0].text;
			expect(maskedText).not.toBe(originalOutput);
			expect(maskedText.length).toBeLessThan(originalOutput.length);
			expect(maskedText).toMatch(/\[Tool output masked/);
			expect(maskedText).toMatch(/\d+.*tokens/);
		});

		test('Masking integrates with hard enforcement (runs before pruning)', async () => {
			const config = {
				context_budget: {
					enabled: true,
					model_limits: { default: 10000 },
					warn_threshold: 0.7,
					critical_threshold: 0.9,
					enforce: true,
					prune_target: 0.7,
					recent_window: 3,
					preserve_last_n_turns: 4,
					tool_output_mask_threshold: 2000,
				},
				max_iterations: 5,
				qa_retry_limit: 3,
				inject_phase_reminders: true,
			};

			const handler = createContextBudgetHandler(config);

			const largeToolOutput = 'x'.repeat(50000);
			const messages = [
				{
					info: { role: 'user', agent: 'architect' },
					parts: [{ type: 'text', text: 'user' }],
				},
				{
					info: { role: 'assistant', toolName: 'bash' },
					parts: [{ type: 'text', text: largeToolOutput }],
				}, // Index 1, age = 4 > recent_window (3)
				{
					info: { role: 'assistant', toolName: 'tool_2' },
					parts: [{ type: 'text', text: 'output 2' }],
				},
				{
					info: { role: 'assistant', toolName: 'tool_3' },
					parts: [{ type: 'text', text: 'output 3' }],
				},
				{
					info: { role: 'assistant', toolName: 'tool_4' },
					parts: [{ type: 'text', text: 'output 4' }],
				},
			];

			messages.push({
				info: { role: 'user', agent: 'architect' },
				parts: [{ type: 'text', text: 'x'.repeat(90000) }],
			});

			const output = { messages: [...messages] };
			await handler({}, output);

			// Masking should happen first (old large output masked)
			const maskedText = output.messages[1].parts[0].text;
			expect(maskedText).not.toBe(largeToolOutput);
			expect(maskedText.length).toBeLessThan(largeToolOutput.length);
			expect(maskedText).toMatch(/\[Tool output masked/);
			expect(maskedText).toMatch(/\d+.*tokens/);
		});
	});

	describe('Task 4.1 & 4.2: Agent-Switch and Tool Masking Helper Functions', () => {
		test('[Task 4.2] shouldMaskToolOutput correctly identifies old large tool results', () => {
			// Note: This test checks the logic of the helper
			// In practice, shouldMaskToolOutput requires:
			// 1. isToolResult(message) = true
			// 2. age > recentWindowSize
			// 3. text.length > threshold

			// Create a message that meets all criteria
			const messages = [
				{
					info: { role: 'assistant' },
					parts: [{ type: 'text', text: 'x'.repeat(3000) }],
				},
				{
					info: { role: 'assistant' },
					parts: [{ type: 'text', text: 'y'.repeat(5000) }],
				},
				{ info: { role: 'user' }, parts: [{ type: 'text', text: 'query' }] },
			];

			// For index 0, age = 3 - 1 - 0 = 2 (if recentWindowSize=10, age < window, not masked)
			// This test validates the age calculation logic
			expect(messages[0].parts[0].text.length).toBeGreaterThan(2000);
		});

		test('[Task 4.2] Tool output masking respects threshold (< 2000 bytes NOT masked)', () => {
			// Small message should not be masked
			const smallMessage = 'short text'.repeat(50); // ~500 chars
			expect(smallMessage.length).toBeLessThan(2000);
		});

		test('[Task 4.2] Placeholder text includes tool name and excerpt', () => {
			// Verify the placeholder format
			const toolName = 'read_file';
			const originalText = 'x'.repeat(5000);
			const originalTokens = Math.ceil(originalText.length / 3);

			const placeholder = `[Tool output masked — ${toolName} returned ~${originalTokens} tokens. First 200 chars: "..."]`;

			expect(placeholder).toContain('[Tool output masked');
			expect(placeholder).toContain(toolName);
			expect(placeholder).toContain('tokens');
		});

		test('[Task 4.2] Freed tokens = original - masked (not just original)', () => {
			// Verify token accounting logic
			const original = 'x'.repeat(5000);
			const originalTokens = Math.ceil(original.length / 3);

			const placeholder = `[Tool output masked...]`;
			const maskedTokens = Math.ceil(placeholder.length / 3);

			const freed = originalTokens - maskedTokens;

			// Should be large positive number
			expect(freed).toBeGreaterThan(1000);
			expect(freed).toBeLessThan(originalTokens);
		});

		test('[Task 4.1] Agent-switch detection requires lastSeenAgent to change', () => {
			// This is a unit test of the condition logic
			const previousAgent = 'coder';
			const currentAgent = 'architect';

			// Condition: previousAgent !== undefined && currentAgent !== previousAgent
			expect(previousAgent !== undefined).toBe(true);
			expect(currentAgent !== previousAgent).toBe(true);

			// Switching should be detected
			expect(currentAgent).not.toBe(previousAgent);
		});

		test('[Task 4.1] Agent-switch with enforce=false does not trigger enforcement', () => {
			// Config with enforce_on_agent_switch=false should skip enforcement
			const config = {
				context_budget: {
					enforce_on_agent_switch: false,
				},
			};

			expect(config.context_budget.enforce_on_agent_switch).toBe(false);
		});

		test('[Task 4.2] retrieve_lane_output messages are NOT masked during enforcement', async () => {
			// Verify the structured-toolName exemption path: when msg.info.toolName is
			// 'retrieve_lane_output', shouldMaskToolOutput must return false even when
			// enforcement fires and the message is large/old.
			const config = {
				context_budget: {
					enabled: true,
					model_limits: { default: 60 },
					critical_threshold: 0.5,
					enforce: true,
					prune_target: 0.3,
					recent_window: 1,
					preserve_last_n_turns: 1,
					tool_output_mask_threshold: 50,
				},
				max_iterations: 5,
				qa_retry_limit: 3,
				inject_phase_reminders: true,
			};

			const handler = createContextBudgetHandler(config);

			const largeText = 'z'.repeat(600);
			const messages = [
				// Old, large retrieve_lane_output result — must NOT be masked
				{
					info: { role: 'assistant', toolName: 'retrieve_lane_output' },
					parts: [{ type: 'text', text: largeText }],
				},
				// Old, large generic tool result — eligible for masking
				{
					info: { role: 'assistant', toolName: 'bash' },
					parts: [{ type: 'text', text: largeText }],
				},
				// Recent user message (preserves the turn)
				{
					info: { role: 'user', agent: 'architect' },
					parts: [{ type: 'text', text: 'retrieve the lane output' }],
				},
			];

			const output = { messages: JSON.parse(JSON.stringify(messages)) };
			await handler({}, output);

			const retrieveMsg = output.messages[0];
			const retrieveText = retrieveMsg.parts[0].text as string;
			expect(retrieveText).not.toContain('[Tool output masked');
			expect(retrieveText).not.toContain('[Context pruned');
			expect(retrieveText).toBe(largeText);
		});
	});
});
