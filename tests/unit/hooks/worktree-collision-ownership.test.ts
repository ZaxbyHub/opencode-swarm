import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	buildBackgroundCompletionEventId,
	claimCoderSettlement,
	claimTerminalResult,
	type RecordPendingInput,
	recordPendingDelegation,
	updateCoderSettlement,
	writeDelegationFallback,
} from '../../../src/background/pending-delegations';
import {
	inspectStandardWorktreeCollisionOwnership,
	_internals as ownershipInternals,
} from '../../../src/hooks/delegation-gate/worktree-collision-ownership';
import {
	initDurableStatusPath,
	_internals as mergeStatusInternals,
	recordWorktreeMergeFailure,
} from '../../../src/hooks/delegation-gate/worktree-merge-status';
import {
	recordWorktreeProvisioningOwner,
	WORKTREE_PROVISIONING_OWNER_LEASE_MS,
} from '../../../src/hooks/delegation-gate/worktree-provisioning-owner';
import { createSafeTestDir } from '../../helpers/safe-test-dir';
import { withFrozenClockAsync } from '../../helpers/test-clock';

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

describe('durable standard-worktree collision ownership', () => {
	let directory: string;
	let cleanup: () => void;
	const parentSessionId = 'parent-1';
	const taskId = '1.1';
	const realStatSync = ownershipInternals.statSync;
	const realRemoveOwner = ownershipInternals.removeWorktreeProvisioningOwner;

	beforeEach(() => {
		({ dir: directory, cleanup } = createSafeTestDir('swarm-collision-owner-'));
		fs.mkdirSync(path.join(directory, '.swarm'), { recursive: true });
	});

	afterEach(() => {
		ownershipInternals.statSync = realStatSync;
		ownershipInternals.removeWorktreeProvisioningOwner = realRemoveOwner;
		mergeStatusInternals.resetForTest();
		cleanup();
	});

	function identity() {
		return {
			directory,
			parentSessionId,
			taskId,
			branchName: `swarm/lane/${parentSessionId}/${taskId}`,
			worktreePath: path.join(directory, '.swarm-worktrees', taskId),
		};
	}

	function rewriteOwnerCreatedAt(callID: string, createdAt: number): string {
		const digest = createHash('sha256').update(callID).digest('hex');
		const absolutePath = path.join(
			directory,
			'.swarm',
			'worktree-provisioning-owners',
			`${digest}.json`,
		);
		const owner = JSON.parse(fs.readFileSync(absolutePath, 'utf8')) as Record<
			string,
			unknown
		>;
		owner.createdAt = createdAt;
		fs.writeFileSync(absolutePath, `${JSON.stringify(owner)}\n`);
		return absolutePath;
	}

	function pendingInput(correlationId: string): RecordPendingInput {
		const lane = identity();
		return {
			correlationId,
			jobId: `${correlationId}-job`,
			subagentSessionId: correlationId,
			parentSessionId,
			callID: `${correlationId}-call`,
			normalizedAgent: 'coder',
			swarmPrefixedAgent: 'coder',
			planTaskId: taskId,
			evidenceTaskId: taskId,
			taskChangeContext: {
				declaredFiles: ['src/feature.ts'],
				baseline: {
					directory: lane.worktreePath,
					gitHead: 'base',
					dirtyHash: 'clean',
					changedFiles: [],
					prHeadSha: null,
					scope: taskId,
				},
			},
			worktree: {
				callID: `${correlationId}-call`,
				parentSessionId,
				taskId,
				planTaskId: taskId,
				worktreePath: lane.worktreePath,
				branchName: lane.branchName,
				worktreeId: taskId,
				worktreeSessionId: parentSessionId,
				mergeStrategy: 'merge',
				laneIndex: 0,
				worktreeDir: null,
			},
		};
	}

	test.each([
		'primary',
		'fallback',
	] as const)('protects an active %s owner', async (ownerKind) => {
		const stored =
			ownerKind === 'primary'
				? await recordPendingDelegation(directory, pendingInput(ownerKind))
				: await writeDelegationFallback(directory, pendingInput(ownerKind));
		expect(stored).not.toBeNull();
		expect(
			await inspectStandardWorktreeCollisionOwnership(identity()),
		).toMatchObject({
			status: 'protected',
			ownerKind,
			lifecycle: 'active',
		});
	});

	test('protects a primary owner recorded through a physical worktree alias', async () => {
		const lane = identity();
		fs.mkdirSync(lane.worktreePath, { recursive: true });
		const alias = `${lane.worktreePath}-alias`;
		fs.symlinkSync(
			lane.worktreePath,
			alias,
			process.platform === 'win32' ? 'junction' : 'dir',
		);
		const input = pendingInput('physical-alias');
		input.worktree!.worktreePath = alias;
		input.taskChangeContext.baseline.directory = alias;
		expect(await recordPendingDelegation(directory, input)).not.toBeNull();
		expect(await inspectStandardWorktreeCollisionOwnership(lane)).toMatchObject(
			{
				status: 'protected',
				ownerKind: 'primary',
			},
		);
	});

	test('protects merge status recorded through a physical worktree alias', async () => {
		const lane = identity();
		fs.mkdirSync(lane.worktreePath, { recursive: true });
		const alias = `${lane.worktreePath}-alias`;
		fs.symlinkSync(
			lane.worktreePath,
			alias,
			process.platform === 'win32' ? 'junction' : 'dir',
		);
		initDurableStatusPath(directory);
		recordWorktreeMergeFailure(taskId, {
			outcome: 'failed',
			stage: 'merge',
			message: 'preserved',
			worktreePath: alias,
			branch: lane.branchName,
		});
		expect(await inspectStandardWorktreeCollisionOwnership(lane)).toMatchObject(
			{
				status: 'protected',
				ownerKind: 'merge-status',
			},
		);
	});

	async function startSettlement(correlationId: string, operationId: string) {
		await recordPendingDelegation(directory, pendingInput(correlationId));
		const eventId = buildBackgroundCompletionEventId({
			correlationId,
			jobId: `${correlationId}-job`,
			status: 'completed',
			resultDigest: 'digest',
		});
		await claimTerminalResult(directory, correlationId, {
			eventId,
			status: 'completed',
			recordedAt: 100,
			result: { chars: 0, truncated: false, digest: 'digest' },
		});
		return claimCoderSettlement(directory, correlationId, operationId);
	}

	test('protects a preserved primary owner', async () => {
		expect(await startSettlement('preserved', 'operation-1')).not.toBeNull();
		expect(
			await updateCoderSettlement(directory, 'preserved', {
				operationId: 'operation-1',
				state: 'preserved',
				outcome: { kind: 'standard-worktree', result: 'failed' },
			}),
		).not.toBeNull();
		expect(
			await inspectStandardWorktreeCollisionOwnership(identity()),
		).toMatchObject({
			status: 'protected',
			ownerKind: 'primary',
			lifecycle: 'preserved',
		});
	});

	test('ignores a proven settled primary owner', async () => {
		expect(await startSettlement('settled', 'operation-2')).not.toBeNull();
		expect(
			await updateCoderSettlement(directory, 'settled', {
				operationId: 'operation-2',
				state: 'settled',
				observedFiles: [],
				outcome: { kind: 'standard-worktree', result: 'merged' },
			}),
		).not.toBeNull();
		expect(await inspectStandardWorktreeCollisionOwnership(identity())).toEqual(
			{
				status: 'unowned',
			},
		);
	});

	test.each([
		{ taskId: undefined, schemaVersion: 1 },
		{ taskId: '1.1', schemaVersion: 2 },
	] as const)('protects provisioning marker v$schemaVersion', async (marker) => {
		recordWorktreeProvisioningOwner(directory, {
			callID: `call-v${marker.schemaVersion}`,
			parentSessionId,
			worktreeSessionId: parentSessionId,
			...(marker.taskId ? { taskId: marker.taskId } : {}),
		});
		expect(
			await inspectStandardWorktreeCollisionOwnership(identity()),
		).toMatchObject({
			status: 'protected',
			ownerKind: 'provisioning',
			lifecycle: 'active',
		});
	});

	test('releases an expired same-task marker only when the exact lane path is missing', async () => {
		await withFrozenClockAsync(
			async () => {
				const callID = 'expired-missing';
				recordWorktreeProvisioningOwner(directory, {
					callID,
					parentSessionId,
					worktreeSessionId: parentSessionId,
					taskId,
				});
				const absolutePath = rewriteOwnerCreatedAt(
					callID,
					Date.now() - WORKTREE_PROVISIONING_OWNER_LEASE_MS - 1,
				);

				expect(
					await inspectStandardWorktreeCollisionOwnership(identity()),
				).toEqual({
					status: 'unowned',
				});
				expect(fs.existsSync(absolutePath)).toBe(false);
			},
			{ fixedNow: 1_000_000 },
		);
	});

	test('keeps an expired marker protected while the exact lane path exists', async () => {
		await withFrozenClockAsync(
			async () => {
				const callID = 'expired-live-path';
				recordWorktreeProvisioningOwner(directory, {
					callID,
					parentSessionId,
					worktreeSessionId: parentSessionId,
					taskId,
				});
				rewriteOwnerCreatedAt(
					callID,
					Date.now() - WORKTREE_PROVISIONING_OWNER_LEASE_MS - 1,
				);
				fs.mkdirSync(identity().worktreePath, { recursive: true });

				expect(
					await inspectStandardWorktreeCollisionOwnership(identity()),
				).toMatchObject({
					status: 'protected',
					ownerKind: 'provisioning',
					lifecycle: 'active',
				});
			},
			{ fixedNow: 1_000_000 },
		);
	});

	test('treats a future-dated marker as a live lease', async () => {
		await withFrozenClockAsync(
			async () => {
				const callID = 'future-marker';
				recordWorktreeProvisioningOwner(directory, {
					callID,
					parentSessionId,
					worktreeSessionId: parentSessionId,
					taskId,
				});
				rewriteOwnerCreatedAt(callID, Date.now() + 60_000);

				expect(
					await inspectStandardWorktreeCollisionOwnership(identity()),
				).toMatchObject({ status: 'protected', ownerKind: 'provisioning' });
			},
			{ fixedNow: 1_000_000 },
		);
	});

	test.each([
		{
			name: 'same session but different v2 task',
			parentSessionId,
			worktreeSessionId: parentSessionId,
			taskId: '2.1',
		},
		{
			name: 'different session with the same task',
			parentSessionId: 'other-parent',
			worktreeSessionId: 'other-parent',
			taskId,
		},
	])('does not claim a $name marker', async (marker) => {
		recordWorktreeProvisioningOwner(directory, {
			callID: marker.name,
			parentSessionId: marker.parentSessionId,
			worktreeSessionId: marker.worktreeSessionId,
			taskId: marker.taskId,
		});
		expect(await inspectStandardWorktreeCollisionOwnership(identity())).toEqual(
			{
				status: 'unowned',
			},
		);
	});

	test('fails closed when expired-marker path liveness cannot be read', async () => {
		const callID = 'stat-denied';
		recordWorktreeProvisioningOwner(directory, {
			callID,
			parentSessionId,
			worktreeSessionId: parentSessionId,
			taskId,
		});
		rewriteOwnerCreatedAt(callID, 1);
		ownershipInternals.statSync = mock(() => {
			throw Object.assign(new Error('denied'), { code: 'EACCES' });
		}) as never;

		expect(
			await inspectStandardWorktreeCollisionOwnership(identity()),
		).toMatchObject({
			status: 'uncertain',
			reason: expect.stringContaining('liveness is unreadable'),
		});
	});

	test('fails closed when an expired missing-path marker cannot be removed', async () => {
		const callID = 'remove-denied';
		recordWorktreeProvisioningOwner(directory, {
			callID,
			parentSessionId,
			worktreeSessionId: parentSessionId,
			taskId,
		});
		rewriteOwnerCreatedAt(callID, 1);
		ownershipInternals.statSync = mock(() => {
			throw Object.assign(new Error('missing'), { code: 'ENOENT' });
		}) as never;
		ownershipInternals.removeWorktreeProvisioningOwner = mock(() => false);

		expect(
			await inspectStandardWorktreeCollisionOwnership(identity()),
		).toMatchObject({
			status: 'uncertain',
			reason: expect.stringContaining('could not be removed'),
		});
	});

	test('protects ownership tags and merge-status records', async () => {
		git(directory, ['init']);
		git(directory, ['config', 'user.email', 'tests@example.com']);
		git(directory, ['config', 'user.name', 'Tests']);
		fs.writeFileSync(path.join(directory, 'base.txt'), 'base\n');
		git(directory, ['add', 'base.txt']);
		git(directory, ['commit', '-m', 'seed']);
		const session = Buffer.from(parentSessionId).toString('base64url');
		const lane = Buffer.from(taskId).toString('base64url');
		const digest = createHash('sha256')
			.update('call-tag')
			.digest('hex')
			.slice(0, 12);
		git(directory, [
			'tag',
			`swarm-preserved-owner/${session}/${lane}/${digest}`,
		]);
		expect(
			await inspectStandardWorktreeCollisionOwnership(identity()),
		).toMatchObject({
			status: 'protected',
			ownerKind: 'ownership-tag',
		});

		git(directory, [
			'tag',
			'-d',
			`swarm-preserved-owner/${session}/${lane}/${digest}`,
		]);
		initDurableStatusPath(directory);
		const laneIdentity = identity();
		recordWorktreeMergeFailure('plan-task', {
			outcome: 'failed',
			stage: 'merge',
			message: 'preserved for recovery',
			worktreePath: laneIdentity.worktreePath,
			branch: laneIdentity.branchName,
		});
		// Clear in-memory map but keep the durable file on disk so the
		// collision ownership scan reads it (resetForTest also deletes the
		// file since the PRR-016 fix).
		mergeStatusInternals.failuresByTask.clear();
		expect(
			await inspectStandardWorktreeCollisionOwnership(identity()),
		).toMatchObject({
			status: 'protected',
			ownerKind: 'merge-status',
			lifecycle: 'preserved',
		});
	});

	test('returns uncertainty when a strict owner store is malformed', async () => {
		const ownerDir = path.join(
			directory,
			'.swarm',
			'worktree-provisioning-owners',
		);
		fs.mkdirSync(ownerDir, { recursive: true });
		fs.writeFileSync(path.join(ownerDir, 'bad.json'), '{"schemaVersion":2}\n');

		expect(
			await inspectStandardWorktreeCollisionOwnership(identity()),
		).toMatchObject({
			status: 'uncertain',
		});
	});
});
