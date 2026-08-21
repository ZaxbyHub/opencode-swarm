import { describe, expect, test } from 'bun:test';
import { getAgentConfigs } from '../../../src/agents';
import type { PluginConfig } from '../../../src/config';

describe('memory tool gating', () => {
	const architectOutcomeGuidance =
		'After using recalled memory or a graph answer';

	test('default agent configs do not expose memory tools', () => {
		const agents = getAgentConfigs(undefined);

		expect(agents.architect.tools?.swarm_memory_recall).toBeUndefined();
		expect(agents.architect.tools?.swarm_memory_propose).toBeUndefined();
		expect(agents.architect.tools?.swarm_memory_outcome).toBeUndefined();
		expect(agents.architect.prompt).not.toContain('swarm_memory_recall');
		expect(agents.architect.prompt).not.toContain('swarm_memory_propose');
		expect(agents.architect.prompt).not.toContain('swarm_memory_outcome');
		expect(agents.architect.prompt).not.toContain(architectOutcomeGuidance);
		for (const role of ['explorer', 'coder', 'reviewer', 'critic'] as const) {
			expect(agents[role].tools?.swarm_memory_outcome).toBeUndefined();
			expect(agents[role].prompt).not.toContain('swarm_memory_outcome');
		}
	});

	test('memory.enabled exposes memory tools to configured roles and prompt text', () => {
		const agents = getAgentConfigs({
			memory: { enabled: true },
		} as PluginConfig);

		expect(agents.architect.tools?.swarm_memory_recall).toBe(true);
		expect(agents.architect.tools?.swarm_memory_propose).toBe(true);
		expect(agents.architect.tools?.swarm_memory_outcome).toBe(true);
		expect(agents.architect.prompt).toContain('swarm_memory_recall');
		expect(agents.architect.prompt).toContain('swarm_memory_propose');
		expect(agents.architect.prompt).toContain('swarm_memory_outcome');
		expect(agents.architect.prompt).toContain(architectOutcomeGuidance);
		expect(agents.architect.prompt).toContain(
			'include the corrected explanation in `correction`',
		);
		expect(agents.critic.tools?.swarm_memory_recall).toBe(true);
		expect(agents.critic.tools?.swarm_memory_outcome).toBe(true);
		expect(agents.critic.tools?.swarm_memory_propose).toBeUndefined();
		expect(agents.reviewer.tools?.swarm_memory_recall).toBe(true);
		expect(agents.reviewer.tools?.swarm_memory_outcome).toBe(true);
		expect(agents.reviewer.tools?.swarm_memory_propose).toBeUndefined();
		for (const role of [
			'architect',
			'explorer',
			'coder',
			'reviewer',
			'critic',
		] as const) {
			expect(agents[role].tools?.swarm_memory_outcome).toBe(true);
			expect(agents[role].prompt).toContain('swarm_memory_outcome');
		}
		expect(agents.test_engineer.tools?.swarm_memory_outcome).toBeUndefined();
		expect(agents.test_engineer.prompt).not.toContain('swarm_memory_outcome');
		expect(
			agents.critic_sounding_board.tools?.swarm_memory_outcome,
		).toBeUndefined();
		expect(agents.critic_sounding_board.prompt).not.toContain(
			'swarm_memory_outcome',
		);
	});

	test('memory.enabled appends memory tools after tool_filter overrides', () => {
		const agents = getAgentConfigs({
			memory: { enabled: true },
			tool_filter: {
				enabled: true,
				overrides: {
					architect: ['save_plan'],
				},
			},
		} as PluginConfig);

		expect(agents.architect.tools?.save_plan).toBe(true);
		expect(agents.architect.tools?.swarm_memory_recall).toBe(true);
		expect(agents.architect.tools?.swarm_memory_propose).toBe(true);
		expect(agents.architect.tools?.swarm_memory_outcome).toBe(true);
		expect(agents.architect.prompt).toContain('swarm_memory_recall');
		expect(agents.architect.prompt).toContain('swarm_memory_propose');
		expect(agents.architect.prompt).toContain('swarm_memory_outcome');
		expect(agents.architect.prompt).toContain(architectOutcomeGuidance);
	});

	test('memory outcome guidance is explicit for prefixed architects', () => {
		const swarms = {
			local: { name: 'Local' },
			mega: { name: 'Mega' },
		};
		const disabledAgents = getAgentConfigs({ swarms } as PluginConfig);
		const enabledAgents = getAgentConfigs({
			memory: { enabled: true },
			swarms,
		} as PluginConfig);

		for (const name of ['local_architect', 'mega_architect'] as const) {
			expect(disabledAgents[name].tools?.swarm_memory_outcome).toBeUndefined();
			expect(disabledAgents[name].prompt).not.toContain(
				architectOutcomeGuidance,
			);
			expect(enabledAgents[name].tools?.swarm_memory_outcome).toBe(true);
			expect(enabledAgents[name].prompt).toContain(architectOutcomeGuidance);
			expect(enabledAgents[name].prompt).toContain(
				'record `corrected` and include the corrected explanation in `correction`',
			);
		}
	});
});
