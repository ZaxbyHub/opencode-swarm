import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	awaitingMergeByCallID,
	finishStandardWorktreeDispatch,
	resetStandardWorktreeIsolationState,
	type StandardWorktreeDispatch,
} from '../../../src/hooks/delegation-gate/worktree-isolation';
import type {
	MergeOperationProvenance,
	MergeStrategy,
} from '../../../src/worktree/merge';

const GIT_TIMEOUT_MS = 10_000;
const GIT_MAX_BUFFER = 1024 * 1024;
const tempRoots: string[] = [];

function git(cwd: string, ...args: string[]): string {
	return execFileSync('git', args, {
		cwd,
		encoding: 'utf8',
		timeout: GIT_TIMEOUT_MS,
		maxBuffer: GIT_MAX_BUFFER,
		stdio: ['ignore', 'pipe', 'pipe'],
	}).trim();
}

function createDispatchFixture(strategy: MergeStrategy): {
	root: string;
	worktreePath: string;
	dispatch: StandardWorktreeDispatch;
} {
	const root = fs.mkdtempSync(
		path.join(os.tmpdir(), `swarm-settlement-${strategy}-`),
	);
	tempRoots.push(root);
	git(root, 'init', '--initial-branch=main');
	git(root, 'config', 'user.email', 'swarm-test@example.invalid');
	git(root, 'config', 'user.name', 'Swarm Test');
	fs.writeFileSync(path.join(root, 'result.txt'), 'base\n');
	git(root, 'add', 'result.txt');
	git(root, 'commit', '-m', 'base');

	const worktreePath = path.join(
		root,
		'.swarm',
		'worktrees',
		'session',
		strategy,
	);
	fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
	const branchName = `swarm/lane/session/${strategy}`;
	git(root, 'worktree', 'add', '-b', branchName, worktreePath);
	fs.writeFileSync(path.join(worktreePath, 'result.txt'), `${strategy}\n`);

	const callID = `call-${strategy}`;
	const dispatch: StandardWorktreeDispatch = {
		callID,
		parentSessionID: `parent-${strategy}`,
		taskId: `task-${strategy}`,
		handle: {
			worktreePath,
			branchName,
			purpose: 'lane',
			id: strategy,
			sessionId: 'session',
		},
		mergeStrategy: strategy,
		laneIndex: 0,
	};
	awaitingMergeByCallID.set(callID, {
		callID,
		parentSessionID: dispatch.parentSessionID,
		taskId: dispatch.taskId,
		branch: branchName,
		worktreePath,
		mergeStrategy: strategy,
		queuedAt: Date.now(),
	});
	return { root, worktreePath, dispatch };
}

function retrack(dispatch: StandardWorktreeDispatch): void {
	awaitingMergeByCallID.set(dispatch.callID, {
		callID: dispatch.callID,
		parentSessionID: dispatch.parentSessionID,
		taskId: dispatch.taskId,
		branch: dispatch.handle.branchName,
		worktreePath: dispatch.handle.worktreePath,
		mergeStrategy: dispatch.mergeStrategy,
		queuedAt: Date.now(),
	});
}

afterEach(() => {
	resetStandardWorktreeIsolationState();
	for (const root of tempRoots.splice(0)) {
		try {
			if (fs.existsSync(path.join(root, '.git'))) {
				git(root, 'worktree', 'prune');
			}
		} catch {
			// Best-effort fixture cleanup after an assertion or Git failure.
		}
		fs.rmSync(root, { recursive: true, force: true });
	}
});

