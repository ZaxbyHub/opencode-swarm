import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createArchitectAgent } from '../../../src/agents/architect.js';
import { createCoderAgent } from '../../../src/agents/coder.js';
import { createCriticAgent } from '../../../src/agents/critic.js';
import { createReviewerAgent } from '../../../src/agents/reviewer.js';
import { createTestEngineerAgent } from '../../../src/agents/test-engineer.js';
import { AGENT_TOOL_MAP } from '../../../src/config/constants.js';

const readRepoFile = (path: string): string =>
	readFileSync(join(process.cwd(), path), 'utf-8');

const expectGraphContract = (content: string, actions: string[]): void => {
	expect(content).toContain('repo_map');
	for (const action of actions) expect(content).toContain(action);
	expect(content.toLowerCase()).toContain('advisory');
	expect(content.toLowerCase()).toMatch(/direct (source|code)/);
	expect(content.toLowerCase()).toMatch(/stale|freshness/);
	expect(content.toLowerCase()).toContain('confidence');
};

describe('graph-first workflow contracts', () => {
	test('operative role prompts expose source-bearing advisory graph workflows', () => {
		const surfaces = [
			{
				name: 'architect',
				content: createArchitectAgent('test-model').config.prompt ?? '',
				actions: [
					'graph_health',
					'package_boundaries',
					'key_files',
					'context_pack',
				],
			},
			{
				name: 'coder',
				content: createCoderAgent('test-model').config.prompt ?? '',
				actions: ['localization', 'impact_cone'],
			},
			{
				name: 'critic',
				content:
					createCriticAgent('test-model', undefined, undefined, 'plan_critic')
						.config.prompt ?? '',
				actions: ['graph_health', 'impact_cone'],
			},
			{
				name: 'reviewer',
				content: createReviewerAgent('test-model').config.prompt ?? '',
				actions: [
					'graph_health',
					'diff_context',
					'impact_cone',
					'blast_radius',
				],
			},
			{
				name: 'test_engineer',
				content: createTestEngineerAgent('test-model').config.prompt ?? '',
				actions: ['test_pack'],
			},
		];

		for (const surface of surfaces) {
			expect(surface.content, surface.name).toBeTruthy();
			expectGraphContract(surface.content, surface.actions);
		}
	});

	test('test engineer owns the graph tool named by its prompt', () => {
		expect(AGENT_TOOL_MAP.test_engineer).toContain('repo_map');
	});

	test('operative workflow skills name exact graph actions and fallback rules', () => {
		const surfaces = [
			{
				path: '.opencode/skills/plan/SKILL.md',
				actions: [
					'graph_health',
					'package_boundaries',
					'key_files',
					'context_pack',
				],
			},
			{
				path: '.opencode/skills/execute/SKILL.md',
				actions: ['localization', 'impact_cone'],
			},
			{
				path: '.opencode/skills/deep-dive/SKILL.md',
				actions: ['graph_health', 'context_pack'],
			},
			{
				path: '.opencode/skills/codebase-review-swarm/SKILL.md',
				actions: ['graph_health', 'context_pack', 'route_trace', 'data_trace'],
			},
			{
				path: '.opencode/skills/swarm-pr-review/SKILL.md',
				actions: ['diff_context', 'impact_cone'],
			},
			{
				path: '.opencode/skills/swarm-pr-review/references/prompt-templates.md',
				actions: ['diff_context', 'impact_cone', 'route_trace', 'data_trace'],
			},
			{
				path: '.opencode/skills/writing-tests/SKILL.md',
				actions: ['test_pack'],
			},
			{
				path: '.opencode/skills/running-tests/SKILL.md',
				actions: ['test_pack'],
			},
			{
				path: '.opencode/skills/critic-gate/SKILL.md',
				actions: ['graph_health', 'impact_cone'],
			},
			{
				path: '.opencode/skills/phase-wrap/SKILL.md',
				actions: ['diff_context', 'impact_cone', 'test_pack'],
			},
			{
				path: '.opencode/skills/engineering-conventions/SKILL.md',
				actions: ['impact_cone'],
			},
			{
				path: '.opencode/skills/commit-pr/SKILL.md',
				actions: ['diff_context', 'impact_cone'],
			},
			{
				path: '.claude/skills/engineering-conventions/SKILL.md',
				actions: ['impact_cone'],
			},
			{
				path: '.claude/skills/commit-pr/SKILL.md',
				actions: ['diff_context', 'impact_cone'],
			},
		];

		for (const surface of surfaces) {
			expectGraphContract(readRepoFile(surface.path), surface.actions);
		}
	});
});
