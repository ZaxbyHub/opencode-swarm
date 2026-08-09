/**
 * Issue #2068 regression tests: the context-budget engine must recognize,
 * count, mask, and prune REAL OpenCode SDK tool-result payloads (`ToolPart`
 * with `part.type === 'tool'`, `part.tool`, `part.state.output`), not the
 * fictional `info.toolName` shape. These tests prove the production scenario
 * (small-context model overflow) is actually fixed.
 *
 * Split from context-budget.test.ts for the FR-006 500-line cap.
 */
import { describe, expect, test } from 'bun:test';
import { createContextBudgetHandler } from '../../../src/hooks/context-budget';
import { estimateTokens } from '../../../src/hooks/utils';

/**
 * Build a real OpenCode SDK completed-tool assistant message: the heavy output
 * lives in a `ToolPart` (`part.state.output`), NOT in a text part and NOT in
 * a fictional `info.toolName` field (issue #2068).
 */
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

describe('Issue #2068: real ToolPart shape', () => {
	// T1: token counter counts state.output (usage reflects tool output).
	test('T1: token counter counts ToolPart.state.output', async () => {
		// 30k chars of tool output ≈ 9900 tokens. With a 10000-token limit and
		// critical_threshold 0.9, this MUST trip critical enforcement. Before
		// the fix, the counter ignored state.output and never tripped.
		const config = baseConfig({ model_limits: { default: 10000 } });
		const handler = createContextBudgetHandler(config);

		const messages = [
			toolMsg('read_file', 'x'.repeat(30000)),
			{
				info: { role: 'user', agent: 'architect' },
				parts: [{ type: 'text', text: 'go' }],
			},
		];
		const output = { messages };
		await handler({}, output);

		// Critical enforcement should have fired and masked/pruned the tool
		// output (proving it was counted). The architect warning is injected
		// on the last user message.
		const userText = output.messages[1].parts[0].text as string;
		expect(userText).toContain('CONTEXT CRITICAL');
	});

	// T2: masking replaces ToolPart with a synthetic text placeholder.
	test('T2: masking replaces ToolPart with text placeholder and frees tokens', async () => {
		const config = baseConfig({
			model_limits: { default: 10000 },
			recent_window: 0, // force old
			preserve_last_n_turns: 0, // allow masking the oldest message
		});
		const handler = createContextBudgetHandler(config);

		const big = 'x'.repeat(50000);
		const messages = [
			toolMsg('bash', big),
			{
				info: { role: 'user', agent: 'architect' },
				parts: [{ type: 'text', text: 'x'.repeat(90000) }],
			},
			{
				info: { role: 'assistant' },
				parts: [{ type: 'text', text: 'recent assistant reply' }],
			},
		];
		const output = { messages: JSON.parse(JSON.stringify(messages)) };
		await handler({}, output);

		const part = output.messages[0].parts[0];
		expect(part.type).toBe('text'); // ToolPart replaced
		expect(part.state).toBeUndefined(); // no ToolPart anymore
		expect(part.text as string).toMatch(/\[Tool output masked/);
		// Freed: original placeholder is far smaller than 50000 chars.
		expect((part.text as string).length).toBeLessThan(big.length);
	});

	// T3: recent tool output NOT masked.
	test('T3: recent tool output NOT masked', async () => {
		const config = baseConfig({
			model_limits: { default: 100000 },
			recent_window: 10, // recent
		});
		const handler = createContextBudgetHandler(config);

		const big = 'x'.repeat(5000);
		const messages = [
			toolMsg('bash', big),
			{
				info: { role: 'user', agent: 'architect' },
				parts: [{ type: 'text', text: 'x'.repeat(80000) }],
			},
		];
		const output = { messages: JSON.parse(JSON.stringify(messages)) };
		await handler({}, output);

		// age = 1 < recent_window 10 → not masked; ToolPart retained.
		expect(output.messages[0].parts[0].type).toBe('tool');
		expect(output.messages[0].parts[0].state.output).toBe(big);
	});

	// T4: exempt tool (read) NOT masked.
	test('T4: exempt tool (read) NOT masked', async () => {
		const config = baseConfig({
			model_limits: { default: 10000 },
			recent_window: 0,
		});
		const handler = createContextBudgetHandler(config);

		const big = 'x'.repeat(50000);
		const messages = [
			toolMsg('read', big),
			{
				info: { role: 'user', agent: 'architect' },
				parts: [{ type: 'text', text: 'x'.repeat(90000) }],
			},
		];
		const output = { messages: JSON.parse(JSON.stringify(messages)) };
		await handler({}, output);

		expect(output.messages[0].parts[0].type).toBe('tool');
		expect(output.messages[0].parts[0].state.output).toBe(big);
	});

	// T5: full critical path on a 32k model reaches target (issue scenario).
	test('T5: 32k-model overflow scenario frees tokens below target', async () => {
		// Simulate the issue: a 32768-token model with ~28k tokens of tool
		// output that previously caused "32769 tokens requested > 32768 max".
		const config = baseConfig({
			model_limits: { default: 32768 },
			critical_threshold: 0.9,
			prune_target: 0.5,
			recent_window: 0,
			preserve_last_n_turns: 0,
			tool_output_mask_threshold: 100,
		});
		const handler = createContextBudgetHandler(config);

		// ~28k tokens ≈ 84000 chars of tool output.
		const messages = [
			toolMsg('bash', 'x'.repeat(84000)),
			toolMsg('bash', 'x'.repeat(40000)),
			{
				info: { role: 'user', agent: 'architect' },
				parts: [{ type: 'text', text: 'proceed' }],
			},
		];
		const output = { messages: JSON.parse(JSON.stringify(messages)) };
		await handler({}, output);

		// Recalculate post-transform tokens (text parts + completed state.output)
		// and assert the result is at or below the configured target
		// (32768 * 0.5 = 16384) — proving enforcement actually freed enough.
		const target = 32768 * 0.5;
		let postTokens = 0;
		for (const m of output.messages) {
			for (const p of m.parts) {
				if (p.type === 'text' && typeof p.text === 'string') {
					postTokens += estimateTokens(p.text);
				} else if (
					p.type === 'tool' &&
					p.state?.status === 'completed' &&
					typeof p.state.output === 'string'
				) {
					postTokens += estimateTokens(p.state.output);
				}
			}
		}
		expect(postTokens).toBeLessThanOrEqual(target);
	});

	// T6: idempotency — already-masked tool output not re-processed.
	test('T6: already-masked tool output not re-masked', async () => {
		const config = baseConfig({
			model_limits: { default: 10000 },
			recent_window: 0,
		});
		const handler = createContextBudgetHandler(config);

		// Pre-masked message (placeholder already in place as a text part).
		const placeholder =
			'[Tool output masked — bash returned ~100 tokens. First 200 chars: "..." Use retrieve_summary if needed.]';
		const messages = [
			{
				info: { role: 'assistant' },
				parts: [{ type: 'text', text: placeholder }],
			},
			{
				info: { role: 'user', agent: 'architect' },
				parts: [{ type: 'text', text: 'x'.repeat(90000) }],
			},
		];
		const output = { messages: JSON.parse(JSON.stringify(messages)) };
		await handler({}, output);

		expect(output.messages[0].parts[0].text).toBe(placeholder);
	});

	// T7: pending/running tool counted 0, not masked.
	test('T7: pending/running tool counted 0 and not masked', async () => {
		const config = baseConfig({
			model_limits: { default: 100000 },
			recent_window: 0,
		});
		const handler = createContextBudgetHandler(config);

		const messages = [
			{
				info: { role: 'assistant' },
				parts: [
					{
						type: 'tool',
						tool: 'bash',
						state: { status: 'running', input: {}, time: { start: 0 } },
					},
				],
			},
			{
				info: { role: 'user', agent: 'architect' },
				parts: [{ type: 'text', text: 'x'.repeat(80000) }],
			},
		];
		const output = { messages: JSON.parse(JSON.stringify(messages)) };
		await handler({}, output);

		// Running tool has no output → not masked, shape preserved.
		expect(output.messages[0].parts[0].type).toBe('tool');
		expect(output.messages[0].parts[0].state.status).toBe('running');
	});
});
