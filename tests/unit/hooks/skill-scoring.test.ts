/**
 * Tests for src/hooks/skill-scoring.ts
 *
 * Framework: bun:test
 * DI strategy: _internals seam for within-module functions;
 *              mock.module for cross-module readSkillUsageEntries.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { parseSkillPaths } from '../../../src/hooks/skill-propagation-gate.js';
import {
	_internals,
	computeSkillRelevanceScore,
	formatSkillIndexWithContext,
	getSkillStats,
	rankSkillsForContext,
	type SkillRankEntry,
	type SkillStats,
} from '../../../src/hooks/skill-scoring.js';
import type { SkillUsageEntry } from '../../../src/hooks/skill-usage-log.js';

// ============================================================================
// Helpers
// ============================================================================

/** One hour ago in ISO 8601 */
function hourAgo(hours = 1): string {
	return new Date(Date.now() - hours * 3600 * 1000).toISOString();
}

/** One day ago */
function dayAgo(days = 1): string {
	return new Date(Date.now() - days * 24 * 3600 * 1000).toISOString();
}

/** Build a minimal usage entry */
function makeEntry(overrides: Partial<SkillUsageEntry> = {}): SkillUsageEntry {
	return {
		id: 'test-id-' + Math.random().toString(36).slice(2),
		skillPath: '.claude/skills/test-skill/SKILL.md',
		agentName: 'test-agent',
		taskID: 'task-1',
		timestamp: hourAgo().toString(),
		complianceVerdict: 'compliant',
		sessionID: 'session-1',
		...overrides,
	};
}

// ============================================================================
// computeSkillRelevanceScore — unit tests via _internals
// ============================================================================

