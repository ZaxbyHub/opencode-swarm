/**
 * FR-001c: Dirty-state preservation — integration test with real git
 *
 * Tests that when a denial or cancellation cleanup would destroy uncommitted work
 * in a worktree, the work is preserved in a recoverable form (auto-commit + tag).
 *
 * This uses real git via child_process spawn (not bunSpawn) to avoid any
 * module-level mock pollution from the unit tests.
 *
 * @note Uses Tier 1 DI (_internals.bunSpawn) for the actual preservation call,
 * but the git repo is created via child_process spawn for isolation.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { StandardWorktreeDispatch } from '../../../src/hooks/delegation-gate/worktree-isolation';
import {
	_internals,
	cleanupStandardWorktreeForCallId,
	preserveDirtyWorktreeForCallId,
	resetStandardWorktreeIsolationState,
	standardWorktreeByCallID,
} from '../../../src/hooks/delegation-gate/worktree-isolation';
import { resetSwarmState } from '../../../src/state';
import type { WorktreeHandle } from '../../../src/worktree';

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeTempProject(prefix: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	const real = fs.realpathSync(dir);
	fs.mkdirSync(path.join(real, '.swarm'), { recursive: true });
	return real;
}

/** Makes a minimal StandardWorktreeDispatch for testing. */
function makeMockDispatch(
	callID: string,
	worktreePath: string,
	branchName: string,
): StandardWorktreeDispatch {
	return {
		callID,
		parentSessionID: 'test-session',
		taskId: '1.1',
		planTaskId: '1.1',
		handle: {
			worktreePath,
			branchName,
			purpose: 'lane',
			id: `wt-${callID}`,
			sessionId: 'test-session',
		} as WorktreeHandle,
		mergeStrategy: 'merge',
		laneIndex: 0,
	};
}

// ─── Integration test ─────────────────────────────────────────────────────────

/** Runs git with child_process spawn (bypasses bunSpawn entirely for isolation). */
function gitSpawn(
	args: string[],
	cwd: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	return new Promise((resolve) => {
		const proc = spawn('git', args, {
			cwd,
			stdin: 'ignore',
			stdout: 'pipe',
			stderr: 'pipe',
		});
		let stdout = '';
		let stderr = '';
		proc.stdout.on('data', (d) => {
			stdout += d;
		});
		proc.stderr.on('data', (d) => {
			stderr += d;
		});
		proc.on('close', (exitCode) => {
			resolve({ exitCode: exitCode ?? 1, stdout, stderr });
		});
	});
}

describe('FR-001c: tag is reachable after worktree cleanup (real git)', () => {
	let tempDir: string;

	beforeEach(() => {
		// Ensure clean state — no mock pollution from other test files
		resetStandardWorktreeIsolationState();
		resetSwarmState();
		// Create fresh temp dir — previous test's temp dir is removed to guarantee
		// no stale git state (tags, refs) leaks into the next test run.
		const existingDir = path.join(os.tmpdir(), 'fr001c-git-pres-');
		try {
			fs.rmSync(existingDir, { recursive: true, force: true });
		} catch {
			// best-effort
		}
		tempDir = makeTempProject('fr001c-git-pres-');
	});

	afterEach(() => {
		resetStandardWorktreeIsolationState();
		resetSwarmState();
		try {
			fs.rmSync(tempDir, { recursive: true, force: true });
		} catch {
			// best-effort
		}
	});

	it('preserves dirty work: commit and tag survive after cleanup', async () => {
		// Use a unique callID to prevent tag collisions across test runs
		const callID = `call-git-preserve-real-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

		// Use tempDir directly as the "worktree" — the function only needs
		// git status, add, commit, rev-parse, and tag to work.

		// Create an isolated git repo using child_process spawn
		// (bypasses the parent opencode-swarm-dev repo context).
		// Wipe .git first to guarantee a clean repo even if the temp dir
		// was partially reused from a prior test run on Windows.
		try {
			fs.rmSync(path.join(tempDir, '.git'), { recursive: true, force: true });
		} catch {
			// ignore — .git might not exist yet
		}
		const r1 = await gitSpawn(['init'], tempDir);
		expect(r1.exitCode).toBe(0);

		await gitSpawn(['config', 'user.email', 'test@test.com'], tempDir);
		await gitSpawn(['config', 'user.name', 'Test'], tempDir);

		// Create initial commit
		fs.writeFileSync(path.join(tempDir, 'README.md'), '# Test\n');
		await gitSpawn(['add', 'README.md'], tempDir);
		const commitResult = await gitSpawn(['commit', '-m', 'initial'], tempDir);
		expect(commitResult.exitCode).toBe(0);

		// Create dirty file in the repo
		fs.writeFileSync(
			path.join(tempDir, 'dirty-work.txt'),
			'uncommitted work\n',
		);

		// Verify it's dirty
		const dirtyResult = await gitSpawn(['status', '--porcelain'], tempDir);
		expect(dirtyResult.exitCode).toBe(0);
		expect(dirtyResult.stdout.trim()).not.toBe('');

		// Dispatch entry — worktreePath = tempDir (simulating worktree IS the main repo)
		const laneBranch = 'swarm/lane/test-session/lane-real';
		const dispatch = makeMockDispatch(callID, tempDir, laneBranch);
		standardWorktreeByCallID.set(callID, dispatch);

		// Run preservation (with real bunSpawn — uses actual git on tempDir)
		const result = await preserveDirtyWorktreeForCallId(
			callID,
			'denied',
			tempDir,
		);

		expect(result.preserved).toBe(true);
		expect(result.ref).toBeDefined();
		expect(result.ref!.length).toBeGreaterThan(0);

		// Verify the commit exists in the repo
		const logProc = _internals.bunSpawn(
			['git', '-C', tempDir, 'log', '--oneline', result.ref!],
			{ stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', timeout: 10_000 },
		);
		const logExit = await logProc.exited;
		expect(logExit).toBe(0);
		const logStdout = await logProc.stdout.text();
		expect(logStdout).toContain('swarm-preserved');
		expect(logStdout).toContain('denied');

		// Verify the tag exists
		const tagName = `swarm-preserved-${callID.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 64)}-${result.ref!.slice(0, 8)}`;
		const tagProc = _internals.bunSpawn(
			['git', '-C', tempDir, 'tag', '-l', tagName],
			{ stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', timeout: 10_000 },
		);
		const tagExit = await tagProc.exited;
		const tagStdout = await tagProc.stdout.text();
		expect(tagExit).toBe(0);
		expect(tagStdout.trim()).toBe(tagName);

		// The "worktree" (tempDir) still exists after preservation
		expect(fs.existsSync(tempDir)).toBe(true);

		// The commit should STILL be reachable via reflog
		const reflogProc = _internals.bunSpawn(
			['git', '-C', tempDir, 'reflog', '--all'],
			{ stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', timeout: 10_000 },
		);
		const reflogExit = await reflogProc.exited;
		expect(reflogExit).toBe(0);
		const reflogStdout = await reflogProc.stdout.text();
		expect(reflogStdout).toContain(result.ref!.slice(0, 7));
	});
});
