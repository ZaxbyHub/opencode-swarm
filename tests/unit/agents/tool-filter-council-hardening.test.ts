import { describe, expect, test } from 'bun:test';
import { getAgentConfigs } from '../../../src/agents';
import type { PluginConfig } from '../../../src/config';
import {
	COUNCIL_AGENT_TOOL_MAP,
	GENERAL_COUNCIL_AGENT_TOOL_MAP,
	TURBO_AGENT_TOOL_MAP,
} from '../../../src/config/constants';

/**
 * General Council tools (convene_general_council, web_search, web_fetch) are
 * gated by council.general.enabled. Unlike council.enabled (QA gate tools),
 * general council is a research/synthesis opt-in.
 */
describe('council.general.enabled feature-gate', () => {
	test('architect has GENERAL_COUNCIL tools when council.general.enabled is true', () => {
		const config: PluginConfig = {
			council: { general: { enabled: true } },
		} as PluginConfig;

		const agents = getAgentConfigs(config);
		const architect = agents['architect'];
		expect(architect).toBeDefined();
		const tools = architect.tools as Record<string, boolean> | undefined;

		for (const tool of GENERAL_COUNCIL_AGENT_TOOL_MAP.architect ?? []) {
			expect(tools?.[tool]).toBe(true);
		}
	});

	test('architect does NOT have GENERAL_COUNCIL tools when council.general.enabled is false', () => {
		const config: PluginConfig = {
			council: { general: { enabled: false } },
		} as PluginConfig;

		const agents = getAgentConfigs(config);
		const architect = agents['architect'];
		const tools = architect.tools as Record<string, boolean> | undefined;

		for (const tool of GENERAL_COUNCIL_AGENT_TOOL_MAP.architect ?? []) {
			expect(tools?.[tool]).toBeUndefined();
		}
	});

	test('architect does NOT have GENERAL_COUNCIL tools when council.general is absent', () => {
		const config: PluginConfig = {
			council: { enabled: true }, // council.enabled=true but no general.enabled
		} as PluginConfig;

		const agents = getAgentConfigs(config);
		const architect = agents['architect'];
		const tools = architect.tools as Record<string, boolean> | undefined;

		for (const tool of GENERAL_COUNCIL_AGENT_TOOL_MAP.architect ?? []) {
			expect(tools?.[tool]).toBeUndefined();
		}
	});

	test('swarm-prefixed architect has GENERAL_COUNCIL tools when council.general.enabled is true', () => {
		const config: PluginConfig = {
			council: { general: { enabled: true } },
			swarms: {
				cloud: { name: 'cloud', agents: {} },
			},
		} as PluginConfig;

		const agents = getAgentConfigs(config);
		const architect = agents['cloud_architect'];
		expect(architect).toBeDefined();
		const tools = architect.tools as Record<string, boolean> | undefined;

		for (const tool of GENERAL_COUNCIL_AGENT_TOOL_MAP.architect ?? []) {
			expect(tools?.[tool]).toBe(true);
		}
	});
});

/**
 * Lean Turbo tools (lean_turbo_*) are gated by turbo config block presence.
 * The mere existence of config.turbo (regardless of inner values) opts in.
 */
describe('turbo config feature-gate', () => {
	test('architect has TURBO tools when turbo config is present', () => {
		const config: PluginConfig = {
			turbo: { enabled: true },
		} as PluginConfig;

		const agents = getAgentConfigs(config);
		const architect = agents['architect'];
		expect(architect).toBeDefined();
		const tools = architect.tools as Record<string, boolean> | undefined;

		for (const tool of TURBO_AGENT_TOOL_MAP.architect ?? []) {
			expect(tools?.[tool]).toBe(true);
		}
	});

	test('architect does NOT have TURBO tools when turbo config is absent', () => {
		const config: PluginConfig = {} as PluginConfig;

		const agents = getAgentConfigs(config);
		const architect = agents['architect'];
		const tools = architect.tools as Record<string, boolean> | undefined;

		for (const tool of TURBO_AGENT_TOOL_MAP.architect ?? []) {
			expect(tools?.[tool]).toBeUndefined();
		}
	});

	test('swarm-prefixed architect has TURBO tools when turbo config is present', () => {
		const config: PluginConfig = {
			turbo: { enabled: true },
			swarms: {
				cloud: { name: 'cloud', agents: {} },
			},
		} as PluginConfig;

		const agents = getAgentConfigs(config);
		const architect = agents['cloud_architect'];
		expect(architect).toBeDefined();
		const tools = architect.tools as Record<string, boolean> | undefined;

		for (const tool of TURBO_AGENT_TOOL_MAP.architect ?? []) {
			expect(tools?.[tool]).toBe(true);
		}
	});

	test('architect does NOT have TURBO tools when turbo is explicitly undefined', () => {
		const config: PluginConfig = {
			turbo: undefined,
		} as PluginConfig;

		const agents = getAgentConfigs(config);
		const architect = agents['architect'];
		const tools = architect.tools as Record<string, boolean> | undefined;

		for (const tool of TURBO_AGENT_TOOL_MAP.architect ?? []) {
			expect(tools?.[tool]).toBeUndefined();
		}
	});
});

/**
 * Combined scenario: verify architect does NOT have council or turbo tools
 * when ALL feature flags are OFF.
 */