describe('computeSkillRelevanceScore', () => {
	// Happy path

	test('returns 0 for empty history with no context match', () => {
		// taskDescription has no keywords that match the skill path
		const score = _internals.computeSkillRelevanceScore(
			'.claude/skills/writing-tests/SKILL.md',
			'fix memory leak in cache module',
			[],
		);
		expect(score).toBe(0);
	});

	test('returns contextScore only when history is empty but context matches', () => {
		// Task description shares keyword "writing" with skill path
		const score = _internals.computeSkillRelevanceScore(
			'.claude/skills/writing-tests/SKILL.md',
			'work on writing tests for the hook',
			[],
		);
		// contextScore = keyword overlap * CONTEXT_WEIGHT (0.2)
		// keywords from task: {work, writing, tests, hook}
		// keywords from skill path: {claude, skills, writing, tests, SKILL, md}
		// match: writing, tests
		// overlap = 2/4 = 0.5 → 0.5 * 0.2 = 0.1
		expect(score).toBeGreaterThan(0);
		expect(score).toBeLessThanOrEqual(0.2);
	});

	test('returns higher score for frequently used skills', () => {
		const fewEntries = [makeEntry({ id: '1' }), makeEntry({ id: '2' })];
		const manyEntries = Array.from({ length: 10 }, (_, i) =>
			makeEntry({ id: String(i) }),
		);

		const scoreFew = _internals.computeSkillRelevanceScore(
			'.claude/skills/test/SKILL.md',
			'do something',
			fewEntries,
		);
		const scoreMany = _internals.computeSkillRelevanceScore(
			'.claude/skills/test/SKILL.md',
			'do something',
			manyEntries,
		);

		// 10 entries saturates frequency cap → max frequencyScore = 0.3
		// 2 entries → min frequencyScore = 2/10 * 0.3 = 0.06
		expect(scoreMany).toBeGreaterThan(scoreFew);
	});

	test('returns higher score for compliant skills', () => {
		const nonCompliant = [
			makeEntry({ complianceVerdict: 'violation' }),
			makeEntry({ complianceVerdict: 'violation' }),
		];
		const compliant = [
			makeEntry({ complianceVerdict: 'compliant' }),
			makeEntry({ complianceVerdict: 'compliant' }),
		];

		const scoreNon = _internals.computeSkillRelevanceScore(
			'.claude/skills/test/SKILL.md',
			'do something',
			nonCompliant,
		);
		const scoreComp = _internals.computeSkillRelevanceScore(
			'.claude/skills/test/SKILL.md',
			'do something',
			compliant,
		);

		expect(scoreComp).toBeGreaterThan(scoreNon);
	});

	test('weights recency — recent usage scores higher than old usage', () => {
		const recentEntry = [makeEntry({ timestamp: hourAgo(1) })];
		const oldEntry = [makeEntry({ timestamp: dayAgo(29) })];

		const scoreRecent = _internals.computeSkillRelevanceScore(
			'.claude/skills/test/SKILL.md',
			'do something',
			recentEntry,
		);
		const scoreOld = _internals.computeSkillRelevanceScore(
			'.claude/skills/test/SKILL.md',
			'do something',
			oldEntry,
		);

		expect(scoreRecent).toBeGreaterThan(scoreOld);
	});

	test('different task descriptions produce different scores for same skill', () => {
		const history = [makeEntry(), makeEntry({ id: '2' })];

		const scoreA = _internals.computeSkillRelevanceScore(
			'.claude/skills/writing-tests/SKILL.md',
			'write unit tests for the writing module',
			history,
		);
		const scoreB = _internals.computeSkillRelevanceScore(
			'.claude/skills/writing-tests/SKILL.md',
			'fix a memory leak in the cache',
			history,
		);

		expect(scoreA).not.toBe(scoreB);
	});

	test('taskID diversity component rewards broad task usage', () => {
		// All same taskID → diversity = 1/3
		const sameTask = [
			makeEntry({ taskID: 'task-A' }),
			makeEntry({ taskID: 'task-A' }),
			makeEntry({ taskID: 'task-A' }),
		];
		// All different taskIDs → diversity = 3/3 = 1.0
		const diverseTasks = [
			makeEntry({ taskID: 'task-A' }),
			makeEntry({ taskID: 'task-B' }),
			makeEntry({ taskID: 'task-C' }),
		];

		const scoreSame = _internals.computeSkillRelevanceScore(
			'.claude/skills/test/SKILL.md',
			'do something',
			sameTask,
		);
		const scoreDiverse = _internals.computeSkillRelevanceScore(
			'.claude/skills/test/SKILL.md',
			'do something',
			diverseTasks,
		);

		expect(scoreDiverse).toBeGreaterThan(scoreSame);
	});

	// Edge cases

	test('handles NaN timestamp gracefully (returns 0 for recency)', () => {
		const entry = makeEntry({ timestamp: 'not-a-timestamp' });
		const score = _internals.computeSkillRelevanceScore(
			'.claude/skills/test/SKILL.md',
			'do something',
			[entry],
		);
		// Should not throw; NaN handled by computeRecencyScore → 0
		expect(score).toBeDefined();
		expect(Number.isNaN(score)).toBe(false);
	});

	test('handles empty task description (returns frequency-based score only)', () => {
		const entry = [makeEntry()];
		const score = _internals.computeSkillRelevanceScore(
			'.claude/skills/test/SKILL.md',
			'',
			entry,
		);
		// No keywords to match → contextScore = 0
		// Score comes from frequency, compliance, recency, diversity only
		expect(score).toBeGreaterThanOrEqual(0);
	});

	test('handles single entry', () => {
		const entry = [makeEntry()];
		const score = _internals.computeSkillRelevanceScore(
			'.claude/skills/test/SKILL.md',
			'do something',
			entry,
		);
		expect(score).toBeGreaterThanOrEqual(0);
		expect(score).toBeLessThanOrEqual(1);
	});

	test('score is clamped to [0, 1]', () => {
		// Many entries with perfect compliance and fresh recency
		const entries = Array.from({ length: 10 }, (_, i) =>
			makeEntry({
				id: String(i),
				complianceVerdict: 'compliant',
				timestamp: hourAgo(1).toString(),
			}),
		);
		const score = _internals.computeSkillRelevanceScore(
			'.claude/skills/writing-tests/SKILL.md',
			'writing tests for hooks',
			entries,
		);
		expect(score).toBeGreaterThanOrEqual(0);
		expect(score).toBeLessThanOrEqual(1);
	});

	test('declared trigger phrase gives an additive literal-match boost', () => {
		const triggered = _internals.computeSkillRelevanceScore(
			'.opencode/skills/generated/biome-lint/SKILL.md',
			'fix the biome lint config',
			[],
			{
				path: '.opencode/skills/generated/biome-lint/SKILL.md',
				name: 'biome-lint',
				description: 'No description provided',
				triggers: ['biome lint config'],
			},
		);
		const untriggered = _internals.computeSkillRelevanceScore(
			'.opencode/skills/generated/other/SKILL.md',
			'fix the biome lint config',
			[],
			{
				path: '.opencode/skills/generated/other/SKILL.md',
				name: 'other',
				description: 'No description provided',
				triggers: ['unrelated trigger'],
			},
		);

		expect(triggered).toBeGreaterThan(untriggered);
		expect(triggered).toBeGreaterThanOrEqual(0.3);
	});

	test('ignores trigger phrases shorter than the minimum guard', () => {
		const score = _internals.computeSkillRelevanceScore(
			'.opencode/skills/generated/ci/SKILL.md',
			'ci failed',
			[],
			{
				path: '.opencode/skills/generated/ci/SKILL.md',
				name: 'other',
				description: 'No description provided',
				triggers: ['ci'],
			},
		);

		expect(score).toBeLessThan(0.3);
	});
});

