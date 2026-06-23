/**
 * Tests for mechanical enforcement of DROP protection on always-surface items.
 *
 * Verifies that the clarification funnel prevents dropping of always-surface categories
 * even when the critic attempts to apply UNNECESSARY/DROP verdicts to them.
 *
 * This test documents the required enforcement behavior for future implementation.
 */

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('DROP Protection Mechanical Enforcement Documentation', () => {
	describe('Skill documentation requirements', () => {
		const clarifyPath = join(
			process.cwd(),
			'.opencode/skills/clarify/SKILL.md',
		);
		const planPath = join(process.cwd(), '.opencode/skills/plan/SKILL.md');
		const clarifyContent = readFileSync(clarifyPath, 'utf-8');
		const planContent = readFileSync(planPath, 'utf-8');

		it('clarify skill documents hard constraint against DROP on always-surface items', () => {
			expect(clarifyContent).toContain(
				'Items in the Always-Surface Categories list (below) MUST NOT receive `UNNECESSARY`/`DROP`',
			);
		});

		it('plan skill documents hard constraint against DROP on always-surface items', () => {
			expect(planContent).toContain(
				'Items in the Always-Surface Categories list (below) MUST NOT receive `UNNECESSARY`/`DROP`',
			);
		});

		it('clarify skill documents override behavior when critic attempts DROP', () => {
			expect(clarifyContent).toContain('override to `APPROVED`/`ASK_USER`');
		});

		it('plan skill documents override behavior when critic attempts DROP', () => {
			expect(planContent).toContain('override to `APPROVED`/`ASK_USER`');
		});

		it('clarify skill has "Mechanical Enforcement of DROP Protection" section', () => {
			expect(clarifyContent).toContain(
				'Mechanical Enforcement of DROP Protection',
			);
		});

		it('plan skill has "Mechanical Enforcement of DROP Protection" section', () => {
			expect(planContent).toContain(
				'Mechanical Enforcement of DROP Protection',
			);
		});
	});

	describe('Implementation guidance in documentation', () => {
		for (const slug of ['clarify', 'plan']) {
			const skillPath = join(
				process.cwd(),
				'.opencode/skills',
				slug,
				'SKILL.md',
			);
			const content = readFileSync(skillPath, 'utf-8');

			it(`documents validation at decision-packet assembly time (${slug})`, () => {
				expect(content).toContain('decision-packet assembly code');
			});

			it(`specifies warning log emission requirement (${slug})`, () => {
				expect(content).toContain('warning log');
			});

			it(`explains failure modes prevented by enforcement (${slug})`, () => {
				expect(content).toContain('failure mode');
			});

			it(`references src/agents/critic.ts as relevant code location (${slug})`, () => {
				expect(content).toContain('src/agents/critic.ts');
			});
		}
	});

	describe('Always-surface categories protection across all skills', () => {
		const skillSlugs = [
			'clarify',
			'plan',
			'specify',
			'brainstorm',
			'issue-ingest',
		];

		for (const skillSlug of skillSlugs) {
			it(`${skillSlug} skill documents always-surface protection requirement`, () => {
				const skillPath = join(
					process.cwd(),
					'.opencode/skills',
					skillSlug,
					'SKILL.md',
				);
				const content = readFileSync(skillPath, 'utf-8');
				expect(
					content,
					`${skillSlug} missing always-surface protection documentation`,
				).toMatch(/always.surface.*UNNECESSARY.*DROP/i);
			});
		}
	});

	describe('Integration test: override scenarios', () => {
		it('clarify skill specifies override target: APPROVED/ASK_USER', () => {
			const clarifyPath = join(
				process.cwd(),
				'.opencode/skills/clarify/SKILL.md',
			);
			const content = readFileSync(clarifyPath, 'utf-8');
			const stage3Start = content.indexOf(
				'#### Stage 3: Consult Critic Sounding Board',
			);
			const stage4Start = content.indexOf(
				'#### Stage 4: Surface User Decision Packet',
			);
			const stage3Section = content.slice(stage3Start, stage4Start);
			expect(stage3Section).toContain('override to `APPROVED`/`ASK_USER`');
		});

		it('plan skill specifies override target: APPROVED/ASK_USER', () => {
			const planPath = join(process.cwd(), '.opencode/skills/plan/SKILL.md');
			const content = readFileSync(planPath, 'utf-8');
			const stage3Start = content.indexOf(
				'#### Stage 3: Consult Critic Sounding Board',
			);
			const stage4Start = content.indexOf(
				'#### Stage 4: Surface User Decision Packet',
			);
			const stage3Section = content.slice(stage3Start, stage4Start);
			expect(stage3Section).toContain('override to `APPROVED`/`ASK_USER`');
		});
	});
});
