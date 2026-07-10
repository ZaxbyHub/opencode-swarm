/**
 * FR-001c: Dirty-state preservation on denial/cancellation cleanup
 *
 * Unit tests for preserveDirtyWorktreeForCallId with mocked bunSpawn.
 * The integration test is in delegation-gate-worktree-isolation-dirty-preserve.integration.test.ts.
 * The fail-closed regression tests are in delegation-gate-worktree-isolation-dirty-preserve.failclosed.test.ts.
 *
 * @note Uses Tier 1 DI (mock _internals.bunSpawn) for unit tests.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	_internals,
	awaitingMergeByCallID,
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

// ─── preserveDirtyWorktreeForCallId unit tests ──────────────────────────────
// Git command shape: ['git', '-C', worktreePath, <subcommand>, ...]
// args[0]='git', args[1]='-C', args[2]=worktreePath, args[3]=<subcommand>

describe('FR-001c: preserveDirtyWorktreeForCallId — unit (mocked bunSpawn)', () => {
	let tempDir: string;

	beforeEach(() => {
		resetStandardWorktreeIsolationState();
		resetSwarmState();
		tempDir = makeTempProject('fr001c-preserve-');
		ensureAgentSession('test-session');
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

	it('returns { preserved: false } when dispatch not found in either map', async () => {
		const result = await preserveDirtyWorktreeForCallId(
			'nonexistent-call',
			'denied',
			tempDir,
		);
		expect(result.preserved).toBe(false);
		expect(result.ref).toBeUndefined();
	});

	it('returns { preserved: false } when worktree is clean (empty git status)', async () => {
		const callID = 'call-clean';
		const worktreePath = path.join(tempDir, 'wt-clean');
		fs.mkdirSync(worktreePath, { recursive: true });

		const dispatch = makeMockDispatch(
			callID,
			worktreePath,
			'swarm-lane/test-session/lane-clean',
		);
		standardWorktreeByCallID.set(callID, dispatch);

		const originalBunSpawn = _internals.bunSpawn;
		_internals.bunSpawn = mock(() => makeSpawnResult({ stdout: '' }));

		const result = await preserveDirtyWorktreeForCallId(
			callID,
			'denied',
			tempDir,
		);

		// Should be clean — nothing to preserve
		expect(result.preserved).toBe(false);

		_internals.bunSpawn = originalBunSpawn;
	});

	it('returns { preserved: true, ref } when worktree is dirty', async () => {
		const callID = 'call-dirty-preserve';
		const worktreePath = path.join(tempDir, 'wt-dirty');
		fs.mkdirSync(worktreePath, { recursive: true });

		const dispatch = makeMockDispatch(
			callID,
			worktreePath,
			'swarm-lane/test-session/lane-dirty',
		);
		standardWorktreeByCallID.set(callID, dispatch);

		const originalBunSpawn = _internals.bunSpawn;
		// args[3] is the git subcommand (after 'git', '-C', worktreePath)
		_internals.bunSpawn = mock((args: string[]) => {
			if (args[3] === 'status') {
				return makeSpawnResult({ stdout: 'M  src/changed.ts\n' });
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
				return makeSpawnResult({});
			}
			return makeSpawnResult({ exitCode: 1, stderr: 'unexpected command' });
		});

		const result = await preserveDirtyWorktreeForCallId(
			callID,
			'denied',
			tempDir,
		);

		expect(result.preserved).toBe(true);
		expect(result.ref).toBe('abc123def4567890');

		// Advisory should be pushed
		const session = ensureAgentSession('test-session');
		expect(
			session.pendingAdvisoryMessages!.some(
				(m) => m.includes('STANDARD_WORKTREE_PRESERVED') && m.includes(callID),
			),
		).toBe(true);

		_internals.bunSpawn = originalBunSpawn;
	});

	it('preserves from awaitingMergeByCallID map when not in standard map', async () => {
		const callID = 'call-awaiting-preserve';
		const worktreePath = path.join(tempDir, 'wt-awaiting-pres');
		fs.mkdirSync(worktreePath, { recursive: true });

		// Put only in awaitingMergeByCallID (not in standardWorktreeByCallID)
		awaitingMergeByCallID.set(callID, {
			callID,
			parentSessionID: 'test-session',
			taskId: '1.1',
			planTaskId: '1.1',
			branch: 'swarm-lane/test-session/lane-awaiting',
			worktreePath,
			mergeStrategy: 'merge',
			queuedAt: Date.now(),
		});

		const originalBunSpawn = _internals.bunSpawn;
		_internals.bunSpawn = mock((args: string[]) => {
			if (args[3] === 'status') {
				return makeSpawnResult({ stdout: '?? untracked.txt\n' });
			}
			if (args[3] === 'add') {
				return makeSpawnResult({});
			}
			if (args[3] === 'commit') {
				return makeSpawnResult({});
			}
			if (args[3] === 'rev-parse') {
				return makeSpawnResult({ stdout: 'def789abc1234560\n' });
			}
			if (args[3] === 'tag') {
				return makeSpawnResult({});
			}
			return makeSpawnResult({ exitCode: 1, stderr: 'unexpected' });
		});

		const result = await preserveDirtyWorktreeForCallId(
			callID,
			'cancelled',
			tempDir,
		);

		expect(result.preserved).toBe(true);
		expect(result.ref).toBe('def789abc1234560');

		_internals.bunSpawn = originalBunSpawn;
	});
});