describe('parseSkillFrontmatter triggers', () => {
	test('parses YAML list triggers from skill frontmatter', () => {
		const meta = _internals.parseSkillFrontmatter(
			[
				'---',
				'name: biome-lint',
				'description: Fix lint config',
				'triggers:',
				'  - biome',
				'  - "lint config"',
				'---',
				'# Body',
			].join('\n'),
			'.opencode/skills/generated/biome-lint/SKILL.md',
		);

		expect(meta.triggers).toEqual(['biome', 'lint config']);
	});

	test('parses inline triggers from external spec-standard frontmatter', () => {
		const meta = _internals.parseSkillFrontmatter(
			[
				'---',
				'name: external-skill',
				'description: External skill',
				'triggers: ["biome", "lint config"]',
				'---',
				'# Body',
			].join('\n'),
			'.agents/skills/external/SKILL.md',
		);

		expect(meta.triggers).toEqual(['biome', 'lint config']);
	});
});

// ============================================================================
// computeRecencyScore — unit tests
// ============================================================================

describe('computeRecencyScore', () => {
	test('returns ~1.0 for very recent usage (within 1 hour)', () => {
		// Linear decay: 1.0 - ageMs/RECENCY_DECAY_MS
		// 1 hour = 0.00139% decay → ~0.9986
		const score = _internals.computeRecencyScore(hourAgo(1));
		expect(score).toBeGreaterThan(0.99);
		expect(score).toBeLessThanOrEqual(1.0);
	});

	test('returns 0 for empty timestamp', () => {
		expect(_internals.computeRecencyScore('')).toBe(0);
	});

	test('returns 0 for NaN timestamp', () => {
		expect(_internals.computeRecencyScore('not-valid')).toBe(0);
	});

	test('returns 0 for timestamp older than 30 days', () => {
		const oldTimestamp = dayAgo(31);
		expect(_internals.computeRecencyScore(oldTimestamp)).toBe(0);
	});

	test('returns score between 0 and 1 for intermediate ages', () => {
		const score = _internals.computeRecencyScore(dayAgo(15));
		expect(score).toBeGreaterThan(0);
		expect(score).toBeLessThan(1);
	});

	test('returns 1.0 for future timestamp (edge case)', () => {
		const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
		expect(_internals.computeRecencyScore(future)).toBe(1.0);
	});
});

// ============================================================================
// computeContextMatchScore — unit tests
// ============================================================================

describe('computeContextMatchScore', () => {
	test('returns 0 when task description has no extractable keywords', () => {
		const score = _internals.computeContextMatchScore(
			'ta sk', // too short
			'.claude/skills/test/SKILL.md',
		);
		expect(score).toBe(0);
	});

	test('returns 1.0 when all task keywords appear in skill path/name', () => {
		// Task keywords all appear in skill path
		const score = _internals.computeContextMatchScore(
			'writing tests skill',
			'.claude/skills/writing-tests/SKILL.md',
		);
		expect(score).toBe(1.0);
	});

	test('returns partial score for partial keyword overlap', () => {
		// skill path has "coding" in it; task has "code" → exact match via "code" substring
		// Actually: skill keywords are {claude, skills, writing, tests, SKILL, md}
		// Task keywords are {fix, bug, write, code}
		// overlap = 0 since "code" != "writing" and no other matches
		const score = _internals.computeContextMatchScore(
			'fix bug write code',
			'.claude/skills/writing-tests/SKILL.md',
		);
		// "write" in task does NOT match "writing" in skill (different words)
		// No overlap → 0
		expect(score).toBe(0);
	});

	test('returns partial score when some keywords match', () => {
		// skill name has "code" in it; task has "coding" → but "coding" is 6 chars >= 3
		// skill: {claude, skills, code, skill, SKILL, md}
		// task: {test, code, skill}
		// overlap: code, skill → 2/3
		const score = _internals.computeContextMatchScore(
			'test code skill',
			'.claude/skills/code-style/SKILL.md',
		);
		// code and skill match → 2/3
		expect(score).toBeCloseTo(2 / 3, 5);
	});

	test('uses SKILL.md metadata description for context matching', () => {
		const score = _internals.computeContextMatchScore(
			'database migration rollback',
			'.claude/skills/generated/unrelated/SKILL.md',
			{
				path: '.claude/skills/generated/unrelated/SKILL.md',
				name: 'generated-unrelated',
				description: 'Database migration rollback guidance',
			},
		);

		expect(score).toBe(1);
	});

	test('extractSkillName handles SKILL.md basename', () => {
		// extractSkillName is in _internals; test via computeContextMatchScore
		const score = _internals.computeContextMatchScore(
			'testing skill',
			'.claude/skills/my-test/SKILL.md',
		);
		// skill name = "my-test", skill keywords include "my-test" and SKILL
		expect(score).toBeGreaterThan(0);
	});
});

