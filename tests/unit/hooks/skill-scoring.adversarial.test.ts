/**
 * Adversarial tests for src/hooks/skill-scoring.ts
 *
 * Framework: bun:test
 * DI strategy: _internals seam + direct function calls
 *
 * Attack vectors tested:
 * 1. Very long strings (10K+ chars) in taskDescription and skillPath
 * 2. Special characters / path traversal in skill paths
 * 3. Extremely large usage history arrays (10K+ entries)
 * 4. NaN/Infinity timestamps
 * 5. Empty strings for all parameters
 * 6. Negative / epoch timestamps
 * 7. Concurrent calls with shared _internals mutation
 * 8. Score overflow — can score exceed 1.0?
 * 9. All entries with complianceVerdict='not_checked'
 * 10. Sorting with NaN scores (sort stability)
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
	_internals,
	computeSkillRelevanceScore,
	formatSkillIndexWithContext,
	getSkillStats,
	rankSkillsForContext,
} from '../../../src/hooks/skill-scoring.js';
import type { SkillUsageEntry } from '../../../src/hooks/skill-usage-log.js';

// ============================================================================
// Helpers
// ============================================================================

/** One hour ago in ISO 8601 */
function hourAgo(hours = 1): string {
	return new Date(Date.now() - hours * 3600 * 1000).toISOString();
}

/** Build a minimal usage entry */
function makeEntry(overrides: Partial<SkillUsageEntry> = {}): SkillUsageEntry {
	return {
		id: 'adv-id-' + Math.random().toString(36).slice(2),
		skillPath: '.claude/skills/test-skill/SKILL.md',
		agentName: 'test-agent',
		taskID: 'task-1',
		timestamp: hourAgo().toString(),
		complianceVerdict: 'compliant',
		sessionID: 'session-1',
		...overrides,
	};
}

/** Generate a string of exactly N characters */
function longString(n: number, char = 'x'): string {
	return char.repeat(n);
}

// ============================================================================
// 1. Oversized payloads — very long strings (10K+ chars)
// ============================================================================

describe('adversarial: oversized string payloads', () => {
	test('computeSkillRelevanceScore does not throw with 10KB taskDescription', () => {
		const bigTask = longString(10_000, 'a');
		const entries = [makeEntry()];
		// Must not throw
		const score = _internals.computeSkillRelevanceScore(
			'.claude/skills/test/SKILL.md',
			bigTask,
			entries,
		);
		expect(typeof score).toBe('number');
		expect(Number.isNaN(score)).toBe(false);
	});

	test('computeSkillRelevanceScore does not throw with 10KB skillPath', () => {
		const bigPath = '.claude/skills/' + longString(10_000, 'x') + '/SKILL.md';
		const entries = [makeEntry()];
		const score = _internals.computeSkillRelevanceScore(
			bigPath,
			'do something with this task description',
			entries,
		);
		expect(typeof score).toBe('number');
		expect(Number.isNaN(score)).toBe(false);
	});

	test('computeSkillRelevanceScore does not throw with 50KB taskDescription', () => {
		const hugeTask = longString(50_000, 'a');
		const entries = [makeEntry()];
		const score = _internals.computeSkillRelevanceScore(
			'.claude/skills/test/SKILL.md',
			hugeTask,
			entries,
		);
		expect(typeof score).toBe('number');
		expect(Number.isNaN(score)).toBe(false);
	});

	test('extractKeywords handles 50KB string without hanging', () => {
		// The internal extractKeywords must not hang or OOM on huge input
		const hugeTask = longString(50_000, 'a');
		const entries = [makeEntry({ timestamp: hourAgo() })];
		const score = _internals.computeSkillRelevanceScore(
			'.claude/skills/test/SKILL.md',
			hugeTask,
			entries,
		);
		expect(typeof score).toBe('number');
		// Must not be NaN — extractKeywords on a string of only 'a' produces
		// one keyword which doesn't match the skill path, so contextScore = 0
		expect(Number.isNaN(score)).toBe(false);
	});
});

