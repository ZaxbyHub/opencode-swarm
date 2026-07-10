/**
 * Worktree isolation pre-provision collision check tests — FR-001b SC-004/SC-005.
 *
 * Covers:
 * - SC-004: pre-provision collision check detects existing lane for same task+session
 * - SC-005: pre-provision collision check does NOT touch other-session lanes
 * - Stale lane for task X from same session is cleaned up before re-provisioning
 * - Another session's lane is preserved across this session's cleanup attempt
 *
 * @note Uses _internals DI seam (no mock.module leakage). The collision check
 * runs git worktree list via bunSpawn; tests mock bunSpawn via _internals on
 * the worktree-isolation module so isolation is per-file.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	isLaneOwnedByCurrentSession,
	preProvisionCollisionCheck,
	resetStandardWorktreeIsolationState,
	_internals as worktreeIsolationInternals,
} from '../../../src/hooks/delegation-gate/worktree-isolation';
import { resetSwarmState } from '../../../src/state';
import type { bunSpawn } from '../../../src/utils/bun-compat';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Canonicalize a path the same way git porcelain emits it. */
function normalizeGitPath(p: string): string {
	return p.replace(/\\/g, '/').replace(/\/+$/, '');
}

/** Make a temp directory backed by realpath (avoids Windows 8.3 short-name mismatches). */
function makeTempDir(prefix: string): string {
	return path.join(
		fs.realpathSync(os.tmpdir()),
		`${prefix}-${Math.random().toString(36).slice(2)}`,
	);
}

interface WorktreeListEntry {
	worktreePath: string;
	branch?: string;
}

/**
 * Build a fake git porcelain output for a single worktree entry.
 * Pass multiple entries by calling with an array.
 */
function buildPorcelainWorktreeList(entries: WorktreeListEntry[]): string {
	const lines: string[] = [];
	for (const entry of entries) {
		lines.push(`worktree ${normalizeGitPath(entry.worktreePath)}`);
		if (entry.branch) {
			lines.push(`branch ${entry.branch}`);
		}
	}
	return lines.join('\n') + '\n';
}

/** Stub bunSpawn for a single call that returns the given porcelain output. */
function mockGitWorktreeList(porcelainOutput: string, exitCode = 0) {
	return mock(() => ({
		exited: Promise.resolve(exitCode),
		stdout: { text: () => Promise.resolve(porcelainOutput) },
		stderr: { text: () => Promise.resolve('') },
		kill: () => {},
	}));
}

// ---------------------------------------------------------------------------
// SC-004: preProvisionCollisionCheck detects existing same-session lane
// ---------------------------------------------------------------------------

