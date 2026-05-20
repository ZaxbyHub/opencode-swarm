import { describe, expect, test } from 'bun:test';
import { getAgentConfigs } from '../../../src/agents';
import type { PluginConfig } from '../../../src/config';

/**
 * Hardening regression: when council.enabled === true, a user-supplied
 * tool_filter.overrides.architect that omits submit_council_verdicts or
 * declare_council_criteria is a CONFLICTING CONFIG. Rather than silently
 * force-including the tools (which overrides explicit user intent) or
 * silently dropping them (which re-creates the original 6.66.0 bug class),
 * getAgentConfigs throws a clear error requiring the user to resolve the
 * conflict explicitly.
 */
describe('tool_filter override + council conflict detection', () => {
	test('throws when architect override omits council tools and council is enabled', () => {
		const config: PluginConfig = {
			council: { enabled: true },
			tool_filter: {
				enabled: true,
				overrides: {
					architect: ['read', 'write', 'task'],
				},
			},
		} as PluginConfig;

		expect(() => getAgentConfigs(config)).toThrow(
			/council\.enabled=true but tool_filter\.overrides\.architect omits/,
		);
	});

	test('throws for swarm-prefixed architect too (e.g. cloud_architect)', () => {
		// Swarm-prefixed architect (cloud_architect, local_architect, etc.) must
		// follow the same rule — the base name is stripped and the override is
		// keyed by the base name. Any swarm whose architect override omits the
		// council tools should fail the same conflict check.
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

		expect(() => getAgentConfigs(config)).toThrow(
			/council\.enabled=true but tool_filter\.overrides\.architect omits/,
		);
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

	test('throws on empty override list when council is enabled', () => {
		// Empty list = user explicitly removed all tools from architect, including
		// both council tools. This is the degenerate case of the conflict and
		// must still throw rather than silently losing council.
		const config: PluginConfig = {
			council: { enabled: true },
			tool_filter: {
				enabled: true,
				overrides: {
					architect: [],
				},
			},
		} as PluginConfig;

		expect(() => getAgentConfigs(config)).toThrow(
			/council\.enabled=true but tool_filter\.overrides\.architect omits/,
		);
	});

	test('throws on partial override (only one of two council tools present)', () => {
		// Override includes submit_council_verdicts but omits declare_council_criteria.
		// Both tools are required by the council workflow — a partial override
		// is still a silent-failure path and must throw.
		const config: PluginConfig = {
			council: { enabled: true },
			tool_filter: {
				enabled: true,
				overrides: {
					architect: ['read', 'write', 'task', 'submit_council_verdicts'],
				},
			},
		} as PluginConfig;

		expect(() => getAgentConfigs(config)).toThrow(/declare_council_criteria/);
	});
});
