import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createArchitectAgent } from '../../../src/agents/architect.js';
import { createCoderAgent } from '../../../src/agents/coder.js';
import { createCriticAgent } from '../../../src/agents/critic.js';
import { createReviewerAgent } from '../../../src/agents/reviewer.js';
import { createTestEngineerAgent } from '../../../src/agents/test-engineer.js';
import { AGENT_TOOL_MAP } from '../../../src/config/constants.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const GRAPH_SECTION_HEADING = '## Graph-first evidence contract';

const readRepoFile = (relativePath: string): string =>
	readFileSync(join(ROOT, relativePath), 'utf-8');

function extractSection(content: string, heading: string): string {
	const lines = content.split(/\r?\n/);
	const headingIndex = lines.findIndex((line) => line.trim() === heading);
	expect(headingIndex).toBeGreaterThanOrEqual(0);
	const sectionLines: string[] = [];
	for (let i = headingIndex + 1; i < lines.length; i++) {
		if (lines[i].startsWith('## ')) break;
		sectionLines.push(lines[i]);
	}
	return sectionLines.join('\n').trim();
}

function expectGraphContractSection(section: string, actions: string[]): void {
	expect(section).toContain('repo_map');
	for (const action of actions) {
		expect(section).toContain(action);
	}
	expect(section.toLowerCase()).toContain('advisory');
	expect(section.toLowerCase()).toContain('confidence is low');
	expect(section.toLowerCase()).toMatch(/direct (source|code)/);
	expect(section.toLowerCase()).toMatch(/stale|freshness|inconclusive/);
	expect(section.toLowerCase()).toMatch(/graph is absent|action fails/);
}

function expectCanonicalSkillAdapter(
	relativePath: string,
	canonicalRelativePath: string,
): void {
	const content = readRepoFile(relativePath);
	const escapedPath = canonicalRelativePath.replace(
		/[.*+?^${}()|[\]\\]/g,
		'\\$&',
	);
	expect(content).toMatch(
		new RegExp(
			'Read and follow `\\.\\.\\/\\.\\.\\/\\.\\.\\/' +
				escapedPath +
				'` as\\s+the canonical workflow\\.',
		),
	);
}

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
			expectGraphContractSection(surface.content, surface.actions);
		}
	});

	test('graph-using operative roles own repo_map in AGENT_TOOL_MAP', () => {
		for (const role of [
			'architect',
			'coder',
			'critic',
			'reviewer',
			'test_engineer',
		] as const) {
			expect(AGENT_TOOL_MAP[role]).toContain('repo_map');
		}
	});

	test('canonical skill files keep graph-first contract sections with exact actions and fallback language', () => {
		const sectionSurfaces = [
			{
				path: '.opencode/skills/swarm-plan/SKILL.md',
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
				useWholeContent: true,
			},
			{
				path: '.opencode/skills/commit-pr/SKILL.md',
				actions: ['diff_context', 'impact_cone'],
			},
			{
				path: '.claude/skills/swarm-plan/SKILL.md',
				actions: [
					'graph_health',
					'package_boundaries',
					'key_files',
					'context_pack',
				],
			},
			{
				path: '.claude/skills/deep-dive/SKILL.md',
				actions: ['graph_health', 'context_pack'],
			},
			{
				path: '.claude/skills/engineering-conventions/SKILL.md',
				actions: ['impact_cone'],
				useWholeContent: true,
			},
			{
				path: '.claude/skills/commit-pr/SKILL.md',
				actions: ['diff_context', 'impact_cone'],
			},
		];

		for (const surface of sectionSurfaces) {
			const content = readRepoFile(surface.path);
			expectGraphContractSection(
				surface.useWholeContent
					? content
					: extractSection(content, GRAPH_SECTION_HEADING),
				surface.actions,
			);
		}

		expectGraphContractSection(
			readRepoFile(
				'.opencode/skills/swarm-pr-review/references/prompt-templates.md',
			),
			['diff_context', 'impact_cone', 'route_trace', 'data_trace'],
		);
	});

	test('claude adapter skills keep pointing at canonical opencode contracts', () => {
		expectCanonicalSkillAdapter(
			'.claude/skills/execute/SKILL.md',
			'.opencode/skills/execute/SKILL.md',
		);
		expectCanonicalSkillAdapter(
			'.claude/skills/codebase-review-swarm/SKILL.md',
			'.opencode/skills/codebase-review-swarm/SKILL.md',
		);
		expectCanonicalSkillAdapter(
			'.claude/skills/swarm-pr-review/SKILL.md',
			'.opencode/skills/swarm-pr-review/SKILL.md',
		);
		expectCanonicalSkillAdapter(
			'.claude/skills/writing-tests/SKILL.md',
			'.opencode/skills/writing-tests/SKILL.md',
		);
		expectCanonicalSkillAdapter(
			'.claude/skills/phase-wrap/SKILL.md',
			'.opencode/skills/phase-wrap/SKILL.md',
		);
	});
});
