/**
 * Issue #2236 (BL-1b): git-executable resolution failures must be CONTAINED
 * inside `worktree-isolation.ts`'s typed result contracts.
 *
 * `_internals.resolveGitExecutable()` can throw (`GitBinaryMissingError`, from
 * the cached `mode: 'missing'` state). Every one of these functions declares a
 * NON-throwing typed contract, so a resolution throw must become that typed
 * failure rather than escaping the function:
 *
 * - `preProvisionCollisionCheck`  -> `{ collision: false, uncertainty: <msg> }`
 *   This one is a destructive-cleanup gate: `precreateStandardWorktreeSession`
 *   hard-stops on `uncertainty`, so the mapping MUST carry `uncertainty` and
 *   must never look like the plain `{ collision: false }` "no lane exists"
 *   answer. These tests assert the `uncertainty` string explicitly — asserting
 *   only `collision === false` would pass against the fail-OPEN bug.
 * - the three `preserve*` functions -> `outcome: 'preserve-failed'`
 *   Preserving a worktree is the protective action.
 *
 * Coverage is per SPAWN SITE, not per function: each of these functions runs a
 * multi-step git sequence, and a warm resolver cache does not protect the later
 * steps (negative cache entries expire on a TTL).
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	_internals,
	precreateStandardWorktreeSession,
	preProvisionCollisionCheck,
	preserveBackgroundWorktreeOwnershipForCallId,
	preserveDirtyWorktreeAtPath,
	preserveDirtyWorktreeForCallId,
	resetStandardWorktreeIsolationState,
	type StandardWorktreeDispatch,
	standardWorktreeByCallID,
} from '../../../src/hooks/delegation-gate/worktree-isolation';
import {
	ensureAgentSession,
	resetSwarmState,
	swarmState,
} from '../../../src/state';
import { GitBinaryMissingError } from '../../../src/utils/git-binary-missing-error';
import type { WorktreeHandle } from '../../../src/worktree';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

// ─── helpers ─────────────────────────────────────────────────────────────────

const RESOLVER_MESSAGE = 'git binary is not available (test injection)';

/**
 * Fake subprocess handle matching what `_internals.bunSpawn` returns. Every
 * git step in these functions is driven to SUCCESS so the only failure the
 * assertions can be reacting to is the injected resolution throw.
 */
function makeSpawnResult(stdout: string) {
	return {
		exited: Promise.resolve(0),
		stdout: {
			text: () => Promise.resolve(stdout),
			getReader: () => ({ releaseLock: () => {} }),
		},
		stderr: {
			text: () => Promise.resolve(''),
			getReader: () => ({ releaseLock: () => {} }),
		},
		exitCode: 0,
		kill: () => {},
	};
}

/** Succeeds every git step: dirty status, real-looking hash, empty otherwise. */
function successSpawn(cmd: string[]) {
	if (cmd.includes('status')) return makeSpawnResult(' M src/changed.ts\n');
	if (cmd.includes('rev-parse'))
		return makeSpawnResult('0123456789abcdef0123456789abcdef01234567\n');
	return makeSpawnResult('');
}

/**
 * Installs a resolver that succeeds for the first `failAt - 1` calls and throws
 * on call number `failAt` (1-based). `failAt = 1` covers the first spawn site
 * in a function; higher values cover the later sites, which a
 * first-site-only fix would leave leaking.
 */
function injectResolverFailure(failAt: number): void {
	let calls = 0;
	_internals.resolveGitExecutable = () => {
		calls += 1;
		if (calls === failAt) throw new GitBinaryMissingError(RESOLVER_MESSAGE);
		return 'git';
	};
}

function makeDispatch(
	callID: string,
	worktreePath: string,
): StandardWorktreeDispatch {
	return {
		callID,
		parentSessionID: 'ses_containment',
		taskId: '1.1',
		planTaskId: '1.1',
		handle: {
			worktreePath,
			branchName: 'swarm/lane/ses_containment/1.1',
			purpose: 'lane',
			id: 'lane-1.1',
			sessionId: 'ses_containment',
		} as WorktreeHandle,
		mergeStrategy: 'merge',
		laneIndex: 0,
		worktree_dir: undefined,
	};
}

// ─── suite ───────────────────────────────────────────────────────────────────

