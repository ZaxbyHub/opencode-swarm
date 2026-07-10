import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	BUNDLED_PROJECT_SKILL_ROOT,
	BUNDLED_PROJECT_SKILLS,
	bundledProjectSkillFileReference,
} from '../../../src/config/bundled-skills.ts';

// Regression for issue #1496: four skills (writing-tests, running-tests,
// engineering-conventions, commit-pr) existed under .opencode/skills/ but were
// missing from BUNDLED_PROJECT_SKILLS and package.json#files, so they never
// materialized into the plugin-private runtime tree or shipped in the npm package. The existing
// package-smoke drift test only checks the hand-maintained slug lists against
// EACH OTHER; nothing checked them against the actual filesystem or
// package.json. These assertions close that gap: the bundled lists must be
// complete vs the .opencode/skills/ directory and vs package.json#files.

const REPO_ROOT = path.resolve(import.meta.dir, '../../..');
const OPENCODE_SKILLS_DIR = path.join(REPO_ROOT, '.opencode', 'skills');
const PACKAGE_SKILL_PREFIX = '.opencode/skills/';

// Directories under .opencode/skills/ that are intentionally NOT bundled.
// `generated/` is an open-ended runtime output root and therefore cannot ship
// wholesale. A small dependency-closed subset may be explicitly allowlisted as
// `generated/<slug>` entries in BUNDLED_PROJECT_SKILLS.
const NON_BUNDLED_SKILL_DIRS = new Set(['generated']);

function listSkillDirs(): string[] {
	return fs
		.readdirSync(OPENCODE_SKILLS_DIR, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => entry.name);
}

function readPackageFiles(): string[] {
	const pkg = JSON.parse(
		fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf-8'),
	) as { files?: string[] };
	return pkg.files ?? [];
}

describe('bundled-skills coherence (issue #1496 regression)', () => {
	const bundled = new Set<string>(BUNDLED_PROJECT_SKILLS);

	test('uses a project-private .swarm root instead of any repository-native skill root', () => {
		expect(BUNDLED_PROJECT_SKILL_ROOT).toBe('.swarm/bundled-skills');
		for (const nativeRoot of [
			'.opencode/skills',
			'.claude/skills',
			'.agents/skills',
		]) {
			expect(BUNDLED_PROJECT_SKILL_ROOT.startsWith(nativeRoot)).toBe(false);
		}
	});

	test('every bundled slug has one stable private file reference', () => {
		const references = BUNDLED_PROJECT_SKILLS.map((slug) =>
			bundledProjectSkillFileReference(slug),
		);
		expect(new Set(references).size).toBe(BUNDLED_PROJECT_SKILLS.length);
		expect(references).toEqual(
			BUNDLED_PROJECT_SKILLS.map(
				(slug) => `file:.swarm/bundled-skills/${slug}/SKILL.md`,
			),
		);
	});

	test('every shippable .opencode/skills/ directory is in BUNDLED_PROJECT_SKILLS', () => {
		const onDisk = listSkillDirs().filter(
			(dir) => !NON_BUNDLED_SKILL_DIRS.has(dir),
		);
		const missing = onDisk.filter((dir) => !bundled.has(dir)).sort();
		expect(missing).toEqual([]);
	});

	test('BUNDLED_PROJECT_SKILLS has no phantom entries (each has a SKILL.md on disk)', () => {
		const phantom = [...BUNDLED_PROJECT_SKILLS]
			.filter(
				(slug) =>
					!fs.existsSync(path.join(OPENCODE_SKILLS_DIR, slug, 'SKILL.md')),
			)
			.sort();
		expect(phantom).toEqual([]);
	});

	test('no bundled slug overlaps the non-bundled exclusion set', () => {
		const overlap = [...BUNDLED_PROJECT_SKILLS]
			.filter((slug) => NON_BUNDLED_SKILL_DIRS.has(slug))
			.sort();
		expect(overlap).toEqual([]);
	});

	test('package.json#files lists every bundled skill directory', () => {
		const files = new Set(readPackageFiles());
		const missing = [...BUNDLED_PROJECT_SKILLS]
			.filter((slug) => !files.has(`${PACKAGE_SKILL_PREFIX}${slug}`))
			.sort();
		expect(missing).toEqual([]);
	});

	test('package.json#files lists no unbundled .opencode/skills/ directory', () => {
		const unexpected = readPackageFiles()
			.filter((file) => file.startsWith(PACKAGE_SKILL_PREFIX))
			.map((file) => file.slice(PACKAGE_SKILL_PREFIX.length))
			.filter((slug) => !bundled.has(slug))
			.sort();
		expect(unexpected).toEqual([]);
	});
});
