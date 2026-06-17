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
import { isGitRepo } from '../../../src/git/branch';

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
		const result = isGitRepo(gitDir);
		expect(result).toBe(true);
	});

	test('isGitRepo returns false for a non-git directory', () => {
		const result = isGitRepo(nonGitDir);
		expect(result).toBe(false);
	});
});