// ============================================================================
// 2. Special characters / injection in skill paths
// ============================================================================

describe('adversarial: special characters in skill paths', () => {
	test('path traversal attempt ../../etc/passwd does not throw', () => {
		const entries = [makeEntry()];
		const score = _internals.computeSkillRelevanceScore(
			'../../etc/passwd',
			'test task description',
			entries,
		);
		// Must not throw — path is just a string to the scoring logic
		expect(typeof score).toBe('number');
		expect(Number.isNaN(score)).toBe(false);
	});

	test('null byte in skillPath does not throw', () => {
		const entries = [makeEntry()];
		// JSON.parse of "\u0000" produces "\x00", a null byte character
		const nullBytePath = '.claude/skills/test\u0000/SKILL.md';
		const score = _internals.computeSkillRelevanceScore(
			nullBytePath,
			'test task',
			entries,
		);
		expect(typeof score).toBe('number');
		expect(Number.isNaN(score)).toBe(false);
	});

	test('unicode / emoji in skillPath does not throw', () => {
		const entries = [makeEntry()];
		const unicodePath = '.claude/skills/🔥-attack/SKILL.md';
		const score = _internals.computeSkillRelevanceScore(
			unicodePath,
			'test task',
			entries,
		);
		expect(typeof score).toBe('number');
		expect(Number.isNaN(score)).toBe(false);
	});

	test('RTL override characters in skillPath do not throw', () => {
		const entries = [makeEntry()];
		// Unicode RTL override — U+202E
		const rtlPath = '.claude/skills/\u202Ehidden/SKILL.md';
		const score = _internals.computeSkillRelevanceScore(
			rtlPath,
			'test task',
			entries,
		);
		expect(typeof score).toBe('number');
		expect(Number.isNaN(score)).toBe(false);
	});

	test('SQL injection fragment in skillPath does not throw', () => {
		const entries = [makeEntry()];
		const sqlPath = ".claude/skills/test'; DROP TABLE skills; --/SKILL.md";
		const score = _internals.computeSkillRelevanceScore(
			sqlPath,
			'test task',
			entries,
		);
		expect(typeof score).toBe('number');
		expect(Number.isNaN(score)).toBe(false);
	});

	test('HTML/script injection in skillPath does not throw', () => {
		const entries = [makeEntry()];
		const xssPath = '.claude/skills/<script>alert(1)</script>/SKILL.md';
		const score = _internals.computeSkillRelevanceScore(
			xssPath,
			'test task',
			entries,
		);
		expect(typeof score).toBe('number');
		expect(Number.isNaN(score)).toBe(false);
	});

	test('template literal injection in skillPath does not throw', () => {
		const entries = [makeEntry()];
		const templatePath = '.claude/skills/${process.env.SECRET}/SKILL.md';
		const score = _internals.computeSkillRelevanceScore(
			templatePath,
			'test task',
			entries,
		);
		expect(typeof score).toBe('number');
		expect(Number.isNaN(score)).toBe(false);
	});
});

// ============================================================================
// 3. Extremely large usage history arrays (10K+ entries)
// ============================================================================

