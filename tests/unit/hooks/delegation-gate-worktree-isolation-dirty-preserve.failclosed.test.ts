/**
 * FR-001c: Dirty-state preservation — fail-closed regression tests
 *
 * Tests that preservation failure (commit failure, add failure, tag failure)
 * causes cleanup to be aborted, preserving the worktree and branch.
 *
 * @note Uses Tier 1 DI (mock _internals.bunSpawn) for unit tests.
 * The integration test is in delegation-gate-worktree-isolation-dirty-preserve.integration.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	_internals,
	awaitingMergeByCallID,
	cleanupStandardWorktreeForCallId,
	preserveDirtyWorktreeForCallId,
	resetStandardWorktreeIsolationState,
	type StandardWorktreeDispatch,
	standardWorktreeByCallID,
} from '../../../src/hooks/delegation-gate/worktree-isolation';
import { ensureAgentSession, resetSwarmState } from '../../../src/state';
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
		worktree_dir: undefined,
	};
}

/**
 * Creates a minimal BunCompatSubprocess mock return value.
 * bunSpawn returns the subprocess object synchronously (not a Promise),
 * but .exited is a Promise<number>.
 */
function makeSpawnResult(opts: {
	exitCode?: number;
	stdout?: string;
	stderr?: string;
}): {
	exited: Promise<number>;
	stdout: { text(): Promise<string>; getReader(): unknown };
	stderr: { text(): Promise<string>; getReader(): unknown };
	exitCode: number | null;
	kill(): void;
} {
	return {
		exited: Promise.resolve(opts.exitCode ?? 0),
		stdout: {
			text: () => Promise.resolve(opts.stdout ?? ''),
			getReader: () => ({ releaseLock: () => {} }),
		},
		stderr: {
			text: () => Promise.resolve(opts.stderr ?? ''),
			getReader: () => ({ releaseLock: () => {} }),
		},
		exitCode: opts.exitCode ?? 0,
		kill: () => {},
	};
}

// ─── cleanupStandardWorktreeForCallId: preservation wired into cleanup ─────────

