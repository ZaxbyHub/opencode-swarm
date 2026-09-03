/**
 * Issue #2528 companion assertions: the deny computation must stay in lockstep
 * with (a) the full-auto policy's parallel capability derivation, and (b) the
 * tool lists the architect is TOLD it has (prompt/map consistency — the
 * rendered YOUR_TOOLS list comes from the same maps, so anything the prompt
 * advertises must not be host-denied).
 */
import { describe, expect, test } from 'bun:test';
import { getAgentConfigs } from '../../../src/agents/index';
import {
	COUNCIL_AGENT_TOOL_MAP,
	EXTERNAL_SKILL_AGENT_TOOL_MAP,
	GENERAL_COUNCIL_AGENT_TOOL_MAP,
	MEMORY_AGENT_TOOL_MAP,
	SKILL_AGENT_TOOL_MAP,
	TURBO_AGENT_TOOL_MAP,
} from '../../../src/config/constants';
import { PluginConfigSchema } from '../../../src/config/schema';
import { _test_exports as policyTestExports } from '../../../src/full-auto/policy';
import { AGENT_TOOL_MAP, TOOL_NAMES } from '../../../src/tools/tool-metadata';

const { resolveAgentCapabilityTools } = policyTestExports;

function deniedPluginTools(permission: Record<string, unknown> | undefined) {
	return new Set(
		Object.entries(permission ?? {})
			.filter(([, v]) => v === 'deny')
			.map(([name]) => name)
			.filter((name) => (TOOL_NAMES as readonly string[]).includes(name)),
	);
}

describe('full-auto policy parity (anti-drift)', () => {
	test.each([
		[{}, 'default'],
		[{ memory: { enabled: true } }, 'memory on'],
		[{ external_skills: { curation_enabled: true } }, 'external skills on'],
		[{ council: { enabled: true } }, 'council on'],
		[{ council: { general: { enabled: true } } }, 'general council on'],
		[{ turbo: { strategy: 'standard' as const } }, 'turbo on'],
		[
			{ tool_filter: { overrides: { reviewer: ['diff', 'lint'] } } },
			'overrides set',
		],
		[
			{
				skills: { enabled: false },
				tool_filter: { overrides: { reviewer: ['skill_generate', 'diff'] } },
			},
			'FR-004 override bypass (reviewer naming a skill tool)',
		],
	])('emitted allow-list == resolveAgentCapabilityTools (%s)', (raw, label) => {
		const config = PluginConfigSchema.parse(raw as Record<string, unknown>);
		const agents = getAgentConfigs(config);
		for (const name of [
			'architect',
			'reviewer',
			'explorer',
			'coder',
			'skill_improver',
		]) {
			const emittedAllow = new Set(
				TOOL_NAMES.filter(
					(t) => !deniedPluginTools(agents[name].permission).has(t),
				),
			);
			const capability = new Set(
				resolveAgentCapabilityTools(name, config as never),
			);
			// Both directions: the emission and the policy derivation must
			// agree exactly on which plugin tools each role can use.
			for (const tool of emittedAllow)
				expect(capability.has(tool), `${label}/${name}/${tool}`).toBe(true);
			for (const tool of capability)
				expect(emittedAllow.has(tool), `${label}/${name}/${tool}`).toBe(true);
		}
	});
});

describe('prompt/map consistency — nothing the architect is told it has is denied', () => {
	// The architect prompt's YOUR_TOOLS/AVAILABLE_TOOLS lists render from
	// AGENT_TOOL_MAP.architect plus the enabled opt-in maps (same sources as
	// buildYourToolsList in src/agents/architect.ts). A tool advertised there
	// must NOT carry a deny in the emitted permission block, or the fix would
	// turn advertised capabilities into hard refusals (plan-critic N8).
	function advertisedTools(raw: Record<string, unknown>): Set<string> {
		const config = PluginConfigSchema.parse(raw);
		const tools = new Set<string>(AGENT_TOOL_MAP.architect);
		const add = (names: readonly string[] | undefined) => {
			for (const t of names ?? []) tools.add(t);
		};
		if (config.memory?.enabled === true) add(MEMORY_AGENT_TOOL_MAP.architect);
		if (config.external_skills?.curation_enabled === true)
			add(EXTERNAL_SKILL_AGENT_TOOL_MAP.architect);
		if (config.council?.enabled === true) add(COUNCIL_AGENT_TOOL_MAP.architect);
		if (config.council?.general?.enabled === true)
			add(GENERAL_COUNCIL_AGENT_TOOL_MAP.architect);
		if (config.turbo !== undefined) add(TURBO_AGENT_TOOL_MAP.architect);
		if (config.skills?.enabled === true) add(SKILL_AGENT_TOOL_MAP.architect);
		return tools;
	}

	test.each([
		[{}],
		[{ memory: { enabled: true } }],
		[{ external_skills: { curation_enabled: true } }],
		[{ council: { enabled: true, general: { enabled: true } } }],
		[{ turbo: { strategy: 'standard' as const } }],
		[{ skills: { enabled: true } }],
	])('advertised ⊆ allowed under %j', (raw) => {
		const denied = deniedPluginTools(
			getAgentConfigs(PluginConfigSchema.parse(raw as Record<string, unknown>))
				.architect.permission,
		);
		for (const tool of advertisedTools(raw as Record<string, unknown>)) {
			expect(denied.has(tool), tool).toBe(false);
		}
	});
});
