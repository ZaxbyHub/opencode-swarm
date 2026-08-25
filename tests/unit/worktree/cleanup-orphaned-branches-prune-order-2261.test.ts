/**
 * Regression test for the #2236 deadlock recurring at a third site (found
 * during review of PR #2261): `cleanupOrphanedBranches` ran `git branch
 * -d/-D` BEFORE `git worktree prune`, inverted from the fixed pattern at
 * `postMergeCleanup` (src/worktree/merge.ts:598-611) and
 * `handleSourceWorktreeGone`.
 *
 * git refuses `branch -d/-D` for a branch that a *registered* worktree still
 * claims — including a worktree whose directory has already been deleted —
 * with `error: cannot delete branch 'X' used by worktree at ...`. Deleting
 * before pruning leaves the branch alive, which reproduces the #2236
 * deadlock under a different message.
 *
 * RED before the fix: the orphan branch survives cleanup because `git
 * branch -D` fails while the stale worktree registration still claims it.
 * GREEN after the fix: pruning runs first, so the delete succeeds.
 */

import { afterEach, describe, expect, test } from 'bun:test';

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { BunCompatSubprocess } from '../../../src/utils/bun-compat';
import {
	_internals,
	cleanupOrphanedBranches,
} from '../../../src/worktree/merge';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

/**
 * Fixture git runs go through `Bun.spawnSync`, NOT
 * `node:child_process.spawnSync`.
 *
 * Nine test files in this repo install a module mock over node:child_process,
 * which bun registers PROCESS-WIDE and does not undo on `mock.restore()`. A
 * node-backed helper here would bind to whichever mock a co-resident file
 * installed, so this test's REPO SETUP would silently no-op — leaving an empty
 * repository and an assertion failing with `Received: []`, which names nothing
 * about the real cause.
 *
 * Not hypothetical: observed co-running this file with
 * tests/unit/git/branch.test.ts.
 *
 * NOTE ON CI: no CI job would have caught it. Both the `unit` job and the
 * merge-queue `coverage` gate run ONE FILE PER PROCESS (the coverage gate via
 * the per-file `bun test --isolate --coverage` loop in
 * `scripts/ci/run-coverage-gate.sh`; the unit job via its own per-file wrapper
 * `scripts/ci/run-test-with-timeout.ts`; per issue #1712). What breaks is a
 * plain local `bun test a.test.ts b.test.ts`. `Bun.spawnSync` is unaffected by
 * a node-module mock, so the fixture is honest under every runner.
 *
 * The code under test is unaffected either way — it reaches git via `bunSpawn`.
 */
function spawnSync(
	command: string,
	args: string[],
	options: {
		cwd: string;
		timeout?: number;
		stdio?: unknown;
		encoding?: string;
		windowsHide?: boolean;
	},
): { error?: Error; status: number | null; stdout: string; stderr: string } {
	const result = Bun.spawnSync([command, ...args], {
		cwd: options.cwd,
		stdin: 'ignore',
		stdout: 'pipe',
		stderr: 'pipe',
		timeout: options.timeout,
	});
	return {
		status: result.exitCode,
		stdout: result.stdout.toString(),
		stderr: result.stderr.toString(),
	};
}

const realBunSpawn = _internals.bunSpawn;
const roots: string[] = [];

function tempRoot(label: string): string {
	const dir = canonicalMkdtemp(`orphan-prune-order-${label}-`);
	roots.push(dir);
	return dir;
}

function mockProc(exitCode: number, stdout = ''): BunCompatSubprocess {
	return {
		exited: Promise.resolve(exitCode),
		exitCode,
		stdout: { text: () => Promise.resolve(stdout) },
		stderr: { text: () => Promise.resolve('') },
		kill: () => {},
	} as unknown as BunCompatSubprocess;
}

afterEach(() => {
	_internals.bunSpawn = realBunSpawn;
	for (const root of roots.splice(0)) {
		fs.rmSync(root, { recursive: true, force: true });
	}
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

describe('cleanupOrphanedBranches ordering (#2236 recurrence, review of #2261)', () => {
	test('worktree prune runs BEFORE branch -D', async () => {
		const calls: string[][] = [];
		// `listLaneBranches` must return a lane branch, or the delete loop never
		// runs and the ordering assertion below has nothing to compare. An
		// earlier version of this test mocked an EMPTY listing and guarded the
		// comparison with `if (deleteIndex >= 0)`, so it passed under BOTH
		// orderings — it asserted its own setup, not the fix.
		_internals.bunSpawn = (args: string[]) => {
			calls.push(args);
			if (args[1] === 'branch' && args[2] === '--format=%(refname:short)') {
				return mockProc(0, 'main\nswarm-lane/s1/lane-1\n');
			}
			return mockProc(0);
		};

		await cleanupOrphanedBranches(tempRoot('order'), []);

		const pruneIndex = calls.findIndex(
			(args) => args[1] === 'worktree' && args[2] === 'prune',
		);
		const deleteIndex = calls.findIndex(
			(args) => args[1] === 'branch' && (args[2] === '-D' || args[2] === '-d'),
		);
		// Both must be UNCONDITIONALLY present: a missing delete call would mean
		// the listing mock stopped matching and the ordering went unchecked.
		expect(pruneIndex).toBeGreaterThanOrEqual(0);
		expect(deleteIndex).toBeGreaterThanOrEqual(0);
		expect(pruneIndex).toBeLessThan(deleteIndex);
	});

	test('real repo: an orphaned lane branch is deleted even when its worktree directory is already gone', async () => {
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
		git(repo, ['worktree', 'add', '-b', 'swarm-lane/s1/lane-1', lane]);
		// Destroy the directory but leave the registration stale — exactly the
		// state a torn-down lane worktree leaves behind.
		fs.rmSync(lane, { recursive: true, force: true });
		expect(branchExists(repo, 'swarm-lane/s1/lane-1')).toBe(true);

		const result = await cleanupOrphanedBranches(repo, []);

		expect(result.removed).toContain('swarm-lane/s1/lane-1');
		expect(result.errors).toEqual([]);
		expect(branchExists(repo, 'swarm-lane/s1/lane-1')).toBe(false);
	});
});