describe('#2236 BL-1b: resolveGitExecutable throws are contained by worktree-isolation typed contracts', () => {
	let tempDir: string;
	let originalResolve: typeof _internals.resolveGitExecutable;
	let originalSpawn: typeof _internals.bunSpawn;
	let spawnCalls: string[][];

	beforeEach(() => {
		resetStandardWorktreeIsolationState();
		resetSwarmState();
		tempDir = canonicalMkdtemp('bl1b-git-resolution-');
		fs.mkdirSync(path.join(tempDir, '.swarm'), { recursive: true });
		originalResolve = _internals.resolveGitExecutable;
		originalSpawn = _internals.bunSpawn;
		spawnCalls = [];
		_internals.bunSpawn = ((cmd: string[]) => {
			spawnCalls.push(cmd);
			return successSpawn(cmd);
		}) as unknown as typeof _internals.bunSpawn;
	});

	afterEach(() => {
		// Restore before any other file in this shared bun:test process runs.
		_internals.resolveGitExecutable = originalResolve;
		_internals.bunSpawn = originalSpawn;
		resetStandardWorktreeIsolationState();
		resetSwarmState();
		try {
			fs.rmSync(tempDir, { recursive: true, force: true });
		} catch {
			// best-effort
		}
	});

	// ---- preProvisionCollisionCheck: must fail CLOSED ------------------------

	describe('preProvisionCollisionCheck (destructive-cleanup gate)', () => {
		it('returns the uncertainty contract — not a bare no-collision answer — when resolution throws', async () => {
			injectResolverFailure(1);

			const result = await preProvisionCollisionCheck('1.1', tempDir, 'ses_x');

			// Fail CLOSED. `collision: false` alone is the fail-OPEN shape; the
			// `uncertainty` string is what every caller hard-stops on.
			expect(result.collision).toBe(false);
			expect(typeof result.uncertainty).toBe('string');
			expect(result.uncertainty).toContain(RESOLVER_MESSAGE);
			expect(result.uncertainty).toContain(tempDir);
			// The throw happened during argv construction, so git never started.
			expect(spawnCalls.length).toBe(0);
		});

		it('does not reach the "not a git repository" branch, which carries no uncertainty', async () => {
			injectResolverFailure(1);

			const result = await preProvisionCollisionCheck('1.1', tempDir, 'ses_x');

			// That branch returns `{ collision: false }` with `uncertainty`
			// undefined; a resolution failure must never be able to produce it.
			expect(result.uncertainty).toBeDefined();
		});

		it('still reports a real collision when resolution succeeds (guard did not change the happy path)', async () => {
			_internals.bunSpawn = ((cmd: string[]) => {
				spawnCalls.push(cmd);
				return makeSpawnResult(
					`worktree ${tempDir}\nbranch refs/heads/swarm/lane/ses_owner/1.1\n\n`,
				);
			}) as unknown as typeof _internals.bunSpawn;
			_internals.resolveGitExecutable = () => 'git';

			const result = await preProvisionCollisionCheck('1.1', tempDir, 'ses_x');

			expect(result.collision).toBe(true);
			expect(result.uncertainty).toBeUndefined();
			expect(result.ownerSessionId).toBe('ses_owner');
			expect(spawnCalls[0]?.[0]).toBe('git');
		});

		it('hard-stops precreateStandardWorktreeSession under the COLLISION_SCAN_UNCERTAIN label, not OWNER_PERSIST_FAILED', async () => {
			swarmState.opencodeClient = {
				session: { create: async () => ({ data: { id: 'sess-lane' } }) },
			} as never;
			injectResolverFailure(1);

			let thrown: unknown;
			try {
				await precreateStandardWorktreeSession({
					config: { worktree: { policy: 'auto' } } as never,
					directory: tempDir,
					parentSessionID: 'ses_containment',
					callID: 'call-bl1b',
					taskId: '1.1',
					outputArgs: {},
				});
			} catch (error) {
				thrown = error;
			}

			const message = thrown instanceof Error ? thrown.message : String(thrown);
			// The pre-fix behaviour: the raw resolver throw fell through to the
			// generic catch and was relabelled STANDARD_WORKTREE_OWNER_PERSIST_FAILED,
			// blaming owner persistence on a host where git works.
			expect(message).toContain('STANDARD_WORKTREE_COLLISION_SCAN_UNCERTAIN');
			expect(message).not.toContain('STANDARD_WORKTREE_OWNER_PERSIST_FAILED');
			expect(message).toContain(RESOLVER_MESSAGE);
		});
	});

	// ---- preserveBackgroundWorktreeOwnershipForCallId ------------------------

	describe('preserveBackgroundWorktreeOwnershipForCallId', () => {
		beforeEach(() => {
			standardWorktreeByCallID.set(
				'call-owner',
				makeDispatch('call-owner', path.join(tempDir, 'lane')),
			);
		});

		it.each([
			[1, 'rev-parse'],
			[2, 'tag'],
		])('returns preserve-failed when resolution throws at spawn site %i (%s)', async (failAt, label) => {
			injectResolverFailure(failAt as number);

			const result =
				await preserveBackgroundWorktreeOwnershipForCallId('call-owner');

			expect(result.outcome).toBe('preserve-failed');
			expect(result.error).toContain(label as string);
			expect(result.error).toContain(RESOLVER_MESSAGE);
			expect(result.tag).toBeUndefined();
		});

		it('still preserves when resolution succeeds throughout', async () => {
			_internals.resolveGitExecutable = () => 'git';

			const result =
				await preserveBackgroundWorktreeOwnershipForCallId('call-owner');

			expect(result.outcome).toBe('preserved');
			expect(result.ref).toBe('0123456789abcdef0123456789abcdef01234567');
		});
	});

	// ---- preserveDirtyWorktreeForCallId --------------------------------------

	describe('preserveDirtyWorktreeForCallId', () => {
		beforeEach(() => {
			ensureAgentSession('ses_containment');
			standardWorktreeByCallID.set(
				'call-dirty',
				makeDispatch('call-dirty', path.join(tempDir, 'lane')),
			);
		});

		it.each([
			[1, 'status'],
			[2, 'add'],
			[3, 'commit'],
			[4, 'rev-parse'],
			[5, 'tag'],
		])('returns preserve-failed when resolution throws at spawn site %i (%s)', async (failAt, label) => {
			injectResolverFailure(failAt as number);

			const result = await preserveDirtyWorktreeForCallId(
				'call-dirty',
				'denied',
				tempDir,
			);

			// Never `clean` (which would let cleanup delete unpreserved work)
			// and never `preserved` (which would claim work was saved).
			expect(result.outcome).toBe('preserve-failed');
			expect(result.preserved).toBe(false);
			expect(result.error).toContain(label as string);
			expect(result.error).toContain(RESOLVER_MESSAGE);
			expect(result.ref).toBeUndefined();
		});

		it('still preserves when resolution succeeds throughout', async () => {
			_internals.resolveGitExecutable = () => 'git';

			const result = await preserveDirtyWorktreeForCallId(
				'call-dirty',
				'denied',
				tempDir,
			);

			expect(result.outcome).toBe('preserved');
			expect(result.preserved).toBe(true);
		});
	});

	// ---- preserveDirtyWorktreeAtPath -----------------------------------------

	describe('preserveDirtyWorktreeAtPath', () => {
		it.each([
			[1, 'status'],
			[2, 'add'],
			[3, 'commit'],
			[4, 'rev-parse'],
			[5, 'tag'],
		])('returns preserve-failed when resolution throws at spawn site %i (%s)', async (failAt, label) => {
			injectResolverFailure(failAt as number);

			const result = await preserveDirtyWorktreeAtPath(
				path.join(tempDir, 'lane'),
				'swarm/lane/ses_owner/1.1',
				'denied',
				tempDir,
			);

			expect(result.outcome).toBe('preserve-failed');
			expect(result.preserved).toBe(false);
			expect(result.error).toContain(label as string);
			expect(result.error).toContain(RESOLVER_MESSAGE);
			expect(result.ref).toBeUndefined();
		});

		it('still preserves when resolution succeeds throughout', async () => {
			_internals.resolveGitExecutable = () => 'git';

			const result = await preserveDirtyWorktreeAtPath(
				path.join(tempDir, 'lane'),
				'swarm/lane/ses_owner/1.1',
				'denied',
				tempDir,
			);

			expect(result.outcome).toBe('preserved');
			expect(result.preserved).toBe(true);
		});
	});
});
