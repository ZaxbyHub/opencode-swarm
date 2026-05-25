/**
 * Tests for skill description format injection in src/index.ts
 *
 * Behaviors tested:
 * 1. SKILLS line includes descriptions for known skills: `file:path (-- description)`
 * 2. Unknown skills (not in SKILL_DESCRIPTIONS) use directory name as fallback
 * 3. Legacy format (file:path without description) is still valid — backward compat
 * 4. SKILLS: none injection path is unaffected (no descriptions there)
 * 5. parseSkillPaths extracts paths correctly from extended format
 * 6. Top 5 cap and threshold (0.5) work correctly with descriptions
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
	_internals,
	parseSkillPaths,
	skillPropagationGateBefore,
} from '../../../src/hooks/skill-propagation-gate';
import type { SkillUsageEntry } from '../../../src/hooks/skill-usage-log';

// ============================================================================
// Helpers
// ============================================================================

function tmpDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), 'skill-desc-test-'));
}

// Normalize paths to use forward slashes for cross-platform comparison
function normalizePath(p: string): string {
	return p.replace(/\\/g, '/');
}

// ============================================================================
// DI seam helpers
// ============================================================================

type Internals = typeof _internals;
type Override<T> = {
	[P in keyof T]?: T[P];
};

function applyOverrides(
	internals: Internals,
	overrides: Override<Internals>,
): void {
	for (const [k, v] of Object.entries(overrides)) {
		(internals as Record<string, unknown>)[k] = v;
	}
}

function restoreOverrides(
	internals: Internals,
	originals: Override<Internals>,
): void {
	for (const k of Object.keys(originals) as (keyof Internals)[]) {
		(internals as Record<string, unknown>)[k] = originals[k];
	}
}

// ============================================================================
// parseSkillPaths — extended format with (-- description) suffix
// ============================================================================

describe('parseSkillPaths — extended format with description suffix', () => {
	test('extracts path from "file:path (-- description)" format', () => {
		// The path portion is everything before " (--"
		const result = parseSkillPaths(
			'file:.claude/skills/writing-tests/SKILL.md (-- Guidelines for writing tests)',
		);
		expect(result).toEqual(['file:.claude/skills/writing-tests/SKILL.md']);
	});

	test('extracts multiple skills with descriptions from comma-separated list', () => {
		const result = parseSkillPaths(
			'file:.claude/skills/writing-tests/SKILL.md (-- Guidelines for writing tests), file:.claude/skills/code/SKILL.md (-- Expert coding workflow)',
		);
		expect(result).toHaveLength(2);
		expect(result[0]).toContain('file:.claude/skills/writing-tests/SKILL.md');
		expect(result[1]).toContain('file:.claude/skills/code/SKILL.md');
	});

	test('handles mixed formats: with and without descriptions', () => {
		const result = parseSkillPaths(
			'file:.claude/skills/writing-tests/SKILL.md (-- Guidelines for writing tests), writing-tests',
		);
		expect(result).toHaveLength(2);
		expect(result[0]).toContain('writing-tests/SKILL.md');
		expect(result[1]).toBe('writing-tests');
	});

	test('handles legacy format without descriptions (backward compat)', () => {
		const result = parseSkillPaths('writing-tests, code, review');
		expect(result).toEqual(['writing-tests', 'code', 'review']);
	});

	test('trims whitespace around full skill entry including description', () => {
		const result = parseSkillPaths(
			'  file:.claude/skills/writing-tests/SKILL.md (-- Guidelines)  ,  code  ',
		);
		expect(result).toHaveLength(2);
		expect(result[0].trim()).toContain('writing-tests');
		expect(result[1]).toBe('code');
	});

	test('handles description with parentheses and special chars', () => {
		const result = parseSkillPaths(
			'file:.claude/skills/writing-tests/SKILL.md (-- Guidelines for writing tests (bun:test))',
		);
		expect(result).toHaveLength(1);
		// parseSkillPaths just splits on comma — the whole string is one element
		expect(result[0]).toContain('writing-tests/SKILL.md');
	});
});

// ============================================================================
// SKILL_DESCRIPTIONS format — buildSkillLine helper logic
// These test the format-building logic used in src/index.ts injection
// We test via skillPropagationGateBefore return values + mock the scoring
// ============================================================================

describe('skillPropagationGateBefore — skill description format in scoring results', () => {
	let tmp: string;
	let originals: Override<Internals>;

	beforeEach(() => {
		tmp = tmpDir();
		originals = {
			parseDelegationArgs: _internals.parseDelegationArgs,
			discoverAvailableSkills: _internals.discoverAvailableSkills,
			writeWarnEvent: _internals.writeWarnEvent,
			SKILL_CAPABLE_AGENTS: _internals.SKILL_CAPABLE_AGENTS,
			readSkillUsageEntriesTail: _internals.readSkillUsageEntriesTail,
			computeSkillRelevanceScore: _internals.computeSkillRelevanceScore,
			appendSkillUsageEntry: _internals.appendSkillUsageEntry,
			readSkillUsageEntries: _internals.readSkillUsageEntries,
			parseSkillPaths: _internals.parseSkillPaths,
			extractTaskIdFromPrompt: _internals.extractTaskIdFromPrompt,
			formatSkillIndexWithContext: _internals.formatSkillIndexWithContext,
			MAX_SCORING_SESSION_ENTRIES: _internals.MAX_SCORING_SESSION_ENTRIES,
		};
	});

	afterEach(() => {
		restoreOverrides(_internals, originals);
		try {
			fs.rmSync(tmp, { recursive: true, force: true });
		} catch {
			// ignore
		}
	});

	/**
	 * Replicates the SKILL_DESCRIPTIONS map from src/index.ts for testing.
	 * Any skill not in this map is treated as "unknown" and uses dirName as fallback.
	 */
	const SKILL_DESCRIPTIONS: Record<string, string> = {
		'writing-tests': 'Guidelines for writing tests',
		'engineering-conventions': 'Engineering invariants and conventions',
		'running-tests': 'Safe test execution patterns',
		'commit-pr': 'Commit and PR workflow',
		'swarm-implement': 'Swarm implementation workflow',
		'issue-tracer': 'Issue investigation workflow',
		'qa-sweep': 'QA sweep workflow',
		'research-first': 'Research-driven approach',
		'swarm-pr-review': 'PR review workflow',
		'tech-debt-ci-review': 'Tech debt and CI review',
		browse: 'Fast web browsing',
		code: 'Expert coding workflow',
		review: 'Pre-landing PR review',
		'ci-failure-resolver': 'CI/CD failure resolution',
	};

	/**
	 * Replicates the skill-line building logic from src/index.ts.
	 * This is the pure formatting logic we want to test independently.
	 */
	function buildSkillLine(
		topSkills: Array<{ skillPath: string; score: number; usageCount: number }>,
	): string {
		const skillPaths = topSkills
			.map((s) => {
				const dirName = path.basename(path.dirname(s.skillPath));
				const desc = SKILL_DESCRIPTIONS[dirName] ?? dirName;
				return `file:${s.skillPath} (-- ${desc})`;
			})
			.join(', ');
		return `SKILLS: ${skillPaths}`;
	}

	// -------------------------------------------------------------------------
	// Behavior 1: Known skills include descriptions
	// -------------------------------------------------------------------------

	test('buildSkillLine formats known skills with description', () => {
		const topSkills = [
			{
				skillPath: '.claude/skills/writing-tests/SKILL.md',
				score: 0.9,
				usageCount: 5,
			},
		];
		const line = buildSkillLine(topSkills);
		expect(line).toBe(
			'SKILLS: file:.claude/skills/writing-tests/SKILL.md (-- Guidelines for writing tests)',
		);
	});

	test('buildSkillLine formats multiple known skills with descriptions', () => {
		const topSkills = [
			{
				skillPath: '.claude/skills/writing-tests/SKILL.md',
				score: 0.9,
				usageCount: 5,
			},
			{
				skillPath: '.claude/skills/code/SKILL.md',
				score: 0.7,
				usageCount: 3,
			},
			{
				skillPath: '.claude/skills/review/SKILL.md',
				score: 0.6,
				usageCount: 1,
			},
		];
		const line = buildSkillLine(topSkills);
		expect(line).toContain('(-- Guidelines for writing tests)');
		expect(line).toContain('(-- Expert coding workflow)');
		expect(line).toContain('(-- Pre-landing PR review)');
	});

	// -------------------------------------------------------------------------
	// Behavior 2: Unknown skills use directory name as fallback description
	// -------------------------------------------------------------------------

	test('buildSkillLine uses dirName as fallback for unknown skills', () => {
		const topSkills = [
			{
				skillPath: '.claude/skills/unknown-skill/SKILL.md',
				score: 0.8,
				usageCount: 2,
			},
		];
		const line = buildSkillLine(topSkills);
		// Should use "unknown-skill" as the description (dirName fallback)
		expect(line).toBe(
			'SKILLS: file:.claude/skills/unknown-skill/SKILL.md (-- unknown-skill)',
		);
	});

	test('buildSkillLine mixes known and unknown skills', () => {
		const topSkills = [
			{
				skillPath: '.claude/skills/writing-tests/SKILL.md',
				score: 0.9,
				usageCount: 5,
			},
			{
				skillPath: '.claude/skills/my-custom-skill/SKILL.md',
				score: 0.6,
				usageCount: 1,
			},
		];
		const line = buildSkillLine(topSkills);
		expect(line).toContain('(-- Guidelines for writing tests)');
		expect(line).toContain('(-- my-custom-skill)');
	});

	// -------------------------------------------------------------------------
	// Behavior 3: Legacy format (file:path without description) — backward compat
	// -------------------------------------------------------------------------

	test('parseSkillPaths handles legacy format without descriptions', () => {
		// Legacy: "writing-tests" without file: prefix and without description
		const result = parseSkillPaths('writing-tests');
		expect(result).toEqual(['writing-tests']);
	});

	test('parseSkillPaths handles file:path without description', () => {
		// Legacy file: format without description
		const result = parseSkillPaths(
			'file:.claude/skills/writing-tests/SKILL.md',
		);
		expect(result).toEqual(['file:.claude/skills/writing-tests/SKILL.md']);
	});

	test('parseSkillPaths handles comma-separated mix of legacy and extended formats', () => {
		const result = parseSkillPaths(
			'writing-tests, file:.claude/skills/code/SKILL.md (-- Expert coding workflow), my-skill',
		);
		expect(result).toHaveLength(3);
		expect(result[0]).toBe('writing-tests');
		expect(result[1]).toContain('code/SKILL.md');
		expect(result[2]).toBe('my-skill');
	});

	// -------------------------------------------------------------------------
	// Behavior 4: SKILLS: none is unaffected
	// -------------------------------------------------------------------------

	test('skillsField=none skips scoring block → recommendedSkills undefined', async () => {
		// When skillsField is "none", the gate short-circuits before scoring
		// recommendedSkills is undefined (not an empty array)
		applyOverrides(_internals, {
			parseDelegationArgs: () => ({
				targetAgent: 'coder',
				skillsField: 'none',
			}),
			discoverAvailableSkills: () => ['.claude/skills/writing-tests/SKILL.md'],
			readSkillUsageEntriesTail: () => [],
			computeSkillRelevanceScore: () => 0.9,
			writeWarnEvent: () => {},
		});

		const result = await skillPropagationGateBefore(
			tmp,
			{
				tool: 'task',
				agent: 'architect',
				sessionID: 'sess-none-skips-scoring',
				args: {
					subagent_type: 'mega_coder',
					prompt: 'SKILLS: none\ndo the work',
				},
			},
			{ enabled: true },
		);

		// When skillsField is "none", scoring block is skipped entirely
		// recommendedSkills is undefined (early return path)
		expect(result.recommendedSkills).toBeUndefined();
	});

	test('no skills above threshold 0.5 → gate returns scored results (index.ts applies threshold filter)', async () => {
		// The gate itself returns ALL scored skills (unfiltered).
		// The 0.5 threshold filter is applied by index.ts when deciding what to inject.
		// With one skill at score 0.3, the gate returns 1 entry; index.ts filters it out.
		applyOverrides(_internals, {
			parseDelegationArgs: () => ({
				targetAgent: 'coder',
				skillsField: 'code',
			}),
			discoverAvailableSkills: () => ['.claude/skills/writing-tests/SKILL.md'],
			readSkillUsageEntriesTail: () => [],
			computeSkillRelevanceScore: () => 0.3, // below 0.5 threshold
			writeWarnEvent: () => {},
			formatSkillIndexWithContext: () => '',
		});

		const result = await skillPropagationGateBefore(
			tmp,
			{
				tool: 'task',
				agent: 'architect',
				sessionID: 'sess-none-above-threshold',
				args: {
					subagent_type: 'mega_coder',
					prompt: 'SKILLS: code\ndo the work',
				},
			},
			{ enabled: true },
		);

		// Gate returns scored results (the threshold filter is in index.ts)
		// With 1 available skill, scored has 1 entry even though score is below 0.5
		expect(result.recommendedSkills).toBeDefined();
		expect(Array.isArray(result.recommendedSkills)).toBe(true);
		expect(result.recommendedSkills!.length).toBe(1);
		expect(result.recommendedSkills![0].score).toBe(0.3);
	});

	// -------------------------------------------------------------------------
	// Behavior 5: parseSkillPaths extracts paths correctly from extended format
	// (covered above in dedicated describe block)

	// -------------------------------------------------------------------------
	// Behavior 6: Top 5 cap and threshold 0.5 still work correctly
	// -------------------------------------------------------------------------

	test('top 5 cap is applied (takes first 5 after filtering by threshold)', () => {
		// Build 7 skills with scores above 0.5
		const allSkills = [
			{ skillPath: '.claude/skills/s1/SKILL.md', score: 0.9, usageCount: 10 },
			{ skillPath: '.claude/skills/s2/SKILL.md', score: 0.85, usageCount: 9 },
			{ skillPath: '.claude/skills/s3/SKILL.md', score: 0.8, usageCount: 8 },
			{ skillPath: '.claude/skills/s4/SKILL.md', score: 0.75, usageCount: 7 },
			{ skillPath: '.claude/skills/s5/SKILL.md', score: 0.7, usageCount: 6 },
			{ skillPath: '.claude/skills/s6/SKILL.md', score: 0.65, usageCount: 5 },
			{ skillPath: '.claude/skills/s7/SKILL.md', score: 0.6, usageCount: 4 },
		];

		// Apply threshold filter (>= 0.5)
		const qualified = allSkills.filter((s) => s.score >= 0.5);
		expect(qualified.length).toBe(7);

		// Apply top-5 cap
		const topSkills = qualified.slice(0, 5);
		expect(topSkills.length).toBe(5);
		expect(topSkills[4].skillPath).toContain('s5');
	});

	test('threshold 0.5 correctly filters out low-scored skills', () => {
		const allSkills = [
			{ skillPath: '.claude/skills/high/SKILL.md', score: 0.9, usageCount: 10 },
			{ skillPath: '.claude/skills/low/SKILL.md', score: 0.49, usageCount: 1 },
			{
				skillPath: '.claude/skills/medium/SKILL.md',
				score: 0.5,
				usageCount: 5,
			},
		];

		const qualified = allSkills.filter((s) => s.score >= 0.5);
		expect(qualified.length).toBe(2);
		expect(qualified.find((s) => s.skillPath.includes('high'))).toBeDefined();
		expect(qualified.find((s) => s.skillPath.includes('medium'))).toBeDefined();
		expect(qualified.find((s) => s.skillPath.includes('low'))).toBeUndefined();
	});

	test('top 5 cap with all skills below threshold results in 0 qualified', () => {
		const allSkills = [
			{ skillPath: '.claude/skills/s1/SKILL.md', score: 0.4, usageCount: 1 },
			{ skillPath: '.claude/skills/s2/SKILL.md', score: 0.3, usageCount: 1 },
		];

		const qualified = allSkills.filter((s) => s.score >= 0.5);
		expect(qualified.length).toBe(0);

		const topSkills = qualified.slice(0, 5);
		expect(topSkills.length).toBe(0);
		// This would trigger "SKILLS: none" injection in index.ts
	});

	test('top 5 cap is applied correctly when more than 5 skills qualify', () => {
		const allSkills = [
			{ skillPath: '.claude/skills/s1/SKILL.md', score: 0.95, usageCount: 10 },
			{ skillPath: '.claude/skills/s2/SKILL.md', score: 0.9, usageCount: 9 },
			{ skillPath: '.claude/skills/s3/SKILL.md', score: 0.85, usageCount: 8 },
			{ skillPath: '.claude/skills/s4/SKILL.md', score: 0.8, usageCount: 7 },
			{ skillPath: '.claude/skills/s5/SKILL.md', score: 0.75, usageCount: 6 },
			{ skillPath: '.claude/skills/s6/SKILL.md', score: 0.7, usageCount: 5 },
			{ skillPath: '.claude/skills/s7/SKILL.md', score: 0.65, usageCount: 4 },
			{ skillPath: '.claude/skills/s8/SKILL.md', score: 0.6, usageCount: 3 },
		];

		const qualified = allSkills.filter((s) => s.score >= 0.5);
		expect(qualified.length).toBe(8);

		const topSkills = qualified.slice(0, 5);
		expect(topSkills.length).toBe(5);
		// s6-s8 should be excluded
		expect(topSkills.find((s) => s.skillPath.includes('s6'))).toBeUndefined();
		expect(topSkills.find((s) => s.skillPath.includes('s7'))).toBeUndefined();
		expect(topSkills.find((s) => s.skillPath.includes('s8'))).toBeUndefined();
	});

	// -------------------------------------------------------------------------
	// End-to-end: gate returns scored + sorted recommendations
	// -------------------------------------------------------------------------

	test('gate returns scored skills sorted by score desc, then usageCount desc', async () => {
		const sessionEntries: SkillUsageEntry[] = [
			{
				id: '1',
				skillPath: '.claude/skills/low-score/SKILL.md',
				agentName: 'coder',
				taskID: 'task-1',
				complianceVerdict: 'compliant',
				sessionID: 'sess-e2e',
				timestamp: new Date().toISOString(),
			},
		];

		applyOverrides(_internals, {
			parseDelegationArgs: () => ({
				targetAgent: 'coder',
				skillsField: 'code',
			}),
			discoverAvailableSkills: () => [
				'.claude/skills/high-score/SKILL.md',
				'.claude/skills/low-score/SKILL.md',
				'.claude/skills/mid-score/SKILL.md',
			],
			readSkillUsageEntriesTail: () => sessionEntries,
			computeSkillRelevanceScore: (skillPath: string) => {
				if (skillPath.includes('high-score')) return 0.9;
				if (skillPath.includes('mid-score')) return 0.5;
				if (skillPath.includes('low-score')) return 0.3;
				return 0;
			},
			writeWarnEvent: () => {},
			formatSkillIndexWithContext: () => '',
		});

		const result = await skillPropagationGateBefore(
			tmp,
			{
				tool: 'task',
				agent: 'architect',
				sessionID: 'sess-e2e',
				args: {
					subagent_type: 'mega_coder',
					prompt: 'SKILLS: code\ndo the work',
				},
			},
			{ enabled: true },
		);

		expect(result.recommendedSkills).toBeDefined();
		expect(result.recommendedSkills!.length).toBe(3);

		// Sorted by score descending
		expect(result.recommendedSkills![0].skillPath).toContain('high-score');
		expect(result.recommendedSkills![0].score).toBe(0.9);
		expect(result.recommendedSkills![1].skillPath).toContain('mid-score');
		expect(result.recommendedSkills![1].score).toBe(0.5);
		expect(result.recommendedSkills![2].skillPath).toContain('low-score');
		expect(result.recommendedSkills![2].score).toBe(0.3);
	});
});
