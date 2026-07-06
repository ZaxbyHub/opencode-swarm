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
 * - startupOrphanRecovery called BEFORE provisionWorktree (call order)
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
	return path.join(
		os.tmpdir(),
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
		// Tests use the same default path: os.tmpdir()/.swarm-worktrees/parent-session/<id>
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

	// V1: First-time provisioning (branch absent) → normal provision
	test('V1: first-time provisioning (branch absent) creates a new worktree', async () => {
		const repoDir = tmpDir();
		fs.mkdirSync(repoDir, { recursive: true });
		await initGitRepo(repoDir);

		const result = await provisionWorktree(repoDir, '1.1', 'parent-session', {
			purpose: 'lane',
		});

		// Fail with the actual error message if provisioning failed
		expect(result).toHaveProperty('worktreePath');
		expect(result).toHaveProperty('branchName');
		const handle = result as { worktreePath: string; branchName: string };
		expect(handle.branchName).toBe('swarm/lane/parent-session/1.1');
		const listResult = await runGit(
			['worktree', 'list', '--porcelain'],
			repoDir,
		);
		expect(listResult.exitCode).toBe(0);
		// Issue #1729 Windows quarantine: normalize BOTH sides through realpath so
		// the Windows 8.3 short-name (RUNNER~1) vs long-name (runneradmin) temp
		// dir mismatch between the test-built path and `git worktree list
		// --porcelain` output doesn't defeat the assertion.
		expect(normalizePorcelainPaths(listResult.stdout)).toContain(
			normalizeGitPath(handle.worktreePath),
		);

		// Cleanup
		try {
			await runGit(['worktree', 'remove', handle.worktreePath], repoDir);
			fs.rmSync(handle.worktreePath, { recursive: true, force: true });
		} catch {
			/* best-effort */
		}
		fs.rmSync(repoDir, { recursive: true, force: true });
	});

	// V2: Branch exists + NOT in any worktree (stale) → ADOPT
	test('V2: branch exists but not in any worktree → adopts via git worktree add -f', async () => {
		const repoDir = tmpDir();
		fs.mkdirSync(repoDir, { recursive: true });
		await initGitRepo(repoDir);

		const branchName = 'swarm/lane/parent-session/2.1';

		// Create the branch (but no worktree) — simulating a stale branch
		await runGit(['checkout', '-b', branchName], repoDir);
		await runGit(['commit', '--allow-empty', '-m', 'stale commit'], repoDir);
		// Switch back to main so the branch is "stale" (not checked out)
		await runGit(['checkout', 'main'], repoDir);

		const result = await provisionWorktree(repoDir, '2.1', 'parent-session', {
			purpose: 'lane',
		});

		// Should succeed and adopt the branch
		expect(result).toHaveProperty('worktreePath');
		expect(result).toHaveProperty('branchName', branchName);
		if ('worktreePath' in result) {
			// Verify the worktree path is in git worktree list
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

		// Cleanup branch
		await runGit(['branch', '-D', branchName], repoDir);
		fs.rmSync(repoDir, { recursive: true, force: true });
	});

	// V3: Branch exists + IN a registered worktree (active) → ERROR
	test('V3: branch exists in an active registered worktree → ERROR (no double-checkout)', async () => {
		const repoDir = tmpDir();
		fs.mkdirSync(repoDir, { recursive: true });
		await initGitRepo(repoDir);

		const branchName = 'swarm/lane/parent-session/3.1';
		const worktreePath = path.join(
			repoDir,
			'.swarm-worktrees',
			'parent-session',
			'3.1',
		);

		// Create a REAL worktree with this branch (active collision)
		await createRealWorktree(repoDir, branchName, worktreePath);

		const result = await provisionWorktree(repoDir, '3.1', 'parent-session', {
			purpose: 'lane',
		});

		// Should return error (active collision)
		expect(result).toHaveProperty('error');
		if ('error' in result) {
			expect(result.error).toContain('already exists');
			expect(result.error).toContain('active');
		}

		// Cleanup
		await runGit(['worktree', 'remove', worktreePath], repoDir);
		fs.rmSync(worktreePath, { recursive: true, force: true });
		await runGit(['branch', '-D', branchName], repoDir);
		fs.rmSync(repoDir, { recursive: true, force: true });
	});

	// V4: Branch exists + expected path registered (active) → ERROR
	test('V4: expected path registered in worktree list → ERROR', async () => {
		const repoDir = tmpDir();
		fs.mkdirSync(repoDir, { recursive: true });
		await initGitRepo(repoDir);

		const branchName = 'swarm/lane/parent-session/4.1';

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
			'parent-session',
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

		const result = await provisionWorktree(repoDir, '4.1', 'parent-session', {
			purpose: 'lane',
		});

		// Should return error (expected path is registered)
		expect(result).toHaveProperty('error');
		if ('error' in result) {
			expect(result.error).toMatch(/already exists|active|worktree/i);
		}

		// Cleanup
		const removeResult = await runGit(
			['worktree', 'remove', expectedPath],
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

		const branchName = 'swarm/lane/parent-session/5.1';

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

		const result = await provisionWorktree(repoDir, '5.1', 'parent-session', {
			purpose: 'lane',
		});

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

		const branchName = 'swarm/lane/parent-session/6.1';

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

		const result = await provisionWorktree(repoDir, '6.1', 'parent-session', {
			purpose: 'lane',
		});

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

	// V7: startupOrphanRecovery called BEFORE provisionWorktree (via precreateStandardWorktreeSession)
	test('V7: precreateStandardWorktreeSession calls startupOrphanRecovery before provisionWorktree', async () => {
		// We test this via the _internals seam in worktree-isolation.ts
		// by replacing both functions and verifying call order.
		const { _internals: di, precreateStandardWorktreeSession } = await import(
			'../../../src/hooks/delegation-gate/worktree-isolation'
		);

		// Save originals
		const origProvision = di.provisionWorktree;
		const origRecovery = di.startupOrphanRecovery;
		const origCleanup = di.cleanupOrphanedBranches;

		const callOrder: string[] = [];

		di.startupOrphanRecovery = mock(async () => {
			callOrder.push('startupOrphanRecovery');
			return { prunedWorktrees: false, remainingBranches: [], warnings: [] };
		});

		di.cleanupOrphanedBranches = mock(async () => {
			callOrder.push('cleanupOrphanedBranches');
			return { removed: [], skipped: [], errors: [] };
		});

		di.provisionWorktree = mock(async () => {
			callOrder.push('provisionWorktree');
			// Return success to avoid hitting handleStandardWorktreeFailure
			return {
				worktreePath: '/fake/path',
				branchName: 'swarm/lane/test/1.1',
				purpose: 'lane',
				id: '1.1',
				sessionId: 'test-session',
			};
		});

		// We also need to mock the OpenCode SDK client to avoid NPE
		const { swarmState } = await import('../../../src/state');
		const origClient = swarmState.opencodeClient;
		swarmState.opencodeClient = {
			session: {
				create: mock(async () => ({
					data: { id: 'fake-session-id' },
				})),
			},
		} as unknown as typeof swarmState.opencodeClient;

		try {
			await precreateStandardWorktreeSession({
				config: { swarms: {} },
				directory: '/fake/dir',
				parentSessionID: 'test-session',
				callID: 'call-1',
				taskId: '1.1',
				outputArgs: {},
			});

			// startupOrphanRecovery MUST be called before provisionWorktree
			expect(callOrder).toEqual([
				'startupOrphanRecovery',
				'cleanupOrphanedBranches',
				'provisionWorktree',
			]);
		} finally {
			// Restore originals
			di.provisionWorktree = origProvision;
			di.startupOrphanRecovery = origRecovery;
			di.cleanupOrphanedBranches = origCleanup;
			swarmState.opencodeClient = origClient;
		}
	});

	// V8: cleanupOrphanedBranches called with (directory, [parentSessionID]) as active allowlist
	// Part of SC-004.2 (resume branch-cleanup depth fix): stale lane branches from
	// inactive sessions are deleted on resume, while the current session's branches survive.
	test('V8: precreateStandardWorktreeSession calls cleanupOrphanedBranches with parentSessionID allowlist', async () => {
		const { _internals: di, precreateStandardWorktreeSession } = await import(
			'../../../src/hooks/delegation-gate/worktree-isolation'
		);

		const origProvision = di.provisionWorktree;
		const origRecovery = di.startupOrphanRecovery;
		const origCleanup = di.cleanupOrphanedBranches;

		let capturedArgs: [string, string[]] | undefined;

		di.startupOrphanRecovery = mock(async () => ({
			prunedWorktrees: false,
			remainingBranches: [],
			warnings: [],
		}));

		di.cleanupOrphanedBranches = mock(
			async (dir: string, activeIds: string[]) => {
				capturedArgs = [dir, activeIds];
				return { removed: [], skipped: [], errors: [] };
			},
		);

		di.provisionWorktree = mock(async () => ({
			worktreePath: '/fake/path',
			branchName: 'swarm/lane/test/1.1',
			purpose: 'lane',
			id: '1.1',
			sessionId: 'test-session',
		}));

		const { swarmState } = await import('../../../src/state');
		const origClient = swarmState.opencodeClient;
		swarmState.opencodeClient = {
			session: {
				create: mock(async () => ({ data: { id: 'fake-session-id' } })),
			},
		} as unknown as typeof swarmState.opencodeClient;

		try {
			await precreateStandardWorktreeSession({
				config: { swarms: {} },
				directory: '/test/project/root',
				parentSessionID: 'my-parent-session',
				callID: 'call-2',
				taskId: '2.1',
				outputArgs: {},
			});

			// SC-004.2: cleanupOrphanedBranches receives the project directory and
			// [parentSessionID] as the active-session allowlist — the current session's
			// branches are preserved, all others are eligible for deletion.
			expect(capturedArgs).toEqual([
				'/test/project/root',
				['my-parent-session'],
			]);
		} finally {
			di.provisionWorktree = origProvision;
			di.startupOrphanRecovery = origRecovery;
			di.cleanupOrphanedBranches = origCleanup;
			swarmState.opencodeClient = origClient;
		}
	});

	// V9: cleanupOrphanedBranches failure is non-fatal — provisioning still succeeds.
	// Part of SC-004.2 (resume branch-cleanup depth fix): cleanup is best-effort;
	// a failed cleanup must not block lane provisioning.
	test('V9: cleanupOrphanedBranches failure is non-fatal — provisioning proceeds', async () => {
		const { _internals: di, precreateStandardWorktreeSession } = await import(
			'../../../src/hooks/delegation-gate/worktree-isolation'
		);

		const origProvision = di.provisionWorktree;
		const origRecovery = di.startupOrphanRecovery;
		const origCleanup = di.cleanupOrphanedBranches;

		let provisionCalled = false;

		di.startupOrphanRecovery = mock(async () => ({
			prunedWorktrees: false,
			remainingBranches: [],
			warnings: [],
		}));

		// Simulate cleanupOrphanedBranches throwing — must NOT prevent provisionWorktree
		di.cleanupOrphanedBranches = mock(async () => {
			throw new Error('git branch -D failed');
		});

		di.provisionWorktree = mock(async () => {
			provisionCalled = true;
			return {
				worktreePath: '/fake/path',
				branchName: 'swarm/lane/test/1.1',
				purpose: 'lane',
				id: '1.1',
				sessionId: 'test-session',
			};
		});

		const { swarmState } = await import('../../../src/state');
		const origClient = swarmState.opencodeClient;
		swarmState.opencodeClient = {
			session: {
				create: mock(async () => ({ data: { id: 'fake-session-id' } })),
			},
		} as unknown as typeof swarmState.opencodeClient;

		const outputArgs: Record<string, unknown> = {};

		try {
			await precreateStandardWorktreeSession({
				config: { swarms: {} },
				directory: '/fake/dir',
				parentSessionID: 'test-session',
				callID: 'call-3',
				taskId: '3.1',
				outputArgs: {},
			});

			// Even though cleanupOrphanedBranches threw, provisioning must still run.
			expect(provisionCalled).toBe(true);
			// The session must have been created (no early return from handleStandardWorktreeFailure).
		} finally {
			di.provisionWorktree = origProvision;
			di.startupOrphanRecovery = origRecovery;
			di.cleanupOrphanedBranches = origCleanup;
			swarmState.opencodeClient = origClient;
		}
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
 * - di.provisionWorktree           — mocked for V7, V8, V9 (call-order + non-fatal assertions)
 * - di.startupOrphanRecovery       — mocked for V7, V8, V9
 * - di.cleanupOrphanedBranches     — mocked for V8, V9 (new SC-004.2 coverage)
 * - swarmState.opencodeClient     — mocked for V7, V8, V9 (SDK client substitution)
 *
 * Gaps / known limitations:
 * - cleanupOrphanedBranches is mocked at the _internals seam; Bun's v1.3.11
 *   mock.restore() does NOT reliably restore mock.module cross-file mocks, but
 *   _internals reassignment is a direct object-property write and is reliably
 *   undone in each finally{} block above — no cross-file pollution risk.
 * - The fake OpenCode SDK client (swarmState.opencodeClient) returns a fixed
 *   session ID; real session-creation failure paths are not exercised here.
 */
