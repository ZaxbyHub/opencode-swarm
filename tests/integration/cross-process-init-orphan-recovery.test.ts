/**
 * Cross-Process Init Orphan Recovery Integration Test (FB-007 / FR-102 SC-105, SC-106)
 * Uses tryAcquireLock (in-process) to simulate cross-process lock contention, and a
 * real child-process lock holder to verify end-to-end advisory behavior.
 *
 * Subprocess safety per AGENTS.md invariant 3: array-form spawn, explicit cwd,
 * stdin: 'ignore', timeout, bounded stdout/stderr, proc.kill() in finally.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { ChildProcess } from 'node:child_process';
import { spawn } from 'node:child_process';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import * as os from 'node:os';
import * as path from 'path';
import { runInitOrphanRecovery } from '../../src/hooks/init-orphan-recovery';
import type { InitOrphanAdvisory } from '../../src/hooks/init-orphan-recovery-advisory';
import { tryAcquireLock } from '../../src/parallel/file-locks';

// ─── helpers ─────────────────────────────────────────────────────────────────

/**
 * Gracefully kills a child process (SIGTERM first, then SIGKILL after timeout),
 * then waits for it to fully exit.
 */
async function killChild(child: ChildProcess, sig = 'SIGTERM'): Promise<void> {
	return new Promise((resolve) => {
		child.kill(sig);
		child.once('exit', () => resolve());
		setTimeout(() => {
			try {
				child.kill('SIGKILL');
			} catch {
				// already dead
			}
			setTimeout(resolve, 500);
		}, 2000);
	});
}

/**
 * Runs a git command in the given directory.
 */
async function runGit(
	cwd: string,
	args: string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	const proc = spawn('git', args, {
		cwd,
		stdio: ['ignore', 'pipe', 'pipe'],
		env: { ...process.env, LC_ALL: 'C' },
	});
	let stdout = '';
	let stderr = '';
	proc.stdout?.on('data', (chunk: Buffer) => {
		stdout += chunk.toString();
	});
	proc.stderr?.on('data', (chunk: Buffer) => {
		stderr += chunk.toString();
	});
	const exitCode = await new Promise<number>((resolve) => {
		proc.on('exit', (code) => resolve(code ?? -1));
	});
	return { exitCode, stdout, stderr };
}

/**
 * Creates a minimal git repo with a commit and clean working tree.
 */
async function initGitRepo(repoDir: string): Promise<void> {
	mkdirSync(repoDir, { recursive: true });
	await runGit(repoDir, [
		'config',
		'--global',
		'user.email',
		'test@test.local',
	]);
	await runGit(repoDir, ['config', '--global', 'user.name', 'Test User']);
	const result2 = await runGit(repoDir, ['init']);
	if (result2.exitCode !== 0) {
		throw new Error('git init failed: ' + result2.stderr);
	}
	writeFileSync(path.join(repoDir, 'README.md'), '# test\n');
	await runGit(repoDir, ['add', '.']);
	await runGit(repoDir, ['commit', '-m', 'initial commit']);
}

function makeTempDir(prefix: string): string {
	const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
	return realpathSync(dir);
}

// ─── fixtures ───────────────────────────────────────────────────────────────

let tmpDir: string;
let gitRepoDir: string;
/** All spawned children tracked for cleanup in afterEach */
const spawnedChildren: ChildProcess[] = [];

beforeEach(async () => {
	tmpDir = makeTempDir('init-orphan-xproc-');
	gitRepoDir = path.join(tmpDir, 'project');
	await initGitRepo(gitRepoDir);
});

afterEach(async () => {
	await Promise.all(
		spawnedChildren.map(async (child) => {
			try {
				await killChild(child, 'SIGTERM');
			} catch {
				try {
					await killChild(child, 'SIGKILL');
				} catch {
					// best-effort
				}
			}
		}),
	);
	spawnedChildren.length = 0;

	try {
		rmSync(tmpDir, { recursive: true, force: true });
	} catch {
		// best-effort cleanup
	}
});

// ─── SC-105: cross-process lock held → orphaned worktrees preserved ────────────

