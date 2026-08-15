/**
 * Tests for ci-simulate realpathSync symlink/junction normalization.
 *
 * Split from ci-simulate.test.ts to satisfy FR-006 line-cap ratchet.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
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
// Test helpers (duplicated from ci-simulate.test.ts — kept minimal)
// ---------------------------------------------------------------------------

function makeTempDir(prefix: string): string {
	const tmp = fs.realpathSync.native(os.tmpdir());
	return fs.realpathSync.native(fs.mkdtempSync(path.join(tmp, prefix)));
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
	fs.writeFileSync(
		path.join(dir, 'example.test.ts'),
		'// minimal test file\nexport {};\n',
	);
}

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

		const tmpBase = fs.realpathSync.native(os.tmpdir());
		realBaseParent = fs.realpathSync.native(
			fs.mkdtempSync(path.join(tmpBase, 'ci-sim-realbase-')),
		);
		junctionDir = path.join(
			tmpBase,
			`ci-sim-junction-${process.hrtime.bigint()}`,
		);

		try {
			const linkType = process.platform === 'win32' ? 'junction' : 'dir';
			fs.symlinkSync(realBaseParent, junctionDir, linkType);
		} catch {
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

	it('sets up and cleans up the worktree when the temp dir resolves through a symlink/junction', async () => {
		if (!junctionSupported) {
			return;
		}

		gitCreateBranch(tempDir, 'feature-branch');
		gitCheckout(tempDir, 'feature-branch');
		gitAddFile(tempDir, 'passing.txt', 'this passes');
		gitCommit(tempDir, 'add passing file');

		const result = await handleCiSimulateCommand(tempDir, ['feature-branch']);

		const worktreePathMatch = result.match(/Worktree: `([^`]+)`/);
		expect(worktreePathMatch).not.toBeNull();
		const worktreePath = worktreePathMatch?.[1] ?? '';
		const ci = (s: string) => s.toLowerCase();
		expect(ci(worktreePath).startsWith(ci(junctionDir))).toBe(false);
		expect(ci(worktreePath).startsWith(ci(realBaseParent))).toBe(true);

		expect(result).not.toContain('WORKTREE CLEANUP BLOCKED');
		expect(result).not.toContain('refusing to clean up non-contained path');
		expect(result).not.toContain('exists but is not a registered git worktree');
		expect(result).toContain('Worktree removed');
		expect(result).toContain('All checks passed');

		expect(fs.existsSync(worktreePath)).toBe(false);
	});
});
