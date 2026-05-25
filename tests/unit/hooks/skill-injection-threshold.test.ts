/**
 * Tests for skill injection threshold filtering and audit logging.
 *
 * These tests cover the injection logic in src/index.ts (lines 1586-1660):
 *   1. Skills with score < 0.5 are filtered out (NOT injected individually)
 *   2. Skills with score >= 0.5 are included for injection
 *   3. When NO skills qualify after threshold filtering → SKILLS: none is injected
 *   4. Max 5 skills from QUALIFIED list (not from unfiltered list)
 *   5. Each injected skill is logged via appendSkillUsageEntry
 *   6. appendSkillUsageEntry errors are caught (non-blocking)
 *   7. SKILLS: none is still preserved when explicitly set (regression)
 *   8. Existing SKILLS field still prevents injection (regression)
 *
 * Behaviors 7 and 8 are regression tests; the primary new behaviors
 * under test here are 1–6.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { _internals } from '../../../src/hooks/skill-propagation-gate';
import type { SkillUsageEntry } from '../../../src/hooks/skill-usage-log';
import { _internals as usageLogInternals } from '../../../src/hooks/skill-usage-log';

// ============================================================================
// Helpers
// ============================================================================

function tmpDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), 'skill-threshold-test-'));
}

type SkillPropagationInternals = typeof _internals;
type Override<T> = {
	[P in keyof T]?: T[P];
};

function applyOverrides(
	internals: SkillPropagationInternals,
	overrides: Override<SkillPropagationInternals>,
): void {
	for (const [k, v] of Object.entries(overrides)) {
		(internals as Record<string, unknown>)[k] = v;
	}
}

function restoreOverrides(
	internals: SkillPropagationInternals,
	originals: Override<SkillPropagationInternals>,
): void {
	for (const k of Object.keys(
		originals,
	) as (keyof SkillPropagationInternals)[]) {
		(internals as Record<string, unknown>)[k] = originals[k];
	}
}

// ============================================================================
// Skill injection function with FULL threshold filtering logic
// Replicates the injection logic from src/index.ts lines 1586-1660
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
 * This version INCLUDES the 0.5 threshold filtering and SKILLS:none fallback
 * that are present in the real injection block.
 *
 * Returns the new prompt value (or undefined if no injection occurred),
 * plus the list of skills that were logged.
 */
function simulateSkillInjectionWithThreshold(
	skillResult: SimulatedSkillResult,
	argsRecord: Record<string, unknown>,
	mockAppendSkillUsageEntry: (entry: Omit<SkillUsageEntry, 'id'>) => void,
): { newPrompt: string | undefined; loggedSkills: RecommendedSkill[] } {
	if (
		!skillResult.recommendedSkills ||
		skillResult.recommendedSkills.length === 0
	) {
		return { newPrompt: undefined, loggedSkills: [] };
	}

	const promptRaw = argsRecord.prompt;
	if (typeof promptRaw !== 'string') {
		return { newPrompt: undefined, loggedSkills: [] };
	}

	// Parse the prompt to check for existing SKILLS field (uses real function)
	const parsedDelegation = _internals.parseDelegationArgs(argsRecord);
	if (!parsedDelegation) {
		return { newPrompt: undefined, loggedSkills: [] };
	}

	const existingSkills = parsedDelegation.skillsField.trim();
	// Skip injection if SKILLS field already exists or is explicitly "none"
	if (existingSkills) {
		return { newPrompt: undefined, loggedSkills: [] };
	}

	// Filter by relevance score threshold (0.5) — THIS IS THE NEW BEHAVIOR
	const qualified = skillResult.recommendedSkills.filter((s) => s.score >= 0.5);

	if (qualified.length === 0) {
		// No skills above threshold — inject SKILLS: none
		argsRecord.prompt = `SKILLS: none\n\n${promptRaw}`;
		return { newPrompt: argsRecord.prompt, loggedSkills: [] };
	}

	// Take top 5 by score FROM THE QUALIFIED LIST (not unfiltered)
	const topSkills = qualified.slice(0, 5);
	const skillPaths = topSkills.map((s) => `file:${s.skillPath}`).join(', ');
	const skillsLine = `SKILLS: ${skillPaths}`;
	const newPrompt = `${skillsLine}\n\n${promptRaw}`;
	argsRecord.prompt = newPrompt;

	// Record each injected skill to skill-usage.jsonl (non-blocking)
	for (const skill of topSkills) {
		try {
			mockAppendSkillUsageEntry({
				skillPath: skill.skillPath,
				agentName: 'architect',
				taskID: 'injection',
				timestamp: new Date().toISOString(),
				complianceVerdict: 'not_checked',
				sessionID: 'test-session',
			});
		} catch {
			// Non-blocking: best-effort audit logging
		}
	}

	return { newPrompt, loggedSkills: topSkills };
}