describe('SC-105: cross-process lock held → orphaned worktrees preserved', () => {
	test(
		'runInitOrphanRecovery preserves orphaned worktrees while the lock is held ' +
			'(crossProcessLockHeld=true, removedWorktrees=[], prunedWorktrees=false)',
		async () => {
			// Create orphaned worktree directories
			const worktreeRoot = path.join(tmpDir, '.swarm-worktrees');
			const orphanedWtPath = path.join(
				worktreeRoot,
				'session-parent-held',
				'lane-1',
			);
			mkdirSync(orphanedWtPath, { recursive: true });
			writeFileSync(
				path.join(orphanedWtPath, 'orphan.txt'),
				'orphan content\n',
			);

			expect(existsSync(orphanedWtPath)).toBe(true);

			// Acquire the lock (simulating another process holding it)
			const lockResult = await tryAcquireLock(
				gitRepoDir,
				'.swarm/locks/init-orphan-recovery.lock',
				'test-agent',
				'FB-007',
			);
			expect(lockResult.acquired).toBe(true);
			const lock = lockResult.lock;

			try {
				// Run init orphan recovery in the same process (simulating another process)
				const result = await runInitOrphanRecovery(gitRepoDir);

				// crossProcessLockHeld must be true (advisory-only mode)
				expect(result.crossProcessLockHeld).toBe(true);
				expect(result.attempted).toBe(true);

				// No destructive cleanup should have happened
				expect(result.removedWorktrees).toEqual([]);
				expect(result.prunedWorktrees).toBe(false);

				// Warnings should mention cross-process lock
				expect(
					result.warnings.some((w) => w.includes('Cross-process lock held')),
				).toBe(true);

				// The orphaned worktree directory must be PRESERVED (not deleted)
				expect(existsSync(orphanedWtPath)).toBe(true);
			} finally {
				// Release the lock
				await lock._release!();
			}
		},
	);

	test(
		'advisory file is written when lock is held ' +
			'and contains lock warning but no removedWorktrees',
		async () => {
			const orphanedWtPath = path.join(
				tmpDir,
				'.swarm-worktrees',
				'session-adv-held',
				'lane-1',
			);
			mkdirSync(orphanedWtPath, { recursive: true });

			const lockResult = await tryAcquireLock(
				gitRepoDir,
				'.swarm/locks/init-orphan-recovery.lock',
				'test-agent',
				'FB-007',
			);
			expect(lockResult.acquired).toBe(true);
			const lock = lockResult.lock;

			try {
				await runInitOrphanRecovery(gitRepoDir);

				const advisoryPath = path.join(
					gitRepoDir,
					'.swarm',
					'advisories',
					'init-orphan-recovery.json',
				);
				expect(existsSync(advisoryPath)).toBe(true);

				const content = JSON.parse(
					readFileSync(advisoryPath, 'utf-8'),
				) as InitOrphanAdvisory;

				// Warnings must mention cross-process lock
				expect(
					content.warnings.some((w) => w.includes('Cross-process lock held')),
				).toBe(true);

				// No worktrees should be reported as removed
				expect(content.reclaimed.removedWorktrees).toEqual([]);
			} finally {
				await lock._release!();
			}
		},
	);
});

// ─── SC-106: lock released → cleanup proceeds ─────────────────────────────────

describe('SC-106: lock released → cleanup proceeds', () => {
	test('runInitOrphanRecovery reclaims orphaned worktrees after lock is released', async () => {
		// Create orphaned worktree directories
		const worktreeRoot = path.join(tmpDir, '.swarm-worktrees');
		const orphanedWtPath = path.join(
			worktreeRoot,
			'session-after-release',
			'lane-1',
		);
		mkdirSync(orphanedWtPath, { recursive: true });
		writeFileSync(path.join(orphanedWtPath, 'orphan.txt'), 'orphan content\n');

		expect(existsSync(orphanedWtPath)).toBe(true);

		// Acquire the lock first
		const lockResult = await tryAcquireLock(
			gitRepoDir,
			'.swarm/locks/init-orphan-recovery.lock',
			'test-agent',
			'FB-007',
		);
		expect(lockResult.acquired).toBe(true);
		const lock = lockResult.lock;

		// Verify cleanup is skipped while lock is held
		const resultWhileLocked = await runInitOrphanRecovery(gitRepoDir);
		expect(resultWhileLocked.crossProcessLockHeld).toBe(true);
		expect(existsSync(orphanedWtPath)).toBe(true); // still preserved

		// Release the lock (simulating process death)
		await lock._release!();

		// Run init orphan recovery again — now cleanup should proceed
		const resultAfterRelease = await runInitOrphanRecovery(gitRepoDir);

		// crossProcessLockHeld should be false
		expect(resultAfterRelease.crossProcessLockHeld).toBe(false);
		expect(resultAfterRelease.attempted).toBe(true);

		// The orphaned worktree directory must be GONE (reclaimed)
		expect(existsSync(orphanedWtPath)).toBe(false);
	});

	test('SC-106: multiple orphaned worktrees are all reclaimed after lock release', async () => {
		const worktreeRoot = path.join(tmpDir, '.swarm-worktrees');

		// Create three orphaned worktree directories
		const sessions = [
			'session-multi-release-1',
			'session-multi-release-2',
			'session-multi-release-3',
		];
		for (const sess of sessions) {
			const wtPath = path.join(worktreeRoot, sess, 'lane-1');
			mkdirSync(wtPath, { recursive: true });
			writeFileSync(path.join(wtPath, 'filler.txt'), 'content\n');
		}

		// Acquire the lock
		const lockResult = await tryAcquireLock(
			gitRepoDir,
			'.swarm/locks/init-orphan-recovery.lock',
			'test-agent',
			'FB-007',
		);
		expect(lockResult.acquired).toBe(true);
		const lock = lockResult.lock;

		// Verify all preserved while lock is held
		const resultWhileLocked = await runInitOrphanRecovery(gitRepoDir);
		expect(resultWhileLocked.crossProcessLockHeld).toBe(true);
		for (const sess of sessions) {
			const wtPath = path.join(worktreeRoot, sess, 'lane-1');
			expect(existsSync(wtPath)).toBe(true);
		}

		// Release the lock
		await lock._release!();

		// Run cleanup
		const resultAfterRelease = await runInitOrphanRecovery(gitRepoDir);

		// All dirs must be gone
		for (const sess of sessions) {
			const wtPath = path.join(worktreeRoot, sess, 'lane-1');
			expect(existsSync(wtPath)).toBe(false);
		}

		expect(resultAfterRelease.crossProcessLockHeld).toBe(false);
	});
});

