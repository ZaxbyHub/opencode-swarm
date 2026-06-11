import { describe, expect, it } from 'bun:test';
import {
	createAgents,
	extractSwarmIdFromAgentName,
	getSwarmAgents,
} from '../../../src/agents';
import type { PluginConfig } from '../../../src/config';

describe('multi-swarm fallback model resolution', () => {
	describe('extractSwarmIdFromAgentName', () => {
		it('extracts swarm ID from prefixed agent name', () => {
			expect(extractSwarmIdFromAgentName('local_coder')).toBe('local');
			expect(extractSwarmIdFromAgentName('fast_architect')).toBe('fast');
			expect(extractSwarmIdFromAgentName('precise_reviewer')).toBe('precise');
		});

		it('returns undefined for unprefixed agent name', () => {
			expect(extractSwarmIdFromAgentName('coder')).toBeUndefined();
			expect(extractSwarmIdFromAgentName('architect')).toBeUndefined();
		});

		it('handles edge cases', () => {
			expect(extractSwarmIdFromAgentName('')).toBeUndefined();
			expect(extractSwarmIdFromAgentName('_coder')).toBe('');
			expect(extractSwarmIdFromAgentName('a_b_c')).toBe('a');
		});
	});

	describe('getSwarmAgents with multi-swarm config', () => {
		it('stores and retrieves config for each swarm separately', () => {
			const config: PluginConfig = {
				swarms: {
					fast: {
						name: 'Fast',
						agents: {
							coder: {
								model: 'fast/model',
								fallback_models: ['fast/fallback1', 'fast/fallback2'],
							},
						},
					},
					precise: {
						name: 'Precise',
						agents: {
							coder: {
								model: 'precise/model',
								fallback_models: ['precise/fallback1', 'precise/fallback2'],
							},
						},
					},
				},
			};

			// Create agents to populate the swarmAgentsMap
			createAgents(config);

			// Verify each swarm's config is stored correctly
			const fastAgents = getSwarmAgents('fast');
			expect(fastAgents).toBeDefined();
			expect(fastAgents?.coder?.model).toBe('fast/model');
			expect(fastAgents?.coder?.fallback_models).toEqual([
				'fast/fallback1',
				'fast/fallback2',
			]);

			const preciseAgents = getSwarmAgents('precise');
			expect(preciseAgents).toBeDefined();
			expect(preciseAgents?.coder?.model).toBe('precise/model');
			expect(preciseAgents?.coder?.fallback_models).toEqual([
				'precise/fallback1',
				'precise/fallback2',
			]);

			// Verify default swarm (should be empty for this config)
			const defaultAgents = getSwarmAgents('default');
			expect(defaultAgents).toBeDefined();
			expect(defaultAgents).toEqual({});

			// Verify getSwarmAgents with no argument defaults to 'default'
			const defaultAgents2 = getSwarmAgents();
			expect(defaultAgents2).toBeDefined();
			expect(defaultAgents2).toEqual(defaultAgents);
		});

		it('handles legacy single-swarm mode (top-level agents config)', () => {
			const config: PluginConfig = {
				agents: {
					coder: {
						model: 'legacy/model',
						fallback_models: ['legacy/fallback'],
					},
				},
			};

			// Create agents without swarms config (legacy mode)
			createAgents(config);

			// Verify default swarm has the config
			const defaultAgents = getSwarmAgents('default');
			expect(defaultAgents).toBeDefined();
			expect(defaultAgents?.coder?.model).toBe('legacy/model');
			expect(defaultAgents?.coder?.fallback_models).toEqual(['legacy/fallback']);

			// Verify getSwarmAgents with no argument works
			const defaultAgents2 = getSwarmAgents();
			expect(defaultAgents2).toEqual(defaultAgents);
		});

		it('handles multi-swarm with explicit default swarm and top-level merge', () => {
			const config: PluginConfig = {
				agents: {
					coder: {
						model: 'toplevel/model',
					},
				},
				swarms: {
					default: {
						name: 'Default',
						agents: {
							coder: {
								model: 'default/model',
								fallback_models: ['default/fallback'],
							},
						},
					},
					local: {
						name: 'Local',
						agents: {
							coder: {
								model: 'local/model',
								fallback_models: ['local/fallback'],
							},
						},
					},
				},
			};

			createAgents(config);

			// Verify default swarm uses swarm-specific model (swarm model wins over top-level)
			const defaultAgents = getSwarmAgents('default');
			expect(defaultAgents?.coder?.model).toBe('default/model');
			expect(defaultAgents?.coder?.fallback_models).toEqual(['default/fallback']);

			// Verify local swarm
			const localAgents = getSwarmAgents('local');
			expect(localAgents?.coder?.model).toBe('local/model');
			expect(localAgents?.coder?.fallback_models).toEqual(['local/fallback']);
		});

		it('returns undefined for non-existent swarms', () => {
			const config: PluginConfig = {
				swarms: {
					fast: {
						name: 'Fast',
						agents: {
							coder: { model: 'fast/model' },
						},
					},
				},
			};

			createAgents(config);

			// Verify non-existent swarm returns undefined
			expect(getSwarmAgents('nonexistent')).toBeUndefined();
		});
	});
});
