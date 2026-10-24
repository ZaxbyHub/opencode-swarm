import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { BackgroundWorktreeDescriptor } from '../../../src/background/pending-delegations';
import { captureWorkspaceSnapshot } from '../../../src/background/workspace-snapshot';
import {
	awaitingMergeByCallID,
	cleanupStandardWorktreeForCallId,
	finishStandardWorktreeDispatch,
	resetStandardWorktreeIsolationState,
	type StandardWorktreeDispatch,
} from '../../../src/hooks/delegation-gate/worktree-isolation';
import { beginCoderSettlement } from '../../../src/workflow/coder-settlement';
import {
	cleanupOrphanedBranches,
	type MergeOperationProvenance,
} from '../../../src/worktree/merge';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const roots: string[] = [];
function git(cwd: string, ...args: string[]): string {
	return execFileSync('git', args, {
		cwd,
		encoding: 'utf8',
		timeout: 10_000,
		maxBuffer: 1024 * 1024,
		stdio: ['ignore', 'pipe', 'pipe'],
	}).trim();
}

function fixture(label: string): {
	root: string;
	worktree: string;
	dispatch: StandardWorktreeDispatch;
} {
	const root = canonicalMkdtemp(`merge-3409-${label}-`);
	roots.push(root);
	git(root, 'init', '--initial-branch=main');
	git(root, 'config', 'user.email', 'tests@example.invalid');
	git(root, 'config', 'user.name', 'Tests');
	git(root, 'config', 'core.autocrlf', 'false');
	fs.writeFileSync(path.join(root, 'shared.txt'), 'base\n');
	fs.writeFileSync(path.join(root, 'stable.txt'), 'base\n');
	git(root, 'add', '.');
	git(root, 'commit', '-m', 'base');
	const worktree = path.join(root, '.swarm', 'worktrees', label);
	fs.mkdirSync(path.dirname(worktree), { recursive: true });
	const branchName = `swarm/lane/${label}`;
	git(root, 'worktree', 'add', '-b', branchName, worktree);
	fs.writeFileSync(path.join(worktree, 'shared.txt'), 'lane\n');
	const callID = `call-${label}`;
	const dispatch: StandardWorktreeDispatch = {
		callID,
		parentSessionID: `parent-${label}`,
		taskId: '1.1',
		handle: {
			worktreePath: worktree,
			branchName,
			purpose: 'lane',
			id: label,
			sessionId: label,
		},
		mergeStrategy: 'merge',
		laneIndex: 0,
	};
	awaitingMergeByCallID.set(callID, {
		callID,
		parentSessionID: dispatch.parentSessionID,
		taskId: dispatch.taskId,
		branch: branchName,
		worktreePath: worktree,
		mergeStrategy: 'merge',
		queuedAt: 1,
	});
	return { root, worktree, dispatch };
}

function retrack(dispatch: StandardWorktreeDispatch): void {
	awaitingMergeByCallID.set(dispatch.callID, {
		callID: dispatch.callID,
		parentSessionID: dispatch.parentSessionID,
		taskId: dispatch.taskId,
		branch: dispatch.handle.branchName,
		worktreePath: dispatch.handle.worktreePath,
		mergeStrategy: 'merge',
		queuedAt: 1,
	});
}

afterEach(() => {
	resetStandardWorktreeIsolationState();
	for (const root of roots.splice(0))
		fs.rmSync(root, { recursive: true, force: true });
});

