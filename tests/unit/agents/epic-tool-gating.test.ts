/**
 * Epic v2 — Epic Mode tools are an opt-in tool map (EPIC_AGENT_TOOL_MAP),
 * merged for the architect ONLY when `epic.mode.enabled === true` (top-level
 * `epic`; the legacy `turbo.epic` path resolves through the same gate).
 *
 * Follows the memory-tool-gating pattern (AGENTS.md §11 "Opt-in tool
 * maps"): (a) absent when the feature is off, (b) present when on, (c) the
 * merged set is correct per role — for legacy unprefixed AND multi-swarm
 * prefixed agent names, and in the full-auto capability derivation.
 */
import { describe, expect, test } from 'bun:test';
import { getAgentConfigs } from '../../../src/agents';
import type { PluginConfig } from '../../../src/config';
import {
	EPIC_AGENT_TOOL_MAP,
	EPIC_TOOL_NAMES,
} from '../../../src/config/constants';
import { PluginConfigSchema } from '../../../src/config/schema';
import { _test_exports as policyTestExports } from '../../../src/full-auto/policy';
import {
	AGENT_TOOL_MAP,
	TOOL_METADATA,
} from '../../../src/tools/tool-metadata';

const { resolveAgentCapabilityTools } = policyTestExports;

const EPIC_ON = { epic: { mode: { enabled: true } } };
/** The legacy path, parsed directly (no loader migration): same gate. */
const EPIC_ON_LEGACY = {
	turbo: { strategy: 'standard', epic: { mode: { enabled: true } } },
};
const OFF_CONFIGS: Array<[string, Record<string, unknown> | undefined]> = [
	['no config', undefined],
	['empty config', {}],
	['turbo block without epic', { turbo: { strategy: 'standard' } }],
	['epic.mode.enabled false', { epic: { mode: { enabled: false } } }],
	['epic block without mode', { epic: {} }],
	[
		'legacy turbo.epic.mode.enabled false',
		{ turbo: { strategy: 'standard', epic: { mode: { enabled: false } } } },
	],
	[
		'top-level epic off wins over legacy on',
		{ ...EPIC_ON_LEGACY, epic: { mode: { enabled: false } } },
	],
];
const SWARMS = { local: { name: 'Local' }, mega: { name: 'Mega' } };

function parse(
	raw: Record<string, unknown> | undefined,
): PluginConfig | undefined {
	return raw === undefined ? undefined : PluginConfigSchema.parse(raw);
}

describe('Epic tool map registry shape', () => {
	test('every epic_* tool in TOOL_METADATA is in EPIC_TOOL_NAMES and vice versa', () => {
		const metadataEpic = Object.keys(TOOL_METADATA)
			.filter((name) => name.startsWith('epic_'))
			.sort();
		expect([...EPIC_TOOL_NAMES].sort()).toEqual(metadataEpic);
	});

	test('Epic v2 C2 tool set: epic_next_wave replaces decide / plan_waves / record_divergence', () => {
		expect([...EPIC_TOOL_NAMES]).toEqual([
			'epic_next_wave',
			'epic_phase_review',
		]);
		for (const removed of [
			'epic_decide_phase',
			'epic_plan_waves',
			'epic_record_divergence',
		]) {
			expect(Object.keys(TOOL_METADATA)).not.toContain(removed);
		}
	});

	test('Epic tools have agents: [] and are absent from the always-on AGENT_TOOL_MAP', () => {
		for (const tool of EPIC_TOOL_NAMES) {
			expect(TOOL_METADATA[tool].agents).toEqual([]);
			for (const tools of Object.values(AGENT_TOOL_MAP)) {
				expect(tools as readonly string[]).not.toContain(tool);
			}
		}
	});

	test('the opt-in map grants the Epic tools to the architect only', () => {
		expect(Object.keys(EPIC_AGENT_TOOL_MAP)).toEqual(['architect']);
		expect(EPIC_AGENT_TOOL_MAP.architect).toEqual([...EPIC_TOOL_NAMES]);
	});
});

