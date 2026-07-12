/**
 * Tests for the REAL `injectSkillsIntoDelegation` function.
 *
 * This file exists (issue #1770) because the pre-existing
 * `skill-injection.test.ts` and `skill-injection-threshold.test.ts` re-
 * implemented the injection logic in local `simulateSkillInjection*` helpers
 * (comments: "Replicates the injection logic from src/index.ts lines 1586-1627")
 * and passed a `mock(() => {})` for the usage logger. Those tests therefore
 * never exercised the real `appendSkillUsageEntry` call site and hardcoded the
 * attribution bug (`agentName: 'architect'`, `taskID: 'injection'`), which is
 * why the defect survived. This file drives the real function end-to-end with
 * real `.swarm/skill-usage.jsonl` file I/O.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { stripKnownSwarmPrefix } from '../../../src/config/schema';
import type { MessageWithParts } from '../../../src/hooks/knowledge-types';
import {
	extractSkillsFieldFromPrompt,
	injectSkillsIntoDelegation,
	type RecommendedSkill,
	SKILL_INJECTION_THRESHOLD,
	SKILL_INJECTION_TOP_N,
	type SkillInjectionResult,
} from '../../../src/hooks/skill-injection';
import {
	parseDelegationArgs,
	skillPropagationGateBefore,
	skillPropagationTransformScan,
} from '../../../src/hooks/skill-propagation-gate';
import { readSkillUsageEntries } from '../../../src/hooks/skill-usage-log';

// =============================================================================
// Helpers
// =============================================================================

function createTempSwarmDir(): string {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spinj-'));
	fs.mkdirSync(path.join(tmpDir, '.swarm'));
	return tmpDir;
}

function createMockSkill(
	rootDir: string,
	treeRelativeSkillPath: string,
	description = 'Mock skill for testing.',
): void {
	// treeRelativeSkillPath e.g. '.opencode/skills/writing-tests/SKILL.md'
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

describe('injectSkillsIntoDelegation — real function', () => {
	let tmpDir: string;
	let sessionID: string;

	beforeEach(() => {
		tmpDir = createTempSwarmDir();
		sessionID = `spinj-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
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

	describe('qualified injection (the main path)', () => {
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

	describe('regression guard — the pre-fix bug does not recur', () => {
		it('NEVER records with agentName === architect or taskID === injection (the legacy bug)', () => {
			createMockSkill(
				tmpDir,
				'.claude/skills/writing-tests/SKILL.md',
				'Test writing.',
			);
			// Pass the architect as the targetAgent arg (as the buggy inline block would have done
			// by reading input.agent). The function must STILL record with whatever targetAgent it's
			// given — but the CALL SITE in src/index.ts now passes parseDelegationArgs().targetAgent,
			// NOT input.agent. This test pins the function's contract: it records targetAgent verbatim.
			const args = { prompt: 'do work' };

			injectSkillsIntoDelegation(
				tmpDir,
				args,
				[makeRecommended('.claude/skills/writing-tests/SKILL.md', 0.8)],
				'coder',
				sessionID,
			);

			const entry = JSON.parse(readUsageLog(tmpDir)[0]);
			// The function records whatever targetAgent it's given. The CALL SITE fix is what
			// prevents 'architect' from being passed. This assertion documents the function-level
			// contract: it does not override targetAgent with a hardcoded 'architect'.
			expect(entry.agentName).toBe('coder');
			expect(entry.taskID).not.toBe('injection');
		});

		it('call-site canonicalization: swarm-prefixed target (mega_coder) records as canonical base (coder)', () => {
			// Mirrors the src/index.ts call-site expression:
			//   stripKnownSwarmPrefix(parseDelegationArgs(input.args)?.targetAgent ?? '')
			// Here we exercise the canonicalization directly: passing the
			// swarm-prefixed name through stripKnownSwarmPrefix yields the
			// canonical base, matching the gate's site 4a attribution.
			createMockSkill(tmpDir, '.claude/skills/canon/SKILL.md', 'Canon.');
			const args = {
				subagent_type: 'mega_coder',
				prompt: 'taskId: c-1\ndo work',
			};
			const parsedTarget = parseDelegationArgs(args)?.targetAgent ?? '';
			const canonicalTarget =
				stripKnownSwarmPrefix(parsedTarget) || 'architect';

			injectSkillsIntoDelegation(
				tmpDir,
				args,
				[makeRecommended('.claude/skills/canon/SKILL.md', 0.9)],
				canonicalTarget,
				sessionID,
			);

			const entry = JSON.parse(readUsageLog(tmpDir)[0]);
			expect(entry.agentName).toBe('coder');
			expect(entry.agentName).not.toBe('mega_coder');
		});

		it('call-site fallback: when parseDelegationArgs returns null, targetAgent falls back to delegator', () => {
			// Mirrors the src/index.ts fallback: when parseDelegationArgs(input.args)
			// returns null (e.g. args missing both subagent_type and prompt),
			// `?.targetAgent ?? ''` yields '', stripKnownSwarmPrefix('') yields '',
			// and `|| String(input.agent)` yields the delegator. The function then
			// returns early (its own parseDelegationArgs(args) call returns null),
			// so no recording happens. This test documents that contract.
			const args: Record<string, unknown> = {}; // no subagent_type, no prompt
			const parsedTarget = parseDelegationArgs(args)?.targetAgent ?? '';
			const canonicalTarget =
				stripKnownSwarmPrefix(parsedTarget) || 'architect';

			const result = injectSkillsIntoDelegation(
				tmpDir,
				args,
				[makeRecommended('.claude/skills/fallback/SKILL.md', 0.9)],
				canonicalTarget,
				sessionID,
			);
			expect(result.injected).toBe(false);
			expect(readUsageLog(tmpDir)).toEqual([]);
		});
	});

	describe('SKILL_COMPLIANCE round-trip — the issue #1770 headline', () => {
		it('injected usage entry joins to a later reviewer compliance verdict via the transform-scan resolver', async () => {
			// This is the test the issue explicitly asks for: verify the
			// SKILL_COMPLIANCE verdict round-trip end-to-end.
			//   1. Architect delegates to coder (no SKILLS) → injection records
			//      a 'not_checked' entry with agentName=coder + real taskID.
			//   2. Later, reviewer emits SKILL_COMPLIANCE: COMPLIANT for the
			//      same skill path. transform-scan resolves the taskID from
			//      the latest non-reviewer delegation entry and records a
			//      'compliant' entry with agentName=reviewer.
			//   3. Both entries land in the same skill's usage history.
			createMockSkill(
				tmpDir,
				'.claude/skills/writing-tests/SKILL.md',
				'Test writing conventions.',
			);
			const skillPath = '.claude/skills/writing-tests/SKILL.md';

			// Step 1: simulate the architect delegation + injection.
			const args = { prompt: 'taskId: round-trip-1\n\nWrite the tests.' };
			const injectResult: SkillInjectionResult = injectSkillsIntoDelegation(
				tmpDir,
				args,
				[makeRecommended(skillPath, 0.85)],
				'coder',
				sessionID,
			);
			expect(injectResult.injected).toBe(true);

			const afterInject = readSkillUsageEntries(tmpDir, { sessionID });
			expect(afterInject.length).toBe(1);
			expect(afterInject[0].agentName).toBe('coder');
			expect(afterInject[0].taskID).toBe('round-trip-1');
			expect(afterInject[0].complianceVerdict).toBe('not_checked');

			// Step 2: simulate the reviewer verdict message.
			const messages: MessageWithParts[] = [
				{
					info: { role: 'assistant', agent: 'reviewer', sessionID },
					parts: [
						{
							type: 'text',
							text: `SKILLS_USED_BY_CODER: file:${skillPath}\nSKILL_COMPLIANCE: COMPLIANT — followed the test-writing conventions.`,
						},
					],
				},
			];

			await skillPropagationTransformScan(tmpDir, { messages }, sessionID);

			// Step 3: the compliance entry joins to the same skill history.
			const afterReview = readSkillUsageEntries(tmpDir, { sessionID });
			expect(afterReview.length).toBe(2);

			const complianceEntry = afterReview.find(
				(e) => e.complianceVerdict === 'compliant',
			);
			expect(complianceEntry).toBeDefined();
			expect(complianceEntry!.agentName).toBe('reviewer');
			expect(complianceEntry!.skillPath).toBe(skillPath);
			// The resolver must have resolved the taskID from the injection entry
			// (latest non-reviewer delegation). With the legacy 'injection' sentinel
			// this only worked by coincidence; with the real taskID 'round-trip-1'
			// it works by correct attribution.
			expect(complianceEntry!.taskID).toBe('round-trip-1');
		});

		it('round-trip still works when the prompt has NO task marker (auto-injected fallback)', async () => {
			// Guards the critic's Item 2: when extractTaskIdFromPrompt returns
			// 'unknown', the function records 'auto-injected' (NOT 'unknown') so
			// the resolver guard `resolvedTaskID !== 'unknown'` continues to fire.
			createMockSkill(
				tmpDir,
				'.claude/skills/no-marker-skill/SKILL.md',
				'No marker skill.',
			);
			const skillPath = '.claude/skills/no-marker-skill/SKILL.md';

			const args = { prompt: 'Write the tests.' };
			injectSkillsIntoDelegation(
				tmpDir,
				args,
				[makeRecommended(skillPath, 0.9)],
				'coder',
				sessionID,
			);

			const afterInject = readSkillUsageEntries(tmpDir, { sessionID });
			expect(afterInject[0].taskID).toBe('auto-injected');
			expect(afterInject[0].taskID).not.toBe('unknown');

			// Reviewer verdict WITHOUT an explicit TASK: line → resolver must
			// fall back to latestDelegation.taskID = 'auto-injected'.
			const messages: MessageWithParts[] = [
				{
					info: { role: 'assistant', agent: 'reviewer', sessionID },
					parts: [
						{
							type: 'text',
							text: `SKILLS_USED_BY_CODER: file:${skillPath}\nSKILL_COMPLIANCE: VIOLATED — did not follow the skill.`,
						},
					],
				},
			];
			await skillPropagationTransformScan(tmpDir, { messages }, sessionID);

			const afterReview = readSkillUsageEntries(tmpDir, { sessionID });
			const violated = afterReview.find(
				(e) => e.complianceVerdict === 'violated',
			);
			expect(violated).toBeDefined();
			// The fallback taskID 'auto-injected' (non-'unknown') must propagate.
			expect(violated!.taskID).toBe('auto-injected');
		});
	});

	describe('gate → injection handoff (full integration)', () => {
		it('recommendedSkills from skillPropagationGateBefore feed injectSkillsIntoDelegation and produce a usage entry', async () => {
			// This test exercises the REAL handoff that src/index.ts performs:
			//   const skillResult = await skillPropagationGateBefore(...);
			//   injectSkillsIntoDelegation(..., skillResult.recommendedSkills, ...);
			// It replaces the parallel-reimplementation "full integration" test
			// in the old skill-injection.test.ts (which used simulateSkillInjection).
			createMockSkill(
				tmpDir,
				'.claude/skills/handoff-skill/SKILL.md',
				'Handoff skill.',
			);

			// Gate sees a delegation with NO SKILLS field → warning path returns
			// recommendedSkills: scored (gate.ts:1116 short-circuits only when
			// SKILLS is present-and-non-none; absent SKILLS falls through to 1157).
			// Cold-start score is low (context-only), so we use `makeRecommended`
			// to lift it above the 0.5 injection threshold — exactly as a richer
			// project with usage history would.
			const gateInput = {
				tool: 'Task',
				agent: 'architect',
				sessionID,
				args: {
					subagent_type: 'mega_coder',
					prompt: 'taskId: handoff-1\nDo the work.',
				},
			};

			const gateResult = await skillPropagationGateBefore(tmpDir, gateInput, {
				enabled: true,
			});
			expect(gateResult.recommendedSkills).toBeDefined();
			expect(gateResult.recommendedSkills!.length).toBeGreaterThan(0);

			// Lift the cold-start scores above the 0.5 threshold (simulates a
			// project with real usage history; the gate's pure-context score
			// is 0.05 here). This is the same shape the gate returns.
			const recommended = gateResult.recommendedSkills!.map((s) => ({
				...s,
				score: Math.max(s.score, 0.8),
			}));

			// Feed those recommendedSkills into the injection function with
			// a FRESH prompt that has no SKILLS field (simulating the next
			// delegation where the architect forgot to specify skills).
			const nextArgs = {
				subagent_type: 'mega_coder',
				prompt: 'taskId: handoff-2\nDo different work.',
			};
			const result = injectSkillsIntoDelegation(
				tmpDir,
				nextArgs,
				recommended,
				'coder',
				sessionID,
			);

			expect(result.injected).toBe(true);
			expect(nextArgs.prompt).toContain(
				'SKILLS: file:.claude/skills/handoff-skill/SKILL.md',
			);

			// The usage entry from THIS injection uses handoff-2 (the new prompt's taskID).
			const entries = readSkillUsageEntries(tmpDir, { sessionID });
			const injectionEntry = entries.find((e) => e.taskID === 'handoff-2');
			expect(injectionEntry).toBeDefined();
			expect(injectionEntry!.agentName).toBe('coder');
			expect(injectionEntry!.complianceVerdict).toBe('not_checked');
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
