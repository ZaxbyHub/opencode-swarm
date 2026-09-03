import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	collectPathIdentityErrors,
	scanSourceForPathIdentity,
} from '../../../scripts/check-path-identity';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const fixtures = path.resolve(import.meta.dir, '../../fixtures/path-identity');

describe('check:path-identity AST predicate', () => {
	test('recognizes namespace path.resolve in a direct identity comparison', () => {
		const violations = scanSourceForPathIdentity(
			'x.ts',
			"import * as p from 'node:path';\nif (p.resolve(directory) === p.resolve(current)) return true;",
		);
		expect(violations.some((v) => v.kind === 'comparison')).toBe(true);
	});

	test('recognizes named and aliased resolve imports', () => {
		const violations = scanSourceForPathIdentity(
			'x.ts',
			"import { resolve as pathResolve } from 'node:path';\nreturn pathResolve(directory) !== pathResolve(recorded);",
		);
		expect(violations.filter((v) => v.kind === 'comparison')).toHaveLength(1);
	});

	test('recognizes the supported default path import', () => {
		const violations = scanSourceForPathIdentity(
			'x.ts',
			"import path from 'node:path';\nif (path.resolve(directory) === path.resolve(current)) return true;",
		);
		expect(violations.filter((v) => v.kind === 'comparison')).toHaveLength(1);
	});

	test('recognizes import-equals, destructured, and assigned resolve aliases', () => {
		const importEquals = scanSourceForPathIdentity(
			'x.ts',
			'import legacyPath = require("node:path");\nif (legacyPath.resolve(directory) === legacyPath.resolve(current)) return true;',
		);
		expect(importEquals.filter((v) => v.kind === 'comparison')).toHaveLength(1);

		const destructured = scanSourceForPathIdentity(
			'x.ts',
			'import * as path from "node:path";\nconst { resolve } = path;\nprojectCache.set(resolve(directory), true);',
		);
		expect(destructured.filter((v) => v.kind === 'project-key')).toHaveLength(
			1,
		);

		const assigned = scanSourceForPathIdentity(
			'x.ts',
			'import * as path from "node:path";\nconst pathResolve = path.resolve;\nif (pathResolve(directory) === pathResolve(current)) return true;',
		);
		expect(assigned.filter((v) => v.kind === 'comparison')).toHaveLength(1);
	});

	test('recognizes Windows path modules and path.win32.resolve', () => {
		const win32Module = scanSourceForPathIdentity(
			'x.ts',
			'import * as winPath from "node:path/win32";\nif (winPath.resolve(directory) === winPath.resolve(current)) return true;',
		);
		expect(win32Module.filter((v) => v.kind === 'comparison')).toHaveLength(1);

		const win32Property = scanSourceForPathIdentity(
			'x.ts',
			'import * as path from "node:path";\nif (path.win32.resolve(directory) === path.win32.resolve(current)) return true;',
		);
		expect(win32Property.filter((v) => v.kind === 'comparison')).toHaveLength(
			1,
		);

		const destructured = scanSourceForPathIdentity(
			'x.ts',
			'import * as path from "node:path";\nconst { resolve: winResolve } = path.win32;\nprojectCache.set(winResolve(directory), true);',
		);
		expect(destructured.filter((v) => v.kind === 'project-key')).toHaveLength(
			1,
		);
	});

	test('recognizes property-form roots inside path.resolve', () => {
		const direct = scanSourceForPathIdentity(
			'x.ts',
			"import * as path from 'node:path';\nfunction matches(ctx, other) { return path.resolve(ctx.directory) === path.resolve(other.directory); }",
		);
		expect(direct.filter((v) => v.kind === 'comparison')).toHaveLength(1);

		const intermediate = scanSourceForPathIdentity(
			'x.ts',
			"import * as path from 'node:path';\nfunction cache(ctx, projectCache) { const normalizedRoot = path.resolve(ctx.directory); projectCache.set(normalizedRoot, true); }",
		);
		expect(intermediate.filter((v) => v.kind === 'project-key')).toHaveLength(
			1,
		);
	});

	test('recognizes a tainted root compared with a persisted root property', () => {
		const violations = scanSourceForPathIdentity(
			'x.ts',
			"import * as path from 'node:path';\nfunction matches(directory, record) { const normalizedRoot = path.resolve(directory); return normalizedRoot === record.rootPath; }",
		);
		expect(violations.filter((v) => v.kind === 'comparison')).toHaveLength(1);
	});

	test('tracks an intermediate into Map, Set, and template keys', () => {
		const violations = scanSourceForPathIdentity(
			'x.ts',
			[
				"import * as path from 'node:path';",
				'function projectSessionKey(directory, cache, seen, session) {',
				'  const normalizedRoot = path.resolve(directory);',
				'  cache.set(normalizedRoot, 1);',
				'  seen.add(normalizedRoot);',
				'  return `${normalizedRoot}:${session}`;',
				'}',
			].join('\n'),
		);
		expect(violations.filter((v) => v.kind === 'project-key')).toHaveLength(3);
	});

	test('tracks neutral variable names and later assignments', () => {
		const neutral = scanSourceForPathIdentity(
			'x.ts',
			"import * as path from 'node:path';\nfunction check(directory, record, projectCache) { const value = path.resolve(directory); projectCache.set(value, true); return value === record.rootPath; }",
		);
		expect(neutral.filter((v) => v.kind === 'project-key')).toHaveLength(1);
		expect(neutral.filter((v) => v.kind === 'comparison')).toHaveLength(1);

		const assigned = scanSourceForPathIdentity(
			'x.ts',
			"import * as path from 'node:path';\nfunction check(directory, projectCache) { let value; value = path.resolve(directory); projectCache.set(value, true); }",
		);
		expect(assigned.filter((v) => v.kind === 'project-key')).toHaveLength(1);
	});

	test('recognizes worktreePath keys and resolve calls inside callbacks', () => {
		const direct = scanSourceForPathIdentity(
			'x.ts',
			'import * as path from "node:path";\nfunction protect(worktreePath, protectedWorktreePaths) { return protectedWorktreePaths.has(path.resolve(worktreePath)); }',
		);
		expect(direct.filter((v) => v.kind === 'project-key')).toHaveLength(1);

		const callback = scanSourceForPathIdentity(
			'x.ts',
			'import * as path from "node:path";\nfunction cacheWorktrees(values) { return new Set(values.map((worktreePath) => path.resolve(worktreePath))); }',
		);
		expect(callback.filter((v) => v.kind === 'project-key')).toHaveLength(1);
	});

	test('tracks resolve through normalize and case-fold identity helpers', () => {
		const violations = scanSourceForPathIdentity(
			'x.ts',
			'import * as path from "node:path";\nfunction worktreePathKey(worktreePath) { const normalized = path.normalize(path.resolve(worktreePath)); return normalized.toLowerCase(); }',
		);
		expect(violations.filter((v) => v.kind === 'project-return')).toHaveLength(
			1,
		);
	});

	test('tracks separate transforms, property carriers, assigned aliases, and ternaries', () => {
		const violations = scanSourceForPathIdentity(
			'x.ts',
			[
				'import * as path from "node:path";',
				'function cache(worktreePath, ctx, projectCache, condition) {',
				'  let a, b, c, r;',
				'  a = path.resolve(worktreePath);',
				'  b = path.normalize(a);',
				'  c = b.toLowerCase();',
				'  projectCache.set(c, true);',
				'  const holder = { value: path.resolve(ctx.directory) };',
				'  projectCache.set(holder.value, true);',
				'  r = path.resolve;',
				'  projectCache.set(r(ctx.directory), true);',
				'  return condition ? c : a.toUpperCase();',
				'}',
			].join('\n'),
		);
		expect(violations.filter((v) => v.kind === 'project-key')).toHaveLength(3);
		expect(violations.filter((v) => v.kind === 'project-return')).toHaveLength(
			1,
		);
	});

	test('restricts the lexical alias escape hatch to resource lifecycle owners', () => {
		const source =
			'import { lexicalRootAliasKey } from "./canonical-root";\nprojectCache.set(lexicalRootAliasKey(directory), true);';
		expect(
			scanSourceForPathIdentity('src/other-cache.ts', source).filter(
				(v) => v.kind === 'lexical-alias',
			),
		).toHaveLength(1);
		expect(
			scanSourceForPathIdentity('src/db/project-db.ts', source).filter(
				(v) => v.kind === 'lexical-alias',
			),
		).toHaveLength(0);
	});

	test('flags duplicate same-project-root helpers outside the canonical module', () => {
		const violations = scanSourceForPathIdentity(
			'x.ts',
			'function sameProjectRoot(directory, current) { return directory === current; }',
		);
		expect(violations).toMatchObject([{ kind: 'duplicate-helper' }]);
		expect(
			scanSourceForPathIdentity(
				'src/utils/canonical-root.ts',
				'function sameProjectRoot() {}',
			),
		).toEqual([]);
	});

	test('flags direct raw-directory keys, two-layer caches, and arrow helpers', () => {
		const violations = scanSourceForPathIdentity(
			'x.ts',
			[
				'function cacheProject(directory, context, projectCache, manifestRootCache, backendCache) {',
				'  projectCache.set(directory, true);',
				'  projectCache.set(context.directory, true);',
				'  const projectRoot = manifestRootCache.get(directory);',
				'  backendCache.set(projectRoot, true);',
				'}',
				'const sameWorkspaceRoot = (left, right) => left === right;',
			].join('\n'),
		);
		expect(violations.filter((v) => v.kind === 'project-key')).toHaveLength(4);
		expect(
			violations.filter((v) => v.kind === 'duplicate-helper'),
		).toHaveLength(1);
	});

	test('does not flag ordinary path construction or containment anchors', () => {
		const source = fs.readFileSync(path.join(fixtures, 'negative.ts'), 'utf8');
		expect(
			scanSourceForPathIdentity(
				'tests/fixtures/path-identity/negative.ts',
				source,
			),
		).toEqual([]);
	});

	test('the fixture positive set reports every diagnostic at its exact source line', () => {
		const source = fs.readFileSync(path.join(fixtures, 'positive.ts'), 'utf8');
		const violations = scanSourceForPathIdentity(
			'tests/fixtures/path-identity/positive.ts',
			source,
		);
		expect(
			violations.map(({ file, kind, line, snippet }) => ({
				file,
				kind,
				line,
				snippet,
			})),
		).toEqual([
			{
				file: 'tests/fixtures/path-identity/positive.ts',
				kind: 'comparison',
				line: 5,
				snippet: 'return path.resolve(directory) === pathResolve(current);',
			},
			{
				file: 'tests/fixtures/path-identity/positive.ts',
				kind: 'project-key',
				line: 15,
				snippet: 'cache.set(normalizedRoot, true);',
			},
			{
				file: 'tests/fixtures/path-identity/positive.ts',
				kind: 'project-key',
				line: 16,
				snippet: 'seen.add(normalizedRoot);',
			},
			{
				file: 'tests/fixtures/path-identity/positive.ts',
				kind: 'project-key',
				line: 17,
				snippet: 'return `${normalizedRoot}:${session}`;',
			},
			{
				file: 'tests/fixtures/path-identity/positive.ts',
				kind: 'comparison',
				line: 21,
				snippet: 'return path.resolve(directory) === path.resolve(current);',
			},
			{
				file: 'tests/fixtures/path-identity/positive.ts',
				kind: 'comparison',
				line: 25,
				snippet:
					'return defaultPath.resolve(directory) === defaultPath.resolve(current);',
			},
			{
				file: 'tests/fixtures/path-identity/positive.ts',
				kind: 'comparison',
				line: 33,
				snippet: 'return normalizedRoot === record.rootPath;',
			},
			{
				file: 'tests/fixtures/path-identity/positive.ts',
				kind: 'project-key',
				line: 40,
				snippet: 'projectCache.set(directory, true);',
			},
			{
				file: 'tests/fixtures/path-identity/positive.ts',
				kind: 'project-key',
				line: 47,
				snippet: 'projectCache.set(ctx.directory, true);',
			},
			{
				file: 'tests/fixtures/path-identity/positive.ts',
				kind: 'comparison',
				line: 54,
				snippet:
					'return path.resolve(ctx.directory) === path.resolve(other.directory);',
			},
			{
				file: 'tests/fixtures/path-identity/positive.ts',
				kind: 'project-key',
				line: 62,
				snippet: 'projectCache.set(normalizedRoot, true);',
			},
			{
				file: 'tests/fixtures/path-identity/positive.ts',
				kind: 'project-key',
				line: 71,
				snippet: 'projectCache.set(value, true);',
			},
			{
				file: 'tests/fixtures/path-identity/positive.ts',
				kind: 'comparison',
				line: 72,
				snippet: 'return value === record.rootPath;',
			},
			{
				file: 'tests/fixtures/path-identity/positive.ts',
				kind: 'project-key',
				line: 81,
				snippet: 'projectCache.set(value, true);',
			},
			{
				file: 'tests/fixtures/path-identity/positive.ts',
				kind: 'project-key',
				line: 89,
				snippet: 'const projectRoot = manifestRootCache.get(directory);',
			},
			{
				file: 'tests/fixtures/path-identity/positive.ts',
				kind: 'project-key',
				line: 90,
				snippet: 'if (projectRoot) backendCache.set(projectRoot, true);',
			},
			{
				file: 'tests/fixtures/path-identity/positive.ts',
				kind: 'duplicate-helper',
				line: 93,
				snippet:
					'export const sameWorkspaceRoot = (left: string, right: string): boolean =>',
			},
			{
				file: 'tests/fixtures/path-identity/positive.ts',
				kind: 'project-key',
				line: 100,
				snippet:
					'return protectedWorktreePaths.has(path.resolve(worktreePath));',
			},
			{
				file: 'tests/fixtures/path-identity/positive.ts',
				kind: 'project-key',
				line: 104,
				snippet:
					'return new Set(values.map((worktreePath) => path.resolve(worktreePath)));',
			},
			{
				file: 'tests/fixtures/path-identity/positive.ts',
				kind: 'project-return',
				line: 109,
				snippet: 'return normalized.toLowerCase();',
			},
			{
				file: 'tests/fixtures/path-identity/positive.ts',
				kind: 'project-key',
				line: 123,
				snippet: 'projectCache.set(folded, true);',
			},
			{
				file: 'tests/fixtures/path-identity/positive.ts',
				kind: 'project-key',
				line: 125,
				snippet: 'projectCache.set(holder.value, true);',
			},
			{
				file: 'tests/fixtures/path-identity/positive.ts',
				kind: 'project-key',
				line: 129,
				snippet: 'projectCache.set(assignedResolve(ctx.directory), true);',
			},
			{
				file: 'tests/fixtures/path-identity/positive.ts',
				kind: 'project-return',
				line: 137,
				snippet:
					'return condition ? resolved.toLowerCase() : resolved.toUpperCase();',
			},
		]);
	});

	test('collector honors an injectable root and scans only that root production files', () => {
		const root = canonicalMkdtemp('path-identity-collector-');
		const sourceDir = path.join(root, 'src');
		fs.mkdirSync(sourceDir, { recursive: true });
		fs.writeFileSync(
			path.join(sourceDir, 'identity.ts'),
			"import * as path from 'node:path';\nfunction cache(directory, projectCache) { projectCache.set(path.resolve(directory), true); }\n",
		);
		fs.writeFileSync(
			path.join(sourceDir, 'ignored.test.ts'),
			'projectCache.set(directory, true);\n',
		);
		try {
			const result = collectPathIdentityErrors(root);
			expect(result.scannedFiles).toBe(1);
			expect(result.errors).toEqual([
				'src/identity.ts:2: raw path.resolve result used as a project Map/Set key. Line: function cache(directory, projectCache) { projectCache.set(path.resolve(directory), true); }',
			]);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
