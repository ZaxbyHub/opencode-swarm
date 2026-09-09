import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { attemptMergeBackFromDirty } from '../../../src/worktree/merge';

const GIT_TIMEOUT_MS = 10_000;
const tempRoots: string[] = [];

function git(cwd: string, ...args: string[]): string {
	return execFileSync('git', args, {
		cwd,
		encoding: 'utf8',
		timeout: GIT_TIMEOUT_MS,
		maxBuffer: 1024 * 1024,
		stdio: ['ignore', 'pipe', 'pipe'],
	}).trim();
}

/** Raw (untrimmed) porcelain: the XY indicator's leading space is load-bearing. */
function porcelain(cwd: string): string {
	return execFileSync('git', ['status', '--porcelain'], {
		cwd,
		encoding: 'utf8',
		timeout: GIT_TIMEOUT_MS,
		maxBuffer: 1024 * 1024,
		stdio: ['ignore', 'pipe', 'pipe'],
	});
}

interface Fixture {
	root: string;
	lanePath: string;
	branch: string;
}

/** Primary repo + lane worktree; lane commits edit b.txt and add new.txt. */
function createFixture(name: string): Fixture {
	const root = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), `2508-squash-${name}-`)),
	);
	tempRoots.push(root);
	git(root, 'init', '--initial-branch=main');
	git(root, 'config', 'user.email', 'swarm-test@example.invalid');
	git(root, 'config', 'user.name', 'Swarm Test');
	fs.writeFileSync(path.join(root, 'b.txt'), 'base\n');
	git(root, 'add', 'b.txt');
	git(root, 'commit', '-m', 'base');

	const lanePath = `${root}-lane`;
	const branch = `swarm/lane/session/${name}`;
	git(root, 'worktree', 'add', '-b', branch, lanePath, 'main');
	fs.writeFileSync(path.join(lanePath, 'b.txt'), 'lane-b\n');
	fs.writeFileSync(path.join(lanePath, 'new.txt'), 'lane-new\n');
	git(lanePath, 'add', 'b.txt', 'new.txt');
	git(lanePath, 'commit', '-m', 'lane edits');
	return { root, lanePath, branch };
}

function cleanupFixtures(): void {
	for (const root of tempRoots.splice(0)) {
		try {
			fs.rmSync(`${root}-lane`, { recursive: true, force: true });
		} catch {
			/* best-effort */
		}
		try {
			git(root, 'worktree', 'prune');
		} catch {
			/* best-effort */
		}
		fs.rmSync(root, { recursive: true, force: true });
	}
}

describe('#2508 squash-merge-unstaged settlement landing', () => {
	afterEach(cleanupFixtures);

	test("default 'merge' dispatch lands unstaged: HEAD unchanged, lane bytes in working tree", async () => {
		const { root, lanePath, branch } = createFixture('default');
		const headBefore = git(root, 'rev-parse', 'HEAD');

		const result = await attemptMergeBackFromDirty(
			lanePath,
			branch,
			root,
			'merge',
		);

		expect(result.merged).toBe(true);
		if (!result.merged) return;
		// The result strategy reports the behavioral landing mode.
		expect(result.strategy).toBe('squash-unstaged');
		// No commit landed in the primary.
		expect(git(root, 'rev-parse', 'HEAD')).toBe(headBefore);
		const status = porcelain(root);
		// Modified file lands unstaged (worktree-modified, never staged-only).
		expect(status).toMatch(/^ {1}M b\.txt$/m);
		expect(status).not.toMatch(/^M {1}b\.txt$/m);
		// New file lands untracked, reviewable.
		expect(status).toMatch(/^\?\? new\.txt$/m);
		// Lane bytes present in the primary working tree (CRLF-tolerant).
		expect(
			fs.readFileSync(path.join(root, 'b.txt'), 'utf8').replace(/\r\n/g, '\n'),
		).toBe('lane-b\n');
	});

	test('commitLanding opt-out keeps the committed merge (Lean boundary)', async () => {
		const { root, lanePath, branch } = createFixture('committed');
		const headBefore = git(root, 'rev-parse', 'HEAD');

		const result = await attemptMergeBackFromDirty(
			lanePath,
			branch,
			root,
			'merge',
			{ commitLanding: true },
		);

		expect(result.merged).toBe(true);
		expect(result.strategy).toBe('merge');
		// Committed: HEAD advanced, tree clean.
		expect(git(root, 'rev-parse', 'HEAD')).not.toBe(headBefore);
		expect(git(root, 'status', '--porcelain')).toBe('');
	});

	test("'rebase' strategy still lands committed (unchanged)", async () => {
		const { root, lanePath, branch } = createFixture('rebase');
		const headBefore = git(root, 'rev-parse', 'HEAD');
		const result = await attemptMergeBackFromDirty(
			lanePath,
			branch,
			root,
			'rebase',
		);
		expect(result.merged).toBe(true);
		expect(git(root, 'rev-parse', 'HEAD')).not.toBe(headBefore);
	});

	test('user pre-staged unrelated entry survives the unstaged landing', async () => {
		const { root, lanePath, branch } = createFixture('staged');
		// User staged an unrelated NEW file BEFORE settlement.
		fs.writeFileSync(path.join(root, 'c.txt'), 'user-c\n');
		git(root, 'add', 'c.txt');

		await attemptMergeBackFromDirty(lanePath, branch, root, 'merge');

		const status = porcelain(root);
		// The user's staged entry is untouched: staged-new c.txt stays staged.
		expect(status).toMatch(/^A {2}c\.txt$/m);
		// The lane's modified file is unstaged.
		expect(status).toMatch(/^ {1}M b\.txt$/m);
	});

	test('rename lands both sides unstaged (no delete+untracked split)', async () => {
		const root = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), '2508-squash-rename-')),
		);
		tempRoots.push(root);
		git(root, 'init', '--initial-branch=main');
		git(root, 'config', 'user.email', 'swarm-test@example.invalid');
		git(root, 'config', 'user.name', 'Swarm Test');
		fs.writeFileSync(path.join(root, 'old.txt'), 'content\n');
		git(root, 'add', 'old.txt');
		git(root, 'commit', '-m', 'base');
		const lanePath = `${root}-lane`;
		const branch = 'swarm/lane/session/rename';
		git(root, 'worktree', 'add', '-b', branch, lanePath, 'main');
		fs.renameSync(
			path.join(lanePath, 'old.txt'),
			path.join(lanePath, 'renamed.txt'),
		);
		git(lanePath, 'add', '-A');
		git(lanePath, 'commit', '-m', 'rename');

		const result = await attemptMergeBackFromDirty(
			lanePath,
			branch,
			root,
			'merge',
		);
		expect(result.merged).toBe(true);
		const status = porcelain(root);
		// Both sides present: old.txt deleted (unstaged D) and renamed.txt
		// untracked — the targeted reset unstaged BOTH rename sides instead
		// of leaving a staged rename record.
		expect(status).toMatch(/^ {1}D old\.txt$/m);
		expect(status).toMatch(/^\?\? renamed\.txt$/m);
		expect(status).not.toMatch(/^R {1}/m);
	});

	test('lane branch survives as the recovery backup', async () => {
		const { root, lanePath, branch } = createFixture('branch');
		await attemptMergeBackFromDirty(lanePath, branch, root, 'merge');
		// The branch is retained: unstaged bytes have no commit in primary
		// history, so the branch ref is the only durable copy.
		const ref = git(root, 'rev-parse', '--verify', `refs/heads/${branch}`);
		expect(ref).toMatch(/^[0-9a-f]{40,64}$/);
	});
});
