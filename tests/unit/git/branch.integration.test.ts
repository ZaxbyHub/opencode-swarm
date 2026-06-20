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

describe('Git branch integration tests (real git)', () => {
	let gitDir: string;
	let nonGitDir: string;

	beforeEach(() => {
		// Create a real temp git directory
		gitDir = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), 'git-repo-test-')),
		);
		// Initialize it as a real git repo using real spawnSync
		const initResult = child_process.spawnSync('git', ['init'], {
			cwd: gitDir,
			encoding: 'utf-8',
			timeout: 30_000,
			stdio: ['ignore', 'pipe', 'pipe'],
			windowsHide: true,
		});
		if (initResult.status !== 0) {
			throw new Error(`git init failed: ${initResult.stderr}`);
		}
		// Configure git user for this repo (required for commits)
		child_process.spawnSync('git', ['config', 'user.email', 'test@test.com'], {
			cwd: gitDir,
			encoding: 'utf-8',
			timeout: 30_000,
			stdio: ['ignore', 'pipe', 'pipe'],
			windowsHide: true,
		});
		child_process.spawnSync('git', ['config', 'user.name', 'Test User'], {
			cwd: gitDir,
			encoding: 'utf-8',
			timeout: 30_000,
			stdio: ['ignore', 'pipe', 'pipe'],
			windowsHide: true,
		});

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
		child_process.spawnSync('git', ['commit', '--allow-empty', '-m', 'init'], {
			cwd: gitDir,
			encoding: 'utf-8',
			timeout: 30_000,
			stdio: ['ignore', 'pipe', 'pipe'],
			windowsHide: true,
		});

		const result = isGitRepo(gitDir);
		expect(result).toBe(true);
	});

	test('getGitRepositoryStatus reports isRepo true for a real git repository', () => {
		// Same setup as the isGitRepo test, but exercises the new status API
		// directly to confirm the underlying probe agrees with the wrapper.
		child_process.spawnSync('git', ['commit', '--allow-empty', '-m', 'init'], {
			cwd: gitDir,
			encoding: 'utf-8',
			timeout: 30_000,
			stdio: ['ignore', 'pipe', 'pipe'],
			windowsHide: true,
		});

		const status = getGitRepositoryStatus(gitDir);
		expect(status.isRepo).toBe(true);
	});

	test('isGitRepo returns false for a non-git directory', () => {
		const result = isGitRepo(nonGitDir);
		expect(result).toBe(false);
	});
});