describe('getAgentConfigs — Epic tools gated by epic.mode.enabled', () => {
	test.each(
		OFF_CONFIGS,
	)('disabled (%s): architect denies every Epic tool and the prompt omits them', (_label, raw) => {
		const agents = getAgentConfigs(parse(raw));
		for (const tool of EPIC_TOOL_NAMES) {
			expect(agents.architect.permission?.[tool]).toBe('deny');
			expect(agents.architect.prompt).not.toContain(tool);
		}
	});

	test('enabled: architect is allowed every Epic tool and the prompt lists them', () => {
		const agents = getAgentConfigs(parse(EPIC_ON));
		for (const tool of EPIC_TOOL_NAMES) {
			expect(agents.architect.permission?.[tool]).not.toBe('deny');
			expect(agents.architect.prompt).toContain(tool);
		}
	});

	test('enabled through the legacy turbo.epic path: same grant', () => {
		const agents = getAgentConfigs(parse(EPIC_ON_LEGACY));
		for (const tool of EPIC_TOOL_NAMES) {
			expect(agents.architect.permission?.[tool]).not.toBe('deny');
			expect(agents.architect.prompt).toContain(tool);
		}
	});

	test('enabled: no other role gains an Epic tool', () => {
		const agents = getAgentConfigs(parse(EPIC_ON));
		for (const [name, agent] of Object.entries(agents)) {
			if (name === 'architect') continue;
			for (const tool of EPIC_TOOL_NAMES) {
				expect(agent.permission?.[tool], `${name}/${tool}`).toBe('deny');
			}
		}
	});

	test('enabled: Epic tools are merged after a tool_filter architect override', () => {
		const agents = getAgentConfigs(
			parse({
				...EPIC_ON,
				tool_filter: { enabled: true, overrides: { architect: ['save_plan'] } },
			}),
		);
		expect(agents.architect.permission?.save_plan).not.toBe('deny');
		for (const tool of EPIC_TOOL_NAMES) {
			expect(agents.architect.permission?.[tool]).not.toBe('deny');
		}
	});

	// Review F-005: the gate strips before it adds (the skill-gate precedent),
	// so a tool_filter override cannot grant an Epic tool the gate withholds.
	test('disabled: a tool_filter override naming Epic tools does not grant them', () => {
		const agents = getAgentConfigs(
			parse({
				tool_filter: {
					enabled: true,
					overrides: { architect: ['save_plan', ...EPIC_TOOL_NAMES] },
				},
			}),
		);
		expect(agents.architect.permission?.save_plan).not.toBe('deny');
		for (const tool of EPIC_TOOL_NAMES) {
			expect(agents.architect.permission?.[tool], tool).toBe('deny');
		}
	});

	test('enabled: a tool_filter override cannot grant Epic tools to another role', () => {
		const agents = getAgentConfigs(
			parse({
				...EPIC_ON,
				tool_filter: {
					enabled: true,
					overrides: { coder: ['write', ...EPIC_TOOL_NAMES] },
				},
			}),
		);
		for (const tool of EPIC_TOOL_NAMES) {
			expect(agents.coder.permission?.[tool], tool).toBe('deny');
			expect(agents.architect.permission?.[tool], tool).not.toBe('deny');
		}
	});

	test('multi-swarm prefixed architects follow the same gate', () => {
		const disabled = getAgentConfigs(parse({ swarms: SWARMS }));
		const enabled = getAgentConfigs(parse({ ...EPIC_ON, swarms: SWARMS }));
		for (const name of ['local_architect', 'mega_architect']) {
			expect(enabled[name]?.mode).toBe('primary');
			for (const tool of EPIC_TOOL_NAMES) {
				expect(disabled[name]?.permission?.[tool], `${name}/${tool}`).toBe(
					'deny',
				);
				expect(disabled[name]?.prompt).not.toContain(tool);
				expect(enabled[name]?.permission?.[tool], `${name}/${tool}`).not.toBe(
					'deny',
				);
				expect(enabled[name]?.prompt).toContain(tool);
			}
		}
		for (const name of ['local_coder', 'mega_reviewer']) {
			for (const tool of EPIC_TOOL_NAMES) {
				expect(enabled[name]?.permission?.[tool], `${name}/${tool}`).toBe(
					'deny',
				);
			}
		}
	});
});

describe('full-auto capability derivation — Epic tools gated identically', () => {
	test.each(
		OFF_CONFIGS,
	)('disabled (%s): architect capability excludes Epic tools', (_label, raw) => {
		const tools = resolveAgentCapabilityTools('architect', parse(raw) as never);
		for (const tool of EPIC_TOOL_NAMES) expect(tools).not.toContain(tool);
	});

	test('enabled: architect capability includes every Epic tool, other roles none', () => {
		const config = parse(EPIC_ON) as never;
		const architect = resolveAgentCapabilityTools('architect', config);
		for (const tool of EPIC_TOOL_NAMES) expect(architect).toContain(tool);
		for (const role of ['coder', 'reviewer', 'explorer', 'critic']) {
			const tools = resolveAgentCapabilityTools(role, config);
			for (const tool of EPIC_TOOL_NAMES) expect(tools).not.toContain(tool);
		}
		const legacy = resolveAgentCapabilityTools(
			'architect',
			parse(EPIC_ON_LEGACY) as never,
		);
		for (const tool of EPIC_TOOL_NAMES) expect(legacy).toContain(tool);
	});
});
