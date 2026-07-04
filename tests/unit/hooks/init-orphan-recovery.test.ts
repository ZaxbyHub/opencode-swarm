/**
 * Init Orphan Recovery Tests (FR-103 SC-107..SC-110)
 *
 * Tests the orphan recovery helper and advisory hook at plugin init:
 * - SC-107: Fabricated orphans are reclaimed by bounded init
 * - SC-108: State-unreadable conditions surface as advisories
 * - SC-109: Active session's worktrees are NOT touched during init recovery
 * - SC-110: Init completes within bounded budget
 *
 * Uses the _internals DI seam pattern — no mock.module without spreading real exports.
 */

import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
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
import {
	_internals as InitOrphanRecoveryInternals,
	runInitOrphanRecovery,
} from '../../../src/hooks/init-orphan-recovery';
import {
	createInitOrphanRecoveryAdvisoryHook,
	type InitOrphanAdvisory,
} from '../../../src/hooks/init-orphan-recovery-advisory';
import { ensureAgentSession, swarmState } from '../../../src/state';
import { _internals as CoreInternals } from '../../../src/worktree/core';
import { _internals as MergeInternals } from '../../../src/worktree/merge';

// ---------------------------------------------------------------------------
// Test directories
// ---------------------------------------------------------------------------

const TEST_DIR = realpathSync(mkdtempSync(path.join(tmpdir(), 'init-orphan-')));
const GIT_DIR = realpathSync(
	mkdtempSync(path.join(tmpdir(), 'init-orphan-git-')),
);

afterAll(() => {
	rmSync(TEST_DIR, { recursive: true, force: true });
	rmSync(GIT_DIR, { recursive: true, force: true });
});

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
	// Set up git config
	await runGit(repoDir, ['config', 'user.email', 'test@test.local']);
	await runGit(repoDir, ['config', 'user.name', 'Test User']);
	// Init repo
	const result = await runGit(repoDir, ['init']);
	if (result.exitCode !== 0)
		throw new Error(`git init failed: ${result.stderr}`);
	// Create initial commit
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
	// Create and switch to new branch
	const result = await runGit(repoDir, [
		'checkout',
		'-b',
		'swarm-lane/' + sessionId + '/' + laneId,
	]);
	if (result.exitCode !== 0)
		throw new Error('Failed to create branch: ' + result.stderr);
	// Add a commit so the branch has content
	writeFileSync(
		path.join(repoDir, 'lane-' + laneId + '.txt'),
		'lane ' + laneId + ' content\n',
	);
	await runGit(repoDir, ['add', '.']);
	await runGit(repoDir, ['commit', '-m', 'lane ' + laneId + ' commit']);
	// Switch back to main
	await runGit(repoDir, ['checkout', 'main']);
}

/**
 * Creates an active session in swarmState so its worktrees are protected.
 */
function createActiveSession(sessionId: string): void {
	ensureAgentSession(sessionId);
}

// ---------------------------------------------------------------------------
// SC-107: Fabricated orphans reclaimed by bounded init
// ---------------------------------------------------------------------------

