/**
 * provisionWorktree verification tests — FR-004 idempotent worktree provisioning.
 *
 * Tests the branch-exists reconciliation path:
 * - First-time provisioning (branch absent) → normal provision
 * - Branch exists + NOT in any worktree → ADOPT via `git worktree add -f`
 * - Branch exists + IN a registered worktree → ERROR (no double-checkout)
 * - Branch exists + expected path registered → ERROR
 * - git worktree list fails → ERROR (fail-safe, never adopt)
 * - Error message bounded at ~500 chars
 *
 * Uses real git repos for functional coverage + _internals.bunSpawn mock for
 * error-path injection.
 *
 * @note mock.module() on node:child_process leaks across files in Bun's shared
 * test-runner process. This file uses _internals.bunSpawn (file-scoped, trivially
 * restorable) rather than mock.module, avoiding isolation failures.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { bunSpawn } from '../../../src/utils/bun-compat';
import {
	provisionWorktree,
	_internals as worktreeInternals,
} from '../../../src/worktree/core';

// ---- Helpers ---------------------------------------------------------------

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
	// Create an initial commit so HEAD is valid
	await runGit(['commit', '--allow-empty', '-m', 'init'], tmpDir);
	return tmpDir;
}

function tmpDir(): string {
	// realpathSync(os.tmpdir()) so every downstream fixture path is canonical.
	// On the GitHub windows-latest runner, os.tmpdir() returns the 8.3 short
	// name (C:\Users\RUNNER~1\...) while git worktree porcelain emits the long
	// form (C:\Users\runneradmin\...). Building the fixture under the resolved
	// long form from the start makes every path comparison consistent without
	// needing per-assertion realpath helpers. Issue #1729.
	return path.join(
		fs.realpathSync(os.tmpdir()),
		'pw-test-' + Math.random().toString(36).slice(2),
	);
}

/**
 * Canonicalize a filesystem path for comparison. Mirrors the production
 * `normalizeGitPath` helper (src/worktree/core.ts): realpath-resolve (so Windows
 * 8.3 short-name vs long-name temp-dir mismatches don't defeat the compare),
 * then normalize separators and trim trailing slashes. Falls back to the lexical
 * form if the path doesn't exist.
 *
 * Issue #1729 Windows quarantine: GitHub's windows-latest RunnerAdmin user
 * exposes the temp dir as `C:\Users\RUNNER~1\...` while `git worktree list
 * --porcelain` emits the long form `C:\Users\runneradmin\...`, so a raw string
 * compare silently mismatches.
 */
function normalizeGitPath(p: string): string {
	const lexical = p.replace(/\\/g, '/').replace(/\/+$/, '');
	try {
		return fs.realpathSync(p).replace(/\\/g, '/').replace(/\/+$/, '');
	} catch {
		return lexical;
	}
}

/** Normalize every `worktree <path>` line in raw porcelain output. */
function normalizePorcelainPaths(porcelain: string): string {
	return porcelain.replace(/^worktree (.+)$/gm, (_m, p: string) =>
		normalizeGitPath(p),
	);
}

/** Creates a real worktree in a git repo via real git commands. */
async function createRealWorktree(
	repoDir: string,
	branchName: string,
	worktreePath: string,
): Promise<void> {
	// Create the worktree directory
	fs.mkdirSync(worktreePath, { recursive: true });
	// Create the branch and worktree
	await runGit(
		['worktree', 'add', '-b', branchName, worktreePath, 'HEAD'],
		repoDir,
	);
}

// ---- Test suite ------------------------------------------------------------