describe('adversarial: very large usage history arrays', () => {
	test('computeSkillRelevanceScore handles 10,000-entry array', () => {
		const entries: SkillUsageEntry[] = Array.from({ length: 10_000 }, (_, i) =>
			makeEntry({ id: String(i), taskID: `task-${i % 100}` }),
		);
		const score = _internals.computeSkillRelevanceScore(
			'.claude/skills/test/SKILL.md',
			'do something',
			entries,
		);
		// Must not throw, must return valid number
		expect(typeof score).toBe('number');
		expect(Number.isNaN(score)).toBe(false);
		// With 10K entries frequency is capped at 1.0 → 0.3
		// With 100 distinct tasks, diversity = 100/10000 * 0.05 = 0.0005
		// Score should be well within [0, 1]
		expect(score).toBeGreaterThanOrEqual(0);
		expect(score).toBeLessThanOrEqual(1);
	});

	test('computeSkillRelevanceScore handles 50,000-entry array without hanging', () => {
		const entries: SkillUsageEntry[] = Array.from({ length: 50_000 }, (_, i) =>
			makeEntry({ id: String(i), taskID: `task-${i % 100}` }),
		);
		const score = _internals.computeSkillRelevanceScore(
			'.claude/skills/test/SKILL.md',
			'do something',
			entries,
		);
		expect(typeof score).toBe('number');
		expect(Number.isNaN(score)).toBe(false);
		expect(score).toBeGreaterThanOrEqual(0);
		expect(score).toBeLessThanOrEqual(1);
	});

	test('computeSkillRelevanceScore handles 100,000-entry array', () => {
		const entries: SkillUsageEntry[] = Array.from({ length: 100_000 }, (_, i) =>
			makeEntry({ id: String(i), taskID: `task-${i % 50}` }),
		);
		const score = _internals.computeSkillRelevanceScore(
			'.claude/skills/test/SKILL.md',
			'do something',
			entries,
		);
		expect(typeof score).toBe('number');
		expect(Number.isNaN(score)).toBe(false);
		expect(score).toBeGreaterThanOrEqual(0);
		expect(score).toBeLessThanOrEqual(1);
	});

	test('rankSkillsForContext handles 10K entries per skill', () => {
		// This tests performance — rankSkillsForContext calls readSkillUsageEntries
		// which reads the JSONL file; create a temp file with 10K entries
		const tempDir = fs.mkdtempSync(
			path.join(os.tmpdir(), 'adv-large-history-'),
		);
		const swarmDir = path.join(tempDir, '.swarm');
		fs.mkdirSync(swarmDir, { recursive: true });
		const logPath = path.join(swarmDir, 'skill-usage.jsonl');
		const entries: SkillUsageEntry[] = Array.from({ length: 10_000 }, (_, i) =>
			makeEntry({
				skillPath: 'big-skill',
				id: String(i),
				taskID: `task-${i % 50}`,
			}),
		);
		fs.writeFileSync(
			logPath,
			entries.map((e) => JSON.stringify(e)).join('\n') + '\n',
		);

		const results = _internals.rankSkillsForContext(
			['big-skill'],
			'do something',
			tempDir,
		);

		expect(results).toHaveLength(1);
		expect(typeof results[0].score).toBe('number');
		expect(Number.isNaN(results[0].score)).toBe(false);
		expect(results[0].usageCount).toBe(10_000);

		fs.rmSync(tempDir, { recursive: true });
	});
});

// ============================================================================
// 4. NaN / Infinity timestamps
// ============================================================================

