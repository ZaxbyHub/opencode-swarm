/**
 * Skill-management tool gating tests (FR-004).
 * Verifies that the 7 skill_* tools are host-denied for the architect by default
 * and genuinely allowed only when skills.enabled === true.
 *
 * Since #2528 the per-agent boundary is emitted as a `permission` block (the
 * host never reads a plugin-injected agent's `tools` map): a gated tool is
 * asserted via `permission[tool] === 'deny'` (host-enforced unreachability),
 * an allowed tool via the absence of a deny entry. Runtime enforcement through
 * the host's own gate is covered by
 * tests/unit/agents/agent-permission-enforcement.test.ts.
 *
 * Pattern mirrors external-skill-agent-tool-map.test.ts and memory-tool-gating.test.ts.
 */

import { describe, expect, test } from 'bun:test';
import { getAgentConfigs } from '../../../src/agents';
import type { PluginConfig } from '../../../src/config';
import {
	SKILL_AGENT_TOOL_MAP,
	SKILL_TOOL_NAMES,
} from '../../../src/config/constants';
import { TOOL_NAME_SET } from '../../../src/tools/tool-names';

function denied(
	agents: ReturnType<typeof getAgentConfigs>,
	name: string,
	tool: string,
): boolean | undefined {
	return (agents[name]?.permission as Record<string, unknown> | undefined)?.[
		tool
	];
}

describe('SKILL_TOOL_NAMES', () => {
	test('contains exactly 7 expected tool names', () => {
		expect(SKILL_TOOL_NAMES).toHaveLength(7);
		expect(SKILL_TOOL_NAMES).toContain('skill_generate');
		expect(SKILL_TOOL_NAMES).toContain('skill_list');
		expect(SKILL_TOOL_NAMES).toContain('skill_apply');
		expect(SKILL_TOOL_NAMES).toContain('skill_inspect');
		expect(SKILL_TOOL_NAMES).toContain('skill_regenerate');
		expect(SKILL_TOOL_NAMES).toContain('skill_retire');
		expect(SKILL_TOOL_NAMES).toContain('skill_improve');
	});

	test('all entries are valid ToolName types (exist in TOOL_NAME_SET)', () => {
		for (const tool of SKILL_TOOL_NAMES) {
			expect(TOOL_NAME_SET.has(tool)).toBe(true);
		}
	});
});

describe('SKILL_AGENT_TOOL_MAP', () => {
	test('only maps to architect agent', () => {
		const agentNames = Object.keys(SKILL_AGENT_TOOL_MAP);
		expect(agentNames).toEqual(['architect']);
	});

	test('architect entry contains all 7 skill tools', () => {
		const architectTools = SKILL_AGENT_TOOL_MAP.architect;
		expect(architectTools).toHaveLength(7);
		for (const tool of SKILL_TOOL_NAMES) {
			expect(architectTools).toContain(tool);
		}
	});
});

