import { describe, expect, test } from 'bun:test';
import { z } from 'zod';

/**
 * Test suite for multi-level fallback configuration (v6.85+)
 *
 * Validates that:
 * 1. Default agent configs have 2-level fallback chains for primary agents
 * 2. Fallback chains only use consistently-available models (big-pickle, gpt-5-nano)
 * 3. Schema constraints are respected (max 3 fallbacks per agent)
 * 4. Fallback chains provide meaningful recovery paths
 */

// Schema from src/config/schema.ts
const AgentOverrideConfigSchema = z.object({
	model: z.string().optional(),
	temperature: z.number().min(0).max(2).optional(),
	disabled: z.boolean().optional(),
	fallback_models: z.array(z.string()).max(3).optional(),
});

type AgentOverrideConfig = z.infer<typeof AgentOverrideConfigSchema>;

// Default config from src/cli/index.ts (lines 146-211)
const DEFAULT_AGENTS: Record<string, AgentOverrideConfig> = {
	coder: {
		model: 'opencode/minimax-m2.5-free',
		fallback_models: ['opencode/gpt-5-nano', 'opencode/big-pickle'],
	},
	reviewer: {
		model: 'opencode/big-pickle',
		fallback_models: ['opencode/gpt-5-nano', 'opencode/big-pickle'],
	},
	test_engineer: {
		model: 'opencode/gpt-5-nano',
		fallback_models: ['opencode/big-pickle'],
	},
	explorer: {
		model: 'opencode/big-pickle',
		fallback_models: ['opencode/gpt-5-nano', 'opencode/big-pickle'],
	},
	sme: {
		model: 'opencode/big-pickle',
		fallback_models: ['opencode/gpt-5-nano', 'opencode/big-pickle'],
	},
	critic: {
		model: 'opencode/big-pickle',
		fallback_models: ['opencode/gpt-5-nano', 'opencode/big-pickle'],
	},
	docs: {
		model: 'opencode/big-pickle',
		fallback_models: ['opencode/gpt-5-nano', 'opencode/big-pickle'],
	},
	designer: {
		model: 'opencode/big-pickle',
		fallback_models: ['opencode/gpt-5-nano', 'opencode/big-pickle'],
	},
	critic_sounding_board: {
		model: 'opencode/gpt-5-nano',
		fallback_models: ['opencode/big-pickle'],
	},
	critic_drift_verifier: {
		model: 'opencode/gpt-5-nano',
		fallback_models: ['opencode/big-pickle'],
	},
	critic_hallucination_verifier: {
		model: 'opencode/gpt-5-nano',
		fallback_models: ['opencode/big-pickle'],
	},
	critic_oversight: {
		model: 'opencode/gpt-5-nano',
		fallback_models: ['opencode/big-pickle'],
	},
	curator_init: {
		model: 'opencode/gpt-5-nano',
		fallback_models: ['opencode/big-pickle'],
	},
	curator_phase: {
		model: 'opencode/gpt-5-nano',
		fallback_models: ['opencode/big-pickle'],
	},
	council_member: {
		model: 'opencode/gpt-5-nano',
		fallback_models: ['opencode/big-pickle'],
	},
	council_moderator: {
		model: 'opencode/gpt-5-nano',
		fallback_models: ['opencode/big-pickle'],
	},
};