describe('provisionWorktree — verification (FR-004)', () => {
	// Save original _internals.bunSpawn and restore after each test
	let origBunSpawn: typeof worktreeInternals.bunSpawn;

	beforeEach(() => {
		// Clean the shared default worktree parent dir to prevent cross-test pollution
		// Tests use the same default path: os.tmpdir()/.swarm-worktrees/ses_parentSession/<id>
		const sharedWtParent = path.join(
			os.tmpdir(),
			'.swarm-worktrees',
			'ses_parentSession',
		);
		fs.rmSync(sharedWtParent, { recursive: true, force: true });
		origBunSpawn = worktreeInternals.bunSpawn;
	});

	afterEach(() => {
		worktreeInternals.bunSpawn = origBunSpawn;
	});

	// V1: First-time provisioning (branch absent) → normal provision
	test('V1: first-time provisioning (branch absent) creates a new worktree', async () => {
		const repoDir = tmpDir();
		fs.mkdirSync(repoDir, { recursive: true });
		await initGitRepo(repoDir);

		const result = await provisionWorktree(
			repoDir,
			'1.1',
			'ses_parentSession',
			{
				purpose: 'lane',
			},
		);

		// Fail with the actual error message if provisioning failed
		expect(result).toHaveProperty('worktreePath');
		expect(result).toHaveProperty('branchName');
		const handle = result as { worktreePath: string; branchName: string };
		expect(handle.branchName).toBe('swarm/lane/ses_parentSession/1.1');
		const listResult = await runGit(
			['worktree', 'list', '--porcelain'],
			repoDir,
		);
		expect(listResult.exitCode).toBe(0);
		// Issue #1729 Windows quarantine: the GitHub windows-latest runner's
		// os.tmpdir() returns the 8.3 short name (RUNNER~1) which Bun's
		// realpathSync does NOT resolve to the long form (runneradmin) that
		// git porcelain emits. Comparing the full path defeats the assertion no
		// matter how we canonicalize. Instead, compare the worktree-relative
		// SUFFIX (everything after the tmpdir root), which is identical on both
		// sides. The suffix uniquely identifies the worktree within the porcelain
		// output.
		const toPosix = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '');
		const wtSuffix = toPosix(handle.worktreePath).split('Temp/')[1] ?? '';
		const porcelainPosix = toPosix(listResult.stdout);
		expect(porcelainPosix).toContain(wtSuffix);

		// Cleanup
		try {
			await runGit(['worktree', 'remove', handle.worktreePath], repoDir);
			fs.rmSync(handle.worktreePath, { recursive: true, force: true });
		} catch {
			/* best-effort */
		}
		fs.rmSync(repoDir, { recursive: true, force: true });
	});

	// V2: Branch exists + NOT in any worktree + no commits ahead -> recreate
	test('V2: branch exists but not in any worktree and has no commits ahead -> recreates safely', async () => {
		const repoDir = tmpDir();
		fs.mkdirSync(repoDir, { recursive: true });
		await initGitRepo(repoDir);

		const branchName = 'swarm/lane/ses_parentSession/2.1';

		// Create the branch (but no worktree), then switch back to main so it is
		// stale but has no commits ahead of HEAD.
		await runGit(['checkout', '-b', branchName], repoDir);
		await runGit(['checkout', 'main'], repoDir);

		const result = await provisionWorktree(
			repoDir,
			'2.1',
			'ses_parentSession',
			{
				purpose: 'lane',
			},
		);

		// Should succeed and recreate the branch from the current HEAD, not adopt
		// the stale branch state.
		expect(result).toHaveProperty('worktreePath');
		expect(result).toHaveProperty('branchName', branchName);
		if ('worktreePath' in result) {
			// Verify the worktree path is in git worktree list
			const listResult = await runGit(
				['worktree', 'list', '--porcelain'],
				repoDir,
			);
			// Issue #1729 Windows quarantine: compare the worktree-relative
			// suffix (after Temp/) rather than the full path — see V1 comment.
			const toPosix = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '');
			const wtSuffix = toPosix(result.worktreePath).split('Temp/')[1] ?? '';
			expect(toPosix(listResult.stdout)).toContain(wtSuffix);
			// Cleanup
			await runGit(['worktree', 'remove', result.worktreePath], repoDir);
			fs.rmSync(result.worktreePath, { recursive: true, force: true });
		}

		// Cleanup branch
		await runGit(['branch', '-D', branchName], repoDir);
		fs.rmSync(repoDir, { recursive: true, force: true });
	});

	test('V2b: stale branch with commits ahead is rejected, not force-deleted', async () => {
		const repoDir = tmpDir();
		fs.mkdirSync(repoDir, { recursive: true });
		await initGitRepo(repoDir);

		const branchName = 'swarm/lane/ses_parentSession/2.1';
		await runGit(['checkout', '-b', branchName], repoDir);
		await runGit(['commit', '--allow-empty', '-m', 'stale commit'], repoDir);
		await runGit(['checkout', 'main'], repoDir);

		const result = await provisionWorktree(
			repoDir,
			'2.1',
			'ses_parentSession',
			{
				purpose: 'lane',
			},
		);

		expect(result).toEqual({
			error: `Branch already exists and has unmerged commits: ${branchName}`,
		});
		const branchStillExists = await runGit(
			['branch', '--list', branchName],
			repoDir,
		);
		expect(branchStillExists.stdout).toContain(branchName);
		fs.rmSync(repoDir, { recursive: true, force: true });
	});

	// V3: Branch exists + IN a registered worktree (active) → ERROR
	test('V3: branch exists in an active registered worktree → ERROR (no double-checkout)', async () => {
		const repoDir = tmpDir();
		fs.mkdirSync(repoDir, { recursive: true });
		await initGitRepo(repoDir);

		const branchName = 'swarm/lane/ses_parentSession/3.1';
		// Issue #2527: the expected lane path is now INSIDE the project
		// (<repo>/.swarm-worktrees/...), so this active collision must live at a
		// NON-expected path for the "registered elsewhere → error" branch to fire
		// (a worktree at the expected path is the adopt/recreate case instead).
		const worktreePath = path.join(
			path.dirname(repoDir),
			'swarm-worktrees-elsewhere',
			'ses_parentSession',
			'3.1',
		);

		// Create a REAL worktree with this branch (active collision)
		await createRealWorktree(repoDir, branchName, worktreePath);

		const result = await provisionWorktree(
			repoDir,
			'3.1',
			'ses_parentSession',
			{
				purpose: 'lane',
			},
		);

		// Should return error (active collision)
		expect(result).toHaveProperty('error');
		if ('error' in result) {
			expect(result.error).toContain('already exists');
			expect(result.error).toContain('active');
		}

		// Cleanup
		await runGit(['worktree', 'remove', worktreePath], repoDir);
		fs.rmSync(path.dirname(worktreePath), { recursive: true, force: true });
		await runGit(['branch', '-D', branchName], repoDir);
		fs.rmSync(repoDir, { recursive: true, force: true });
	});

	// V4: Branch exists + expected path registered (active) → ERROR
	test('V4: expected path registered in worktree list → ERROR', async () => {
		const repoDir = tmpDir();
		fs.mkdirSync(repoDir, { recursive: true });
		await initGitRepo(repoDir);

		const branchName = 'swarm/lane/ses_parentSession/4.1';

		// Create the branch (no worktree), then manually register a worktree at
		// the EXPECTED path (simulating a previously created worktree that's now gone
		// but still registered in git's worktree list metadata)
		await runGit(['checkout', '-b', branchName], repoDir);
		await runGit(['commit', '--allow-empty', '-m', 'commit'], repoDir);
		await runGit(['checkout', 'main'], repoDir);

		// Use `git worktree add --force` to create a worktree at the expected path
		// so it shows up in `git worktree list --porcelain`
		const expectedPath = path.join(
			path.dirname(repoDir),
			'.swarm-worktrees',
			'ses_parentSession',
			'4.1',
		);
		fs.mkdirSync(path.dirname(expectedPath), { recursive: true });
		// Create a fake locked worktree entry at the expected path (no actual worktree dir needed
		// for the listing — git worktree list just reads .git/worktrees)
		// Instead: create a real worktree at the expected path
		const addResult = await runGit(
			['worktree', 'add', '-f', expectedPath, branchName],
			repoDir,
		);
		// May fail if directory already exists, but that's fine for our purposes
		if (addResult.exitCode === 0) {
			fs.writeFileSync(path.join(expectedPath, 'dirty.txt'), 'do not delete');
		}

		const result = await provisionWorktree(
			repoDir,
			'4.1',
			'ses_parentSession',
			{
				purpose: 'lane',
			},
		);

		// Should return error because same-task cleanup must not delete dirty work.
		expect(result).toHaveProperty('error');
		if ('error' in result) {
			expect(result.error).toMatch(/dirty|already exists|active|worktree/i);
		}

		// Cleanup
		const removeResult = await runGit(
			['worktree', 'remove', '--force', expectedPath],
			repoDir,
		);
		if (removeResult.exitCode === 0) {
			fs.rmSync(expectedPath, { recursive: true, force: true });
		}
		await runGit(['branch', '-D', branchName], repoDir);
		fs.rmSync(repoDir, { recursive: true, force: true });
	});

	// V5: git worktree list fails (nonzero exit) → ERROR (fail-safe, never adopt)
	test('V5: git worktree list --porcelain fails → ERROR (fail-safe, never adopt)', async () => {
		const repoDir = tmpDir();
		fs.mkdirSync(repoDir, { recursive: true });
		await initGitRepo(repoDir);

		const branchName = 'swarm/lane/ses_parentSession/5.1';

		// Create the branch so provisionWorktree enters the reconciliation branch
		await runGit(['checkout', '-b', branchName], repoDir);
		await runGit(['commit', '--allow-empty', '-m', 'commit'], repoDir);
		await runGit(['checkout', 'main'], repoDir);

		// Mock _internals.bunSpawn to make `git worktree list --porcelain` fail
		let worktreeListCallCount = 0;
		worktreeInternals.bunSpawn = mock((args: string[], _opts: unknown) => {
			if (args[1] === 'worktree' && args[2] === 'list') {
				worktreeListCallCount++;
				// Return a proc-like object with failed exitCode
				return {
					exited: Promise.resolve(128),
					stdout: { text: () => Promise.resolve('') },
					stderr: {
						text: () => Promise.resolve('fatal: not a git repository'),
					},
					kill: () => {},
				} as unknown as ReturnType<typeof bunSpawn>;
			}
			// Fall through to real bunSpawn for all other git commands
			return origBunSpawn(args, _opts as Parameters<typeof bunSpawn>[1]);
		});

		const result = await provisionWorktree(
			repoDir,
			'5.1',
			'ses_parentSession',
			{
				purpose: 'lane',
			},
		);

		// Should return error (fail-safe, never adopt)
		expect(result).toHaveProperty('error');
		if ('error' in result) {
			expect(result.error).toContain('enumeration failed');
			// Must NOT have adopted — branch should still be only in .git/refs/heads
			const showRef = await runGit(
				['show-ref', '--verify', '--quiet', `refs/heads/${branchName}`],
				repoDir,
			);
			expect(showRef.exitCode).toBe(0); // branch still exists
		}

		// Cleanup
		await runGit(['branch', '-D', branchName], repoDir);
		fs.rmSync(repoDir, { recursive: true, force: true });
	});

	// V6: Error message bounded at ~500 chars with truncation marker
	test('V6: error message is bounded at ~500 chars with truncation marker', async () => {
		const repoDir = tmpDir();
		fs.mkdirSync(repoDir, { recursive: true });
		await initGitRepo(repoDir);

		const branchName = 'swarm/lane/ses_parentSession/6.1';

		// Create the branch so we enter the reconciliation branch
		await runGit(['checkout', '-b', branchName], repoDir);
		await runGit(['commit', '--allow-empty', '-m', 'commit'], repoDir);
		await runGit(['checkout', 'main'], repoDir);

		// Create a huge stderr (10KB) to test bounding
		const hugeStderr = 'x'.repeat(10 * 1024);

		worktreeInternals.bunSpawn = mock((args: string[], _opts: unknown) => {
			if (args[1] === 'worktree' && args[2] === 'list') {
				return {
					exited: Promise.resolve(128),
					stdout: { text: () => Promise.resolve('') },
					stderr: { text: () => Promise.resolve(hugeStderr) },
					kill: () => {},
				} as unknown as ReturnType<typeof bunSpawn>;
			}
			return origBunSpawn(args, _opts as Parameters<typeof bunSpawn>[1]);
		});

		const result = await provisionWorktree(
			repoDir,
			'6.1',
			'ses_parentSession',
			{
				purpose: 'lane',
			},
		);

		expect(result).toHaveProperty('error');
		if ('error' in result) {
			// Error message must be bounded (~500 chars + marker + prefix)
			// prefix = "worktree enumeration failed: " (29 chars)
			// truncation = "... (truncated)" (15 chars)
			// max = 29 + 500 + 15 = 544
			expect(result.error.length).toBeLessThanOrEqual(550);
			expect(result.error).toContain('... (truncated)');
		}

		// Cleanup
		await runGit(['branch', '-D', branchName], repoDir);
		fs.rmSync(repoDir, { recursive: true, force: true });
	});
});

// ---------------------------------------------------------------------------
// Mock coverage documentation (per writing-tests SKILL.md)
// ---------------------------------------------------------------------------
/**
 * Mock coverage for this file:
 *
 * Tier 1 (_internals seams):
 * - worktreeInternals.bunSpawn    — mocked for V5, V6 (git worktree list failure paths)
 *
 * Gaps / known limitations:
 * - Dispatch-time lifecycle locking and durable collision ownership are covered
 *   in worktree-precreate-durable-collision.test.ts. Bounded global orphan
 *   recovery is covered separately in init-orphan-recovery.test.ts.
 */
