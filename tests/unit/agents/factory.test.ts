import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createAgents, getAgentConfigs } from '../../../src/agents';
import type { PluginConfig } from '../../../src/config';

let originalXDG: string | undefined;
let tempDir: string | undefined;

beforeEach(() => {
	originalXDG = process.env.XDG_CONFIG_HOME;
	tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-test-'));
	process.env.XDG_CONFIG_HOME = tempDir;
});

afterEach(() => {
	if (originalXDG === undefined) delete process.env.XDG_CONFIG_HOME;
	else process.env.XDG_CONFIG_HOME = originalXDG;
	if (tempDir) {
		fs.rmSync(tempDir, { recursive: true, force: true });
		tempDir = undefined;
	}
});

describe('createAgents', () => {
	describe('no config', () => {
		it('returns 17 agents (docs enabled by default, designer opt-in)', () => {
			const agents = createAgents();
			expect(agents).toHaveLength(17);
		});

		it('agent names are correct', () => {
			const agents = createAgents();
			const names = agents.map((a) => a.name).sort();
			expect(names).toEqual([
				'architect',
				'coder',
				'critic',
				'critic_architecture_supervisor',
				'critic_drift_verifier',
				'critic_hallucination_verifier',
				'critic_oversight',
				'critic_sounding_board',
				'curator_init',
				'curator_phase',
				'docs',
				'explorer',
				'reviewer',
				'skill_improver',
				'sme',
				'spec_writer',
				'test_engineer',
				// Note: designer is opt-in (ui_review.enabled=true), not included by default
			]);
		});

		it('each agent has temperature, prompt, description', () => {
			const agents = createAgents();

			for (const agent of agents) {
				expect(agent).toHaveProperty('name');
				expect(agent).toHaveProperty('config');
				expect(agent.config).toHaveProperty('temperature');
				expect(agent.config).toHaveProperty('prompt');
				expect(agent).toHaveProperty('description');

				// Verify properties are not empty
				expect(agent.name.length).toBeGreaterThan(0);
				expect(typeof agent.config.temperature).toBe('number');
				expect(agent.config.temperature).toBeGreaterThanOrEqual(0);
				expect(agent.config.temperature).toBeLessThanOrEqual(2);
				expect(agent.config.prompt?.length ?? 0).toBeGreaterThan(0);
				expect(agent.description?.length ?? 0).toBeGreaterThan(0);
			}
		});

		it('each subagent has model (primary agents created with model but getAgentConfigs strips it)', () => {
			const agents = createAgents();

			for (const agent of agents) {
				// All agents initially have model in their config
				expect(agent.config).toHaveProperty('model');
				expect(agent.config.model?.length ?? 0).toBeGreaterThan(0);
			}
		});
	});

	describe('with agent overrides', () => {
		it('model override applies correctly', () => {
			const config = {
				agents: {
					coder: {
						model: 'custom/model',
					},
				},
			};

			const agents = createAgents(config as unknown as PluginConfig);
			const coder = agents.find((a) => a.name === 'coder');
			expect(coder?.config.model).toBe('custom/model');
		});

		it('temperature override applies correctly', () => {
			const config = {
				agents: {
					coder: {
						temperature: 0.5,
					},
				},
			};

			const agents = createAgents(config as unknown as PluginConfig);
			const coder = agents.find((a) => a.name === 'coder');
			expect(coder?.config.temperature).toBe(0.5);
		});

		it('variant override applies correctly', () => {
			const config = {
				agents: {
					test_engineer: {
						model: 'grove-openai/gpt-5.3-codex',
						variant: 'medium',
					},
				},
			};

			const agents = createAgents(config as unknown as PluginConfig);
			const te = agents.find((a) => a.name === 'test_engineer');
			expect(te?.config.model).toBe('grove-openai/gpt-5.3-codex');
			expect((te?.config as { variant?: string } | undefined)?.variant).toBe(
				'medium',
			);
		});

		it('variant is omitted when not configured', () => {
			const config = {
				agents: {
					coder: { model: 'custom/model' },
				},
			};

			const agents = createAgents(config as unknown as PluginConfig);
			const coder = agents.find((a) => a.name === 'coder');
			expect(
				(coder?.config as { variant?: string } | undefined)?.variant,
			).toBeUndefined();
		});

		it('auto-splits variant from 3-segment model string', () => {
			const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
			const config = {
				quiet: false,
				agents: {
					coder: {
						model: 'grove-openai/gpt-5.3-codex/medium',
					},
				},
			};

			const agents = createAgents(config as unknown as PluginConfig);
			const coder = agents.find((a) => a.name === 'coder');
			expect(coder?.config.model).toBe('grove-openai/gpt-5.3-codex');
			expect((coder?.config as { variant?: string } | undefined)?.variant).toBe(
				'medium',
			);
			expect(warnSpy).toHaveBeenCalled();
			warnSpy.mockRestore();
		});

		it('explicit variant override takes precedence over auto-split', () => {
			const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
			const config = {
				quiet: false,
				agents: {
					coder: {
						model: 'grove-openai/gpt-5.3-codex/medium',
						variant: 'high',
					},
				},
			};

			const agents = createAgents(config as unknown as PluginConfig);
			const coder = agents.find((a) => a.name === 'coder');
			expect(coder?.config.model).toBe('grove-openai/gpt-5.3-codex');
			expect((coder?.config as { variant?: string } | undefined)?.variant).toBe(
				'high',
			);
			expect(warnSpy).toHaveBeenCalled();
			warnSpy.mockRestore();
		});

		it('does not modify 2-segment model string', () => {
			const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
			const config = {
				agents: {
					coder: { model: 'custom/model' },
				},
			};

			const agents = createAgents(config as unknown as PluginConfig);
			const coder = agents.find((a) => a.name === 'coder');
			expect(coder?.config.model).toBe('custom/model');
			expect(
				(coder?.config as { variant?: string } | undefined)?.variant,
			).toBeUndefined();
			expect(warnSpy).not.toHaveBeenCalled();
			warnSpy.mockRestore();
		});

		it('preserves 3-segment lmstudio model ID intact (regression: bug where last segment was stripped as variant)', () => {
			const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
			const config = {
				agents: {
					reviewer: { model: 'lmstudio/qwen/qwen3.6-35b-a3b' },
				},
			};

			const agents = createAgents(config as unknown as PluginConfig);
			const reviewer = agents.find((a) => a.name === 'reviewer');
			// The full 3-segment path must be preserved — the last segment is a
			// model name component, not a reasoning-effort variant token.
			expect(reviewer?.config.model).toBe('lmstudio/qwen/qwen3.6-35b-a3b');
			expect(
				(reviewer?.config as { variant?: string } | undefined)?.variant,
			).toBeUndefined();
			expect(warnSpy).not.toHaveBeenCalled();
			warnSpy.mockRestore();
		});

		it('preserves 3-segment lmstudio model ID intact for multiple agents', () => {
			const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
			const config = {
				agents: {
					coder: { model: 'lmstudio/qwen/qwen3-coder-next' },
					reviewer: { model: 'lmstudio/qwen/qwen3.6-35b-a3b' },
					test_engineer: { model: 'lmstudio/qwen/qwen3.6-35b-a3b' },
					docs: { model: 'lmstudio/qwen/qwen3.6-35b-a3b' },
				},
			};

			const agents = createAgents(config as unknown as PluginConfig);

			const coder = agents.find((a) => a.name === 'coder');
			expect(coder?.config.model).toBe('lmstudio/qwen/qwen3-coder-next');
			expect(
				(coder?.config as { variant?: string } | undefined)?.variant,
			).toBeUndefined();

			const reviewer = agents.find((a) => a.name === 'reviewer');
			expect(reviewer?.config.model).toBe('lmstudio/qwen/qwen3.6-35b-a3b');
			expect(
				(reviewer?.config as { variant?: string } | undefined)?.variant,
			).toBeUndefined();

			const te = agents.find((a) => a.name === 'test_engineer');
			expect(te?.config.model).toBe('lmstudio/qwen/qwen3.6-35b-a3b');
			expect(
				(te?.config as { variant?: string } | undefined)?.variant,
			).toBeUndefined();

			expect(warnSpy).not.toHaveBeenCalled();
			warnSpy.mockRestore();
		});

		it('still auto-splits known variant tokens: low, medium, high, max, xhigh, thinking', () => {
			const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
			const variantCases: Array<[string, string, string]> = [
				['grove-openai/gpt-5.3-codex/low', 'grove-openai/gpt-5.3-codex', 'low'],
				[
					'grove-openai/gpt-5.3-codex/medium',
					'grove-openai/gpt-5.3-codex',
					'medium',
				],
				[
					'grove-openai/gpt-5.3-codex/high',
					'grove-openai/gpt-5.3-codex',
					'high',
				],
				['grove-openai/gpt-5.3-codex/max', 'grove-openai/gpt-5.3-codex', 'max'],
				[
					'grove-openai/gpt-5.3-codex/xhigh',
					'grove-openai/gpt-5.3-codex',
					'xhigh',
				],
				[
					'grove-openai/gpt-5.3-codex/thinking',
					'grove-openai/gpt-5.3-codex',
					'thinking',
				],
				[
					'gateway/ns/gpt-5.3-codex/medium',
					'gateway/ns/gpt-5.3-codex',
					'medium',
				],
			];

			for (const [fullModel, expectedModel, expectedVariant] of variantCases) {
				const config = {
					quiet: false,
					agents: { coder: { model: fullModel } },
				};
				const agents = createAgents(config as unknown as PluginConfig);
				const coder = agents.find((a) => a.name === 'coder');
				expect(coder?.config.model).toBe(expectedModel);
				expect(
					(coder?.config as { variant?: string } | undefined)?.variant,
				).toBe(expectedVariant);
			}
			expect(warnSpy).toHaveBeenCalled();
			warnSpy.mockRestore();
		});

		it('disabled agent is filtered out', () => {
			const config = {
				agents: {
					sme: {
						disabled: true,
					},
				},
			};

			const agents = createAgents(config as unknown as PluginConfig);
			const sme = agents.find((a) => a.name === 'sme');
			expect(sme).toBeUndefined();
			// 17 agents - 1 disabled = 16 agents (docs still included by default)
			expect(agents).toHaveLength(16);
		});

		it('reasoning override applies to agent config', () => {
			const config = {
				agents: {
					critic: {
						model: 'openai/gpt-5.3-codex',
						reasoning: { effort: 'high' },
					},
				},
			};

			const agents = createAgents(config as unknown as PluginConfig);
			const critic = agents.find((a) => a.name === 'critic');
			expect(
				(critic?.config as { reasoning?: { effort?: string } } | undefined)
					?.reasoning,
			).toEqual({ effort: 'high' });
		});

		it('thinking override applies to agent config', () => {
			const config = {
				agents: {
					reviewer: {
						model: 'anthropic/claude-sonnet-4-6',
						thinking: { type: 'enabled', budget_tokens: 10000 },
					},
				},
			};

			const agents = createAgents(config as unknown as PluginConfig);
			const reviewer = agents.find((a) => a.name === 'reviewer');
			expect(
				(
					reviewer?.config as {
						thinking?: { type?: string; budget_tokens?: number };
					}
				)?.thinking,
			).toEqual({ type: 'enabled', budget_tokens: 10000 });
		});

		it('reasoning and thinking are omitted when not configured', () => {
			const config = {
				agents: {
					coder: { model: 'some/model' },
				},
			};

			const agents = createAgents(config as unknown as PluginConfig);
			const coder = agents.find((a) => a.name === 'coder');
			expect(
				(coder?.config as { reasoning?: unknown })?.reasoning,
			).toBeUndefined();
			expect(
				(coder?.config as { thinking?: unknown })?.thinking,
			).toBeUndefined();
		});

		it('reasoning override applies in named swarm with prefix', () => {
			const config = {
				swarms: {
					paid: {
						agents: {
							critic: {
								model: 'openai/gpt-5.3-codex',
								reasoning: { effort: 'max' },
							},
						},
					},
				},
			};

			const agents = createAgents(config as unknown as PluginConfig);
			const critic = agents.find((a) => a.name === 'paid_critic');
			expect(
				(critic?.config as { reasoning?: { effort?: string } } | undefined)
					?.reasoning,
			).toEqual({ effort: 'max' });
		});
	});

	describe('with swarms', () => {
		it('single swarm named default has no prefix', () => {
			const config = {
				swarms: {
					default: {},
				},
			};

			const agents = createAgents(config as unknown as PluginConfig);
			const names = agents.map((a) => a.name).sort();
			expect(names).toEqual([
				'architect',
				'coder',
				'critic',
				'critic_architecture_supervisor',
				'critic_drift_verifier',
				'critic_hallucination_verifier',
				'critic_oversight',
				'critic_sounding_board',
				'curator_init',
				'curator_phase',
				'docs',
				'explorer',
				'reviewer',
				'skill_improver',
				'sme',
				'spec_writer',
				'test_engineer',
				// Note: designer is opt-in, not included by default
			]);
		});

		it('single named swarm adds prefix to all agents', () => {
			const config = {
				swarms: {
					local: {
						name: 'Local',
					},
				},
			};

			const agents = createAgents(config as unknown as PluginConfig);
			const names = agents.map((a) => a.name).sort();
			expect(names).toEqual([
				'local_architect',
				'local_coder',
				'local_critic',
				'local_critic_architecture_supervisor',
				'local_critic_drift_verifier',
				'local_critic_hallucination_verifier',
				'local_critic_oversight',
				'local_critic_sounding_board',
				'local_curator_init',
				'local_curator_phase',
				'local_docs',
				'local_explorer',
				'local_reviewer',
				'local_skill_improver',
				'local_sme',
				'local_spec_writer',
				'local_test_engineer',
				// Note: designer is opt-in, not included by default
			]);
		});

		it('architect prompt contains swarm header for non-default swarms', () => {
			const config = {
				swarms: {
					cloud: {
						name: 'Cloud',
					},
				},
			};

			const agents = createAgents(config as unknown as PluginConfig);
			const cloudArchitect = agents.find((a) => a.name === 'cloud_architect');
			expect(cloudArchitect?.description).toContain('[Cloud]');
			expect(cloudArchitect?.config.prompt).toContain(
				'## ⚠️ YOU ARE THE CLOUD SWARM ARCHITECT',
			);
			expect(cloudArchitect?.config.prompt).toContain('cloud_');
		});

		it('non-default swarm renders loaded skill agent targets to concrete prefixed names', () => {
			const config = {
				swarms: {
					cloud: {
						name: 'Cloud',
					},
				},
			};

			const agents = createAgents(config as unknown as PluginConfig);
			const cloudArchitect = agents.find((a) => a.name === 'cloud_architect');
			const prompt = cloudArchitect?.config.prompt ?? '';

			expect(prompt).toContain("the active swarm's coder agent = @cloud_coder");
			expect(prompt).toContain(
				"the active swarm's reviewer agent = @cloud_reviewer",
			);
			expect(prompt).toContain(
				"the active swarm's critic_drift_verifier agent = @cloud_critic_drift_verifier",
			);
			expect(prompt).not.toContain(
				"the active swarm's coder agent = @{{AGENT_PREFIX}}coder",
			);
		});

		it('merges top-level agents with default swarm agents config (swarm-specific takes precedence)', () => {
			// Regression test for issue: models configured for agents aren't respected when both
			// top-level agents and swarms are configured. The fix ensures that:
			// 1. Top-level agents are merged into the default swarm
			// 2. Swarm-specific agents take precedence over top-level agents
			const config = {
				agents: {
					coder: {
						model: 'top-level/model',
					},
					explorer: {
						model: 'top-level/explorer',
						temperature: 0.3,
					},
				},
				swarms: {
					default: {
						agents: {
							coder: {
								// This swarm-specific config overrides top-level
								model: 'swarm-specific/model',
								temperature: 0.8,
							},
						},
					},
				},
			};

			const agents = createAgents(config as unknown as PluginConfig);
			const coder = agents.find((a) => a.name === 'coder');
			const explorer = agents.find((a) => a.name === 'explorer');

			// Swarm-specific coder model takes precedence
			expect(coder?.config.model).toBe('swarm-specific/model');
			expect(coder?.config.temperature).toBe(0.8);

			// Top-level explorer is still respected
			expect(explorer?.config.model).toBe('top-level/explorer');
			expect(explorer?.config.temperature).toBe(0.3);
		});

		it('top-level agents are respected when swarms config exists with default swarm', () => {
			// Another regression test: users expect top-level agents to work even when
			// swarms are configured, as long as the default swarm exists
			const config = {
				agents: {
					coder: {
						model: 'custom/coder-model',
					},
					reviewer: {
						model: 'custom/reviewer-model',
						temperature: 0.5,
					},
				},
				swarms: {
					default: {
						name: 'Default',
						// No agents specified in the swarm itself
					},
				},
			};

			const agents = createAgents(config as unknown as PluginConfig);
			const coder = agents.find((a) => a.name === 'coder');
			const reviewer = agents.find((a) => a.name === 'reviewer');

			// Top-level agent configs should be respected
			expect(coder?.config.model).toBe('custom/coder-model');
			expect(reviewer?.config.model).toBe('custom/reviewer-model');
			expect(reviewer?.config.temperature).toBe(0.5);
		});

		it('merges top-level agents with non-default swarms (e.g., custom swarm names)', () => {
			// Regression test: users with non-default swarm names like "fast", "precise", "local"
			// should also get top-level agents merged. Previously, the merge only worked
			// for swarms named "default".
			const config = {
				agents: {
					coder: {
						model: 'top-level/coder',
						temperature: 0.3,
					},
					reviewer: {
						model: 'top-level/reviewer',
					},
				},
				swarms: {
					fast: {
						agents: {
							coder: {
								// Swarm-specific override for coder
								model: 'fast-swarm/coder',
							},
						},
					},
					precise: {
						// No agents specified - should inherit from top-level
						agents: undefined,
					},
				},
			};

			const agents = createAgents(config as unknown as PluginConfig);

			// For the "fast" swarm: coder should use fast-swarm override, reviewer from top-level
			const fastCoder = agents.find((a) => a.name === 'fast_coder');
			const fastReviewer = agents.find((a) => a.name === 'fast_reviewer');
			expect(fastCoder?.config.model).toBe('fast-swarm/coder');
			expect(fastReviewer?.config.model).toBe('top-level/reviewer');

			// For the "precise" swarm: both should use top-level configs
			const preciseCoder = agents.find((a) => a.name === 'precise_coder');
			const preciseReviewer = agents.find((a) => a.name === 'precise_reviewer');
			expect(preciseCoder?.config.model).toBe('top-level/coder');
			expect(preciseCoder?.config.temperature).toBe(0.3);
			expect(preciseReviewer?.config.model).toBe('top-level/reviewer');
		});
	});

	describe('architect template replacement', () => {
		it('default swarm replaces SWARM_ID with "default"', () => {
			const agents = createAgents();
			const architect = agents.find((a) => a.name === 'architect');
			expect(architect?.config.prompt).toContain('Swarm: default');
			expect(architect?.config.prompt).not.toContain('{{SWARM_ID}}');
		});

		it('default swarm replaces AGENT_PREFIX with empty string', () => {
			const agents = createAgents();
			const architect = agents.find((a) => a.name === 'architect');
			expect(architect?.config.prompt).not.toContain('{{AGENT_PREFIX}}');
		});

		it('default swarm replaces QA_RETRY_LIMIT with default value 3', () => {
			const agents = createAgents();
			const architect = agents.find((a) => a.name === 'architect');
			expect(architect?.config.prompt).toContain('3');
			expect(architect?.config.prompt).not.toContain('{{QA_RETRY_LIMIT}}');
		});

		it('custom qa_retry_limit replaces correctly', () => {
			const config = {
				qa_retry_limit: 5,
			};

			const agents = createAgents(config as unknown as PluginConfig);
			const architect = agents.find((a) => a.name === 'architect');
			expect(architect?.config.prompt).toContain('5');
			expect(architect?.config.prompt).not.toContain('{{QA_RETRY_LIMIT}}');
		});
	});
});