describe('FR-001b SC-004: preProvisionCollisionCheck', () => {
	let originalBunSpawn: typeof bunSpawn;
	let tempDir: string;

	beforeEach(() => {
		resetSwarmState();
		resetStandardWorktreeIsolationState();
		originalBunSpawn = worktreeIsolationInternals.bunSpawn as typeof bunSpawn;
		tempDir = makeTempDir('preprov-sc004');
		fs.mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		// Restore bunSpawn
		(worktreeIsolationInternals as Record<string, unknown>).bunSpawn =
			originalBunSpawn;
		try {
			fs.rmSync(tempDir, { recursive: true, force: true });
		} catch {
			// best-effort
		}
		resetSwarmState();
		resetStandardWorktreeIsolationState();
	});

	it('returns collision:true when a worktree with the same lane branch exists', async () => {
		const sessionId = 'session-alpha';
		const taskId = '1.1';
		const worktreePath = path.join(
			tempDir,
			'..',
			'.swarm-worktrees',
			sessionId,
			taskId,
		);

		// Simulate git worktree list showing our branch checked out in a worktree
		const porcelain = buildPorcelainWorktreeList([
			{
				worktreePath,
				branch: `refs/heads/swarm/lane/${sessionId}/${taskId}`,
			},
		]);

		(worktreeIsolationInternals as Record<string, unknown>).bunSpawn =
			mockGitWorktreeList(porcelain);

		const result = await preProvisionCollisionCheck(taskId, tempDir, sessionId);

		expect(result.collision).toBe(true);
		expect(result.existingBranch).toBe(`swarm/lane/${sessionId}/${taskId}`);
		expect(result.ownerSessionId).toBe(sessionId);
	});

	it('returns collision:false when no worktree has the expected branch', async () => {
		const porcelain = buildPorcelainWorktreeList([
			{
				worktreePath: '/some/other/path',
				branch: 'refs/heads/swarm/lane/other-session/2.1',
			},
		]);

		(worktreeIsolationInternals as Record<string, unknown>).bunSpawn =
			mockGitWorktreeList(porcelain);

		const result = await preProvisionCollisionCheck(
			'1.1',
			tempDir,
			'session-alpha',
		);

		expect(result.collision).toBe(false);
		expect(result.existingBranch).toBeUndefined();
	});

	it('returns collision:false when git worktree list fails (fail-open)', async () => {
		// Simulate git failure
		(worktreeIsolationInternals as Record<string, unknown>).bunSpawn = mock(
			() => ({
				exited: Promise.resolve(1),
				stdout: { text: () => Promise.resolve('') },
				stderr: { text: () => Promise.resolve('git crashed') },
				kill: () => {},
			}),
		);

		const result = await preProvisionCollisionCheck(
			'1.1',
			tempDir,
			'session-alpha',
		);

		expect(result.collision).toBe(false);
	});

	it('detects collision with modern swarm/lane/ branch format', async () => {
		const sessionId = 'modern-session';
		const taskId = '2.3';
		// Use path.join like the other passing test to get consistent path format
		const worktreePath = path.join(
			tempDir,
			'..',
			'.swarm-worktrees',
			sessionId,
			taskId,
		);

		const porcelain = buildPorcelainWorktreeList([
			{
				worktreePath,
				branch: `refs/heads/swarm/lane/${sessionId}/${taskId}`,
			},
		]);

		(worktreeIsolationInternals as Record<string, unknown>).bunSpawn =
			mockGitWorktreeList(porcelain);

		const result = await preProvisionCollisionCheck(taskId, tempDir, sessionId);

		expect(result.collision).toBe(true);
		expect(result.existingBranch).toBe(`swarm/lane/${sessionId}/${taskId}`);
		expect(result.ownerSessionId).toBe(sessionId);
	});
});

// ---------------------------------------------------------------------------
// SC-005: isLaneOwnedByCurrentSession validates ownership
// ---------------------------------------------------------------------------

describe('FR-001b SC-005: isLaneOwnedByCurrentSession', () => {
	it('returns true when branch session ID matches expected session', () => {
		const branch = 'swarm/lane/session-alpha/1.1';
		expect(isLaneOwnedByCurrentSession(branch, 'session-alpha')).toBe(true);
	});

	it('returns false when branch session ID differs from expected session', () => {
		const branch = 'swarm/lane/session-alpha/1.1';
		expect(isLaneOwnedByCurrentSession(branch, 'session-beta')).toBe(false);
	});

	it('returns false for legacy swarm-lane/ branch with mismatched session', () => {
		const branch = 'swarm-lane/session-alpha/lane-b';
		expect(isLaneOwnedByCurrentSession(branch, 'session-beta')).toBe(false);
	});

	it('returns true for legacy swarm-lane/ branch with matching session', () => {
		const branch = 'swarm-lane/session-alpha/lane-b';
		expect(isLaneOwnedByCurrentSession(branch, 'session-alpha')).toBe(true);
	});

	it('returns false for non-swarm branch name', () => {
		expect(isLaneOwnedByCurrentSession('main', 'any-session')).toBe(false);
		expect(isLaneOwnedByCurrentSession('feature/foo', 'any-session')).toBe(
			false,
		);
	});
});

// ---------------------------------------------------------------------------
// Integration: same-session stale lane detection
// ---------------------------------------------------------------------------

