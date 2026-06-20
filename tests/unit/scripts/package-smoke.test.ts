import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
// @ts-expect-error - .mjs script exports runtime helpers without declarations.
import {
	REQUIRED_PROJECT_SKILL_SLUGS,
	validatePackageFiles,
} from '../../../scripts/package-smoke.mjs';
import { BUNDLED_PROJECT_SKILLS } from '../../../src/config/bundled-skills.ts';

const expectedGrammars = [
	'dist/lang/grammars/tree-sitter.wasm',
	'dist/lang/grammars/tree-sitter-typescript.wasm',
];

const requiredProjectSkillSlugs = [
	'brainstorm',
	'specify',
	'clarify-spec',
	'resume',
	'clarify',
	'discover',
	'consult',
	'pre-phase-briefing',
	'council',
	'deep-dive',
	'deep-research',
	'codebase-review-swarm',
	'design-docs',
	'swarm-pr-review',
	'swarm-pr-feedback',
	'issue-ingest',
	'plan',
	'critic-gate',
	'execute',
	'phase-wrap',
	'loop',
];

const expectedProjectSkillFiles = [
	...requiredProjectSkillSlugs.map(
		(slug) => `.opencode/skills/${slug}/SKILL.md`,
	),
	'.opencode/skills/codebase-review-swarm/assets/jsonl-schemas.md',
	'.opencode/skills/codebase-review-swarm/assets/review-report-template.md',
	'.opencode/skills/codebase-review-swarm/references/review-protocol-v8.2.md',
];

const baseFiles = [
	'dist/index.js',
	'dist/index.d.ts',
	'dist/cli/index.js',
	...expectedProjectSkillFiles,
	'README.md',
	'LICENSE',
	'package.json',
	...expectedGrammars,
].map((path) => ({ path }));

describe('package-smoke skill-list sync', () => {
	// Regression: the package:smoke gate keeps its own slug allowlist. When a
	// new bundled skill was added to BUNDLED_PROJECT_SKILLS (and package.json
	// files) without updating this script, the packed tarball contained an
	// "unexpected bundled skill package file" and package-check failed in CI.
	// These assertions fail fast at unit time instead.
	test('REQUIRED_PROJECT_SKILL_SLUGS matches BUNDLED_PROJECT_SKILLS exactly', () => {
		expect([...REQUIRED_PROJECT_SKILL_SLUGS].sort()).toEqual(
			[...BUNDLED_PROJECT_SKILLS].sort(),
		);
	});

	test('test fixture slug list matches the script allowlist', () => {
		expect([...requiredProjectSkillSlugs].sort()).toEqual(
			[...REQUIRED_PROJECT_SKILL_SLUGS].sort(),
		);
	});
});

describe('package-smoke validatePackageFiles', () => {
	test('package export map preserves the root plugin boundary without exporting the Bun-targeted CLI', () => {
		const pkg = JSON.parse(
			fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf-8'),
		) as {
			exports: Record<string, unknown>;
		};
		expect(pkg.exports['.']).toEqual({
			types: './dist/index.d.ts',
			default: './dist/index.js',
		});
		expect(pkg.exports['./cli']).toBeUndefined();
		expect(pkg.exports['./package.json']).toBe('./package.json');
	});

	test('accepts a package with runtime files, declarations, and grammar assets', () => {
		const result = validatePackageFiles(
			baseFiles,
			expectedGrammars,
			expectedProjectSkillFiles,
		);

		expect(result.ok).toBe(true);
		expect(result.errors).toEqual([]);
	});

	test('rejects a package missing the public type declaration entrypoint', () => {
		const result = validatePackageFiles(
			baseFiles.filter((file) => file.path !== 'dist/index.d.ts'),
			expectedGrammars,
			expectedProjectSkillFiles,
		);

		expect(result.ok).toBe(false);
		expect(result.errors).toContain(
			'missing required package file: dist/index.d.ts',
		);
	});

	test('rejects a package missing a bundled architect mode skill', () => {
		const result = validatePackageFiles(
			baseFiles.filter(
				(file) => file.path !== '.opencode/skills/design-docs/SKILL.md',
			),
			expectedGrammars,
			expectedProjectSkillFiles,
		);

		expect(result.ok).toBe(false);
		expect(result.errors).toContain(
			'missing required package file: .opencode/skills/design-docs/SKILL.md',
		);
		expect(result.errors).toContain(
			'missing bundled skill package file: .opencode/skills/design-docs/SKILL.md',
		);
	});

	test('rejects a package missing a grammar asset copied from source', () => {
		const result = validatePackageFiles(
			baseFiles.filter(
				(file) =>
					file.path !== 'dist/lang/grammars/tree-sitter-typescript.wasm',
			),
			expectedGrammars,
			expectedProjectSkillFiles,
		);

		expect(result.ok).toBe(false);
		expect(result.errors).toContain(
			'missing grammar asset: dist/lang/grammars/tree-sitter-typescript.wasm',
		);
	});

	test('rejects source-only files that should not ship in the npm package', () => {
		const result = validatePackageFiles(
			[...baseFiles, { path: 'src/agents/architect.ts' }],
			expectedGrammars,
			expectedProjectSkillFiles,
		);

		expect(result.ok).toBe(false);
		expect(result.errors).toContain(
			'unexpected source-only package file: src/agents/architect.ts',
		);
	});

	test('normalizes npm tar paths that include a package/ prefix', () => {
		const prefixed = baseFiles.map((file) => ({
			path: `package/${file.path}`,
		}));
		const result = validatePackageFiles(
			prefixed,
			expectedGrammars,
			expectedProjectSkillFiles,
		);

		expect(result.ok).toBe(true);
		expect(result.paths.has('dist/index.js')).toBe(true);
	});

	test('regression F-003/F-004: rejects non-bundled skill files in the tarball', () => {
		const result = validatePackageFiles(
			[
				...baseFiles,
				{ path: '.opencode/skills/generated/codebase-review-swarm/SKILL.md' },
			],
			expectedGrammars,
			expectedProjectSkillFiles,
		);

		expect(result.ok).toBe(false);
		expect(result.errors).toContain(
			'unexpected bundled skill package file: .opencode/skills/generated/codebase-review-swarm/SKILL.md',
		);
	});

	test('regression F-003/F-004: rejects unallowlisted files inside bundled skill directories', () => {
		const result = validatePackageFiles(
			[
				...baseFiles,
				{ path: '.opencode/skills/design-docs/generated/debug.json' },
			],
			expectedGrammars,
			expectedProjectSkillFiles,
		);

		expect(result.ok).toBe(false);
		expect(result.errors).toContain(
			'unexpected bundled skill package file: .opencode/skills/design-docs/generated/debug.json',
		);
	});
});
