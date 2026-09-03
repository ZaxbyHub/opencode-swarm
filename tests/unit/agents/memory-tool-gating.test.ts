import { describe, expect, test } from 'bun:test';
import { getAgentConfigs } from '../../../src/agents';
import type { PluginConfig } from '../../../src/config';

// Since #2528 the per-agent boundary is a `permission` block: a gated tool
// asserts as `permission[tool] === 'deny'` (host-enforced), an allowed one as
// the absence of a deny entry.
function denied(
	agents: ReturnType<typeof getAgentConfigs>,
	name: string,
	tool: string,
): unknown {
	return (agents[name]?.permission as Record<string, unknown> | undefined)?.[
		tool
	];
}

describe('memory tool gating', () => {
	const architectOutcomeGuidance =
		'After using recalled memory or a graph answer';

	test('default agent configs deny memory tools (host-enforced)', () => {
		const agents = getAgentConfigs(undefined);

		expect(agents.architect.permission?.swarm_memory_recall).toBe('deny');
		expect(agents.architect.permission?.swarm_memory_propose).toBe('deny');
		expect(agents.architect.permission?.swarm_memory_outcome).toBe('deny');
		expect(agents.architect.prompt).not.toContain('swarm_memory_recall');
		expect(agents.architect.prompt).not.toContain('swarm_memory_propose');
		expect(agents.architect.prompt).not.toContain('swarm_memory_outcome');
		expect(agents.architect.prompt).not.toContain(architectOutcomeGuidance);
		for (const role of ['explorer', 'coder', 'reviewer', 'critic'] as const) {
			expect(agents[role].permission?.swarm_memory_outcome).toBe('deny');
			expect(agents[role].prompt).not.toContain('swarm_memory_outcome');
		}
	});

	test('memory.enabled exposes memory tools to configured roles and prompt text', () => {
		const agents = getAgentConfigs({
			memory: { enabled: true },
		} as PluginConfig);

		expect(agents.architect.permission?.swarm_memory_recall).not.toBe('deny');
		expect(agents.architect.permission?.swarm_memory_propose).not.toBe('deny');
		expect(agents.architect.permission?.swarm_memory_outcome).not.toBe('deny');
		expect(agents.architect.prompt).toContain('swarm_memory_recall');
		expect(agents.architect.prompt).toContain('swarm_memory_propose');
		expect(agents.architect.prompt).toContain('swarm_memory_outcome');
		expect(agents.architect.prompt).toContain(architectOutcomeGuidance);
		expect(agents.architect.prompt).toContain(
			'include the corrected explanation in `correction`',
		);
		expect(agents.critic.permission?.swarm_memory_recall).not.toBe('deny');
		expect(agents.critic.permission?.swarm_memory_outcome).not.toBe('deny');
		expect(agents.critic.permission?.swarm_memory_propose).toBe('deny');
		expect(agents.reviewer.permission?.swarm_memory_recall).not.toBe('deny');
		expect(agents.reviewer.permission?.swarm_memory_outcome).not.toBe('deny');
		expect(agents.reviewer.permission?.swarm_memory_propose).toBe('deny');
		for (const role of [
			'architect',
			'explorer',
			'coder',
			'reviewer',
			'critic',
		] as const) {
			expect(agents[role].permission?.swarm_memory_outcome).not.toBe('deny');
			expect(agents[role].prompt).toContain('swarm_memory_outcome');
		}
		expect(agents.test_engineer.permission?.swarm_memory_outcome).toBe('deny');
		expect(agents.test_engineer.prompt).not.toContain('swarm_memory_outcome');
		expect(agents.critic_sounding_board.permission?.swarm_memory_outcome).toBe(
			'deny',
		);
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

		expect(agents.architect.permission?.save_plan).not.toBe('deny');
		expect(agents.architect.permission?.swarm_memory_recall).not.toBe('deny');
		expect(agents.architect.permission?.swarm_memory_propose).not.toBe('deny');
		expect(agents.architect.permission?.swarm_memory_outcome).not.toBe('deny');
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
			expect(disabledAgents[name].permission?.swarm_memory_outcome).toBe(
				'deny',
			);
			expect(disabledAgents[name].prompt).not.toContain(
				architectOutcomeGuidance,
			);
			expect(enabledAgents[name].permission?.swarm_memory_outcome).not.toBe(
				'deny',
			);
			expect(enabledAgents[name].prompt).toContain(architectOutcomeGuidance);
			expect(enabledAgents[name].prompt).toContain(
				'record `corrected` and include the corrected explanation in `correction`',
			);
		}
	});
});