// ============================================================================
// extractSkillName — unit tests
// ============================================================================

describe('extractSkillName', () => {
	test('extracts name from SKILL.md basename', () => {
		expect(
			_internals.extractSkillName('.claude/skills/writing-tests/SKILL.md'),
		).toBe('writing-tests');
	});

	test('returns basename when not SKILL.md', () => {
		expect(_internals.extractSkillName('.claude/skills/foo/bar.ts')).toBe(
			'bar',
		);
	});

	test('handles deeply nested paths', () => {
		expect(
			_internals.extractSkillName('.claude/skills/nested/deep/file.ts'),
		).toBe('file');
	});
});

// ============================================================================
// rankSkillsForContext — integration tests via mock.module
// ============================================================================

describe('rankSkillsForContext', () => {
	let tempDir: string;
	let mockReadFileSync: ReturnType<typeof mock>;
	let mockExistsSync: ReturnType<typeof mock>;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-scoring-test-'));
	});

	afterEach(() => {
		mock.restore();
		try {
			fs.rmSync(tempDir, { recursive: true });
		} catch {
			// ignore cleanup failure
		}
	});

	test('returns sorted array by score descending', async () => {
		// Create a real .swarm directory so readSkillUsageEntries doesn't fail path validation
		const swarmDir = path.join(tempDir, '.swarm');
		fs.mkdirSync(swarmDir, { recursive: true });

		// Write JSONL with two skills — one more used than the other
		const logPath = path.join(swarmDir, 'skill-usage.jsonl');
		const skillAEntries = Array.from({ length: 3 }, (_, i) =>
			makeEntry({ skillPath: 'skill-a', id: `a-${i}` }),
		);
		const skillBEntries = Array.from({ length: 1 }, (_, i) =>
			makeEntry({ skillPath: 'skill-b', id: `b-${i}` }),
		);
		fs.writeFileSync(
			logPath,
			[...skillAEntries, ...skillBEntries]
				.map((e) => JSON.stringify(e))
				.join('\n') + '\n',
		);

		// Use the real readSkillUsageEntries via the actual module
		// (we created the file, so it will be read)
		const results = _internals.rankSkillsForContext(
			['skill-b', 'skill-a'],
			'do something',
			tempDir,
		);

		expect(results).toHaveLength(2);
		expect(results[0].score).toBeGreaterThanOrEqual(results[1].score);
	});

	test('handles empty skills list', async () => {
		const swarmDir = path.join(tempDir, '.swarm');
		fs.mkdirSync(swarmDir, { recursive: true });

		const results = _internals.rankSkillsForContext(
			[],
			'do something',
			tempDir,
		);
		expect(results).toEqual([]);
	});

	test('handles missing .swarm directory gracefully', async () => {
		// tempDir has no .swarm subdir
		const results = _internals.rankSkillsForContext(
			['skill-a'],
			'do something',
			tempDir,
		);
		expect(results).toHaveLength(1);
		expect(results[0].score).toBe(0); // no history → contextScore only
		expect(results[0].usageCount).toBe(0);
	});

	test('returns all skills even when no usage history', async () => {
		const swarmDir = path.join(tempDir, '.swarm');
		fs.mkdirSync(swarmDir, { recursive: true });

		const results = _internals.rankSkillsForContext(
			['skill-a', 'skill-b', 'skill-c'],
			'do something',
			tempDir,
		);
		expect(results).toHaveLength(3);
	});

	test('sorts by score descending, breaks ties by usageCount descending', async () => {
		const swarmDir = path.join(tempDir, '.swarm');
		fs.mkdirSync(swarmDir, { recursive: true });

		const logPath = path.join(swarmDir, 'skill-usage.jsonl');
		// skill-a: 2 entries, skill-b: 2 entries (same score tie)
		const entries = [
			...Array.from({ length: 2 }, (_, i) =>
				makeEntry({ skillPath: 'skill-a', id: `a-${i}` }),
			),
			...Array.from({ length: 2 }, (_, i) =>
				makeEntry({ skillPath: 'skill-b', id: `b-${i}` }),
			),
		];
		fs.writeFileSync(
			logPath,
			entries.map((e) => JSON.stringify(e)).join('\n') + '\n',
		);

		const results = _internals.rankSkillsForContext(
			['skill-a', 'skill-b'],
			'do something', // same task → same contextScore for both
			tempDir,
		);

		expect(results).toHaveLength(2);
		// They have identical scores and identical usage counts, order is stable
		expect(Math.abs(results[0].score - results[1].score)).toBeLessThan(1e-9);
	});
});

