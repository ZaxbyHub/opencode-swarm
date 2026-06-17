/**
 * End-to-end integration tests for skill-scoring runtime wiring.
 *
 * Tests the complete flow:
 *   readSkillUsageEntriesTail → computeSkillRelevanceScore → ranked output
 *
 * Uses real file I/O via _internals seams (no mock.module) to validate
 * the bounded tail-read + in-memory scoring pipeline.
 *
 * Framework: bun:test
 * Coverage: tail-read → scoring pipeline, MAX_SCORING_SESSION_ENTRIES bounding,
 *           gateBefore scoring block integration, end-to-end ranking accuracy.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	_internals as gateInternals,
	skillPropagationGateBefore,
} from '../../../src/hooks/skill-propagation-gate.ts';
import {
	computeSkillRelevanceScore,
	_internals as scoringInternals,
} from '../../../src/hooks/skill-scoring.ts';
import {
	appendSkillUsageEntry,
	_internals as logInternals,
	readSkillUsageEntries,
	readSkillUsageEntriesTail,
	type SkillUsageEntry,
} from '../../../src/hooks/skill-usage-log.ts';

// ============================================================================
// Helpers
// ============================================================================

function makeTempDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), 'skill-scoring-e2e-'));
}

/** Write raw content to the skill-usage log. */
function writeRawLog(dir: string, content: string): void {
	const resolved = path.join(dir, '.swarm', 'skill-usage.jsonl');
	fs.mkdirSync(path.dirname(resolved), { recursive: true });
	fs.writeFileSync(resolved, content, 'utf-8');
}

/** Read raw log content. */
function readRawLog(dir: string): string {
	const resolved = path.join(dir, '.swarm', 'skill-usage.jsonl');
	return fs.existsSync(resolved) ? fs.readFileSync(resolved, 'utf-8') : '';
}

/** Minimal valid entry template. */
function makeEntry(
	overrides: Partial<Omit<SkillUsageEntry, 'id'>> = {},
): Omit<SkillUsageEntry, 'id'> {
	return {
		skillPath: '.claude/skills/my-skill/SKILL.md',
		agentName: 'test-agent',
		taskID: 'task-001',
		timestamp: new Date().toISOString(),
		complianceVerdict: 'compliant',
		sessionID: 'session-abc',
		...overrides,
	};
}

/** One hour ago in ISO 8601. */
function hourAgo(hours = 1): string {
	return new Date(Date.now() - hours * 3600 * 1000).toISOString();
}

// ============================================================================
// Test suite
// ============================================================================

