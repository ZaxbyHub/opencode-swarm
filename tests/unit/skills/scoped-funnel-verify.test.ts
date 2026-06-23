/**
 * Verification tests for abbreviated and scoped-funnel protocols.
 *
 * Abbreviated funnel skills (specify, brainstorm, issue-ingest): these embed
 * a shortened funnel summary (all categories, protections, and outcomes but
 * without the full 4-stage protocol prose found in clarify/plan skills).
 *
 * Scoped-funnel skill (clarify-spec): has a unique scoped protocol tailored
 * to spec editing, with its own stage structure and outcome mappings.
 *
 * Validates that all abbreviated funnel summaries contain:
 * 1. All five classification categories
 * 2. Overconfidence guard
 * 3. Always-surface protection with UNNECESSARY/DROP override
 * 4. SoundingBoardVerdict mapping reference
 * 5. Assumptions recording requirement
 *
 * And that the scoped-funnel skill (clarify-spec) validates its own protocol.
 */

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ABBREVIATED_FUNNEL_SKILLS = ['specify', 'brainstorm', 'issue-ingest'];
const SCOPED_FUNNEL_SKILLS = ['clarify-spec'];
const SKILLS_TO_TEST = [...ABBREVIATED_FUNNEL_SKILLS, ...SCOPED_FUNNEL_SKILLS];

describe('Scoped and Abbreviated Funnel Protocol Verification', () => {
	for (const skillSlug of ABBREVIATED_FUNNEL_SKILLS) {
		describe(`${skillSlug} skill`, () => {
			const skillPath = join(
				process.cwd(),
				'.opencode/skills',
				skillSlug,
				'SKILL.md',
			);
			const content = readFileSync(skillPath, 'utf-8');

			it('file exists and is readable', () => {
				expect(content.length).toBeGreaterThan(0);
			});

			it('contains reference to clarification funnel', () => {
				expect(content).toContain('clarification funnel');
			});

			it('contains all five classification categories', () => {
				const categories = [
					'self_resolved',
					'critic_resolved',
					'research_needed',
					'user_decision',
					'deferred_nonblocking',
				];
				for (const category of categories) {
					expect(
						content,
						`${skillSlug} missing classification category: ${category}`,
					).toContain(category);
				}
			});

			it('contains overconfidence guard reference', () => {
				expect(content, `${skillSlug} missing overconfidence guard`).toContain(
					'Overconfidence guard',
				);
			});

			it('contains always-surface protection requirement', () => {
				expect(
					content,
					`${skillSlug} missing always-surface protection`,
				).toContain('always-surface');
			});

			it('contains UNNECESSARY/DROP override language', () => {
				expect(
					content,
					`${skillSlug} missing UNNECESSARY/DROP override`,
				).toMatch(/UNNECESSARY.*DROP|UNNECESSARY[^\n]*DROP/);
			});

			it('contains SoundingBoardVerdict reference', () => {
				expect(content, `${skillSlug} missing SoundingBoardVerdict`).toContain(
					'SoundingBoardVerdict',
				);
			});

			it('contains assumptions recording requirement', () => {
				expect(
					content,
					`${skillSlug} missing assumptions recording requirement`,
				).toMatch(/assumptions|recorded/i);
			});

			it('explicitly mentions the four funnel outcomes (UNNECESSARY/DROP, RESOLVE, REPHRASE, APPROVED/ASK_USER)', () => {
				expect(content, `${skillSlug} missing UNNECESSARY`).toContain(
					'UNNECESSARY',
				);
				expect(content, `${skillSlug} missing DROP`).toContain('DROP');
				expect(content, `${skillSlug} missing RESOLVE`).toContain('RESOLVE');
				expect(content, `${skillSlug} missing REPHRASE`).toContain('REPHRASE');
				expect(content, `${skillSlug} missing APPROVED`).toContain('APPROVED');
				expect(content, `${skillSlug} missing ASK_USER`).toContain('ASK_USER');
			});
		});
	}

	// ===== Dedicated scoped-funnel tests for clarify-spec =====
	describe('clarify-spec scoped protocol', () => {
		const specPath = join(
			process.cwd(),
			'.opencode/skills/clarify-spec/SKILL.md',
		);
		const content = readFileSync(specPath, 'utf-8');

		it('has "Scoped Funnel Protocol (CLARIFY-SPEC only)" heading', () => {
			expect(content).toContain('Scoped Funnel Protocol (CLARIFY-SPEC only)');
		});

		it('contains overconfidence guard reference', () => {
			expect(content).toContain('Overconfidence guard');
		});

		it('contains always-surface protection with DROP override', () => {
			expect(content).toContain('always-surface');
			expect(content).toContain('UNNECESSARY');
			expect(content).toContain('DROP');
		});

		it('documents override direction: UNNECESSARY/DROP → APPROVED/ASK_USER', () => {
			expect(content).toMatch(/UNNECESSARY.*DROP.*APPROVED|APPROVED.*ASK_USER/);
		});

		it('describes scope as lighter than the full funnel', () => {
			expect(content).toMatch(/lighter|scoped|subset|not.*full/i);
		});

		it('mirror parity: .claude version is byte-identical', () => {
			const claudePath = join(
				process.cwd(),
				'.claude/skills/clarify-spec/SKILL.md',
			);
			const claudeContent = readFileSync(claudePath, 'utf-8');
			expect(claudeContent).toBe(content);
		});
	});
});
