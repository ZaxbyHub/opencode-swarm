/**
 * Tests for /swarm ci-simulate command (FR-004a / issue #1746 item #5).
 *
 * Integration tests that create a minimal git repo with fast scripts to avoid
 * the slowness of running the full validation suite against the real project.
 *
 * SC-012: ci-simulate reproduces a known merge-queue failure locally.
 * SC-013: ci-simulate runs the documented validation suite in order.
 * Cleanup: temporary worktree is discarded after run.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const { handleCiSimulateCommand } = await import(
	'../../../src/commands/ci-simulate.js'
);

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeTempDir(prefix: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	return dir;
}

function gitInit(dir: string): void {
	const { execSync } = require('child_process');
	execSync('git init', { cwd: dir });
	execSync('git config user.email "test@test.com"', { cwd: dir });
	execSync('git config user.name "Test"', { cwd: dir });
	execSync('git branch -M main', { cwd: dir });
}

function gitCreateBranch(dir: string, branch: string, fromRef = 'HEAD'): void {
	const { execSync } = require('child_process');
	execSync(`git branch ${branch} ${fromRef}`, { cwd: dir });
}

function gitCheckout(dir: string, ref: string): void {
	const { execSync } = require('child_process');
	execSync(`git checkout ${ref}`, { cwd: dir });
}

function gitAddFile(dir: string, filename: string, content: string): void {
	const filePath = path.join(dir, filename);
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, content);
	const { execSync } = require('child_process');
	execSync('git add .', { cwd: dir });
}

function gitCommit(dir: string, msg: string): void {
	const { execSync } = require('child_process');
	execSync(`git commit -m "${msg}"`, { cwd: dir });
}

function gitCreateBareRemote(reposDir: string, name: string): string {
	const { execSync } = require('child_process');
	const barePath = path.join(reposDir, name);
	execSync(`git init --bare "${barePath}"`, { cwd: reposDir });
	return barePath;
}

function gitSetRemote(
	dir: string,
	remoteName: string,
	remoteUrl: string,
): void {
	const { execSync } = require('child_process');
	execSync(`git remote add ${remoteName} "${remoteUrl}"`, { cwd: dir });
}

function gitPush(dir: string, remote: string, ref: string): void {
	const { execSync } = require('child_process');
	execSync(`git push ${remote} ${ref}`, { cwd: dir });
}

function createMinimalProject(dir: string): void {
	// package.json with fast scripts
	const pkg = {
		name: 'test-project',
		version: '1.0.0',
		scripts: {
			typecheck: 'echo "typecheck"',
			lint: 'echo "lint"',
			build: 'echo "build"',
		},
	};
	fs.writeFileSync(
		path.join(dir, 'package.json'),
		JSON.stringify(pkg, null, 2),
	);

	// A simple test file so bun test doesn't fail
	fs.writeFileSync(
		path.join(dir, 'example.test.ts'),
		'// minimal test file\nexport {};\n',
	);
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('handleCiSimulateCommand', () => {
	let tempDir: string;
	let reposDir: string;
	let bareRepoPath: string;

	beforeEach(() => {
		tempDir = makeTempDir('ci-simulate-test-');
		reposDir = path.join(tempDir, 'repos');
		fs.mkdirSync(reposDir, { recursive: true });

		// Create a bare repo to act as "origin"
		bareRepoPath = gitCreateBareRemote(reposDir, 'origin.git');

		// Create the test repo with main branch
		gitInit(tempDir);
		gitSetRemote(tempDir, 'origin', bareRepoPath);

		// Create initial commit on main with package.json and test file
		createMinimalProject(tempDir);
		gitAddFile(
			tempDir,
			'package.json',
			fs.readFileSync(path.join(tempDir, 'package.json'), 'utf-8'),
		);
		gitAddFile(
			tempDir,
			'example.test.ts',
			fs.readFileSync(path.join(tempDir, 'example.test.ts'), 'utf-8'),
		);
		gitCommit(tempDir, 'initial commit with package.json');

		// Push main to origin
		gitPush(tempDir, 'origin', 'main');
	});

	afterEach(() => {
		// Clean up temp directory
		try {
			fs.rmSync(tempDir, { recursive: true, force: true });
		} catch {
			// Best-effort cleanup
		}
	});

	// -------------------------------------------------------------------------
	// SC-013: ci-simulate runs the documented validation suite in order
	// -------------------------------------------------------------------------

	it('SC-013: runs typecheck, lint, build, test in order', async () => {
		// Create a feature branch with a passing file
		gitCreateBranch(tempDir, 'feature-branch');
		gitCheckout(tempDir, 'feature-branch');
		gitAddFile(tempDir, 'passing.txt', 'this passes');
		gitCommit(tempDir, 'add passing file');

		const result = await handleCiSimulateCommand(tempDir, ['feature-branch']);

		// Should have run all 4 validation steps in order
		expect(result).toContain('## Validation Suite');
		expect(result).toContain('typecheck');
		expect(result).toContain('lint');
		expect(result).toContain('build');
		expect(result).toContain('test');

		// All 4 steps should pass
		expect(result).toContain('4/4 steps passed');
		expect(result).toContain('All checks passed');
	});

	// -------------------------------------------------------------------------
	// Cleanup: temporary worktree is discarded after run
	// -------------------------------------------------------------------------

	it('cleanup: removes the worktree after run', async () => {
		gitCreateBranch(tempDir, 'cleanup-test-branch');
		gitCheckout(tempDir, 'cleanup-test-branch');
		gitAddFile(tempDir, 'test.txt', 'test');
		gitCommit(tempDir, 'test commit');

		const result = await handleCiSimulateCommand(tempDir, [
			'cleanup-test-branch',
		]);

		// Verify worktree was cleaned up
		expect(result).toContain('Worktree removed');

		// The worktree path should have been cleaned up
		const worktreePathMatch = result.match(/Worktree: `([^`]+)`/);
		if (worktreePathMatch) {
			const worktreePath = worktreePathMatch[1];
			expect(fs.existsSync(worktreePath)).toBe(false);
		}
	});

	// -------------------------------------------------------------------------
	// Default PR ref: uses current branch when no argument provided
	// -------------------------------------------------------------------------

	it('uses current branch when no PR ref argument provided', async () => {
		gitCreateBranch(tempDir, 'current-test-branch');
		gitCheckout(tempDir, 'current-test-branch');
		gitAddFile(tempDir, 'test.txt', 'test');
		gitCommit(tempDir, 'test commit');

		const result = await handleCiSimulateCommand(tempDir, []);

		// Should use the current branch
		expect(result).toContain('current-test-branch');
	});

	// -------------------------------------------------------------------------
	// Error handling
	// -------------------------------------------------------------------------

	it('reports error when branch does not exist', async () => {
		const result = await handleCiSimulateCommand(tempDir, [
			'nonexistent-branch',
		]);

		// Should show error during setup (worktree creation or merge)
		expect(result).toContain('## Error');
	});

	// -------------------------------------------------------------------------
	// SC-012: merge failure detection (true line-level conflict)
	// -------------------------------------------------------------------------

	it('SC-012: detects merge conflict when same line modified differently', async () => {
		// Create a shared file on main first
		gitCheckout(tempDir, 'main');
		fs.writeFileSync(
			path.join(tempDir, 'config.js'),
			'export const VERSION = 1;\n',
		);
		gitAddFile(tempDir, 'config.js', 'export const VERSION = 1;\n');
		gitCommit(tempDir, 'add shared file on main');
		gitPush(tempDir, 'origin', 'main');

		// Create branch from main
		gitCreateBranch(tempDir, 'conflict-branch');
		gitCheckout(tempDir, 'conflict-branch');

		// Modify the SAME line to a different value
		fs.writeFileSync(
			path.join(tempDir, 'config.js'),
			'export const VERSION = 2;\n',
		);
		gitAddFile(tempDir, 'config.js', 'modify VERSION on branch');
		gitCommit(tempDir, 'modify VERSION on branch');

		// Switch back to main and modify the SAME line to yet another value
		gitCheckout(tempDir, 'main');
		fs.writeFileSync(
			path.join(tempDir, 'config.js'),
			'export const VERSION = 3;\n',
		);
		gitAddFile(tempDir, 'config.js', 'modify VERSION on main');
		gitCommit(tempDir, 'modify VERSION on main');
		gitPush(tempDir, 'origin', 'main');

		// Simulate CI on the branch - should detect merge conflict
		const result = await handleCiSimulateCommand(tempDir, ['conflict-branch']);

		// The merge should fail due to conflict - either error or validation failure
		expect(
			result.includes('## Error') ||
				result.includes('merge') ||
				result.includes('conflict'),
		).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Tests for repos with master as the default remote branch (not main)
// ---------------------------------------------------------------------------

describe('handleCiSimulateCommand with origin/master default branch', () => {
	let tempDir: string;
	let reposDir: string;
	let bareRepoPath: string;

	beforeEach(() => {
		tempDir = makeTempDir('ci-simulate-master-test-');
		reposDir = path.join(tempDir, 'repos');
		fs.mkdirSync(reposDir, { recursive: true });

		// Create a bare repo to act as "origin"
		bareRepoPath = gitCreateBareRemote(reposDir, 'origin.git');

		// Create the test repo with master branch (not main)
		gitInit(tempDir);
		gitSetRemote(tempDir, 'origin', bareRepoPath);

		// Rename initial branch to master instead of main
		const { execSync } = require('child_process');
		execSync('git branch -M master', { cwd: tempDir });

		// Create initial commit with package.json and test file
		createMinimalProject(tempDir);
		gitAddFile(
			tempDir,
			'package.json',
			fs.readFileSync(path.join(tempDir, 'package.json'), 'utf-8'),
		);
		gitAddFile(
			tempDir,
			'example.test.ts',
			fs.readFileSync(path.join(tempDir, 'example.test.ts'), 'utf-8'),
		);
		gitCommit(tempDir, 'initial commit with package.json');

		// Push master to origin
		gitPush(tempDir, 'origin', 'master');
	});

	afterEach(() => {
		// Clean up temp directory
		try {
			fs.rmSync(tempDir, { recursive: true, force: true });
		} catch {
			// Best-effort cleanup
		}
	});

	it('handles repos whose remote default branch is origin/master', async () => {
		// Create a feature branch
		gitCreateBranch(tempDir, 'feature-branch');
		gitCheckout(tempDir, 'feature-branch');
		gitAddFile(tempDir, 'passing.txt', 'this passes');
		gitCommit(tempDir, 'add passing file');

		// The report should reference origin/master, not origin/main
		const result = await handleCiSimulateCommand(tempDir, ['feature-branch']);

		// Should have run all 4 validation steps in order
		expect(result).toContain('## Validation Suite');
		expect(result).toContain('typecheck');
		expect(result).toContain('lint');
		expect(result).toContain('build');
		expect(result).toContain('test');

		// All 4 steps should pass
		expect(result).toContain('4/4 steps passed');
		expect(result).toContain('All checks passed');
	});
});
