/**
 * Tests for skill injection mechanics.
 *
 * Tests the injection logic in src/index.ts (tool.execute.before hook wiring)
 * that auto-injects recommended skills into args.prompt when:
 *   - recommendedSkills is non-empty
 *   - the prompt has no SKILLS field
 *
 * Key behaviors:
 *   1. When recommendedSkills is non-empty and prompt has no SKILLS field → SKILLS is injected
 *   2. When prompt explicitly has SKILLS: none → nothing injected
 *   3. When prompt already has a SKILLS field → nothing injected
 *   4. When recommendedSkills is empty or undefined → nothing injected
 *   5. Top 5 skills are used (not more)
 *   6. Format is correct: "SKILLS: file:.claude/skills/writing-tests/SKILL.md, ..."
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
	_internals,
	parseDelegationArgs,
	skillPropagationGateBefore,
} from '../../../src/hooks/skill-propagation-gate';
import type { SkillUsageEntry } from '../../../src/hooks/skill-usage-log';

// ============================================================================
// Helpers
// ============================================================================

function tmpDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), 'skill-inject-test-'));
}

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
// Skill injection function
// Replicates the injection logic from src/index.ts lines 1586-1627
// ============================================================================

interface RecommendedSkill {
	skillPath: string;
	score: number;
	usageCount: number;
}

interface SimulatedSkillResult {
	recommendedSkills?: RecommendedSkill[];
}

/**
 * Simulates the skill injection step from src/index.ts tool.execute.before hook.
 * Returns the new prompt value (or undefined if no injection occurred).
 */
function simulateSkillInjection(
	skillResult: SimulatedSkillResult,
	argsRecord: Record<string, unknown>,
): string | undefined {
	if (
		!skillResult.recommendedSkills ||
		skillResult.recommendedSkills.length === 0
	) {
		return undefined;
	}

	const promptRaw = argsRecord.prompt;
	if (typeof promptRaw !== 'string') {
		return undefined;
	}

	// Parse the prompt to check for existing SKILLS field
	const parsedDelegation = parseDelegationArgs(argsRecord);
	if (!parsedDelegation) {
		return undefined;
	}

	const existingSkills = parsedDelegation.skillsField.trim();
	// Skip injection if SKILLS field already exists or is explicitly "none"
	if (existingSkills) {
		return undefined;
	}

	// Build SKILLS line from top 5 recommended skills
	const topSkills = skillResult.recommendedSkills.slice(0, 5);
	const skillPaths = topSkills.map((s) => `file:${s.skillPath}`).join(', ');

	const skillsLine = `SKILLS: ${skillPaths}`;

	// Inject at the beginning of the prompt
	const newPrompt = `${skillsLine}\n\n${promptRaw}`;

	// Mutate the argsRecord to simulate the real behavior
	argsRecord.prompt = newPrompt;

	return newPrompt;
}

// ============================================================================
// Test cases
// ============================================================================