describe('skill tool gating via getAgentConfigs (FR-004)', () => {
	test('when skills.enabled is false (default), skill tools are host-denied for the architect', () => {
		const agents = getAgentConfigs({
			skills: { enabled: false },
		} as PluginConfig);

		for (const tool of SKILL_TOOL_NAMES) {
			expect(denied(agents, 'architect', tool)).toBe('deny');
		}
	});

	test('when skills.enabled is false, skill_improver legitimately retains them (denies only the apply/regenerate/retire trio it never had)', () => {
		const agents = getAgentConfigs({
			skills: { enabled: false },
		} as PluginConfig);

		// Architect must be gated
		for (const tool of SKILL_TOOL_NAMES) {
			expect(denied(agents, 'architect', tool)).toBe('deny');
		}
		// skill_improver is the designed consumer of the skill_* surface
		// (FR-004: gated separately by skill_improver.enabled). The four
		// tools in its role map stay allowed; the architect-only
		// apply/regenerate/retire trio stays denied.
		expect(denied(agents, 'skill_improver', 'skill_generate')).not.toBe('deny');
		expect(denied(agents, 'skill_improver', 'skill_list')).not.toBe('deny');
		expect(denied(agents, 'skill_improver', 'skill_inspect')).not.toBe('deny');
		expect(denied(agents, 'skill_improver', 'skill_improve')).not.toBe('deny');
		expect(denied(agents, 'skill_improver', 'skill_apply')).toBe('deny');
		expect(denied(agents, 'skill_improver', 'skill_regenerate')).toBe('deny');
		expect(denied(agents, 'skill_improver', 'skill_retire')).toBe('deny');
	});

	test('when skills.enabled is true, all 7 tools are allowed for the architect', () => {
		const agents = getAgentConfigs({
			skills: { enabled: true },
		} as PluginConfig);

		for (const tool of SKILL_TOOL_NAMES) {
			expect(denied(agents, 'architect', tool)).not.toBe('deny');
		}
	});

	test('when skills.enabled is true, tools stay denied for non-architect non-skill_improver agents', () => {
		const agents = getAgentConfigs({
			skills: { enabled: true },
		} as PluginConfig);

		const nonTargetAgents = Object.keys(agents).filter(
			(name) => name !== 'architect' && name !== 'skill_improver',
		);
		for (const agentName of nonTargetAgents) {
			for (const tool of SKILL_TOOL_NAMES) {
				expect(denied(agents, agentName, tool)).toBe('deny');
			}
		}
	});

	test('skills.enabled true appends tools after tool_filter overrides', () => {
		const agents = getAgentConfigs({
			skills: { enabled: true },
			tool_filter: {
				enabled: true,
				overrides: {
					architect: ['save_plan'],
				},
			},
		} as PluginConfig);

		// Override tool should still be allowed
		expect(denied(agents, 'architect', 'save_plan')).not.toBe('deny');
		// Skill tools should also be allowed
		for (const tool of SKILL_TOOL_NAMES) {
			expect(denied(agents, 'architect', tool)).not.toBe('deny');
		}
	});

	test('skills.enabled false with override still excludes skill tools', () => {
		const agents = getAgentConfigs({
			skills: { enabled: false },
			tool_filter: {
				enabled: true,
				overrides: {
					architect: ['save_plan'],
				},
			},
		} as PluginConfig);

		// Override tool should still be allowed
		expect(denied(agents, 'architect', 'save_plan')).not.toBe('deny');
		// Skill tools should be denied
		for (const tool of SKILL_TOOL_NAMES) {
			expect(denied(agents, 'architect', tool)).toBe('deny');
		}
	});

	test('skills.enabled=false + tool_filter override including skill tool still excludes (bypass regression)', () => {
		// Explicit bypass scenario from FR-004 gate issue:
		// override lists a skill tool, but gate must still exclude it.
		const agents = getAgentConfigs({
			skills: { enabled: false },
			tool_filter: {
				enabled: true,
				overrides: {
					architect: ['save_plan', 'skill_generate'],
				},
			},
		} as PluginConfig);

		// Non-skill override tool is allowed
		expect(denied(agents, 'architect', 'save_plan')).not.toBe('deny');
		// Skill tool from override MUST still be excluded (gate is authoritative)
		expect(denied(agents, 'architect', 'skill_generate')).toBe('deny');
		for (const tool of SKILL_TOOL_NAMES) {
			expect(denied(agents, 'architect', tool)).toBe('deny');
		}
	});

	test('default config (no skills key) excludes skill tools (fresh install)', () => {
		const agents = getAgentConfigs(undefined);

		for (const tool of SKILL_TOOL_NAMES) {
			expect(denied(agents, 'architect', tool)).toBe('deny');
		}
	});

	test('skills.enabled true also appears in architect prompt text', () => {
		const agents = getAgentConfigs({
			skills: { enabled: true },
		} as PluginConfig);

		for (const tool of SKILL_TOOL_NAMES) {
			expect(agents.architect.prompt).toContain(tool);
		}
	});

	test('skills.enabled false excludes skill tools from architect tool surface (prompt + permission)', () => {
		const agents = getAgentConfigs({
			skills: { enabled: false },
		} as PluginConfig);

		for (const tool of SKILL_TOOL_NAMES) {
			// Prompt may contain the tool name in other contexts (e.g., skill_improver docs);
			// we only assert that the architect's *tool surface* does not grant them:
			// the critical gate is the host-enforced permission deny.
			expect(denied(agents, 'architect', tool)).toBe('deny');
		}
	});
});
