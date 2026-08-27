/**
 * Regression guard for issue #2379: a repo-shipped native skill slug must not
 * shadow a host built-in slash command.
 *
 * Both hosts expose every `<native-root>/skills/<slug>/` directory as the
 * slash command `/<slug>`, with no notion of "internal-only protocol skill".
 * The `resume` architect-MODE protocol shadowed Claude Code's built-in
 * `/resume` (conversation resume) until it was renamed to `swarm-resume`.
 * `CLAUDE_CODE_NATIVE_COMMANDS` (src/config/constants.ts) is the repo's own
 * oracle for host built-in names, so this test reuses it instead of a second
 * hand-maintained list.
 */

import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
	BUNDLED_PROJECT_SKILLS,
	RETIRED_BUNDLED_PROJECT_SKILLS,
} from '../../../src/config/bundled-skills';
import { CLAUDE_CODE_NATIVE_COMMANDS } from '../../../src/config/constants';
import { OPENCODE_ONLY_ARCHITECT_MODE_SKILLS } from '../../../src/config/skill-mirrors';

const ROOT = process.cwd();
const NATIVE_SKILL_TREES = ['.claude/skills', '.opencode/skills'] as const;
const ALL_SKILL_TREES = [
	'.claude/skills',
	'.opencode/skills',
	'.agents/skills',
] as const;

function nativeSkillSlugs(tree: string): string[] {
	const dir = join(ROOT, ...tree.split('/'));
	if (!existsSync(dir)) return [];
	return readdirSync(dir, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => entry.name)
		.sort();
}

function tsFilesBelow(directory: string): string[] {
	const files: string[] = [];
	for (const entry of readdirSync(directory)) {
		const candidate = join(directory, entry);
		if (statSync(candidate).isDirectory()) {
			files.push(...tsFilesBelow(candidate));
		} else if (entry.endsWith('.ts')) {
			files.push(candidate);
		}
	}
	return files;
}

function allFilesBelow(directory: string): string[] {
	const files: string[] = [];
	for (const entry of readdirSync(directory)) {
		const candidate = join(directory, entry);
		if (statSync(candidate).isDirectory()) {
			files.push(...allFilesBelow(candidate));
		} else {
			files.push(candidate);
		}
	}
	return files;
}

/**
 * Acknowledged, deliberately-kept collisions. Every entry needs a reason and
 * an exit path; this list must shrink, never grow:
 *
 * - `plan` (both trees): pre-existing same-class collision (shadows Claude
 *   Code plan mode). It gets the same dedicated reviewed rename PR treatment
 *   as `resume` in #2379 — the issue explicitly prescribes one rename PR per
 *   slug — and is tracked as a follow-up issue referencing #2379. Remove this
 *   entry when that rename lands.
 * - OPENCODE_ONLY_ARCHITECT_MODE_SKILLS (.opencode tree, derived — not
 *   duplicated): those slugs are intentionally not mirrored to `.claude`
 *   precisely because a mirror would shadow a Claude Code built-in (e.g.
 *   `loop`, which shadows CC's `/loop`) or the mode is reachable only through
 *   the OpenCode plugin runtime. Claude Code never reads `.opencode`, so an
 *   opencode-only slug cannot shadow anything in the Claude Code host.
 */
const ACKNOWLEDGED_CLAUDE_COMMAND_COLLISIONS: Record<string, string[]> = {
	'.claude/skills': ['plan'],
	'.opencode/skills': [
		'plan',
		...OPENCODE_ONLY_ARCHITECT_MODE_SKILLS.map(({ slug }) => slug),
	],
};

describe('native skill slugs must not shadow host built-in commands (#2379)', () => {
	for (const tree of NATIVE_SKILL_TREES) {
		test(`${tree}: no slug is a Claude Code built-in slash command`, () => {
			const acknowledged = ACKNOWLEDGED_CLAUDE_COMMAND_COLLISIONS[tree] ?? [];
			const collisions = nativeSkillSlugs(tree).filter(
				(slug) =>
					CLAUDE_CODE_NATIVE_COMMANDS.has(slug) && !acknowledged.includes(slug),
			);
			expect(collisions).toEqual([]);
		});
	}

	test("issue #2379: 'resume' no longer ships as a native skill slug in either tree", () => {
		expect(nativeSkillSlugs('.claude/skills')).not.toContain('resume');
		expect(nativeSkillSlugs('.opencode/skills')).not.toContain('resume');
	});
});

describe('retired bundled-skill hygiene (#2379 rename fallout)', () => {
	test('a slug is never both active and retired', () => {
		const overlap = RETIRED_BUNDLED_PROJECT_SKILLS.filter((slug) =>
			BUNDLED_PROJECT_SKILLS.includes(
				slug as (typeof BUNDLED_PROJECT_SKILLS)[number],
			),
		);
		expect(overlap).toEqual([]);
	});

	test('no retired slug retains a native-tree skill directory', () => {
		for (const slug of RETIRED_BUNDLED_PROJECT_SKILLS) {
			for (const tree of ALL_SKILL_TREES) {
				expect(nativeSkillSlugs(tree)).not.toContain(slug);
			}
		}
	});

	test('no source or skill file still references a retired slug', () => {
		// After a rename, bundled-skill-runtime-closure.test.ts iterates the
		// NEW BUNDLED_PROJECT_SKILLS, so it can no longer catch a re-introduced
		// `bundledProjectSkillFileReference('<retired>')` literal (plan-critic
		// finding for #2379). This scan re-closes that blind spot for every
		// retired slug across runtime source and all skill trees.
		const offenders: string[] = [];
		const scans: Array<[root: string, files: string[]]> = [
			['src', tsFilesBelow(join(ROOT, 'src'))],
			...ALL_SKILL_TREES.map((tree) => {
				const dir = join(ROOT, ...tree.split('/'));
				return [tree, existsSync(dir) ? allFilesBelow(dir) : []] as const;
			}),
		];
		for (const [root, files] of scans) {
			for (const file of files) {
				const source = readFileSync(file, 'utf-8');
				for (const slug of RETIRED_BUNDLED_PROJECT_SKILLS) {
					if (source.includes(`bundledProjectSkillFileReference('${slug}')`)) {
						offenders.push(`${root}: ${file} still calls helper '${slug}'`);
					}
					if (source.includes(`file:.swarm/bundled-skills/${slug}/SKILL.md`)) {
						offenders.push(`${root}: ${file} still refs bundled '${slug}'`);
					}
					if (source.includes(`.opencode/skills/${slug}/SKILL.md`)) {
						offenders.push(`${root}: ${file} still refs native '${slug}'`);
					}
				}
			}
		}
		expect(offenders).toEqual([]);
	});
});