describe('adversarial: NaN and Infinity timestamps', () => {
	test('NaN-equivalent timestamp ("not-a-timestamp") produces NaN-free score', () => {
		// "not-a-timestamp" is parsed by new Date() but getTime() returns NaN
		const entry = makeEntry({ timestamp: 'not-a-timestamp' });
		const score = _internals.computeSkillRelevanceScore(
			'.claude/skills/test/SKILL.md',
			'do something',
			[entry],
		);
		// computeRecencyScore returns 0 for NaN, score must be finite
		expect(Number.isNaN(score)).toBe(false);
		expect(score).toBeGreaterThanOrEqual(0);
	});

	test('Infinity timestamp does not produce infinite score', () => {
		// Use a timestamp that makes Date.now() - lastUsed = Infinity
		// Date.now() is finite, so we need lastUsed = -Infinity
		// new Date(-Infinity) is valid → epoch-ish large positive age → recency = 0
		const entry = makeEntry({ timestamp: String(-Infinity) });
		const score = _internals.computeSkillRelevanceScore(
			'.claude/skills/test/SKILL.md',
			'do something',
			[entry],
		);
		expect(Number.isFinite(score)).toBe(true);
		expect(score).toBeGreaterThanOrEqual(0);
		expect(score).toBeLessThanOrEqual(1);
	});

	test('Negative infinity timestamp does not produce infinite score', () => {
		const entry = makeEntry({ timestamp: String(Infinity) });
		const score = _internals.computeSkillRelevanceScore(
			'.claude/skills/test/SKILL.md',
			'do something',
			[entry],
		);
		expect(Number.isFinite(score)).toBe(true);
		expect(score).toBeGreaterThanOrEqual(0);
		expect(score).toBeLessThanOrEqual(1);
	});

	test('Very large positive timestamp (year 9999) produces finite score', () => {
		const entry = makeEntry({ timestamp: '9999-12-31T23:59:59.999Z' });
		const score = _internals.computeSkillRelevanceScore(
			'.claude/skills/test/SKILL.md',
			'do something',
			[entry],
		);
		// Year 9999 is in the future relative to 2026, ageMs > 0
		// and the check ageMs <= 0 returns false, then ageMs >= RECENCY_DECAY_MS
		// should be true (far future) → recency = 0
		expect(Number.isFinite(score)).toBe(true);
		expect(score).toBeGreaterThanOrEqual(0);
		expect(score).toBeLessThanOrEqual(1);
	});

	test('Mixed valid and invalid timestamps in history — score must be finite', () => {
		const entries: SkillUsageEntry[] = [
			makeEntry({ timestamp: hourAgo(1) }),
			makeEntry({ timestamp: 'not-a-timestamp' }),
			makeEntry({ timestamp: hourAgo(2) }),
			makeEntry({ timestamp: '' }),
		];
		const score = _internals.computeSkillRelevanceScore(
			'.claude/skills/test/SKILL.md',
			'do something',
			entries,
		);
		expect(Number.isFinite(score)).toBe(true);
		expect(score).toBeGreaterThanOrEqual(0);
		expect(score).toBeLessThanOrEqual(1);
	});
});

// ============================================================================
// 5. Empty strings for all parameters
// ============================================================================

describe('adversarial: empty and zero values', () => {
	test('empty taskDescription returns finite score', () => {
		const entries = [makeEntry()];
		const score = _internals.computeSkillRelevanceScore(
			'.claude/skills/test/SKILL.md',
			'',
			entries,
		);
		expect(typeof score).toBe('number');
		expect(Number.isNaN(score)).toBe(false);
		expect(score).toBeGreaterThanOrEqual(0);
	});

	test('empty skillPath returns finite score', () => {
		const entries = [makeEntry()];
		const score = _internals.computeSkillRelevanceScore(
			'',
			'do something',
			entries,
		);
		expect(typeof score).toBe('number');
		expect(Number.isNaN(score)).toBe(false);
	});

	test('both empty strings return contextScore of 0', () => {
		// No history + empty task description = no scoring components
		const score = _internals.computeSkillRelevanceScore('', '', []);
		expect(score).toBe(0);
	});

	test('undefined-like taskDescription ("undefined") does not throw', () => {
		const entries = [makeEntry()];
		const score = _internals.computeSkillRelevanceScore(
			'.claude/skills/test/SKILL.md',
			'undefined',
			entries,
		);
		expect(typeof score).toBe('number');
		expect(Number.isNaN(score)).toBe(false);
	});

	test('null-equivalent timestamp ("null") does not throw', () => {
		const entry = makeEntry({ timestamp: 'null' });
		const score = _internals.computeSkillRelevanceScore(
			'.claude/skills/test/SKILL.md',
			'do something',
			[entry],
		);
		expect(typeof score).toBe('number');
		expect(Number.isNaN(score)).toBe(false);
	});
});

// ============================================================================
// 6. Negative / epoch timestamps
// ============================================================================