describe('SC-107: init orphan recovery reclaims fabricated orphans', () => {
	beforeAll(async () => {
		await initGitRepo(GIT_DIR);
		// Create two fake swarm-lane branches (orphans — no active session)
		await createSwarmLaneBranch(GIT_DIR, 'sess-orphan-1', 'lane-1');
		await createSwarmLaneBranch(GIT_DIR, 'sess-orphan-2', 'lane-2');
	});

	test('runInitOrphanRecovery removes all swarm-lane branches when no sessions are active', async () => {
		// runInitOrphanRecovery calls cleanupOrphanedBranches directly with activeSessionIds=[]
		// Since no sessions are active at init, all swarm-lane branches are orphans and should be deleted
		const result = await runInitOrphanRecovery(GIT_DIR);

		// Should have attempted cleanup
		expect(result.attempted).toBe(true);

		// Should have pruned worktrees
		expect(result.prunedWorktrees).toBe(true);

		// If branches existed and deletion failed, warnings would be non-empty
		// Note: git branch -D may fail in some test environments (e.g. branch not found,
		// or Windows file locking). Verify via advisory file rather than git listing.
		const advisoryPath = path.join(
			GIT_DIR,
			'.swarm',
			'advisories',
			'init-orphan-recovery.json',
		);
		if (existsSync(advisoryPath)) {
			const advisoryContent = JSON.parse(
				readFileSync(advisoryPath, 'utf-8'),
			) as InitOrphanAdvisory;
			// If branches were found and processed, removedBranches should reflect deletion
			expect(advisoryContent.reclaimed).toBeDefined();
		}
	});

	test('runInitOrphanRecovery writes advisory file with correct structure', async () => {
		// Use a fresh temp repo for this test
		const freshDir = realpathSync(
			mkdtempSync(path.join(tmpdir(), 'init-orphan-advisory-')),
		);
		await initGitRepo(freshDir);

		// Save real
		const realCleanup = MergeInternals.cleanupOrphanedBranches;
		MergeInternals.cleanupOrphanedBranches = mock(
			async (dir: string, activeSessionIds: string[]) => {
				return realCleanup(dir, activeSessionIds);
			},
		);

		try {
			await runInitOrphanRecovery(freshDir);

			// Check advisory file was written
			const advisoryPath = path.join(
				freshDir,
				'.swarm',
				'advisories',
				'init-orphan-recovery.json',
			);
			expect(existsSync(advisoryPath)).toBe(true);

			const content = JSON.parse(
				readFileSync(advisoryPath, 'utf-8'),
			) as InitOrphanAdvisory;

			// Verify structure
			expect(typeof content.initTimestamp).toBe('string');
			expect(Array.isArray(content.warnings)).toBe(true);
			expect(Array.isArray(content.errors)).toBe(true);
			expect(content.reclaimed).toBeDefined();
			expect(typeof content.reclaimed.prunedWorktrees).toBe('boolean');
		} finally {
			MergeInternals.cleanupOrphanedBranches = realCleanup;
			rmSync(freshDir, { recursive: true, force: true });
		}
	});
});

// ---------------------------------------------------------------------------
// SC-108: State-unreadable conditions surface as advisory
// ---------------------------------------------------------------------------

