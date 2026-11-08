import { describe, expect, it } from 'bun:test';
import {
	createAgents,
	getAgentConfigs,
	getSwarmAgents,
} from '../../../src/agents';
import type { PluginConfig } from '../../../src/config';
import {
	deriveSwarmIdentity,
	stripKnownSwarmPrefix,
} from '../../../src/config/schema';

describe('multi-swarm fallback model resolution', () => {
	describe('deriveSwarmIdentity (retires the naive first-underscore helper)', () => {
		it('derives the swarm ID from prefixed agent names (#3330)', () => {
			expect(deriveSwarmIdentity('local_coder')).toEqual({
				role: 'coder',
				swarmID: 'local',
			});
			expect(deriveSwarmIdentity('fast_architect')).toEqual({
				role: 'architect',
				swarmID: 'fast',
			});
			expect(deriveSwarmIdentity('precise_reviewer')).toEqual({
				role: 'reviewer',
				swarmID: 'precise',
			});
		});

		it('resolves the default swarm for unprefixed agent names', () => {
			expect(deriveSwarmIdentity('coder').swarmID).toBeUndefined();
			expect(deriveSwarmIdentity('architect').swarmID).toBeUndefined();
		});

		it('handles edge cases with the guarded #3324 semantics', () => {
			expect(deriveSwarmIdentity('').role).toBe('');
			expect(deriveSwarmIdentity('_coder').swarmID).toBeUndefined();
			// Case-carrying swarm ids keep their raw case.
			expect(deriveSwarmIdentity('Case_coder').swarmID).toBe('Case');
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

			// Negative assertion: swarms must not share the same config object
			expect(fastAgents).not.toBe(preciseAgents);
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
			expect(defaultAgents?.coder?.fallback_models).toEqual([
				'legacy/fallback',
			]);

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
			expect(defaultAgents?.coder?.fallback_models).toEqual([
				'default/fallback',
			]);

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

	// Issue #2960: the following tests are LOOKUP-SEMANTICS PINS — the Task
	// route resolver (resolveTaskRouteModelChain in src/index.ts) is an
	// unexported closure, so these pin the lookup facts its length-delta
	// derivation relies on. They pass on the pre-fix tree; the discriminating
	// regression net for the derivation itself is the boundary-level test in
	// tests/unit/index-task-model-routing-underscore-agents.test.ts plus the
	// frozen trace checks C1-C3.
	describe('underscore-named agent resolution (issue #2960)', () => {
		it('resolves default-swarm fallback_models for underscore-named agents', () => {
			const config: PluginConfig = {
				agents: {
					test_engineer: {
						model: 'prov/primary',
						fallback_models: ['prov/fallback'],
					},
				},
			};

			createAgents(config);

			// The length-delta derivation yields swarm id undefined for an
			// exact roster name; getSwarmAgents(undefined) resolves 'default'.
			expect(stripKnownSwarmPrefix('test_engineer')).toBe('test_engineer');
			expect(getSwarmAgents(undefined)?.test_engineer?.fallback_models).toEqual(
				['prov/fallback'],
			);
		});

		it('resolves prefixed underscore agents in multi-swarm configs', () => {
			const config: PluginConfig = {
				swarms: {
					local: {
						name: 'Local',
						agents: {
							test_engineer: {
								model: 'prov/x',
								fallback_models: ['prov/xb'],
							},
						},
					},
					mega: {
						name: 'Mega',
						agents: {},
					},
				},
			};

			createAgents(config);

			// The length-delta swarm-id derivation the resolver uses. The
			// `_<role>` suffix test is required (not redundant): the role
			// extractor is case-insensitive and also accepts `-`/` `, so a bare
			// `role !== name` guard slices a garbage id from an unprefixed name.
			// Boundary-level regression coverage for that lives in
			// tests/unit/index-task-model-routing-underscore-agents.test.ts
			// (the resolver is an unexported closure and cannot be reached
			// from a unit test — these are lookup-semantics pins only).
			const role = stripKnownSwarmPrefix('local_test_engineer');
			expect(role).toBe('test_engineer');
			const swarmId =
				role !== 'local_test_engineer' &&
				'local_test_engineer'.toLowerCase().endsWith(`_${role}`)
					? 'local_test_engineer'.slice(
							0,
							'local_test_engineer'.length - role.length - 1,
						)
					: undefined;
			expect(swarmId).toBe('local');
			expect(getSwarmAgents(swarmId)?.test_engineer?.fallback_models).toEqual([
				'prov/xb',
			]);
		});

		it('derives the default swarm for every name with no real prefix suffix', () => {
			// Derivation pin for the resolver guard. The role extractor is
			// case-insensitive and also accepts `-` / ` ` separators, so a bare
			// `role !== name` test slices a garbage swarm id from an
			// UNPREFIXED name. Only a real `<swarmId>_<role>` suffix may be
			// sliced, and the sliced id must itself be schema-valid (a swarm id
			// may not contain `_`), so a malformed doubled separator falls to
			// the default swarm instead of naming a swarm that cannot exist.
			// Boundary-level regression coverage for the case-variant class
			// lives in tests/unit/index-task-model-routing-underscore-agents.test.ts.
			const derive = (name: string): string | undefined => {
				const role = stripKnownSwarmPrefix(name);
				const sliced =
					role !== name && name.toLowerCase().endsWith(`_${role}`)
						? name.slice(0, name.length - role.length - 1)
						: undefined;
				return sliced && !sliced.includes('_') ? sliced : undefined;
			};
			// No real prefix -> default swarm. This is the #2960 fix for the
			// underscore seeded roles AND preservation for every other form.
			expect(derive('test_engineer')).toBeUndefined();
			expect(derive('Coder')).toBeUndefined();
			expect(derive('CODER')).toBeUndefined();
			expect(derive('code-coder')).toBeUndefined();
			expect(derive('chief coder')).toBeUndefined();
			expect(derive('Test_Engineer')).toBeUndefined();
			// A malformed doubled separator must not yield an unregistrable id.
			expect(derive('local__coder')).toBeUndefined();
			// A real prefix IS sliced, preserving the raw swarm-id casing.
			expect(derive('local_test_engineer')).toBe('local');
			expect(derive('Case_coder')).toBe('Case');
		});

		it('treats an unprefixed underscore name as the default swarm even when its first token collides with a swarm id', () => {
			const config: PluginConfig = {
				swarms: {
					test: {
						name: 'Test',
						agents: {
							test_engineer: {
								model: 'prov/x',
								fallback_models: ['prov/xb'],
							},
						},
					},
				},
			};

			createAgents(config);

			// Designed semantics (issue #2960): an unprefixed canonical name
			// resolves via the 'default' swarm. The pre-fix naive first-
			// underscore split accidentally hit swarm 'test' here; the
			// length-delta derivation deliberately does not. The 'test'
			// swarm's entry stays reachable via its prefixed name form.
			expect(getSwarmAgents(undefined)?.test_engineer).toBeUndefined();
			expect(getSwarmAgents('test')?.test_engineer?.fallback_models).toEqual([
				'prov/xb',
			]);
		});

		it('keeps underscore agent names primary in both name forms (AGENTS.md invariant 11)', () => {
			const multiSwarm: PluginConfig = {
				swarms: {
					local: {
						name: 'Local Swarm',
						agents: {
							test_engineer: {
								model: 'prov/x',
								fallback_models: ['prov/xb'],
							},
						},
					},
					mega: {
						name: 'Mega Swarm',
						agents: {},
					},
				},
			};
			const multiSwarmConfigs = getAgentConfigs(multiSwarm);
			const prefixedPrimaries = Object.entries(multiSwarmConfigs).filter(
				([name, cfg]) => name.startsWith('local_') && cfg.mode === 'primary',
			);
			// At least one prefixed agent must be primary in a multi-swarm
			// config (the v7.3.x regression class: strict default_agent
			// equality demoting every *_architect to subagent).
			expect(prefixedPrimaries.length).toBeGreaterThan(0);
			expect(multiSwarmConfigs.local_architect?.mode).toBe('primary');
			expect(multiSwarmConfigs.local_test_engineer?.mode).toBe('subagent');

			const legacy: PluginConfig = {
				default_agent: 'test_engineer',
				agents: {
					test_engineer: {
						model: 'prov/primary',
						fallback_models: ['prov/fallback'],
					},
				},
			};
			const legacyConfigs = getAgentConfigs(legacy);
			// Legacy unprefixed form: an exact default_agent match stays primary.
			expect(legacyConfigs.test_engineer?.mode).toBe('primary');
		});
	});
});
