import { beforeEach, describe, expect, test } from 'bun:test';
import {
	extractModelInfo,
	NATIVE_MODEL_LIMITS,
	PROVIDER_CAPS,
	resolveModelLimit,
} from '../../../src/hooks/model-limits';

// Helper function to create message objects matching OpenCode's message format
function makeMessage(
	role: string,
	modelID?: string,
	providerID?: string,
): {
	info: { role: string; modelID?: string; providerID?: string };
	parts: Array<{ type: string }>;
} {
	return {
		info: {
			role,
			...(modelID !== undefined && { modelID }),
			...(providerID !== undefined && { providerID }),
		},
		parts: [{ type: 'text' }],
	};
}

describe('model-limits.ts - resolveModelLimit', () => {
	describe('Native provider limits', () => {
		test('Test 1: resolveModelLimit with native API provider (anthropic) returns native limit', () => {
			// Input: resolveModelLimit('claude-sonnet-4-6', 'anthropic', {})
			const result = resolveModelLimit('claude-sonnet-4-6', 'anthropic', {});

			// Expected: 200000 (native for claude-sonnet-4)
			expect(result.limit).toBe(200000);
			// #2044: provenance — the native static table produced the limit.
			expect(result.source).toBe('native');
			expect(result.resolution).toBe('static_native');

			// Verify: Prefix matching works for versioned model ID
			expect(result.limit).toBe(NATIVE_MODEL_LIMITS['claude-sonnet-4']);
		});
	});

	describe('Provider caps override native limits', () => {
		test('Test 2: resolveModelLimit with Copilot provider returns Copilot cap (128k), not native', () => {
			// Input: resolveModelLimit('claude-sonnet-4-6', 'copilot', {})
			const result = resolveModelLimit('claude-sonnet-4-6', 'copilot', {});

			// Expected: 128000 (Copilot cap, not 200k native)
			expect(result.limit).toBe(128000);
			// #2044: the provider-cap table is distinguishable from the native table.
			expect(result.source).toBe('provider_cap');
			expect(result.resolution).toBe('static_provider_cap');

			// Verify: Provider cap overrides native limit
			expect(result.limit).toBeLessThan(NATIVE_MODEL_LIMITS['claude-sonnet-4']);
			expect(result.limit).toBe(PROVIDER_CAPS.copilot);
		});

		test('Test 3: resolveModelLimit with GPT-5 on Copilot returns 128k (not 400k native)', () => {
			// Input: resolveModelLimit('gpt-5', 'copilot', {})
			const result = resolveModelLimit('gpt-5', 'copilot', {});

			// Expected: 128000 (Copilot cap)
			expect(result.limit).toBe(128000);
			expect(result.source).toBe('provider_cap');

			// Verify: Copilot cap applies to ALL models including expensive ones
			expect(result.limit).toBeLessThan(NATIVE_MODEL_LIMITS['gpt-5']);
			expect(result.limit).toBe(PROVIDER_CAPS.copilot);
		});
	});

	describe('Config overrides have highest priority', () => {
		test('Test 4: User config override beats provider cap', () => {
			// Input: resolveModelLimit('claude-sonnet-4-6', 'copilot', {'copilot/claude-sonnet-4-6': 200000})
			const config = { 'copilot/claude-sonnet-4-6': 200000 };
			const result = resolveModelLimit('claude-sonnet-4-6', 'copilot', config);

			// Expected: 200000 (user override)
			expect(result.limit).toBe(200000);
			// #2044: a user-authored entry is the 'override' class, with the
			// compound key as the fine-grained rung.
			expect(result.source).toBe('override');
			expect(result.resolution).toBe('user_provider_model');

			// Verify: User config has highest priority
			expect(result.limit).toBeGreaterThan(PROVIDER_CAPS.copilot);
			expect(result.limit).toBe(config['copilot/claude-sonnet-4-6']);
		});

		test('Test 5: Model-only config override beats native default', () => {
			// Input: resolveModelLimit('claude-sonnet-4-6', 'openai', {'claude-sonnet-4-6': 180000})
			const config = { 'claude-sonnet-4-6': 180000 };
			const result = resolveModelLimit('claude-sonnet-4-6', 'openai', config);

			// Expected: 180000 (model override)
			expect(result.limit).toBe(180000);
			expect(result.source).toBe('override');
			expect(result.resolution).toBe('user_model');

			// Verify: Model key in config works
			expect(result.limit).toBe(config['claude-sonnet-4-6']);
		});

		test('Test 11: Compound key config (copilot/gpt-5) takes priority over model-only key (gpt-5)', () => {
			// Setup: Both compound and model-only keys present
			const config = {
				'copilot/gpt-5': 150000, // Compound key
				'gpt-5': 200000, // Model-only key
			};
			const result = resolveModelLimit('gpt-5', 'copilot', config);

			// Expected: 150000 (compound key takes priority)
			expect(result.limit).toBe(150000);
			expect(result.resolution).toBe('user_provider_model');

			// Verify: Compound key takes priority over model-only key
			expect(result.limit).toBe(config['copilot/gpt-5']);
			expect(result.limit).not.toBe(config['gpt-5']);
		});
	});

	describe('Prefix matching with versioned model IDs', () => {
		test('Test 6: Prefix matching with versioned model ID', () => {
			// Input: resolveModelLimit('claude-sonnet-4-6-20260301', 'anthropic', {})
			const result = resolveModelLimit(
				'claude-sonnet-4-6-20260301',
				'anthropic',
				{},
			);

			// Expected: 200000 (matches 'claude-sonnet-4' prefix in NATIVE_MODEL_LIMITS)
			expect(result.limit).toBe(200000);
			expect(result.source).toBe('native');

			// Verify: Longest prefix match works correctly
			expect(result.limit).toBe(NATIVE_MODEL_LIMITS['claude-sonnet-4']);
		});

		test('Prefix matching selects longest match', () => {
			// Test with multiple potential prefix matches
			const result = resolveModelLimit(
				'gpt-5.1-codex-variant',
				'anthropic',
				{},
			);

			// Should match 'gpt-5.1-codex' (longest prefix), not 'gpt-5.1'
			expect(result.limit).toBe(NATIVE_MODEL_LIMITS['gpt-5.1-codex']);
		});
	});

	describe('Graceful fallback behavior', () => {
		test('Test 7: Graceful fallback when modelID/providerID are undefined', () => {
			// Input: resolveModelLimit(undefined, undefined, {})
			const result = resolveModelLimit(undefined, undefined, {});

			// Expected: 128000 (safe default)
			expect(result.limit).toBe(128000);
			// #2044: the flat default is the 'fallback' class — visible, not hidden.
			expect(result.source).toBe('fallback');
			expect(result.resolution).toBe('static_default');

			// Verify: No crashes, returns a usable limit
			expect(typeof result.limit).toBe('number');
		});

		test('Fallback when modelID not in NATIVE_MODEL_LIMITS', () => {
			const result = resolveModelLimit(
				'unknown-model-x',
				'unknown-provider',
				{},
			);

			expect(result.limit).toBe(128000);
			expect(result.source).toBe('fallback');
		});

		test('Config.default override takes precedence before fallback', () => {
			const config = { default: 64000 };
			const result = resolveModelLimit(
				'unknown-model',
				'unknown-provider',
				config,
			);

			expect(result.limit).toBe(64000);
			expect(result.source).toBe('override');
			expect(result.resolution).toBe('user_default');
		});
	});

	describe('Other providers preserve native limits', () => {
		test('OpenAI provider returns native GPT-5 limit', () => {
			const result = resolveModelLimit('gpt-5', 'openai', {});

			expect(result.limit).toBe(NATIVE_MODEL_LIMITS['gpt-5']);
			expect(result.source).toBe('native');
		});

		test('Google provider returns native Gemini limit', () => {
			const result = resolveModelLimit('gemini-2.5-pro', 'google', {});

			expect(result.limit).toBe(NATIVE_MODEL_LIMITS['gemini-2.5-pro']);
			expect(result.source).toBe('native');
		});

		test('MiniMax-M3 returns its native 1,000,000-token limit', () => {
			const result = resolveModelLimit('MiniMax-M3', 'minimax', {});

			expect(result.limit).toBe(NATIVE_MODEL_LIMITS['MiniMax-M3']);
			expect(result.limit).toBe(1000000);
			expect(result.source).toBe('native');
		});

		test('MiniMax-M2.7 returns its native 204,800-token limit', () => {
			const result = resolveModelLimit('MiniMax-M2.7', 'minimax', {});

			expect(result.limit).toBe(NATIVE_MODEL_LIMITS['MiniMax-M2.7']);
			expect(result.limit).toBe(204800);
			expect(result.source).toBe('native');
		});

		test('Prefix matching resolves a versioned MiniMax-M3 variant', () => {
			const result = resolveModelLimit('MiniMax-M3-20260701', 'minimax', {});

			expect(result.limit).toBe(NATIVE_MODEL_LIMITS['MiniMax-M3']);
		});
	});

	describe('#2044 — provenance: host precedence and visibility', () => {
		test('the live host window resolves as the host class and beats every static rung', () => {
			const result = resolveModelLimit(
				'claude-sonnet-4-6',
				'github-copilot',
				{},
				1_000_000,
			);
			expect(result).toEqual({
				limit: 1_000_000,
				source: 'host',
				resolution: 'live_model_limit',
			});
		});

		test('an override beats the host value (explicit user intent wins)', () => {
			const result = resolveModelLimit(
				'claude-sonnet-4-6',
				'github-copilot',
				{ 'github-copilot/claude-sonnet-4-6': 60000 },
				1_000_000,
			);
			expect(result.source).toBe('override');
			expect(result.resolution).toBe('user_provider_model');
			expect(result.limit).toBe(60000);
		});

		test('unknown model + no live value is visible as fallback, never coerced', () => {
			const result = resolveModelLimit('model-nobody-knows', 'provider-x', {});
			expect(result.source).toBe('fallback');
			expect(result.resolution).toBe('static_default');
			expect(result.limit).toBe(128000);
		});

		test('normalized aliases: case/whitespace differences in override keys still match', () => {
			const result = resolveModelLimit('GPT-5', 'GitHub-Copilot', {
				'  github-copilot/gpt-5  ': 90000,
			});
			expect(result.source).toBe('override');
			expect(result.resolution).toBe('user_provider_model');
			expect(result.limit).toBe(90000);
		});

		test('invalid override values are skipped and surfaced, not coerced', () => {
			const result = resolveModelLimit('gpt-5', 'copilot', {
				'copilot/gpt-5': Number.NaN as number,
				default: 0 as number,
			});
			// Neither unusable value is used; resolution falls to the provider cap.
			expect(result.source).toBe('provider_cap');
			expect(result.limit).toBe(128000);
		});
	});
});

