/**
 * Issue #2236 F0a / BR-2 — `runGit` contains spawn failures, and
 * `postMergeCleanup` prunes before it deletes.
 *
 * Before the fix `runGit`'s `try` covered only the post-spawn awaiting; the
 * `bunSpawn` call itself sat outside it, so a synchronous spawn throw escaped
 * uncaught to the tool boundary (and bypassed the `finally`'s `proc.kill()`).
 * These tests pin both halves: nothing throws out of the wrapper, and the
 * kill-on-cleanup guarantee survives the restructuring that moved the spawn
 * inside the `try`.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { BunCompatSubprocess } from '../../../src/utils/bun-compat';
import {
	_internals,
	attemptMergeBackFromDirty,
	postMergeCleanup,
	pruneStaleWorktreeMetadata,
	SOURCE_WORKTREE_GONE_STAGE,
	SOURCE_WORKTREE_UNCERTAIN_STAGE,
} from '../../../src/worktree/merge';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const realBunSpawn = _internals.bunSpawn;
const roots: string[] = [];

function tempRoot(label: string): string {
	const dir = canonicalMkdtemp(`merge-spawn-${label}-`);
	roots.push(dir);
	return dir;
}

function mockProc(exitCode: number, onKill?: () => void): BunCompatSubprocess {
	return {
		exited: Promise.resolve(exitCode),
		exitCode,
		stdout: { text: () => Promise.resolve('') },
		stderr: { text: () => Promise.resolve('') },
		kill: () => onKill?.(),
	} as unknown as BunCompatSubprocess;
}

afterEach(() => {
	_internals.bunSpawn = realBunSpawn;
	for (const root of roots.splice(0)) {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

describe('runGit contains spawn failures (via postMergeCleanup)', () => {
	test('a deleted cwd returns a typed failure naming the path, and never throws', async () => {
		const root = tempRoot('deleted-cwd');
		const gone = path.join(root, 'gone');

		const result = await postMergeCleanup(gone, 'swarm-lane/s/lane-1');

		// The pre-#2236 behaviour was an uncaught synchronous throw whose raw
		// `ENOENT ... posix_spawn 'git'` message reached the user.
		expect('error' in result).toBe(true);
		const message = 'error' in result ? result.error : '';
		expect(message).toContain(gone);
		expect(message).toContain('working directory no longer exists');
		expect(message).not.toContain('posix_spawn');
		expect(message).not.toContain('uv_spawn');
	});

	test('a cwd that is a file is reported as a cwd problem, not a missing git', async () => {
		const root = tempRoot('file-cwd');
		const file = path.join(root, 'a-file');
		fs.writeFileSync(file, 'x');

		const result = await pruneStaleWorktreeMetadata(file);

		expect('error' in result).toBe(true);
		expect('error' in result ? result.error : '').toContain(
			'working directory no longer exists',
		);
	});

	test('a synchronous throw from the spawn seam is converted, not propagated', async () => {
		const root = tempRoot('sync-throw');
		_internals.bunSpawn = () => {
			throw new Error("ENOENT: no such file or directory, posix_spawn 'git'");
		};

		// Defense in depth behind the bunSpawn chokepoint: even if a future
		// spawn path throws again, runGit must still return a value.
		const result = await pruneStaleWorktreeMetadata(root);

		expect('error' in result).toBe(true);
		expect('error' in result ? result.error : '').toContain('could not start');
	});

	test('proc.kill() still runs after the spawn moved inside the try', async () => {
		const root = tempRoot('kill-guarantee');
		let kills = 0;
		_internals.bunSpawn = () => mockProc(0, () => kills++);

		await pruneStaleWorktreeMetadata(root);

		// One spawn, one best-effort kill. Declaring `proc` outside the `try` and
		// calling `proc?.kill()` is what preserves this; losing it would silently
		// regress the timeout-kill guarantee for every runGit caller.
		expect(kills).toBe(1);
	});

	test('a subprocess whose spawnError is set asynchronously is still caught', async () => {
		const root = tempRoot('async-spawn-error');
		const err = new Error('spawn git ENOENT') as NodeJS.ErrnoException;
		err.code = 'ENOENT';
		_internals.bunSpawn = () =>
			({
				exited: Promise.resolve(1),
				exitCode: null,
				spawnError: err,
				stdout: {
					text: () => Promise.reject(new Error('streams must not be read')),
				},
				stderr: {
					text: () => Promise.reject(new Error('streams must not be read')),
				},
				kill: () => {},
			}) as unknown as BunCompatSubprocess;

		const result = await pruneStaleWorktreeMetadata(root);

		// The Node path populates spawnError via the `error` event, i.e. after
		// the await. Reading the streams of a process that never existed must
		// never happen — the rejections above would surface if it did.
		expect('error' in result).toBe(true);
		expect('error' in result ? result.error : '').toContain('could not start');
	});
});

describe('postMergeCleanup ordering (BR-2)', () => {
	test('worktree prune runs BEFORE branch -D', async () => {
		const calls: string[][] = [];
		_internals.bunSpawn = (args: string[]) => {
			calls.push(args);
			return mockProc(0);
		};

		await postMergeCleanup(tempRoot('order'), 'swarm-lane/s/lane-1');

		const pruneIndex = calls.findIndex(
			(args) => args[1] === 'worktree' && args[2] === 'prune',
		);
		const deleteIndex = calls.findIndex(
			(args) => args[1] === 'branch' && args[2] === '-D',
		);
		expect(pruneIndex).toBeGreaterThanOrEqual(0);
		expect(deleteIndex).toBeGreaterThanOrEqual(0);
		// git refuses `branch -d/-D` while a registered worktree still claims the
		// branch — including one whose directory is already gone. Deleting first
		// leaves the branch alive and reproduces the #2236 deadlock under a
		// different message.
		expect(pruneIndex).toBeLessThan(deleteIndex);
	});

	test('real repo: the branch is deleted even when the worktree directory is already gone', async () => {
		const root = tempRoot('real-prune');
		const repo = path.join(root, 'repo');
		const lane = path.join(root, 'lane');
		fs.mkdirSync(repo);
		git(repo, ['init']);
		git(repo, ['config', 'user.email', 'tests@example.com']);
		git(repo, ['config', 'user.name', 'Tests']);
		fs.writeFileSync(path.join(repo, 'seed.txt'), 'seed\n');
		git(repo, ['add', '.']);
		git(repo, ['commit', '-m', 'seed']);
		git(repo, ['worktree', 'add', '-b', 'lane-1', lane]);
		// Destroy the directory but leave the registration stale — exactly the
		// state a torn-down lane worktree leaves behind.
		fs.rmSync(lane, { recursive: true, force: true });
		expect(branchExists(repo, 'lane-1')).toBe(true);

		const result = await postMergeCleanup(repo, 'lane-1');

		expect(result).toEqual({ cleaned: true });
		expect(branchExists(repo, 'lane-1')).toBe(false);
	});
});

function git(directory: string, args: string[]): void {
	const result = spawnSync('git', ['-C', directory, ...args], {
		cwd: directory,
		stdio: ['ignore', 'pipe', 'pipe'],
		encoding: 'utf8',
		timeout: 20_000,
		windowsHide: true,
	});
	if (result.error) throw result.error;
	if (result.status !== 0) throw new Error(result.stderr || result.stdout);
}

function branchExists(directory: string, branch: string): boolean {
	const result = spawnSync(
		'git',
		[
			'-C',
			directory,
			'show-ref',
			'--verify',
			'--quiet',
			`refs/heads/${branch}`,
		],
		{
			cwd: directory,
			stdio: ['ignore', 'ignore', 'ignore'],
			timeout: 20_000,
			windowsHide: true,
		},
	);
	if (result.error) throw result.error;
	return result.status === 0;
}

describe('source-worktree-gone mode fails closed on an uncertain branch answer', () => {
	test('a primary directory git cannot answer for yields the uncertain stage, never the gone stage', async () => {
		const root = tempRoot('uncertain');
		const notARepo = path.join(root, 'not-a-repo');
		fs.mkdirSync(notARepo);
		const goneWorktree = path.join(root, 'lane');

		const result = await attemptMergeBackFromDirty(
			goneWorktree,
			'swarm-lane/s/lane-1',
			notARepo,
			'merge',
		);

		// "Cannot tell whether the branch exists" must not be reported as
		// "nothing is recoverable" — that stage is what unlocks the WAL
		// self-heal, and healing on an uncertain answer can strand commits.
		expect(result).toMatchObject({
			failed: true,
			stage: SOURCE_WORKTREE_UNCERTAIN_STAGE,
		});
		expect('stage' in result ? result.stage : '').not.toBe(
			SOURCE_WORKTREE_GONE_STAGE,
		);
	});
});
