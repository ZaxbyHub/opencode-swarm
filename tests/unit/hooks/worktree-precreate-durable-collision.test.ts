import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	_internals,
	precreateStandardWorktreeSession,
	resetStandardWorktreeIsolationState,
} from '../../../src/hooks/delegation-gate/worktree-isolation';
import { resetSwarmState, swarmState } from '../../../src/state';
import { createSafeTestDir } from '../../helpers/safe-test-dir';

const originals = {
	tryAcquireWorktreeLifecycleLock: _internals.tryAcquireWorktreeLifecycleLock,
	preProvisionCollisionCheck: _internals.preProvisionCollisionCheck,
	inspectStandardWorktreeCollisionOwnership:
		_internals.inspectStandardWorktreeCollisionOwnership,
	preserveDirtyWorktreeAtPath: _internals.preserveDirtyWorktreeAtPath,
	removeWorktree: _internals.removeWorktree,
	postMergeCleanup: _internals.postMergeCleanup,
	pruneStaleWorktreeMetadata: _internals.pruneStaleWorktreeMetadata,
	recordWorktreeProvisioningOwner: _internals.recordWorktreeProvisioningOwner,
	removeWorktreeProvisioningOwner: _internals.removeWorktreeProvisioningOwner,
	provisionWorktree: _internals.provisionWorktree,
};

function git(directory: string, args: string[]): string {
	const result = spawnSync('git', ['-C', directory, ...args], {
		cwd: directory,
		stdin: 'ignore',
		stdout: 'pipe',
		stderr: 'pipe',
		encoding: 'utf8',
		timeout: 5_000,
		maxBuffer: 128 * 1024,
	});
	if (result.status !== 0) throw new Error(result.stderr || result.stdout);
	return result.stdout.trim();
}

