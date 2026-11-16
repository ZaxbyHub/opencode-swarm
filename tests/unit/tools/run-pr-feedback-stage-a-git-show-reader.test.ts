import { afterEach, describe, expect, test } from 'bun:test';
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { readGitTextAtRevision } from '../../../src/background/workspace-snapshot.js';
import { _internals } from '../../../src/tools/run-pr-feedback-stage-a.js';
import { canonicalMkdtemp, removeTreeWithRetry } from '../../helpers/tmpdir.js';

/**
 * UNMOCKED reader-contract pins for the trusted base-identical script path
 * (review round on the subdirectory fix): every other trusted-scripts suite
 * stubs `_internals.readGitTextAtRevision`, so a caller/callee contract
 * mismatch (the reader's path guard rejecting what the caller now sends)
 * would ship green. These tests exercise the REAL git-show reader and the
 * REAL merge-base resolution against a real repository fixture.
 */

const createdDirs: string[] = [];

afterEach(() => {
	while (createdDirs.length > 0) {
		const dir = createdDirs.pop();
		if (dir) removeTreeWithRetry(dir);
	}
});

const git = (args: string, cwd: string): string =>
	execSync(`git ${args}`, { cwd, encoding: 'utf8', stdio: 'pipe' });

const initRepoWithManifest = (prefix: string): { dir: string; sha: string } => {
	const dir = canonicalMkdtemp(prefix);
	createdDirs.push(dir);
	git('init -b main', dir);
	git('config user.name "Test"', dir);
	git('config user.email "test@example.com"', dir);
	const manifest = `${JSON.stringify(
		{ scripts: { build: 'bun run clean && bun run build:ts' } },
		null,
		'\t',
	)}\n`;
	fs.writeFileSync(path.join(dir, 'package.json'), manifest);
	git('add package.json', dir);
	git('commit -m "manifest"', dir);
	const sha = git('rev-parse HEAD', dir).trim();
	return { dir, sha };
};

