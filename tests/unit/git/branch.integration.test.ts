/**
 * Real-git integration tests for src/git/branch.ts
 *
 * These tests use REAL git via real child_process.spawnSync (no mock.module).
 * Temp directories are created and cleaned up for each test.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as child_process from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { getGitRepositoryStatus, isGitRepo } from '../../../src/git/branch';

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

describe('Git branch integration tests (real git)', () => {
	let gitDir: string;
	let nonGitDir: string;

	beforeEach(() => {
		// Create a real temp git directory
		gitDir = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), 'git-repo-test-')),
		);
		// Initialize it as a real git repo using real spawnSync
		runGit(gitDir, ['init']);
		// Configure git user for this repo (required for commits)
		runGit(gitDir, ['config', 'user.email', 'test@test.com']);
		runGit(gitDir, ['config', 'user.name', 'Test User']);

		// Create a real temp non-git directory
		nonGitDir = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), 'non-git-dir-test-')),
		);
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
});
