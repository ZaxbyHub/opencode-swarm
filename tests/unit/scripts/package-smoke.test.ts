import { describe, expect, test } from 'bun:test';
// @ts-expect-error - .mjs script exports runtime helpers without declarations.
import { validatePackageFiles } from '../../../scripts/package-smoke.mjs';

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
	'codebase-review-swarm',
	'design-docs',
	'swarm-pr-review',
	'swarm-pr-feedback',
	'issue-ingest',
	'plan',
	'critic-gate',
	'execute',
	'phase-wrap',
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

describe('package-smoke validatePackageFiles', () => {
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
