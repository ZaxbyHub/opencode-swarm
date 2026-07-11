import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
	BUNDLED_PROJECT_SKILL_ROOT,
	BUNDLED_PROJECT_SKILLS,
	bundledProjectSkillFileReference,
} from '../../../src/config/bundled-skills';

const ROOT = process.cwd();
const BUNDLED_SET = new Set<string>(BUNDLED_PROJECT_SKILLS);

function bundledSkillSource(slug: string): string {
	return readFileSync(
		join(ROOT, '.opencode', 'skills', slug, 'SKILL.md'),
		'utf8',
	);
}

function bundledSkillFiles(slug: string): string[] {
	const sourceDir = join(ROOT, '.opencode', 'skills', slug);
	const files: string[] = [];
	const visit = (directory: string): void => {
		for (const entry of readdirSync(directory)) {
			const candidate = join(directory, entry);
			if (statSync(candidate).isDirectory()) visit(candidate);
			else files.push(candidate);
		}
	};
	visit(sourceDir);
	return files;
}

function sourceFilesBelow(directory: string): string[] {
	const files: string[] = [];
	for (const entry of readdirSync(directory)) {
		const candidate = join(directory, entry);
		if (statSync(candidate).isDirectory()) {
			files.push(...sourceFilesBelow(candidate));
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
		if (statSync(candidate).isDirectory())
			files.push(...allFilesBelow(candidate));
		else files.push(candidate);
	}
	return files;
}

describe('bundled skill runtime dependency closure', () => {
	test('every helper call names an allowlisted skill and resolves to the private root', () => {
		const source = sourceFilesBelow(join(ROOT, 'src'))
			.map((file) => readFileSync(file, 'utf8'))
			.join('\n');
		const referenced = [
			...source.matchAll(/bundledProjectSkillFileReference\('([^']+)'\)/g),
		].map((match) => match[1]);

		expect(referenced.length).toBeGreaterThan(0);
		for (const slug of referenced) {
			expect(BUNDLED_PROJECT_SKILLS).toContain(slug);
			expect(
				bundledProjectSkillFileReference(
					slug as (typeof BUNDLED_PROJECT_SKILLS)[number],
				),
			).toBe(`file:${BUNDLED_PROJECT_SKILL_ROOT}/${slug}/SKILL.md`);
		}
	});

	test('runtime source has no legacy native-root reference to a bundled skill', () => {
		const legacyReferences: string[] = [];
		for (const file of sourceFilesBelow(join(ROOT, 'src'))) {
			const source = readFileSync(file, 'utf8');
			for (const slug of BUNDLED_PROJECT_SKILLS) {
				if (source.includes(`file:.opencode/skills/${slug}/SKILL.md`)) {
					legacyReferences.push(`${file}:${slug}`);
				}
			}
		}

		expect(legacyReferences).toEqual([]);
	});

	test('adapter references resolve to live canonical OpenCode skills', () => {
		const unresolved: string[] = [];
		for (const root of ['.agents/skills', '.claude/skills']) {
			for (const file of allFilesBelow(join(ROOT, root))) {
				if (!file.endsWith('SKILL.md')) continue;
				const source = readFileSync(file, 'utf8');
				for (const match of source.matchAll(
					/(?:\.\.\/)*\.opencode\/skills\/([a-z0-9._/-]+)\/SKILL\.md/g,
				)) {
					const canonical = join(
						ROOT,
						'.opencode',
						'skills',
						match[1],
						'SKILL.md',
					);
					if (!existsSync(canonical)) unresolved.push(`${file}:${match[0]}`);
				}
			}
		}

		expect(unresolved).toEqual([]);
	});

	test('promoted protocols have no stale generated-path references', () => {
		const staleReferences: string[] = [];
		for (const root of ['.agents', '.claude', '.opencode', 'docs', 'src']) {
			for (const file of allFilesBelow(join(ROOT, root))) {
				const source = readFileSync(file, 'utf8');
				if (
					/\.opencode\/skills\/generated\/(?:ci-fix-monitor|parallel-work-check)\/SKILL\.md/.test(
						source,
					)
				) {
					staleReferences.push(file);
				}
			}
		}

		expect(staleReferences).toEqual([]);
	});

	test('every bundled cross-protocol runtime reference is dependency-closed', () => {
		const referenced = new Set<string>();
		const legacyGeneratedReferences: string[] = [];

		for (const slug of BUNDLED_PROJECT_SKILLS) {
			for (const file of bundledSkillFiles(slug)) {
				const source = readFileSync(file, 'utf8');
				for (const match of source.matchAll(
					/file:\.swarm\/bundled-skills\/([a-z0-9._/-]+)\/SKILL\.md/g,
				)) {
					referenced.add(match[1]);
				}
				if (
					/(?:\.\.\/)+(?:(?:\.opencode\/skills\/)?generated\/)[a-z0-9._/-]+\/SKILL\.md/.test(
						source,
					)
				) {
					legacyGeneratedReferences.push(file);
				}
			}
		}

		expect(legacyGeneratedReferences).toEqual([]);
		expect(referenced).toContain('parallel-work-check');
		expect(referenced).toContain('ci-fix-monitor');
		for (const dependency of referenced) {
			expect(BUNDLED_SET.has(dependency)).toBe(true);
			expect(
				statSync(
					join(ROOT, '.opencode', 'skills', dependency, 'SKILL.md'),
				).isFile(),
			).toBe(true);
		}
	});

	test('required bundled protocols cannot carry stale or retired lifecycle markers', () => {
		for (const slug of BUNDLED_PROJECT_SKILLS) {
			const sourceDir = join(ROOT, '.opencode', 'skills', slug);
			expect(existsSync(join(sourceDir, 'retired.marker'))).toBe(false);
			expect(existsSync(join(sourceDir, 'stale.marker'))).toBe(false);
		}
	});

	test('every allowlisted package source has valid plugin audience metadata', () => {
		for (const slug of BUNDLED_PROJECT_SKILLS) {
			const source = bundledSkillSource(slug);
			expect(source).toMatch(
				/^---\r?\nname:[^\r\n]+\r?\naudience: swarm-plugin\r?\n/,
			);
		}
	});
});