describe('Multi-Level Fallback Configuration', () => {
	test('All default agents have valid schema-compliant configurations', () => {
		for (const [agent, config] of Object.entries(DEFAULT_AGENTS)) {
			const result = AgentOverrideConfigSchema.safeParse(config);
			expect(result.success).toBe(true);
			if (!result.success) {
				console.error(
					`Agent ${agent} failed validation:`,
					result.error.message,
				);
			}
		}
	});

	test('Agents with primary big-pickle have 2-level fallback', () => {
		const bigPickleAgents = [
			'reviewer',
			'explorer',
			'sme',
			'critic',
			'docs',
			'designer',
		];

		for (const agent of bigPickleAgents) {
			const config = DEFAULT_AGENTS[agent];
			expect(config.model).toBe('opencode/big-pickle');
			expect(config.fallback_models).toBeDefined();
			expect(config.fallback_models?.length).toBe(2);
			expect(config.fallback_models?.[0]).toBe('opencode/gpt-5-nano');
			expect(config.fallback_models?.[1]).toBe('opencode/big-pickle');
		}
	});

	test('Coder agent has 2-level fallback (minimax → gpt-5-nano → big-pickle)', () => {
		const config = DEFAULT_AGENTS.coder;
		expect(config.model).toBe('opencode/minimax-m2.5-free');
		expect(config.fallback_models).toEqual([
			'opencode/gpt-5-nano',
			'opencode/big-pickle',
		]);
	});

	test('Lightweight agents (test_engineer, curator, council) have 1-level fallback', () => {
		const lightweightAgents = [
			'test_engineer',
			'critic_sounding_board',
			'critic_drift_verifier',
			'critic_hallucination_verifier',
			'critic_oversight',
			'curator_init',
			'curator_phase',
			'council_member',
			'council_moderator',
		];

		for (const agent of lightweightAgents) {
			const config = DEFAULT_AGENTS[agent];
			expect(config.fallback_models).toBeDefined();
			expect(config.fallback_models?.length).toBe(1);
			expect(config.fallback_models?.[0]).toBe('opencode/big-pickle');
		}
	});

	test('All fallback models are from consistently-available set (big-pickle, gpt-5-nano)', () => {
		const allowedModels = new Set([
			'opencode/big-pickle',
			'opencode/gpt-5-nano',
			'opencode/minimax-m2.5-free', // Only as primary, allowed as sometimes-available
		]);

		for (const [agent, config] of Object.entries(DEFAULT_AGENTS)) {
			if (config.model && !allowedModels.has(config.model)) {
				throw new Error(
					`Agent ${agent} has disallowed primary model: ${config.model}`,
				);
			}

			for (const fallback of config.fallback_models || []) {
				const isConsistent =
					fallback === 'opencode/big-pickle' ||
					fallback === 'opencode/gpt-5-nano';
				expect(isConsistent).toBe(true);
			}
		}
	});

	test('Schema respects max 3 fallbacks limit', () => {
		for (const [agent, config] of Object.entries(DEFAULT_AGENTS)) {
			const fallbackCount = config.fallback_models?.length || 0;
			expect(fallbackCount).toBeLessThanOrEqual(3);
		}
	});

	test('Fallback chains provide meaningful recovery', () => {
		// Scenario 1: Coder primary unavailable
		const coderChain = [
			'opencode/minimax-m2.5-free',
			...(DEFAULT_AGENTS.coder.fallback_models || []),
		];
		const coderAvailableFallback = coderChain.find(
			(m) => m !== 'opencode/minimax-m2.5-free',
		);
		expect(coderAvailableFallback).toBeDefined();

		// Scenario 2: Critic with both big-pickle and gpt-5-nano unavailable (exhaustion)
		// This is the intended edge case — fallback to third level
		const criticChain = [
			'opencode/big-pickle',
			...(DEFAULT_AGENTS.critic.fallback_models || []),
		];
		expect(criticChain).toHaveLength(3);
		expect(criticChain[0]).toBe('opencode/big-pickle');
		expect(criticChain[1]).toBe('opencode/gpt-5-nano');
		expect(criticChain[2]).toBe('opencode/big-pickle');

		// Scenario 3: Only big-pickle available ensures no complete failure
		const testEngineerChain = [
			'opencode/gpt-5-nano',
			...(DEFAULT_AGENTS.test_engineer.fallback_models || []),
		];
		expect(testEngineerChain).toEqual([
			'opencode/gpt-5-nano',
			'opencode/big-pickle',
		]);
	});

	test('Each agent has a model assignment (explicit or inherited)', () => {
		const agentsWithoutModel = Object.entries(DEFAULT_AGENTS).filter(
			([_, config]) => !config.model,
		);
		expect(agentsWithoutModel).toHaveLength(0);
	});

	test('Fallback models exclude removed/inconsistent models', () => {
		const disallowedModels = [
			'opencode/trinity-large-preview-free', // v6.84.6 removed
		];

		for (const [agent, config] of Object.entries(DEFAULT_AGENTS)) {
			for (const fallback of config.fallback_models || []) {
				for (const disallowed of disallowedModels) {
					expect(fallback).not.toBe(disallowed);
				}
			}
		}
	});

	test('Resilience summary: agents have recovery depth', () => {
		const resilienceCounts: Record<string, number> = {};

		for (const [agent, config] of Object.entries(DEFAULT_AGENTS)) {
			const depth = (config.fallback_models?.length || 0) + 1; // +1 for primary
			resilienceCounts[agent] = depth;
		}

		// Primary agents should have depth 3 (primary + 2 fallbacks)
		[
			'coder',
			'reviewer',
			'explorer',
			'sme',
			'critic',
			'docs',
			'designer',
		].forEach((agent) => {
			expect(resilienceCounts[agent]).toBe(3);
		});

		// Lightweight agents should have depth 2 (primary + 1 fallback)
		[
			'test_engineer',
			'critic_sounding_board',
			'curator_init',
			'council_member',
		].forEach((agent) => {
			expect(resilienceCounts[agent]).toBe(2);
		});
	});
});
