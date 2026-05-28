/**
 * Verification tests for architect MODE protocol skill extraction.
 */

import { describe, expect, it } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const MODE_SKILLS = [
	['BRAINSTORM', 'brainstorm', ['Phase 1: CONTEXT SCAN', 'Phase 7: TRANSITION']],
	['SPECIFY', 'specify', ['SPEC CONTENT RULES', 'EXTERNAL PLAN IMPORT PATH']],
	['CLARIFY-SPEC', 'clarify-spec', ['[NEEDS CLARIFICATION]', 'delta format']],
	['RESUME', 'resume', ['.swarm/plan.md exists', 'Swarm field differs']],
	['CLARIFY', 'clarify', ['Ask up to 3 questions', 'Clear request']],
	['DISCOVER', 'discover', ['governance', 'Project Governance']],
	['CONSULT', 'consult', ['cached guidance', 'SME calls per project phase']],
	['PRE-PHASE BRIEFING', 'pre-phase-briefing', ['Phase 2+', 'CODEBASE REALITY REPORT']],
	['COUNCIL', 'council', ['RESEARCH CONTEXT', 'convene_general_council']],
	['DEEP_DIVE', 'deep-dive', ['Step 0 — Parse Header', 'Step 7 — Final Report']],
	['ISSUE_INGEST', 'issue-ingest', ['Phase 1: INTAKE', 'Phase 4: TRANSITION']],
	['PLAN', 'plan', ['SPEC GATE', 'POST-SAVE_PLAN']],
	['CRITIC-GATE', 'critic-gate', ['HARD STOP', 'CRITIC-GATE TRIGGER']],
	['EXECUTE', 'execute', ['TASK COMPLETION GATE', 'ROLE-BOUNDARY CHANGE VALIDATION']],
	['PHASE-WRAP', 'phase-wrap', ['CATASTROPHIC VIOLATION CHECK', 'phase_complete']],
] as const;

const architectPrompt = readFileSync(
	join(process.cwd(), 'src/agents/architect.ts'),
	'utf-8',
);

describe('architect MODE protocol skills', () => {
	for (const [modeName, slug, expectedContent] of MODE_SKILLS) {
		describe(`${modeName} skill`, () => {
			const opencodePath = join(
				process.cwd(),
				'.opencode/skills',
				slug,
				'SKILL.md',
			);
			const claudePath = join(
				process.cwd(),
				'.claude/skills',
				slug,
				'SKILL.md',
			);

			it('exists in both OpenCode and Claude skill trees', () => {
				expect(existsSync(opencodePath)).toBe(true);
				expect(existsSync(claudePath)).toBe(true);
			});

			it('keeps the protocol out of the architect prompt behind a skill stub', () => {
				const skillRef = `file:.opencode/skills/${slug}/SKILL.md`;
				expect(architectPrompt).toContain(skillRef);
				expect(architectPrompt).toContain(`### MODE: ${modeName}`);
			});

			it('preserves representative protocol content in the skill file', () => {
				const skillContent = readFileSync(opencodePath, 'utf-8');
				expect(skillContent).toContain(`name: ${slug}`);
				expect(skillContent).toContain(`### MODE: ${modeName}`);
				for (const expected of expectedContent) {
					expect(skillContent).toContain(expected);
				}
			});
		});
	}

	it('expands static QA gate dialogue in extracted dialogue-mode skills', () => {
		const brainstorm = readFileSync(
			join(process.cwd(), '.opencode/skills/brainstorm/SKILL.md'),
			'utf-8',
		);
		const specify = readFileSync(
			join(process.cwd(), '.opencode/skills/specify/SKILL.md'),
			'utf-8',
		);

		expect(brainstorm).not.toContain('{{QA_GATE_DIALOGUE_BRAINSTORM}}');
		expect(specify).not.toContain('{{QA_GATE_DIALOGUE_SPECIFY}}');
		expect(brainstorm).toContain('Present the eleven gates');
		expect(specify).toContain('Present the eleven gates');
	});
});
