/**
 * Verification tests for .opencode/skills/plan/SKILL.md protocol content.
 */

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildQaGateSelectionDialogue } from '../../../src/agents/architect';

const SKILL_PATH = join(process.cwd(), '.opencode/skills/plan/SKILL.md');
const skillContent = readFileSync(SKILL_PATH, 'utf-8');
const CLAUDE_SKILL_PATH = join(process.cwd(), '.claude/skills/plan/SKILL.md');
const claudeSkillContent = readFileSync(CLAUDE_SKILL_PATH, 'utf-8');

const earlyModeSkills = {
	'specify (.opencode)': '.opencode/skills/specify/SKILL.md',
	'specify (.claude)': '.claude/skills/specify/SKILL.md',
	'brainstorm (.opencode)': '.opencode/skills/brainstorm/SKILL.md',
	'brainstorm (.claude)': '.claude/skills/brainstorm/SKILL.md',
} as const;

describe('.opencode/skills/plan/SKILL.md protocol content', () => {
	describe('frontmatter', () => {
		it('declares the plan skill', () => {
			expect(skillContent).toContain('name: plan');
			expect(skillContent).toContain('description:');
		});
	});

	describe('planning protocol', () => {
		it('keeps spec gate and external plan ingestion rules', () => {
			expect(skillContent).toContain('SPEC GATE');
			expect(skillContent).toContain('PLAN INGESTION DETECTION');
			expect(skillContent).toContain('EXTERNAL PLAN IMPORT PATH');
		});

		it('requires offering General Council advisory input before save_plan when enabled', () => {
			const generalCouncilIdx = skillContent.indexOf(
				'GENERAL COUNCIL ADVISORY OPTION (pre-save_plan)',
			);
			const savePlanIdx = skillContent.indexOf('Use the `save_plan` tool');

			expect(generalCouncilIdx).toBeGreaterThan(0);
			expect(savePlanIdx).toBeGreaterThan(generalCouncilIdx);
			expect(skillContent).toContain('council.general.enabled');
			expect(skillContent).toContain('convene_general_council');
			expect(skillContent).toMatch(/before drafting or saving the plan/i);
			expect(skillContent).toContain('before any critic pre-plan review');
		});

		it('keeps save_plan requirements and example', () => {
			expect(skillContent).toContain('Use the `save_plan` tool');
			expect(skillContent).toContain('Required parameters:');
			expect(skillContent).toContain('save_plan({ title: "My Real Project"');
		});

		it('keeps post-save QA gate persistence and inline gate warning', () => {
			expect(skillContent).toContain('POST-SAVE_PLAN: APPLY QA GATE SELECTION');
			expect(skillContent).toContain('Pending QA Gate Selection');
			expect(skillContent).not.toContain('{{QA_GATE_DIALOGUE_PLAN}}');
			expect(skillContent).toContain('Present the eleven gates');
			expect(skillContent).toContain('final_council (default: OFF)');
			expect(skillContent).toMatch(/how many coders should run in parallel/i);
			expect(skillContent).toMatch(/commit frequency/i);
			expect(skillContent).toContain('INLINE GATE SELECTION');
		});

		it('keeps planning quality controls', () => {
			expect(skillContent).toContain('TASK GRANULARITY RULES');
			expect(skillContent).toContain('TEST TASK DEDUPLICATION');
			expect(skillContent).toContain('PHASE COUNT GUIDANCE');
			expect(skillContent).toContain('TRACEABILITY CHECK');
		});

		it('teaches worktree isolation in the parallel-coders sub-item', () => {
			expect(skillContent).toContain('isolated git worktree');
			expect(skillContent).toMatch(/file[- ]disjoint|do NOT overlap/i);
		});
	});

	// Lockstep guard: the parallel-coders/worktree guidance is duplicated across the
	// two skill copies and the architect dialogue. They must not silently drift.
	describe('worktree/parallelization lockstep', () => {
		it('.claude and .opencode plan skill copies stay byte-identical', () => {
			expect(claudeSkillContent).toBe(skillContent);
		});

		it('architect dialogue and plan skill share the parallel + worktree concepts', () => {
			const dialogue = buildQaGateSelectionDialogue('PLAN');
			for (const needle of [
				'how many coders should run in parallel',
				'isolated git worktree',
			]) {
				expect(dialogue.toLowerCase()).toContain(needle.toLowerCase());
				expect(skillContent.toLowerCase()).toContain(needle.toLowerCase());
			}
		});

		// The specify/brainstorm skills also embed the parallel-coders question.
		// They must teach the worktree concept (so the guidance does not drift away
		// from the plan skill), but — because no plan exists yet at the SPECIFY /
		// BRAINSTORM gate-selection step — they must defer the concrete count
		// recommendation to plan time rather than telling the architect to inspect
		// a plan that does not exist (F-006). A byte-identity check is intentionally
		// avoided here because the brainstorm copies carry a pre-existing
		// auto_proceed asymmetry unrelated to parallelization (F-005).
		for (const [label, relPath] of Object.entries(earlyModeSkills)) {
			it(`${label} teaches worktrees and defers the recommendation to plan time`, () => {
				const content = readFileSync(join(process.cwd(), relPath), 'utf-8');
				expect(content).toContain('isolated git worktree');
				expect(content).toMatch(/do NOT overlap/i);
				expect(content).toContain('not known until the plan is finalized');
				expect(content).not.toContain('Inspect the plan and recommend a count');
			});
		}
	});
});
