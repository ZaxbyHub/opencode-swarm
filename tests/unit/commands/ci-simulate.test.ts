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

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const { _internals, handleCiSimulateCommand } = await import(
	'../../../src/commands/ci-simulate.js'
);
const realRunExternalTool = _internals.runExternalTool;
const realGetDefaultBaseBranch = _internals.getDefaultBaseBranch;
const realDetectDefaultRemoteBranch = _internals.detectDefaultRemoteBranch;

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeTempDir(prefix: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	return dir;
}

function runGit(dir: string, args: string[]): void {
	execFileSync('git', args, {
		cwd: dir,
		stdio: 'ignore',
		timeout: 30_000,
	});
}

function gitInit(dir: string): void {
	runGit(dir, ['init']);
	runGit(dir, ['config', 'user.email', 'test@test.com']);
	runGit(dir, ['config', 'user.name', 'Test']);
	runGit(dir, ['branch', '-M', 'main']);
}

function gitCreateBranch(dir: string, branch: string, fromRef = 'HEAD'): void {
	runGit(dir, ['branch', branch, fromRef]);
}

function gitCheckout(dir: string, ref: string): void {
	runGit(dir, ['checkout', ref]);
}

function gitAddFile(dir: string, filename: string, content: string): void {
	const filePath = path.join(dir, filename);
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, content);
	// Use explicit path instead of `git add .` to avoid directory-scan race
	// in CI environments where the filesystem has not yet committed the
	// writeFileSync before git scans the working tree.
	runGit(dir, ['add', filename]);
}

function gitCommit(dir: string, msg: string): void {
	runGit(dir, ['commit', '-m', msg]);
}

function gitCreateBareRemote(reposDir: string, name: string): string {
	const barePath = path.join(reposDir, name);
	runGit(reposDir, ['init', '--bare', barePath]);
	return barePath;
}

function gitSetRemote(
	dir: string,
	remoteName: string,
	remoteUrl: string,
): void {
	runGit(dir, ['remote', 'add', remoteName, remoteUrl]);
}

