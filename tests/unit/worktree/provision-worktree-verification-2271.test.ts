/**
 * Issue #2271 bug 1 — post-provision worktree verification.
 *
 * `git worktree add` exiting 0 does not prove the lane is a registered,
 * usable worktree: a concurrent prune or a partial removal from a sibling
 * dispatch can leave a plain directory with no `.git` link. A coder session
 * created in such a lane writes files git can never attribute and settlement
 * records dispatch_no_mutation. provisionWorktree must verify the lane before
 * returning success and return WORKTREE_VERIFICATION_FAILED otherwise.
 *
 * Uses real git repos; the failure path is injected through the file-scoped
 * `_internals.bunSpawn` seam (no mock.module — Bun shared-process isolation).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { bunSpawn } from '../../../src/utils/bun-compat';
import {
	provisionWorktree,
	_internals as worktreeInternals,
} from '../../../src/worktree/core';

async function runGit(
	args: string[],
	cwd: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	const proc = bunSpawn(['git', ...args], {
		cwd,
		stdin: 'ignore',
		stdout: 'pipe',
		stderr: 'pipe',
	});
	const exitCode = await proc.exited;
	const stdout = await proc.stdout.text();
	const stderr = await proc.stderr.text();
	return { exitCode, stdout, stderr };
}

async function initGitRepo(tmpDir: string): Promise<string> {
	await runGit(['init', '-b', 'main'], tmpDir);
	await runGit(['config', 'user.email', 'test@test.com'], tmpDir);
	await runGit(['config', 'user.name', 'Test'], tmpDir);
	await runGit(['commit', '--allow-empty', '-m', 'init'], tmpDir);
	return tmpDir;
}

function tmpDir(): string {
	return path.join(
		fs.realpathSync(os.tmpdir()),
		'pw-verify-2271-' + Math.random().toString(36).slice(2),
	);
}

describe('issue #2271 bug 1 — provisionWorktree lane verification', () => {
	let origBunSpawn: typeof worktreeInternals.bunSpawn;
	const created: string[] = [];

	// Lanes live under <tmp>/.swarm-worktrees/<sessionId>/<taskId> — a fixed
	// session id would collide with a previous run's lane base on this machine
	// ("branch already exists"), so every run uses a fresh session id.
	function sessionId(): string {
		return `ses_p${Math.random().toString(36).slice(2, 12)}`;
	}

	beforeEach(() => {
		origBunSpawn = worktreeInternals.bunSpawn;
	});

	afterEach(() => {
		worktreeInternals.bunSpawn = origBunSpawn;
		for (const dir of created) {
			fs.rmSync(dir, { recursive: true, force: true });
		}
		created.length = 0;
	});

	test('healthy provisioning returns a lane with a .git link (verification passes)', async () => {
		const repoDir = tmpDir();
		created.push(repoDir);
		fs.mkdirSync(repoDir, { recursive: true });
		await initGitRepo(repoDir);

		const result = await provisionWorktree(repoDir, '1.1', sessionId(), {
			purpose: 'lane',
		});
		if ('error' in result) throw new Error(result.error);
		expect(fs.existsSync(path.join(result.worktreePath, '.git'))).toBe(true);
	});

	test('a lane left without a .git link after add is rejected with WORKTREE_VERIFICATION_FAILED', async () => {
		const repoDir = tmpDir();
		created.push(repoDir);
		fs.mkdirSync(repoDir, { recursive: true });
		await initGitRepo(repoDir);

		// Simulate the reported race: let the REAL `git worktree add` run and
		// succeed, then delete the lane's .git link before provisionWorktree
		// proceeds to its verification probes — exactly the "lane directory
		// with scaffolding but no .git" state from the issue.
		worktreeInternals.bunSpawn = ((
			args: string[],
			opts: Parameters<typeof bunSpawn>[1],
		) => {
			const proc = origBunSpawn(args, opts);
			if (
				args[0] === 'git' &&
				args[1] === 'worktree' &&
				args[2] === 'add' &&
				typeof args[5] === 'string'
			) {
				const lanePath = args[5];
				void proc.exited.then(() => {
					try {
						fs.rmSync(path.join(lanePath, '.git'), { force: true });
					} catch {
						/* best-effort sabotage */
					}
				});
			}
			return proc;
		}) as typeof worktreeInternals.bunSpawn;

		const result = await provisionWorktree(repoDir, '2.1', sessionId(), {
			purpose: 'lane',
		});
		if (!('error' in result)) {
			throw new Error('expected provisioning to fail verification');
		}
		expect(result.error).toContain('WORKTREE_VERIFICATION_FAILED');
		expect(result.error).toContain('git rev-parse --git-dir failed');
		expect(result.error).toContain('retry the dispatch');
	});
});