describe('issue #3409 stored merge settlement recovery', () => {
	test('reconciles the recorded source after target advances, preserves target work, and is idempotent', async () => {
		const { root, dispatch } = fixture('advanced-target');
		let provenance: MergeOperationProvenance | undefined;
		const first = await finishStandardWorktreeDispatch(
			root,
			dispatch,
			undefined,
			dispatch.callID,
			{
				operationId: 'transition-advanced-target',
				commitLanding: true,
				onBeforeMerge: async (record) => {
					provenance = record;
					throw new Error(
						'simulate crash after provenance persistence, before Git landing',
					);
				},
			},
		);
		expect(first.outcome).toBe('failed');
		expect(git(root, 'rev-parse', 'HEAD')).toBe(provenance?.targetHeadBefore);
		expect(provenance?.sourceHead).toMatch(/^[0-9a-f]{40,64}$/);

		fs.writeFileSync(path.join(root, 'stable.txt'), 'later target change\n');
		git(root, 'add', 'stable.txt');
		git(root, 'commit', '-m', 'advance target independently');
		const advancedTargetHead = git(root, 'rev-parse', 'HEAD');
		retrack(dispatch);
		const recovered = await finishStandardWorktreeDispatch(
			root,
			dispatch,
			undefined,
			dispatch.callID,
			{
				operationId: 'transition-advanced-target',
				commitLanding: true,
				resume: provenance,
				onMerged: async () => {},
			},
		);
		expect(recovered).toMatchObject({ outcome: 'merged' });
		expect(recovered.outcome === 'merged' && recovered.reconciled).toBe(false);
		const recoveredHead = git(root, 'rev-parse', 'HEAD');
		expect(recoveredHead).not.toBe(advancedTargetHead);
		expect(
			git(
				root,
				'merge-base',
				'--is-ancestor',
				provenance?.sourceHead ?? '',
				'HEAD',
			),
		).toBe('');
		expect(fs.readFileSync(path.join(root, 'stable.txt'), 'utf8')).toBe(
			'later target change\n',
		);
		expect(fs.readFileSync(path.join(root, 'shared.txt'), 'utf8')).toBe(
			'lane\n',
		);
		expect(fs.existsSync(dispatch.handle.worktreePath)).toBe(false);

		retrack(dispatch);
		const repeated = await finishStandardWorktreeDispatch(
			root,
			dispatch,
			undefined,
			dispatch.callID,
			{
				operationId: 'transition-advanced-target',
				commitLanding: true,
				resume: provenance,
				onMerged: async () => {},
			},
		);
		expect(repeated.outcome).toBe('merged');
		expect(git(root, 'rev-parse', 'HEAD')).toBe(recoveredHead);
	});

	test('success cleanup and orphan-branch cleanup preserve a lane with DISPATCHED settlement', async () => {
		const { root, worktree, dispatch } = fixture('pending-cleanup');
		git(worktree, 'add', 'shared.txt');
		git(worktree, 'commit', '-m', 'durable unlanded lane source');
		const descriptor: BackgroundWorktreeDescriptor = {
			callID: dispatch.callID,
			parentSessionId: dispatch.parentSessionID,
			taskId: dispatch.taskId,
			planTaskId: dispatch.taskId,
			worktreePath: worktree,
			branchName: dispatch.handle.branchName,
			worktreeId: dispatch.handle.id,
			worktreeSessionId: dispatch.handle.sessionId,
			mergeStrategy: 'merge',
			laneIndex: 0,
			worktreeDir: null,
		};
		await beginCoderSettlement({
			directory: root,
			taskId: dispatch.taskId,
			transitionId: 'coder:pending-cleanup',
			actor: 'architect',
			expectedGeneration: 0,
			context: {
				declaredFiles: ['shared.txt'],
				baseline: captureWorkspaceSnapshot(worktree),
				workflowGeneration: 0,
			},
			worktree: descriptor,
		});

		const directCleanup = await cleanupStandardWorktreeForCallId(
			dispatch.callID,
			'success',
			root,
		);
		const orphanCleanup = await cleanupOrphanedBranches(root, []);
		expect(directCleanup.removedWorktree).toBe(false);
		expect(orphanCleanup.removed).not.toContain(dispatch.handle.branchName);
		expect(fs.existsSync(worktree)).toBe(true);
		expect(git(root, 'branch', '--list', dispatch.handle.branchName)).not.toBe(
			'',
		);
	});

	test('keeps provenance and recovery coordinates when target changes overlap the source', async () => {
		const { root, worktree, dispatch } = fixture('overlapping-target');
		fs.writeFileSync(path.join(root, 'shared.txt'), 'target conflict\n');
		git(root, 'add', 'shared.txt');
		git(root, 'commit', '-m', 'conflicting target change');
		let provenance: MergeOperationProvenance | undefined;
		const result = await finishStandardWorktreeDispatch(
			root,
			dispatch,
			undefined,
			dispatch.callID,
			{
				operationId: 'transition-overlap',
				commitLanding: true,
				onBeforeMerge: async (record) => {
					provenance = record;
				},
				onMerged: async () => {
					throw new Error('partial result must not settle');
				},
			},
		);
		expect(result.outcome).toBe('partial');
		if (result.outcome !== 'partial')
			throw new Error('expected partial merge result');
		expect(result.stage).toBe('merge');
		expect(result.conflictFiles).toContain('shared.txt');
		expect(result.provenance?.sourceHead ?? provenance?.sourceHead).toMatch(
			/^[0-9a-f]{40,64}$/,
		);
		expect(fs.existsSync(worktree)).toBe(true);
		expect(git(root, 'branch', '--list', dispatch.handle.branchName)).not.toBe(
			'',
		);
		expect(
			fs
				.readFileSync(path.join(root, 'shared.txt'), 'utf8')
				.replace(/\r\n/g, '\n'),
		).toBe('target conflict\n');
	});

	test('refuses to overwrite an overlapping dirty target while resuming recorded provenance', async () => {
		const { root, worktree, dispatch } = fixture('dirty-overlap');
		git(worktree, 'add', 'shared.txt');
		git(worktree, 'commit', '-m', 'record lane source');
		const provenance: MergeOperationProvenance = {
			operationId: 'transition-dirty-overlap',
			sourceHead: git(worktree, 'rev-parse', 'HEAD'),
			targetHeadBefore: git(root, 'rev-parse', 'HEAD'),
			branchName: dispatch.handle.branchName,
			strategy: 'merge',
		};
		fs.writeFileSync(
			path.join(root, 'shared.txt'),
			'uncommitted target edit\n',
		);
		retrack(dispatch);
		const result = await finishStandardWorktreeDispatch(
			root,
			dispatch,
			undefined,
			dispatch.callID,
			{
				operationId: provenance.operationId,
				commitLanding: true,
				resume: provenance,
				onMerged: async () => {},
			},
		);
		expect(result.outcome).not.toBe('merged');
		expect(fs.readFileSync(path.join(root, 'shared.txt'), 'utf8')).toBe(
			'uncommitted target edit\n',
		);
		expect(fs.existsSync(worktree)).toBe(true);
		expect(git(root, 'branch', '--list', dispatch.handle.branchName)).not.toBe(
			'',
		);
	});
});