describe('model-limits.ts - extractModelInfo', () => {
	describe('Extracts from most recent assistant message', () => {
		test('Test 8: extractModelInfo extracts modelID and providerID from most recent assistant message', () => {
			// Input: messages array with assistant message containing { modelID: 'gpt-5', providerID: 'copilot' } in parts
			const messages = [
				makeMessage('user', undefined, undefined),
				makeMessage('assistant', 'gpt-5', 'copilot'),
			];

			const result = extractModelInfo(messages);

			// Expected: { modelID: 'gpt-5', providerID: 'copilot' }
			expect(result).toEqual({
				modelID: 'gpt-5',
				providerID: 'copilot',
			});

			// Verify: Extraction logic works correctly
			expect(result.modelID).toBeDefined();
			expect(result.providerID).toBeDefined();
		});

		test('Extracts from the most recent assistant message when multiple exist', () => {
			const messages = [
				makeMessage('user', undefined, undefined),
				makeMessage('assistant', 'claude-sonnet-4-6', 'anthropic'),
				makeMessage('user', undefined, undefined),
				makeMessage('assistant', 'gpt-5', 'copilot'), // Most recent
			];

			const result = extractModelInfo(messages);

			expect(result).toEqual({
				modelID: 'gpt-5',
				providerID: 'copilot',
			});
		});
	});

	describe('Edge cases and graceful handling', () => {
		test('Test 9: extractModelInfo with no assistant messages returns {}', () => {
			// Input: messages array with no assistant messages
			const messages = [
				makeMessage('user', undefined, undefined),
				makeMessage('system', undefined, undefined),
			];

			const result = extractModelInfo(messages);

			// Expected: {}
			expect(result).toEqual({});
		});

		test('Test 10: extractModelInfo with assistant messages but no modelID/providerID fields returns {}', () => {
			// Input: messages array with assistant message but missing modelID/providerID
			const messages = [
				makeMessage('user', undefined, undefined),
				makeMessage('assistant', undefined, undefined), // No modelID/providerID
			];

			const result = extractModelInfo(messages);

			// Expected: {}
			expect(result).toEqual({});
		});

		test('Returns empty object when messages array is empty', () => {
			const result = extractModelInfo([]);

			expect(result).toEqual({});
		});

		test('Returns empty object when messages is undefined', () => {
			const result = extractModelInfo(undefined as any);

			expect(result).toEqual({});
		});

		test('Returns empty object when message.info is missing', () => {
			const messages = [{ parts: [] }]; // Missing info property

			const result = extractModelInfo(messages as any);

			expect(result).toEqual({});
		});

		test('Extracts partial info when only modelID present', () => {
			const messages = [
				makeMessage('user', undefined, undefined),
				makeMessage('assistant', 'claude-sonnet-4-6', undefined),
			];

			const result = extractModelInfo(messages);

			expect(result).toEqual({
				modelID: 'claude-sonnet-4-6',
			});
			expect(result.providerID).toBeUndefined();
		});

		test('Extracts partial info when only providerID present', () => {
			const messages = [
				makeMessage('user', undefined, undefined),
				makeMessage('assistant', undefined, 'anthropic'),
			];

			const result = extractModelInfo(messages);

			expect(result).toEqual({
				providerID: 'anthropic',
			});
			expect(result.modelID).toBeUndefined();
		});
	});

	describe('Message scanning behavior', () => {
		test('Scans messages in reverse order (most recent first)', () => {
			const messages = [
				makeMessage('assistant', 'old-model', 'old-provider'),
				makeMessage('user', undefined, undefined),
				makeMessage('assistant', 'new-model', 'new-provider'), // Should be selected
				makeMessage('user', undefined, undefined),
			];

			const result = extractModelInfo(messages);

			expect(result).toEqual({
				modelID: 'new-model',
				providerID: 'new-provider',
			});
		});

		test('Stops at first assistant message with modelID or providerID', () => {
			const messages = [
				makeMessage('assistant', 'model-1', 'provider-1'),
				makeMessage('assistant', undefined, undefined), // Assistant with no fields
				makeMessage('assistant', 'model-2', 'provider-2'), // First with fields (reverse order)
			];

			const result = extractModelInfo(messages);

			// Should return first found in reverse order
			expect(result).toEqual({
				modelID: 'model-2',
				providerID: 'provider-2',
			});
		});
	});
});