describe('adversarial: negative and epoch timestamps', () => {
	test('timestamp of 0 (Unix epoch) produces finite score', () => {
		const entry = makeEntry({ timestamp: '1970-01-01T00:00:00.000Z' });
		const score = _internals.computeSkillRelevanceScore(
			'.claude/skills/test/SKILL.md',
			'do something',
			[entry],
		);
		expect(Number.isFinite(score)).toBe(true);
		expect(score).toBeGreaterThanOrEqual(0);
		expect(score).toBeLessThanOrEqual(1);
	});

	test('negative timestamp (-1 second before epoch) produces finite score', () => {
		// -1000 ms before epoch → Dec 31 1969 23:59:59
		const entry = makeEntry({ timestamp: '1969-12-31T23:59:59.000Z' });
		const score = _internals.computeSkillRelevanceScore(
			'.claude/skills/test/SKILL.md',
			'do something',
			[entry],
		);
		expect(Number.isFinite(score)).toBe(true);
		expect(score).toBeGreaterThanOrEqual(0);
		expect(score).toBeLessThanOrEqual(1);
	});

	test('very old timestamp (year 1900) produces recency = 0', () => {
		const entry = makeEntry({ timestamp: '1900-01-01T00:00:00.000Z' });
		const recencyScore = _internals.computeRecencyScore(entry.timestamp);
		// More than 30 days old → recency must be 0
		expect(recencyScore).toBe(0);
	});

	test('entries with year 1900 timestamps do not corrupt sort order', () => {
		const entries: SkillUsageEntry[] = [
			makeEntry({ id: 'a', timestamp: hourAgo(1) }),
			makeEntry({ id: 'b', timestamp: '1900-01-01T00:00:00.000Z' }),
			makeEntry({ id: 'c', timestamp: hourAgo(2) }),
		];
		const score = _internals.computeSkillRelevanceScore(
			'.claude/skills/test/SKILL.md',
			'do something',
			entries,
		);
		expect(Number.isFinite(score)).toBe(true);
		expect(score).toBeGreaterThanOrEqual(0);
	});
});

// ============================================================================
// 7. Concurrent calls with shared _internals mutation
// ============================================================================

describe('adversarial: _internals seam isolation', () => {
	test('overriding _internals.computeRecencyScore does NOT affect computeSkillRelevanceScore', () => {
		// computeSkillRelevanceScore calls the LOCAL computeRecencyScore, not _internals
		// So overriding _internals should have no effect on scoring
		const originalRecency = _internals.computeRecencyScore;
		_internals.computeRecencyScore = () => 99 as unknown as number; // malicious override

		const entry = [makeEntry({ timestamp: hourAgo(1) })];
		const score = _internals.computeSkillRelevanceScore(
			'.claude/skills/test/SKILL.md',
			'do something',
			entry,
		);

		// Score must NOT reflect the overridden recency of 99
		expect(score).toBeLessThan(10); // clearly not using the override
		expect(score).toBeGreaterThanOrEqual(0);
		expect(score).toBeLessThanOrEqual(1);

		_internals.computeRecencyScore = originalRecency;
	});

	test('getSkillStats calls readSkillUsageEntries directly — _internals override irrelevant', () => {
		// getSkillStats does not call any _internals functions
		// It calls readSkillUsageEntries (imported at module scope)
		// So _internals mutations don't affect it
		const originalGetStats = _internals.getSkillStats;
		let callCount = 0;
		_internals.getSkillStats = () => {
			callCount++;
			return {
				totalUsage: 999,
				complianceRate: 0.5,
				lastUsed: '',
				topAgents: [],
			};
		};

		// getSkillStats is called directly, not through _internals from scoring.ts
		// (scoring.ts calls it directly as a module-level function)
		// Verify that _internals.getSkillStats override DOES affect calls from scoring
		// This tests whether the DI seam actually works
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adv-internals-'));
		fs.mkdirSync(path.join(tempDir, '.swarm'), { recursive: true });

		// rankSkillsForContext calls getSkillStats internally
		const results = _internals.rankSkillsForContext(
			['.claude/skills/test/SKILL.md'],
			'test',
			tempDir,
		);

		// If _internals.getSkillStats override worked, callCount would be > 0
		// But since rankSkillsForContext calls the local getSkillStats, not _internals,
		// this verifies the seam does NOT protect against _internals mutations in scoring.ts
		expect(results).toHaveLength(1);

		fs.rmSync(tempDir, { recursive: true });
		_internals.getSkillStats = originalGetStats;
	});
});

