/**
 * provisionWorktree adversarial tests — FR-004 attack vectors.
 *
 * A1: Double-checkout evasion — branch checked out in a DIFFERENT registered
 *     worktree path → error fires (not adopt-with-force)
 * A2: Unbounded output injection — fake git emits huge stderr → capped ~500 chars
 * A3: Malformed porcelain — garbage lines → parse resilience (skip, don't crash)
 * A4: Empty porcelain (no worktrees) + branch exists → adopt (correct)
 * A5: Force-flag abuse — confirm no path lets caller force-adopt an active branch
 *
 * @note Uses _internals.bunSpawn mock (file-scoped, trivially restorable).
 * No mock.module() — avoids Bun cross-file mock leakage.
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
		'pw-adv-' + Math.random().toString(36).slice(2),
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

async function createRealWorktree(
	repoDir: string,
	branchName: string,
	worktreePath: string,
): Promise<void> {
	// git worktree add creates the directory itself — do NOT pre-create it
	// (pre-creating causes "directory already exists" failure)
	const result = await runGit(
		['worktree', 'add', '-b', branchName, worktreePath, 'HEAD'],
		repoDir,
	);
	if (result.exitCode !== 0) {
		throw new Error(
			`createRealWorktree failed: ${result.stderr.trim() || result.stdout.trim()}`,
		);
	}
}

// ---- Test suite ------------------------------------------------------------

describe('provisionWorktree — adversarial (FR-004)', () => {
	let origBunSpawn: typeof worktreeInternals.bunSpawn;

	beforeEach(() => {
		// Clean the shared default worktree parent dir to prevent cross-test pollution
		const sharedWtParent = path.join(
			os.tmpdir(),
			'.swarm-worktrees',
			'parent-session',
		);
		fs.rmSync(sharedWtParent, { recursive: true, force: true });
		origBunSpawn = worktreeInternals.bunSpawn;
	});

	afterEach(() => {
		worktreeInternals.bunSpawn = origBunSpawn;
	});

	// A1: DOUBLE-CHECKOUT EVASION — CORE SECURITY PROPERTY
	//
	// A branch checked out in ANY registered worktree → provisionWorktree returns
	// ERROR (not adopt-with-force). Key: git prevents double-checkout via
	// `git worktree add <path> <branch>` (without -b) failing when the branch
	// is already checked out elsewhere. Our collision detection must be consistent.
	test('A1: branch checked out in worktree A → provisionWorktree for same branch to worktree B errors', async () => {
		const repoDir = tmpDir();
		fs.mkdirSync(repoDir, { recursive: true });
		await initGitRepo(repoDir);

		const branchName = 'swarm/lane/parent-session/A1';

		// Create the branch and commit (--allow-empty doesn't touch files)
		await runGit(['checkout', '-b', branchName], repoDir);
		await runGit(['commit', '--allow-empty', '-m', 'commit'], repoDir);

		// MUST switch back to main BEFORE creating the worktree.
		// The main repo IS a worktree, and we're currently ON the branch.
		// git refuses to create a worktree for a branch that's already checked out.
		await runGit(['checkout', 'main'], repoDir);

		// Verify main's working tree is clean
		const statusCheck = await runGit(['status', '--porcelain'], repoDir);
		expect(statusCheck.stdout.trim()).toBe(''); // verify clean state

		// Create first worktree using `git worktree add <path> <branch>` (NO -b flag).
		// This checks out an EXISTING branch at a new path.
		const firstPath = path.join(
			os.tmpdir(),
			'worktree-A1-first-' + Math.random().toString(36).slice(2),
		);
		const addResult = await runGit(
			['worktree', 'add', firstPath, branchName],
			repoDir,
		);
		if (addResult.exitCode !== 0) {
			throw new Error(
				`A1 setup failed: git worktree add ${firstPath} ${branchName} exited ${addResult.exitCode}: ${addResult.stderr.slice(0, 300)}`,
			);
		}

		// Verify first worktree is registered with branchName
		const listResult = await runGit(
			['worktree', 'list', '--porcelain'],
			repoDir,
		);
		// Issue #1729 Windows quarantine: realpath both sides (see
		// normalizeGitPath above) so the 8.3 vs long-name temp-dir mismatch
		// doesn't defeat the assertion.
		expect(normalizePorcelainPaths(listResult.stdout)).toContain(
			normalizeGitPath(firstPath),
		);
		expect(listResult.stdout).toContain(branchName);

		// Now call provisionWorktree for the SAME branch — should ERROR
		const result = await provisionWorktree(repoDir, 'A1', 'parent-session', {
			purpose: 'lane',
		});

		expect(result).toHaveProperty('error');
		if ('error' in result) {
			expect(result.error).toContain('already exists');
			expect(result.error).toContain('active');
		}

		// Cleanup
		await runGit(['worktree', 'remove', firstPath], repoDir);
		fs.rmSync(firstPath, { recursive: true, force: true });
		await runGit(['branch', '-D', branchName], repoDir);
		fs.rmSync(repoDir, { recursive: true, force: true });
	});

	// A2: UNBOUNDED OUTPUT INJECTION
	// Fake git emits huge stderr on list failure → error message capped ~500 chars
	test('A2: huge stderr (100KB) on git worktree list failure → error bounded at ~500 chars', async () => {
		const repoDir = tmpDir();
		fs.mkdirSync(repoDir, { recursive: true });
		await initGitRepo(repoDir);

		const branchName = 'swarm/lane/parent-session/A2';
		await runGit(['checkout', '-b', branchName], repoDir);
		await runGit(['commit', '--allow-empty', '-m', 'commit'], repoDir);
		await runGit(['checkout', 'main'], repoDir);

		// 100KB of noise + an embedded error pattern
		const hugeNoise =
			'fatal: this is a very long error message from git\n'.repeat(4_000);

		worktreeInternals.bunSpawn = mock((args: string[], _opts: unknown) => {
			if (args[1] === 'worktree' && args[2] === 'list') {
				return {
					exited: Promise.resolve(128),
					stdout: { text: () => Promise.resolve('') },
					stderr: { text: () => Promise.resolve(hugeNoise) },
					kill: () => {},
				} as unknown as ReturnType<typeof bunSpawn>;
			}
			return origBunSpawn(args, _opts as Parameters<typeof bunSpawn>[1]);
		});

		const result = await provisionWorktree(repoDir, 'A2', 'parent-session', {
			purpose: 'lane',
		});

		expect(result).toHaveProperty('error');
		if ('error' in result) {
			// The error message must be bounded (~500 chars + prefix + truncation marker)
			// prefix = "worktree enumeration failed: " (29 chars)
			// truncation = "... (truncated)" (15 chars)
			// max = 29 + 500 + 15 = 544
			expect(result.error.length).toBeLessThanOrEqual(550);
			expect(result.error).toContain('... (truncated)');
			// Must still contain the prefix so user knows what failed
			expect(result.error).toContain('enumeration failed');
		}

		// Cleanup
		await runGit(['branch', '-D', branchName], repoDir);
		fs.rmSync(repoDir, { recursive: true, force: true });
	});

	// A3: MALFORMED PORCELAIN
	// git worktree list --porcelain returns garbage lines → parse resilience
	test('A3: malformed porcelain output → skipped, not crashed, not wrongly adopted', async () => {
		const repoDir = tmpDir();
		fs.mkdirSync(repoDir, { recursive: true });
		await initGitRepo(repoDir);

		const branchName = 'swarm/lane/parent-session/A3';
		await runGit(['checkout', '-b', branchName], repoDir);
		await runGit(['commit', '--allow-empty', '-m', 'commit'], repoDir);
		await runGit(['checkout', 'main'], repoDir);

		// Malformed porcelain: valid entry followed by garbage, then valid entry
		const malformedPorcelain = `worktree ${repoDir}
branch refs/heads/${branchName}
garbage line without prefix
worktree /somewhere/else
not a valid entry
worktree /another/place
branch refs/heads/main
`;

		worktreeInternals.bunSpawn = mock((args: string[], _opts: unknown) => {
			if (args[1] === 'worktree' && args[2] === 'list') {
				return {
					exited: Promise.resolve(0),
					stdout: { text: () => Promise.resolve(malformedPorcelain) },
					stderr: { text: () => Promise.resolve('') },
					kill: () => {},
				} as unknown as ReturnType<typeof bunSpawn>;
			}
			return origBunSpawn(args, _opts as Parameters<typeof bunSpawn>[1]);
		});

		const result = await provisionWorktree(repoDir, 'A3', 'parent-session', {
			purpose: 'lane',
		});

		// Since branch IS in worktree list (refs/heads/A3 is registered),
		// it should ERROR — NOT crash, NOT wrongly adopt
		expect(result).toHaveProperty('error');
		if ('error' in result) {
			expect(result.error).toContain('already exists');
		}

		// Cleanup
		await runGit(['branch', '-D', branchName], repoDir);
		fs.rmSync(repoDir, { recursive: true, force: true });
	});

	// A4: EMPTY porcelain (no worktrees) + branch exists → adopt
	test('A4: empty porcelain (no worktrees) + branch exists → adopts correctly', async () => {
		const repoDir = tmpDir();
		fs.mkdirSync(repoDir, { recursive: true });
		await initGitRepo(repoDir);

		const branchName = 'swarm/lane/parent-session/A4';
		await runGit(['checkout', '-b', branchName], repoDir);
		await runGit(['commit', '--allow-empty', '-m', 'commit'], repoDir);
		await runGit(['checkout', 'main'], repoDir);

		// Empty porcelain — simulates a repo with no registered worktrees
		worktreeInternals.bunSpawn = mock((args: string[], _opts: unknown) => {
			if (args[1] === 'worktree' && args[2] === 'list') {
				return {
					exited: Promise.resolve(0),
					stdout: { text: () => Promise.resolve('') }, // empty = no worktrees
					stderr: { text: () => Promise.resolve('') },
					kill: () => {},
				} as unknown as ReturnType<typeof bunSpawn>;
			}
			return origBunSpawn(args, _opts as Parameters<typeof bunSpawn>[1]);
		});

		const result = await provisionWorktree(repoDir, 'A4', 'parent-session', {
			purpose: 'lane',
		});

		// Since branch is NOT in any worktree (empty porcelain), it should ADOPT
		expect(result).toHaveProperty('worktreePath');
		expect(result).toHaveProperty('branchName', branchName);
		if ('worktreePath' in result) {
			// Verify adopted worktree appears in real git worktree list
			const listResult = await runGit(
				['worktree', 'list', '--porcelain'],
				repoDir,
			);
			// Issue #1729 Windows quarantine: realpath both sides (see
			// normalizeGitPath above) so the 8.3 vs long-name temp-dir mismatch
			// doesn't defeat the assertion.
			expect(normalizePorcelainPaths(listResult.stdout)).toContain(
				normalizeGitPath(result.worktreePath),
			);
			// Cleanup
			await runGit(['worktree', 'remove', result.worktreePath], repoDir);
			fs.rmSync(result.worktreePath, { recursive: true, force: true });
		}

		// Cleanup
		await runGit(['branch', '-D', branchName], repoDir);
		fs.rmSync(repoDir, { recursive: true, force: true });
	});

	// A5: FORCE-FLAG ABUSE — confirm no path lets caller force-adopt an active branch.
	// provisionWorktree has no force flag in its signature or options. The collision
	// check is branch-based (not path-based), so we verify:
	// (a) Active branch returns error regardless of worktreeDir
	// (b) Merge strategy options do not bypass the collision check
	test('A5: no force-adopt bypass — active branch always returns error regardless of options', async () => {
		const repoDir = tmpDir();
		fs.mkdirSync(repoDir, { recursive: true });
		await initGitRepo(repoDir);

		const branchName = 'swarm/lane/parent-session/A5';
		const worktreePath = path.join(
			os.tmpdir(),
			'worktree-A5-active-' + Math.random().toString(36).slice(2),
		);

		// Create an active worktree for the branch
		await createRealWorktree(repoDir, branchName, worktreePath);

		// 1. Default call with active branch → must ERROR
		const result1 = await provisionWorktree(repoDir, 'A5', 'parent-session', {
			purpose: 'lane',
		});

		// 2. Same branch name but explicit worktreeDir (collision still detected via branch check)
		const result2 = await provisionWorktree(repoDir, 'A5', 'parent-session', {
			purpose: 'lane',
			worktreeDir: path.join(os.tmpdir(), 'worktree-A5-explicit'),
		});

		// 3. Same branch + mergeStrategy option (no bypass)
		const result3 = await provisionWorktree(repoDir, 'A5', 'parent-session', {
			purpose: 'lane',
			mergeStrategy: 'rebase',
		});

		// All three must return errors — no force-adopt bypass exists
		expect(result1).toHaveProperty('error');
		expect(result2).toHaveProperty('error');
		expect(result3).toHaveProperty('error');

		if ('error' in result1) expect(result1.error).toContain('already exists');
		if ('error' in result2) expect(result2.error).toContain('already exists');
		if ('error' in result3) expect(result3.error).toContain('already exists');

		// Cleanup
		await runGit(['worktree', 'remove', worktreePath], repoDir);
		fs.rmSync(worktreePath, { recursive: true, force: true });
		await runGit(['branch', '-D', branchName], repoDir);
		fs.rmSync(repoDir, { recursive: true, force: true });
	});
});
