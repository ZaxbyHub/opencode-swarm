import { describe, expect, test } from 'bun:test';
import { getAgentConfigs } from '../../../src/agents';
import type { PluginConfig } from '../../../src/config';
import {
	EXTERNAL_SKILL_AGENT_TOOL_MAP,
	EXTERNAL_SKILL_TOOL_NAMES,
} from '../../../src/config/constants';
import { TOOL_NAME_SET } from '../../../src/tools/tool-names';

describe('EXTERNAL_SKILL_TOOL_NAMES', () => {
	test('contains exactly 7 expected tool names', () => {
		expect(EXTERNAL_SKILL_TOOL_NAMES).toHaveLength(7);
		expect(EXTERNAL_SKILL_TOOL_NAMES).toContain('external_skill_discover');
		expect(EXTERNAL_SKILL_TOOL_NAMES).toContain('external_skill_list');
		expect(EXTERNAL_SKILL_TOOL_NAMES).toContain('external_skill_inspect');
		expect(EXTERNAL_SKILL_TOOL_NAMES).toContain('external_skill_promote');
		expect(EXTERNAL_SKILL_TOOL_NAMES).toContain('external_skill_reject');
		expect(EXTERNAL_SKILL_TOOL_NAMES).toContain('external_skill_delete');
		expect(EXTERNAL_SKILL_TOOL_NAMES).toContain('external_skill_revoke');
	});

	test('all entries are valid ToolName types (exist in TOOL_NAME_SET)', () => {
		for (const tool of EXTERNAL_SKILL_TOOL_NAMES) {
			expect(TOOL_NAME_SET.has(tool)).toBe(true);
		}
	});
});

describe('EXTERNAL_SKILL_AGENT_TOOL_MAP', () => {
	test('only maps to architect agent', () => {
		const agentNames = Object.keys(EXTERNAL_SKILL_AGENT_TOOL_MAP);
		expect(agentNames).toEqual(['architect']);
	});

	test('architect entry contains all 7 external skill tools', () => {
		const architectTools = EXTERNAL_SKILL_AGENT_TOOL_MAP.architect;
		expect(architectTools).toHaveLength(7);
		for (const tool of EXTERNAL_SKILL_TOOL_NAMES) {
			expect(architectTools).toContain(tool);
		}
	});

	test('no other agent names are present', () => {
		const knownAgentNames = [
			'architect',
			'coder',
			'critic',
			'designer',
			'docs',
			'explorer',
			'reviewer',
			'sme',
			'test_engineer',
			'critic_sounding_board',
			'critic_drift_verifier',
			'critic_hallucination_verifier',
			'critic_architecture_supervisor',
			'critic_oversight',
			'curator_init',
			'curator_phase',
			'skill_improver',
			'spec_writer',
			'docs_design',
		];
		const mapAgentNames = Object.keys(EXTERNAL_SKILL_AGENT_TOOL_MAP);
		for (const name of mapAgentNames) {
			expect(knownAgentNames).toContain(name);
		}
	});
});

describe('external skill tool gating via getAgentConfigs', () => {
	test('when curation_enabled is false, tools do NOT appear in architect tool list', () => {
		const agents = getAgentConfigs({
			external_skills: { curation_enabled: false },
		} as PluginConfig);

		for (const tool of EXTERNAL_SKILL_TOOL_NAMES) {
			expect(agents.architect.tools?.[tool]).toBeUndefined();
		}
	});

	test('when curation_enabled is false, tools do NOT appear in any agent tool list', () => {
		const agents = getAgentConfigs({
			external_skills: { curation_enabled: false },
		} as PluginConfig);

		for (const agentConfig of Object.values(agents)) {
			for (const tool of EXTERNAL_SKILL_TOOL_NAMES) {
				expect(agentConfig.tools?.[tool]).toBeUndefined();
			}
		}
	});

	test('when curation_enabled is true, all 7 tools appear in architect tool list', () => {
		const agents = getAgentConfigs({
			external_skills: { curation_enabled: true },
		} as PluginConfig);

		for (const tool of EXTERNAL_SKILL_TOOL_NAMES) {
			expect(agents.architect.tools?.[tool]).toBe(true);
		}
	});

	test('when curation_enabled is true, tools do NOT appear in non-architect agents', () => {
		const agents = getAgentConfigs({
			external_skills: { curation_enabled: true },
		} as PluginConfig);

		const nonArchitectAgents = Object.keys(agents).filter(
			(name) => name !== 'architect',
		);
		for (const agentName of nonArchitectAgents) {
			for (const tool of EXTERNAL_SKILL_TOOL_NAMES) {
				expect(agents[agentName]?.tools?.[tool]).toBeUndefined();
			}
		}
	});

	test('curation_enabled true appends tools after tool_filter overrides', () => {
		const agents = getAgentConfigs({
			external_skills: { curation_enabled: true },
			tool_filter: {
				enabled: true,
				overrides: {
					architect: ['save_plan'],
				},
			},
		} as PluginConfig);

		// Override tool should still be present
		expect(agents.architect.tools?.save_plan).toBe(true);
		// External skill tools should also be present
		for (const tool of EXTERNAL_SKILL_TOOL_NAMES) {
			expect(agents.architect.tools?.[tool]).toBe(true);
		}
	});

	test('curation_enabled false with override still excludes external skill tools', () => {
		const agents = getAgentConfigs({
			external_skills: { curation_enabled: false },
			tool_filter: {
				enabled: true,
				overrides: {
					architect: ['save_plan'],
				},
			},
		} as PluginConfig);

		// Override tool should still be present
		expect(agents.architect.tools?.save_plan).toBe(true);
		// External skill tools should NOT be present
		for (const tool of EXTERNAL_SKILL_TOOL_NAMES) {
			expect(agents.architect.tools?.[tool]).toBeUndefined();
		}
	});
});