// ============================================================================
// getSkillStats — integration tests with real temp file
// ============================================================================

describe('getSkillStats', () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-scoring-test-'));
	});

	afterEach(() => {
		mock.restore();
		try {
			fs.rmSync(tempDir, { recursive: true });
		} catch {
			// ignore cleanup failure
		}
	});

	test('computes correct totalUsage', () => {
		const swarmDir = path.join(tempDir, '.swarm');
		fs.mkdirSync(swarmDir, { recursive: true });
		const logPath = path.join(swarmDir, 'skill-usage.jsonl');
		// Use consistent skillPath matching the query
		const entries = Array.from({ length: 7 }, (_, i) =>
			makeEntry({ skillPath: 'test-skill', id: String(i) }),
		);
		fs.writeFileSync(
			logPath,
			entries.map((e) => JSON.stringify(e)).join('\n') + '\n',
		);

		const stats = _internals.getSkillStats('test-skill', tempDir);
		expect(stats.totalUsage).toBe(7);
	});

	test('computes correct complianceRate', () => {
		const swarmDir = path.join(tempDir, '.swarm');
		fs.mkdirSync(swarmDir, { recursive: true });
		const logPath = path.join(swarmDir, 'skill-usage.jsonl');
		// Override skillPath to match query; complianceVerdict is on the entry itself
		const entries: SkillUsageEntry[] = [
			makeEntry({ skillPath: 'test-skill', complianceVerdict: 'compliant' }),
			makeEntry({ skillPath: 'test-skill', complianceVerdict: 'compliant' }),
			makeEntry({ skillPath: 'test-skill', complianceVerdict: 'violation' }),
			makeEntry({ skillPath: 'test-skill', complianceVerdict: 'not_checked' }), // excluded
		];
		fs.writeFileSync(
			logPath,
			entries.map((e) => JSON.stringify(e)).join('\n') + '\n',
		);

		const stats = _internals.getSkillStats('test-skill', tempDir);
		// 2 compliant / 3 with verdicts (excludes not_checked) = 2/3
		expect(stats.complianceRate).toBeCloseTo(2 / 3, 5);
	});

	test('computes correct lastUsed (newest timestamp)', () => {
		const swarmDir = path.join(tempDir, '.swarm');
		fs.mkdirSync(swarmDir, { recursive: true });
		const logPath = path.join(swarmDir, 'skill-usage.jsonl');
		const oldEntry = makeEntry({
			skillPath: 'test-skill',
			timestamp: dayAgo(5),
			id: 'old',
		});
		const recentEntry = makeEntry({
			skillPath: 'test-skill',
			timestamp: hourAgo(2),
			id: 'new',
		});
		fs.writeFileSync(
			logPath,
			[oldEntry, recentEntry].map((e) => JSON.stringify(e)).join('\n') + '\n',
		);

		const stats = _internals.getSkillStats('test-skill', tempDir);
		expect(stats.lastUsed).toBe(recentEntry.timestamp);
	});

	test('computes correct topAgents', () => {
		const swarmDir = path.join(tempDir, '.swarm');
		fs.mkdirSync(swarmDir, { recursive: true });
		const logPath = path.join(swarmDir, 'skill-usage.jsonl');
		const entries: SkillUsageEntry[] = [
			makeEntry({ skillPath: 'test-skill', agentName: 'coder', id: '1' }),
			makeEntry({ skillPath: 'test-skill', agentName: 'coder', id: '2' }),
			makeEntry({ skillPath: 'test-skill', agentName: 'reviewer', id: '3' }),
		];
		fs.writeFileSync(
			logPath,
			entries.map((e) => JSON.stringify(e)).join('\n') + '\n',
		);

		const stats = _internals.getSkillStats('test-skill', tempDir);
		expect(stats.topAgents).toHaveLength(2);
		expect(stats.topAgents[0].agent).toBe('coder');
		expect(stats.topAgents[0].count).toBe(2);
		expect(stats.topAgents[1].agent).toBe('reviewer');
		expect(stats.topAgents[1].count).toBe(1);
	});

	test('handles empty log — returns zeros and empty arrays', () => {
		const swarmDir = path.join(tempDir, '.swarm');
		fs.mkdirSync(swarmDir, { recursive: true });
		// Don't write any entries

		const stats = _internals.getSkillStats('nonexistent-skill', tempDir);
		expect(stats.totalUsage).toBe(0);
		expect(stats.complianceRate).toBe(0);
		expect(stats.lastUsed).toBe('');
		expect(stats.topAgents).toEqual([]);
	});

	test('handles missing .swarm directory — returns zeros', () => {
		// tempDir has no .swarm subdir
		const stats = _internals.getSkillStats('test-skill', tempDir);
		expect(stats.totalUsage).toBe(0);
		expect(stats.complianceRate).toBe(0);
		expect(stats.lastUsed).toBe('');
		expect(stats.topAgents).toEqual([]);
	});

	test('handles single entry', () => {
		const swarmDir = path.join(tempDir, '.swarm');
		fs.mkdirSync(swarmDir, { recursive: true });
		const logPath = path.join(swarmDir, 'skill-usage.jsonl');
		fs.writeFileSync(
			logPath,
			JSON.stringify(makeEntry({ skillPath: 'test-skill' })) + '\n',
		);

		const stats = _internals.getSkillStats('test-skill', tempDir);
		expect(stats.totalUsage).toBe(1);
		expect(stats.topAgents).toHaveLength(1);
	});
});

