import { describe, expect, test } from 'bun:test';
import { resolveFallbackModel } from '../../../src/agents/index';

describe('resolveFallbackModel - curator fallback inheritance', () => {
	test('curator_init inherits fallback_models from explorer when not explicitly set', () => {
		const swarmAgents = {
			explorer: {
				model: 'opencode/big-pickle',
				fallback_models: ['opencode/gpt-5-nano', 'opencode/gpt-5-turbo'],
			},
			curator_init: {
				model: 'opencode/big-pickle',
				// No fallback_models explicitly set
			},
		};

		// First fallback should come from explorer
		const fallback1 = resolveFallbackModel('curator_init', 1, swarmAgents);
		expect(fallback1).toBe('opencode/gpt-5-nano');

		// Second fallback should also come from explorer
		const fallback2 = resolveFallbackModel('curator_init', 2, swarmAgents);
		expect(fallback2).toBe('opencode/gpt-5-turbo');

		// Third fallback doesn't exist
		const fallback3 = resolveFallbackModel('curator_init', 3, swarmAgents);
		expect(fallback3).toBeNull();
	});

	test('curator_consolidation inherits fallback_models from explorer when not explicitly set (#1927)', () => {
		// curator_consolidation's model already defaults to explorer's in
		// createSwarmAgents, so it must inherit explorer's fallback chain too —
		// otherwise the opt-in memory-consolidation dispatch fails over to nothing.
		const swarmAgents = {
			explorer: {
				model: 'opencode/big-pickle',
				fallback_models: ['consol-fb-1', 'consol-fb-2'],
			},
			curator_consolidation: {
				model: 'opencode/big-pickle',
				// No fallback_models explicitly set
			},
		};

		expect(resolveFallbackModel('curator_consolidation', 1, swarmAgents)).toBe(
			'consol-fb-1',
		);
		expect(resolveFallbackModel('curator_consolidation', 2, swarmAgents)).toBe(
			'consol-fb-2',
		);
		expect(
			resolveFallbackModel('curator_consolidation', 3, swarmAgents),
		).toBeNull();
	});

	test('curator_consolidation uses explicit fallback_models when set, ignoring explorer (#1927)', () => {
		const swarmAgents = {
			explorer: {
				model: 'opencode/big-pickle',
				fallback_models: ['explorer-fallback-1'],
			},
			curator_consolidation: {
				model: 'custom-model',
				fallback_models: ['consol-explicit'],
			},
		};

		expect(resolveFallbackModel('curator_consolidation', 1, swarmAgents)).toBe(
			'consol-explicit',
		);
	});

	test('curator_phase inherits fallback_models from explorer when not explicitly set', () => {
		const swarmAgents = {
			explorer: {
				model: 'opencode/big-pickle',
				fallback_models: ['model-a', 'model-b', 'model-c'],
			},
			curator_phase: {
				model: 'opencode/big-pickle',
				// No fallback_models explicitly set
			},
		};

		expect(resolveFallbackModel('curator_phase', 1, swarmAgents)).toBe(
			'model-a',
		);
		expect(resolveFallbackModel('curator_phase', 2, swarmAgents)).toBe(
			'model-b',
		);
		expect(resolveFallbackModel('curator_phase', 3, swarmAgents)).toBe(
			'model-c',
		);
	});

	test('curator_init uses explicit fallback_models when set, ignoring explorer', () => {
		const swarmAgents = {
			explorer: {
				model: 'opencode/big-pickle',
				fallback_models: ['explorer-fallback-1', 'explorer-fallback-2'],
			},
			curator_init: {
				model: 'custom-model',
				fallback_models: ['curator-specific-1', 'curator-specific-2'],
			},
		};

		// Should use curator_init's explicit fallback_models, not explorer's
		expect(resolveFallbackModel('curator_init', 1, swarmAgents)).toBe(
			'curator-specific-1',
		);
		expect(resolveFallbackModel('curator_init', 2, swarmAgents)).toBe(
			'curator-specific-2',
		);
	});

	test('curator_phase uses explicit fallback_models when set, ignoring explorer', () => {
		const swarmAgents = {
			explorer: {
				model: 'opencode/big-pickle',
				fallback_models: ['explorer-fallback-1'],
			},
			curator_phase: {
				model: 'custom-model',
				fallback_models: ['curator-explicit'],
			},
		};

		expect(resolveFallbackModel('curator_phase', 1, swarmAgents)).toBe(
			'curator-explicit',
		);
	});

	test('curator_init returns null when neither curator nor explorer have fallback_models', () => {
		const swarmAgents = {
			explorer: {
				model: 'opencode/big-pickle',
				// No fallback_models
			},
			curator_init: {
				model: 'opencode/big-pickle',
				// No fallback_models
			},
		};

		expect(resolveFallbackModel('curator_init', 1, swarmAgents)).toBeNull();
	});

	test('curator_init returns null when explorer has empty fallback_models array', () => {
		const swarmAgents = {
			explorer: {
				model: 'opencode/big-pickle',
				fallback_models: [],
			},
			curator_init: {
				model: 'opencode/big-pickle',
				// No fallback_models
			},
		};

		expect(resolveFallbackModel('curator_init', 1, swarmAgents)).toBeNull();
	});

	test('other agents do not inherit from explorer', () => {
		const swarmAgents = {
			explorer: {
				model: 'opencode/big-pickle',
				fallback_models: ['explorer-fallback-1', 'explorer-fallback-2'],
			},
			coder: {
				model: 'coder-model',
				// No fallback_models
			},
		};

		// coder should NOT inherit from explorer
		expect(resolveFallbackModel('coder', 1, swarmAgents)).toBeNull();
	});

	test('handles missing explorer config gracefully', () => {
		const swarmAgents = {
			curator_init: {
				model: 'opencode/big-pickle',
				// No fallback_models
			},
			// No explorer config
		};

		expect(resolveFallbackModel('curator_init', 1, swarmAgents)).toBeNull();
	});

	test('respects fallback index boundary for curator agents', () => {
		const swarmAgents = {
			explorer: {
				model: 'opencode/big-pickle',
				fallback_models: ['model-1', 'model-2'],
			},
			curator_init: {
				model: 'opencode/big-pickle',
			},
		};

		// Index 0 is invalid
		expect(resolveFallbackModel('curator_init', 0, swarmAgents)).toBeNull();

		// Index -1 is invalid
		expect(resolveFallbackModel('curator_init', -1, swarmAgents)).toBeNull();

		// Index > array length is invalid
		expect(resolveFallbackModel('curator_init', 3, swarmAgents)).toBeNull();
	});

	test('curator agents with empty explicit fallback_models do not fall back to explorer', () => {
		const swarmAgents = {
			explorer: {
				model: 'opencode/big-pickle',
				fallback_models: ['explorer-fallback-1'],
			},
			curator_init: {
				model: 'opencode/big-pickle',
				fallback_models: [], // Explicitly empty
			},
		};

		// Should NOT fall back to explorer since curator_init has explicit (empty) config
		expect(resolveFallbackModel('curator_init', 1, swarmAgents)).toBeNull();
	});
});
