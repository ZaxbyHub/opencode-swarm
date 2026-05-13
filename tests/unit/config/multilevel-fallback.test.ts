import { describe, expect, test } from 'bun:test';
import {
	DEFAULT_AGENT_CONFIGS,
	DEFAULT_MODELS,
} from '../../../src/config/constants';
import { AgentOverrideConfigSchema } from '../../../src/config/schema';

const PUBLIC_FREE_ZEN_MODELS = new Set([
	'opencode/big-pickle',
	'opencode/minimax-m2.5-free',
]);

const REMOVED_OR_PAID_STARTER_MODELS = [
	'opencode/trinity-large-preview-free',
	'opencode/gpt-5-nano',
];

describe('starter model configuration', () => {
	test('all default agent configs are schema-compliant', () => {
		for (const [agent, config] of Object.entries(DEFAULT_AGENT_CONFIGS)) {
			const result = AgentOverrideConfigSchema.safeParse(config);
			expect(result.success, `${agent} should validate`).toBe(true);
		}
	});

	test('starter configs only use public free Zen models', () => {
		for (const [agent, config] of Object.entries(DEFAULT_AGENT_CONFIGS)) {
			expect(
				PUBLIC_FREE_ZEN_MODELS.has(config.model),
				`${agent} primary model ${config.model} should be starter-safe`,
			).toBe(true);

			for (const fallback of config.fallback_models) {
				expect(
					PUBLIC_FREE_ZEN_MODELS.has(fallback),
					`${agent} fallback model ${fallback} should be starter-safe`,
				).toBe(true);
			}
		}
	});

	test('default model map excludes removed or paid starter traps', () => {
		const allModels = Object.entries(DEFAULT_MODELS).filter(
			([name]) => name !== 'default',
		);

		for (const [agent, model] of allModels) {
			for (const disallowed of REMOVED_OR_PAID_STARTER_MODELS) {
				expect(model, `${agent} should not default to ${disallowed}`).not.toBe(
					disallowed,
				);
			}
		}
	});

	test('fallback chains provide a different recovery model without cycles', () => {
		for (const [agent, config] of Object.entries(DEFAULT_AGENT_CONFIGS)) {
			expect(config.fallback_models.length, `${agent} fallback depth`).toBe(1);
			expect(config.fallback_models[0]).not.toBe(config.model);
		}
	});

	test('coder and test_engineer use different starter primaries', () => {
		expect(DEFAULT_AGENT_CONFIGS.coder.model).toBe(
			'opencode/minimax-m2.5-free',
		);
		expect(DEFAULT_AGENT_CONFIGS.test_engineer.model).toBe(
			'opencode/big-pickle',
		);
		expect(DEFAULT_AGENT_CONFIGS.coder.model).not.toBe(
			DEFAULT_AGENT_CONFIGS.test_engineer.model,
		);
	});
});
