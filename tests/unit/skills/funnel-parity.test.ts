/**
 * Cross-skill funnel parity verification test.
 *
 * Verifies that the clarification funnel protocol is consistent across all skill files
 * that embed it: clarify, plan, specify, brainstorm, issue-ingest, and clarify-spec.
 *
 * This test ensures that stages, classification categories, critic outcomes, and
 * always-surface categories remain synchronized across all skill implementations.
 */

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Skills with FULL clarification funnel (all 5 categories, all protections required)
const FULL_FUNNEL_SKILLS = [
	'clarify',
	'plan',
	'specify',
	'brainstorm',
	'issue-ingest',
];

// Skills with SCOPED funnel protocol (subset of funnel for specific use case)
const SCOPED_FUNNEL_SKILLS = ['clarify-spec'];

// All funnel-bearing skills (full + scoped)
const ALL_FUNNEL_SKILLS = [...FULL_FUNNEL_SKILLS, ...SCOPED_FUNNEL_SKILLS];

// Core funnel elements that must appear in all full-funnel skills
const REQUIRED_FUNNEL_ELEMENTS = {
	categories: [
		'self_resolved',
		'critic_resolved',
		'research_needed',
		'user_decision',
		'deferred_nonblocking',
	],
	outcomes: [
		'UNNECESSARY',
		'DROP',
		'RESOLVE',
		'REPHRASE',
		'APPROVED',
		'ASK_USER',
	],
	protections: [
		'Overconfidence guard', // Note: capital O as appears in skills
		'always-surface',
		'SoundingBoardVerdict',
	],
};

describe('Cross-skill funnel parity verification', () => {
	describe('All funnel-bearing skills present', () => {
		for (const skillSlug of ALL_FUNNEL_SKILLS) {
			it(`${skillSlug} skill exists`, () => {
				const skillPath = join(
					process.cwd(),
					'.opencode/skills',
					skillSlug,
					'SKILL.md',
				);
				const content = readFileSync(skillPath, 'utf-8');
				expect(content.length).toBeGreaterThan(0);
			});
		}
	});

	describe('Classification categories parity (full-funnel skills only)', () => {
		// Note: Scoped-funnel skills like clarify-spec don't enumerate all categories
		for (const category of REQUIRED_FUNNEL_ELEMENTS.categories) {
			it(`"${category}" appears in all full-funnel skills`, () => {
				for (const skillSlug of FULL_FUNNEL_SKILLS) {
					const skillPath = join(
						process.cwd(),
						'.opencode/skills',
						skillSlug,
						'SKILL.md',
					);
					const content = readFileSync(skillPath, 'utf-8');
					expect(
						content,
						`${skillSlug} missing category: ${category}`,
					).toContain(category);
				}
			});
		}
	});

	describe('Critic outcomes parity (all funnel skills)', () => {
		for (const outcome of REQUIRED_FUNNEL_ELEMENTS.outcomes) {
			it(`"${outcome}" appears in all funnel skills`, () => {
				for (const skillSlug of ALL_FUNNEL_SKILLS) {
					const skillPath = join(
						process.cwd(),
						'.opencode/skills',
						skillSlug,
						'SKILL.md',
					);
					const content = readFileSync(skillPath, 'utf-8');
					expect(content, `${skillSlug} missing outcome: ${outcome}`).toContain(
						outcome,
					);
				}
			});
		}
	});

	describe('Funnel protections parity (all funnel skills)', () => {
		for (const protection of REQUIRED_FUNNEL_ELEMENTS.protections) {
			it(`"${protection}" protection appears in all funnel skills`, () => {
				for (const skillSlug of ALL_FUNNEL_SKILLS) {
					const skillPath = join(
						process.cwd(),
						'.opencode/skills',
						skillSlug,
						'SKILL.md',
					);
					const content = readFileSync(skillPath, 'utf-8');
					expect(
						content,
						`${skillSlug} missing protection: ${protection}`,
					).toContain(protection);
				}
			});
		}
	});

	describe('Always-surface categories spot-check (full coverage in clarify-funnel-verify)', () => {
		const alwaysSurfaceItems = [
			'Scope boundaries',
			'Data loss or destructive behavior',
			'Security/privacy risk tolerance',
			'Backward compatibility',
			'Breaking changes',
			'New dependency',
			'Deprecation',
			'Cross-platform impact',
			'Cost/performance',
			'User-visible behavior',
			'Release/rollout',
			'QA gates',
			'advisory vs hard-blocking',
		];

		it('clarify skill contains always-surface section', () => {
			const skillPath = join(
				process.cwd(),
				'.opencode/skills/clarify/SKILL.md',
			);
			const content = readFileSync(skillPath, 'utf-8');
			expect(content).toContain('Always-Surface Categories');
		});

		it('plan skill contains always-surface section', () => {
			const skillPath = join(process.cwd(), '.opencode/skills/plan/SKILL.md');
			const content = readFileSync(skillPath, 'utf-8');
			expect(content).toContain('Always-Surface Categories');
		});

		it('clarify-spec skill references always-surface protection', () => {
			const skillPath = join(
				process.cwd(),
				'.opencode/skills/clarify-spec/SKILL.md',
			);
			const content = readFileSync(skillPath, 'utf-8');
			expect(content).toContain('always-surface protection');
		});

		// Verify key always-surface items are documented in full-funnel skills
		for (const item of alwaysSurfaceItems.slice(0, 5)) {
			// Test first 5 to avoid excessive test count
			it(`both clarify and plan skills mention always-surface aspect: "${item}"`, () => {
				const clarifyPath = join(
					process.cwd(),
					'.opencode/skills/clarify/SKILL.md',
				);
				const planPath = join(process.cwd(), '.opencode/skills/plan/SKILL.md');
				const clarifyContent = readFileSync(clarifyPath, 'utf-8');
				const planContent = readFileSync(planPath, 'utf-8');

				// Both should mention related concepts (exact text may vary slightly)
				expect(clarifyContent.toLowerCase()).toContain(item.toLowerCase());
				expect(planContent.toLowerCase()).toContain(item.toLowerCase());
			});
		}
	});

	describe('.opencode/.claude mirror parity', () => {
		for (const skillSlug of ALL_FUNNEL_SKILLS) {
			it(`${skillSlug} .claude mirror is byte-identical to .opencode version`, () => {
				const opencodePath = join(
					process.cwd(),
					'.opencode/skills',
					skillSlug,
					'SKILL.md',
				);
				const claudePath = join(
					process.cwd(),
					'.claude/skills',
					skillSlug,
					'SKILL.md',
				);
				const opencodeContent = readFileSync(opencodePath);
				const claudeContent = readFileSync(claudePath);
				expect(claudeContent).toEqual(opencodeContent);
			});
		}
	});
});