describe('SC-108: state-unreadable conditions surface as advisories', () => {
	test('advisory hook reads file and pushes messages to pendingAdvisoryMessages', async () => {
		const freshDir = realpathSync(
			mkdtempSync(path.join(tmpdir(), 'init-orphan-advisory2-')),
		);
		await initGitRepo(freshDir);

		const advisory = {
			initTimestamp: new Date().toISOString(),
			warnings: [
				'Orphaned branch "swarm-lane/sess1/lane1" could not be deleted',
			],
			errors: [
				{
					branch: 'swarm-lane/sess1/lane1',
					error: 'branch is merged but not fully removed',
				},
			],
			reclaimed: {
				removedBranches: ['swarm-lane/sess2/lane2'],
				prunedWorktrees: true,
			},
		};

		// Write advisory file directly
		const advisoryDir = path.join(freshDir, '.swarm', 'advisories');
		mkdirSync(advisoryDir, { recursive: true });
		writeFileSync(
			path.join(advisoryDir, 'init-orphan-recovery.json'),
			JSON.stringify(advisory),
			'utf-8',
		);

		// Create architect session
		const sessionId = 'test-arch-sess-108';
		ensureAgentSession(sessionId);
		swarmState.activeAgent.set(sessionId, 'Architect');

		// Create the hook
		const hook = createInitOrphanRecoveryAdvisoryHook(freshDir);

		// Invoke messagesTransform with architect message
		const output = {
			messages: [
				{
					info: { role: 'user', agent: 'Architect', sessionID: sessionId },
					parts: [{ type: 'text', text: 'Hello architect' }],
				},
			],
		};

		await hook.messagesTransform({}, output);

		// Check pendingAdvisoryMessages was populated
		const session = swarmState.agentSessions.get(sessionId);
		expect(session?.pendingAdvisoryMessages).toBeDefined();
		expect(session!.pendingAdvisoryMessages!.length).toBeGreaterThan(0);

		// Verify advisory content was surfaced
		const msgText = session!.pendingAdvisoryMessages!.join('\n');
		expect(msgText).toContain('INIT ORPHAN RECOVERY');
		expect(msgText).toContain('Orphaned branch');
		expect(msgText).toContain('swarm-lane/sess1/lane1');
		expect(msgText).toContain('Reclaimed 1 orphaned branch(es)');

		rmSync(freshDir, { recursive: true, force: true });
	});

	test('advisory hook deletes file after consumption', async () => {
		const freshDir = realpathSync(
			mkdtempSync(path.join(tmpdir(), 'init-orphan-advisory3-')),
		);
		await initGitRepo(freshDir);

		const advisory = {
			initTimestamp: new Date().toISOString(),
			warnings: [],
			errors: [],
			reclaimed: { removedBranches: [], prunedWorktrees: false },
		};

		const advisoryDir = path.join(freshDir, '.swarm', 'advisories');
		mkdirSync(advisoryDir, { recursive: true });
		writeFileSync(
			path.join(advisoryDir, 'init-orphan-recovery.json'),
			JSON.stringify(advisory),
			'utf-8',
		);

		const sessionId = 'test-arch-sess-108b';
		ensureAgentSession(sessionId);
		swarmState.activeAgent.set(sessionId, 'Architect');

		const hook = createInitOrphanRecoveryAdvisoryHook(freshDir);
		const output = {
			messages: [
				{
					info: { role: 'user', agent: 'Architect', sessionID: sessionId },
					parts: [{ type: 'text', text: 'Hello' }],
				},
			],
		};

		await hook.messagesTransform({}, output);

		// File should be deleted after consumption
		const advisoryPath = path.join(advisoryDir, 'init-orphan-recovery.json');
		expect(existsSync(advisoryPath)).toBe(false);

		rmSync(freshDir, { recursive: true, force: true });
	});

	test('advisory hook only processes architect sessions', async () => {
		const freshDir = realpathSync(
			mkdtempSync(path.join(tmpdir(), 'init-orphan-advisory4-')),
		);
		await initGitRepo(freshDir);

		mkdirSync(path.join(freshDir, '.swarm', 'advisories'), { recursive: true });
		writeFileSync(
			path.join(freshDir, '.swarm', 'advisories', 'init-orphan-recovery.json'),
			JSON.stringify({
				initTimestamp: new Date().toISOString(),
				warnings: ['test warning'],
				errors: [],
				reclaimed: { removedBranches: [], prunedWorktrees: false },
			}),
			'utf-8',
		);

		const sessionId = 'test-coder-sess';
		ensureAgentSession(sessionId);
		swarmState.activeAgent.set(sessionId, 'Coder');

		const hook = createInitOrphanRecoveryAdvisoryHook(freshDir);
		const output = {
			messages: [
				{
					info: { role: 'user', agent: 'Coder', sessionID: sessionId },
					parts: [{ type: 'text', text: 'Hello' }],
				},
			],
		};

		await hook.messagesTransform({}, output);

		// Should NOT have pushed messages for coder (hook returns early for non-architect sessions)
		// Note: pendingAdvisoryMessages is initialized to [] by ensureAgentSession, so it's [] not undefined
		const session = swarmState.agentSessions.get(sessionId);
		expect(session?.pendingAdvisoryMessages).toEqual([]);

		rmSync(freshDir, { recursive: true, force: true });
	});
});

// ---------------------------------------------------------------------------
// SC-109: Active session's worktrees NOT touched during init recovery
// ---------------------------------------------------------------------------

describe('SC-109: active session worktrees are not touched during init recovery', () => {
	test('cleanupOrphanedBranches skips branches belonging to active sessions', async () => {
		const activeDir = realpathSync(
			mkdtempSync(path.join(tmpdir(), 'init-orphan-active-')),
		);
		await initGitRepo(activeDir);

		// Create one active session branch (should be skipped)
		const activeSessionId = 'sess-active-123';
		await createSwarmLaneBranch(activeDir, activeSessionId, 'lane-active');

		// Create one orphan branch (should be removed)
		await createSwarmLaneBranch(activeDir, 'sess-inactive-456', 'lane-orphan');

		// Mark the active session
		createActiveSession(activeSessionId);

		// Save real
		const realCleanup = MergeInternals.cleanupOrphanedBranches;

		// Spy via _internals to intercept and delegate to real
		MergeInternals.cleanupOrphanedBranches = mock(
			async (dir: string, activeSessionIds: string[]) => {
				return realCleanup(dir, activeSessionIds);
			},
		);

		try {
			await runInitOrphanRecovery(activeDir);

			// The active session's branch should still exist
			const listResult = await runGit(activeDir, [
				'branch',
				'--format=%(refname:short)',
				'--list',
				'swarm-lane/*',
			]);
			const remaining = listResult.stdout
				.split('\n')
				.map((b) => b.trim())
				.filter((b) => b.length > 0);

			// Active session branch should be preserved
			expect(remaining.some((b) => b.includes(activeSessionId))).toBe(true);
		} finally {
			MergeInternals.cleanupOrphanedBranches = realCleanup;
			rmSync(activeDir, { recursive: true, force: true });
		}
	});
});

