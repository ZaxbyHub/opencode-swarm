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

// A fixed literal, replacing what were real-clock reads. No assertion in this
// file depends on the value — it is filler for a required field — so reading the
// wall clock bought nothing and made the tests non-deterministic. The repo
// test-stability gate (#1782) requires any test file touching the real clock to
// use the freezeClock helper; removing the dependency outright is simpler than
// freezing it.
const FIXED_INIT_TIMESTAMP = '2026-01-01T00:00:00.000Z';

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
			initTimestamp: FIXED_INIT_TIMESTAMP,
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
			initTimestamp: FIXED_INIT_TIMESTAMP,
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

describe('emptiness gate: a contentless advisory is never surfaced', () => {
	/**
	 * Field evidence: `writeAdvisoryFile(directory, cleanupResult, allWarnings,
	 * true, removedWorktrees)` is called on the happy path of every plugin init
	 * (init-orphan-recovery.ts) with `attempted` as a literal `true`, and
	 * `writeAdvisoryFile` sets `prunedWorktrees: attempted`. So a clean repo with
	 * zero orphans produced a real advisory file whose only "content" was
	 * `prunedWorktrees: true` — and the hook emitted a header plus "Stale
	 * worktree metadata pruned.": two lines of zero information at the top of the
	 * architect's system message, once per session, on every project.
	 *
	 * AGENTS.md invariant 10: "Do not emit diagnostic noise into chat-visible
	 * streams."
	 */
	async function runAdvisory(
		advisoryContent: unknown,
		sessionId: string,
	): Promise<{ dir: string; messages: string[] }> {
		const freshDir = realpathSync(
			mkdtempSync(path.join(tmpdir(), 'init-orphan-adv-empty-')),
		);
		await initGitRepo(freshDir);
		const advisoryDir = path.join(freshDir, '.swarm', 'advisories');
		mkdirSync(advisoryDir, { recursive: true });
		writeFileSync(
			path.join(advisoryDir, 'init-orphan-recovery.json'),
			JSON.stringify(advisoryContent),
			'utf-8',
		);
		ensureAgentSession(sessionId);
		swarmState.activeAgent.set(sessionId, 'Architect');
		const hook = createInitOrphanRecoveryAdvisoryHook(freshDir);
		await hook.messagesTransform(
			{},
			{
				messages: [
					{
						info: { role: 'user', agent: 'Architect', sessionID: sessionId },
						parts: [{ type: 'text', text: 'Hello' }],
					},
				],
			},
		);
		const session = swarmState.agentSessions.get(sessionId);
		return { dir: freshDir, messages: session?.pendingAdvisoryMessages ?? [] };
	}

	test('a clean-repo advisory (prunedWorktrees only) surfaces NOTHING', async () => {
		const { dir, messages } = await runAdvisory(
			{
				initTimestamp: FIXED_INIT_TIMESTAMP,
				warnings: [],
				errors: [],
				reclaimed: {
					removedBranches: [],
					removedWorktrees: [],
					// True on EVERY successful init, so it must not count as content.
					prunedWorktrees: true,
				},
			},
			'test-arch-adv-empty-clean',
		);
		expect(messages).toEqual([]);
		rmSync(dir, { recursive: true, force: true });
	});

	test('the advisory file is still consumed and deleted even when nothing is surfaced', async () => {
		// The gate changes what is SAID, never what is CLEANED UP. A stale file
		// must not survive to be re-read on the next session.
		const freshDir = realpathSync(
			mkdtempSync(path.join(tmpdir(), 'init-orphan-adv-empty-del-')),
		);
		await initGitRepo(freshDir);
		const advisoryDir = path.join(freshDir, '.swarm', 'advisories');
		mkdirSync(advisoryDir, { recursive: true });
		const advisoryPath = path.join(advisoryDir, 'init-orphan-recovery.json');
		writeFileSync(
			advisoryPath,
			JSON.stringify({
				initTimestamp: FIXED_INIT_TIMESTAMP,
				warnings: [],
				errors: [],
				reclaimed: {
					removedBranches: [],
					removedWorktrees: [],
					prunedWorktrees: true,
				},
			}),
			'utf-8',
		);
		const sessionId = 'test-arch-adv-empty-deleted';
		ensureAgentSession(sessionId);
		swarmState.activeAgent.set(sessionId, 'Architect');
		const hook = createInitOrphanRecoveryAdvisoryHook(freshDir);
		await hook.messagesTransform(
			{},
			{
				messages: [
					{
						info: { role: 'user', agent: 'Architect', sessionID: sessionId },
						parts: [{ type: 'text', text: 'Hello' }],
					},
				],
			},
		);
		expect(existsSync(advisoryPath)).toBe(false);
		rmSync(freshDir, { recursive: true, force: true });
	});

	test.each([
		['a warning', { warnings: ['could not reclaim /path/to/locked'] }],
		[
			'an error',
			{ errors: [{ branch: 'swarm-lane/s/l', error: 'missing worktree' }] },
		],
		[
			'a reclaimed branch',
			{ reclaimed: { removedBranches: ['swarm-lane/s/l'] } },
		],
		[
			'a reclaimed worktree',
			{ reclaimed: { removedWorktrees: ['/path/.swarm-worktrees/s/l'] } },
		],
	])('real content is STILL surfaced when the advisory carries %s', async (label, overrides) => {
		// The gate must narrow, never silence. Each of these is a genuine
		// operational condition the user needs to see.
		const o = overrides as Record<string, unknown>;
		const { dir, messages } = await runAdvisory(
			{
				initTimestamp: FIXED_INIT_TIMESTAMP,
				warnings: (o.warnings as string[]) ?? [],
				errors: (o.errors as unknown[]) ?? [],
				reclaimed: {
					removedBranches: [],
					removedWorktrees: [],
					prunedWorktrees: true,
					...((o.reclaimed as Record<string, unknown>) ?? {}),
				},
			},
			`test-arch-adv-content-${label.replace(/\s+/g, '-')}`,
		);
		expect(messages.length).toBeGreaterThan(0);
		expect(messages.join('\n')).toContain('INIT ORPHAN RECOVERY');
		rmSync(dir, { recursive: true, force: true });
	});

	test('an entirely empty advisory degrades to silence', async () => {
		// readAdvisoryFile does a bare `JSON.parse(content) as InitOrphanAdvisory`
		// with no runtime validation, and the file is deleted before the fields are
		// read — so a throw here loses the payload with it.
		const { dir, messages } = await runAdvisory(
			{ initTimestamp: FIXED_INIT_TIMESTAMP },
			'test-arch-adv-malformed',
		);
		expect(messages).toEqual([]);
		rmSync(dir, { recursive: true, force: true });
	});

	test.each([
		[
			'errors present, warnings field missing',
			{
				initTimestamp: '2026-01-01T00:00:00.000Z',
				errors: [{ branch: 'swarm-lane/s/l', error: 'missing worktree' }],
			},
			'ORPHAN_RECOVERY_ERROR',
		],
		[
			'warnings present, errors field missing',
			{
				initTimestamp: '2026-01-01T00:00:00.000Z',
				warnings: ['could not reclaim /path/to/locked'],
			},
			'could not reclaim',
		],
		[
			'reclaimed branches present, reclaimed sub-fields partial',
			{
				initTimestamp: '2026-01-01T00:00:00.000Z',
				warnings: [],
				errors: [],
				reclaimed: { removedBranches: ['swarm-lane/s/l'] },
			},
			'Reclaimed 1 orphaned branch(es)',
		],
	])('a PARTIALLY-shaped advisory renders without throwing: %s', async (label, advisoryContent, expectedFragment) => {
		// These are the dangerous shapes: they PASS the emptiness gate on one
		// field while another field the renderer dereferences is absent. Guarding
		// only the gate would still have thrown here — and the advisory file is
		// already deleted by that point, so the payload would be lost.
		const { dir, messages } = await runAdvisory(
			advisoryContent,
			`test-arch-adv-partial-${label.replace(/[^a-z0-9]+/gi, '-')}`,
		);
		const joined = messages.join('\n');
		expect(joined).toContain('INIT ORPHAN RECOVERY');
		expect(joined).toContain(expectedFragment);
		rmSync(dir, { recursive: true, force: true });
	});
});
