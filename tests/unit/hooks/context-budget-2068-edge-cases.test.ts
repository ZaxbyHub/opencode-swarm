/**
 * Issue #2068 regression tests — edge cases: error/pending states, multi-part
 * messages, preserve-window protection, sibling text + tool, mixed exempt +
 * non-exempt, and pruning-honors-exempt.
 *
 * Split from the core T1-T7 block (context-budget-2068-toolpart.test.ts) for
 * the FR-006 500-line cap.
 */
import { describe, expect, test } from 'bun:test';
import { createContextBudgetHandler } from '../../../src/hooks/context-budget';

/** Build a real OpenCode SDK completed-tool assistant message. */
function toolMsg(tool: string, output: string) {
	return {
		info: { role: 'assistant' },
		parts: [
			{
				type: 'tool',
				tool,
				state: {
					status: 'completed',
					input: {},
					output,
					title: tool,
					metadata: {},
					time: { start: 0, end: 1 },
				},
			},
		],
	};
}

function baseConfig(overrides: Record<string, unknown> = {}) {
	return {
		context_budget: {
			enabled: true,
			enforce: true,
			prune_target: 0.7,
			recent_window: 2,
			preserve_last_n_turns: 1,
			tool_output_mask_threshold: 2000,
			...overrides,
		},
		max_iterations: 5,
		qa_retry_limit: 3,
		inject_phase_reminders: true,
	};
}

