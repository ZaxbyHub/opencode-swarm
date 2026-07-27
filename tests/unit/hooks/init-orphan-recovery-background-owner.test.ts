import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	type RecordPendingInput,
	recordPendingDelegation,
	writeDelegationFallback,
} from '../../../src/background/pending-delegations';
import {
	initDurableStatusPath,
	_internals as mergeStatusInternals,
	recordWorktreeMergeFailure,
} from '../../../src/hooks/delegation-gate/worktree-merge-status';
import { runInitOrphanRecovery } from '../../../src/hooks/init-orphan-recovery';
import { resetSwarmState } from '../../../src/state';

describe('init orphan recovery durable background ownership', () => {
	const roots: string[] = [];

	afterEach(() => {
		resetSwarmState();
		mergeStatusInternals.resetForTest();
		for (const root of roots.splice(0)) {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test('preserves a double-store-failure worktree from durable recovery status', async () => {
		const root = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-bg-preserved-owner-')),
		);
		roots.push(root);
		const project = path.join(root, 'project');
		const worktreePath = path.join(
			root,
			'.swarm-worktrees',
			'background-child',
			'lane-1',
		);
		fs.mkdirSync(path.join(project, '.swarm'), { recursive: true });
		fs.mkdirSync(worktreePath, { recursive: true });
		fs.writeFileSync(path.join(worktreePath, 'valuable.txt'), 'keep\n');
		initDurableStatusPath(project);
		// Write a merge failure that persists to disk, then simulate a process
		// restart (clear in-memory map, reload from durable file).
		recordWorktreeMergeFailure('1.1', {
			outcome: 'failed',
			stage: 'background-correlation-persist',
			message: 'both stores failed; ownership tag created',
			worktreePath,
			branch: 'swarm/lane/background-child/lane-1',
		});

		// Simulate process restart: clear in-memory map but keep the durable
		// file on disk. We avoid resetForTest() here because it also deletes
		// the durable file (PRR-016 fix); instead, directly clear only the
		// in-memory state and re-initialize from disk.
		mergeStatusInternals.failuresByTask.clear();
		mergeStatusInternals.initDurableStatusPath(project);
		resetSwarmState();
		const result = await runInitOrphanRecovery(project);

		expect(result.removedWorktrees).not.toContain(worktreePath);
		expect(
			fs.readFileSync(path.join(worktreePath, 'valuable.txt'), 'utf8'),
		).toBe('keep\n');
	});

	test.each([
		'primary',
		'fallback',
	] as const)('preserves a %s-owned worktree after process state is lost', async (ownerStore) => {
		const root = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-bg-owner-')),
		);
		roots.push(root);
		const project = path.join(root, 'project');
		const worktreePath = path.join(
			root,
			'.swarm-worktrees',
			'background-child',
			'lane-1',
		);
		fs.mkdirSync(path.join(project, '.swarm'), { recursive: true });
		fs.mkdirSync(worktreePath, { recursive: true });
		fs.writeFileSync(path.join(worktreePath, 'valuable.txt'), 'keep\n');
		const input: RecordPendingInput = {
			correlationId: `${ownerStore}-child`,
			jobId: `${ownerStore}-job`,
			subagentSessionId: `${ownerStore}-child`,
			parentSessionId: 'parent',
			callID: `${ownerStore}-call`,
			normalizedAgent: 'coder',
			swarmPrefixedAgent: 'coder',
			planTaskId: '1.1',
			evidenceTaskId: '1.1',
			taskChangeContext: {
				declaredFiles: ['valuable.txt'],
				baseline: {
					directory: worktreePath,
					gitHead: 'base',
					dirtyHash: 'clean',
					changedFiles: [],
					prHeadSha: null,
					scope: '1.1',
				},
			},
			worktree: {
				callID: `${ownerStore}-call`,
				parentSessionId: 'parent',
				taskId: '1.1',
				planTaskId: '1.1',
				worktreePath,
				branchName: `swarm/lane/${ownerStore}`,
				worktreeId: 'lane-1',
				worktreeSessionId: 'background-child',
				mergeStrategy: 'merge',
				laneIndex: 0,
				worktreeDir: null,
			},
		};
		if (ownerStore === 'primary') {
			await recordPendingDelegation(project, input);
		} else {
			await writeDelegationFallback(project, input);
		}

		resetSwarmState();
		const result = await runInitOrphanRecovery(project);

		expect(result.attempted).toBe(true);
		expect(result.removedWorktrees).not.toContain(worktreePath);
		expect(
			fs.readFileSync(path.join(worktreePath, 'valuable.txt'), 'utf8'),
		).toBe('keep\n');
	});
});
