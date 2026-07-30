/**
 * `recoveryHint()` in src/hooks/context-budget.ts — the placeholder that
 * replaces masked/pruned tool output must point the model at the correct
 * retrieval tool. Generic oversized tool output is stored by
 * tool-summarizer.ts and retrieved with `retrieve_summary`; lane batch
 * output (dispatch_lanes / collect_lane_results) lives in the lane-output
 * store and is retrieved with `retrieve_lane_output <ref>` instead —
 * pointing a lane-artifact placeholder at `retrieve_summary` is a dead end.
 *
 * `recoveryHint` itself is not exported (internal to context-budget.ts), so
 * these tests drive it through the public `createContextBudgetHandler` mask
 * path, matching the module's existing test conventions in
 * tests/unit/hooks/context-budget.test.ts.
 *
 * This file is kept separate from context-budget.test.ts (already over the
 * 500-line FR-006 cap) rather than extended, per the writing-tests skill's
 * guidance to avoid growing an already over-cap file.
 */
import { describe, expect, test } from 'bun:test';
import { createContextBudgetHandler } from '../../../src/hooks/context-budget';

/** Valid-format lane output ref: `L1:<64 hex>:<64 hex>:<64 hex>`. */
function laneRef(char: string): string {
	const hex = char.repeat(64);
	return `L1:${hex}:${hex}:${hex}`;
}

/**
 * Config that forces the Task 4.2 tool-output-masking path to run
 * unconditionally on non-terminal messages, while protecting every message
 * from the separate priority-based pruning pass (Step 2/3) so a message is
 * masked exactly once and `recoveryHint` is observable directly in the
 * "[Tool output masked" placeholder.
 */
function makeMaskingConfig() {
	return {
		context_budget: {
			enabled: true,
			model_limits: { default: 100 },
			enforce: true,
			// recent_window: 0 makes every non-last message "old" (age > 0),
			// so shouldMaskToolOutput triggers regardless of text length.
			recent_window: 0,
			// Protect all messages from Step 2/3 removal so the masked
			// placeholder is not re-masked by applyObservationMasking.
			preserve_last_n_turns: 100,
			tool_output_mask_threshold: 100_000,
		},
		max_iterations: 5,
		qa_retry_limit: 3,
		inject_phase_reminders: true,
	};
}

function findMaskedText(messages: Array<{ parts: Array<{ text?: string }> }>) {
	for (const msg of messages) {
		for (const part of msg.parts) {
			if (part.text?.includes('[Tool output masked')) return part.text;
		}
	}
	return undefined;
}

describe('recoveryHint via tool-output masking', () => {
	test('a lane ref in the original text produces a retrieve_lane_output placeholder containing the ref', async () => {
		const handler = createContextBudgetHandler(makeMaskingConfig());
		const ref = laneRef('a');
		const messages = [
			{
				info: { role: 'user', agent: 'architect' },
				parts: [{ type: 'text', text: 'x'.repeat(100) }],
			},
			{
				info: { role: 'assistant', toolName: 'bash' },
				parts: [
					{
						type: 'text',
						text: `lane result ref ${ref} plus padding ${'y'.repeat(100)}`,
					},
				],
			},
			{
				info: { role: 'user', agent: 'architect' },
				parts: [{ type: 'text', text: 'a'.repeat(100) }],
			},
			{
				info: { role: 'assistant', toolName: 'bash' },
				parts: [{ type: 'text', text: 'b'.repeat(100) }],
			},
			{
				info: { role: 'user', agent: 'architect' },
				parts: [{ type: 'text', text: 'c'.repeat(100) }],
			},
		];
		const output = { messages };
		await handler({}, output);

		const masked = findMaskedText(output.messages);
		expect(masked).toBeDefined();
		expect(masked).toContain('retrieve_lane_output');
		expect(masked).toContain(ref);
	});

	test('text with no lane ref falls back to retrieve_summary wording (no regression)', async () => {
		const handler = createContextBudgetHandler(makeMaskingConfig());
		const messages = [
			{
				info: { role: 'user', agent: 'architect' },
				parts: [{ type: 'text', text: 'x'.repeat(100) }],
			},
			{
				info: { role: 'assistant', toolName: 'bash' },
				parts: [{ type: 'text', text: 'plain tool output '.repeat(20) }],
			},
			{
				info: { role: 'user', agent: 'architect' },
				parts: [{ type: 'text', text: 'a'.repeat(100) }],
			},
			{
				info: { role: 'assistant', toolName: 'bash' },
				parts: [{ type: 'text', text: 'b'.repeat(100) }],
			},
			{
				info: { role: 'user', agent: 'architect' },
				parts: [{ type: 'text', text: 'c'.repeat(100) }],
			},
		];
		const output = { messages };
		await handler({}, output);

		const masked = findMaskedText(output.messages);
		expect(masked).toBeDefined();
		expect(masked).toContain('retrieve_summary');
		expect(masked).not.toContain('retrieve_lane_output');
	});

	// R7 fix (src/hooks/context-budget.ts, finding R7): recoveryHint now caps
	// to ONE ref, not three. Each `L1:` ref is ~197 chars; including up to
	// three could add ~600 chars to a placeholder replacing a short tool
	// result, driving the computed freedTokens negative. One ref is enough
	// for the model to recover the lane payload. Test name and expectations
	// updated from "capped at 3" to "capped at 1" to match; no other
	// assertion in this file changed or weakened.
	test('multiple distinct lane refs are capped at 1 in the hint', async () => {
		const handler = createContextBudgetHandler(makeMaskingConfig());
		const refA = laneRef('a');
		const refB = laneRef('b');
		const refC = laneRef('c');
		const refD = laneRef('d');
		const messages = [
			{
				info: { role: 'user', agent: 'architect' },
				parts: [{ type: 'text', text: 'x'.repeat(100) }],
			},
			{
				info: { role: 'assistant', toolName: 'bash' },
				parts: [
					{
						type: 'text',
						text: `${refA} then ${refB} then ${refC} then ${refD} end ${'y'.repeat(100)}`,
					},
				],
			},
			{
				info: { role: 'user', agent: 'architect' },
				parts: [{ type: 'text', text: 'a'.repeat(100) }],
			},
			{
				info: { role: 'assistant', toolName: 'bash' },
				parts: [{ type: 'text', text: 'b'.repeat(100) }],
			},
			{
				info: { role: 'user', agent: 'architect' },
				parts: [{ type: 'text', text: 'c'.repeat(100) }],
			},
		];
		const output = { messages };
		await handler({}, output);

		const masked = findMaskedText(output.messages);
		expect(masked).toBeDefined();
		const hintMatch = masked?.match(
			/Use retrieve_lane_output with ref (.+) if needed\.\]/,
		);
		expect(hintMatch).toBeDefined();
		const refsListed = hintMatch![1].split(', ');
		expect(refsListed).toEqual([refA]);
		expect(refsListed).not.toContain(refB);
		expect(refsListed).not.toContain(refC);
		expect(refsListed).not.toContain(refD);
	});
});