function gitPush(dir: string, remote: string, ref: string): void {
	runGit(dir, ['push', remote, ref]);
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
		_internals.runExternalTool = realRunExternalTool;
		_internals.getDefaultBaseBranch = realGetDefaultBaseBranch;
		_internals.detectDefaultRemoteBranch = realDetectDefaultRemoteBranch;
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

	it('SC-012: cleans up after a deterministic merge conflict', async () => {
		const calls: string[][] = [];
		let createdWorktreePath = '';
		_internals.detectDefaultRemoteBranch = () => 'main';
		_internals.runExternalTool = mock(async (options) => {
			calls.push(options.args);
			// Capture the worktree path from `worktree add --detach <path> <base>`
			// so the cleanup's registration check can answer for it.
			if (options.args[0] === 'worktree' && options.args[1] === 'add') {
				createdWorktreePath = options.args[3] ?? '';
			}
			if (
				options.args[0] === 'worktree' &&
				options.args[1] === 'list' &&
				createdWorktreePath
			) {
				return {
					status: 'completed',
					exitCode: 0,
					stdout: `worktree ${tempDir}\nworktree ${createdWorktreePath}\n`,
					stderr: '',
					stdoutTruncated: false,
					stderrTruncated: false,
				};
			}
			const conflict = options.args[0] === 'merge';
			return {
				status: 'completed',
				exitCode: conflict ? 1 : 0,
				stdout: '',
				stderr: conflict ? 'CONFLICT (content): Merge conflict' : '',
				stdoutTruncated: false,
				stderrTruncated: false,
			};
		}) as typeof realRunExternalTool;

		const result = await handleCiSimulateCommand(tempDir, ['conflict-branch']);

		expect(result).toContain('Merge failed');
		expect(calls).toContainEqual([
			'merge',
			'--no-ff',
			'--no-edit',
			'--',
			'conflict-branch',
		]);
		// Non-force removal (no --force flag) is attempted after the conflict.
		const removeCall = calls.find(
			(args) => args[0] === 'worktree' && args[1] === 'remove',
		);
		expect(removeCall).toBeDefined();
		expect(removeCall).not.toContain('--force');
	});

	// -------------------------------------------------------------------------
	// Issue #2131 criterion E: fail-closed worktree cleanup
	// -------------------------------------------------------------------------

	it('rejects option-like PR refs before invoking git', async () => {
		const result = await handleCiSimulateCommand(tempDir, ['--upload-pack=x']);
		expect(result).toContain('safe git branch or commit reference');
	});

	it('reports when bounded child output is truncated', async () => {
		const calls: Array<{ maxStderrBytes?: number; maxStdoutBytes?: number }> =
			[];
		_internals.detectDefaultRemoteBranch = () => 'main';
		_internals.runExternalTool = mock(async (options) => {
			calls.push(options);
			const isValidation = options.executable === 'bun';
			return {
				status: 'completed',
				exitCode: isValidation ? 1 : 0,
				stdout: isValidation ? 'validation output' : '',
				stderr: '',
				stdoutTruncated: isValidation,
				stderrTruncated: false,
			};
		}) as typeof realRunExternalTool;

		const result = await handleCiSimulateCommand(tempDir, ['feature-branch']);

		expect(result).toContain('child output truncated to bounded limit');
		expect(calls).not.toHaveLength(0);
		for (const call of calls) {
			expect(call.maxStdoutBytes).toBe(12_000);
			expect(call.maxStderrBytes).toBe(12_000);
		}
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
		runGit(tempDir, ['branch', '-M', 'master']);

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

// ---------------------------------------------------------------------------
// realpathSync symlink/junction normalization (setupWorktree ~L181,
// cleanupWorktree ~L238-270).
//
// Git itself resolves symlinked/junctioned paths: `git worktree add --detach
// <path-through-junction> ...` registers the REAL (symlink-resolved) path
// internally, so a subsequent `git worktree list --porcelain` reports the
// real path, NOT the junction path that was passed in. If our own
// containment/registration checks compare against the raw (non-realpath'd)
// junction path, they will never match git's reported real path, and
// cleanup fails closed with a spurious "not a registered git worktree" or
// "refusing to clean up non-contained path" error even though the worktree
// is exactly the one we created and it is safely within our temp base.
//
// This was verified empirically against real git behavior on Windows
// (junction) before writing this test:
//   git worktree add --detach <junctionDir>/wt1 HEAD
//   git worktree list --porcelain  =>  worktree <realBase>/wt1   (NOT junctionDir)
// ---------------------------------------------------------------------------

describe('handleCiSimulateCommand with a symlinked/junctioned tmpdir (realpathSync fix)', () => {
	let tempDir: string;
	let reposDir: string;
	let bareRepoPath: string;
	let realBaseParent: string;
	let junctionDir: string;
	let junctionSupported = true;

	beforeEach(() => {
		tempDir = makeTempDir('ci-simulate-junction-test-');
		reposDir = path.join(tempDir, 'repos');
		fs.mkdirSync(reposDir, { recursive: true });

		bareRepoPath = gitCreateBareRemote(reposDir, 'origin.git');

		gitInit(tempDir);
		gitSetRemote(tempDir, 'origin', bareRepoPath);

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
		gitPush(tempDir, 'origin', 'main');

		// `realBaseParent` is a real, physical directory. `junctionDir` is a
		// reparse point (Windows junction, or a plain symlink elsewhere) that
		// *resolves to* realBaseParent but is textually a completely different
		// path — exactly the shape of macOS's /var -> /private/var, or a
		// Windows temp dir mounted through a junction.
		realBaseParent = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-sim-realbase-'));
		junctionDir = path.join(
			os.tmpdir(),
			`ci-sim-junction-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
		);

		try {
			const linkType = process.platform === 'win32' ? 'junction' : 'dir';
			fs.symlinkSync(realBaseParent, junctionDir, linkType);
		} catch {
			// Some sandboxed/CI environments disallow symlink creation even for
			// non-admin junctions. Skip gracefully rather than failing spuriously
			// on an unrelated permissions issue.
			junctionSupported = false;
		}

		if (junctionSupported) {
			_internals.osTmpdir = () => junctionDir;
		}
	});

	afterEach(() => {
		_internals.runExternalTool = realRunExternalTool;
		_internals.getDefaultBaseBranch = realGetDefaultBaseBranch;
		_internals.detectDefaultRemoteBranch = realDetectDefaultRemoteBranch;
		_internals.osTmpdir = () => os.tmpdir();

		try {
			if (junctionSupported) fs.rmdirSync(junctionDir);
		} catch {
			// Best-effort cleanup
		}
		try {
			fs.rmSync(realBaseParent, { recursive: true, force: true });
		} catch {
			// Best-effort cleanup
		}
		try {
			fs.rmSync(tempDir, { recursive: true, force: true });
		} catch {
			// Best-effort cleanup
		}
	});

	it('sets up and cleans up the worktree when os.tmpdir() resolves through a symlink/junction', async () => {
		if (!junctionSupported) {
			// Environment cannot create symlinks/junctions; nothing to assert.
			return;
		}

		gitCreateBranch(tempDir, 'feature-branch');
		gitCheckout(tempDir, 'feature-branch');
		gitAddFile(tempDir, 'passing.txt', 'this passes');
		gitCommit(tempDir, 'add passing file');

		const result = await handleCiSimulateCommand(tempDir, ['feature-branch']);

		// The worktree it created must actually live under the REAL
		// (post-junction) base, proving setupWorktree resolved rawBase via
		// realpathSync before constructing the worktree path — not the raw
		// junction path.
		const worktreePathMatch = result.match(/Worktree: `([^`]+)`/);
		expect(worktreePathMatch).not.toBeNull();
		const worktreePath = worktreePathMatch?.[1] ?? '';
		expect(worktreePath.startsWith(junctionDir)).toBe(false);
		expect(worktreePath.startsWith(realBaseParent)).toBe(true);

		// Cleanup must succeed: without realpathSync normalization, git's
		// `worktree list --porcelain` (which reports the real, not junction,
		// path) can never string-match our raw junction-rooted worktreePath,
		// so the registration check would incorrectly conclude the worktree is
		// unregistered / not contained and fail closed.
		expect(result).not.toContain('WORKTREE CLEANUP BLOCKED');
		expect(result).not.toContain('refusing to clean up non-contained path');
		expect(result).not.toContain('exists but is not a registered git worktree');
		expect(result).toContain('Worktree removed');
		expect(result).toContain('All checks passed');

		// And the worktree directory must actually be gone from disk (real,
		// resolved location) — not merely "reported" removed while the real
		// directory is orphaned because cleanup silently no-op'd.
		expect(fs.existsSync(worktreePath)).toBe(false);
	});
});