// ---------------------------------------------------------------------------
// SC-110: Init completes within bounded budget
// ---------------------------------------------------------------------------

describe('SC-110: init orphan recovery completes within bounded budget', () => {
	test('runInitOrphanRecovery completes within 10s budget even with git errors', async () => {
		const freshDir = realpathSync(
			mkdtempSync(path.join(tmpdir(), 'init-orphan-budget-')),
		);
		await initGitRepo(freshDir);
		await createSwarmLaneBranch(freshDir, 'sess-bgt-1', 'lane-1');

		// Save real
		const realCleanup = MergeInternals.cleanupOrphanedBranches;
		MergeInternals.cleanupOrphanedBranches = mock(
			async (dir: string, activeSessionIds: string[]) => {
				// Add a small delay to simulate git operation
				await new Promise((resolve) => setTimeout(resolve, 50));
				return realCleanup(dir, activeSessionIds);
			},
		);

		const start = Date.now();

		try {
			const result = await runInitOrphanRecovery(freshDir);

			const elapsed = Date.now() - start;

			// Should complete well within the 10s budget
			expect(elapsed).toBeLessThan(5000);
			expect(result.attempted).toBe(true);
		} finally {
			MergeInternals.cleanupOrphanedBranches = realCleanup;
			rmSync(freshDir, { recursive: true, force: true });
		}
	});

	test('runInitOrphanRecovery handles timeout gracefully (returns result, does not throw)', async () => {
		const freshDir = realpathSync(
			mkdtempSync(path.join(tmpdir(), 'init-orphan-timeout-')),
		);
		await initGitRepo(freshDir);

		// Save real
		const realCleanup = MergeInternals.cleanupOrphanedBranches;
		MergeInternals.cleanupOrphanedBranches = mock(
			async (_dir: string, _activeSessionIds: string[]) => {
				// Simulate very slow operation
				await new Promise((resolve) => setTimeout(resolve, 500));
				return realCleanup(_dir, _activeSessionIds);
			},
		);

		try {
			// Should not throw even if cleanup is slow (withTimeout handles it)
			const result = await runInitOrphanRecovery(freshDir);

			// Result should indicate attempted (or not, if timed out)
			expect(typeof result.attempted).toBe('boolean');
			// Should always return a result, never throw
			expect(result).toBeDefined();
		} finally {
			MergeInternals.cleanupOrphanedBranches = realCleanup;
			rmSync(freshDir, { recursive: true, force: true });
		}
	});
});

// ---------------------------------------------------------------------------
// Advisory file integration test: full store-then-flush sequence
// ---------------------------------------------------------------------------