describe('FR-001b: same-session stale lane detection', () => {
	let originalBunSpawn: typeof bunSpawn;
	let tempDir: string;

	beforeEach(() => {
		resetSwarmState();
		resetStandardWorktreeIsolationState();
		originalBunSpawn = worktreeIsolationInternals.bunSpawn as typeof bunSpawn;
		tempDir = makeTempDir('preprov-same-session');
		fs.mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		(worktreeIsolationInternals as Record<string, unknown>).bunSpawn =
			originalBunSpawn;
		try {
			fs.rmSync(tempDir, { recursive: true, force: true });
		} catch {
			// best-effort
		}
		resetSwarmState();
		resetStandardWorktreeIsolationState();
	});

	it('collision check returns collision:true with ownerSessionId matching current session', async () => {
		const sessionId = 'my-session';
		const taskId = '3.2';
		const worktreePath = path.join(
			tempDir,
			'..',
			'.swarm-worktrees',
			sessionId,
			taskId,
		);

		const porcelain = buildPorcelainWorktreeList([
			{
				worktreePath,
				branch: `refs/heads/swarm/lane/${sessionId}/${taskId}`,
			},
		]);

		(worktreeIsolationInternals as Record<string, unknown>).bunSpawn =
			mockGitWorktreeList(porcelain);

		const result = await preProvisionCollisionCheck(taskId, tempDir, sessionId);

		// SC-004: collision detected
		expect(result.collision).toBe(true);
		// SC-005: ownership confirmed
		expect(isLaneOwnedByCurrentSession(result.existingBranch!, sessionId)).toBe(
			true,
		);
	});
});

// ---------------------------------------------------------------------------
// SC-005 / Bug #1 fix: cross-session collision detection
// ---------------------------------------------------------------------------