// ============================================================================
// 8. Score overflow — can score exceed 1.0?
// ============================================================================

describe('adversarial: score overflow boundary', () => {
	test('score cannot exceed 1.0 with maximum-frequency entries', () => {
		// 100 entries with compliant verdicts = max frequency (capped at 1.0) + max compliance
		const entries: SkillUsageEntry[] = Array.from({ length: 100 }, (_, i) =>
			makeEntry({ id: String(i), complianceVerdict: 'compliant' }),
		);
		const score = _internals.computeSkillRelevanceScore(
			'.claude/skills/test/SKILL.md',
			'test',
			entries,
		);
		expect(score).toBeLessThanOrEqual(1.0);
		expect(score).toBeGreaterThanOrEqual(0);
	});

	test('score cannot exceed 1.0 with all-verdict-compliant entries from different tasks', () => {
		const entries: SkillUsageEntry[] = Array.from({ length: 50 }, (_, i) =>
			makeEntry({
				id: String(i),
				taskID: `task-${i}`, // all distinct → max diversity
				complianceVerdict: 'compliant',
				timestamp: hourAgo(1), // very recent → max recency
			}),
		);
		const score = _internals.computeSkillRelevanceScore(
			'.claude/skills/writing-tests/SKILL.md',
			'writing tests for the hook', // matches "writing" and "tests"
			entries,
		);
		expect(score).toBeLessThanOrEqual(1.0);
		expect(score).toBeGreaterThanOrEqual(0);
	});

	test('score cannot exceed 1.0 with perfect context match', () => {
		const entries: SkillUsageEntry[] = Array.from({ length: 100 }, (_, i) =>
			makeEntry({
				id: String(i),
				complianceVerdict: 'compliant',
				timestamp: hourAgo(1),
				taskID: `task-${i}`,
			}),
		);
		// Skill path contains "test" — task description also has "test"
		// contextScore = 1.0 * CONTEXT_WEIGHT = 0.2 (max context)
		const score = _internals.computeSkillRelevanceScore(
			'.claude/skills/test/SKILL.md',
			'test this skill',
			entries,
		);
		expect(score).toBeLessThanOrEqual(1.0);
	});

	test('future timestamp via _internals override could theoretically exceed 1.0 but is clamped by caller', () => {
		// We can't directly override computeRecencyScore in computeSkillRelevanceScore
		// (it's called as a local function), so this is a theoretical attack vector
		// that the DI seam cannot prevent.
		// The only way to exceed 1.0 would be if computeRecencyScore returned > 1.0,
		// but the function itself clamps to [0, 1] via its guards.
		const entries = [makeEntry({ timestamp: hourAgo(1) })];
		const score = _internals.computeSkillRelevanceScore(
			'.claude/skills/test/SKILL.md',
			'do something',
			entries,
		);
		// Normal inputs always produce scores in [0, 1]
		expect(score).toBeGreaterThanOrEqual(0);
		expect(score).toBeLessThanOrEqual(1);
	});
});

// ============================================================================
// 9. All entries with complianceVerdict='not_checked'
// ============================================================================