describe('run-pr-feedback-stage-a real git-show reader contract', () => {
	test('the reader admits ./-prefixed and bare paths and rejects traversal', () => {
		const { dir, sha } = initRepoWithManifest('stage-a-reader-root-');
		const content = readGitTextAtRevision(dir, sha, './package.json');
		expect(content).not.toBeNull();
		expect(JSON.parse(content as string).scripts.build).toContain('&&');
		// The bare form still resolves (toplevel-relative, identical at the
		// repository root).
		expect(readGitTextAtRevision(dir, sha, 'package.json')).toBe(content);
		// Traversal and unsafe shapes stay rejected.
		expect(readGitTextAtRevision(dir, sha, '../escape.json')).toBeNull();
		expect(readGitTextAtRevision(dir, sha, './nope/missing.json')).toBeNull();
		expect(
			readGitTextAtRevision(dir, 'not-a-revision', './package.json'),
		).toBeNull();
	});

	test('from a subdirectory cwd the ./ form resolves the subdirectory file', () => {
		const { dir } = initRepoWithManifest('stage-a-reader-sub-');
		fs.mkdirSync(path.join(dir, 'services', 'api'), { recursive: true });
		const nested = `${JSON.stringify(
			{ scripts: { build: 'echo nested-build' } },
			null,
			'\t',
		)}\n`;
		fs.writeFileSync(path.join(dir, 'services', 'api', 'package.json'), nested);
		git('add services/api/package.json', dir);
		git('commit -m "nested manifest"', dir);
		const sha = git('rev-parse HEAD', dir).trim();
		const sub = path.join(dir, 'services', 'api');
		// cwd-relative from the subdirectory: the nested manifest.
		expect(readGitTextAtRevision(sub, sha, './package.json')).toBe(nested);
		// The bare form from the subdirectory resolves the TOPLEVEL manifest —
		// exactly the confusion the ./ prefix exists to avoid.
		expect(readGitTextAtRevision(sub, sha, 'package.json')).not.toBe(nested);
	});

	test('discovery trusts a base-identical compound script through the real reader and real merge base', () => {
		const repo = canonicalMkdtemp('stage-a-reader-e2e-');
		createdDirs.push(repo);
		git('init -b main', repo);
		git('config user.name "Test"', repo);
		git('config user.email "test@example.com"', repo);
		const manifest = `${JSON.stringify(
			{ scripts: { build: 'bun run clean && bun run build:ts' } },
			null,
			'\t',
		)}\n`;
		fs.writeFileSync(path.join(repo, 'package.json'), manifest);
		git('add package.json', repo);
		git('commit -m "base"', repo);
		const baseSha = git('rev-parse HEAD', repo).trim();
		// Advance a FEATURE branch (main stays at the base commit) with a
		// commit that does not touch the manifest, so the merge base of main
		// and HEAD is the base commit and the working-tree manifest text is
		// byte-identical to it.
		git('switch -c feat', repo);
		fs.writeFileSync(path.join(repo, 'README.md'), 'readme\n');
		git('add README.md', repo);
		git('commit -m "readme"', repo);
		const headSha = git('rev-parse HEAD', repo).trim();
		const mergeBase = _internals.resolveExactMergeBase(repo, 'main', headSha);
		expect(mergeBase?.toLowerCase()).toBe(baseSha);

		const obligations = _internals.discoverApplicableStageAObligations(repo, {
			baseRef: 'main',
			baseSha: mergeBase as string,
		});
		expect([...obligations]).toEqual([
			{
				id: 'build:.:package.json#build',
				category: 'build',
				workingDirectory: '.',
				source: 'package.json#build',
			},
		]);
	});

	test('the reader admits dot-initial segments (contract files) at root and depth', () => {
		const { dir } = initRepoWithManifest('stage-a-reader-contract-');
		fs.mkdirSync(path.join(dir, 'services', 'api'), { recursive: true });
		const rootContract = '{"version":1,"validators":[]}\n';
		fs.writeFileSync(path.join(dir, '.pr-validation.json'), rootContract);
		const apiContract = '{"version":1,"validators":[{"id":"api"}]}\n';
		fs.writeFileSync(
			path.join(dir, 'services', 'api', '.pr-validation.json'),
			apiContract,
		);
		git('add .pr-validation.json services/api/.pr-validation.json', dir);
		git('commit -m "contracts"', dir);
		const sha = git('rev-parse HEAD', dir).trim();
		const sub = path.join(dir, 'services', 'api');
		// The Stage A contract call site always sends ./<path> with a
		// dot-initial basename — the guard must admit it at the root and at
		// depth, and the .github/ dot-initial middle segment too.
		expect(readGitTextAtRevision(dir, sha, './.pr-validation.json')).toBe(
			rootContract,
		);
		expect(readGitTextAtRevision(sub, sha, './.pr-validation.json')).toBe(
			apiContract,
		);
		expect(
			readGitTextAtRevision(dir, sha, './services/api/.pr-validation.json'),
		).toBe(apiContract);
		expect(
			readGitTextAtRevision(dir, sha, './.github/workflows/ci.yml'),
		).toBeNull();
		// Traversal still rejected in every position.
		expect(readGitTextAtRevision(dir, sha, 'a/../../b')).toBeNull();
		expect(readGitTextAtRevision(dir, sha, './..hidden/x')).toBeNull();
	});

	test('discovery trusts a base-identical contract validator through the real reader', () => {
		const repo = canonicalMkdtemp('stage-a-reader-contract-e2e-');
		createdDirs.push(repo);
		git('init -b main', repo);
		git('config user.name "Test"', repo);
		git('config user.email "test@example.com"', repo);
		const manifest = `${JSON.stringify(
			{
				scripts: {
					build: 'bun run clean && bun run build:ts',
					'lint:contract': 'node ./validate.mjs',
				},
			},
			null,
			'\t',
		)}\n`;
		fs.writeFileSync(path.join(repo, 'package.json'), manifest);
		const contract = `${JSON.stringify(
			{
				version: 1,
				validators: [
					{
						id: 'build-validator',
						category: 'build',
						working_directory: '.',
						command: ['node', './validate.mjs'],
					},
				],
			},
			null,
			'\t',
		)}\n`;
		fs.writeFileSync(path.join(repo, '.pr-validation.json'), contract);
		git('add package.json .pr-validation.json', repo);
		git('commit -m "base with contract"', repo);
		const baseSha = git('rev-parse HEAD', repo).trim();
		git('switch -c feat', repo);
		fs.writeFileSync(path.join(repo, 'README.md'), 'readme\n');
		git('add README.md', repo);
		git('commit -m "readme"', repo);
		const headSha = git('rev-parse HEAD', repo).trim();
		const mergeBase = _internals.resolveExactMergeBase(repo, 'main', headSha);
		expect(mergeBase?.toLowerCase()).toBe(baseSha);
		// The build script is compound and its name does not pass the
		// plausibility screen, so the ONLY path to the obligation is the
		// .pr-validation.json contract trusted through the REAL reader at the
		// real merge base.
		const obligations = _internals.discoverApplicableStageAObligations(repo, {
			baseRef: 'main',
			baseSha: mergeBase as string,
		});
		expect([...obligations]).toContainEqual({
			id: 'build:.:.pr-validation.json#build-validator',
			category: 'build',
			workingDirectory: '.',
			source: '.pr-validation.json#build-validator',
		});
	});
});