describe('getAgentConfigs', () => {
	it('returns Record<string, SDKAgentConfig>', () => {
		const configs = getAgentConfigs();
		expect(typeof configs).toBe('object');
		expect(configs).not.toBeNull();

		for (const [name, config] of Object.entries(configs)) {
			expect(typeof name).toBe('string');
			expect(name.length).toBeGreaterThan(0);
			expect(config).toHaveProperty('temperature');
			expect(config).toHaveProperty('prompt');
			expect(config).toHaveProperty('description');
			expect(config).toHaveProperty('mode');
		}
	});

	it('primary agents omit model (architect and *_architect)', () => {
		const configs = getAgentConfigs();

		// architect is a primary agent
		expect(configs.architect).not.toHaveProperty('model');

		// Verify other agents have model (they are subagents)
		for (const [name, config] of Object.entries(configs)) {
			if (name !== 'architect') {
				expect(config).toHaveProperty('model');
			}
		}
	});

	it('subagents retain model', () => {
		const configs = getAgentConfigs();

		for (const [name, config] of Object.entries(configs)) {
			if (config.mode === 'subagent') {
				expect(config).toHaveProperty('model');
				expect(config.model?.length ?? 0).toBeGreaterThan(0);
			}
		}
	});

	it('prefixed architect configs omit model', () => {
		const config = {
			swarms: {
				local: {
					name: 'Local',
				},
			},
		};

		const configs = getAgentConfigs(config as unknown as PluginConfig);

		// Prefixed architect should not have model
		const localArchitect = configs.local_architect;
		expect(localArchitect).not.toHaveProperty('model');

		// Other prefixed agents should have model
		const localCoder = configs.local_coder;
		expect(localCoder).toHaveProperty('model');
	});

	it('architect has mode primary', () => {
		const configs = getAgentConfigs();
		const architect = configs.architect;
		expect(architect.mode).toBe('primary');
	});

	it('all other agents have mode subagent', () => {
		const configs = getAgentConfigs();
		const agentNames = Object.keys(configs).filter(
			(name) => name !== 'architect',
		);

		for (const name of agentNames) {
			expect(configs[name].mode).toBe('subagent');
		}
	});

	it('each agent config includes description', () => {
		const configs = getAgentConfigs();

		for (const [name, config] of Object.entries(configs)) {
			expect(config.description?.length ?? 0).toBeGreaterThan(0);
		}
	});

	it('prefixed architect also has mode primary', () => {
		const config = {
			swarms: {
				local: {
					name: 'Local',
				},
			},
		};

		const configs = getAgentConfigs(config as unknown as PluginConfig);
		const localArchitect = configs.local_architect;
		expect(localArchitect.mode).toBe('primary');
	});

	it('handles agent overrides in getAgentConfigs', () => {
		const config = {
			agents: {
				coder: {
					model: 'custom/model',
					temperature: 0.7,
				},
			},
		};

		const configs = getAgentConfigs(config as unknown as PluginConfig);
		const coder = configs.coder;
		expect(coder.model).toBe('custom/model');
		expect(coder.temperature).toBe(0.7);
	});

	it('handles disabled agents in getAgentConfigs', () => {
		const config = {
			agents: {
				sme: {
					disabled: true,
				},
			},
		};

		const configs = getAgentConfigs(config as unknown as PluginConfig);
		expect(configs.sme).toBeUndefined();
		// 17 agents - 1 disabled = 16 agents (docs included by default)
		expect(Object.keys(configs)).toHaveLength(16);
	});
});
