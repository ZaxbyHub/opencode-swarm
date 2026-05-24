import { describe, expect, test } from 'bun:test';
import { getAgentConfigs } from '../../../src/agents';
import type { PluginConfig } from '../../../src/config';

describe('memory tool gating', () => {
	test('default agent configs do not expose memory tools', () => {
		const agents = getAgentConfigs(undefined);

		expect(agents.architect.tools?.swarm_memory_recall).toBeUndefined();
		expect(agents.architect.tools?.swarm_memory_propose).toBeUndefined();
		expect(agents.architect.prompt).not.toContain('swarm_memory_recall');
		expect(agents.architect.prompt).not.toContain('swarm_memory_propose');
	});

	test('memory.enabled exposes memory tools to configured roles and prompt text', () => {
		const agents = getAgentConfigs({
			memory: { enabled: true },
		} as PluginConfig);

		expect(agents.architect.tools?.swarm_memory_recall).toBe(true);
		expect(agents.architect.tools?.swarm_memory_propose).toBe(true);
		expect(agents.architect.prompt).toContain('swarm_memory_recall');
		expect(agents.architect.prompt).toContain('swarm_memory_propose');
		expect(agents.critic.tools?.swarm_memory_recall).toBe(true);
		expect(agents.critic.tools?.swarm_memory_propose).toBeUndefined();
		expect(agents.reviewer.tools?.swarm_memory_recall).toBe(true);
		expect(agents.reviewer.tools?.swarm_memory_propose).toBeUndefined();
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
		expect(agents.architect.prompt).toContain('swarm_memory_recall');
		expect(agents.architect.prompt).toContain('swarm_memory_propose');
	});
});