// ─── Cross-process simulation (real child process) ─────────────────────────────────

/**
 * Creates a child-process script that:
 * - Acquires the init-orphan-recovery lock using tryAcquireLock
 * - Writes "ready\n" to stdout once the lock is held
 * - Keeps the process alive (holding the lock) until killed
 *
 * This simulates a REAL concurrent process holding the lock.
 */
function writeLockHolderScript(tmpDir: string): string {
	const scriptPath = path.join(tmpDir, 'lock-holder.mjs');
	const fileLocksUrl = 'file://' + path.resolve('src/parallel/file-locks.js');
	const script = `
import { tryAcquireLock } from ${JSON.stringify(fileLocksUrl)};

const lockHolderDir = process.argv[2];
const lockFile = '.swarm/locks/init-orphan-recovery.lock';

const result = await tryAcquireLock(lockHolderDir, lockFile, 'lock-holder-child', 'FB-007', 'session-xproc-test');
if (!result.acquired) {
  console.error('LOCK_FAILED: could not acquire lock');
  process.exit(1);
}

// Signal that lock is held
process.stdout.write('ready\\n');
process.stdout.flush();

// Keep the process alive — lock._release() is called on exit
await new Promise(() => {});
`;
	writeFileSync(scriptPath, script, 'utf-8');
	return scriptPath;
}

/**
 * Spawns a child process that holds the init-orphan-recovery lock.
 */
function spawnLockHolder(tmpDir: string, lockHolderDir: string): ChildProcess {
	const scriptPath = writeLockHolderScript(tmpDir);
	const child = spawn(process.execPath, [scriptPath, lockHolderDir], {
		cwd: tmpDir,
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	return child;
}

/**
 * Waits for a child process to emit "ready\n" on stdout.
 */
function waitForLockReady(
	child: ChildProcess,
	timeoutMs = 8000,
): Promise<void> {
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => {
			if (child.exitCode !== null) {
				reject(new Error(`Child exited before ready: code=${child.exitCode}`));
			} else {
				reject(
					new Error(`Timeout waiting for ready signal after ${timeoutMs}ms`),
				);
			}
		}, timeoutMs);

		let stdoutData = '';
		child.stdout?.on('data', (chunk: Buffer) => {
			stdoutData += chunk.toString();
			if (stdoutData.includes('ready')) {
				clearTimeout(timeout);
				resolve();
			}
		});

		child.on('exit', (code) => {
			clearTimeout(timeout);
			if (!stdoutData.includes('ready')) {
				reject(new Error(`Child exited before emitting ready: code=${code}`));
			}
		});
	});
}

describe('cross-process simulation (real child process holding lock)', () => {
	test('SC-105: real child process lock → worktrees preserved, crossProcessLockHeld=true', async () => {
		const worktreeRoot = path.join(tmpDir, '.swarm-worktrees');
		const orphanedWtPath = path.join(
			worktreeRoot,
			'session-child-real',
			'lane-1',
		);
		mkdirSync(orphanedWtPath, { recursive: true });
		writeFileSync(path.join(orphanedWtPath, 'orphan.txt'), 'orphan\n');

		expect(existsSync(orphanedWtPath)).toBe(true);

		const child = spawnLockHolder(tmpDir, gitRepoDir);
		spawnedChildren.push(child);
		await waitForLockReady(child, 8000);
		expect(child.exitCode).toBeNull();

		try {
			const result = await runInitOrphanRecovery(gitRepoDir);
			expect(result.crossProcessLockHeld).toBe(true);
			expect(result.removedWorktrees).toEqual([]);
			expect(existsSync(orphanedWtPath)).toBe(true);
		} finally {
			await killChild(child, 'SIGTERM');
		}
	});
});

// NOTE: Subprocess spawn-pattern correctness (array-form, explicit cwd,
// stdin:ignore, timeout, bounded stderr) is verified by the sibling
// integration test tests/integration/cross-process-port-binding.test.ts
// which covers the same spawn conventions used here.
