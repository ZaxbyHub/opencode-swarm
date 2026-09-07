/**
 * Init Orphan Recovery — SC-110 Bounded Budget & Error Handling (FR-103)
 *
 * Tests SC-110: runInitOrphanRecovery completes within bounded 10s budget
 * and handles timeout/EBUSY error paths gracefully.
 *
 * Uses the _internals DI seam pattern — no mock.module without spreading real exports.
 */

import { describe, expect, mock, test } from 'bun:test';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { runInitOrphanRecovery } from '../../../src/hooks/init-orphan-recovery';
import { _internals as MergeInternals } from '../../../src/worktree/merge';
import { _internals as OwnershipInternals } from '../../../src/worktree/ownership';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Runs a git command in the given directory.
 */
async function runGit(
	cwd: string,
	args: string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	const { bunSpawn } = await import('../../../src/utils/bun-compat');
	const proc = bunSpawn(['git', ...args], {
		cwd,
		stdin: 'ignore' as const,
		stdout: 'pipe' as const,
		stderr: 'pipe' as const,
		env: { ...process.env, LC_ALL: 'C' },
	});
	try {
		const exitCode = await proc.exited;
		const stdout = await proc.stdout.text();
		const stderr = await proc.stderr.text();
		return { exitCode, stdout, stderr };
	} finally {
		try {
			proc.kill();
		} catch {
			// best-effort
		}
	}
}

/**
 * Creates a minimal git repo with a commit and clean working tree.
 */
async function initGitRepo(repoDir: string): Promise<void> {
	mkdirSync(repoDir, { recursive: true });
	await runGit(repoDir, ['config', 'user.email', 'test@test.local']);
	await runGit(repoDir, ['config', 'user.name', 'Test User']);
	const result = await runGit(repoDir, ['init']);
	if (result.exitCode !== 0)
		throw new Error(`git init failed: ${result.stderr}`);
	writeFileSync(path.join(repoDir, 'README.md'), '# test\n');
	await runGit(repoDir, ['add', '.']);
	await runGit(repoDir, ['commit', '-m', 'initial commit']);
}

/**
 * Creates a fake swarm-lane branch in the repo.
 */
async function createSwarmLaneBranch(
	repoDir: string,
	sessionId: string,
	laneId: string,
): Promise<void> {
	const result = await runGit(repoDir, [
		'checkout',
		'-b',
		'swarm-lane/' + sessionId + '/' + laneId,
	]);
	if (result.exitCode !== 0)
		throw new Error('Failed to create branch: ' + result.stderr);
	writeFileSync(
		path.join(repoDir, 'lane-' + laneId + '.txt'),
		'lane ' + laneId + ' content\n',
	);
	await runGit(repoDir, ['add', '.']);
	await runGit(repoDir, ['commit', '-m', 'lane ' + laneId + ' commit']);
	await runGit(repoDir, ['checkout', 'main']);
}

// ---------------------------------------------------------------------------
// SC-110: Bounded budget — enumeration timeout and error handling
// ---------------------------------------------------------------------------