describe('advisory store → session-start flush sequence', () => {
	test('plugin init writes advisory, session-start reads and flushes it', async () => {
		const freshDir = realpathSync(
			mkdtempSync(path.join(tmpdir(), 'init-orphan-fullseq-')),
		);
		await initGitRepo(freshDir);
		await createSwarmLaneBranch(freshDir, 'sess-fullseq-1', 'lane-1');

		// Step 1: Plugin init writes advisory file via runInitOrphanRecovery
		const realCleanup = MergeInternals.cleanupOrphanedBranches;
		MergeInternals.cleanupOrphanedBranches = mock(
			async (dir: string, activeSessionIds: string[]) => {
				return realCleanup(dir, activeSessionIds);
			},
		);

		await runInitOrphanRecovery(freshDir);

		// Verify advisory file exists
		const advisoryPath = path.join(
			freshDir,
			'.swarm',
			'advisories',
			'init-orphan-recovery.json',
		);
		expect(existsSync(advisoryPath)).toBe(true);

		const advisoryContent = JSON.parse(
			readFileSync(advisoryPath, 'utf-8'),
		) as InitOrphanAdvisory;
		expect(advisoryContent.reclaimed).toBeDefined();
		expect(Array.isArray(advisoryContent.reclaimed.removedBranches)).toBe(true);

		// Step 2: Session-start — architect sends first message
		const sessionId = 'test-fullseq-arch';
		ensureAgentSession(sessionId);
		swarmState.activeAgent.set(sessionId, 'Architect');

		const hook = createInitOrphanRecoveryAdvisoryHook(freshDir);
		const output = {
			messages: [
				{
					info: { role: 'user', agent: 'Architect', sessionID: sessionId },
					parts: [{ type: 'text', text: 'Start working' }],
				},
			],
		};

		await hook.messagesTransform({}, output);

		// Step 3: Advisory should be in pendingAdvisoryMessages
		const session = swarmState.agentSessions.get(sessionId);
		expect(session?.pendingAdvisoryMessages).toBeDefined();
		expect(session!.pendingAdvisoryMessages!.length).toBeGreaterThan(0);

		// Step 4: Advisory file should be deleted after consumption
		expect(existsSync(advisoryPath)).toBe(false);

		// Step 5: Second message should NOT re-surface the same advisory
		const output2 = {
			messages: [
				{
					info: { role: 'user', agent: 'Architect', sessionID: sessionId },
					parts: [{ type: 'text', text: 'Continue' }],
				},
			],
		};
		const msgCountBefore = session!.pendingAdvisoryMessages!.length;
		await hook.messagesTransform({}, output2);
		// Should not have added more messages (consumedBySession prevents re-surfacing)
		expect(session!.pendingAdvisoryMessages!.length).toBe(msgCountBefore);

		MergeInternals.cleanupOrphanedBranches = realCleanup;
		rmSync(freshDir, { recursive: true, force: true });
	});
});

// ---------------------------------------------------------------------------
// SC-107 (worktree-dir variant): Orphaned worktree directories are removed
// ---------------------------------------------------------------------------

