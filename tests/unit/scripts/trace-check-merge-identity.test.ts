import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { bashCommand } from '../../helpers/bash';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

// `trace-check.sh merge-identity` proves that the MERGED change is the REVIEWED
// change by comparing stable patch-ids. A squash has ONE parent and a merge
// commit has TWO, and both are legitimate shapes for that guarantee: a merge
// commit's diff against its FIRST parent is exactly the change that was
// merged. The one-parent arm keeps its previous behaviour exactly.

const SCRIPT = path.resolve(
	process.cwd(),
	'.opencode/skills/issue-tracer/scripts/trace-check.sh',
);

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0))
		fs.rmSync(root, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
	const p = Bun.spawnSync({
		cmd: ['git', ...args],
		cwd,
		stdin: 'ignore',
		stdout: 'pipe',
		stderr: 'pipe',
		timeout: 50_000,
	});
	if (p.exitCode !== 0)
		throw new Error(`git ${args.join(' ')} failed: ${p.stderr.toString()}`);
	return p.stdout.toString().trim();
}

function write(root: string, rel: string, body: string): void {
	fs.writeFileSync(path.join(root, rel), body);
}

function identity(
	cwd: string,
	base: string,
	head: string,
	squash: string,
): { code: number; out: string; err: string } {
	const p = Bun.spawnSync({
		cmd: bashCommand(SCRIPT, 'merge-identity', base, head, squash),
		cwd,
		env: process.env,
		stdin: 'ignore',
		stdout: 'pipe',
		stderr: 'pipe',
		timeout: 50_000,
	});
	return {
		code: p.exitCode ?? 1,
		out: p.stdout.toString(),
		err: p.stderr.toString(),
	};
}

/**
 * A repository with:
 *   base      the initial commit
 *   feature   a branch from base adding b.txt
 *   mainHead  main adding c.txt, then merged with --no-ff so `merge` has two
 *             parents (mainHead and feature)
 */
function repo() {
	const root = canonicalMkdtemp('trace-check-merge-identity-');
	roots.push(root);
	git(root, 'init', '-q', '-b', 'main');
	git(root, 'config', 'user.email', 'trace@example.invalid');
	git(root, 'config', 'user.name', 'Trace');
	write(root, 'a.txt', 'base\n');
	git(root, 'add', '-A');
	git(root, 'commit', '-q', '-m', 'base');
	const base = git(root, 'rev-parse', 'HEAD');

	git(root, 'checkout', '-q', '-b', 'feature');
	write(root, 'b.txt', 'feature\n');
	git(root, 'add', '-A');
	git(root, 'commit', '-q', '-m', 'feature');
	const feature = git(root, 'rev-parse', 'HEAD');

	git(root, 'checkout', '-q', 'main');
	write(root, 'c.txt', 'main\n');
	git(root, 'add', '-A');
	git(root, 'commit', '-q', '-m', 'main');
	const mainHead = git(root, 'rev-parse', 'HEAD');

	git(root, 'merge', '-q', '--no-ff', '-m', 'merge feature', 'feature');
	const merge = git(root, 'rev-parse', 'HEAD');

	return { root, base, feature, mainHead, merge };
}

describe('trace-check.sh merge-identity', () => {
	test('accepts a two-parent merge whose merged change is the reviewed change', () => {
		const r = repo();
		const result = identity(r.root, r.base, r.feature, r.merge);
		expect(result.code).toBe(0);
		expect(result.out).toContain('merge-identity-v1');
		expect(result.out).toContain(`squash-parent=${r.mainHead}`);
		expect(result.out).toContain(`merge-identity-second-parent=${r.feature}`);
	}, 60_000);

	test('refuses a two-parent merge whose merged change differs from the reviewed change', () => {
		const r = repo();
		git(r.root, 'checkout', '-q', '-b', 'other', r.base);
		write(r.root, 'd.txt', 'other\n');
		git(r.root, 'add', '-A');
		git(r.root, 'commit', '-q', '-m', 'other');
		const other = git(r.root, 'rev-parse', 'HEAD');
		const result = identity(r.root, r.base, other, r.merge);
		expect(result.code).not.toBe(0);
		expect(result.err).toContain('stable patch IDs differ or are empty');
	}, 60_000);

	test('refuses when the base is not an ancestor of the reviewed head', () => {
		const r = repo();
		const result = identity(r.root, r.mainHead, r.feature, r.merge);
		expect(result.code).not.toBe(0);
		expect(result.out).not.toContain('merge-identity-v1');
	}, 60_000);

	test('refuses when the base is not an ancestor of the first parent', () => {
		const r = repo();
		// `feature` is an ancestor of the merge's second parent but not of its
		// first parent (mainHead).
		const result = identity(r.root, r.feature, r.feature, r.merge);
		expect(result.code).not.toBe(0);
		expect(result.out).not.toContain('merge-identity-v1');
	}, 60_000);

	test('refuses a commit with more than two parents', () => {
		const r = repo();
		const tree = git(r.root, 'rev-parse', `${r.feature}^{tree}`);
		const octo = git(
			r.root,
			'commit-tree',
			tree,
			'-p',
			r.base,
			'-p',
			r.feature,
			'-p',
			r.mainHead,
			'-m',
			'three parents',
		);
		const result = identity(r.root, r.base, r.feature, octo);
		expect(result.code).not.toBe(0);
		expect(result.err).toContain('expected one or two parents');
	}, 60_000);

	test('a one-parent squash that carries the reviewed change is still accepted', () => {
		const r = repo();
		const tree = git(r.root, 'rev-parse', `${r.feature}^{tree}`);
		const squash = git(
			r.root,
			'commit-tree',
			tree,
			'-p',
			r.base,
			'-m',
			'squash',
		);
		const result = identity(r.root, r.base, r.feature, squash);
		expect(result.code).toBe(0);
		expect(result.out).toContain('merge-identity-v1');
		expect(result.out).not.toContain('merge-identity-second-parent=');
	}, 60_000);

	test('a one-parent squash whose change differs is still refused', () => {
		const r = repo();
		const tree = git(r.root, 'rev-parse', `${r.mainHead}^{tree}`);
		const squash = git(
			r.root,
			'commit-tree',
			tree,
			'-p',
			r.base,
			'-m',
			'other squash',
		);
		const result = identity(r.root, r.base, r.feature, squash);
		expect(result.code).not.toBe(0);
		expect(result.err).toContain('stable patch IDs differ or are empty');
	}, 60_000);
});