describe('FR-001c SC-002/SC-003: preserveDirtyWorktreeForCallId called before cleanup on denial/cancellation', () => {
	let tempDir: string;
	let originalBunSpawn: typeof _internals.bunSpawn;
	let originalRemoveWorktree: typeof _internals.removeWorktree;
	let originalPostMergeCleanup: typeof _internals.postMergeCleanup;

	beforeEach(() => {
		resetStandardWorktreeIsolationState();
		resetSwarmState();
		tempDir = makeTempProject('fr001c-cleanup-pres-');
		ensureAgentSession('test-session');
		// Snapshot for restoration — this suite mocks _internals without restoring
		originalBunSpawn = _internals.bunSpawn;
		originalRemoveWorktree = _internals.removeWorktree;
		originalPostMergeCleanup = _internals.postMergeCleanup;
	});

	afterEach(() => {
		resetStandardWorktreeIsolationState();
		resetSwarmState();
		// Restore mocked _internals to prevent cross-test pollution (bun:test shares
		// the module cache across test files in the same process).
		_internals.bunSpawn = originalBunSpawn;
		_internals.removeWorktree = originalRemoveWorktree;
		_internals.postMergeCleanup = originalPostMergeCleanup;
		try {
			fs.rmSync(tempDir, { recursive: true, force: true });
		} catch {
			// best-effort
		}
	});

	it('calls preserveDirtyWorktreeForCallId BEFORE removeWorktree on denial', async () => {
		const callID = 'call-preserve-order-denied';
		const worktreePath = path.join(tempDir, 'wt-pres-order');
		fs.mkdirSync(worktreePath, { recursive: true });
		const branchName = 'swarm-lane/test-session/lane-pres-order';
		const dispatch = makeMockDispatch(callID, worktreePath, branchName);

		standardWorktreeByCallID.set(callID, dispatch);

		const bunSpawnCallArgs: string[][] = [];

		_internals.bunSpawn = mock((args: string[]) => {
			bunSpawnCallArgs.push(args);
			if (args[3] === 'status') {
				return makeSpawnResult({ stdout: 'M  dirty.txt\n' });
			}
			return makeSpawnResult({});
		});

		_internals.removeWorktree = mock(async () => ({ success: true }));
		_internals.postMergeCleanup = mock(async () => ({ cleaned: true }));

		await cleanupStandardWorktreeForCallId(callID, 'denied', tempDir);

		// Preservation calls must come before cleanup
		const statusCalls = bunSpawnCallArgs.filter((a) => a[3] === 'status');
		expect(statusCalls.length).toBeGreaterThan(0);
	});

	it('does NOT call preserveDirtyWorktreeForCallId on success reason', async () => {
		const callID = 'call-preserve-noop-success';
		const worktreePath = path.join(tempDir, 'wt-no-pres-success');
		fs.mkdirSync(worktreePath, { recursive: true });
		const branchName = 'swarm-lane/test-session/lane-no-pres';
		const dispatch = makeMockDispatch(callID, worktreePath, branchName);

		standardWorktreeByCallID.set(callID, dispatch);

		let bunSpawnCalls = 0;
		_internals.bunSpawn = mock(() => {
			bunSpawnCalls++;
			return makeSpawnResult({});
		});

		_internals.removeWorktree = mock(async () => ({ success: true }));
		_internals.postMergeCleanup = mock(async () => ({ cleaned: true }));

		// Success reason — preserve should NOT be called
		await cleanupStandardWorktreeForCallId(callID, 'success', tempDir);

		// bunSpawn should not be called for preservation (no git status needed on success)
		expect(bunSpawnCalls).toBe(0);
	});

	it('calls preserveDirtyWorktreeForCallId on cancelled reason', async () => {
		const callID = 'call-preserve-cancelled';
		const worktreePath = path.join(tempDir, 'wt-pres-cancelled');
		fs.mkdirSync(worktreePath, { recursive: true });
		const branchName = 'swarm-lane/test-session/lane-pres-cancelled';
		const dispatch = makeMockDispatch(callID, worktreePath, branchName);

		standardWorktreeByCallID.set(callID, dispatch);

		let statusCalls = 0;
		_internals.bunSpawn = mock((args: string[]) => {
			if (args[3] === 'status') {
				statusCalls++;
				return makeSpawnResult({ stdout: 'M  cancelled-dirty.txt\n' });
			}
			return makeSpawnResult({});
		});

		_internals.removeWorktree = mock(async () => ({ success: true }));
		_internals.postMergeCleanup = mock(async () => ({ cleaned: true }));

		await cleanupStandardWorktreeForCallId(callID, 'cancelled', tempDir);

		// Status should have been called (preservation was triggered)
		expect(statusCalls).toBeGreaterThan(0);
	});

	// ─── FR-001c fail-closed: preservation failure → no cleanup ─────────────────

	it('FR-001c fail-closed: preserves worktree AND branch when dirty but preservation fails (denied)', async () => {
		const callID = 'call-failclosed-denied';
		const worktreePath = path.join(tempDir, 'wt-failclosed-denied');
		fs.mkdirSync(worktreePath, { recursive: true });
		const branchName = 'swarm-lane/test-session/lane-failclosed';
		const dispatch = makeMockDispatch(callID, worktreePath, branchName);

		standardWorktreeByCallID.set(callID, dispatch);
		awaitingMergeByCallID.set(callID, {
			callID,
			parentSessionID: 'test-session',
			taskId: '1.1',
			planTaskId: '1.1',
			branch: branchName,
			worktreePath,
			mergeStrategy: 'merge',
			queuedAt: Date.now(),
		});

		// Simulate dirty worktree where git commit FAILS (e.g. no git identity configured).
		// Status returns dirty, add succeeds, but commit fails with exit code 1.
		let gitStatusCalls = 0;
		_internals.bunSpawn = mock((args: string[]) => {
			if (args[3] === 'status') {
				gitStatusCalls++;
				return makeSpawnResult({ stdout: 'M  dirty-work.txt\n' });
			}
			if (args[3] === 'add') {
				return makeSpawnResult({});
			}
			if (args[3] === 'commit') {
				// Simulate commit failure (e.g. "Author identity unknown" or hook rejection)
				return makeSpawnResult({
					exitCode: 1,
					stderr: 'Author identity unknown.',
				});
			}
			return makeSpawnResult({});
		});

		const removeCalls: Array<{ worktreePath: string; projectRoot: string }> =
			[];
		const cleanupCalls: Array<{ directory: string; branchName: string }> = [];

		_internals.removeWorktree = mock(
			async (wtPath: string, projectRoot: string) => {
				removeCalls.push({ worktreePath: wtPath, projectRoot });
				return { success: true };
			},
		);

		_internals.postMergeCleanup = mock(
			async (directory: string, branch: string) => {
				cleanupCalls.push({ directory, branchName: branch });
				return { cleaned: true };
			},
		);

		await cleanupStandardWorktreeForCallId(callID, 'denied', tempDir);

		// removeWorktree should NOT be called — worktree must be preserved
		expect(removeCalls).toHaveLength(0);
		// postMergeCleanup (branch delete) should NOT be called — branch must be preserved
		expect(cleanupCalls).toHaveLength(0);

		// Maps should be cleared so future retry can pick up the worktree state
		expect(standardWorktreeByCallID.has(callID)).toBe(false);
		expect(awaitingMergeByCallID.has(callID)).toBe(false);

		// Worktree directory should still exist on disk
		expect(fs.existsSync(worktreePath)).toBe(true);

		// Advisory must mention preservation failure and aborted cleanup
		const session = ensureAgentSession('test-session');
		expect(
			session.pendingAdvisoryMessages!.some(
				(m) =>
					m.includes('STANDARD_WORKTREE_PRESERVATION_FAILED_ABORT_CLEANUP') &&
					m.includes(callID) &&
					m.includes('Author identity unknown'),
			),
		).toBe(true);
	});

	it('FR-001c fail-closed: preserves worktree AND branch when dirty but preservation fails (cancelled)', async () => {
		const callID = 'call-failclosed-cancelled';
		const worktreePath = path.join(tempDir, 'wt-failclosed-cancelled');
		fs.mkdirSync(worktreePath, { recursive: true });
		const branchName = 'swarm-lane/test-session/lane-failclosed-cancel';
		const dispatch = makeMockDispatch(callID, worktreePath, branchName);

		standardWorktreeByCallID.set(callID, dispatch);

		// Simulate dirty worktree where git add fails.
		_internals.bunSpawn = mock((args: string[]) => {
			if (args[3] === 'status') {
				return makeSpawnResult({ stdout: '?? untracked.txt\n' });
			}
			if (args[3] === 'add') {
				return makeSpawnResult({
					exitCode: 128,
					stderr: 'fatal: cannot index',
				});
			}
			return makeSpawnResult({});
		});

		const removeCalls: Array<{ worktreePath: string; projectRoot: string }> =
			[];
		const cleanupCalls: Array<{ directory: string; branchName: string }> = [];

		_internals.removeWorktree = mock(
			async (wtPath: string, projectRoot: string) => {
				removeCalls.push({ worktreePath: wtPath, projectRoot });
				return { success: true };
			},
		);

		_internals.postMergeCleanup = mock(
			async (directory: string, branch: string) => {
				cleanupCalls.push({ directory, branchName: branch });
				return { cleaned: true };
			},
		);

		await cleanupStandardWorktreeForCallId(callID, 'cancelled', tempDir);

		// removeWorktree should NOT be called
		expect(removeCalls).toHaveLength(0);
		// postMergeCleanup should NOT be called
		expect(cleanupCalls).toHaveLength(0);

		// Worktree directory should still exist
		expect(fs.existsSync(worktreePath)).toBe(true);

		// Advisory must mention preservation failure
		const session = ensureAgentSession('test-session');
		expect(
			session.pendingAdvisoryMessages!.some(
				(m) =>
					m.includes('STANDARD_WORKTREE_PRESERVATION_FAILED_ABORT_CLEANUP') &&
					m.includes('cannot index'),
			),
		).toBe(true);
	});

	// ─── FR-001c regression: tag failure is preserve-failed ───────────────────

	it('FR-001c fail-closed: git tag failure returns preserve-failed and aborts cleanup', async () => {
		const callID = 'call-tag-fail-failclosed';
		const worktreePath = path.join(tempDir, 'wt-tag-fail');
		fs.mkdirSync(worktreePath, { recursive: true });
		const branchName = 'swarm-lane/test-session/lane-tag-fail';
		const dispatch = makeMockDispatch(callID, worktreePath, branchName);

		standardWorktreeByCallID.set(callID, dispatch);
		awaitingMergeByCallID.set(callID, {
			callID,
			parentSessionID: 'test-session',
			taskId: '1.1',
			planTaskId: '1.1',
			branch: branchName,
			worktreePath,
			mergeStrategy: 'merge',
			queuedAt: Date.now(),
		});

		// Status dirty, add succeeds, commit succeeds, rev-parse succeeds,
		// but tag FAILS — this is the regression for the CRITICAL reviewer finding.
		_internals.bunSpawn = mock((args: string[]) => {
			if (args[3] === 'status') {
				return makeSpawnResult({ stdout: 'M  some-dirty-file.txt\n' });
			}
			if (args[3] === 'add') {
				return makeSpawnResult({});
			}
			if (args[3] === 'commit') {
				return makeSpawnResult({});
			}
			if (args[3] === 'rev-parse') {
				return makeSpawnResult({ stdout: 'abc123def4567890\n' });
			}
			if (args[3] === 'tag') {
				// Simulate tag failure (e.g. tag name collision, permission issue)
				return makeSpawnResult({
					exitCode: 128,
					stderr: 'fatal: cannot tag ref; tag already exists',
				});
			}
			return makeSpawnResult({});
		});

		const removeCalls: Array<{ worktreePath: string; projectRoot: string }> =
			[];
		const cleanupCalls: Array<{ directory: string; branchName: string }> = [];

		_internals.removeWorktree = mock(
			async (wtPath: string, projectRoot: string) => {
				removeCalls.push({ worktreePath: wtPath, projectRoot });
				return { success: true };
			},
		);

		_internals.postMergeCleanup = mock(
			async (directory: string, branch: string) => {
				cleanupCalls.push({ directory, branchName: branch });
				return { cleaned: true };
			},
		);

		await cleanupStandardWorktreeForCallId(callID, 'denied', tempDir);

		// removeWorktree should NOT be called — worktree must be preserved
		expect(removeCalls).toHaveLength(0);
		// postMergeCleanup should NOT be called — branch must be preserved
		expect(cleanupCalls).toHaveLength(0);

		// Worktree directory should still exist on disk
		expect(fs.existsSync(worktreePath)).toBe(true);

		// Advisory must mention preservation failure (tag failure)
		const session = ensureAgentSession('test-session');
		expect(
			session.pendingAdvisoryMessages!.some(
				(m) =>
					m.includes('STANDARD_WORKTREE_PRESERVATION_FAILED_ABORT_CLEANUP') &&
					m.includes('git tag failed'),
			),
		).toBe(true);
	});
});