describe('all feature flags OFF — architect has no gated tools', () => {
	test('architect has no council, general council, or turbo tools when all flags are off', () => {
		const config: PluginConfig = {
			council: { enabled: false, general: { enabled: false } },
		} as PluginConfig;

		const agents = getAgentConfigs(config);
		const architect = agents['architect'];
		const tools = architect.tools as Record<string, boolean> | undefined;

		// No COUNCIL_AGENT_TOOL_MAP tools
		for (const tool of COUNCIL_AGENT_TOOL_MAP.architect ?? []) {
			expect(tools?.[tool]).toBeUndefined();
		}
		// No GENERAL_COUNCIL_AGENT_TOOL_MAP tools
		for (const tool of GENERAL_COUNCIL_AGENT_TOOL_MAP.architect ?? []) {
			expect(tools?.[tool]).toBeUndefined();
		}
		// No TURBO_AGENT_TOOL_MAP tools
		for (const tool of TURBO_AGENT_TOOL_MAP.architect ?? []) {
			expect(tools?.[tool]).toBeUndefined();
		}
	});
});

/**
 * Hardening regression: when council.enabled === true, council-mode tools
 * are auto-merged ON TOP of any architect override via the conditional
 * merge in getAgentConfigs. This means the override cannot accidentally
 * exclude council tools — they are always present when council.enabled=true.
 * The previous behavior (throwing a conflict error) was removed in the
 * opt-in gating refactor.
 */
describe('tool_filter override + council conflict detection', () => {
	test('council tools are auto-merged into architect override when council is enabled', () => {
		const config: PluginConfig = {
			council: { enabled: true },
			tool_filter: {
				enabled: true,
				overrides: {
					architect: ['read', 'write', 'task'],
				},
			},
		} as PluginConfig;

		const agents = getAgentConfigs(config);
		const architect = agents['architect'];
		expect(architect).toBeDefined();
		const tools = architect.tools as Record<string, boolean> | undefined;
		// Council tools are auto-merged on top of the override
		for (const tool of COUNCIL_AGENT_TOOL_MAP.architect ?? []) {
			expect(tools?.[tool]).toBe(true);
		}
	});

	test('swarm-prefixed architect: council tools auto-merged when council is enabled', () => {
		const config: PluginConfig = {
			council: { enabled: true },
			swarms: {
				cloud: {
					name: 'cloud',
					agents: {},
				},
			},
			tool_filter: {
				enabled: true,
				overrides: {
					architect: ['read', 'write', 'task'],
				},
			},
		} as PluginConfig;

		const agents = getAgentConfigs(config);
		const architect = agents['cloud_architect'];
		expect(architect).toBeDefined();
		const tools = architect.tools as Record<string, boolean> | undefined;
		for (const tool of COUNCIL_AGENT_TOOL_MAP.architect ?? []) {
			expect(tools?.[tool]).toBe(true);
		}
	});

	test('architect override containing council tools passes unchanged', () => {
		const config: PluginConfig = {
			council: { enabled: true },
			tool_filter: {
				enabled: true,
				overrides: {
					architect: [
						'read',
						'write',
						'task',
						'submit_council_verdicts',
						'declare_council_criteria',
					],
				},
			},
		} as PluginConfig;

		const agents = getAgentConfigs(config);
		const architect = agents['architect'];
		expect(architect).toBeDefined();
		const tools = architect.tools as Record<string, boolean> | undefined;
		expect(tools?.submit_council_verdicts).toBe(true);
		expect(tools?.declare_council_criteria).toBe(true);
	});

	test('architect override without council tools is respected when council disabled', () => {
		// When council is off, user intent is honored: the override list wins
		// and council tools are NOT force-included.
		const config: PluginConfig = {
			council: { enabled: false },
			tool_filter: {
				enabled: true,
				overrides: {
					architect: ['read', 'write', 'task'],
				},
			},
		} as PluginConfig;

		const agents = getAgentConfigs(config);
		const architect = agents['architect'];
		const tools = architect.tools as Record<string, boolean> | undefined;
		expect(tools?.submit_council_verdicts).toBeUndefined();
		expect(tools?.declare_council_criteria).toBeUndefined();
	});

	test('no override + council enabled: council tools come from AGENT_TOOL_MAP as usual', () => {
		const config: PluginConfig = {
			council: { enabled: true },
		} as PluginConfig;

		const agents = getAgentConfigs(config);
		const architect = agents['architect'];
		const tools = architect.tools as Record<string, boolean> | undefined;
		expect(tools?.submit_council_verdicts).toBe(true);
		expect(tools?.declare_council_criteria).toBe(true);
	});

	test('empty override list when council enabled: council tools still present (auto-merged)', () => {
		// Empty list + council.enabled=true: council tools are auto-merged
		// on top, so they remain available (no throw, no silent loss).
		const config: PluginConfig = {
			council: { enabled: true },
			tool_filter: {
				enabled: true,
				overrides: {
					architect: [],
				},
			},
		} as PluginConfig;

		const agents = getAgentConfigs(config);
		const architect = agents['architect'];
		const tools = architect.tools as Record<string, boolean> | undefined;
		for (const tool of COUNCIL_AGENT_TOOL_MAP.architect ?? []) {
			expect(tools?.[tool]).toBe(true);
		}
	});

	test('partial override when council enabled: missing council tools are auto-merged', () => {
		// Override includes submit_council_verdicts but omits declare_council_criteria.
		// With auto-merge, both are present in the final tool set.
		const config: PluginConfig = {
			council: { enabled: true },
			tool_filter: {
				enabled: true,
				overrides: {
					architect: ['read', 'write', 'task', 'submit_council_verdicts'],
				},
			},
		} as PluginConfig;

		const agents = getAgentConfigs(config);
		const architect = agents['architect'];
		const tools = architect.tools as Record<string, boolean> | undefined;
		expect(tools?.submit_council_verdicts).toBe(true);
		expect(tools?.declare_council_criteria).toBe(true);
	});
});
