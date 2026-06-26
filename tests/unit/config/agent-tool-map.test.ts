import { describe, expect, it } from 'bun:test';
import type { AgentName } from '../../../src/config/constants';
import {
	AGENT_TOOL_MAP,
	MEMORY_AGENT_TOOL_MAP,
	MEMORY_TOOL_NAMES,
} from '../../../src/config/constants';

describe('AGENT_TOOL_MAP', () => {
	const allAgentNames: AgentName[] = [
		'architect',
		'coder',
		'critic',
		'designer',
		'docs',
		'explorer',
		'researcher',
		'reviewer',
		'sme',
		'test_engineer',
	];

	it('covers all agent names', () => {
		for (const agent of allAgentNames) {
			expect(AGENT_TOOL_MAP).toHaveProperty(agent);
			expect(AGENT_TOOL_MAP[agent]).toBeDefined();
			expect(Array.isArray(AGENT_TOOL_MAP[agent])).toBe(true);
		}
	});

	it('architect has more tools than any other agent (superset)', () => {
		const architectTools = AGENT_TOOL_MAP.architect.length;
		for (const agent of allAgentNames) {
			if (agent === 'architect') continue;
			expect(AGENT_TOOL_MAP[agent].length).toBeLessThan(architectTools);
		}
	});

	it('subagent tool counts are <= 22', () => {
		for (const agent of allAgentNames) {
			if (agent === 'architect') continue;
			expect(AGENT_TOOL_MAP[agent].length).toBeLessThanOrEqual(22);
		}
	});

	it('coder lacks QA-only helpers', () => {
		const coderTools = AGENT_TOOL_MAP.coder;
		const qaHelpers = [
			'test_runner',
			'pkg_audit',
			'secretscan',
			'pre_check_batch',
			'complexity_hotspots',
		];
		for (const tool of qaHelpers) {
			expect(coderTools).not.toContain(tool);
		}
	});

	it('reviewer retains security tools', () => {
		const reviewerTools = AGENT_TOOL_MAP.reviewer;
		expect(reviewerTools).toContain('secretscan');
		expect(reviewerTools).toContain('pkg_audit');
	});

	it('sme can run opt-in external research but remains read-only', () => {
		const smeTools = AGENT_TOOL_MAP.sme;
		expect(smeTools).toContain('web_search');
		expect(smeTools).not.toContain('knowledge_add');
		expect(smeTools).not.toContain('apply_patch');
		expect(smeTools).not.toContain('swarm_apply_patch');
	});

	it('researcher has all 8 assigned tools and remains read-only', () => {
		const researcherTools = AGENT_TOOL_MAP.researcher;
		// All 8 tools assigned to researcher in tool-metadata.ts
		const expectedTools = [
			'imports',
			'symbols',
			'complexity_hotspots',
			'schema_drift',
			'todo_extract',
			'web_search',
			'swarm_command',
			'summarize_work',
		];
		for (const tool of expectedTools) {
			expect(researcherTools).toContain(tool);
		}
		// Read-only invariant: no write tools
		const writeTools = [
			'apply_patch',
			'swarm_apply_patch',
			'knowledge_add',
			'save_plan',
			'update_task_status',
			'spec_write',
			'phase_complete',
			'checkpoint',
		];
		for (const tool of writeTools) {
			expect(researcherTools).not.toContain(tool);
		}
	});

	it('architect has all critical tools', () => {
		const architectTools = AGENT_TOOL_MAP.architect;
		const criticalTools = [
			'diff',
			'lint',
			'pre_check_batch',
			'secretscan',
			'test_runner',
		];
		for (const tool of criticalTools) {
			expect(architectTools).toContain(tool);
		}
	});

	it('user-facing swarm agents can call swarm_command', () => {
		for (const agent of allAgentNames) {
			expect(AGENT_TOOL_MAP[agent]).toContain('swarm_command');
		}
	});

	it('memory tools are not in the default agent map', () => {
		for (const tools of Object.values(AGENT_TOOL_MAP)) {
			for (const memoryTool of MEMORY_TOOL_NAMES) {
				expect(tools).not.toContain(memoryTool);
			}
		}
	});

	it('memory opt-in map assigns proposal tools only to non-reviewer roles', () => {
		expect(MEMORY_AGENT_TOOL_MAP.architect).toEqual([
			'swarm_memory_recall',
			'swarm_memory_propose',
		]);
		expect(MEMORY_AGENT_TOOL_MAP.critic).toEqual(['swarm_memory_recall']);
		expect(MEMORY_AGENT_TOOL_MAP.reviewer).toEqual(['swarm_memory_recall']);
	});
});