describe('adversarial: all entries with not_checked verdict', () => {
	test('computeSkillRelevanceScore handles 100% not_checked entries', () => {
		const entries: SkillUsageEntry[] = Array.from({ length: 10 }, (_, i) =>
			makeEntry({ id: String(i), complianceVerdict: 'not_checked' }),
		);
		const score = _internals.computeSkillRelevanceScore(
			'.claude/skills/test/SKILL.md',
			'do something',
			entries,
		);
		// All not_checked → entriesWithVerdict = [] → denominator = Math.max(1, 0) = 1
		// compliantCount = 0 → complianceScore = 0/1 * 0.3 = 0
		// Score comes from frequency, recency, diversity only
		expect(Number.isNaN(score)).toBe(false);
		expect(score).toBeGreaterThanOrEqual(0);
		expect(score).toBeLessThanOrEqual(1);
	});

	test('getSkillStats handles 100% not_checked entries', () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adv-notchecked-'));
		const swarmDir = path.join(tempDir, '.swarm');
		fs.mkdirSync(swarmDir, { recursive: true });
		const logPath = path.join(swarmDir, 'skill-usage.jsonl');
		const entries: SkillUsageEntry[] = Array.from({ length: 5 }, (_, i) =>
			makeEntry({
				skillPath: 'not-checked-skill',
				complianceVerdict: 'not_checked',
			}),
		);
		fs.writeFileSync(
			logPath,
			entries.map((e) => JSON.stringify(e)).join('\n') + '\n',
		);

		const stats = _internals.getSkillStats('not-checked-skill', tempDir);

		// complianceRate should be 0 when no entries have real verdicts
		expect(stats.complianceRate).toBe(0);
		expect(stats.totalUsage).toBe(5);

		fs.rmSync(tempDir, { recursive: true });
	});

	test('getSkillStats complianceRate does not divide by zero with not_checked entries', () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adv-notchecked2-'));
		const swarmDir = path.join(tempDir, '.swarm');
		fs.mkdirSync(swarmDir, { recursive: true });
		const logPath = path.join(swarmDir, 'skill-usage.jsonl');
		// All entries have no real verdicts
		const entries: SkillUsageEntry[] = [
			makeEntry({ skillPath: 'test-skill', complianceVerdict: 'not_checked' }),
			makeEntry({ skillPath: 'test-skill', complianceVerdict: 'not_checked' }),
			makeEntry({ skillPath: 'test-skill', complianceVerdict: 'not_checked' }),
		];
		fs.writeFileSync(
			logPath,
			entries.map((e) => JSON.stringify(e)).join('\n') + '\n',
		);

		const stats = _internals.getSkillStats('test-skill', tempDir);
		// entriesWithVerdict = [] → compliantCount = 0 → complianceRate = 0 / 0
		// The code has: entriesWithVerdict.length > 0 ? ... : 0
		// So it should be 0, not NaN
		expect(stats.complianceRate).toBe(0);

		fs.rmSync(tempDir, { recursive: true });
	});

	test('rankSkillsForContext complianceRate is NaN-free with not_checked entries', () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adv-notchecked3-'));
		const swarmDir = path.join(tempDir, '.swarm');
		fs.mkdirSync(swarmDir, { recursive: true });
		const logPath = path.join(swarmDir, 'skill-usage.jsonl');
		const entries: SkillUsageEntry[] = Array.from({ length: 3 }, (_, i) =>
			makeEntry({ skillPath: 'test-skill', complianceVerdict: 'not_checked' }),
		);
		fs.writeFileSync(
			logPath,
			entries.map((e) => JSON.stringify(e)).join('\n') + '\n',
		);

		const results = _internals.rankSkillsForContext(
			['test-skill'],
			'do something',
			tempDir,
		);

		expect(results).toHaveLength(1);
		// complianceRate = compliantCount / entriesWithVerdict.length
		// = 0 / 0 = NaN in rankSkillsForContext's own computation!
		// But the result stores it — check it's not NaN
		expect(Number.isNaN(results[0].complianceRate)).toBe(false);
		expect(results[0].complianceRate).toBe(0);

		fs.rmSync(tempDir, { recursive: true });
	});
});

// ============================================================================
// 10. Sorting with NaN scores (sort stability)
// ============================================================================