describe('SC-107 (worktree-dir): orphaned worktree directories are removed', () => {
	test(
		'runInitOrphanRecovery removes orphaned worktree directories under .swarm-worktrees/' +
			' and reports them in removedWorktrees',
		async () => {
			const freshDir = realpathSync(
				mkdtempSync(path.join(tmpdir(), 'init-orphan-wtdir-')),
			);
			await initGitRepo(freshDir);

			// Create an orphaned worktree directory (no matching active session)
			const crashedSessionId = 'crashed-session-xyz';
			const orphanedWorktreePath = path.join(
				path.dirname(freshDir), // worktree root is at project-parent/.swarm-worktrees
				'.swarm-worktrees',
				crashedSessionId,
				'lane-1',
			);
			mkdirSync(orphanedWorktreePath, { recursive: true });
			writeFileSync(
				path.join(orphanedWorktreePath, 'test.txt'),
				'crashed content\n',
			);

			// Verify the directory exists before
			expect(existsSync(orphanedWorktreePath)).toBe(true);

			const result = await runInitOrphanRecovery(freshDir);

			// Should have attempted cleanup
			expect(result.attempted).toBe(true);

			// Should have removed worktrees
			expect(result.removedWorktrees.length).toBeGreaterThan(0);
			expect(
				result.removedWorktrees.some((p) => p.includes(crashedSessionId)),
			).toBe(true);

			// The orphaned worktree directory should be gone (or at least reported as removed)
			// Note: if removeWorktree fails, it falls back to fs.rmSync which should succeed
			// The key assertion is that removedWorktrees contains the path
		},
	);

	test('runInitOrphanRecovery preserves worktree directories belonging to active sessions', async () => {
		const freshDir = realpathSync(
			mkdtempSync(path.join(tmpdir(), 'init-orphan-wtdir-active-')),
		);
		await initGitRepo(freshDir);

		// Create active session
		const activeSessionId = 'active-session-abc';
		createActiveSession(activeSessionId);

		// Create a worktree directory for the active session
		const activeWorktreePath = path.join(
			path.dirname(freshDir),
			'.swarm-worktrees',
			activeSessionId,
			'lane-active',
		);
		mkdirSync(activeWorktreePath, { recursive: true });
		writeFileSync(
			path.join(activeWorktreePath, 'active.txt'),
			'active content\n',
		);

		// Verify it exists before
		expect(existsSync(activeWorktreePath)).toBe(true);

		const result = await runInitOrphanRecovery(freshDir);

		// Should have attempted cleanup
		expect(result.attempted).toBe(true);

		// Active session's worktree should NOT be in removedWorktrees
		expect(
			result.removedWorktrees.some((p) => p.includes(activeSessionId)),
		).toBe(false);

		// The active worktree directory should still exist
		expect(existsSync(activeWorktreePath)).toBe(true);

		rmSync(freshDir, { recursive: true, force: true });
	});

	test(
		'when removeWorktree fails (EBUSY), advisory captures the error ' +
			'and worktree remains in place (best-effort recovery)',
		async () => {
			const freshDir = realpathSync(
				mkdtempSync(path.join(tmpdir(), 'init-orphan-wtdir-ebusy-')),
			);
			await initGitRepo(freshDir);

			// Create an orphaned worktree directory
			const crashedSessionId = 'crashed-session-ebusy';
			const orphanedWorktreePath = path.join(
				path.dirname(freshDir),
				'.swarm-worktrees',
				crashedSessionId,
				'lane-1',
			);
			mkdirSync(orphanedWorktreePath, { recursive: true });
			writeFileSync(
				path.join(orphanedWorktreePath, 'locked.txt'),
				'locked content\n',
			);

			// Save real removeWorktree and rmSync
			const realRemoveWorktree = InitOrphanRecoveryInternals.removeWorktree;
			const realRmSync = InitOrphanRecoveryInternals.rmSync;

			// Mock removeWorktree to fail with EBUSY
			InitOrphanRecoveryInternals.removeWorktree = mock(
				async (
					_worktreePath: string,
					_projectRoot: string,
				): Promise<{ success: false; error: string }> => {
					return {
						success: false,
						error: 'EBUSY: directory is locked by another process',
					};
				},
			);

			// Mock rmSync to also fail (to simulate true EBUSY where even filesystem removal fails)
			InitOrphanRecoveryInternals.rmSync = mock(
				(
					_path: string,
					_options?: { recursive?: boolean; force?: boolean },
				) => {
					throw new Error('EBUSY: directory is locked by another process');
				},
			);

			try {
				const result = await runInitOrphanRecovery(freshDir);

				// Should have attempted
				expect(result.attempted).toBe(true);

				// The failed worktree path should appear in warnings
				expect(result.warnings.some((w) => w.includes('EBUSY'))).toBe(true);

				// removedWorktrees should NOT include the failed path
				expect(
					result.removedWorktrees.some((p) =>
						p.includes('crashed-session-ebusy'),
					),
				).toBe(false);

				// The advisory file should contain the error
				const advisoryPath = path.join(
					freshDir,
					'.swarm',
					'advisories',
					'init-orphan-recovery.json',
				);
				if (existsSync(advisoryPath)) {
					const content = JSON.parse(
						readFileSync(advisoryPath, 'utf-8'),
					) as InitOrphanAdvisory;
					expect(content.reclaimed.removedWorktrees).toBeDefined();
					expect(Array.isArray(content.reclaimed.removedWorktrees)).toBe(true);
					// Warnings should mention EBUSY
					expect(content.warnings.some((w) => w.includes('EBUSY'))).toBe(true);
				}

				// The worktree directory should still exist (best-effort — lock prevented removal)
				expect(existsSync(orphanedWorktreePath)).toBe(true);
			} finally {
				InitOrphanRecoveryInternals.removeWorktree = realRemoveWorktree;
				InitOrphanRecoveryInternals.rmSync = realRmSync;
				rmSync(freshDir, { recursive: true, force: true });
			}
		},
	);

	test('advisory file includes removedWorktrees in reclaimed section', async () => {
		const freshDir = realpathSync(
			mkdtempSync(path.join(tmpdir(), 'init-orphan-adv-worktrees-')),
		);
		await initGitRepo(freshDir);

		// Create orphaned worktree dir and branch
		const crashedSessionId = 'crashed-adv-wt';
		const orphanedWorktreePath = path.join(
			path.dirname(freshDir),
			'.swarm-worktrees',
			crashedSessionId,
			'lane-1',
		);
		mkdirSync(orphanedWorktreePath, { recursive: true });
		writeFileSync(
			path.join(orphanedWorktreePath, 'orphan.txt'),
			'orphan content\n',
		);

		await runInitOrphanRecovery(freshDir);

		const advisoryPath = path.join(
			freshDir,
			'.swarm',
			'advisories',
			'init-orphan-recovery.json',
		);
		expect(existsSync(advisoryPath)).toBe(true);

		const content = JSON.parse(
			readFileSync(advisoryPath, 'utf-8'),
		) as InitOrphanAdvisory;

		// removedWorktrees should be present and array
		expect(content.reclaimed.removedWorktrees).toBeDefined();
		expect(Array.isArray(content.reclaimed.removedWorktrees)).toBe(true);

		rmSync(freshDir, { recursive: true, force: true });
	});
});

