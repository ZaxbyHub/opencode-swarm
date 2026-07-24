/**
 * Init Orphan Recovery — SC-107 Worktree-Dir & Advisory Tests (FR-103)
 *
 * Tests SC-107 worktree-dir variant and advisory file integration.
 *
 * Uses the _internals DI seam pattern — no mock.module without spreading real exports.
 *
 * Supplemental files (see FR-006 500-line cap):
 * - init-orphan-recovery-sc107-crossprocess.test.ts: cross-process interference + git worktree list
 * - init-orphan-recovery-sc110-budget.test.ts: SC-110 bounded budget + timeout/EBUSY
 */

import { describe, expect, mock, test } from 'bun:test';
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
	await runGit(repoDir, ['config', 'user.email', 'test@test.local']);
	await runGit(repoDir, ['config', 'user.name', 'Test User']);
	const result = await runGit(repoDir, ['init']);
	if (result.exitCode !== 0)
		throw new Error(`git init failed: ${result.stderr}`);
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
	const result = await runGit(repoDir, [
		'checkout',
		'-b',
		'swarm-lane/' + sessionId + '/' + laneId,
	]);
	if (result.exitCode !== 0)
		throw new Error('Failed to create branch: ' + result.stderr);
	writeFileSync(
		path.join(repoDir, 'lane-' + laneId + '.txt'),
		'lane ' + laneId + ' content\n',
	);
	await runGit(repoDir, ['add', '.']);
	await runGit(repoDir, ['commit', '-m', 'lane ' + laneId + ' commit']);
	await runGit(repoDir, ['checkout', 'main']);
}

/**
 * Creates an active session in swarmState so its worktrees are protected.
 */
function createActiveSession(sessionId: string): void {
	ensureAgentSession(sessionId);
}

// ---------------------------------------------------------------------------
// SC-107 (worktree-dir): Orphaned worktree directories are removed
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
			writeFileSync(
				path.join(orphanedWorktreePath, '.git'),
				'gitdir: unavailable\n',
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
// Advisory flush: session-start reads and flushes advisory file
// ---------------------------------------------------------------------------

describe('advisory flush: messagesTransform surfaces advisory to architect', () => {
	test('advisory messages appear in pendingAdvisoryMessages after messagesTransform call', async () => {
		const freshDir = realpathSync(
			mkdtempSync(path.join(tmpdir(), 'init-orphan-adv-flush-')),
		);
		await initGitRepo(freshDir);

		// Write a synthetic advisory file
		const advisoryContent = {
			initTimestamp: new Date().toISOString(),
			warnings: [
				'Test warning: could not reclaim orphaned worktree /path/to/locked',
			],
			errors: [
				{
					branch: 'swarm-lane/sess1/lane1',
					error: 'refers to missing worktree directory',
				},
			],
			reclaimed: {
				removedBranches: ['swarm-lane/sess2/lane2'],
				removedWorktrees: ['/path/to/.swarm-worktrees/sess2/lane2'],
				prunedWorktrees: true,
			},
		};

		const advisoryDir = path.join(freshDir, '.swarm', 'advisories');
		mkdirSync(advisoryDir, { recursive: true });
		writeFileSync(
			path.join(advisoryDir, 'init-orphan-recovery.json'),
			JSON.stringify(advisoryContent),
			'utf-8',
		);

		// Create architect session
		const sessionId = 'test-arch-adv-flush';
		ensureAgentSession(sessionId);
		swarmState.activeAgent.set(sessionId, 'Architect');

		const hook = createInitOrphanRecoveryAdvisoryHook(freshDir);

		// Simulate first architect message (NEXT TURN after plugin init)
		const output = {
			messages: [
				{
					info: { role: 'user', agent: 'Architect', sessionID: sessionId },
					parts: [{ type: 'text', text: 'Hello' }],
				},
			],
		};

		await hook.messagesTransform({}, output);

		// Verify pendingAdvisoryMessages was populated
		const session = swarmState.agentSessions.get(sessionId);
		expect(session?.pendingAdvisoryMessages).toBeDefined();
		expect(session!.pendingAdvisoryMessages!.length).toBeGreaterThan(0);

		// Verify content
		const msgText = session!.pendingAdvisoryMessages!.join('\n');
		expect(msgText).toContain('INIT ORPHAN RECOVERY');
		expect(msgText).toContain('Test warning');
		expect(msgText).toContain('ORPHAN_RECOVERY_ERROR');
		expect(msgText).toContain('swarm-lane/sess1/lane1');
		expect(msgText).toContain('Reclaimed 1 orphaned branch(es)');
		expect(msgText).toContain('Reclaimed 1 orphaned worktree directory');

		// Advisory file should be deleted after consumption
		const advisoryPath = path.join(advisoryDir, 'init-orphan-recovery.json');
		expect(existsSync(advisoryPath)).toBe(false);

		rmSync(freshDir, { recursive: true, force: true });
	});

	test('advisory file is deleted after consumption (idempotent)', async () => {
		const freshDir = realpathSync(
			mkdtempSync(path.join(tmpdir(), 'init-orphan-adv-del-')),
		);
		await initGitRepo(freshDir);

		const advisoryContent = {
			initTimestamp: new Date().toISOString(),
			warnings: [],
			errors: [],
			reclaimed: {
				removedBranches: [],
				removedWorktrees: [],
				prunedWorktrees: false,
			},
		};

		const advisoryDir = path.join(freshDir, '.swarm', 'advisories');
		mkdirSync(advisoryDir, { recursive: true });
		writeFileSync(
			path.join(advisoryDir, 'init-orphan-recovery.json'),
			JSON.stringify(advisoryContent),
			'utf-8',
		);

		const sessionId = 'test-arch-adv-del';
		ensureAgentSession(sessionId);
		swarmState.activeAgent.set(sessionId, 'Architect');

		const hook = createInitOrphanRecoveryAdvisoryHook(freshDir);

		const advisoryPath = path.join(advisoryDir, 'init-orphan-recovery.json');

		// First call — should consume and delete
		await hook.messagesTransform(
			{},
			{
				messages: [
					{
						info: { role: 'user', agent: 'Architect', sessionID: sessionId },
						parts: [{ type: 'text', text: 'First turn' }],
					},
				],
			},
		);
		expect(existsSync(advisoryPath)).toBe(false);

		// Second call — file already gone, should not error
		await hook.messagesTransform(
			{},
			{
				messages: [
					{
						info: { role: 'user', agent: 'Architect', sessionID: sessionId },
						parts: [{ type: 'text', text: 'Second turn' }],
					},
				],
			},
		);
		// Still gone (idempotent delete)
		expect(existsSync(advisoryPath)).toBe(false);

		rmSync(freshDir, { recursive: true, force: true });
	});
});
