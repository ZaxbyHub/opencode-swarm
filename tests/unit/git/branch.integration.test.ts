/**
 * Real-git integration tests for src/git/branch.ts
 *
 * These tests use REAL git via real child_process.spawnSync (no mock.module).
 * Temp directories are created and cleaned up for each test.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as child_process from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	type ConfirmedGitAlignment,
	getGitRepositoryStatus,
	isGitRepo,
	resetToMainAfterMerge,
} from '../../../src/git/branch';
import {
	publishWorktreeRecoveryAuthority,
	removeWorktreeRecoveryAuthority,
} from '../../../src/hooks/delegation-gate/worktree-recovery-authority';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

function runGit(cwd: string, args: string[]): void {
	let lastResult: child_process.SpawnSyncReturns<string> | null = null;
	for (let attempt = 0; attempt < 3; attempt++) {
		const result = child_process.spawnSync('git', args, {
			cwd,
			encoding: 'utf-8',
			timeout: 30_000,
			stdio: ['ignore', 'pipe', 'pipe'],
			windowsHide: true,
		});
		if (result.status === 0) return;
		lastResult = result;
		if (
			result.error === undefined &&
			result.signal === null &&
			result.status !== null
		) {
			break;
		}
	}
	throw new Error(
		`git ${args.join(' ')} failed: status=${lastResult?.status ?? 'null'} signal=${lastResult?.signal ?? 'null'} error=${lastResult?.error?.message ?? 'none'} stderr=${lastResult?.stderr ?? ''}`,
	);
}

function runGitOutput(cwd: string, args: string[]): string {
	const result = child_process.spawnSync('git', args, {
		cwd,
		encoding: 'utf-8',
		timeout: 30_000,
		stdio: ['ignore', 'pipe', 'pipe'],
		windowsHide: true,
	});
	if (result.status !== 0) {
		throw new Error(
			`git ${args.join(' ')} failed: status=${result.status} stderr=${result.stderr ?? ''}`,
		);
	}
	return (result.stdout ?? '').trim();
}

describe('Git branch integration tests (real git)', () => {
	let gitDir: string;
	let nonGitDir: string;

	beforeEach(() => {
		// Create a real temp git directory
		gitDir = canonicalMkdtemp('git-repo-test-');
		// Initialize it as a real git repo using real spawnSync
		runGit(gitDir, ['init']);
		// Configure git user for this repo (required for commits)
		runGit(gitDir, ['config', 'user.email', 'test@test.com']);
		runGit(gitDir, ['config', 'user.name', 'Test User']);

		// Create a real temp non-git directory
		nonGitDir = canonicalMkdtemp('non-git-dir-test-');
	});

	afterEach(() => {
		// Clean up git directory
		try {
			fs.rmSync(gitDir, { recursive: true, force: true });
		} catch {
			// Ignore cleanup errors on Windows
		}
		// Clean up non-git directory
		try {
			fs.rmSync(nonGitDir, { recursive: true, force: true });
		} catch {
			// Ignore cleanup errors on Windows
		}
	});

	test('isGitRepo returns true for a real git repository', () => {
		// Make an initial commit so HEAD exists; getGitRepositoryStatus (which
		// isGitRepo delegates to) requires a HEAD reference to confirm a repo.
		runGit(gitDir, ['commit', '--allow-empty', '-m', 'init']);

		const result = isGitRepo(gitDir);
		expect(result).toBe(true);
	});

	test('getGitRepositoryStatus reports isRepo true for a real git repository', () => {
		// Same setup as the isGitRepo test, but exercises the new status API
		// directly to confirm the underlying probe agrees with the wrapper.
		runGit(gitDir, ['commit', '--allow-empty', '-m', 'init']);

		const status = getGitRepositoryStatus(gitDir);
		expect(status.isRepo).toBe(true);
	});

	test('isGitRepo returns false for a non-git directory', () => {
		const result = isGitRepo(nonGitDir);
		expect(result).toBe(false);
	});

	test('confirmed divergent retained branch uses exact deletion and authority cleanup', async () => {
		const remoteDir = canonicalMkdtemp('git-remote-test-');
		runGit(remoteDir, ['init', '--bare']);
		runGit(gitDir, ['branch', '-M', 'main']);
		runGit(gitDir, ['commit', '--allow-empty', '-m', 'main']);
		runGit(gitDir, ['remote', 'add', 'origin', remoteDir]);
		runGit(gitDir, ['push', '-u', 'origin', 'main']);
		runGit(gitDir, ['checkout', '-b', 'feature']);
		fs.writeFileSync(path.join(gitDir, 'feature.txt'), 'feature\n');
		runGit(gitDir, ['add', 'feature.txt']);
		runGit(gitDir, ['commit', '-m', 'feature']);
		runGit(gitDir, ['push', '-u', 'origin', 'feature']);
		runGit(gitDir, ['checkout', '-b', 'lane/review']);
		fs.writeFileSync(path.join(gitDir, 'lane.txt'), 'lane\n');
		runGit(gitDir, ['add', 'lane.txt']);
		runGit(gitDir, ['commit', '-m', 'divergent retained lane']);
		const laneTip = runGitOutput(gitDir, ['rev-parse', 'HEAD']);
		runGit(gitDir, ['checkout', 'feature']);
		fs.mkdirSync(path.join(gitDir, '.swarm'), { recursive: true });
		const published = publishWorktreeRecoveryAuthority(gitDir, {
			originalCallID: 'real-git-retained',
			parentSessionId: 'real-git-session',
			taskId: 'retained',
			reservationId: 'real-git-reservation',
			generation: 1,
			canonicalBranch: 'main',
			canonicalPath: gitDir,
			laneBranch: 'lane/review',
			lanePath: path.join(gitDir, '.swarm-worktrees', 'lane/review'),
			expectedPrimaryHead: runGitOutput(gitDir, ['rev-parse', 'origin/main']),
			sourceBaseOid: 'a'.repeat(40),
			sourceHeadOid: laneTip,
			targetHeadOid: runGitOutput(gitDir, ['rev-parse', 'origin/main']),
			strategy: 'squash',
			resultTree: laneTip,
			changedPaths: ['lane.txt'],
		});
		expect(published.ok).toBe(true);
		if (!published.ok) return;
		const plan: ConfirmedGitAlignment = Object.freeze({
			defaultBranch: 'main',
			targetRef: 'origin/main',
			targetSha: runGitOutput(gitDir, ['rev-parse', 'origin/main']),
			targetAvailable: true,
			currentBranch: 'feature',
			currentHeadSha: runGitOutput(gitDir, ['rev-parse', 'HEAD']),
			branchCandidates: Object.freeze([
				Object.freeze({
					name: 'lane/review',
					tipSha: laneTip,
					reason: 'retained squash recovery branch',
				}),
			]),
			retainedRecoveryAuthorities: Object.freeze([
				Object.freeze({
					authorityDigest: published.authority.authorityDigest,
					branchName: 'lane/review',
					branchTipSha: laneTip,
				}),
			]),
		});

		const aligned = await resetToMainAfterMerge(gitDir, {
			confirmedPlan: plan,
			pruneBranches: true,
		});
		expect(aligned.success).toBe(true);
		expect(() =>
			runGit(gitDir, ['rev-parse', '--verify', 'refs/heads/lane/review']),
		).toThrow();
		const removed = removeWorktreeRecoveryAuthority(gitDir, {
			authorityDigest: published.authority.authorityDigest,
			branchName: 'lane/review',
			branchTipSha: laneTip,
			resultTree: laneTip,
			changedPaths: ['lane.txt'],
			readBranchTip: () => {
				try {
					return runGitOutput(gitDir, ['rev-parse', 'refs/heads/lane/review']);
				} catch {
					return undefined;
				}
			},
		});
		expect(removed).toEqual({ ok: true });
		fs.rmSync(remoteDir, { recursive: true, force: true });
	});

	test('confirmed retained tip mismatch preserves the divergent branch and authority', async () => {
		const remoteDir = canonicalMkdtemp('git-remote-mismatch-test-');
		runGit(remoteDir, ['init', '--bare']);
		runGit(gitDir, ['branch', '-M', 'main']);
		runGit(gitDir, ['commit', '--allow-empty', '-m', 'main']);
		runGit(gitDir, ['remote', 'add', 'origin', remoteDir]);
		runGit(gitDir, ['push', '-u', 'origin', 'main']);
		runGit(gitDir, ['checkout', '-b', 'feature']);
		runGit(gitDir, ['push', '-u', 'origin', 'feature']);
		runGit(gitDir, ['checkout', '-b', 'lane/review']);
		fs.writeFileSync(path.join(gitDir, 'lane.txt'), 'lane\n');
		runGit(gitDir, ['add', 'lane.txt']);
		runGit(gitDir, ['commit', '-m', 'divergent retained lane']);
		const laneTip = runGitOutput(gitDir, ['rev-parse', 'HEAD']);
		runGit(gitDir, ['checkout', 'feature']);
		const wrongTip = '0'.repeat(40);
		const plan: ConfirmedGitAlignment = Object.freeze({
			defaultBranch: 'main',
			targetRef: 'origin/main',
			targetSha: runGitOutput(gitDir, ['rev-parse', 'origin/main']),
			targetAvailable: true,
			currentBranch: 'feature',
			currentHeadSha: runGitOutput(gitDir, ['rev-parse', 'HEAD']),
			branchCandidates: Object.freeze([
				Object.freeze({
					name: 'lane/review',
					tipSha: wrongTip,
					reason: 'retained squash recovery branch',
				}),
			]),
			retainedRecoveryAuthorities: Object.freeze([]),
		});

		const aligned = await resetToMainAfterMerge(gitDir, {
			confirmedPlan: plan,
			pruneBranches: true,
		});
		expect(aligned.success).toBe(true);
		expect(runGitOutput(gitDir, ['rev-parse', 'refs/heads/lane/review'])).toBe(
			laneTip,
		);
		fs.rmSync(remoteDir, { recursive: true, force: true });
	});
});