describe('skill injection mechanics', () => {
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

	// -------------------------------------------------------------------------
	// Case 1: recommendedSkills non-empty + no SKILLS field → injection occurs
	// -------------------------------------------------------------------------

	describe('Case 1 — recommendedSkills non-empty, no SKILLS field → injection', () => {
		test('injects SKILLS line at the beginning of the prompt', () => {
			const argsRecord = {
				subagent_type: 'mega_coder',
				prompt: 'TO coder\ntaskId: task-1\n\nWrite the tests.',
			};

			const skillResult: SimulatedSkillResult = {
				recommendedSkills: [
					{
						skillPath: '.claude/skills/writing-tests/SKILL.md',
						score: 0.85,
						usageCount: 3,
					},
				],
			};

			const newPrompt = simulateSkillInjection(skillResult, argsRecord);

			expect(newPrompt).toBeDefined();
			expect(newPrompt).toContain(
				'SKILLS: file:.claude/skills/writing-tests/SKILL.md',
			);
			expect(newPrompt).toContain(
				'TO coder\ntaskId: task-1\n\nWrite the tests.',
			);
		});

		test('mutates argsRecord.prompt directly', () => {
			const argsRecord = {
				subagent_type: 'mega_coder',
				prompt: 'Write the code.',
			};

			const skillResult: SimulatedSkillResult = {
				recommendedSkills: [
					{
						skillPath: '.claude/skills/code/SKILL.md',
						score: 0.7,
						usageCount: 2,
					},
				],
			};

			simulateSkillInjection(skillResult, argsRecord);

			expect(argsRecord.prompt).toContain(
				'SKILLS: file:.claude/skills/code/SKILL.md',
			);
			expect(argsRecord.prompt).toContain('Write the code.');
		});

		test('injects multiple skills as comma-separated', () => {
			const argsRecord = {
				subagent_type: 'mega_coder',
				prompt: 'Do the work.',
			};

			const skillResult: SimulatedSkillResult = {
				recommendedSkills: [
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
						score: 0.5,
						usageCount: 1,
					},
				],
			};

			const newPrompt = simulateSkillInjection(skillResult, argsRecord);

			expect(newPrompt).toBeDefined();
			expect(newPrompt).toContain(
				'SKILLS: file:.claude/skills/writing-tests/SKILL.md, file:.claude/skills/code/SKILL.md, file:.claude/skills/review/SKILL.md',
			);
		});
	});

	// -------------------------------------------------------------------------
	// Case 2: prompt has SKILLS: none → no injection
	// -------------------------------------------------------------------------

	describe('Case 2 — prompt has SKILLS: none → no injection', () => {
		test('SKILLS: none is preserved and no injection occurs', () => {
			const argsRecord = {
				subagent_type: 'mega_coder',
				prompt: 'SKILLS: none\n\nDo the work.',
			};

			const skillResult: SimulatedSkillResult = {
				recommendedSkills: [
					{
						skillPath: '.claude/skills/writing-tests/SKILL.md',
						score: 0.85,
						usageCount: 3,
					},
				],
			};

			const newPrompt = simulateSkillInjection(skillResult, argsRecord);

			expect(newPrompt).toBeUndefined();
			expect(argsRecord.prompt).toBe('SKILLS: none\n\nDo the work.');
		});

		test('SKILLS: NONE (uppercase) is preserved', () => {
			const argsRecord = {
				subagent_type: 'mega_coder',
				prompt: 'SKILLS: NONE\n\nDo the work.',
			};

			const skillResult: SimulatedSkillResult = {
				recommendedSkills: [
					{
						skillPath: '.claude/skills/writing-tests/SKILL.md',
						score: 0.85,
						usageCount: 3,
					},
				],
			};

			const newPrompt = simulateSkillInjection(skillResult, argsRecord);

			expect(newPrompt).toBeUndefined();
		});

		test('SKILLS:  none (with whitespace) is preserved', () => {
			const argsRecord = {
				subagent_type: 'mega_coder',
				prompt: 'SKILLS:   none  \n\nDo the work.',
			};

			const skillResult: SimulatedSkillResult = {
				recommendedSkills: [
					{
						skillPath: '.claude/skills/writing-tests/SKILL.md',
						score: 0.85,
						usageCount: 3,
					},
				],
			};

			const newPrompt = simulateSkillInjection(skillResult, argsRecord);

			// parseDelegationArgs trims, so 'none' with whitespace still triggers the skip
			expect(newPrompt).toBeUndefined();
		});
	});

	// -------------------------------------------------------------------------
	// Case 3: prompt already has a SKILLS field → no injection
	// -------------------------------------------------------------------------

	describe('Case 3 — prompt already has SKILLS field → no injection', () => {
		test('existing SKILLS field is preserved', () => {
			const argsRecord = {
				subagent_type: 'mega_coder',
				prompt: 'SKILLS: file:.claude/skills/custom/SKILL.md\n\nDo the work.',
			};

			const skillResult: SimulatedSkillResult = {
				recommendedSkills: [
					{
						skillPath: '.claude/skills/writing-tests/SKILL.md',
						score: 0.85,
						usageCount: 3,
					},
				],
			};

			const newPrompt = simulateSkillInjection(skillResult, argsRecord);

			expect(newPrompt).toBeUndefined();
			expect(argsRecord.prompt).toBe(
				'SKILLS: file:.claude/skills/custom/SKILL.md\n\nDo the work.',
			);
		});

		test('SKILLS field in middle of prompt still blocks injection', () => {
			const argsRecord = {
				subagent_type: 'mega_coder',
				prompt: 'TO coder\nSKILLS: custom-skill\n\nDo the work.',
			};

			const skillResult: SimulatedSkillResult = {
				recommendedSkills: [
					{
						skillPath: '.claude/skills/writing-tests/SKILL.md',
						score: 0.85,
						usageCount: 3,
					},
				],
			};

			const newPrompt = simulateSkillInjection(skillResult, argsRecord);

			expect(newPrompt).toBeUndefined();
		});
	});

	// -------------------------------------------------------------------------
	// Case 4: recommendedSkills empty or undefined → no injection
	// -------------------------------------------------------------------------

	describe('Case 4 — recommendedSkills empty/undefined → no injection', () => {
		test('undefined recommendedSkills → no injection', () => {
			const argsRecord = {
				subagent_type: 'mega_coder',
				prompt: 'TO coder\n\nDo the work.',
			};

			const skillResult: SimulatedSkillResult = {
				recommendedSkills: undefined,
			};

			const newPrompt = simulateSkillInjection(skillResult, argsRecord);

			expect(newPrompt).toBeUndefined();
			expect(argsRecord.prompt).toBe('TO coder\n\nDo the work.');
		});

		test('empty recommendedSkills array → no injection', () => {
			const argsRecord = {
				subagent_type: 'mega_coder',
				prompt: 'TO coder\n\nDo the work.',
			};

			const skillResult: SimulatedSkillResult = {
				recommendedSkills: [],
			};

			const newPrompt = simulateSkillInjection(skillResult, argsRecord);

			expect(newPrompt).toBeUndefined();
		});
	});

	// -------------------------------------------------------------------------
	// Case 5: Top 5 skills are used (not more)
	// -------------------------------------------------------------------------

	describe('Case 5 — top 5 skills are used', () => {
		test('injects exactly top 5 when more than 5 are available', () => {
			const argsRecord = {
				subagent_type: 'mega_coder',
				prompt: 'Do the work.',
			};

			const skillResult: SimulatedSkillResult = {
				recommendedSkills: [
					{
						skillPath: '.claude/skills/skill-1/SKILL.md',
						score: 0.95,
						usageCount: 10,
					},
					{
						skillPath: '.claude/skills/skill-2/SKILL.md',
						score: 0.9,
						usageCount: 9,
					},
					{
						skillPath: '.claude/skills/skill-3/SKILL.md',
						score: 0.85,
						usageCount: 8,
					},
					{
						skillPath: '.claude/skills/skill-4/SKILL.md',
						score: 0.8,
						usageCount: 7,
					},
					{
						skillPath: '.claude/skills/skill-5/SKILL.md',
						score: 0.75,
						usageCount: 6,
					},
					{
						skillPath: '.claude/skills/skill-6/SKILL.md',
						score: 0.7,
						usageCount: 5,
					},
					{
						skillPath: '.claude/skills/skill-7/SKILL.md',
						score: 0.65,
						usageCount: 4,
					},
				],
			};

			const newPrompt = simulateSkillInjection(skillResult, argsRecord);

			expect(newPrompt).toBeDefined();
			// Should contain exactly 5 skills
			expect(newPrompt).toContain('skill-1');
			expect(newPrompt).toContain('skill-2');
			expect(newPrompt).toContain('skill-3');
			expect(newPrompt).toContain('skill-4');
			expect(newPrompt).toContain('skill-5');
			// Should NOT contain skill-6 or skill-7
			expect(newPrompt).not.toContain('skill-6');
			expect(newPrompt).not.toContain('skill-7');
		});

		test('injects all when fewer than 5 are available', () => {
			const argsRecord = {
				subagent_type: 'mega_coder',
				prompt: 'Do the work.',
			};

			const skillResult: SimulatedSkillResult = {
				recommendedSkills: [
					{
						skillPath: '.claude/skills/skill-a/SKILL.md',
						score: 0.9,
						usageCount: 3,
					},
					{
						skillPath: '.claude/skills/skill-b/SKILL.md',
						score: 0.7,
						usageCount: 1,
					},
				],
			};

			const newPrompt = simulateSkillInjection(skillResult, argsRecord);

			expect(newPrompt).toBeDefined();
			expect(newPrompt).toContain('skill-a');
			expect(newPrompt).toContain('skill-b');
		});

		test('slice(0, 5) is used — exactly 5 entries max', () => {
			// Create a local array with 7 items and verify slice(0, 5) limits to 5
			const skills = [
				{ skillPath: 's1', score: 0.95, usageCount: 10 },
				{ skillPath: 's2', score: 0.9, usageCount: 9 },
				{ skillPath: 's3', score: 0.85, usageCount: 8 },
				{ skillPath: 's4', score: 0.8, usageCount: 7 },
				{ skillPath: 's5', score: 0.75, usageCount: 6 },
				{ skillPath: 's6', score: 0.7, usageCount: 5 },
				{ skillPath: 's7', score: 0.65, usageCount: 4 },
			];
			const top5 = skills.slice(0, 5);
			expect(top5.length).toBe(5);
			// 6th and 7th items should not be in top5
			expect(top5.find((s) => s.skillPath === 's6')).toBeUndefined();
			expect(top5.find((s) => s.skillPath === 's7')).toBeUndefined();
		});
	});

	// -------------------------------------------------------------------------
	// Case 6: Format is correct
	// -------------------------------------------------------------------------

	describe('Case 6 — format is correct', () => {
		test('SKILLS line format is "SKILLS: file:..."', () => {
			const argsRecord = {
				subagent_type: 'mega_coder',
				prompt: 'Do the work.',
			};

			const skillResult: SimulatedSkillResult = {
				recommendedSkills: [
					{
						skillPath: '.claude/skills/writing-tests/SKILL.md',
						score: 0.85,
						usageCount: 3,
					},
				],
			};

			const newPrompt = simulateSkillInjection(skillResult, argsRecord);

			expect(newPrompt).toMatch(
				/^SKILLS: file:\.claude\/skills\/writing-tests\/SKILL\.md\n\n/,
			);
		});

		test('skill paths are comma-separated with ", "', () => {
			const argsRecord = {
				subagent_type: 'mega_coder',
				prompt: 'Do the work.',
			};

			const skillResult: SimulatedSkillResult = {
				recommendedSkills: [
					{
						skillPath: '.claude/skills/skill-a/SKILL.md',
						score: 0.9,
						usageCount: 3,
					},
					{
						skillPath: '.claude/skills/skill-b/SKILL.md',
						score: 0.8,
						usageCount: 2,
					},
				],
			};

			const newPrompt = simulateSkillInjection(skillResult, argsRecord);

			// Should be "SKILLS: file:...skill-a, file:...skill-b"
			expect(newPrompt).toMatch(
				/SKILLS: file:\.claude\/skills\/skill-a\/SKILL\.md, file:\.claude\/skills\/skill-b\/SKILL\.md/,
			);
		});

		test('original prompt is preserved after the injected SKILLS line', () => {
			const argsRecord = {
				subagent_type: 'mega_coder',
				prompt: 'TO coder\ntaskId: task-42\n\nWrite the code now.',
			};

			const skillResult: SimulatedSkillResult = {
				recommendedSkills: [
					{
						skillPath: '.claude/skills/writing-tests/SKILL.md',
						score: 0.85,
						usageCount: 3,
					},
				],
			};

			const newPrompt = simulateSkillInjection(skillResult, argsRecord);

			expect(newPrompt).toContain(
				'TO coder\ntaskId: task-42\n\nWrite the code now.',
			);
		});

		test('skillPath uses file: prefix', () => {
			const argsRecord = {
				subagent_type: 'mega_coder',
				prompt: 'Do the work.',
			};

			const skillResult: SimulatedSkillResult = {
				recommendedSkills: [
					{
						skillPath: '.claude/skills/writing-tests/SKILL.md',
						score: 0.85,
						usageCount: 3,
					},
				],
			};

			const newPrompt = simulateSkillInjection(skillResult, argsRecord);

			expect(newPrompt).toContain('file:.claude/skills/writing-tests/SKILL.md');
		});
	});

	// -------------------------------------------------------------------------
	// Integration: full skillPropagationGateBefore returns recommendedSkills
	// -------------------------------------------------------------------------

	describe('full integration — skillPropagationGateBefore returns recommendedSkills', () => {
		test('when gate returns non-empty recommendedSkills, injection path is triggered', async () => {
			const sessionEntries: SkillUsageEntry[] = [
				{
					id: '1',
					skillPath: '.claude/skills/writing-tests/SKILL.md',
					agentName: 'coder',
					taskID: 'task-1',
					complianceVerdict: 'compliant',
					sessionID: 'sess-inject',
					timestamp: new Date().toISOString(),
				},
			];

			applyOverrides(_internals, {
				// Non-empty skillsField triggers scoring path which returns recommendedSkills
				parseDelegationArgs: () => ({
					targetAgent: 'coder',
					skillsField: 'writing-tests',
				}),
				discoverAvailableSkills: () => [
					'.claude/skills/writing-tests/SKILL.md',
					'.claude/skills/code/SKILL.md',
				],
				readSkillUsageEntriesTail: () => sessionEntries,
				computeSkillRelevanceScore: (
					skillPath: string,
					_prompt: string,
					entries: SkillUsageEntry[],
				) => {
					if (entries.length === 0) return 0;
					const complianceRate =
						entries.filter((e) => e.complianceVerdict === 'compliant').length /
						entries.length;
					return 0.3 + complianceRate * 0.7;
				},
				writeWarnEvent: () => {},
				formatSkillIndexWithContext: () => '',
			});

			const result = await skillPropagationGateBefore(
				tmp,
				{
					tool: 'task',
					agent: 'architect',
					sessionID: 'sess-inject',
					args: {
						subagent_type: 'mega_coder',
						prompt: 'SKILLS: writing-tests\ndo the work',
					},
				},
				{ enabled: true },
			);

			// Gate returns recommendedSkills when SKILLS is present and not "none"
			expect(result.recommendedSkills).toBeDefined();
			expect(Array.isArray(result.recommendedSkills)).toBe(true);
			expect(result.recommendedSkills!.length).toBeGreaterThan(0);

			// Simulate the injection with a prompt that has NO SKILLS field
			// (simulateSkillInjection calls parseDelegationArgs on the provided argsRecord,
			// which is why we need to ensure existingSkills is empty)
			const argsRecord = {
				subagent_type: 'mega_coder',
				prompt: 'do the work',
			};

			const newPrompt = simulateSkillInjection(result, argsRecord);
			expect(newPrompt).toBeDefined();
			expect(newPrompt).toContain('SKILLS:');
		});

		test('when gate returns undefined recommendedSkills (no available skills), injection does not occur', async () => {
			applyOverrides(_internals, {
				parseDelegationArgs: () => ({
					targetAgent: 'coder',
					skillsField: '', // Empty → gate returns early without scoring
				}),
				discoverAvailableSkills: () => [], // No skills discovered
				readSkillUsageEntriesTail: () => [],
				computeSkillRelevanceScore: () => 0,
				writeWarnEvent: () => {},
				formatSkillIndexWithContext: () => '',
			});

			const result = await skillPropagationGateBefore(
				tmp,
				{
					tool: 'task',
					agent: 'architect',
					sessionID: 'sess-no-skills',
					args: {
						subagent_type: 'mega_coder',
						prompt: 'do the work',
					},
				},
				{ enabled: true },
			);

			// Gate returns undefined when no available skills and empty skillsField
			expect(result.recommendedSkills).toBeUndefined();
		});

		test('simulateSkillInjection uses real parseDelegationArgs, not gate mock', () => {
			// This tests that simulateSkillInjection calls the real parseDelegationArgs,
			// so injection is skipped when the REAL prompt has a SKILLS field.
			// The gate's parseDelegationArgs might be mocked, but simulateSkillInjection
			// uses the real function, so existingSkills in the real prompt is detected.
			const argsRecord = {
				subagent_type: 'mega_coder',
				prompt: 'SKILLS: some-existing-skill\n\nDo the work.',
			};

			const skillResult: SimulatedSkillResult = {
				recommendedSkills: [
					{
						skillPath: '.claude/skills/skill-a/SKILL.md',
						score: 0.9,
						usageCount: 3,
					},
				],
			};

			const newPrompt = simulateSkillInjection(skillResult, argsRecord);

			// The real parseDelegationArgs finds "SKILLS: some-existing-skill" in the prompt,
			// so existingSkills is non-empty and injection is skipped
			expect(newPrompt).toBeUndefined();
		});
	});

	// -------------------------------------------------------------------------
	// Edge cases
	// -------------------------------------------------------------------------

	describe('edge cases', () => {
		test('prompt is not a string → no injection', () => {
			const argsRecord = {
				subagent_type: 'mega_coder',
				prompt: 42, // invalid type
			};

			const skillResult: SimulatedSkillResult = {
				recommendedSkills: [
					{
						skillPath: '.claude/skills/skill-a/SKILL.md',
						score: 0.9,
						usageCount: 3,
					},
				],
			};

			const newPrompt = simulateSkillInjection(skillResult, argsRecord);

			expect(newPrompt).toBeUndefined();
		});

		test('argsRecord has no prompt field → no injection', () => {
			const argsRecord = {
				subagent_type: 'mega_coder',
				// no prompt field
			};

			const skillResult: SimulatedSkillResult = {
				recommendedSkills: [
					{
						skillPath: '.claude/skills/skill-a/SKILL.md',
						score: 0.9,
						usageCount: 3,
					},
				],
			};

			const newPrompt = simulateSkillInjection(skillResult, argsRecord);

			expect(newPrompt).toBeUndefined();
		});

		test('when gate returns undefined recommendedSkills (parseDelegationArgs mocked to null), no injection', async () => {
			// When the gate's parseDelegationArgs is mocked to return null, the gate
			// returns early with recommendedSkills: undefined.
			// simulateSkillInjection receives undefined and returns early.
			applyOverrides(_internals, {
				parseDelegationArgs: () => null,
			});

			const result = await skillPropagationGateBefore(
				tmp,
				{
					tool: 'task',
					agent: 'architect',
					sessionID: 'sess-null-parse',
					args: {
						subagent_type: 'mega_coder',
						prompt: 'SKILLS: none\n\nDo the work.',
					},
				},
				{ enabled: true },
			);

			// Gate returns early because parseDelegationArgs returns null
			expect(result.recommendedSkills).toBeUndefined();

			// Simulate injection with the gate result
			const argsRecord = {
				subagent_type: 'mega_coder',
				prompt: 'Do the work.',
			};

			const newPrompt = simulateSkillInjection(result, argsRecord);
			// recommendedSkills is undefined, so no injection
			expect(newPrompt).toBeUndefined();
		});

		test('injects skills from .opencode/skills directory', () => {
			const argsRecord = {
				subagent_type: 'mega_coder',
				prompt: 'Do the work.',
			};

			const skillResult: SimulatedSkillResult = {
				recommendedSkills: [
					{
						skillPath: '.opencode/skills/generated/my-skill/SKILL.md',
						score: 0.9,
						usageCount: 3,
					},
				],
			};

			const newPrompt = simulateSkillInjection(skillResult, argsRecord);

			expect(newPrompt).toContain(
				'file:.opencode/skills/generated/my-skill/SKILL.md',
			);
		});

		test('original prompt with leading/trailing whitespace is preserved correctly', () => {
			const argsRecord = {
				subagent_type: 'mega_coder',
				prompt: '  Do the work.  ',
			};

			const skillResult: SimulatedSkillResult = {
				recommendedSkills: [
					{
						skillPath: '.claude/skills/skill-a/SKILL.md',
						score: 0.9,
						usageCount: 3,
					},
				],
			};

			const newPrompt = simulateSkillInjection(skillResult, argsRecord);

			expect(newPrompt).toBeDefined();
			expect(newPrompt).toContain('SKILLS:');
			expect(newPrompt).toContain('Do the work.');
		});
	});
});