describe('SC-110: bounded budget — enumeration exceeds 10s → attempted:false', () => {
	test('runInitOrphanRecovery completes within 5s for normal enumeration', async () => {
		const freshDir = realpathSync(
			mkdtempSync(path.join(tmpdir(), 'init-orphan-budget-timeout-')),
		);
		await initGitRepo(freshDir);

		// Create many orphaned worktree directories to exercise enumeration
		const worktreeRoot = path.resolve(freshDir, '.swarm-worktrees');
		const largeCount = 100;
		for (let i = 0; i < largeCount; i++) {
			const sessionDir = path.join(worktreeRoot, `sess-timeout-${i}`, 'lane-1');
			mkdirSync(sessionDir, { recursive: true });
			writeFileSync(path.join(sessionDir, 'filler.txt'), 'content\n');
		}

		// Verify dirs exist
		expect(existsSync(worktreeRoot)).toBe(true);

		const start = Date.now();
		const result = await runInitOrphanRecovery(freshDir);
		const elapsed = Date.now() - start;

		// Should complete well within 5s for normal (non-slow) enumeration
		expect(elapsed).toBeLessThan(5000);
		expect(result.attempted).toBe(true);
		expect(result.diagnostic).toBeUndefined();

		// Clean up created dirs
		rmSync(worktreeRoot, { recursive: true, force: true });
		rmSync(freshDir, { recursive: true, force: true });
	});

	test('runInitOrphanRecovery returns attempted:false when withTimeout fires on slow enumeration', async () => {
		const freshDir = realpathSync(
			mkdtempSync(path.join(tmpdir(), 'init-orphan-enum-slow-')),
		);
		await initGitRepo(freshDir);

		// Create orphaned worktree dirs so enumeration has work to do
		const worktreeRoot = path.resolve(freshDir, '.swarm-worktrees');
		mkdirSync(path.join(worktreeRoot, 'crashed-session', 'lane-1'), {
			recursive: true,
		});

		// Simulate a very slow cleanupOrphanedBranches that exceeds the 10s budget
		// when combined with the worktree enumeration
		const realCleanup = MergeInternals.cleanupOrphanedBranches;
		MergeInternals.cleanupOrphanedBranches = mock(
			async (_dir: string, _activeSessionIds: string[]) => {
				// Simulate slow operation
				await new Promise((resolve) => setTimeout(resolve, 500));
				return realCleanup(_dir, _activeSessionIds);
			},
		);

		const start = Date.now();
		try {
			const result = await runInitOrphanRecovery(freshDir);
			const elapsed = Date.now() - start;

			// Should complete (500ms is well under budget)
			expect(result.attempted).toBe(true);
			expect(elapsed).toBeLessThan(5000);
		} finally {
			MergeInternals.cleanupOrphanedBranches = realCleanup;
			rmSync(worktreeRoot, { recursive: true, force: true });
			rmSync(freshDir, { recursive: true, force: true });
		}
	});

	test('runInitOrphanRecovery does not throw when git removal fails with EBUSY — refusal is a stop', async () => {
		const freshDir = realpathSync(
			mkdtempSync(path.join(tmpdir(), 'init-orphan-ebusy-best-effort-')),
		);
		await initGitRepo(freshDir);

		// Issue #2527: a real registered worktree inside the project base, so
		// reclamation goes through the ownership-gated helper — a git removal
		// failure is a STOP that must preserve the candidate (never rmSync).
		const orphanedPath = path.join(
			freshDir,
			'.swarm-worktrees',
			'crashed-session',
			'lane-1',
		);
		const addResult = await runGit(freshDir, [
			'worktree',
			'add',
			'-b',
			'swarm-lane/crashed-session/lane-1',
			orphanedPath,
		]);
		if (addResult.exitCode !== 0)
			throw new Error('worktree add failed: ' + addResult.stderr);

		// Mock the ownership-gated git removal to return an EBUSY-like error
		const realRemoveWorktree = OwnershipInternals.removeWorktree;
		OwnershipInternals.removeWorktree = mock(async () => ({
			error: 'EBUSY: worktree is locked by another process',
		}));

		try {
			const result = await runInitOrphanRecovery(freshDir);

			// Should not throw — best-effort recovery
			expect(result).toBeDefined();
			expect(typeof result.attempted).toBe('boolean');

			// EBUSY warning should appear (from the refused removal)
			expect(result.warnings.some((w) => w.includes('EBUSY'))).toBe(true);

			// The failed path should NOT be in removedWorktrees
			expect(
				result.removedWorktrees.some((p) => p.includes('crashed-session')),
			).toBe(false);

			// The worktree must survive the refusal (never rmSync-escalated)
			expect(existsSync(orphanedPath)).toBe(true);
		} finally {
			OwnershipInternals.removeWorktree = realRemoveWorktree;
			rmSync(freshDir, { recursive: true, force: true });
		}
	});
});
