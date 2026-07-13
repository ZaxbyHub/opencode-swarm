/**
 * Regression coverage for mirrored on-demand skills.
 */

import { describe, expect, it } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
	ADAPTER_ARCHITECT_MODE_SKILLS,
	ADDITIONAL_SKILL_MIRROR_CONTRACTS,
	DIVERGENT_ARCHITECT_MODE_SKILLS,
	MIRRORED_ARCHITECT_MODE_SKILLS,
	OPENCODE_ONLY_ARCHITECT_MODE_SKILLS,
} from '../../../src/config/skill-mirrors.ts';

// The mirror contract lists now live in src/config/skill-mirrors.ts so the
// regression test below and the scripts/drift-check.ts CI detector share one
// source of truth and cannot themselves drift apart. When adding a new
// architect mode stub that loads a skill, update that module (MIRRORED, or
// DIVERGENT if the .claude variant is intentionally condensed).
const architectSource = readFileSync(
	join(process.cwd(), 'src/agents/architect.ts'),
	'utf-8',
);

describe('architect mode skill mirrors - regression: prevent mirror drift (F-001)', () => {
	for (const {
		slug: skillName,
		opencodePath,
		claudePath,
	} of MIRRORED_ARCHITECT_MODE_SKILLS) {
		it(`${skillName} skill stays byte-identical across OpenCode and Claude mirrors`, () => {
			// Future protocol edits must update both mirrors together; otherwise
			// OpenCode and Claude sessions can diverge silently.
			const opencodeSkill = readFileSync(
				join(process.cwd(), opencodePath),
				'utf-8',
			);
			const claudeSkill = readFileSync(
				join(process.cwd(), claudePath),
				'utf-8',
			);

			expect(claudeSkill).toBe(opencodeSkill);
		});
	}

	for (const {
		slug,
		opencodePath,
		claudePath,
		reason,
	} of DIVERGENT_ARCHITECT_MODE_SKILLS) {
		it(`${slug} skill: both .opencode and .claude mirrors exist (${reason})`, () => {
			expect(existsSync(join(process.cwd(), opencodePath))).toBe(true);
			expect(existsSync(join(process.cwd(), claudePath))).toBe(true);
		});
	}

	for (const {
		slug,
		canonicalPath,
		adapterPaths,
		expectedCanonicalRef,
	} of ADAPTER_ARCHITECT_MODE_SKILLS) {
		it(`${slug} adapters delegate back to the canonical .opencode skill`, () => {
			expect(existsSync(join(process.cwd(), canonicalPath))).toBe(true);

			for (const adapterPath of adapterPaths) {
				const adapterSource = readFileSync(
					join(process.cwd(), adapterPath),
					'utf-8',
				);
				const lineCount = adapterSource.trimEnd().split(/\r?\n/).length;

				expect(adapterSource).toContain(expectedCanonicalRef);
				expect(lineCount).toBeLessThan(60);
				expect(adapterSource).toContain('canonical workflow');
				expect(adapterSource).not.toContain('## Phase ');
				expect(adapterSource).not.toContain('## Multi-Round');
				expect(adapterSource).not.toContain('### Bot Review');
			}
		});
	}

	for (const {
		slug,
		opencodePath,
		reason,
	} of OPENCODE_ONLY_ARCHITECT_MODE_SKILLS) {
		it(`${slug} skill: .opencode exists and is intentionally NOT mirrored to .claude (${reason})`, () => {
			expect(existsSync(join(process.cwd(), opencodePath))).toBe(true);
			const claudePath = opencodePath.replace(
				'.opencode/skills/',
				'.claude/skills/',
			);
			expect(existsSync(join(process.cwd(), claudePath))).toBe(false);
		});
	}

	describe('ADDITIONAL_SKILL_MIRROR_CONTRACTS (non-architect skill pairs)', () => {
		for (const contract of ADDITIONAL_SKILL_MIRROR_CONTRACTS) {
			const opencodePath = join(
				process.cwd(),
				`.opencode/skills/${contract.slug}/SKILL.md`,
			);
			const claudePath = join(
				process.cwd(),
				`.claude/skills/${contract.slug}/SKILL.md`,
			);

			if (contract.kind === 'identical') {
				it(`${contract.slug}: every declared mirror is byte-identical`, () => {
					expect(existsSync(opencodePath)).toBe(true);
					expect(existsSync(claudePath)).toBe(true);
					const canonical = readFileSync(opencodePath, 'utf-8');
					expect(readFileSync(claudePath, 'utf-8')).toBe(canonical);
					for (const extraPath of contract.extraIdenticalPaths ?? []) {
						const resolvedExtraPath = join(process.cwd(), extraPath);
						expect(existsSync(resolvedExtraPath)).toBe(true);
						expect(readFileSync(resolvedExtraPath, 'utf-8')).toBe(canonical);
					}
				});
			} else if (contract.kind === 'divergent') {
				it(`${contract.slug}: both .opencode and .claude mirrors exist (divergent)`, () => {
					expect(existsSync(opencodePath)).toBe(true);
					expect(existsSync(claudePath)).toBe(true);
				});
			} else if (contract.kind === 'opencode-only') {
				it(`${contract.slug}: .opencode exists and no .claude mirror`, () => {
					expect(existsSync(opencodePath)).toBe(true);
					expect(existsSync(claudePath)).toBe(false);
				});
			}
		}
	});

	it('keeps mirrored skill list in sync with architect mode stubs', () => {
		// Previous coverage used only this hardcoded list, so a new architect
		// stub could reference a skill that was never checked for mirror parity.
		//
		// swarm-pr-subscribe is event-driven: the PR-monitor wake prompt /
		// [pr-monitor:...] advisory instructs the subscribed session to load the
		// skill directly, so no architect.ts MODE stub references it. It still
		// belongs in ADAPTER_ARCHITECT_MODE_SKILLS so its .claude/.agents shims
		// are held to the adapter contract. If a /swarm command ever gains a
		// MODE stub for it, remove this exemption.
		const eventDrivenAdapterSkills = new Set(['swarm-pr-subscribe']);
		const stubSlugs = [
			...architectSource.matchAll(
				/bundledProjectSkillFileReference\('([^']+)'\)/g,
			),
		].map((match) => match[1]);
		const mirroredSlugs = [
			...MIRRORED_ARCHITECT_MODE_SKILLS.map(({ slug }) => slug),
			...DIVERGENT_ARCHITECT_MODE_SKILLS.map(({ slug }) => slug),
			...ADAPTER_ARCHITECT_MODE_SKILLS.map(({ slug }) => slug).filter(
				(slug) => !eventDrivenAdapterSkills.has(slug),
			),
			...OPENCODE_ONLY_ARCHITECT_MODE_SKILLS.map(({ slug }) => slug),
		];

		// Deduplicate both sides — architect.ts may reference a slug in multiple
		// MODE stubs (e.g. when the same skill is loaded by two modes), and a
		// future editor could mistakenly add a slug to both MIRRORED and DIVERGENT.
		expect([...new Set(stubSlugs)].sort()).toEqual(
			[...new Set(mirroredSlugs)].sort(),
		);
	});
});