describe('precreate durable collision protection', () => {
	let directory: string;
	let cleanup: () => void;
	const parentSessionID = 'parent-1';
	const taskId = 'task-1';
	const branchName = `swarm/lane/${parentSessionID}/${taskId}`;
	let worktreePath: string;

	beforeEach(() => {
		({ dir: directory, cleanup } = createSafeTestDir('swarm-precreate-owner-'));
		worktreePath = path.join(directory, '.swarm-worktrees', taskId);
		resetStandardWorktreeIsolationState();
		resetSwarmState();
		swarmState.opencodeClient = {
			session: {
				create: async () => ({ data: { id: 'child-session' } }),
			},
		} as never;
	});

	afterEach(() => {
		Object.assign(_internals, originals);
		resetStandardWorktreeIsolationState();
		resetSwarmState();
		cleanup();
	});

	function args() {
		return {
			config: { worktree: { policy: 'auto' } } as never,
			directory,
			parentSessionID,
			callID: 'call-1',
			taskId,
			outputArgs: {},
		};
	}

	function installCollision() {
		const release = mock(async () => {});
		_internals.tryAcquireWorktreeLifecycleLock = mock(async () => ({
			acquired: true,
			lock: { _release: release },
		})) as never;
		_internals.preProvisionCollisionCheck = mock(async () => ({
			collision: true,
			existingBranch: branchName,
			ownerSessionId: parentSessionID,
			worktreePath,
		}));
		return release;
	}

	test.each([
		['primary', 'active'],
		['fallback', 'active'],
		['primary', 'preserved'],
		['provisioning', 'active'],
		['ownership-tag', 'preserved'],
		['merge-status', 'preserved'],
	] as const)('hard-stops a %s/%s durable owner without destructive cleanup', async (ownerKind, lifecycle) => {
		const release = installCollision();
		const preserve = mock(async () => ({
			outcome: 'clean' as const,
			preserved: false,
		}));
		const remove = mock(async () => ({ success: true as const }));
		const cleanupBranch = mock(async () => ({ cleaned: true as const }));
		const provision = mock(async () => ({
			worktreePath,
			branchName,
			purpose: 'lane' as const,
			id: taskId,
			sessionId: parentSessionID,
		}));
		_internals.inspectStandardWorktreeCollisionOwnership = mock(async () => ({
			status: 'protected' as const,
			ownerKind,
			lifecycle,
			reason: 'durable owner exists',
		})) as never;
		_internals.preserveDirtyWorktreeAtPath = preserve as never;
		_internals.removeWorktree = remove as never;
		_internals.postMergeCleanup = cleanupBranch as never;
		_internals.provisionWorktree = provision as never;

		await expect(precreateStandardWorktreeSession(args())).rejects.toThrow(
			'STANDARD_WORKTREE_OWNER_PROTECTED',
		);
		expect(preserve).not.toHaveBeenCalled();
		expect(remove).not.toHaveBeenCalled();
		expect(cleanupBranch).not.toHaveBeenCalled();
		expect(provision).not.toHaveBeenCalled();
		expect(release).toHaveBeenCalledTimes(1);
	});

	test('hard-stops ownership uncertainty regardless of auto policy', async () => {
		const release = installCollision();
		const provision = mock(async () => {
			throw new Error('must not provision');
		});
		_internals.inspectStandardWorktreeCollisionOwnership = mock(async () => ({
			status: 'uncertain' as const,
			reason: 'primary owner store is unreadable',
		})) as never;
		_internals.provisionWorktree = provision as never;

		await expect(precreateStandardWorktreeSession(args())).rejects.toThrow(
			'STANDARD_WORKTREE_OWNERSHIP_UNCERTAIN',
		);
		expect(provision).not.toHaveBeenCalled();
		expect(release).toHaveBeenCalledTimes(1);
	});

	test('cleans only a proven-unowned lane, verifies absence, then publishes v2 owner', async () => {
		fs.mkdirSync(worktreePath, { recursive: true });
		const events: string[] = [];
		_internals.tryAcquireWorktreeLifecycleLock = mock(async () => {
			events.push('lock');
			return {
				acquired: true,
				lock: {
					_release: async () => {
						events.push('release');
					},
				},
			};
		}) as never;
		let collisionChecks = 0;
		_internals.preProvisionCollisionCheck = mock(async () => {
			collisionChecks++;
			events.push(`scan-${collisionChecks}`);
			return collisionChecks === 1
				? {
						collision: true,
						existingBranch: branchName,
						ownerSessionId: parentSessionID,
						worktreePath,
					}
				: { collision: false };
		});
		_internals.inspectStandardWorktreeCollisionOwnership = mock(async () => {
			events.push('classify');
			return { status: 'unowned' as const };
		}) as never;
		_internals.preserveDirtyWorktreeAtPath = mock(async () => {
			events.push('preserve');
			return { outcome: 'clean' as const, preserved: false };
		}) as never;
		_internals.removeWorktree = mock(async () => {
			events.push('remove');
			return { success: true as const };
		}) as never;
		_internals.postMergeCleanup = mock(async () => {
			events.push('cleanup-branch');
			return { cleaned: true as const };
		}) as never;
		const ownerInputs: unknown[] = [];
		_internals.recordWorktreeProvisioningOwner = mock((_directory, owner) => {
			events.push('record-owner');
			ownerInputs.push(owner);
			return { schemaVersion: 2, ...owner, createdAt: 1 };
		}) as never;
		_internals.provisionWorktree = mock(async () => {
			events.push('provision');
			return {
				worktreePath,
				branchName,
				purpose: 'lane' as const,
				id: taskId,
				sessionId: parentSessionID,
			};
		});

		const dispatchArgs = args();
		dispatchArgs.outputArgs.prompt =
			'TASK: task-1\nFILE: src/feature.ts\nACCEPTANCE: done';
		await precreateStandardWorktreeSession(dispatchArgs);

		expect(events).toEqual([
			'lock',
			'scan-1',
			'classify',
			'preserve',
			'remove',
			'cleanup-branch',
			'scan-2',
			'record-owner',
			'release',
			'provision',
		]);
		expect(ownerInputs).toEqual([
			{
				callID: 'call-1',
				parentSessionId: parentSessionID,
				worktreeSessionId: parentSessionID,
				taskId,
			},
		]);
		expect(dispatchArgs.outputArgs.prompt).toContain(
			`authoritative_lane_root: ${JSON.stringify(worktreePath)}`,
		);
		expect(dispatchArgs.outputArgs.prompt).toContain(
			'workspace-relative to authoritative_lane_root',
		);
		expect(dispatchArgs.outputArgs.prompt).toContain(
			'TASK: task-1\nFILE: src/feature.ts',
		);
	});

	test('prunes only stale metadata when an unowned collision path is missing', async () => {
		const events: string[] = [];
		_internals.tryAcquireWorktreeLifecycleLock = mock(async () => ({
			acquired: true,
			lock: { _release: async () => events.push('release') },
		})) as never;
		let scans = 0;
		_internals.preProvisionCollisionCheck = mock(async () => {
			scans++;
			events.push(`scan-${scans}`);
			return scans === 1
				? {
						collision: true,
						existingBranch: branchName,
						ownerSessionId: parentSessionID,
						worktreePath,
					}
				: { collision: false };
		});
		_internals.inspectStandardWorktreeCollisionOwnership = mock(async () => ({
			status: 'unowned' as const,
		})) as never;
		const preserve = mock(async () => ({
			outcome: 'clean' as const,
			preserved: false,
		}));
		const remove = mock(async () => ({ success: true as const }));
		const deleteBranch = mock(async () => ({ cleaned: true as const }));
		_internals.preserveDirtyWorktreeAtPath = preserve as never;
		_internals.removeWorktree = remove as never;
		_internals.postMergeCleanup = deleteBranch as never;
		_internals.pruneStaleWorktreeMetadata = mock(async () => {
			events.push('prune-metadata');
			return { pruned: true as const };
		}) as never;
		_internals.recordWorktreeProvisioningOwner = mock((_directory, owner) => {
			events.push('record-owner');
			return { schemaVersion: 2, ...owner, createdAt: 1 };
		}) as never;
		_internals.provisionWorktree = mock(async () => {
			events.push('provision');
			return {
				worktreePath,
				branchName,
				purpose: 'lane' as const,
				id: taskId,
				sessionId: parentSessionID,
			};
		});

		await precreateStandardWorktreeSession(args());

		expect(preserve).not.toHaveBeenCalled();
		expect(remove).not.toHaveBeenCalled();
		expect(deleteBranch).not.toHaveBeenCalled();
		expect(events).toEqual([
			'scan-1',
			'prune-metadata',
			'scan-2',
			'record-owner',
			'release',
			'provision',
		]);
	});

	test('fails closed without destructive cleanup when metadata pruning fails', async () => {
		const release = installCollision();
		_internals.inspectStandardWorktreeCollisionOwnership = mock(async () => ({
			status: 'unowned' as const,
		})) as never;
		const preserve = mock(async () => ({
			outcome: 'clean' as const,
			preserved: false,
		}));
		const remove = mock(async () => ({ success: true as const }));
		const deleteBranch = mock(async () => ({ cleaned: true as const }));
		const provision = mock(async () => ({
			worktreePath,
			branchName,
			purpose: 'lane' as const,
			id: taskId,
			sessionId: parentSessionID,
		}));
		_internals.preserveDirtyWorktreeAtPath = preserve as never;
		_internals.removeWorktree = remove as never;
		_internals.postMergeCleanup = deleteBranch as never;
		_internals.pruneStaleWorktreeMetadata = mock(async () => ({
			error: 'git metadata unavailable',
		})) as never;
		_internals.provisionWorktree = provision as never;

		await expect(precreateStandardWorktreeSession(args())).rejects.toThrow(
			'STANDARD_WORKTREE_COLLISION_PRUNE_FAILED',
		);
		expect(preserve).not.toHaveBeenCalled();
		expect(remove).not.toHaveBeenCalled();
		expect(deleteBranch).not.toHaveBeenCalled();
		expect(provision).not.toHaveBeenCalled();
		expect(release).toHaveBeenCalledTimes(1);
	});

	test('preserves an unmerged branch after an expired owner and missing worktree path', async () => {
		const sessionId = 'ses_parent1';
		git(directory, ['init']);
		git(directory, ['config', 'user.email', 'tests@example.com']);
		git(directory, ['config', 'user.name', 'Tests']);
		fs.writeFileSync(path.join(directory, 'base.txt'), 'base\n');
		git(directory, ['add', 'base.txt']);
		git(directory, ['commit', '-m', 'seed']);

		const initial = await originals.provisionWorktree(
			directory,
			taskId,
			sessionId,
			{
				purpose: 'lane',
				mergeStrategy: 'merge',
				depsStrategy: 'skip',
			},
		);
		if ('error' in initial) throw new Error(initial.error);
		fs.writeFileSync(path.join(initial.worktreePath, 'lane.txt'), 'valuable\n');
		git(initial.worktreePath, ['add', 'lane.txt']);
		git(initial.worktreePath, ['commit', '-m', 'valuable lane commit']);

		_internals.recordWorktreeProvisioningOwner(directory, {
			callID: 'stale-owner',
			parentSessionId: sessionId,
			worktreeSessionId: sessionId,
			taskId,
		});
		const ownerDigest = createHash('sha256')
			.update('stale-owner')
			.digest('hex');
		const ownerPath = path.join(
			directory,
			'.swarm',
			'worktree-provisioning-owners',
			`${ownerDigest}.json`,
		);
		const owner = JSON.parse(fs.readFileSync(ownerPath, 'utf8')) as Record<
			string,
			unknown
		>;
		owner.createdAt = 1;
		fs.writeFileSync(ownerPath, `${JSON.stringify(owner)}\n`);
		fs.rmSync(initial.worktreePath, { recursive: true, force: true });

		swarmState.opencodeClient = {
			session: { create: async () => ({ data: { id: 'must-not-create' } }) },
		} as never;
		await expect(
			precreateStandardWorktreeSession({
				config: { worktree: { policy: 'required' } } as never,
				directory,
				parentSessionID: sessionId,
				callID: 'replacement-call',
				taskId,
				outputArgs: { prompt: 'TASK: task-1' },
			}),
		).rejects.toThrow('has unmerged commits');

		expect(git(directory, ['show', `${initial.branchName}:lane.txt`])).toBe(
			'valuable',
		);
		expect(
			git(directory, [
				'show-ref',
				'--verify',
				`refs/heads/${initial.branchName}`,
			]),
		).not.toBe('');
	});
});
