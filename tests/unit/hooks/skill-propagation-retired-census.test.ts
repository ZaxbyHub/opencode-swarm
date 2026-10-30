/**
 * Retired-skill replacement-map census and reconciled-tree census (issue
 * #2966, split from skill-propagation-retired-injection.test.ts for the
 * FR-006 500-line cap during the PR #3506 feedback round).
 *
 * Pinned here: the RETIRED_SKILL_REPLACEMENTS map's exact consumer-stable
 * shape and resolvability, and the repository tree reconciliation (0 markers,
 * the 20 deleted directories absent, the 17 active forks retained, no live
 * SKILL.md referencing a deleted fork, byte-identical test-file-split
 * mirrors).
 */
import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	RETIRED_SKILL_REPLACEMENTS,
	validateSkillReference,
} from '../../../src/hooks/skill-propagation-gate';
import { canonicalMkdtemp, removeTreeWithRetry } from '../../helpers/tmpdir';
import {
	MAPPED_SLUGS,
	RETAINED_SLUGS,
	RETIRED_SLUGS,
	writeSkillDir,
} from './_retired-injection-fixtures';

function validate(root: string, reference: string) {
	return validateSkillReference(
		root,
		reference,
		{},
		{ enforceAudience: false },
	);
}

describe('replacement map census', () => {
	test('covers exactly the six claimed slugs with consumer-stable bundled references', () => {
		expect(Object.keys(RETIRED_SKILL_REPLACEMENTS).sort()).toEqual(
			[...MAPPED_SLUGS].sort(),
		);
		for (const slug of MAPPED_SLUGS) {
			const value = RETIRED_SKILL_REPLACEMENTS[slug];
			expect(value.startsWith('file:.swarm/bundled-skills/')).toBe(true);
			expect(value.endsWith('/SKILL.md')).toBe(true);
			// non-self: never points back at the retired tree
			expect(value.includes('/generated/')).toBe(false);
		}
		expect(RETIRED_SKILL_REPLACEMENTS['pr-review-fix']).toBe(
			'file:.swarm/bundled-skills/swarm-pr-feedback/SKILL.md',
		);
		expect(RETIRED_SKILL_REPLACEMENTS['pr-readiness']).toBe(
			'file:.swarm/bundled-skills/swarm-pr-feedback/SKILL.md',
		);
	});

	test('every replacement target resolves in a consumer-shaped tree', () => {
		// Consumer projects have NO .opencode natives — only .swarm/bundled-skills.
		const scratch = canonicalMkdtemp('retired-census-');
		try {
			for (const slug of MAPPED_SLUGS) {
				const reference = RETIRED_SKILL_REPLACEMENTS[slug];
				const relative = reference.replace(/^file:/, '');
				writeSkillDir(scratch, path.dirname(relative));
			}
			for (const slug of MAPPED_SLUGS) {
				const reference = RETIRED_SKILL_REPLACEMENTS[slug];
				const result = validate(scratch, reference);
				expect(result.valid, `${slug}: replacement does not resolve`).toBe(
					true,
				);
			}
		} finally {
			removeTreeWithRetry(scratch);
		}
	});
});

describe('repository tree census (reconciliation pinned)', () => {
	// Repo-root resolution via import.meta.dir (cwd-independent read-only
	// census of the checkout's skill trees; FR-011 safe).
	const repoRoot = path.resolve(import.meta.dir, '../../..');
	const generatedRoot = path.join(repoRoot, '.opencode', 'skills', 'generated');

	test('zero retired/stale markers under .opencode/skills/generated', () => {
		let markerCount = 0;
		for (const slug of fs.readdirSync(generatedRoot)) {
			const dir = path.join(generatedRoot, slug);
			if (
				fs.existsSync(path.join(dir, 'retired.marker')) ||
				fs.existsSync(path.join(dir, 'stale.marker'))
			) {
				markerCount += 1;
			}
		}
		expect(markerCount).toBe(0);
	});

	test('the 20 reconciled directories are gone; the 17 active forks remain', () => {
		for (const slug of RETIRED_SLUGS) {
			expect(
				fs.existsSync(path.join(generatedRoot, slug)),
				`${slug}: still present`,
			).toBe(false);
		}
		expect(fs.existsSync(path.join(generatedRoot, 'ci-failure-batching'))).toBe(
			false,
		);
		for (const slug of RETAINED_SLUGS) {
			expect(
				fs.existsSync(path.join(generatedRoot, slug)),
				`${slug}: wrongly removed`,
			).toBe(true);
		}
	});

	test('no SKILL.md outside generated/ references the deleted retired forks', () => {
		const roots = ['.agents/skills', '.opencode/skills', '.claude/skills'].map(
			(rel) => path.join(repoRoot, rel),
		);
		const offenders: string[] = [];
		const walk = (dir: string): void => {
			if (!fs.existsSync(dir)) return;
			for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
				const full = path.join(dir, entry.name);
				if (entry.isDirectory()) {
					if (full === generatedRoot) continue; // self-references excluded
					walk(full);
					continue;
				}
				if (entry.name !== 'SKILL.md') continue;
				const content = fs.readFileSync(full, 'utf-8');
				// Every deleted fork (19 retired + the ci-failure-batching
				// collision), not just a subset (review LO-3).
				const deletedSlugs = [...RETIRED_SLUGS, 'ci-failure-batching'];
				for (const slug of deletedSlugs) {
					if (content.includes(`generated/${slug}`)) {
						offenders.push(
							`${path.relative(repoRoot, full)} -> generated/${slug}`,
						);
					}
				}
			}
		};
		for (const root of roots) walk(root);
		expect(offenders).toEqual([]);
	});

	test('the three test-file-split copies remain byte-identical (mirror contract)', () => {
		const read = (tree: string) =>
			fs.readFileSync(
				path.join(repoRoot, tree, 'skills/test-file-split/SKILL.md'),
			);
		const opencode = read('.opencode');
		expect(read('.claude').equals(opencode)).toBe(true);
		expect(read('.agents').equals(opencode)).toBe(true);
	});
});