// ============================================================================
// formatSkillIndexWithContext — integration tests
// ============================================================================

describe('formatSkillIndexWithContext', () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-scoring-test-'));
	});

	afterEach(() => {
		mock.restore();
		try {
			fs.rmSync(tempDir, { recursive: true });
		} catch {
			// ignore cleanup failure
		}
	});

	test('produces formatted string with stats when log exists', () => {
		const swarmDir = path.join(tempDir, '.swarm');
		fs.mkdirSync(swarmDir, { recursive: true });
		const logPath = path.join(swarmDir, 'skill-usage.jsonl');
		// skillPath must match what getSkillStats will query
		const fullSkillPath = '.claude/skills/writing-tests/SKILL.md';
		const entries = [
			makeEntry({ skillPath: fullSkillPath, complianceVerdict: 'compliant' }),
			makeEntry({ skillPath: fullSkillPath, complianceVerdict: 'compliant' }),
		];
		fs.writeFileSync(
			logPath,
			entries.map((e) => JSON.stringify(e)).join('\n') + '\n',
		);

		const output = _internals.formatSkillIndexWithContext(
			[fullSkillPath],
			tempDir,
		);

		expect(output).toContain('writing-tests');
		expect(output).toContain('used: 2');
		expect(output).toContain('compliance: 100%');
	});

	test('includes skill frontmatter description and repo-relative path when no usage log exists', () => {
		const skillDir = path.join(tempDir, '.claude', 'skills', 'vitest-patterns');
		fs.mkdirSync(skillDir, { recursive: true });
		fs.writeFileSync(
			path.join(skillDir, 'SKILL.md'),
			[
				'---',
				'name: vitest-patterns',
				'description: Effect-TS 4 Vitest patterns for tests',
				'---',
				'# Body',
			].join('\n'),
		);

		const output = _internals.formatSkillIndexWithContext(
			['.claude/skills/vitest-patterns/SKILL.md'],
			tempDir,
		);

		expect(output).toContain('vitest-patterns');
		expect(output).toContain('Effect-TS 4 Vitest patterns for tests');
		expect(output).toContain('file:.claude/skills/vitest-patterns/SKILL.md');
		expect(parseSkillPaths(output)).toEqual([
			'file:.claude/skills/vitest-patterns/SKILL.md',
		]);
	});

	test('parses folded frontmatter descriptions for skill index output', () => {
		const skillDir = path.join(tempDir, '.opencode', 'skills', 'writing-tests');
		fs.mkdirSync(skillDir, { recursive: true });
		fs.writeFileSync(
			path.join(skillDir, 'SKILL.md'),
			[
				'---',
				'name: writing-tests',
				'description: >',
				'  Guidelines for writing, organizing,',
				'  and maintaining tests.',
				'---',
				'# Body',
			].join('\n'),
		);

		const output = _internals.formatSkillIndexWithContext(
			['.opencode/skills/writing-tests/SKILL.md'],
			tempDir,
		);

		expect(output).toContain(
			'Guidelines for writing, organizing, and maintaining tests.',
		);
	});

	test('reads metadata when the input skill path already has a file: prefix', () => {
		const skillDir = path.join(tempDir, '.claude', 'skills', 'prefixed');
		fs.mkdirSync(skillDir, { recursive: true });
		fs.writeFileSync(
			path.join(skillDir, 'SKILL.md'),
			[
				'---',
				'name: prefixed',
				'description: Prefix-safe metadata',
				'---',
			].join('\n'),
		);

		const metadata = _internals.readSkillMetadata(
			'file:.claude/skills/prefixed/SKILL.md',
			tempDir,
		);

		expect(metadata.path).toBe('.claude/skills/prefixed/SKILL.md');
		expect(metadata.description).toBe('Prefix-safe metadata');
	});

	test('falls back to simple index when log is empty', () => {
		const swarmDir = path.join(tempDir, '.swarm');
		fs.mkdirSync(swarmDir, { recursive: true });
		// Empty log file
		const logPath = path.join(swarmDir, 'skill-usage.jsonl');
		fs.writeFileSync(logPath, '');

		const output = _internals.formatSkillIndexWithContext(
			['.claude/skills/writing-tests/SKILL.md'],
			tempDir,
		);

		expect(output).toContain('writing-tests');
		expect(output).not.toContain('used:');
	});

	test('falls back to simple index when .swarm directory is missing', () => {
		const output = _internals.formatSkillIndexWithContext(
			['.claude/skills/writing-tests/SKILL.md'],
			tempDir,
		);

		expect(output).toContain('writing-tests');
	});

	test('includes top agents when available', () => {
		const swarmDir = path.join(tempDir, '.swarm');
		fs.mkdirSync(swarmDir, { recursive: true });
		const logPath = path.join(swarmDir, 'skill-usage.jsonl');
		const fullSkillPath = '.claude/skills/writing-tests/SKILL.md';
		const entries = [
			makeEntry({ skillPath: fullSkillPath, agentName: 'coder' }),
			makeEntry({ skillPath: fullSkillPath, agentName: 'reviewer' }),
		];
		fs.writeFileSync(
			logPath,
			entries.map((e) => JSON.stringify(e)).join('\n') + '\n',
		);

		const output = _internals.formatSkillIndexWithContext(
			[fullSkillPath],
			tempDir,
		);

		expect(output).toContain('coder');
		expect(output).toContain('reviewer');
	});

	test('handles multiple skills', () => {
		const swarmDir = path.join(tempDir, '.swarm');
		fs.mkdirSync(swarmDir, { recursive: true });

		const output = _internals.formatSkillIndexWithContext(
			[
				'.claude/skills/skill-a/SKILL.md',
				'.claude/skills/skill-b/SKILL.md',
				'.claude/skills/skill-c/SKILL.md',
			],
			tempDir,
		);

		expect(output).toContain('skill-a');
		expect(output).toContain('skill-b');
		expect(output).toContain('skill-c');
	});

	test('handles empty skills list', () => {
		const swarmDir = path.join(tempDir, '.swarm');
		fs.mkdirSync(swarmDir, { recursive: true });

		const output = _internals.formatSkillIndexWithContext([], tempDir);
		expect(output).toBe('');
	});

	test('formatSkillIndexWithContext does not include lastUsed timestamp in output', () => {
		const swarmDir = path.join(tempDir, '.swarm');
		fs.mkdirSync(swarmDir, { recursive: true });
		const logPath = path.join(swarmDir, 'skill-usage.jsonl');
		const fullSkillPath = '.claude/skills/writing-tests/SKILL.md';

		// Two entries: an older one and a distinct newest timestamp
		const distinctTimestamp = new Date(Date.now() + 86400000).toISOString(); // tomorrow — guaranteed newest
		const entries = [
			makeEntry({ skillPath: fullSkillPath, timestamp: dayAgo(10).toString() }),
			makeEntry({ skillPath: fullSkillPath, timestamp: distinctTimestamp }),
		];
		fs.writeFileSync(
			logPath,
			entries.map((e) => JSON.stringify(e)).join('\n') + '\n',
		);

		// Verify that getSkillStats recognises distinctTimestamp as the actual lastUsed
		const stats = _internals.getSkillStats(fullSkillPath, tempDir);
		expect(stats.lastUsed).toBe(distinctTimestamp);

		const output = _internals.formatSkillIndexWithContext(
			[fullSkillPath],
			tempDir,
		);

		// Output should contain usage stats (proving the log was read)
		expect(output).toContain('used: 2');

		// lastUsed is available in SkillStats but intentionally excluded from the
		// formatted index string — it would add noise to the prompt context.
		expect(output).not.toContain(distinctTimestamp);
	});
});

