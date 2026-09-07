/**
 * Issue #2527 — `resolveWorktreeRepoOwnership` over real git fixtures.
 *
 * `owned === true && uncertain === false` is the ONLY answer that permits a
 * reclamation path to delete a worktree directory. Everything else — foreign
 * repository, plain directory, unreadable or unresolvable `.git` pointer —
 * must be fail-closed (not owned). win32 case-insensitive comparison is
 * exercised naturally on this host and pinned by an explicit case-variant
 * test guarded to win32.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { resolveWorktreeRepoOwnership } from '../../../src/config/lane-context';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

function git(cwd: string, args: string[]): string {
	return execFileSync('git', args, {
		cwd,
		encoding: 'utf-8',
		stdio: ['ignore', 'pipe', 'pipe'],
		timeout: 30_000,
	}) as string;
}

function initRepo(dir: string): void {
	mkdirSync(dir, { recursive: true });
	git(dir, ['init']);
	git(dir, ['config', 'user.email', 'swarm-test@example.local']);
	git(dir, ['config', 'user.name', 'Swarm Test']);
	writeFileSync(path.join(dir, 'README.md'), '# test\n');
	git(dir, ['add', '.']);
	git(dir, ['commit', '-m', 'initial commit']);
}

let root: string;
let repoA: string;

beforeEach(() => {
	root = canonicalMkdtemp('laneown-2527-');
	repoA = path.join(root, 'repoA');
	initRepo(repoA);
});

afterEach(() => {
	try {
		rmSync(root, { recursive: true, force: true });
	} catch {
		// Teardown is best-effort (Windows can briefly hold git file handles).
	}
});

describe('resolveWorktreeRepoOwnership (issue #2527)', () => {
	test('own linked worktree resolves owned with a resolved main worktree', () => {
		const lane = path.join(root, 'lane-of-a');
		mkdirSync(path.dirname(lane), { recursive: true });
		git(repoA, ['worktree', 'add', '-b', 'own-branch', lane]);

		const ownership = resolveWorktreeRepoOwnership(lane, repoA);

		expect(ownership.owned).toBe(true);
		expect(ownership.uncertain).toBe(false);
		expect(ownership.mainWorktree).toBeTruthy();
	}, 60_000);

	test("another repository's worktree is not owned (and not uncertain)", () => {
		const repoB = path.join(root, 'repoB');
		initRepo(repoB);
		const foreignLane = path.join(root, 'lane-of-b');
		mkdirSync(path.dirname(foreignLane), { recursive: true });
		git(repoB, ['worktree', 'add', '-b', 'foreign-branch', foreignLane]);

		const ownership = resolveWorktreeRepoOwnership(foreignLane, repoA);

		// A resolvable pointer to a DIFFERENT main worktree is a definitive
		// "not ours" — certain, not uncertain.
		expect(ownership.owned).toBe(false);
		expect(ownership.uncertain).toBe(false);
	}, 60_000);

	test('plain directory without .git is not owned and not uncertain', () => {
		const plain = path.join(root, 'plain-dir');
		mkdirSync(plain, { recursive: true });

		const ownership = resolveWorktreeRepoOwnership(plain, repoA);

		expect(ownership.owned).toBe(false);
		expect(ownership.uncertain).toBe(false);
	});

	test('.git file with no gitdir pointer line is not owned (fail-closed)', () => {
		const malformed = path.join(root, 'malformed-git-file');
		mkdirSync(malformed, { recursive: true });
		// A .git FILE (linked-worktree shape) whose content carries no
		// `gitdir:` pointer cannot identify an owner — never deletable.
		writeFileSync(path.join(malformed, '.git'), 'not a gitdir pointer\n');

		const ownership = resolveWorktreeRepoOwnership(malformed, repoA);

		expect(ownership.owned).toBe(false);
		expect(ownership.uncertain).toBe(false);
	});

	test('.git file pointing at an unresolvable administrative directory is uncertain', () => {
		const broken = path.join(root, 'broken-pointer');
		mkdirSync(broken, { recursive: true });
		// gitdir resolves, but the pointed-at admin dir does not exist, so
		// neither commondir nor the documented `.git/worktrees/<n>` shape
		// can establish a main worktree: the ownership answer is uncertain,
		// which is never deletable.
		const dangling = path.join(root, 'nonexistent', 'worktrees', 'x');
		writeFileSync(
			path.join(broken, '.git'),
			`gitdir: ${dangling.replaceAll('\\', '/')}\n`,
		);

		const ownership = resolveWorktreeRepoOwnership(broken, repoA);

		expect(ownership.owned).toBe(false);
		expect(ownership.uncertain).toBe(true);
	});
});

// The win32 case-variant test only makes sense where path comparison is
// case-insensitive; run it on this Windows host and skip elsewhere.
(process.platform === 'win32' ? describe : describe.skip)(
	'win32-only case-insensitivity',
	() => {
		test('drive-letter-cased project root still owns its worktree', () => {
			const lane = path.join(root, 'lane-case');
			mkdirSync(path.dirname(lane), { recursive: true });
			git(repoA, ['worktree', 'add', '-b', 'case-branch', lane]);

			const upperRoot = repoA.replace(
				/^([a-zA-Z]):/,
				(_m, d: string) => `${d.toUpperCase()}:`,
			);
			const ownership = resolveWorktreeRepoOwnership(lane, upperRoot);

			expect(ownership.owned).toBe(true);
			expect(ownership.uncertain).toBe(false);
		});
	},
);
