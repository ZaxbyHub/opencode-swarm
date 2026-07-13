/**
 * Tests for `injectSkillsIntoDelegation` — skip/no-op paths, the `SKILLS: none`
 * branch, and error resilience.
 *
 * Part of the issue #1770 test suite (split for FR-006 ≤500-line cap). The
 * headline attribution + round-trip coverage lives in the sibling files:
 *   - skill-injection-qualified.test.ts        (qualified-injection mechanics)
 *   - skill-injection-roundtrip.test.ts        (regression guard + round-trip)
 *
 * This file exercises the REAL `injectSkillsIntoDelegation` function with real
 * `.swarm/` file I/O (no parallel re-implementation, no mocked logger).
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	injectSkillsIntoDelegation,
	type RecommendedSkill,
	SKILL_INJECTION_THRESHOLD,
} from '../../../src/hooks/skill-injection';

// =============================================================================
// Helpers
// =============================================================================

function createTempSwarmDir(): string {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spinj-skip-'));
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

describe('injectSkillsIntoDelegation — skip / none / error', () => {
	let tmpDir: string;
	let sessionID: string;

	beforeEach(() => {
		tmpDir = createTempSwarmDir();
		sessionID = `spinj-skip-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	describe('skip / no-op paths', () => {
		it('returns injected=false when recommendedSkills is undefined', () => {
			const args = { prompt: 'do stuff' };
			const result = injectSkillsIntoDelegation(
				tmpDir,
				args,
				undefined,
				'coder',
				sessionID,
			);
			expect(result.injected).toBe(false);
			expect(result.injectedSkills).toEqual([]);
			expect(args.prompt).toBe('do stuff');
			expect(readUsageLog(tmpDir)).toEqual([]);
		});

		it('returns injected=false when recommendedSkills is empty', () => {
			const args = { prompt: 'do stuff' };
			const result = injectSkillsIntoDelegation(
				tmpDir,
				args,
				[],
				'coder',
				sessionID,
			);
			expect(result.injected).toBe(false);
			expect(readUsageLog(tmpDir)).toEqual([]);
		});

		it('returns injected=false when args.prompt is not a string', () => {
			const args = { prompt: 42 };
			const result = injectSkillsIntoDelegation(
				tmpDir,
				args,
				[makeRecommended('.claude/skills/x/SKILL.md', 0.9)],
				'coder',
				sessionID,
			);
			expect(result.injected).toBe(false);
		});

		it('returns injected=false when an explicit SKILLS field already exists', () => {
			const args = {
				prompt: 'SKILLS: file:.claude/skills/x/SKILL.md\n\ndo stuff',
			};
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

		it('returns injected=false when prompt has explicit SKILLS: none', () => {
			const args = { prompt: 'SKILLS: none\n\ndo stuff' };
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

		it('returns injected=false when parseDelegationArgs returns null (no agent identity)', () => {
			// args with neither subagent_type nor a prompt first-line → parseDelegationArgs returns null
			const args: Record<string, unknown> = {};
			const result = injectSkillsIntoDelegation(
				tmpDir,
				args,
				[makeRecommended('.claude/skills/x/SKILL.md', 0.9)],
				'coder',
				sessionID,
			);
			expect(result.injected).toBe(false);
		});
	});

	describe('SKILLS: none branch (no skill above threshold)', () => {
		it('injects SKILLS: none and emits a decision event but writes NO usage entry', () => {
			// Critical regression guard: phantom usage would corrupt per-skill scoring.
			const args = { prompt: 'do the thing' };
			const result = injectSkillsIntoDelegation(
				tmpDir,
				args,
				[makeRecommended('.claude/skills/low-skill/SKILL.md', 0.2)],
				'coder',
				sessionID,
			);

			expect(result.injected).toBe(true);
			expect(result.injectedSkills).toEqual([]);
			expect(args.prompt).toBe('SKILLS: none\n\ndo the thing');
			// No usage entries for the none branch.
			expect(readUsageLog(tmpDir)).toEqual([]);

			// Decision event IS emitted for observability.
			const events = readEvents(tmpDir).filter(
				(e) => e.type === 'skill_injection_decision',
			);
			expect(events.length).toBe(1);
			expect(events[0].decision).toBe('none');
			expect(events[0].reason).toBe('no_skill_above_threshold');
			expect(events[0].threshold).toBe(SKILL_INJECTION_THRESHOLD);
			expect(events[0].target_agent).toBe('coder');
		});

		it('emits the decision event even when quiet=true (only console.warn is suppressed)', () => {
			const args = { prompt: 'do the thing' };
			injectSkillsIntoDelegation(
				tmpDir,
				args,
				[makeRecommended('.claude/skills/low-skill/SKILL.md', 0.1)],
				'coder',
				sessionID,
				{ quiet: true },
			);
			const events = readEvents(tmpDir).filter(
				(e) => e.type === 'skill_injection_decision',
			);
			expect(events.length).toBe(1);
		});
	});

	describe('error resilience', () => {
		it('does not throw when appendSkillUsageEntry fails (best-effort audit logging)', () => {
			// Simulate a broken .swarm directory: make skill-usage.jsonl unwritable
			// by pointing the directory at a file (so the mkdir/append inside
			// appendSkillUsageEntry throws). The function must swallow and continue.
			createMockSkill(
				tmpDir,
				'.claude/skills/err-skill/SKILL.md',
				'Err skill.',
			);
			const args = { prompt: 'do work' };

			// Replace .swarm with a FILE so writes fail. The function catches.
			fs.rmSync(path.join(tmpDir, '.swarm'), { recursive: true, force: true });
			fs.writeFileSync(path.join(tmpDir, '.swarm'), 'not a directory');

			expect(() => {
				injectSkillsIntoDelegation(
					tmpDir,
					args,
					[makeRecommended('.claude/skills/err-skill/SKILL.md', 0.9)],
					'coder',
					sessionID,
				);
			}).not.toThrow();
			// The prompt was still mutated; only recording failed.
			expect(args.prompt).toContain(
				'SKILLS: file:.claude/skills/err-skill/SKILL.md',
			);
		});
	});
});