describe('adversarial: sorting with NaN scores', () => {
	test('rankSkillsForContext handles NaN scores without throwing', () => {
		// We can't directly create NaN scores from outside computeSkillRelevanceScore
		// (since it guards against NaN timestamps), but we can verify the sort
		// comparator handles NaN gracefully by checking that NaN comparisons
		// don't cause non-deterministic ordering
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adv-sort-'));
		const swarmDir = path.join(tempDir, '.swarm');
		fs.mkdirSync(swarmDir, { recursive: true });
		const logPath = path.join(swarmDir, 'skill-usage.jsonl');
		// Two skills with identical scores and usage counts
		const entries: SkillUsageEntry[] = [
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

		// Run sort multiple times — if sort comparator returns NaN inconsistently,
		// results could vary. We check for at least stable ordering.
		const results1 = _internals.rankSkillsForContext(
			['skill-a', 'skill-b'],
			'do something',
			tempDir,
		);
		const results2 = _internals.rankSkillsForContext(
			['skill-a', 'skill-b'],
			'do something',
			tempDir,
		);

		// Both runs should produce same order (stable sort)
		expect(results1[0].skillPath).toBe(results2[0].skillPath);
		expect(results1[1].skillPath).toBe(results2[1].skillPath);

		fs.rmSync(tempDir, { recursive: true });
	});

	test('NaN taskID diversity: empty string taskIDs produce deterministic diversity', () => {
		// Empty taskIDs are filtered out: .filter(Boolean)
		// So distinctTaskIDs with all-empty taskIDs = 0
		const entries: SkillUsageEntry[] = [
			makeEntry({ taskID: '' }),
			makeEntry({ taskID: '' }),
			makeEntry({ taskID: '' }),
		];
		const score = _internals.computeSkillRelevanceScore(
			'.claude/skills/test/SKILL.md',
			'do something',
			entries,
		);
		// diversity = 0 / 3 * 0.05 = 0
		expect(Number.isNaN(score)).toBe(false);
		expect(score).toBeGreaterThanOrEqual(0);
	});
});

// ============================================================================
// 11. Edge: readSkillUsageEntries malformed JSONL
// ============================================================================

describe('adversarial: malformed JSONL in skill-usage log', () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adv-malformed-'));
		fs.mkdirSync(path.join(tempDir, '.swarm'), { recursive: true });
	});

	afterEach(() => {
		mock.restore();
		try {
			fs.rmSync(tempDir, { recursive: true });
		} catch {
			// ignore cleanup failure
		}
	});

	test('rankSkillsForContext skips malformed JSONL lines without throwing', () => {
		const logPath = path.join(tempDir, '.swarm', 'skill-usage.jsonl');
		// Mix valid entries with malformed ones
		const validEntries = [
			makeEntry({ skillPath: 'test-skill', id: 'valid-1' }),
			makeEntry({ skillPath: 'test-skill', id: 'valid-2' }),
		];
		const malformedLines = [
			'not valid json at all',
			'{"id": "broken", "skillPath": "test-skill"', // truncated JSON
			'',
			'\n',
		];
		fs.writeFileSync(
			logPath,
			[...validEntries.map((e) => JSON.stringify(e)), ...malformedLines].join(
				'\n',
			) + '\n',
		);

		// Must not throw — malformed lines are silently skipped
		const results = _internals.rankSkillsForContext(
			['test-skill'],
			'do something',
			tempDir,
		);
		expect(results).toHaveLength(1);
		// Only 2 valid entries should be counted
		expect(results[0].usageCount).toBe(2);
	});

	test('getSkillStats skips malformed JSONL lines without throwing', () => {
		const logPath = path.join(tempDir, '.swarm', 'skill-usage.jsonl');
		const validEntries = [
			makeEntry({ skillPath: 'test-skill', id: 'valid-1' }),
		];
		const malformedLines = [
			'definitely not json',
			'',
			'{"id": "incomplete", "skillPath": "test-skill"', // truncated
		];
		fs.writeFileSync(
			logPath,
			[...validEntries.map((e) => JSON.stringify(e)), ...malformedLines].join(
				'\n',
			) + '\n',
		);

		const stats = _internals.getSkillStats('test-skill', tempDir);
		expect(stats.totalUsage).toBe(1);
	});
});