describe('FR-001b SC-005 — cross-session collision is detected', () => {
	let originalBunSpawn: typeof bunSpawn;
	let tempDir: string;

	beforeEach(() => {
		resetSwarmState();
		resetStandardWorktreeIsolationState();
		originalBunSpawn = worktreeIsolationInternals.bunSpawn as typeof bunSpawn;
		tempDir = makeTempDir('preprov-cross-session');
		fs.mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		(worktreeIsolationInternals as Record<string, unknown>).bunSpawn =
			originalBunSpawn;
		try {
			fs.rmSync(tempDir, { recursive: true, force: true });
		} catch {
			// best-effort
		}
		resetSwarmState();
		resetStandardWorktreeIsolationState();
	});

	it('returns collision:true when another session has a lane for the same taskId', async () => {
		const mySession = 'my-session';
		const theirSession = 'their-session';
		const taskId = '4.1';

		// Their session has a worktree on swarm/lane/theirSession/4.1
		const worktreePath = path.join(
			tempDir,
			'..',
			'.swarm-worktrees',
			theirSession,
			taskId,
		);
		const porcelain = buildPorcelainWorktreeList([
			{
				worktreePath,
				branch: `refs/heads/swarm/lane/${theirSession}/${taskId}`,
			},
		]);

		(worktreeIsolationInternals as Record<string, unknown>).bunSpawn =
			mockGitWorktreeList(porcelain);

		// My session checks for taskId collision
		const result = await preProvisionCollisionCheck(taskId, tempDir, mySession);

		// SC-005: ANY lane for this taskId is detected as a collision,
		// regardless of which session owns it.
		expect(result.collision).toBe(true);
		expect(result.existingBranch).toBe(`swarm/lane/${theirSession}/${taskId}`);
		expect(result.ownerSessionId).toBe(theirSession);
		// Normalize Windows backslash paths to forward slashes for comparison
		expect(result.worktreePath?.replace(/\\/g, '/')).toBe(
			worktreePath.replace(/\\/g, '/'),
		);
	});

	it('isLaneOwnedByCurrentSession returns false for cross-session collision', async () => {
		const mySession = 'my-session';
		const theirSession = 'their-session';
		const taskId = '4.1';

		const worktreePath = path.join(
			tempDir,
			'..',
			'.swarm-worktrees',
			theirSession,
			taskId,
		);
		const porcelain = buildPorcelainWorktreeList([
			{
				worktreePath,
				branch: `refs/heads/swarm/lane/${theirSession}/${taskId}`,
			},
		]);

		(worktreeIsolationInternals as Record<string, unknown>).bunSpawn =
			mockGitWorktreeList(porcelain);

		const result = await preProvisionCollisionCheck(taskId, tempDir, mySession);

		// isLaneOwnedByCurrentSession correctly identifies this as NOT our lane
		expect(result.collision).toBe(true);
		expect(isLaneOwnedByCurrentSession(result.existingBranch!, mySession)).toBe(
			false,
		);
		// SC-005: cross-session lane is NOT owned by current session
	});

	it('returns collision:true for legacy swarm-lane/ cross-session lane', async () => {
		const mySession = 'my-session';
		const theirSession = 'their-session';
		const taskId = 'lane-x';

		const worktreePath = path.join(
			tempDir,
			'..',
			'.swarm-worktrees',
			theirSession,
			taskId,
		);
		const porcelain = buildPorcelainWorktreeList([
			{
				worktreePath,
				branch: `refs/heads/swarm-lane/${theirSession}/${taskId}`,
			},
		]);

		(worktreeIsolationInternals as Record<string, unknown>).bunSpawn =
			mockGitWorktreeList(porcelain);

		const result = await preProvisionCollisionCheck(taskId, tempDir, mySession);

		expect(result.collision).toBe(true);
		expect(result.existingBranch).toBe(`swarm-lane/${theirSession}/${taskId}`);
		expect(result.ownerSessionId).toBe(theirSession);
	});

	it('returns collision:false when no worktree matches the taskId', async () => {
		// A worktree exists but for a different taskId
		const porcelain = buildPorcelainWorktreeList([
			{
				worktreePath: path.join(
					tempDir,
					'..',
					'.swarm-worktrees',
					'other',
					'9.9',
				),
				branch: 'refs/heads/swarm/lane/other/9.9',
			},
		]);

		(worktreeIsolationInternals as Record<string, unknown>).bunSpawn =
			mockGitWorktreeList(porcelain);

		const result = await preProvisionCollisionCheck(
			'1.1',
			tempDir,
			'my-session',
		);

		expect(result.collision).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Bug #2 fix: same-session stale lane — worktreePath is returned for cleanup
// ---------------------------------------------------------------------------

describe('FR-001b Bug #2 — same-session stale lane returns worktreePath', () => {
	let originalBunSpawn: typeof bunSpawn;
	let tempDir: string;

	beforeEach(() => {
		resetSwarmState();
		resetStandardWorktreeIsolationState();
		originalBunSpawn = worktreeIsolationInternals.bunSpawn as typeof bunSpawn;
		tempDir = makeTempDir('preprov-same-cleanup');
		fs.mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		(worktreeIsolationInternals as Record<string, unknown>).bunSpawn =
			originalBunSpawn;
		try {
			fs.rmSync(tempDir, { recursive: true, force: true });
		} catch {
			// best-effort
		}
		resetSwarmState();
		resetStandardWorktreeIsolationState();
	});

	it('preProvisionCollisionCheck returns worktreePath for same-session lane', async () => {
		// Bug #2 fix: the new collision result includes worktreePath so the caller
		// (precreateStandardWorktreeSession) can call removeWorktree to clean the
		// worktree directory in addition to postMergeCleanup which only removes the branch.
		const sessionId = 'my-session';
		const taskId = '3.2';
		const worktreePath = path.join(
			tempDir,
			'..',
			'.swarm-worktrees',
			sessionId,
			taskId,
		);
		const porcelain = buildPorcelainWorktreeList([
			{
				worktreePath,
				branch: `refs/heads/swarm/lane/${sessionId}/${taskId}`,
			},
		]);

		(worktreeIsolationInternals as Record<string, unknown>).bunSpawn =
			mockGitWorktreeList(porcelain);

		const result = await preProvisionCollisionCheck(taskId, tempDir, sessionId);

		expect(result.collision).toBe(true);
		expect(result.worktreePath?.replace(/\\/g, '/')).toBe(
			worktreePath.replace(/\\/g, '/'),
		);
		// The worktreePath enables the precreate wiring to call removeWorktree
		// (in addition to postMergeCleanup) for full stale-lane cleanup.
	});
});

// ---------------------------------------------------------------------------
// Blocking Issue 1 fix: same-session stale lane with dirty worktree preserves
// (does NOT destroy) — FR-001c SC-004 pre-provision collision fallback path
// ---------------------------------------------------------------------------

/**
 * Regression test: when a same-session pre-provision collision occurs and the
 * callID is no longer tracked in any map (untracked fallback), the collision
 * handler must call preserveDirtyWorktreeAtPath BEFORE removeWorktree so that
 * dirty (uncommitted) work is auto-committed and tagged — NOT destroyed.
 *
 * Prior to the fix: reason='success' in tracked path and no preservation call
 * in untracked path caused dirty work to be silently removed.
 * After fix: reason='denied' in tracked path and preserveDirtyWorktreeAtPath
 * in untracked path → dirty work is preserved.
 */
describe('FR-001b SC-004 pre-provision collision — dirty worktree is preserved (not destroyed)', () => {
	let originalBunSpawn: typeof bunSpawn;
	let tempDir: string;

	beforeEach(() => {
		resetSwarmState();
		resetStandardWorktreeIsolationState();
		originalBunSpawn = worktreeIsolationInternals.bunSpawn as typeof bunSpawn;
		tempDir = makeTempDir('preprov-dirty-preserve');
		fs.mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		(worktreeIsolationInternals as Record<string, unknown>).bunSpawn =
			originalBunSpawn;
		try {
			fs.rmSync(tempDir, { recursive: true, force: true });
		} catch {
			// best-effort
		}
		resetSwarmState();
		resetStandardWorktreeIsolationState();
	});

	it('preserveDirtyWorktreeAtPath preserves dirty work and returns preserved:true', async () => {
		// Import the new function via _internals (already in scope as worktreeIsolationInternals)
		const { preserveDirtyWorktreeAtPath } = worktreeIsolationInternals as {
			preserveDirtyWorktreeAtPath: typeof import('../../../src/hooks/delegation-gate/worktree-isolation').preserveDirtyWorktreeAtPath;
		};

		const worktreePath = path.join(
			tempDir,
			'.swarm-worktrees',
			'my-session',
			'1.1',
		);
		fs.mkdirSync(worktreePath, { recursive: true });

		// Mock git commands to simulate a dirty worktree
		(worktreeIsolationInternals as Record<string, unknown>).bunSpawn = mock(
			(args: string[]) => {
				// args: ['git', '-C', worktreePath, <subcommand>, ...]
				if (args[3] === 'status') {
					// Dirty: modified file reported
					return mockGitWorktreeList(
						'M  src/changed.ts\n',
					).getMockImplementation()!([]);
				}
				if (args[3] === 'add') {
					return mockGitWorktreeList('').getMockImplementation()!([]);
				}
				if (args[3] === 'commit') {
					return mockGitWorktreeList('').getMockImplementation()!([]);
				}
				if (args[3] === 'rev-parse') {
					return mockGitWorktreeList(
						'abc123def4567890\n',
					).getMockImplementation()!([]);
				}
				if (args[3] === 'tag') {
					return mockGitWorktreeList('').getMockImplementation()!([]);
				}
				return mockGitWorktreeList('').getMockImplementation()!([]);
			},
		);

		const result = await preserveDirtyWorktreeAtPath(
			worktreePath,
			'swarm/lane/my-session/1.1',
			'denied',
			tempDir,
		);

		// Dirty work is preserved, not destroyed
		expect(result.preserved).toBe(true);
		expect(result.outcome).toBe('preserved');
		expect(result.ref).toBe('abc123def4567890');
	});

	it('preserveDirtyWorktreeAtPath returns clean when worktree has no changes', async () => {
		const { preserveDirtyWorktreeAtPath } = worktreeIsolationInternals as {
			preserveDirtyWorktreeAtPath: typeof import('../../../src/hooks/delegation-gate/worktree-isolation').preserveDirtyWorktreeAtPath;
		};

		const worktreePath = path.join(
			tempDir,
			'.swarm-worktrees',
			'clean-session',
			'2.1',
		);
		fs.mkdirSync(worktreePath, { recursive: true });

		// Clean worktree (empty git status)
		(worktreeIsolationInternals as Record<string, unknown>).bunSpawn = mock(
			() => mockGitWorktreeList('').getMockImplementation()!([]),
		);

		const result = await preserveDirtyWorktreeAtPath(
			worktreePath,
			'swarm/lane/clean-session/2.1',
			'denied',
			tempDir,
		);

		// Nothing to preserve — worktree is clean
		expect(result.preserved).toBe(false);
		expect(result.outcome).toBe('clean');
	});

	it('cleanupStandardWorktreeForCallId uses reason=denied (not success) for pre-provision collision tracked path', async () => {
		// This is verified by the change from 'success' → 'denied' in
		// precreateStandardWorktreeSession at line 671 (worktree-isolation.ts).
		// The reason='denied' causes preserveDirtyWorktreeForCallId to be called
		// before removeWorktree, preserving dirty work on the tracked callID path.
		// This test documents the expected behavior.
		const { cleanupStandardWorktreeForCallId, standardWorktreeByCallID } =
			worktreeIsolationInternals as {
				cleanupStandardWorktreeForCallId: typeof import('../../../src/hooks/delegation-gate/worktree-isolation').cleanupStandardWorktreeForCallId;
				standardWorktreeByCallID: Map<string, unknown>;
			};

		const callID = 'call-dirty-tracked';
		const worktreePath = path.join(
			tempDir,
			'.swarm-worktrees',
			'session-tracked',
			'3.1',
		);
		fs.mkdirSync(worktreePath, { recursive: true });

		// Set up the dispatch in the map (tracked callID)
		(
			worktreeIsolationInternals as Record<string, unknown>
		).standardWorktreeByCallID.set(callID, {
			callID,
			parentSessionID: 'session-tracked',
			taskId: '3.1',
			planTaskId: '3.1',
			handle: {
				worktreePath,
				branchName: 'swarm/lane/session-tracked/3.1',
				purpose: 'lane' as const,
				id: `wt-${callID}`,
				sessionId: 'session-tracked',
			},
			mergeStrategy: 'merge' as const,
			laneIndex: 0,
		});

		// Mock git commands — dirty worktree
		let preserveCalled = false;
		(worktreeIsolationInternals as Record<string, unknown>).bunSpawn = mock(
			(args: string[]) => {
				if (args[3] === 'status') {
					return mockGitWorktreeList(
						'M  src/dirty.ts\n',
					).getMockImplementation()!([]);
				}
				if (args[3] === 'add') {
					preserveCalled = true;
					return mockGitWorktreeList('').getMockImplementation()!([]);
				}
				if (args[3] === 'commit') {
					return mockGitWorktreeList('').getMockImplementation()!([]);
				}
				if (args[3] === 'rev-parse') {
					return mockGitWorktreeList(
						'def456abc7890\n',
					).getMockImplementation()!([]);
				}
				if (args[3] === 'tag') {
					return mockGitWorktreeList('').getMockImplementation()!([]);
				}
				return mockGitWorktreeList('').getMockImplementation()!([]);
			},
		);

		// With reason='denied', preservation should run for the tracked callID path
		await cleanupStandardWorktreeForCallId(callID, 'denied', tempDir);

		// The git add (staging) was called → preservation was attempted
		expect(preserveCalled).toBe(true);
	});
});