describe('model-limits.ts - Integration scenarios', () => {
	describe('Real-world usage patterns', () => {
		test('Typical Copilot workflow', () => {
			const messages = [
				makeMessage('user', undefined, undefined),
				makeMessage('assistant', 'gpt-5', 'copilot'),
			];

			const info = extractModelInfo(messages);
			const limit = resolveModelLimit(info.modelID, info.providerID, {});

			expect(limit.limit).toBe(128000);
			expect(limit.source).toBe('provider_cap');
		});

		test('Typical Anthropic workflow', () => {
			const messages = [
				makeMessage('user', undefined, undefined),
				makeMessage('assistant', 'claude-sonnet-4-6-20260301', 'anthropic'),
			];

			const info = extractModelInfo(messages);
			const limit = resolveModelLimit(info.modelID, info.providerID, {});

			expect(limit.limit).toBe(200000);
			expect(limit.source).toBe('native');
		});

		test('Custom override workflow', () => {
			const messages = [
				makeMessage('user', undefined, undefined),
				makeMessage('assistant', 'gpt-5', 'copilot'),
			];

			const config = {
				'copilot/gpt-5': 200000,
				default: 64000,
			};

			const info = extractModelInfo(messages);
			const limit = resolveModelLimit(info.modelID, info.providerID, config);

			expect(limit.limit).toBe(200000);
			expect(limit.source).toBe('override');
		});
	});
});
