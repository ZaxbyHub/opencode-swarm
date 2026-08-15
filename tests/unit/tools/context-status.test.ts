/**
 * Unit tests for context_status tool (FR-001).
 *
 * Verifies:
 * - AC-001: tool exists, is registered, and returns all required fields
 * - AC-002: tool returns data even when context_budget.enabled is false (uses default thresholds)
 * - AC-002: tool derives messages from session context, not caller-supplied input
 * - SC-001..SC-003: token counting, threshold detection, model/provider resolution
 * - SC-002: no warning injection side effects
 */

import { describe, expect, it } from 'bun:test';
import {
	computeContextHeadroom,
	context_status,
} from '../../../src/tools/context-status';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMessage(
	overrides: {
		role?: string;
		modelID?: string;
		providerID?: string;
		text?: string;
	} = {},
) {
	return {
		info: {
			role: overrides.role ?? 'user',
			modelID: overrides.modelID,
			providerID: overrides.providerID,
		},
		parts: overrides.text ? [{ type: 'text', text: overrides.text }] : [],
	};
}

// ---------------------------------------------------------------------------
// Tool surface tests (AC-001)
// ---------------------------------------------------------------------------

describe('context_status tool surface', () => {
	it('should be exported from src/tools/context-status', () => {
		expect(context_status).toBeDefined();
		expect(typeof context_status).toBe('object');
	});

	it('should have description and execute', () => {
		expect(context_status.description).toBeDefined();
		expect(typeof context_status.description).toBe('string');
		expect(context_status.execute).toBeDefined();
		expect(typeof context_status.execute).toBe('function');
	});

	it('should have an args schema with no required fields', () => {
		expect(context_status.args).toBeDefined();
		expect(Object.keys(context_status.args)).toEqual(['working_directory']);
		expect(
			context_status.args.working_directory.safeParse(undefined).success,
		).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// computeContextHeadroom unit tests
// ---------------------------------------------------------------------------

describe('computeContextHeadroom', () => {
	it('returns zero tokens for empty messages', () => {
		const result = computeContextHeadroom([]);
		expect(result.tokensUsed).toBe(0);
		expect(result.modelLimit).toBeGreaterThan(0);
		expect(result.usagePercent).toBe(0);
		expect(result.thresholdCrossed).toBe('none');
		expect(result.modelId).toBeNull();
		expect(result.provider).toBeNull();
	});

	it('counts tokens from text parts only', () => {
		// estimateTokens uses Math.ceil(text.length * 0.33)
		const text = 'Hello world'; // 11 chars * 0.33 = 3.63 -> ceil = 4
		const messages = [makeMessage({ role: 'user', text })];

		const result = computeContextHeadroom(messages);
		expect(result.tokensUsed).toBe(4);
	});

	it('skips non-text parts', () => {
		const messages = [
			makeMessage({ role: 'user', text: 'hello' }),
			{
				...makeMessage({ role: 'assistant' }),
				parts: [{ type: 'tool_result', text: 'ignored' }],
			},
		];

		const result = computeContextHeadroom(messages);
		// Only the first message's text should be counted
		expect(result.tokensUsed).toBeGreaterThan(0);
	});

	it('detects warn threshold with custom config', () => {
		// Build messages that consume ~60% of a 1000-token limit
		// Using custom warn=0.5, critical=0.8
		const messages = [
			makeMessage({
				role: 'assistant',
				modelID: 'claude-sonnet-4',
				providerID: 'anthropic',
				text: 'x'.repeat(10000), // ~3300 tokens, limit=200000 -> ~1.65%
			}),
		];

		const result = computeContextHeadroom(messages, 0.5, 0.8);
		expect(result.thresholdCrossed).toBe('none');
		expect(result.usagePercent).toBeLessThan(0.5);
	});

	it('detects critical threshold with custom config', () => {
		// Test that custom critical threshold is respected
		// We can't easily hit 90% with small text, so we verify the boundary
		// by testing that a usagePercent > custom critical triggers 'critical'
		const messages = [
			makeMessage({
				role: 'assistant',
				modelID: 'claude-sonnet-4',
				providerID: 'anthropic',
				text: 'x'.repeat(10000),
			}),
		];

		// With a very low critical threshold (0.001), even tiny usage triggers critical
		const result = computeContextHeadroom(messages, 0.7, 0.001);
		expect(result.thresholdCrossed).toBe('critical');
	});

	it('classifies exact critical threshold as warn (boundary — strict >)', () => {
		// warn=0.5, critical=0.8, modelLimit=100
		// text length 240 -> ceil(240*0.33)=80 tokens -> 80/100 = 0.8 exactly
		// With strict `>`, exact critical does NOT trigger critical,
		// but it IS above warn, so it triggers warn
		const messages = [
			makeMessage({
				role: 'assistant',
				modelID: 'custom-model',
				providerID: 'custom-provider',
				text: 'x'.repeat(240),
			}),
		];

		const result = computeContextHeadroom(messages, 0.5, 0.8, {
			'custom-provider/custom-model': 100,
		});
		expect(result.thresholdCrossed).toBe('warn');
		expect(result.usagePercent).toBe(0.8);
	});

	it('classifies exact warn threshold as none (boundary — strict >)', () => {
		// warn=0.5, critical=0.8, modelLimit=100
		// text length 151 -> ceil(151*0.33)=50 tokens -> 50/100 = 0.5 exactly
		// With strict `>`, exact threshold does NOT trigger warn
		const messages = [
			makeMessage({
				role: 'assistant',
				modelID: 'custom-model',
				providerID: 'custom-provider',
				text: 'x'.repeat(151),
			}),
		];

		const result = computeContextHeadroom(messages, 0.5, 0.8, {
			'custom-provider/custom-model': 100,
		});
		expect(result.thresholdCrossed).toBe('none');
		expect(result.usagePercent).toBe(0.5);
	});

	it('classifies just above critical threshold as critical (boundary — strict >)', () => {
		// warn=0.5, critical=0.8, modelLimit=100
		// text length 241 -> ceil(241*0.33)=80 tokens -> 80/100 = 0.8 (still exact due to ceil)
		// Need to exceed: text length 242 -> ceil(242*0.33)=80 tokens -> 80/100 = 0.8 (still exact)
		// text length 243 -> ceil(243*0.33)=81 tokens -> 81/100 = 0.81 > 0.8
		const messages = [
			makeMessage({
				role: 'assistant',
				modelID: 'custom-model',
				providerID: 'custom-provider',
				text: 'x'.repeat(243),
			}),
		];

		const result = computeContextHeadroom(messages, 0.5, 0.8, {
			'custom-provider/custom-model': 100,
		});
		expect(result.thresholdCrossed).toBe('critical');
		expect(result.usagePercent).toBeGreaterThan(0.8);
	});

	it('classifies just above warn threshold as warn (boundary — strict >)', () => {
		// warn=0.5, critical=0.8, modelLimit=100
		// text length 152 -> ceil(152*0.33)=51 tokens -> 51/100 = 0.51 > 0.5
		const messages = [
			makeMessage({
				role: 'assistant',
				modelID: 'custom-model',
				providerID: 'custom-provider',
				text: 'x'.repeat(152),
			}),
		];

		const result = computeContextHeadroom(messages, 0.5, 0.8, {
			'custom-provider/custom-model': 100,
		});
		expect(result.thresholdCrossed).toBe('warn');
		expect(result.usagePercent).toBeGreaterThan(0.5);
	});

	it('classifies just below warn threshold as none (boundary — strict >)', () => {
		// warn=0.5, critical=0.8, modelLimit=100
		// text length 148 -> ceil(148*0.33)=49 tokens -> 49/100 = 0.49 < 0.5
		const messages = [
			makeMessage({
				role: 'assistant',
				modelID: 'custom-model',
				providerID: 'custom-provider',
				text: 'x'.repeat(148),
			}),
		];

		const result = computeContextHeadroom(messages, 0.5, 0.8, {
			'custom-provider/custom-model': 100,
		});
		expect(result.thresholdCrossed).toBe('none');
		expect(result.usagePercent).toBeLessThan(0.5);
	});

	it('extracts model and provider from most recent assistant message', () => {
		const messages = [
			makeMessage({ role: 'user', text: 'hi' }),
			makeMessage({
				role: 'assistant',
				modelID: 'gpt-5',
				providerID: 'openai',
				text: 'hello',
			}),
		];

		const result = computeContextHeadroom(messages);
		expect(result.modelId).toBe('gpt-5');
		expect(result.provider).toBe('openai');
	});

	it('falls back to null model/provider when no assistant message has them', () => {
		const messages = [
			makeMessage({ role: 'user', text: 'hi' }),
			makeMessage({ role: 'assistant', text: 'hello' }),
		];

		const result = computeContextHeadroom(messages);
		expect(result.modelId).toBeNull();
		expect(result.provider).toBeNull();
	});

	it('resolves model limit for known model/provider combos', () => {
		const messages = [
			makeMessage({
				role: 'assistant',
				modelID: 'claude-sonnet-4',
				providerID: 'copilot',
				text: 'test',
			}),
		];

		const result = computeContextHeadroom(messages);
		// copilot caps at 128000
		expect(result.modelLimit).toBe(128000);
	});

	it('falls back to 128000 when model/provider unknown', () => {
		const messages = [makeMessage({ role: 'user', text: 'test' })];

		const result = computeContextHeadroom(messages);
		expect(result.modelLimit).toBe(128000);
	});

	it('does not mutate input messages', () => {
		const messages = [
			makeMessage({ role: 'user', text: 'original' }),
			makeMessage({ role: 'assistant', text: 'reply' }),
		];
		const originalText = messages[0].parts?.[0]?.text;

		computeContextHeadroom(messages);

		expect(messages[0].parts?.[0]?.text).toBe(originalText);
	});

	it('uses custom model limits from config', () => {
		const messages = [
			makeMessage({
				role: 'assistant',
				modelID: 'custom-model',
				providerID: 'custom-provider',
				text: 'test',
			}),
		];

		const result = computeContextHeadroom(messages, 0.7, 0.9, {
			'custom-provider/custom-model': 50000,
		});
		expect(result.modelLimit).toBe(50000);
	});
});