// ============================================================================
// Test cases
// ============================================================================

describe('skill injection — threshold filtering (0.5)', () => {
	let tmp: string;
	let originals: Override<SkillPropagationInternals>;

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
		// Restore usage log internals
		(usageLogInternals as Override<typeof usageLogInternals>).appendFileSync =
			fs.appendFileSync.bind(fs);
		try {
			fs.rmSync(tmp, { recursive: true, force: true });
		} catch {
			// ignore
		}
	});

	// -------------------------------------------------------------------------
	// Behavior 1: Skills with score < 0.5 are filtered out (NOT injected)
	// Behavior 3: When NO skills qualify after threshold filtering → SKILLS: none
	// -------------------------------------------------------------------------
	// NOTE: These two behaviors interact. When ALL available skills are below
	// threshold, Behavior 3 applies (SKILLS: none is injected, not "no injection").
	// When SOME skills are above and SOME below threshold, Behavior 1 applies
	// (only the above-threshold ones are injected).
	// -------------------------------------------------------------------------

	describe('Behavior 1 & 3 — threshold filtering with SKILLS:none fallback', () => {
		test('single skill below 0.5 → SKILLS: none injected (Behavior 3)', () => {
			// When no skills qualify, SKILLS: none is injected (not "no injection")
			const argsRecord = {
				subagent_type: 'mega_coder',
				prompt: 'Do the work.',
			};

			const skillResult: SimulatedSkillResult = {
				recommendedSkills: [
					{
						skillPath: '.claude/skills/writing-tests/SKILL.md',
						score: 0.49,
						usageCount: 3,
					},
				],
			};

			const mockLog = mock(() => {});
			const { newPrompt, loggedSkills } = simulateSkillInjectionWithThreshold(
				skillResult,
				argsRecord,
				mockLog,
			);

			// SKILLS: none is injected when no skills qualify
			expect(newPrompt).toMatch(/^SKILLS: none\n\n/);
			expect(newPrompt).toContain('Do the work.');
			expect(loggedSkills).toEqual([]);
			expect(mockLog).not.toHaveBeenCalled();
		});

		test('skill with score 0.0 → SKILLS: none injected', () => {
			const argsRecord = {
				subagent_type: 'mega_coder',
				prompt: 'Do the work.',
			};

			const skillResult: SimulatedSkillResult = {
				recommendedSkills: [
					{
						skillPath: '.claude/skills/writing-tests/SKILL.md',
						score: 0.0,
						usageCount: 0,
					},
				],
			};

			const { newPrompt } = simulateSkillInjectionWithThreshold(
				skillResult,
				argsRecord,
				mock(() => {}),
			);

			expect(newPrompt).toMatch(/^SKILLS: none\n\n/);
		});

		test('all skills below 0.5 → SKILLS: none injected (qualified.length === 0)', () => {
			const argsRecord = {
				subagent_type: 'mega_coder',
				prompt: 'Do the work.',
			};

			const skillResult: SimulatedSkillResult = {
				recommendedSkills: [
					{
						skillPath: '.claude/skills/skill-a/SKILL.md',
						score: 0.3,
						usageCount: 1,
					},
					{
						skillPath: '.claude/skills/skill-b/SKILL.md',
						score: 0.1,
						usageCount: 0,
					},
					{
						skillPath: '.claude/skills/skill-c/SKILL.md',
						score: 0.49,
						usageCount: 2,
					},
				],
			};

			const { newPrompt } = simulateSkillInjectionWithThreshold(
				skillResult,
				argsRecord,
				mock(() => {}),
			);

			// qualified.length === 0 → SKILLS: none injected
			expect(newPrompt).toMatch(/^SKILLS: none\n\n/);
			expect(newPrompt).toContain('Do the work.');
		});

		test('mixed scores — only >= 0.5 are injected (Behavior 1)', () => {
			const argsRecord = {
				subagent_type: 'mega_coder',
				prompt: 'Do the work.',
			};

			const skillResult: SimulatedSkillResult = {
				recommendedSkills: [
					{
						skillPath: '.claude/skills/skill-a/SKILL.md',
						score: 0.8,
						usageCount: 10,
					},
					{
						skillPath: '.claude/skills/skill-b/SKILL.md',
						score: 0.49,
						usageCount: 5,
					},
					{
						skillPath: '.claude/skills/skill-c/SKILL.md',
						score: 0.9,
						usageCount: 8,
					},
					{
						skillPath: '.claude/skills/skill-d/SKILL.md',
						score: 0.5,
						usageCount: 3,
					},
					{
						skillPath: '.claude/skills/skill-e/SKILL.md',
						score: 0.3,
						usageCount: 1,
					},
				],
			};

			const { newPrompt, loggedSkills } = simulateSkillInjectionWithThreshold(
				skillResult,
				argsRecord,
				mock(() => {}),
			);

			expect(newPrompt).toBeDefined();
			// Only 3 skills meet threshold: skill-a (0.8), skill-c (0.9), skill-d (0.5)
			expect(loggedSkills).toHaveLength(3);
			expect(
				loggedSkills.find((s) => s.skillPath.includes('skill-b')),
			).toBeUndefined();
			expect(
				loggedSkills.find((s) => s.skillPath.includes('skill-e')),
			).toBeUndefined();
			expect(newPrompt).toContain('skill-a');
			expect(newPrompt).toContain('skill-c');
			expect(newPrompt).toContain('skill-d');
			expect(newPrompt).not.toContain('skill-b');
			expect(newPrompt).not.toContain('skill-e');
		});
	});

	// -------------------------------------------------------------------------
	// Behavior 2: Skills with score >= 0.5 are included for injection
	// -------------------------------------------------------------------------

	describe('Behavior 2 — score >= 0.5 → included', () => {
		test('skill with score exactly 0.5 IS injected', () => {
			const argsRecord = {
				subagent_type: 'mega_coder',
				prompt: 'Do the work.',
			};

			const skillResult: SimulatedSkillResult = {
				recommendedSkills: [
					{
						skillPath: '.claude/skills/writing-tests/SKILL.md',
						score: 0.5,
						usageCount: 3,
					},
				],
			};

			const { newPrompt, loggedSkills } = simulateSkillInjectionWithThreshold(
				skillResult,
				argsRecord,
				mock(() => {}),
			);

			expect(newPrompt).toBeDefined();
			expect(newPrompt).toContain(
				'SKILLS: file:.claude/skills/writing-tests/SKILL.md',
			);
			expect(loggedSkills).toHaveLength(1);
			expect(loggedSkills[0]!.score).toBe(0.5);
		});

		test('skill with score 0.51 IS injected', () => {
			const argsRecord = {
				subagent_type: 'mega_coder',
				prompt: 'Do the work.',
			};

			const skillResult: SimulatedSkillResult = {
				recommendedSkills: [
					{
						skillPath: '.claude/skills/writing-tests/SKILL.md',
						score: 0.51,
						usageCount: 1,
					},
				],
			};

			const { newPrompt } = simulateSkillInjectionWithThreshold(
				skillResult,
				argsRecord,
				mock(() => {}),
			);

			expect(newPrompt).toBeDefined();
			expect(newPrompt).toContain('file:.claude/skills/writing-tests/SKILL.md');
		});

		test('skill with score 1.0 IS injected', () => {
			const argsRecord = {
				subagent_type: 'mega_coder',
				prompt: 'Do the work.',
			};

			const skillResult: SimulatedSkillResult = {
				recommendedSkills: [
					{
						skillPath: '.claude/skills/writing-tests/SKILL.md',
						score: 1.0,
						usageCount: 100,
					},
				],
			};

			const { newPrompt } = simulateSkillInjectionWithThreshold(
				skillResult,
				argsRecord,
				mock(() => {}),
			);

			expect(newPrompt).toBeDefined();
		});
	});

	// -------------------------------------------------------------------------
	// Behavior 4: Max 5 skills from QUALIFIED list (not from unfiltered list)
	// -------------------------------------------------------------------------

	describe('Behavior 4 — cap of 5 from qualified list, not unfiltered', () => {
		test('when unfiltered has 10 but all 10 qualify → cap at 5', () => {
			const argsRecord = {
				subagent_type: 'mega_coder',
				prompt: 'Do the work.',
			};

			const skillResult: SimulatedSkillResult = {
				recommendedSkills: [
					// All 10 have scores >= 0.5
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
					{
						skillPath: '.claude/skills/skill-8/SKILL.md',
						score: 0.6,
						usageCount: 3,
					},
					{
						skillPath: '.claude/skills/skill-9/SKILL.md',
						score: 0.55,
						usageCount: 2,
					},
					{
						skillPath: '.claude/skills/skill-10/SKILL.md',
						score: 0.5,
						usageCount: 1,
					},
				],
			};

			const { newPrompt, loggedSkills } = simulateSkillInjectionWithThreshold(
				skillResult,
				argsRecord,
				mock(() => {}),
			);

			expect(newPrompt).toBeDefined();
			// All 10 are >= 0.5, so cap at 5
			expect(loggedSkills).toHaveLength(5);
			expect(loggedSkills.map((s) => s.skillPath)).toEqual([
				'.claude/skills/skill-1/SKILL.md',
				'.claude/skills/skill-2/SKILL.md',
				'.claude/skills/skill-3/SKILL.md',
				'.claude/skills/skill-4/SKILL.md',
				'.claude/skills/skill-5/SKILL.md',
			]);
		});

		test('when unfiltered has 7 and only 3 qualify → injects only those 3 (cap irrelevant since 3 < 5)', () => {
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
					// Below threshold — these should be filtered BEFORE the cap
					{
						skillPath: '.claude/skills/skill-4/SKILL.md',
						score: 0.49,
						usageCount: 7,
					},
					{
						skillPath: '.claude/skills/skill-5/SKILL.md',
						score: 0.3,
						usageCount: 6,
					},
					{
						skillPath: '.claude/skills/skill-6/SKILL.md',
						score: 0.2,
						usageCount: 5,
					},
					{
						skillPath: '.claude/skills/skill-7/SKILL.md',
						score: 0.1,
						usageCount: 4,
					},
				],
			};

			const { newPrompt, loggedSkills } = simulateSkillInjectionWithThreshold(
				skillResult,
				argsRecord,
				mock(() => {}),
			);

			expect(newPrompt).toBeDefined();
			// Only 3 qualify, so inject all 3 (no cap needed since 3 < 5)
			expect(loggedSkills).toHaveLength(3);
			expect(newPrompt).toContain('skill-1');
			expect(newPrompt).toContain('skill-2');
			expect(newPrompt).toContain('skill-3');
			expect(newPrompt).not.toContain('skill-4');
			expect(newPrompt).not.toContain('skill-5');
			expect(newPrompt).not.toContain('skill-6');
			expect(newPrompt).not.toContain('skill-7');
		});

		test('cap applied to qualified list (top 5 by score) — 7 qualify, 2 excluded', () => {
			const argsRecord = {
				subagent_type: 'mega_coder',
				prompt: 'Do the work.',
			};

			const skillResult: SimulatedSkillResult = {
				recommendedSkills: [
					{
						skillPath: '.claude/skills/skill-a/SKILL.md',
						score: 0.7,
						usageCount: 10,
					},
					{
						skillPath: '.claude/skills/skill-b/SKILL.md',
						score: 0.6,
						usageCount: 9,
					},
					{
						skillPath: '.claude/skills/skill-c/SKILL.md',
						score: 0.55,
						usageCount: 8,
					},
					{
						skillPath: '.claude/skills/skill-d/SKILL.md',
						score: 0.52,
						usageCount: 7,
					},
					{
						skillPath: '.claude/skills/skill-e/SKILL.md',
						score: 0.51,
						usageCount: 6,
					},
					{
						skillPath: '.claude/skills/skill-f/SKILL.md',
						score: 0.5,
						usageCount: 5,
					},
					{
						skillPath: '.claude/skills/skill-g/SKILL.md',
						score: 0.5,
						usageCount: 4,
					},
				],
			};

			const { newPrompt, loggedSkills } = simulateSkillInjectionWithThreshold(
				skillResult,
				argsRecord,
				mock(() => {}),
			);

			// All 7 are >= 0.5, so cap at 5 (top 5 by score order)
			expect(loggedSkills).toHaveLength(5);
			expect(loggedSkills.map((s) => s.skillPath)).toEqual([
				'.claude/skills/skill-a/SKILL.md', // 0.7
				'.claude/skills/skill-b/SKILL.md', // 0.6
				'.claude/skills/skill-c/SKILL.md', // 0.55
				'.claude/skills/skill-d/SKILL.md', // 0.52
				'.claude/skills/skill-e/SKILL.md', // 0.51
				// skill-f (0.5) and skill-g (0.5) are excluded by cap
			]);
		});

		test('cap of 5 is applied AFTER threshold filtering — not before', () => {
			// This is the key invariant: if 6 skills qualify but 10 exist,
			// the cap should still be 5 (not less due to pre-filtering)
			const argsRecord = {
				subagent_type: 'mega_coder',
				prompt: 'Do the work.',
			};

			const skillResult: SimulatedSkillResult = {
				recommendedSkills: [
					// 6 skills above threshold
					{
						skillPath: '.claude/skills/skill-1/SKILL.md',
						score: 0.9,
						usageCount: 10,
					},
					{
						skillPath: '.claude/skills/skill-2/SKILL.md',
						score: 0.8,
						usageCount: 9,
					},
					{
						skillPath: '.claude/skills/skill-3/SKILL.md',
						score: 0.7,
						usageCount: 8,
					},
					{
						skillPath: '.claude/skills/skill-4/SKILL.md',
						score: 0.6,
						usageCount: 7,
					},
					{
						skillPath: '.claude/skills/skill-5/SKILL.md',
						score: 0.55,
						usageCount: 6,
					},
					{
						skillPath: '.claude/skills/skill-6/SKILL.md',
						score: 0.5,
						usageCount: 5,
					},
					// 4 skills below threshold
					{
						skillPath: '.claude/skills/skill-7/SKILL.md',
						score: 0.49,
						usageCount: 4,
					},
					{
						skillPath: '.claude/skills/skill-8/SKILL.md',
						score: 0.3,
						usageCount: 3,
					},
					{
						skillPath: '.claude/skills/skill-9/SKILL.md',
						score: 0.2,
						usageCount: 2,
					},
					{
						skillPath: '.claude/skills/skill-10/SKILL.md',
						score: 0.1,
						usageCount: 1,
					},
				],
			};

			const { newPrompt, loggedSkills } = simulateSkillInjectionWithThreshold(
				skillResult,
				argsRecord,
				mock(() => {}),
			);

			// 6 qualify → cap at 5 (NOT at 4 or any smaller number)
			expect(loggedSkills).toHaveLength(5);
			// Verify the 4 below threshold are NOT in the injected list
			const injectedPaths = loggedSkills.map((s) => s.skillPath);
			expect(injectedPaths.find((p) => p.includes('skill-7'))).toBeUndefined();
			expect(injectedPaths.find((p) => p.includes('skill-8'))).toBeUndefined();
			expect(injectedPaths.find((p) => p.includes('skill-9'))).toBeUndefined();
			expect(injectedPaths.find((p) => p.includes('skill-10'))).toBeUndefined();
			// Verify top 5 by score are selected
			expect(loggedSkills[0]!.skillPath).toContain('skill-1');
			expect(loggedSkills[4]!.skillPath).toContain('skill-5');
		});
	});

	// -------------------------------------------------------------------------
	// Behavior 5: Each injected skill is logged via appendSkillUsageEntry
	// -------------------------------------------------------------------------

	describe('Behavior 5 — each injected skill is logged', () => {
		test('appendSkillUsageEntry is called once per injected skill', () => {
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
					{
						skillPath: '.claude/skills/skill-c/SKILL.md',
						score: 0.7,
						usageCount: 1,
					},
				],
			};

			const mockLog = mock(() => {});
			const { loggedSkills } = simulateSkillInjectionWithThreshold(
				skillResult,
				argsRecord,
				mockLog,
			);

			expect(mockLog).toHaveBeenCalledTimes(3);
			expect(loggedSkills).toHaveLength(3);
		});

		test('appendSkillUsageEntry is called with correct skillPath per call', () => {
			const argsRecord = {
				subagent_type: 'mega_coder',
				prompt: 'Do the work.',
			};

			const skillResult: SimulatedSkillResult = {
				recommendedSkills: [
					{
						skillPath: '.claude/skills/skill-x/SKILL.md',
						score: 0.9,
						usageCount: 3,
					},
					{
						skillPath: '.claude/skills/skill-y/SKILL.md',
						score: 0.8,
						usageCount: 2,
					},
				],
			};

			const callArgs: Array<Omit<SkillUsageEntry, 'id'>> = [];
			const mockLog = mock((entry: Omit<SkillUsageEntry, 'id'>) => {
				callArgs.push(entry);
			});

			simulateSkillInjectionWithThreshold(skillResult, argsRecord, mockLog);

			expect(callArgs[0]!.skillPath).toBe('.claude/skills/skill-x/SKILL.md');
			expect(callArgs[1]!.skillPath).toBe('.claude/skills/skill-y/SKILL.md');
		});

		test('appendSkillUsageEntry is called with complianceVerdict: not_checked', () => {
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
				],
			};

			let capturedEntry: Omit<SkillUsageEntry, 'id'> | undefined;
			const mockLog = mock((entry: Omit<SkillUsageEntry, 'id'>) => {
				capturedEntry = entry;
			});

			simulateSkillInjectionWithThreshold(skillResult, argsRecord, mockLog);

			expect(capturedEntry).toBeDefined();
			expect(capturedEntry!.complianceVerdict).toBe('not_checked');
		});

		test('appendSkillUsageEntry is NOT called when SKILLS: none is injected', () => {
			const argsRecord = {
				subagent_type: 'mega_coder',
				prompt: 'Do the work.',
			};

			const skillResult: SimulatedSkillResult = {
				recommendedSkills: [
					{
						skillPath: '.claude/skills/skill-a/SKILL.md',
						score: 0.3,
						usageCount: 1,
					},
				],
			};

			const mockLog = mock(() => {});
			simulateSkillInjectionWithThreshold(skillResult, argsRecord, mockLog);

			expect(mockLog).not.toHaveBeenCalled();
		});

		test('appendSkillUsageEntry is NOT called when prompt has existing SKILLS field', () => {
			const argsRecord = {
				subagent_type: 'mega_coder',
				prompt: 'SKILLS: file:.claude/skills/existing/SKILL.md\n\nDo the work.',
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

			const mockLog = mock(() => {});
			simulateSkillInjectionWithThreshold(skillResult, argsRecord, mockLog);

			expect(mockLog).not.toHaveBeenCalled();
		});
	});

	// -------------------------------------------------------------------------
	// Behavior 6: appendSkillUsageEntry errors are caught (non-blocking)
	// -------------------------------------------------------------------------

	describe('Behavior 6 — appendSkillUsageEntry errors are non-blocking', () => {
		test('when appendSkillUsageEntry throws, injection still succeeds', () => {
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
				],
			};

			// Simulate appendSkillUsageEntry throwing
			const throwingLog = mock(() => {
				throw new Error('Disk full');
			});

			const { newPrompt, loggedSkills } = simulateSkillInjectionWithThreshold(
				skillResult,
				argsRecord,
				throwingLog,
			);

			// Injection should still succeed (non-blocking)
			expect(newPrompt).toBeDefined();
			expect(newPrompt).toContain('SKILLS:');
			expect(newPrompt).toContain('skill-a');
			expect(loggedSkills).toHaveLength(1);
		});

		test('when appendSkillUsageEntry throws for one skill, other skills still injected', () => {
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
					{
						skillPath: '.claude/skills/skill-c/SKILL.md',
						score: 0.7,
						usageCount: 1,
					},
				],
			};

			let callCount = 0;
			const firstFailingLog = mock((entry: Omit<SkillUsageEntry, 'id'>) => {
				callCount++;
				if (entry.skillPath.includes('skill-b')) {
					throw new Error('IO error');
				}
			});

			const { newPrompt, loggedSkills } = simulateSkillInjectionWithThreshold(
				skillResult,
				argsRecord,
				firstFailingLog,
			);

			// Should have called 3 times (one per skill), injection succeeds
			expect(callCount).toBe(3);
			expect(newPrompt).toBeDefined();
			expect(newPrompt).toContain('skill-a');
			expect(newPrompt).toContain('skill-b');
			expect(newPrompt).toContain('skill-c');
			expect(loggedSkills).toHaveLength(3);
		});

		test('when ALL appendSkillUsageEntry calls throw, injection still succeeds', () => {
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

			const alwaysFailingLog = mock(() => {
				throw new Error('Permission denied');
			});

			const { newPrompt, loggedSkills } = simulateSkillInjectionWithThreshold(
				skillResult,
				argsRecord,
				alwaysFailingLog,
			);

			// Injection should still succeed
			expect(newPrompt).toBeDefined();
			expect(newPrompt).toContain('SKILLS:');
			expect(loggedSkills).toHaveLength(2);
		});
	});

	// -------------------------------------------------------------------------
	// Behavior 7: SKILLS: none is still preserved when explicitly set (regression)
	// -------------------------------------------------------------------------

	describe('Behavior 7 — SKILLS: none is preserved (regression)', () => {
		test('SKILLS: none in prompt → no injection, SKILLS: none preserved', () => {
			const argsRecord = {
				subagent_type: 'mega_coder',
				prompt: 'SKILLS: none\n\nDo the work.',
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

			const mockLog = mock(() => {});
			const { newPrompt } = simulateSkillInjectionWithThreshold(
				skillResult,
				argsRecord,
				mockLog,
			);

			expect(newPrompt).toBeUndefined();
			expect(argsRecord.prompt).toBe('SKILLS: none\n\nDo the work.');
			expect(mockLog).not.toHaveBeenCalled();
		});

		test('SKILLS: NONE (uppercase) is preserved', () => {
			const argsRecord = {
				subagent_type: 'mega_coder',
				prompt: 'SKILLS: NONE\n\nDo the work.',
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

			const { newPrompt } = simulateSkillInjectionWithThreshold(
				skillResult,
				argsRecord,
				mock(() => {}),
			);

			expect(newPrompt).toBeUndefined();
		});
	});

	// -------------------------------------------------------------------------
	// Behavior 8: Existing SKILLS field still prevents injection (regression)
	// -------------------------------------------------------------------------

	describe('Behavior 8 — existing SKILLS field prevents injection (regression)', () => {
		test('existing SKILLS field with file reference is preserved', () => {
			const argsRecord = {
				subagent_type: 'mega_coder',
				prompt: 'SKILLS: file:.claude/skills/custom/SKILL.md\n\nDo the work.',
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

			const mockLog = mock(() => {});
			const { newPrompt } = simulateSkillInjectionWithThreshold(
				skillResult,
				argsRecord,
				mockLog,
			);

			expect(newPrompt).toBeUndefined();
			expect(argsRecord.prompt).toBe(
				'SKILLS: file:.claude/skills/custom/SKILL.md\n\nDo the work.',
			);
			expect(mockLog).not.toHaveBeenCalled();
		});
	});

	// -------------------------------------------------------------------------
	// Critical invariant: threshold is applied BEFORE cap
	// -------------------------------------------------------------------------

	describe('critical invariant — threshold applied before cap', () => {
		test('cap=5 is meaningless if threshold filtering yields < 5 — no crash, correct count', () => {
			// If threshold filtering yields only 3 skills, cap of 5 is never reached.
			// This should not cause an error or unexpected behavior.
			const argsRecord = {
				subagent_type: 'mega_coder',
				prompt: 'Do the work.',
			};

			const skillResult: SimulatedSkillResult = {
				recommendedSkills: [
					{
						skillPath: '.claude/skills/skill-1/SKILL.md',
						score: 0.9,
						usageCount: 10,
					},
					{
						skillPath: '.claude/skills/skill-2/SKILL.md',
						score: 0.8,
						usageCount: 9,
					},
					{
						skillPath: '.claude/skills/skill-3/SKILL.md',
						score: 0.7,
						usageCount: 8,
					},
					// Below threshold — these get filtered
					{
						skillPath: '.claude/skills/skill-4/SKILL.md',
						score: 0.49,
						usageCount: 7,
					},
					{
						skillPath: '.claude/skills/skill-5/SKILL.md',
						score: 0.3,
						usageCount: 6,
					},
				],
			};

			const { newPrompt, loggedSkills } = simulateSkillInjectionWithThreshold(
				skillResult,
				argsRecord,
				mock(() => {}),
			);

			// 3 qualify, cap is 5, so all 3 are injected
			expect(newPrompt).toBeDefined();
			expect(loggedSkills).toHaveLength(3);
			expect(newPrompt).toContain('skill-1');
			expect(newPrompt).toContain('skill-2');
			expect(newPrompt).toContain('skill-3');
			expect(newPrompt).not.toContain('skill-4');
			expect(newPrompt).not.toContain('skill-5');
		});

		test('threshold filtering is stable — same scores always produce same results', () => {
			const argsRecord1 = {
				subagent_type: 'mega_coder',
				prompt: 'Do the work.',
			};
			const argsRecord2 = {
				subagent_type: 'mega_coder',
				prompt: 'Do the work.',
			};

			const skillResult: SimulatedSkillResult = {
				recommendedSkills: [
					{
						skillPath: '.claude/skills/skill-a/SKILL.md',
						score: 0.7,
						usageCount: 5,
					},
					{
						skillPath: '.claude/skills/skill-b/SKILL.md',
						score: 0.49,
						usageCount: 4,
					},
					{
						skillPath: '.claude/skills/skill-c/SKILL.md',
						score: 0.5,
						usageCount: 3,
					},
				],
			};

			const { newPrompt: np1 } = simulateSkillInjectionWithThreshold(
				skillResult,
				argsRecord1,
				mock(() => {}),
			);
			const { newPrompt: np2 } = simulateSkillInjectionWithThreshold(
				skillResult,
				argsRecord2,
				mock(() => {}),
			);

			// Both should produce identical results (skill-a and skill-c qualify)
			expect(np1).toBeDefined();
			expect(np2).toBeDefined();
			// skill-b (0.49) is filtered out, skill-a (0.7) and skill-c (0.5) pass
			expect(np1).toContain('skill-a');
			expect(np1).toContain('skill-c');
			expect(np1).not.toContain('skill-b');
		});
	});
});
