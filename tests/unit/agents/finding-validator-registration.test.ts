import { describe, expect, test } from 'bun:test';
import { createCriticAgent } from '../../../src/agents/critic';
import { getAgentConfigs } from '../../../src/agents/index';
import type { PluginConfig } from '../../../src/config';
import { getAgentCategory } from '../../../src/config/agent-categories';
import {
	AGENT_TOOL_MAP,
	ALL_AGENT_NAMES,
	DEFAULT_AGENT_CONFIGS,
	DEFAULT_MODELS,
	MEMORY_AGENT_TOOL_MAP,
	QA_AGENTS,
} from '../../../src/config/constants';

describe('critic_finding_validator registration', () => {
	test('canonical registries classify the validator as QA with reviewer-equivalent tools', () => {
		expect(QA_AGENTS).toContain('critic_finding_validator');
		expect(ALL_AGENT_NAMES).toContain('critic_finding_validator');
		expect(getAgentCategory('critic_finding_validator')).toBe('qa');
		expect(AGENT_TOOL_MAP.critic_finding_validator).toEqual(
			AGENT_TOOL_MAP.reviewer,
		);
		expect(MEMORY_AGENT_TOOL_MAP.critic_finding_validator).toEqual([
			'swarm_memory_recall',
		]);
		expect(DEFAULT_MODELS.critic_finding_validator).toBeDefined();
		expect(DEFAULT_AGENT_CONFIGS.critic_finding_validator).toBeDefined();
	});

	test('factory prompt is read-only, exact-ID correlated, and never approves code', () => {
		const agent = createCriticAgent(
			'test/model',
			undefined,
			undefined,
			'finding_validator',
		);
		expect(agent.name).toBe('critic_finding_validator');
		expect(agent.config.tools).toEqual({
			write: false,
			edit: false,
			patch: false,
		});
		expect(agent.config.prompt).toContain('finding_id');
		expect(agent.config.prompt).toContain('CONFIRMED');
		expect(agent.config.prompt).toContain('DISPROVED');
		expect(agent.config.prompt).toContain('UNVERIFIED');
		expect(agent.config.prompt).toMatch(/never approve/i);
	});

	test('unprefixed validator is a configured subagent', () => {
		const configs = getAgentConfigs();
		expect(configs.critic_finding_validator).toBeDefined();
		expect(configs.critic_finding_validator.mode).toBe('subagent');
		expect(configs.critic_finding_validator.model).toBeDefined();
	});

	test('multi-swarm validators are prefixed subagents and an architect remains primary', () => {
		const config = {
			swarms: {
				local: { name: 'Local' },
				mega: {
					name: 'Mega',
					agents: { critic: { model: 'mega/critic-model' } },
				},
			},
		} as unknown as PluginConfig;
		const configs = getAgentConfigs(config);

		for (const prefix of ['local', 'mega']) {
			const name = `${prefix}_critic_finding_validator`;
			expect(configs[name]).toBeDefined();
			expect(configs[name].mode).toBe('subagent');
			expect(configs[name].model).toBeDefined();
		}
		expect(configs.mega_critic_finding_validator.model).toBe(
			'mega/critic-model',
		);
		expect(
			Object.entries(configs).some(
				([name, value]) =>
					name.endsWith('_architect') && value.mode === 'primary',
			),
		).toBe(true);
	});
});
