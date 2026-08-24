/**
 * provisionWorktree `prunable` recovery — issue #2208.
 *
 * When a session is killed mid-task, the worktree directory may be deleted
 * while git's index still tracks it as `prunable`. Re-provisioning used to
 * parse the prunable registration as an active collision and fail with
 * "Branch already exists and expected worktree is dirty" (isCleanWorktree on
 * the missing directory). provisionWorktree must detect the `prunable`
 * attribute, run `git worktree prune`, and re-provision seamlessly.
 *
 * Uses a real git repo; skips gracefully if the installed git does not emit
 * the `prunable` attribute in porcelain output.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { bunSpawn } from '../../../src/utils/bun-compat';
import { provisionWorktree } from '../../../src/worktree/core';

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
	try {
		proc.kill();
	} catch {
		// best-effort — process may already have exited
	}
	return { exitCode, stdout, stderr };
}

function tmpDir(): string {
	// NOTE: the prefix must not contain the word "prunable" — this repo's
	// parent path leaks into `git worktree list --porcelain` output and would
	// defeat the not.toContain('prunable') assertion below.
	return path.join(
		fs.realpathSync(os.tmpdir()),
		'pw-stale-' + Math.random().toString(36).slice(2),
	);
}

describe('provisionWorktree — prunable registration recovery (#2208)', () => {
	let repoDir: string;

	beforeEach(() => {
		repoDir = tmpDir();
		fs.mkdirSync(repoDir, { recursive: true });
		// provisionWorktree's default base dir is shared across the process
		// (the canonical OS temp root plus .swarm-worktrees/<sessionId>/<id>) —
		// remove this suite's session dirs so a failed earlier run cannot leave
		// "already exists" collisions (same pattern as provision-worktree.test.ts).
		for (const sessionId of ['ses_crash', 'ses_dead', 'ses_alive']) {
			fs.rmSync(
				path.join(fs.realpathSync(os.tmpdir()), '.swarm-worktrees', sessionId),
				{ recursive: true, force: true },
			);
		}
	});

	afterEach(() => {
		fs.rmSync(repoDir, { recursive: true, force: true });
	});

	async function initGitRepo(): Promise<void> {
		await runGit(['init', '-b', 'main'], repoDir);
		await runGit(['config', 'user.email', 'test@test.com'], repoDir);
		await runGit(['config', 'user.name', 'Test'], repoDir);
		await runGit(['commit', '--allow-empty', '-m', 'init'], repoDir);
	}

	test('re-provisions a task whose worktree registration is prunable (#2208)', async () => {
		await initGitRepo();

		// Provision once, then simulate the crash: delete the worktree
		// directory WITHOUT unregistering it, so git reports it prunable.
		const first = await provisionWorktree(repoDir, '4.1', 'ses_crash', {
			purpose: 'lane',
		});
		expect(first).toHaveProperty('worktreePath');
		const firstHandle = first as { worktreePath: string; branchName: string };
		fs.rmSync(firstHandle.worktreePath, { recursive: true, force: true });

		const listAfterDelete = await runGit(
			['worktree', 'list', '--porcelain'],
			repoDir,
		);
		if (!listAfterDelete.stdout.includes('prunable')) {
			// Git only emits `prunable` when it notices the missing directory
			// (version/behavior dependent). Without the attribute this
			// scenario is indistinguishable from a live lane, so the recovery
			// contract cannot be exercised on this git. LOUD skip (final-critic
			// item): a silent return would hide coverage loss on a CI image
			// whose git stopped emitting the attribute.
			console.warn(
				'[2208] SKIP: installed git does not emit the porcelain `prunable` attribute; the prune+relist recovery path is unexercised on this runner.',
			);
			return;
		}

		// Pre-#2208: "Branch already exists and expected worktree is dirty"
		// (isCleanWorktree fails on the deleted directory → treated as dirty).
		const second = await provisionWorktree(repoDir, '4.1', 'ses_crash', {
			purpose: 'lane',
		});
		expect(second).toHaveProperty('worktreePath');
		const secondHandle = second as {
			worktreePath: string;
			branchName: string;
		};
		expect(secondHandle.branchName).toBe('swarm/lane/ses_crash/4.1');
		// The new worktree exists on disk and is a healthy registration.
		expect(fs.existsSync(secondHandle.worktreePath)).toBe(true);
		const finalList = await runGit(
			['worktree', 'list', '--porcelain'],
			repoDir,
		);
		expect(finalList.stdout).not.toContain('prunable');
	});

	test('a prunable OTHER-task lane does not break provisioning of a fresh task (#2208)', async () => {
		await initGitRepo();

		const stale = await provisionWorktree(repoDir, '9.9', 'ses_dead', {
			purpose: 'lane',
		});
		const staleHandle = stale as { worktreePath: string };
		fs.rmSync(staleHandle.worktreePath, { recursive: true, force: true });

		const result = await provisionWorktree(repoDir, '4.2', 'ses_alive', {
			purpose: 'lane',
		});
		expect(result).toHaveProperty('worktreePath');
		const handle = result as { worktreePath: string; branchName: string };
		expect(handle.branchName).toBe('swarm/lane/ses_alive/4.2');
		expect(fs.existsSync(handle.worktreePath)).toBe(true);
	});
});