for (const strategy of ['merge', 'rebase', 'cherry-pick'] as const) {
	describe(`${strategy} standard-worktree settlement`, () => {
		test('persists pre-merge provenance and reconciles Git success after callback failure', async () => {
			const { root, worktreePath, dispatch } = createDispatchFixture(strategy);
			let provenance: MergeOperationProvenance | undefined;
			let beforeMergeCalls = 0;
			let mergedCalls = 0;

			const firstResult = await finishStandardWorktreeDispatch(
				root,
				dispatch,
				undefined,
				dispatch.callID,
				{
					operationId: `operation-${strategy}`,
					onBeforeMerge: async (record) => {
						beforeMergeCalls++;
						provenance = record;
					},
					onMerged: async () => {
						mergedCalls++;
						throw new Error('injected durable write failure');
					},
				},
			);

			expect(firstResult.outcome).toBe('failed');
			expect(firstResult.outcome === 'failed' ? firstResult.stage : '').toBe(
				'settlement-persist',
			);
			expect(beforeMergeCalls).toBe(1);
			expect(mergedCalls).toBe(1);
			expect(provenance?.operationId).toBe(`operation-${strategy}`);
			expect(provenance?.branchName).toBe(dispatch.handle.branchName);
			expect(provenance?.strategy).toBe(strategy);
			expect(provenance?.sourceHead).toMatch(/^[0-9a-f]{40,64}$/);
			expect(provenance?.targetHeadBefore).toMatch(/^[0-9a-f]{40,64}$/);
			expect(fs.existsSync(worktreePath)).toBe(true);
			expect(
				git(root, 'branch', '--list', dispatch.handle.branchName),
			).not.toBe('');
			expect(
				fs
					.readFileSync(path.join(root, 'result.txt'), 'utf8')
					.replace(/\r\n/g, '\n'),
			).toBe(`${strategy}\n`);
			const targetAfterGitSuccess = git(root, 'rev-parse', 'HEAD');

			retrack(dispatch);
			const retryResult = await finishStandardWorktreeDispatch(
				root,
				dispatch,
				undefined,
				dispatch.callID,
				{
					operationId: `operation-${strategy}`,
					resume: provenance,
					onBeforeMerge: async () => {
						beforeMergeCalls++;
					},
					onMerged: async () => {
						mergedCalls++;
					},
				},
			);

			expect(retryResult.outcome).toBe('merged');
			expect(
				retryResult.outcome === 'merged' ? retryResult.reconciled : false,
			).toBe(true);
			expect(beforeMergeCalls).toBe(1);
			expect(mergedCalls).toBe(2);
			expect(git(root, 'rev-parse', 'HEAD')).toBe(targetAfterGitSuccess);
			expect(fs.existsSync(worktreePath)).toBe(false);
			expect(git(root, 'branch', '--list', dispatch.handle.branchName)).toBe(
				'',
			);
		});
	});
}

test('cherry-pick merge-back writes the exact -x source trailer', async () => {
	const { root, dispatch } = createDispatchFixture('cherry-pick');
	let provenance: MergeOperationProvenance | undefined;

	const result = await finishStandardWorktreeDispatch(
		root,
		dispatch,
		undefined,
		dispatch.callID,
		{
			operationId: 'operation-cherry-pick-trailer',
			onBeforeMerge: async (record) => {
				provenance = record;
			},
			onMerged: async () => {},
		},
	);

	expect(result.outcome).toBe('merged');
	const body = git(root, 'show', '-s', '--format=%B', 'HEAD');
	expect(body.split(/\r?\n/)).toContain(
		`(cherry picked from commit ${provenance?.sourceHead})`,
	);
});

test('conflict returns a structured partial result and preserves recovery coordinates', async () => {
	const { root, worktreePath, dispatch } = createDispatchFixture('merge');
	fs.writeFileSync(path.join(root, 'result.txt'), 'target conflict\n');
	git(root, 'add', 'result.txt');
	git(root, 'commit', '-m', 'conflicting target change');

	const result = await finishStandardWorktreeDispatch(
		root,
		dispatch,
		undefined,
		dispatch.callID,
		{
			operationId: 'operation-conflict',
			onBeforeMerge: async () => {},
			onMerged: async () => {
				throw new Error('must not publish a partial merge');
			},
		},
	);

	expect(result.outcome).toBe('partial');
	if (result.outcome !== 'partial') {
		throw new Error(`expected partial settlement, received ${result.outcome}`);
	}
	expect(result.stage).toBe('merge');
	expect(result.conflictFiles).toContain('result.txt');
	expect(result.provenance?.operationId).toBe('operation-conflict');
	expect(fs.existsSync(worktreePath)).toBe(true);
	expect(git(root, 'branch', '--list', dispatch.handle.branchName)).not.toBe(
		'',
	);
});