describe('Issue #2068: edge cases', () => {
	// T8: error-state tool NOT masked (signal preserved).
	test('T8: error-state tool output NOT masked', async () => {
		const config = baseConfig({
			model_limits: { default: 10000 },
			recent_window: 0,
		});
		const handler = createContextBudgetHandler(config);

		const errMsg = 'Error: failed to connect (stack trace ...)'.repeat(200);
		const messages = [
			{
				info: { role: 'assistant' },
				parts: [
					{
						type: 'tool',
						tool: 'bash',
						state: {
							status: 'error',
							input: {},
							error: errMsg,
							metadata: {},
							time: { start: 0, end: 1 },
						},
					},
				],
			},
			{
				info: { role: 'user', agent: 'architect' },
				parts: [{ type: 'text', text: 'x'.repeat(90000) }],
			},
		];
		const output = { messages: JSON.parse(JSON.stringify(messages)) };
		await handler({}, output);

		// Error output preserved (not masked).
		expect(output.messages[0].parts[0].type).toBe('tool');
		expect(output.messages[0].parts[0].state.error).toBe(errMsg);
	});

	// T9: multiple tool parts in one message — all counted/masked independently.
	test('T9: multiple tool parts masked independently', async () => {
		const config = baseConfig({
			model_limits: { default: 10000 },
			recent_window: 0,
			preserve_last_n_turns: 0,
		});
		const handler = createContextBudgetHandler(config);

		const big1 = 'A'.repeat(40000);
		const big2 = 'B'.repeat(40000);
		const messages = [
			{
				info: { role: 'assistant' },
				parts: [
					{
						type: 'tool',
						tool: 'bash',
						state: {
							status: 'completed',
							input: {},
							output: big1,
							title: 'bash',
							metadata: {},
							time: { start: 0, end: 1 },
						},
					},
					{
						type: 'tool',
						tool: 'write',
						state: {
							status: 'completed',
							input: {},
							output: big2,
							title: 'write',
							metadata: {},
							time: { start: 0, end: 1 },
						},
					},
				],
			},
			{
				info: { role: 'user', agent: 'architect' },
				parts: [{ type: 'text', text: 'x'.repeat(90000) }],
			},
			{
				info: { role: 'assistant' },
				parts: [{ type: 'text', text: 'recent reply' }],
			},
		];
		const output = { messages: JSON.parse(JSON.stringify(messages)) };
		await handler({}, output);

		// Both tool parts replaced with text placeholders.
		const parts = output.messages[0].parts;
		expect(parts.every((p) => p.type === 'text')).toBe(true);
		expect(
			parts.every((p) => (p.text as string).includes('[Tool output masked')),
		).toBe(true);
	});

	// T10: tool-bearing message within preserve_last_n_turns NOT pruned or masked.
	test('T10: recent tool message within preserve window retained intact', async () => {
		const config = baseConfig({
			model_limits: { default: 10000 },
			recent_window: 0,
			preserve_last_n_turns: 2,
		});
		const handler = createContextBudgetHandler(config);

		const big = 'x'.repeat(50000);
		const messages = [
			{
				info: { role: 'user', agent: 'architect' },
				parts: [{ type: 'text', text: 'first' }],
			},
			toolMsg('bash', big), // recent tool result, within preserve window
			{
				info: { role: 'user', agent: 'architect' },
				parts: [{ type: 'text', text: 'x'.repeat(90000) }],
			},
		];
		const output = { messages: JSON.parse(JSON.stringify(messages)) };
		await handler({}, output);

		// The tool message is within preserve_last_n_turns=2 → its completed
		// ToolPart must be retained intact (not masked, not pruned).
		const toolPart = output.messages[1].parts[0];
		expect(toolPart.type).toBe('tool');
		expect(toolPart.state.output).toBe(big);
	});

	// T11: message with sibling text part + tool part — masking replaces only the
	// tool part; the sibling text part survives; BOTH are counted (no dedupe).
	test('T11: text part + tool part — masking replaces only the tool part; both counted', async () => {
		const config = baseConfig({
			model_limits: { default: 8000 },
			critical_threshold: 0.5,
			prune_target: 0.2,
			recent_window: 0,
			preserve_last_n_turns: 0,
			tool_output_mask_threshold: 100,
		});
		const handler = createContextBudgetHandler(config);

		const big = 'x'.repeat(20000);
		const commentary = 'assistant commentary';
		const messages = [
			{
				info: { role: 'assistant' },
				parts: [
					{ type: 'text', text: commentary },
					{
						type: 'tool',
						tool: 'bash',
						state: {
							status: 'completed',
							input: {},
							output: big,
							title: 'bash',
							metadata: {},
							time: { start: 0, end: 1 },
						},
					},
				],
			},
			{
				info: { role: 'user', agent: 'architect' },
				parts: [{ type: 'text', text: 'go' }],
			},
			{
				info: { role: 'assistant' },
				parts: [{ type: 'text', text: 'recent reply' }],
			},
		];
		const output = { messages: JSON.parse(JSON.stringify(messages)) };
		await handler({}, output);

		// The sibling text part is retained; the tool part is masked (replaced).
		const parts = output.messages[0].parts;
		const textPart = parts.find(
			(p) => p.type === 'text' && p.text === commentary,
		);
		const maskedPart = parts.find(
			(p) =>
				p.type === 'text' && (p.text as string).includes('[Tool output masked'),
		);
		expect(textPart).toBeDefined();
		expect(maskedPart).toBeDefined();

		// Both parts were counted toward the budget: critical enforcement fired
		// (usage of commentary + big tool output exceeded critical_threshold).
		const userText = output.messages[1].parts[0].text as string;
		expect(userText).toContain('CONTEXT CRITICAL');
	});

	// T12: mixed message — exempt + non-exempt tool parts; only non-exempt masked.
	test('T12: mixed message masks only non-exempt tool parts', async () => {
		const config = baseConfig({
			model_limits: { default: 12000 },
			critical_threshold: 0.5,
			prune_target: 0.9,
			recent_window: 0,
			preserve_last_n_turns: 0,
			tool_output_mask_threshold: 100,
		});
		const handler = createContextBudgetHandler(config);

		const exemptOutput = 'E'.repeat(12000);
		const maskedOutput = 'M'.repeat(12000);
		const messages = [
			{
				info: { role: 'assistant' },
				parts: [
					{
						type: 'tool',
						tool: 'retrieve_summary',
						state: {
							status: 'completed',
							input: {},
							output: exemptOutput,
							title: 'retrieve_summary',
							metadata: {},
							time: { start: 0, end: 1 },
						},
					},
					{
						type: 'tool',
						tool: 'bash',
						state: {
							status: 'completed',
							input: {},
							output: maskedOutput,
							title: 'bash',
							metadata: {},
							time: { start: 0, end: 1 },
						},
					},
				],
			},
			{
				info: { role: 'user', agent: 'architect' },
				parts: [{ type: 'text', text: 'go' }],
			},
			{
				info: { role: 'assistant' },
				parts: [{ type: 'text', text: 'recent reply' }],
			},
		];
		const output = { messages: JSON.parse(JSON.stringify(messages)) };
		await handler({}, output);

		const parts = output.messages[0].parts;
		const exemptPart = parts.find(
			(p) => p.type === 'tool' && p.tool === 'retrieve_summary',
		);
		expect(exemptPart).toBeDefined();
		expect(exemptPart.state.output).toBe(exemptOutput);
		const maskedPart = parts.find(
			(p) =>
				p.type === 'text' && (p.text as string).includes('[Tool output masked'),
		);
		expect(maskedPart).toBeDefined();
	});

	// T13: pruning honors per-part exemptions — an exempt tool output survives
	// even when the message is pruned (applyObservationMasking skips exempt parts).
	test('T13: pruning preserves exempt tool output even when message is pruned', async () => {
		const config = baseConfig({
			model_limits: { default: 4000 },
			critical_threshold: 0.5,
			prune_target: 0.2,
			recent_window: 0,
			preserve_last_n_turns: 0,
			tool_output_mask_threshold: 100,
		});
		const handler = createContextBudgetHandler(config);

		const exemptOutput = 'E'.repeat(3000);
		const messages = [
			toolMsg('retrieve_summary', exemptOutput),
			{
				info: { role: 'user', agent: 'architect' },
				parts: [{ type: 'text', text: 'x'.repeat(30000) }],
			},
			{
				info: { role: 'assistant' },
				parts: [{ type: 'text', text: 'reply' }],
			},
		];
		const output = { messages: JSON.parse(JSON.stringify(messages)) };
		await handler({}, output);

		const toolPart = output.messages[0].parts[0];
		expect(toolPart.type).toBe('tool');
		expect(toolPart.state.output).toBe(exemptOutput);
	});

	// T14 (F6): a message whose ONLY content is a pending tool part is neither
	// counted nor masked (pending tools have no output).
	test('T14: message with only a pending tool part is not masked', async () => {
		const config = baseConfig({
			model_limits: { default: 100000 },
			recent_window: 0,
			preserve_last_n_turns: 0,
		});
		const handler = createContextBudgetHandler(config);

		const messages = [
			{
				info: { role: 'assistant' },
				parts: [
					{
						type: 'tool',
						tool: 'bash',
						state: { status: 'pending', input: {}, raw: 'cmd' },
					},
				],
			},
			{
				info: { role: 'user', agent: 'architect' },
				parts: [{ type: 'text', text: 'x'.repeat(80000) }],
			},
			{
				info: { role: 'assistant' },
				parts: [{ type: 'text', text: 'recent reply' }],
			},
		];
		const output = { messages: JSON.parse(JSON.stringify(messages)) };
		await handler({}, output);

		expect(output.messages[0].parts[0].type).toBe('tool');
		expect(output.messages[0].parts[0].state.status).toBe('pending');
	});

	// T15 (F6): a very short tool output that is still above the mask threshold
	// gets masked (replaced by a placeholder that is longer than the original).
	// This confirms masking runs on tiny outputs; the freed-token accounting is
	// clamped to ≥ 0 in production (Math.max(0, …) in maskToolOutput /
	// applyObservationMasking) so a longer placeholder never shows as negative
	// freed tokens, but that clamp is not directly observable through the
	// public handler output and is therefore not asserted here.
	test('T15: very short tool output above threshold is still masked', async () => {
		const config = baseConfig({
			model_limits: { default: 10000 },
			critical_threshold: 0.5,
			recent_window: 0,
			preserve_last_n_turns: 0,
			tool_output_mask_threshold: 1,
		});
		const handler = createContextBudgetHandler(config);

		const tiny = 'ok';
		const messages = [
			toolMsg('bash', tiny),
			{
				info: { role: 'user', agent: 'architect' },
				parts: [{ type: 'text', text: 'x'.repeat(90000) }],
			},
			{
				info: { role: 'assistant' },
				parts: [{ type: 'text', text: 'recent reply' }],
			},
		];
		const output = { messages: JSON.parse(JSON.stringify(messages)) };
		await handler({}, output);

		const masked = output.messages[0].parts.some(
			(p) =>
				p.type === 'text' && (p.text as string).includes('[Tool output masked'),
		);
		expect(masked).toBe(true);
	});
});
