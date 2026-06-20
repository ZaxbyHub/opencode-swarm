/**
 * Verification tests for architect MODE protocol skill extraction.
 */

import { describe, expect, it } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const MODE_SKILLS = [
	[
		'BRAINSTORM',
		'brainstorm',
		['Phase 1: CONTEXT SCAN', 'Phase 7: TRANSITION'],
	],
	['SPECIFY', 'specify', ['SPEC CONTENT RULES', 'EXTERNAL PLAN IMPORT PATH']],
	['CLARIFY-SPEC', 'clarify-spec', ['[NEEDS CLARIFICATION]', 'delta format']],
	['RESUME', 'resume', ['.swarm/plan.md exists', 'Swarm field differs']],
	[
		'CLARIFY',
		'clarify',
		['Stage 2: Classify Each Uncertainty', 'Always-Surface Categories'],
	],
	['DISCOVER', 'discover', ['governance', 'Project Governance']],
	['CONSULT', 'consult', ['cached guidance', 'SME calls per project phase']],
	[
		'PRE-PHASE BRIEFING',
		'pre-phase-briefing',
		['Phase 2+', 'CODEBASE REALITY REPORT'],
	],
	['COUNCIL', 'council', ['RESEARCH CONTEXT', 'convene_general_council']],
	[
		'DEEP_DIVE',
		'deep-dive',
		['Step 0 — Parse Header', 'Step 7 — Final Report'],
	],
	['ISSUE_INGEST', 'issue-ingest', ['Phase 1: INTAKE', 'Phase 4: TRANSITION']],
	[
		'PLAN',
		'plan',
		[
			'SPEC GATE',
			'GENERAL COUNCIL ADVISORY OPTION (pre-save_plan)',
			'POST-SAVE_PLAN',
		],
	],
	[
		'CRITIC-GATE',
		'critic-gate',
		[
			'HARD STOP',
			'CRITIC-GATE TRIGGER',
			"Delegate plan to the active swarm's critic agent",
		],
	],
	[
		'EXECUTE',
		'execute',
		['TASK COMPLETION GATE', 'ROLE-BOUNDARY CHANGE VALIDATION'],
	],
	[
		'PHASE-WRAP',
		'phase-wrap',
		['CATASTROPHIC VIOLATION CHECK', 'phase_complete'],
	],
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
		const skillContents = MODE_SKILLS.map(([, slug]) =>
			readFileSync(
				join(process.cwd(), '.opencode/skills', slug, 'SKILL.md'),
				'utf-8',
			),
		);
		const brainstorm = skillContents[0];
		const specify = skillContents[1];

		for (const skillContent of skillContents) {
			expect(skillContent).not.toMatch(/\{\{QA_GATE_DIALOGUE_[A-Z_-]+\}\}/);
		}
		expect(brainstorm).toContain('Present the eleven gates');
		expect(specify).toContain('Present the eleven gates');
	});

	it('does not leave renderer placeholders in runtime-loaded skill files', () => {
		for (const root of ['.opencode/skills', '.claude/skills']) {
			for (const [, slug] of MODE_SKILLS) {
				const skillContent = readFileSync(
					join(process.cwd(), root, slug, 'SKILL.md'),
					'utf-8',
				);

				expect(skillContent).not.toMatch(/\{\{[A-Z0-9_]+\}\}/);
				expect(skillContent).not.toContain('mega_explorer');
				expect(skillContent).not.toContain('mega_sme');
			}
		}
	});

	it('keeps hard constraints on every architect mode stub', () => {
		for (const [modeName] of MODE_SKILLS) {
			const start = architectPrompt.indexOf(`### MODE: ${modeName}`);
			const next = architectPrompt.indexOf('\n### MODE:', start + 1);
			const end =
				next === -1 ? architectPrompt.indexOf('\n## FILES', start) : next;
			const stub = architectPrompt.slice(start, end === -1 ? undefined : end);

			expect(stub).toContain('HARD CONSTRAINTS');
		}
	});
});
