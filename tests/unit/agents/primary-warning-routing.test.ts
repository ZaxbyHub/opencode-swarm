import { afterEach, describe, expect, test } from 'bun:test';
import { getAgentConfigs } from '../../../src/agents';
import type { PluginConfig } from '../../../src/config';
import {
	clearDeferredWarnings,
	getDeferredWarnings,
} from '../../../src/services/warning-buffer';

const originalDebug = process.env.OPENCODE_SWARM_DEBUG;

afterEach(() => {
	clearDeferredWarnings();
	if (originalDebug === undefined) delete process.env.OPENCODE_SWARM_DEBUG;
	else process.env.OPENCODE_SWARM_DEBUG = originalDebug;
});

function configWithActionableWarnings(quiet: boolean): PluginConfig {
	return {
		quiet,
		default_agent: 'not_a_registered_agent',
		tool_filter: {
			enabled: true,
			overrides: { architect: ['declare_council_criteria'] },
		},
	} as PluginConfig;
}

function councilWarnings(): string[] {
	return getDeferredWarnings().filter((message) =>
		message.includes('council.enabled is not true'),
	);
}

describe('getAgentConfigs actionable warning routing', () => {
	for (const quiet of [true, false]) {
		test(`buffers primary fallback and unusable council override when quiet=${quiet}`, () => {
			delete process.env.OPENCODE_SWARM_DEBUG;
			clearDeferredWarnings();

			getAgentConfigs(configWithActionableWarnings(quiet));

			const warnings = getDeferredWarnings();
			expect(
				warnings.some((message) => message.includes('default_agent')),
			).toBe(true);
			expect(
				warnings.some((message) =>
					message.includes('council.enabled is not true'),
				),
			).toBe(true);
		});

		test(`buffers one council advisory across multiple swarms when quiet=${quiet}`, () => {
			getAgentConfigs({
				quiet,
				swarms: {
					local: { name: 'Local', agents: {} },
					mega: { name: 'Mega', agents: {} },
				},
				tool_filter: {
					enabled: true,
					overrides: { architect: ['declare_council_criteria'] },
				},
			} as PluginConfig);

			expect(councilWarnings()).toHaveLength(1);
		});
	}

	test('does not warn when council is enabled', () => {
		getAgentConfigs({
			council: { enabled: true },
			tool_filter: {
				enabled: true,
				overrides: { architect: ['declare_council_criteria'] },
			},
		} as PluginConfig);

		expect(councilWarnings()).toHaveLength(0);
	});

	test('does not warn when the architect override is absent', () => {
		getAgentConfigs({
			council: { enabled: false },
			tool_filter: { enabled: true, overrides: {} },
		} as PluginConfig);

		expect(councilWarnings()).toHaveLength(0);
	});
});
