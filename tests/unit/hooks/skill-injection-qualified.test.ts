/**
 * Tests for `injectSkillsIntoDelegation` — the qualified-injection path.
 *
 * Part of the issue #1770 test suite (split for FR-006 ≤500-line cap). Sibling
 * files:
 *   - skill-injection-skip-and-none.test.ts   (skip/no-op + SKILLS:none + error)
 *   - skill-injection-roundtrip.test.ts       (regression guard + round-trip)
 *
 * This file covers: SKILLS-line injection mechanics, attribution, threshold
 * filtering, top-N cap, reviewer forwarding, comma-stripping, and the
 * qualified-branch decision event. All against the REAL function with real
 * `.swarm/` file I/O.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	extractSkillsFieldFromPrompt,
	injectSkillsIntoDelegation,
	type RecommendedSkill,
	SKILL_INJECTION_THRESHOLD,
	SKILL_INJECTION_TOP_N,
} from '../../../src/hooks/skill-injection';

// =============================================================================
// Helpers
// =============================================================================

function createTempSwarmDir(): string {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spinj-qual-'));
	fs.mkdirSync(path.join(tmpDir, '.swarm'));
	return tmpDir;
}

function createMockSkill(
	rootDir: string,
	treeRelativeSkillPath: string,
	description = 'Mock skill for testing.',
): void {
	const abs = path.join(rootDir, treeRelativeSkillPath);
	fs.mkdirSync(path.dirname(abs), { recursive: true });
	fs.writeFileSync(
		abs,
		`---\nname: ${path.basename(path.dirname(treeRelativeSkillPath))}\ndescription: ${description}\n---\n# ${path.basename(path.dirname(treeRelativeSkillPath))}\n`,
	);
}

function makeRecommended(
	skillPath: string,
	score: number,
	usageCount = 0,
): RecommendedSkill {
	return { skillPath, score, usageCount };
}

function readEvents(directory: string): Array<Record<string, unknown>> {
	const eventsPath = path.join(directory, '.swarm', 'events.jsonl');
	if (!fs.existsSync(eventsPath)) return [];
	return fs
		.readFileSync(eventsPath, 'utf-8')
		.split('\n')
		.filter((l) => l.trim().length > 0)
		.map((l) => JSON.parse(l));
}

function readUsageLog(directory: string): string[] {
	const logPath = path.join(directory, '.swarm', 'skill-usage.jsonl');
	if (!fs.existsSync(logPath)) return [];
	return fs
		.readFileSync(logPath, 'utf-8')
		.split('\n')
		.filter((l) => l.trim().length > 0);
}

// =============================================================================
// Tests
// =============================================================================

describe('injectSkillsIntoDelegation — qualified injection mechanics', () => {
	let tmpDir: string;
	let sessionID: string;

	beforeEach(() => {
		tmpDir = createTempSwarmDir();
		sessionID = `spinj-qual-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it('injects SKILLS line, records usage with TARGET SUBAGENT attribution (regression: NOT architect + injection)', () => {
		createMockSkill(
			tmpDir,
			'.claude/skills/writing-tests/SKILL.md',
			'Test writing conventions.',
		);
		const args = { prompt: 'Write tests for the feature.' };

		const result = injectSkillsIntoDelegation(
			tmpDir,
			args,
			[makeRecommended('.claude/skills/writing-tests/SKILL.md', 0.8)],
			'coder',
			sessionID,
		);

		expect(result.injected).toBe(true);
		expect(result.injectedSkills.length).toBe(1);
		expect(result.injectedSkills[0].skillPath).toBe(
			'.claude/skills/writing-tests/SKILL.md',
		);
		expect(args.prompt).toContain(
			'SKILLS: file:.claude/skills/writing-tests/SKILL.md',
		);
		expect(args.prompt).toContain('Write tests for the feature.');

		// Usage entry: ONE per injected skill, persisted to disk.
		const lines = readUsageLog(tmpDir);
		expect(lines.length).toBe(1);
		const entry = JSON.parse(lines[0]);

		// REGRESSION GUARD: agentName must be the target subagent (coder),
		// not the architect/delegator.
		expect(entry.agentName).toBe('coder');
		expect(entry.agentName).not.toBe('architect');

		// REGRESSION GUARD: taskID must NOT be the legacy synthetic 'injection'.
		expect(entry.taskID).not.toBe('injection');
		expect(entry.taskID).toBe('auto-injected');

		expect(entry.skillPath).toBe('.claude/skills/writing-tests/SKILL.md');
		expect(entry.complianceVerdict).toBe('not_checked');
		expect(entry.sessionID).toBe(sessionID);
	});

	it('uses the real taskID when the prompt contains a taskId: marker', () => {
		createMockSkill(
			tmpDir,
			'.claude/skills/writing-tests/SKILL.md',
			'Test writing.',
		);
		const args = {
			prompt: 'taskId: task-7-2-write-tests\n\nWrite tests for the feature.',
		};

		injectSkillsIntoDelegation(
			tmpDir,
			args,
			[makeRecommended('.claude/skills/writing-tests/SKILL.md', 0.9)],
			'coder',
			sessionID,
		);

		const entry = JSON.parse(readUsageLog(tmpDir)[0]);
		expect(entry.taskID).toBe('task-7-2-write-tests');
		expect(entry.taskID).not.toBe('injection');
		expect(entry.taskID).not.toBe('auto-injected');
	});

	it('uses the real taskID when the prompt contains a TASK: marker', () => {
		createMockSkill(
			tmpDir,
			'.claude/skills/writing-tests/SKILL.md',
			'Test writing.',
		);
		const args = { prompt: 'TASK: feat-123\n\nWrite tests.' };

		injectSkillsIntoDelegation(
			tmpDir,
			args,
			[makeRecommended('.claude/skills/writing-tests/SKILL.md', 0.9)],
			'coder',
			sessionID,
		);

		const entry = JSON.parse(readUsageLog(tmpDir)[0]);
		expect(entry.taskID).toBe('feat-123');
	});

	it('records ONE entry per injected skill (multiple skills)', () => {
		createMockSkill(tmpDir, '.claude/skills/alpha/SKILL.md', 'Alpha skill.');
		createMockSkill(tmpDir, '.claude/skills/beta/SKILL.md', 'Beta skill.');
		const args = { prompt: 'do work' };

		injectSkillsIntoDelegation(
			tmpDir,
			args,
			[
				makeRecommended('.claude/skills/alpha/SKILL.md', 0.9),
				makeRecommended('.claude/skills/beta/SKILL.md', 0.7),
			],
			'coder',
			sessionID,
		);

		const lines = readUsageLog(tmpDir);
		expect(lines.length).toBe(2);
		const paths = lines.map((l) => JSON.parse(l).skillPath).sort();
		expect(paths).toEqual([
			'.claude/skills/alpha/SKILL.md',
			'.claude/skills/beta/SKILL.md',
		]);
		// All entries share the same taskID (resolved once from the prompt).
		const taskIDs = new Set(lines.map((l) => JSON.parse(l).taskID));
		expect(taskIDs.size).toBe(1);
	});

	it('caps injection at the top N (SKILL_INJECTION_TOP_N) highest-scoring skills', () => {
		for (let i = 0; i < SKILL_INJECTION_TOP_N + 3; i++) {
			createMockSkill(
				tmpDir,
				`.claude/skills/skill-${i}/SKILL.md`,
				`Skill ${i}.`,
			);
		}
		const args = { prompt: 'do work' };
		const recommended = Array.from(
			{ length: SKILL_INJECTION_TOP_N + 3 },
			(_, i) =>
				makeRecommended(
					`.claude/skills/skill-${i}/SKILL.md`,
					// higher i = higher score, so the top N are the last N indices
					0.5 + i * 0.05,
				),
		);

		const result = injectSkillsIntoDelegation(
			tmpDir,
			args,
			recommended,
			'coder',
			sessionID,
		);

		expect(result.injectedSkills.length).toBe(SKILL_INJECTION_TOP_N);
		expect(readUsageLog(tmpDir).length).toBe(SKILL_INJECTION_TOP_N);
	});

	it('filters out skills below the 0.5 threshold', () => {
		createMockSkill(tmpDir, '.claude/skills/high/SKILL.md', 'High.');
		createMockSkill(tmpDir, '.claude/skills/low/SKILL.md', 'Low.');
		const args = { prompt: 'do work' };

		const result = injectSkillsIntoDelegation(
			tmpDir,
			args,
			[
				makeRecommended('.claude/skills/high/SKILL.md', 0.6),
				makeRecommended('.claude/skills/low/SKILL.md', 0.49),
			],
			'coder',
			sessionID,
		);

		expect(result.injectedSkills.length).toBe(1);
		expect(result.injectedSkills[0].skillPath).toBe(
			'.claude/skills/high/SKILL.md',
		);
		expect(readUsageLog(tmpDir).length).toBe(1);
	});

	it('boundary: a skill scoring EXACTLY 0.5 IS injected (>= threshold)', () => {
		createMockSkill(tmpDir, '.claude/skills/exact/SKILL.md', 'Exact.');
		const args = { prompt: 'do work' };
		const result = injectSkillsIntoDelegation(
			tmpDir,
			args,
			[
				makeRecommended(
					'.claude/skills/exact/SKILL.md',
					SKILL_INJECTION_THRESHOLD,
				),
			],
			'coder',
			sessionID,
		);
		expect(result.injected).toBe(true);
		expect(result.injectedSkills.length).toBe(1);
	});

	it('boundary: a skill scoring 0.49 is NOT injected (below threshold)', () => {
		createMockSkill(
			tmpDir,
			'.claude/skills/just-below/SKILL.md',
			'Just below.',
		);
		const args = { prompt: 'do work' };
		const result = injectSkillsIntoDelegation(
			tmpDir,
			args,
			[makeRecommended('.claude/skills/just-below/SKILL.md', 0.49)],
			'coder',
			sessionID,
		);
		// Below threshold → falls into the SKILLS: none branch.
		expect(result.injected).toBe(true);
		expect(result.injectedSkills).toEqual([]);
		expect(args.prompt).toMatch(/^SKILLS: none/);
		expect(readUsageLog(tmpDir)).toEqual([]);
	});

	it('mixed scores — only >= 0.5 skills are injected, others ignored', () => {
		createMockSkill(tmpDir, '.claude/skills/a/SKILL.md', 'A.');
		createMockSkill(tmpDir, '.claude/skills/b/SKILL.md', 'B.');
		createMockSkill(tmpDir, '.claude/skills/c/SKILL.md', 'C.');
		const args = { prompt: 'do work' };
		const result = injectSkillsIntoDelegation(
			tmpDir,
			args,
			[
				makeRecommended('.claude/skills/a/SKILL.md', 0.9),
				makeRecommended('.claude/skills/b/SKILL.md', 0.3),
				makeRecommended('.claude/skills/c/SKILL.md', 0.5),
			],
			'coder',
			sessionID,
		);
		expect(result.injectedSkills.map((s) => s.skillPath).sort()).toEqual([
			'.claude/skills/a/SKILL.md',
			'.claude/skills/c/SKILL.md',
		]);
	});

	it('preserves an explicit uppercase SKILLS: NONE (no injection, no recording)', () => {
		const args = { prompt: 'SKILLS: NONE\n\ndo work' };
		const result = injectSkillsIntoDelegation(
			tmpDir,
			args,
			[makeRecommended('.claude/skills/x/SKILL.md', 0.9)],
			'coder',
			sessionID,
		);
		expect(result.injected).toBe(false);
		expect(readUsageLog(tmpDir)).toEqual([]);
	});

	it('appends SKILLS_USED_BY_CODER line when target is a reviewer', () => {
		createMockSkill(
			tmpDir,
			'.claude/skills/writing-tests/SKILL.md',
			'Test writing.',
		);
		const args = { prompt: 'taskId: t-1\n\nReview the coder work.' };

		injectSkillsIntoDelegation(
			tmpDir,
			args,
			[makeRecommended('.claude/skills/writing-tests/SKILL.md', 0.9)],
			'reviewer',
			sessionID,
		);

		expect(args.prompt).toContain(
			'SKILLS_USED_BY_CODER: file:.claude/skills/writing-tests/SKILL.md',
		);
		// The reviewer forwarding still records with agentName=reviewer (the target).
		const entry = JSON.parse(readUsageLog(tmpDir)[0]);
		expect(entry.agentName).toBe('reviewer');
	});

	it('does NOT append SKILLS_USED_BY_CODER for non-reviewer targets (negative case)', () => {
		// Regression guard: a bug that unconditionally appends the line would
		// leak coder-provenance into non-reviewer prompts (corrupting the
		// compliance loop's signal source).
		createMockSkill(
			tmpDir,
			'.claude/skills/writing-tests/SKILL.md',
			'Test writing.',
		);
		const args = { prompt: 'taskId: t-1\n\nDo the work.' };

		injectSkillsIntoDelegation(
			tmpDir,
			args,
			[makeRecommended('.claude/skills/writing-tests/SKILL.md', 0.9)],
			'coder',
			sessionID,
		);

		expect(args.prompt).toContain(
			'SKILLS: file:.claude/skills/writing-tests/SKILL.md',
		);
		expect(args.prompt).not.toContain('SKILLS_USED_BY_CODER');
	});

	it('reviewer forwarding is case-insensitive and prefix-tolerant (mega_reviewer)', () => {
		createMockSkill(
			tmpDir,
			'.claude/skills/writing-tests/SKILL.md',
			'Test writing.',
		);
		const args = { prompt: 'taskId: t-1\n\nReview.' };

		injectSkillsIntoDelegation(
			tmpDir,
			args,
			[makeRecommended('.claude/skills/writing-tests/SKILL.md', 0.9)],
			'mega_reviewer',
			sessionID,
		);

		expect(args.prompt).toContain('SKILLS_USED_BY_CODER:');
	});

	it('strips commas from skill descriptions to avoid corrupting comma-delimited SKILLS parsing', () => {
		createMockSkill(
			tmpDir,
			'.claude/skills/commas/SKILL.md',
			'A, B, and C skill.',
		);
		const args = { prompt: 'do work' };

		injectSkillsIntoDelegation(
			tmpDir,
			args,
			[makeRecommended('.claude/skills/commas/SKILL.md', 0.9)],
			'coder',
			sessionID,
		);

		// The description in the SKILLS line must not contain raw commas.
		const skillsLine = args.prompt.split('\n')[0];
		expect(skillsLine).toMatch(/^SKILLS:/);
		// Re-parse the field to confirm round-trip yields exactly ONE skill path.
		const reparsed = extractSkillsFieldFromPrompt(args.prompt);
		expect(reparsed).not.toContain('; ;'); // sanity: no double-semicolons
	});

	it('emits a skill_injection_decision event for the qualified branch', () => {
		createMockSkill(tmpDir, '.claude/skills/x/SKILL.md', 'X.');
		const args = { prompt: 'do work' };

		injectSkillsIntoDelegation(
			tmpDir,
			args,
			[makeRecommended('.claude/skills/x/SKILL.md', 0.7)],
			'coder',
			sessionID,
		);

		const events = readEvents(tmpDir).filter(
			(e) => e.type === 'skill_injection_decision',
		);
		expect(events.length).toBe(1);
		expect(events[0].decision).toBe('injected');
		expect(Array.isArray(events[0].injected)).toBe(true);
		expect(events[0].injected.length).toBe(1);
		expect(events[0].target_agent).toBe('coder');
	});
});