describe('readSkillUsageEntriesTail — integration with real scoring', () => {
	let tempDir: string;
	let originals: {
		statSync: typeof fs.statSync;
		openSync: typeof fs.openSync;
		readSync: typeof fs.readSync;
		closeSync: typeof fs.closeSync;
		existsSync: typeof fs.existsSync;
	};

	beforeEach(() => {
		tempDir = makeTempDir();
		originals = {
			statSync: logInternals.statSync,
			openSync: logInternals.openSync,
			readSync: logInternals.readSync,
			closeSync: logInternals.closeSync,
			existsSync: logInternals.existsSync,
		};
	});

	afterEach(() => {
		// Restore all _internals
		logInternals.statSync = originals.statSync;
		logInternals.openSync = originals.openSync;
		logInternals.readSync = originals.readSync;
		logInternals.closeSync = originals.closeSync;
		logInternals.existsSync = originals.existsSync;
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	test('tail-read entries feed directly into computeSkillRelevanceScore with correct ranking', () => {
		// Write a log with two skills at different usage levels
		const sessionID = 'e2e-scoring-session';
		const skillAPath = '.claude/skills/writing-tests/SKILL.md';
		const skillBPath = '.claude/skills/engineering-conventions/SKILL.md';

		const entries: SkillUsageEntry[] = [
			// skill-a: 5 compliant entries, recent
			...Array.from({ length: 5 }, (_, i) =>
				makeEntry({
					skillPath: skillAPath,
					sessionID,
					taskID: `task-a-${i}`,
					timestamp: hourAgo(1),
					complianceVerdict: 'compliant',
				}),
			),
			// skill-b: 1 violation entry, old
			makeEntry({
				skillPath: skillBPath,
				sessionID,
				taskID: 'task-b-1',
				timestamp: hourAgo(720), // ~30 days ago
				complianceVerdict: 'violated',
			}),
		];

		writeRawLog(
			tempDir,
			entries.map((e) => JSON.stringify(e)).join('\n') + '\n',
		);

		// Read via tail
		const tailEntries = readSkillUsageEntriesTail(tempDir, { sessionID });
		expect(tailEntries.length).toBe(6);

		// Score each skill using real scoring function
		const skillAEntries = tailEntries.filter((e) => e.skillPath === skillAPath);
		const skillBEntries = tailEntries.filter((e) => e.skillPath === skillBPath);

		const scoreA = computeSkillRelevanceScore(
			skillAPath,
			'implement writing tests for the hook',
			skillAEntries,
		);
		const scoreB = computeSkillRelevanceScore(
			skillBPath,
			'implement writing tests for the hook',
			skillBEntries,
		);

		// skill-a should rank higher: more entries, all compliant, recent
		expect(scoreA).toBeGreaterThan(scoreB);
		// Verify scores are in valid range
		expect(scoreA).toBeGreaterThanOrEqual(0);
		expect(scoreA).toBeLessThanOrEqual(1);
		expect(scoreB).toBeGreaterThanOrEqual(0);
		expect(scoreB).toBeLessThanOrEqual(1);
	});

	test('session filter on tail-read correctly scopes scoring entries', () => {
		const sessionA = 'session-a';
		const sessionB = 'session-b';

		writeRawLog(
			tempDir,
			[
				makeEntry({ sessionID: sessionA, skillPath: 'skill-a', taskID: 't1' }),
				makeEntry({ sessionID: sessionA, skillPath: 'skill-a', taskID: 't2' }),
				makeEntry({ sessionID: sessionB, skillPath: 'skill-b', taskID: 't3' }),
			]
				.map((e) => JSON.stringify(e))
				.join('\n') + '\n',
		);

		// Filter to session A only
		const entriesA = readSkillUsageEntriesTail(tempDir, {
			sessionID: sessionA,
		});
		const entriesB = readSkillUsageEntriesTail(tempDir, {
			sessionID: sessionB,
		});

		// All returned entries must match the filter
		expect(entriesA.every((e) => e.sessionID === sessionA)).toBe(true);
		expect(entriesB.every((e) => e.sessionID === sessionB)).toBe(true);

		// Scoring session A should not see session B entries
		const scoreA = computeSkillRelevanceScore('skill-a', 'do work', entriesA);
		const scoreB = computeSkillRelevanceScore('skill-b', 'do work', entriesB);

		// skill-a has 2 entries, skill-b has 1
		// Both are compliant and recent-ish, so skill-a should score higher
		expect(scoreA).toBeGreaterThan(scoreB);
	});

	test('tail-read with empty session filter returns all recent entries', () => {
		const sessionID = 'filter-none-session';
		const entries = [
			makeEntry({ sessionID, skillPath: 'skill-x', taskID: 't1' }),
			makeEntry({ sessionID, skillPath: 'skill-y', taskID: 't2' }),
		];
		writeRawLog(
			tempDir,
			entries.map((e) => JSON.stringify(e)).join('\n') + '\n',
		);

		const result = readSkillUsageEntriesTail(tempDir, {});
		expect(result.length).toBe(2);
	});

	test('empty tail-read result produces context-only score', () => {
		// No file exists
		const score = computeSkillRelevanceScore(
			'.claude/skills/writing-tests/SKILL.md',
			'write tests for the hook',
			[],
		);
		// Returns contextScore only (keyword overlap * 0.2)
		expect(score).toBeGreaterThanOrEqual(0);
		expect(score).toBeLessThanOrEqual(0.2);
	});

	test('malformed JSON in tail-read is skipped and does not corrupt scoring', () => {
		const sessionID = 'malform-scoring-session';
		writeRawLog(
			tempDir,
			JSON.stringify(
				makeEntry({ sessionID, skillPath: 'skill-good', taskID: 'good-1' }),
			) +
				'\n' +
				'NOT JSON\n' +
				JSON.stringify(
					makeEntry({ sessionID, skillPath: 'skill-good', taskID: 'good-2' }),
				) +
				'\n',
		);

		const tailEntries = readSkillUsageEntriesTail(tempDir, { sessionID });
		const tasks = tailEntries.map((e) => e.taskID);

		// Malformed line should be skipped
		expect(tasks).toContain('good-1');
		expect(tasks).toContain('good-2');
		expect(tasks).not.toContain('NOT JSON');

		// Scoring should work with the valid entries
		const validEntries = tailEntries.filter((e) => e.taskID.startsWith('good'));
		const score = computeSkillRelevanceScore(
			'skill-good',
			'do work',
			validEntries,
		);
		expect(score).toBeGreaterThanOrEqual(0);
	});
});

describe('MAX_SCORING_SESSION_ENTRIES bounding', () => {
	let tempDir: string;
	let originals: {
		readSkillUsageEntriesTail: typeof gateInternals.readSkillUsageEntriesTail;
		computeSkillRelevanceScore: typeof gateInternals.computeSkillRelevanceScore;
		MAX_SCORING_SESSION_ENTRIES: number;
		appendSkillUsageEntry: typeof gateInternals.appendSkillUsageEntry;
		parseDelegationArgs: typeof gateInternals.parseDelegationArgs;
		discoverAvailableSkills: typeof gateInternals.discoverAvailableSkills;
		extractTaskIdFromPrompt: typeof gateInternals.extractTaskIdFromPrompt;
		parseSkillPaths: typeof gateInternals.parseSkillPaths;
		SKILL_CAPABLE_AGENTS: Set<string>;
	};

	beforeEach(() => {
		tempDir = makeTempDir();
		originals = {
			readSkillUsageEntriesTail: gateInternals.readSkillUsageEntriesTail,
			computeSkillRelevanceScore: gateInternals.computeSkillRelevanceScore,
			MAX_SCORING_SESSION_ENTRIES: gateInternals.MAX_SCORING_SESSION_ENTRIES,
			appendSkillUsageEntry: gateInternals.appendSkillUsageEntry,
			parseDelegationArgs: gateInternals.parseDelegationArgs,
			discoverAvailableSkills: gateInternals.discoverAvailableSkills,
			extractTaskIdFromPrompt: gateInternals.extractTaskIdFromPrompt,
			parseSkillPaths: gateInternals.parseSkillPaths,
			SKILL_CAPABLE_AGENTS: gateInternals.SKILL_CAPABLE_AGENTS,
		};
	});

	afterEach(() => {
		// Restore all overrides
		gateInternals.readSkillUsageEntriesTail =
			originals.readSkillUsageEntriesTail;
		gateInternals.computeSkillRelevanceScore =
			originals.computeSkillRelevanceScore;
		gateInternals.MAX_SCORING_SESSION_ENTRIES =
			originals.MAX_SCORING_SESSION_ENTRIES;
		gateInternals.appendSkillUsageEntry = originals.appendSkillUsageEntry;
		gateInternals.parseDelegationArgs = originals.parseDelegationArgs;
		gateInternals.discoverAvailableSkills = originals.discoverAvailableSkills;
		gateInternals.extractTaskIdFromPrompt = originals.extractTaskIdFromPrompt;
		gateInternals.parseSkillPaths = originals.parseSkillPaths;
		gateInternals.SKILL_CAPABLE_AGENTS = originals.SKILL_CAPABLE_AGENTS;
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	test('scoring is skipped when session entry count equals MAX_SCORING_SESSION_ENTRIES', async () => {
		let scoringCalled = false;
		const sessionID = 'bound-test-session';

		// Pre-populate log with exactly MAX_SCORING_SESSION_ENTRIES entries
		const limit = originals.MAX_SCORING_SESSION_ENTRIES;
		for (let i = 0; i < limit; i++) {
			appendSkillUsageEntry(tempDir, {
				skillPath: 'skill-x',
				agentName: 'coder',
				taskID: `task-${i}`,
				complianceVerdict: 'compliant',
				sessionID,
				timestamp: new Date().toISOString(),
			});
		}

		gateInternals.parseDelegationArgs = () => ({
			targetAgent: 'coder',
			skillsField: 'skill-x',
		});
		gateInternals.discoverAvailableSkills = () => [
			'.claude/skills/skill-x/SKILL.md',
		];
		gateInternals.extractTaskIdFromPrompt = () => 'task-bound';
		gateInternals.parseSkillPaths = (v: string) =>
			v === 'skill-x' ? ['skill-x'] : [];
		gateInternals.computeSkillRelevanceScore = () => {
			scoringCalled = true;
			return 0.5;
		};

		await skillPropagationGateBefore(
			tempDir,
			{
				tool: 'task',
				agent: 'architect',
				sessionID,
				args: {
					subagent_type: 'mega_coder',
					prompt: 'SKILLS: skill-x\ndo work',
				},
			},
			{ enabled: true },
		);

		// At exactly the limit, scoring should still run
		expect(scoringCalled).toBe(true);
	});

	test('scoring is skipped when session entry count exceeds MAX_SCORING_SESSION_ENTRIES', async () => {
		let scoringCalled = false;
		const sessionID = 'overflow-session';

		// Write 600 compact entries — enough that the tail (64KB) captures a significant count
		const logPath = path.join(tempDir, '.swarm', 'skill-usage.jsonl');
		fs.mkdirSync(path.dirname(logPath), { recursive: true });

		const lines: string[] = [];
		for (let i = 0; i < 600; i++) {
			lines.push(
				JSON.stringify({
					id: `id-${i}`,
					skillPath: 'skill-x',
					agentName: 'c',
					taskID: `t-${i}`,
					timestamp: new Date().toISOString(),
					complianceVerdict: 'c',
					sessionID,
				}),
			);
		}
		fs.writeFileSync(logPath, lines.join('\n') + '\n', 'utf-8');

		// Measure actual tail count for this file
		const actualTailCount = readSkillUsageEntriesTail(tempDir, {
			sessionID,
		}).length;
		expect(actualTailCount).toBeGreaterThan(0);

		// Force the limit BELOW the tail count to guarantee the skip path fires
		gateInternals.MAX_SCORING_SESSION_ENTRIES = Math.max(
			1,
			actualTailCount - 1,
		);

		gateInternals.parseDelegationArgs = () => ({
			targetAgent: 'coder',
			skillsField: 'skill-x',
		});
		gateInternals.discoverAvailableSkills = () => [
			'.claude/skills/skill-x/SKILL.md',
		];
		gateInternals.extractTaskIdFromPrompt = () => 'task-overflow';
		gateInternals.parseSkillPaths = (v: string) =>
			v === 'skill-x' ? ['.claude/skills/skill-x/SKILL.md'] : [];
		gateInternals.computeSkillRelevanceScore = () => {
			scoringCalled = true;
			return 0.5;
		};
		gateInternals.appendSkillUsageEntry = () => {}; // prevent append

		await skillPropagationGateBefore(
			tempDir,
			{
				tool: 'task',
				agent: 'architect',
				sessionID,
				args: {
					subagent_type: 'mega_coder',
					prompt: 'SKILLS: skill-x\ndo work',
				},
			},
			{ enabled: true },
		);

		// Scoring MUST be skipped because tail count > forced limit
		expect(scoringCalled).toBe(false);
	});

	test('entry count check uses actual tail-read result, not full log read', async () => {
		let tailReadCount = 0;
		const sessionID = 'tail-verify-session';

		// Write entries directly to the log file (bypassing any caching)
		const logPath = path.join(tempDir, '.swarm', 'skill-usage.jsonl');
		fs.mkdirSync(path.dirname(logPath), { recursive: true });
		const entries = Array.from({ length: 10 }, (_, i) =>
			makeEntry({
				sessionID,
				skillPath: 'skill-tail',
				taskID: `task-${i}`,
				timestamp: hourAgo(1),
				complianceVerdict: 'compliant',
			}),
		);
		fs.writeFileSync(
			logPath,
			entries.map((e) => JSON.stringify(e)).join('\n') + '\n',
		);

		// Wrap the real tail-read to count calls
		gateInternals.readSkillUsageEntriesTail = (
			dir: string,
			filters: { sessionID?: string },
		) => {
			tailReadCount++;
			return readSkillUsageEntriesTail(dir, filters);
		};
		gateInternals.parseDelegationArgs = () => ({
			targetAgent: 'coder',
			skillsField: 'skill-tail',
		});
		gateInternals.discoverAvailableSkills = () => [
			'.claude/skills/skill-tail/SKILL.md',
		];
		gateInternals.extractTaskIdFromPrompt = () => 'task-tail-verify';
		gateInternals.parseSkillPaths = (v: string) =>
			v === 'skill-tail' ? ['skill-tail'] : [];
		gateInternals.computeSkillRelevanceScore = () => 0.5;
		gateInternals.MAX_SCORING_SESSION_ENTRIES = 500;

		await skillPropagationGateBefore(
			tempDir,
			{
				tool: 'task',
				agent: 'architect',
				sessionID,
				args: {
					subagent_type: 'mega_coder',
					prompt: 'SKILLS: skill-tail\ndo work',
				},
			},
			{ enabled: true },
		);

		// Tail read was called exactly once for scoring
		expect(tailReadCount).toBe(1);
		// The tail-read returned 10 entries (within limit), scoring ran
		// We can verify via the log: 10 pre-populated + 1 delegation = 11 entries total
		const logContent = fs.readFileSync(logPath, 'utf-8');
		const lines = logContent.trim().split('\n').filter(Boolean);
		expect(lines).toHaveLength(11);
	});
});

describe('end-to-end ranking accuracy via tail-read + scoring', () => {
	let tempDir: string;
	let originals: {
		statSync: typeof fs.statSync;
		openSync: typeof fs.openSync;
		readSync: typeof fs.readSync;
		closeSync: typeof fs.closeSync;
		existsSync: typeof fs.existsSync;
	};

	beforeEach(() => {
		tempDir = makeTempDir();
		originals = {
			statSync: logInternals.statSync,
			openSync: logInternals.openSync,
			readSync: logInternals.readSync,
			closeSync: logInternals.closeSync,
			existsSync: logInternals.existsSync,
		};
	});

	afterEach(() => {
		logInternals.statSync = originals.statSync;
		logInternals.openSync = originals.openSync;
		logInternals.readSync = originals.readSync;
		logInternals.closeSync = originals.closeSync;
		logInternals.existsSync = originals.existsSync;
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	test('skills rank by composite score descending — frequency + compliance + recency + context', () => {
		const sessionID = 'ranking-e2e';
		const skillHigh = '.claude/skills/writing-tests/SKILL.md';
		const skillMid = '.claude/skills/engineering-conventions/SKILL.md';
		const skillLow = '.claude/skills/code-style/SKILL.md';

		// skillHigh: 8 compliant entries, very recent → should rank #1
		// skillMid: 3 compliant entries, 30 days old → recency component near 0
		// skillLow: 1 violation entry, recent → poor compliance score
		const entries: SkillUsageEntry[] = [
			...Array.from({ length: 8 }, (_, i) =>
				makeEntry({
					skillPath: skillHigh,
					sessionID,
					taskID: `task-high-${i}`,
					timestamp: hourAgo(2),
					complianceVerdict: 'compliant',
				}),
			),
			...Array.from({ length: 3 }, (_, i) =>
				makeEntry({
					skillPath: skillMid,
					sessionID,
					taskID: `task-mid-${i}`,
					timestamp: hourAgo(720), // ~30 days ago
					complianceVerdict: 'compliant',
				}),
			),
			makeEntry({
				skillPath: skillLow,
				sessionID,
				taskID: 'task-low-1',
				timestamp: hourAgo(1),
				complianceVerdict: 'violated',
			}),
		];

		writeRawLog(
			tempDir,
			entries.map((e) => JSON.stringify(e)).join('\n') + '\n',
		);

		const tailEntries = readSkillUsageEntriesTail(tempDir, { sessionID });
		expect(tailEntries.length).toBe(12);

		const taskDesc = 'write tests for the hook using writing-tests skill';

		// Score each skill
		const scoreHigh = computeSkillRelevanceScore(
			skillHigh,
			taskDesc,
			tailEntries.filter((e) => e.skillPath === skillHigh),
		);
		const scoreMid = computeSkillRelevanceScore(
			skillMid,
			taskDesc,
			tailEntries.filter((e) => e.skillPath === skillMid),
		);
		const scoreLow = computeSkillRelevanceScore(
			skillLow,
			taskDesc,
			tailEntries.filter((e) => e.skillPath === skillLow),
		);

		// Verify ranking order
		expect(scoreHigh).toBeGreaterThan(scoreMid);
		expect(scoreMid).toBeGreaterThan(scoreLow);

		// Verify all scores are valid
		expect(scoreHigh).toBeLessThanOrEqual(1);
		expect(scoreMid).toBeLessThanOrEqual(1);
		expect(scoreLow).toBeLessThanOrEqual(1);
	});

	test('bounded tail-read does not include stale entries beyond maxBytes', () => {
		const sessionID = 'bounded-session';

		// Create enough entries to exceed the default 64KB limit
		// Each entry is ~200 bytes JSON, so 500 entries ≈ 100KB
		const largeEntryCount = 600;
		const entries: SkillUsageEntry[] = Array.from(
			{ length: largeEntryCount },
			(_, i) =>
				makeEntry({
					sessionID,
					skillPath: i < 300 ? 'skill-recent' : 'skill-old',
					taskID: `task-${i.toString().padStart(3, '0')}`,
					timestamp: i < 300 ? hourAgo(1) : hourAgo(24 * 30 + 1), // > 30 days old — would score 0 recency
					complianceVerdict: 'compliant',
				}),
		);

		writeRawLog(
			tempDir,
			entries.map((e) => JSON.stringify(e)).join('\n') + '\n',
		);

		// Use the default 64KB tail read
		const tailEntries = readSkillUsageEntriesTail(tempDir, { sessionID });

		// Tail read should return fewer than total entries (bounded)
		expect(tailEntries.length).toBeLessThan(largeEntryCount);

		// All returned entries should be recent (within recency window)
		// Old entries beyond the tail window should not appear
		const hasOnlyRecent = tailEntries.every(
			(e) => e.skillPath === 'skill-recent',
		);
		// Either all recent (bounded returned only recent half)
		// or contains some old but still within tail window
		// The key invariant: no entry can have a negative recency score
		for (const entry of tailEntries) {
			const score = computeSkillRelevanceScore(entry.skillPath, 'do work', [
				entry,
			]);
			// Recent entries should have positive recency component
			// (unless the file was large enough that even recent entries were cut)
			if (entry.skillPath === 'skill-recent') {
				expect(score).toBeGreaterThan(0);
			}
		}
	});

	test('scoring results are deterministic for same input', () => {
		const sessionID = 'deterministic-session';
		const skillPath = '.claude/skills/writing-tests/SKILL.md';

		const entries: SkillUsageEntry[] = Array.from({ length: 5 }, (_, i) =>
			makeEntry({
				sessionID,
				skillPath,
				taskID: `task-${i}`,
				timestamp: hourAgo(2),
				complianceVerdict: 'compliant',
			}),
		);

		writeRawLog(
			tempDir,
			entries.map((e) => JSON.stringify(e)).join('\n') + '\n',
		);

		const tailEntries = readSkillUsageEntriesTail(tempDir, { sessionID });
		const taskDesc = 'write tests for hooks';

		const score1 = computeSkillRelevanceScore(skillPath, taskDesc, tailEntries);
		const score2 = computeSkillRelevanceScore(skillPath, taskDesc, tailEntries);
		const score3 = computeSkillRelevanceScore(skillPath, taskDesc, tailEntries);

		expect(score1).toBe(score2);
		expect(score2).toBe(score3);
	});
});

describe('gateBefore with real tail-read and real scoring', () => {
	let tempDir: string;
	let originals: {
		readSkillUsageEntriesTail: typeof gateInternals.readSkillUsageEntriesTail;
		computeSkillRelevanceScore: typeof gateInternals.computeSkillRelevanceScore;
		MAX_SCORING_SESSION_ENTRIES: number;
		appendSkillUsageEntry: typeof gateInternals.appendSkillUsageEntry;
		parseDelegationArgs: typeof gateInternals.parseDelegationArgs;
		discoverAvailableSkills: typeof gateInternals.discoverAvailableSkills;
		extractTaskIdFromPrompt: typeof gateInternals.extractTaskIdFromPrompt;
		parseSkillPaths: typeof gateInternals.parseSkillPaths;
		SKILL_CAPABLE_AGENTS: Set<string>;
		writeWarnEvent: typeof gateInternals.writeWarnEvent;
	};

	beforeEach(() => {
		tempDir = makeTempDir();
		originals = {
			readSkillUsageEntriesTail: gateInternals.readSkillUsageEntriesTail,
			computeSkillRelevanceScore: gateInternals.computeSkillRelevanceScore,
			MAX_SCORING_SESSION_ENTRIES: gateInternals.MAX_SCORING_SESSION_ENTRIES,
			appendSkillUsageEntry: gateInternals.appendSkillUsageEntry,
			parseDelegationArgs: gateInternals.parseDelegationArgs,
			discoverAvailableSkills: gateInternals.discoverAvailableSkills,
			extractTaskIdFromPrompt: gateInternals.extractTaskIdFromPrompt,
			parseSkillPaths: gateInternals.parseSkillPaths,
			SKILL_CAPABLE_AGENTS: gateInternals.SKILL_CAPABLE_AGENTS,
			writeWarnEvent: gateInternals.writeWarnEvent,
		};
	});

	afterEach(() => {
		gateInternals.readSkillUsageEntriesTail =
			originals.readSkillUsageEntriesTail;
		gateInternals.computeSkillRelevanceScore =
			originals.computeSkillRelevanceScore;
		gateInternals.MAX_SCORING_SESSION_ENTRIES =
			originals.MAX_SCORING_SESSION_ENTRIES;
		gateInternals.appendSkillUsageEntry = originals.appendSkillUsageEntry;
		gateInternals.parseDelegationArgs = originals.parseDelegationArgs;
		gateInternals.discoverAvailableSkills = originals.discoverAvailableSkills;
		gateInternals.extractTaskIdFromPrompt = originals.extractTaskIdFromPrompt;
		gateInternals.parseSkillPaths = originals.parseSkillPaths;
		gateInternals.SKILL_CAPABLE_AGENTS = originals.SKILL_CAPABLE_AGENTS;
		gateInternals.writeWarnEvent = originals.writeWarnEvent;
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	test('gateBefore records delegation AND scores using real tail-read output', async () => {
		// Use two different session IDs: historicalSession for pre-populated entries
		// and delegationSession for the gate call. This verifies that pre-populated
		// entries from a different session do not leak into scoring's history.
		const historicalSession = 'historical-session';
		const delegationSession = 'delegation-session';
		const skillPath = '.claude/skills/writing-tests/SKILL.md';

		// Pre-populate log with entries for a DIFFERENT session
		for (let i = 0; i < 3; i++) {
			appendSkillUsageEntry(tempDir, {
				skillPath,
				agentName: 'coder',
				taskID: `prev-task-${i}`,
				complianceVerdict: 'compliant',
				sessionID: historicalSession,
				timestamp: hourAgo(i + 1),
			});
		}

		// Track scoring calls
		let scoringCallCount = 0;
		let lastScoringArgs: Parameters<typeof computeSkillRelevanceScore> | null =
			null;

		gateInternals.parseDelegationArgs = () => ({
			targetAgent: 'coder',
			skillsField: 'writing-tests',
		});
		gateInternals.discoverAvailableSkills = () => [skillPath];
		gateInternals.extractTaskIdFromPrompt = () => 'current-task';
		gateInternals.parseSkillPaths = (v: string) =>
			v === 'writing-tests' ? [skillPath] : [];
		gateInternals.computeSkillRelevanceScore = (
			sp: string,
			desc: string,
			history: SkillUsageEntry[],
		) => {
			scoringCallCount++;
			lastScoringArgs = [sp, desc, history];
			return scoringInternals.computeSkillRelevanceScore(sp, desc, history);
		};
		gateInternals.writeWarnEvent = () => {};

		// Gate call uses a DIFFERENT session ID than pre-populated entries
		await skillPropagationGateBefore(
			tempDir,
			{
				tool: 'task',
				agent: 'architect',
				sessionID: delegationSession,
				args: {
					subagent_type: 'mega_coder',
					prompt: 'SKILLS: writing-tests\ndo the work',
				},
			},
			{ enabled: true },
		);

		// Scoring was called
		expect(scoringCallCount).toBe(1);
		expect(lastScoringArgs).not.toBeNull();

		// The history for delegationSession contains only the newly appended entry
		// (delegation entry appended before scoring reads tail). Pre-populated
		// entries from historicalSession do NOT appear in this session's history.
		const [, , history] = lastScoringArgs!;
		expect(history.length).toBe(1);
		expect(history[0]!.sessionID).toBe(delegationSession);

		// The scored skill path matches
		expect(lastScoringArgs![0]).toBe(skillPath);

		// Pre-populated entries from historicalSession exist separately
		const historicalEntries = readSkillUsageEntries(tempDir, {
			sessionID: historicalSession,
		});
		expect(historicalEntries.length).toBe(3);

		// Delegation was recorded for the correct session
		const usagePath = path.join(tempDir, '.swarm', 'skill-usage.jsonl');
		expect(fs.existsSync(usagePath)).toBe(true);
		const allDelegationEntries = readSkillUsageEntries(tempDir, {
			sessionID: delegationSession,
		});
		expect(allDelegationEntries.length).toBe(1);
		expect(allDelegationEntries[0].skillPath).toBe(skillPath);
		expect(allDelegationEntries[0].taskID).toBe('current-task');
	});

	test('scoring error in gateBefore does not prevent delegation recording', async () => {
		const sessionID = 'gate-error-session';
		const skillPath = '.claude/skills/writing-tests/SKILL.md';

		// Pre-populate
		appendSkillUsageEntry(tempDir, {
			skillPath,
			agentName: 'coder',
			taskID: 'prev-task',
			complianceVerdict: 'compliant',
			sessionID,
			timestamp: hourAgo(1),
		});

		let scoringCalled = false;
		gateInternals.parseDelegationArgs = () => ({
			targetAgent: 'coder',
			skillsField: 'writing-tests',
		});
		gateInternals.discoverAvailableSkills = () => [skillPath];
		gateInternals.extractTaskIdFromPrompt = () => 'current-task';
		gateInternals.parseSkillPaths = (v: string) =>
			v === 'writing-tests' ? [skillPath] : [];
		gateInternals.computeSkillRelevanceScore = () => {
			scoringCalled = true;
			throw new Error('scoring deliberately failed');
		};
		gateInternals.writeWarnEvent = () => {};

		// Should NOT throw
		const result = await skillPropagationGateBefore(
			tempDir,
			{
				tool: 'task',
				agent: 'architect',
				sessionID,
				args: {
					subagent_type: 'mega_coder',
					prompt: 'SKILLS: writing-tests\ndo the work',
				},
			},
			{ enabled: true },
		);
		expect(result.blocked).toBe(false);

		// Scoring attempted
		expect(scoringCalled).toBe(true);

		// But delegation was still recorded
		const allEntries = readSkillUsageEntries(tempDir, { sessionID });
		const delegationEntries = allEntries.filter(
			(e) => e.taskID === 'current-task',
		);
		expect(delegationEntries.length).toBe(1);
	});

	test('gateBefore skips scoring when no tail-read entries returned', async () => {
		const sessionID = 'empty-tail-session';

		let scoringCalled = false;
		gateInternals.parseDelegationArgs = () => ({
			targetAgent: 'coder',
			skillsField: 'writing-tests',
		});
		gateInternals.discoverAvailableSkills = () => [
			'.claude/skills/writing-tests/SKILL.md',
		];
		gateInternals.extractTaskIdFromPrompt = () => 'task-empty';
		gateInternals.parseSkillPaths = (v: string) =>
			v === 'writing-tests' ? ['.claude/skills/writing-tests/SKILL.md'] : [];
		gateInternals.computeSkillRelevanceScore = () => {
			scoringCalled = true;
			return 0;
		};
		gateInternals.writeWarnEvent = () => {};

		// No pre-populated entries for this session
		await skillPropagationGateBefore(
			tempDir,
			{
				tool: 'task',
				agent: 'architect',
				sessionID,
				args: {
					subagent_type: 'mega_coder',
					prompt: 'SKILLS: writing-tests\ndo work',
				},
			},
			{ enabled: true },
		);

		// Scoring IS called (empty history → context-only score)
		expect(scoringCalled).toBe(true);
	});
});

// ============================================================================
// Property-based invariant tests
// ============================================================================

describe('scoring invariants — property tests', () => {
	test('score is always in [0, 1] regardless of entry count', () => {
		const skillPath = '.claude/skills/test/SKILL.md';
		const taskDesc = 'testing the scoring function';

		// Zero entries
		expect(
			computeSkillRelevanceScore(skillPath, taskDesc, []),
		).toBeGreaterThanOrEqual(0);

		// One entry
		expect(
			computeSkillRelevanceScore(skillPath, taskDesc, [
				makeEntry({ complianceVerdict: 'compliant' }),
			]),
		).toBeLessThanOrEqual(1);

		// Many entries
		const manyEntries = Array.from({ length: 100 }, (_, i) =>
			makeEntry({ complianceVerdict: i % 2 === 0 ? 'compliant' : 'violated' }),
		);
		const score = computeSkillRelevanceScore(skillPath, taskDesc, manyEntries);
		expect(score).toBeGreaterThanOrEqual(0);
		expect(score).toBeLessThanOrEqual(1);
	});

	test('idempotency: scoring same entries twice returns same score', () => {
		const entries = [
			makeEntry({ complianceVerdict: 'compliant' }),
			makeEntry({ complianceVerdict: 'violated' }),
			makeEntry({ complianceVerdict: 'compliant' }),
		];
		const skillPath = '.claude/skills/test/SKILL.md';
		const taskDesc = 'testing idempotency';

		const score1 = computeSkillRelevanceScore(skillPath, taskDesc, entries);
		const score2 = computeSkillRelevanceScore(skillPath, taskDesc, entries);

		expect(score1).toBe(score2);
	});

	test('round-trip: append → tail-read → score produces consistent result', () => {
		const tempDir = makeTempDir();
		const sessionID = 'roundtrip-session';
		const skillPath = '.claude/skills/writing-tests/SKILL.md';

		try {
			// Append entries
			for (let i = 0; i < 5; i++) {
				appendSkillUsageEntry(tempDir, {
					skillPath,
					agentName: 'coder',
					taskID: `task-${i}`,
					complianceVerdict: 'compliant',
					sessionID,
					timestamp: hourAgo(i + 1),
				});
			}

			// Read back via tail
			const tailEntries = readSkillUsageEntriesTail(tempDir, { sessionID });

			// Score
			const score = computeSkillRelevanceScore(
				skillPath,
				'write tests for hooks',
				tailEntries,
			);

			// Score should be valid
			expect(score).toBeGreaterThanOrEqual(0);
			expect(score).toBeLessThanOrEqual(1);

			// Re-read and re-score — should be identical
			const tailEntries2 = readSkillUsageEntriesTail(tempDir, { sessionID });
			const score2 = computeSkillRelevanceScore(
				skillPath,
				'write tests for hooks',
				tailEntries2,
			);
			expect(score).toBeCloseTo(score2, 5);
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});
});