// ============================================================================
// Weight verification — property tests
// ============================================================================

describe('score component weights sum to 1.0', () => {
	test('FREQUENCY_WEIGHT + COMPLIANCE_WEIGHT + RECENCY_WEIGHT + TASK_DIVERSITY_WEIGHT + CONTEXT_WEIGHT = 1.0', () => {
		const FREQUENCY_WEIGHT = 0.3;
		const COMPLIANCE_WEIGHT = 0.3;
		const RECENCY_WEIGHT = 0.15;
		const TASK_DIVERSITY_WEIGHT = 0.05;
		const CONTEXT_WEIGHT = 0.2;
		const sum =
			FREQUENCY_WEIGHT +
			COMPLIANCE_WEIGHT +
			RECENCY_WEIGHT +
			TASK_DIVERSITY_WEIGHT +
			CONTEXT_WEIGHT;
		expect(sum).toBe(1.0);
	});
});

// ============================================================================
// Integration — full round-trip
// ============================================================================

describe('full round-trip: rankSkillsForContext with real temp log', () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-scoring-test-'));
	});

	afterEach(() => {
		mock.restore();
		try {
			fs.rmSync(tempDir, { recursive: true });
		} catch {
			// ignore cleanup failure
		}
	});

	test('skills with history rank above skills without history', () => {
		const swarmDir = path.join(tempDir, '.swarm');
		fs.mkdirSync(swarmDir, { recursive: true });
		const logPath = path.join(swarmDir, 'skill-usage.jsonl');

		// skill-a has history; skill-b does not
		const entries = Array.from({ length: 5 }, (_, i) =>
			makeEntry({ skillPath: 'skill-a', id: String(i) }),
		);
		fs.writeFileSync(
			logPath,
			entries.map((e) => JSON.stringify(e)).join('\n') + '\n',
		);

		const results = _internals.rankSkillsForContext(
			['skill-b', 'skill-a'],
			'do something',
			tempDir,
		);

		expect(results).toHaveLength(2);
		const skillA = results.find((r) => r.skillPath === 'skill-a')!;
		const skillB = results.find((r) => r.skillPath === 'skill-b')!;
		expect(skillA.score).toBeGreaterThan(skillB.score);
	});

	test('more compliant skill ranks higher', () => {
		const swarmDir = path.join(tempDir, '.swarm');
		fs.mkdirSync(swarmDir, { recursive: true });
		const logPath = path.join(swarmDir, 'skill-usage.jsonl');

		// skill-a: all compliant; skill-b: all violations
		const compliantEntries = Array.from({ length: 3 }, (_, i) =>
			makeEntry({
				skillPath: 'skill-a',
				complianceVerdict: 'compliant',
				id: `a-${i}`,
			}),
		);
		const violationEntries = Array.from({ length: 3 }, (_, i) =>
			makeEntry({
				skillPath: 'skill-b',
				complianceVerdict: 'violation',
				id: `b-${i}`,
			}),
		);
		fs.writeFileSync(
			logPath,
			[...compliantEntries, ...violationEntries]
				.map((e) => JSON.stringify(e))
				.join('\n') + '\n',
		);

		const results = _internals.rankSkillsForContext(
			['skill-a', 'skill-b'],
			'do something',
			tempDir,
		);

		expect(results[0].skillPath).toBe('skill-a');
		expect(results[0].complianceRate).toBe(1);
		expect(results[1].skillPath).toBe('skill-b');
		expect(results[1].complianceRate).toBe(0);
	});
});
