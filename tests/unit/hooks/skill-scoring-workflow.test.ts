/**
 * Tests for workflow skill scoring boost (#1234 Part 4D) and score clamping.
 *
 * NOTE: this file is currently quarantined in scripts/ci/quarantined-tests.txt
 * (merge-group flake). The freezeClock wraps below are the root-cause fix
 * (root-cause class 1: time-sensitive assertions — computeSkillRelevanceScore
 * is a continuous function of Date.now() via computeRecencyScore, and
 * makeUsageEntry stamps entries with live new Date().toISOString()). The file
 * stays quarantined until a merge-group run confirms greenness on all 3 OSes
 * (issue #1782, plan critic H1 — un-quarantine is gated, not in this PR).
 */

import { describe, expect, it } from 'bun:test';
import {
	computeSkillRelevanceScore,
	parseSkillFrontmatter,
	type SkillMetadata,
} from '../../../src/hooks/skill-scoring.js';
import type { SkillUsageEntry } from '../../../src/hooks/skill-usage-log.js';
import { withFrozenClock } from '../../helpers/test-clock.js';

function makeUsageEntry(
	skillPath: string,
	overrides: Partial<SkillUsageEntry> = {},
): SkillUsageEntry {
	return {
		skillPath,
		agentName: 'coder',
		taskID: 'task-1',
		timestamp: new Date().toISOString(),
		sessionID: 's1',
		complianceVerdict: 'compliant' as const,
		...overrides,
	} as SkillUsageEntry;
}

describe('parseSkillFrontmatter: skill_type', () => {
	it('parses skill_type: workflow', () => {
		const content = [
			'---',
			'name: Edit-Test-Lint Flow',
			'description: A workflow for code changes',
			'skill_type: workflow',
			'---',
			'# Body',
		].join('\n');

		const meta = parseSkillFrontmatter(
			content,
			'skills/edit-test-lint/SKILL.md',
		);
		expect(meta.skillType).toBe('workflow');
		expect(meta.name).toBe('Edit-Test-Lint Flow');
	});

	it('parses skill_type: directive', () => {
		const content = [
			'---',
			'name: Always run tests',
			'skill_type: directive',
			'description: Ensure tests run',
			'---',
		].join('\n');

		const meta = parseSkillFrontmatter(content, 'skills/run-tests/SKILL.md');
		expect(meta.skillType).toBe('directive');
	});

	it('ignores invalid skill_type values', () => {
		const content = [
			'---',
			'name: Test',
			'skill_type: invalid_value',
			'description: Test',
			'---',
		].join('\n');

		const meta = parseSkillFrontmatter(content, 'skills/test/SKILL.md');
		expect(meta.skillType).toBeUndefined();
	});

	it('returns no skillType when frontmatter has no skill_type', () => {
		const content = ['---', 'name: Simple', 'description: Simple', '---'].join(
			'\n',
		);

		const meta = parseSkillFrontmatter(content, 'skills/simple/SKILL.md');
		expect(meta.skillType).toBeUndefined();
	});
});

describe('computeSkillRelevanceScore: workflow boost', () => {
	const skillPath = '.opencode/skills/generated/edit-test-lint/SKILL.md';

	it('gives a workflow boost when skill_type is workflow and context matches', () => {
		// Freeze the clock: makeUsageEntry stamps with new Date().toISOString()
		// and computeSkillRelevanceScore reads Date.now() — freezing both makes
		// the relative ordering of scores deterministic (issue #1782).
		withFrozenClock(
			() => {
				const history = Array.from({ length: 5 }, (_, i) =>
					makeUsageEntry(skillPath, { taskID: `task-${i}` }),
				);

				const directiveMeta: SkillMetadata = {
					path: skillPath,
					name: 'edit-test-lint',
					description: 'A directive',
					skillType: 'directive',
				};

				const workflowMeta: SkillMetadata = {
					path: skillPath,
					name: 'edit-test-lint',
					description: 'A workflow',
					skillType: 'workflow',
				};

				const taskDescription = 'edit the file and run test and lint';

				const directiveScore = computeSkillRelevanceScore(
					skillPath,
					taskDescription,
					history,
					directiveMeta,
				);
				const workflowScore = computeSkillRelevanceScore(
					skillPath,
					taskDescription,
					history,
					workflowMeta,
				);

				expect(workflowScore).toBeGreaterThan(directiveScore);
			},
			{ fixedNow: 1_700_000_000_000 },
		);
	});

	it('does not give workflow boost when context does not match', () => {
		withFrozenClock(
			() => {
				const history = Array.from({ length: 5 }, (_, i) =>
					makeUsageEntry(skillPath, { taskID: `task-${i}` }),
				);

				const workflowMeta: SkillMetadata = {
					path: skillPath,
					name: 'edit-test-lint',
					description: 'A workflow',
					skillType: 'workflow',
				};

				const taskDescription = 'unrelated database migration task';

				const scoreWithMeta = computeSkillRelevanceScore(
					skillPath,
					taskDescription,
					history,
					workflowMeta,
				);
				const scoreWithoutMeta = computeSkillRelevanceScore(
					skillPath,
					taskDescription,
					history,
				);

				expect(scoreWithMeta).toBe(scoreWithoutMeta);
			},
			{ fixedNow: 1_700_000_000_000 },
		);
	});

	it('clamps score to 1.0 maximum', () => {
		withFrozenClock(
			() => {
				const history = Array.from({ length: 20 }, (_, i) =>
					makeUsageEntry(skillPath, {
						taskID: `task-${i}`,
						complianceVerdict: 'compliant',
						timestamp: new Date(1_700_000_000_000).toISOString(),
					}),
				);

				const workflowMeta: SkillMetadata = {
					path: skillPath,
					name: 'edit-test-lint',
					description: 'A workflow',
					skillType: 'workflow',
				};

				const taskDescription = 'edit test lint';

				const score = computeSkillRelevanceScore(
					skillPath,
					taskDescription,
					history,
					workflowMeta,
				);

				expect(score).toBeLessThanOrEqual(1.0);
			},
			{ fixedNow: 1_700_000_000_000 },
		);
	});

	it('clamps score to 1.0 even without workflow boost', () => {
		withFrozenClock(
			() => {
				const history = Array.from({ length: 20 }, (_, i) =>
					makeUsageEntry(skillPath, {
						taskID: `task-${i}`,
						complianceVerdict: 'compliant',
						timestamp: new Date(1_700_000_000_000).toISOString(),
					}),
				);

				const taskDescription = 'edit test lint';
				const score = computeSkillRelevanceScore(
					skillPath,
					taskDescription,
					history,
				);

				expect(score).toBeLessThanOrEqual(1.0);
			},
			{ fixedNow: 1_700_000_000_000 },
		);
	});
});
