import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
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
import { inspectStandardWorktreeCollisionOwnership } from '../../../src/hooks/delegation-gate/worktree-collision-ownership';
import {
	initDurableStatusPath,
	_internals as mergeStatusInternals,
	recordWorktreeMergeFailure,
} from '../../../src/hooks/delegation-gate/worktree-merge-status';
import { recordWorktreeProvisioningOwner } from '../../../src/hooks/delegation-gate/worktree-provisioning-owner';
import { createSafeTestDir } from '../../helpers/safe-test-dir';

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

	beforeEach(() => {
		({ dir: directory, cleanup } = createSafeTestDir('swarm-collision-owner-'));
		fs.mkdirSync(path.join(directory, '.swarm'), { recursive: true });
	});

	afterEach(() => {
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
		mergeStatusInternals.resetForTest();
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