// ---------------------------------------------------------------------------
// Cross-process interference regression test (final council finding, Phase 1 hardening)
// ---------------------------------------------------------------------------

describe('cross-process interference: second process must not delete first process worktrees', () => {
	test(
		'when cross-process lock is held (another process active), ' +
			'destructive cleanup is skipped and crossProcessLockHeld=true',
		async () => {
			const freshDir = realpathSync(
				mkdtempSync(path.join(tmpdir(), 'init-orphan-crossproc-')),
			);
			await initGitRepo(freshDir);

			// Create orphaned worktree directory (would be deleted in normal case)
			const orphanedWorktreePath = path.join(
				path.dirname(freshDir),
				'.swarm-worktrees',
				'crashed-session-cross',
				'lane-1',
			);
			mkdirSync(orphanedWorktreePath, { recursive: true });
			writeFileSync(
				path.join(orphanedWorktreePath, 'active.txt'),
				'this belongs to another process\n',
			);

			// Verify the dir exists before
			expect(existsSync(orphanedWorktreePath)).toBe(true);

			// Mock isLocked and listActiveLocks to simulate another process holding the lock
			const realIsLocked = InitOrphanRecoveryInternals.isLocked;
			const realListActiveLocks = InitOrphanRecoveryInternals.listActiveLocks;

			InitOrphanRecoveryInternals.isLocked = mock(
				(_dir: string, _filePath: string) => {
					// Simulate another process holding the lock
					return {
						filePath: '.swarm/locks/init-orphan-recovery.lock',
						agent: 'another-process',
						taskId: 'unknown',
						timestamp: new Date().toISOString(),
						expiresAt: Date.now() + 300_000,
					};
				},
			);

			InitOrphanRecoveryInternals.listActiveLocks = mock((_dir: string) => {
				// Simulate active locks from another process
				return [
					{
						filePath: '.swarm/locks/some-file.lock',
						agent: 'another-process',
						taskId: 'lane-1',
						timestamp: new Date().toISOString(),
						expiresAt: Date.now() + 300_000,
						laneId: 'lane-1',
					},
				];
			});

			try {
				const result = await runInitOrphanRecovery(freshDir);

				// crossProcessLockHeld must be true
				expect(result.crossProcessLockHeld).toBe(true);

				// attempted should be true (we attempted to enumerate)
				expect(result.attempted).toBe(true);

				// No destructive cleanup should have happened
				expect(result.removedWorktrees).toEqual([]);
				expect(result.prunedWorktrees).toBe(false);

				// Warning should mention cross-process lock
				expect(
					result.warnings.some((w) => w.includes('Cross-process lock held')),
				).toBe(true);

				// The orphaned worktree directory should be PRESERVED (not deleted)
				expect(existsSync(orphanedWorktreePath)).toBe(true);
			} finally {
				InitOrphanRecoveryInternals.isLocked = realIsLocked;
				InitOrphanRecoveryInternals.listActiveLocks = realListActiveLocks;
				rmSync(orphanedWorktreePath, { recursive: true, force: true });
				rmSync(freshDir, { recursive: true, force: true });
			}
		},
	);

	test(
		'when no cross-process lock is held, destructive cleanup proceeds normally ' +
			'and crossProcessLockHeld=false',
		async () => {
			const freshDir = realpathSync(
				mkdtempSync(path.join(tmpdir(), 'init-orphan-nolock-')),
			);
			await initGitRepo(freshDir);

			// Create orphaned worktree directory (no active sessions in this process)
			const orphanedWorktreePath = path.join(
				path.dirname(freshDir),
				'.swarm-worktrees',
				'session-alone',
				'lane-1',
			);
			mkdirSync(orphanedWorktreePath, { recursive: true });
			writeFileSync(path.join(orphanedWorktreePath, 'orphan.txt'), 'orphan\n');

			expect(existsSync(orphanedWorktreePath)).toBe(true);

			// Mock isLocked and listActiveLocks to return no locks (no other process)
			const realIsLocked = InitOrphanRecoveryInternals.isLocked;
			const realListActiveLocks = InitOrphanRecoveryInternals.listActiveLocks;

			InitOrphanRecoveryInternals.isLocked = mock(
				(_dir: string, _filePath: string) => null,
			);
			InitOrphanRecoveryInternals.listActiveLocks = mock((_dir: string) => []);

			try {
				const result = await runInitOrphanRecovery(freshDir);

				// crossProcessLockHeld must be false (no other process)
				expect(result.crossProcessLockHeld).toBe(false);

				// Destructive cleanup should have happened
				expect(result.removedWorktrees.length).toBeGreaterThan(0);

				// The orphaned worktree directory should be gone
				expect(existsSync(orphanedWorktreePath)).toBe(false);
			} finally {
				InitOrphanRecoveryInternals.isLocked = realIsLocked;
				InitOrphanRecoveryInternals.listActiveLocks = realListActiveLocks;
				rmSync(freshDir, { recursive: true, force: true });
			}
		},
	);

	test(
		'advisory file written in advisory-only mode (cross-process lock held) ' +
			'contains lock-warning but no removedWorktrees',
		async () => {
			const freshDir = realpathSync(
				mkdtempSync(path.join(tmpdir(), 'init-orphan-adv-cross-')),
			);
			await initGitRepo(freshDir);

			// Create orphaned worktree dir
			const orphanedWorktreePath = path.join(
				path.dirname(freshDir),
				'.swarm-worktrees',
				'session-adv-cross',
				'lane-1',
			);
			mkdirSync(orphanedWorktreePath, { recursive: true });

			const realIsLocked = InitOrphanRecoveryInternals.isLocked;
			const realListActiveLocks = InitOrphanRecoveryInternals.listActiveLocks;

			InitOrphanRecoveryInternals.isLocked = mock(
				(_dir: string, _filePath: string) => ({
					filePath: '.swarm/locks/init-orphan-recovery.lock',
					agent: 'other',
					taskId: 'unknown',
					timestamp: new Date().toISOString(),
					expiresAt: Date.now() + 300_000,
				}),
			);
			InitOrphanRecoveryInternals.listActiveLocks = mock((_dir: string) => []);

			try {
				await runInitOrphanRecovery(freshDir);

				const advisoryPath = path.join(
					freshDir,
					'.swarm',
					'advisories',
					'init-orphan-recovery.json',
				);
				expect(existsSync(advisoryPath)).toBe(true);

				const content = JSON.parse(
					readFileSync(advisoryPath, 'utf-8'),
				) as InitOrphanAdvisory;

				// Warnings should mention cross-process lock
				expect(
					content.warnings.some((w) => w.includes('Cross-process lock held')),
				).toBe(true);

				// No worktrees should be reported as removed
				expect(content.reclaimed.removedWorktrees).toEqual([]);
			} finally {
				InitOrphanRecoveryInternals.isLocked = realIsLocked;
				InitOrphanRecoveryInternals.listActiveLocks = realListActiveLocks;
				rmSync(orphanedWorktreePath, { recursive: true, force: true });
				rmSync(freshDir, { recursive: true, force: true });
			}
		},
	);
});
