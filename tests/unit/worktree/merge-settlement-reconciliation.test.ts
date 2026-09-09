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
import { lookupWorktreeRecoveryAuthoritiesByTask } from '../../../src/hooks/delegation-gate/worktree-recovery-authority';
import type { BunCompatSubprocess } from '../../../src/utils/bun-compat';

import {
	getMergeStrategy,
	type MergeOperationProvenance,
	type MergeStrategy,
	_internals as mergeInternals,
	mergeLaneBranch,
	reconcileLandedMerge,
} from '../../../src/worktree/merge';

const GIT_TIMEOUT_MS = 10_000;
const GIT_MAX_BUFFER = 1024 * 1024;
const tempRoots: string[] = [];
const realMergeBunSpawn = mergeInternals.bunSpawn;

function mockGitProcess(
	exitCode: number,
	stdout = '',
	stderr = '',
): BunCompatSubprocess {
	return {
		exited: Promise.resolve(exitCode),
		exitCode,
		stdout: { text: () => Promise.resolve(stdout) },
		stderr: { text: () => Promise.resolve(stderr) },
		kill: () => {},
	} as unknown as BunCompatSubprocess;
}

test('squash patch paths are operation-scoped even for the same branch', () => {
	const first = mergeInternals.squashPatchPath('C:/project', 'swarm/lane-0');
	const second = mergeInternals.squashPatchPath('C:/project', 'swarm/lane-0');
	expect(first).not.toBe(second);
	expect(first).toContain(
		path.join('C:/project', '.swarm', 'merge-settlement'),
	);
	expect(second).toContain(
		path.join('C:/project', '.swarm', 'merge-settlement'),
	);
});

test('standard merge strategy fallback is squash while explicit Lean merge remains merge', () => {
	expect(getMergeStrategy({})).toBe('squash');
	expect(getMergeStrategy({ merge_strategy: 'merge' })).toBe('merge');
});

test('NUL-delimited changed paths preserve legal whitespace and ignore empty records', () => {
	expect(
		mergeInternals.parseNulDelimitedPaths(' leading.txt \0\0trailing.txt\t\0'),
	).toEqual([' leading.txt ', 'trailing.txt\t']);
});

test('squash reconciliation treats an empty changed-path set as an explicit no-op', async () => {
	const head = 'a'.repeat(40);
	mergeInternals.bunSpawn = (() =>
		mockGitProcess(0, `${head}\n`)) as typeof mergeInternals.bunSpawn;

	const result = await reconcileLandedMerge('C:/repo', {
		operationId: 'empty-squash',
		sourceHead: 'b'.repeat(40),
		targetHeadBefore: head,
		branchName: 'swarm/lane/empty',
		strategy: 'squash',
		resultTree: 'c'.repeat(40),
		changedPaths: [],
	});

	expect(result).toEqual({ landed: true, method: 'squash-worktree-tree' });
});

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
	mergeInternals.bunSpawn = realMergeBunSpawn;
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

test('classifies non-conflict merge-tree failures as typed errors without applying', async () => {
	let spawnCount = 0;
	mergeInternals.bunSpawn = (() => {
		spawnCount += 1;
		return mockGitProcess(
			128,
			'conflicted-tree\n',
			'fatal: invalid object name',
		);
	}) as typeof mergeInternals.bunSpawn;

	const result = await mergeLaneBranch(
		path.resolve('.'),
		'swarm/lane/invalid-ref',
		'squash',
		undefined,
		{ targetHead: 'a'.repeat(40), sourceHead: 'b'.repeat(40) },
	);

	expect(result).toMatchObject({
		error: expect.stringContaining('squash-merge-tree-failed'),
	});
	expect(spawnCount).toBe(1);
});

test('squash merge-tree uses frozen object ids instead of mutable branch refs', async () => {
	const seenCommands: string[][] = [];
	mergeInternals.bunSpawn = ((command) => {
		seenCommands.push(command);
		if (seenCommands.length === 1) {
			return mockGitProcess(0, `${'c'.repeat(40)}\n`);
		}
		return mockGitProcess(0);
	}) as typeof mergeInternals.bunSpawn;

	const result = await mergeLaneBranch(
		path.resolve('.'),
		'swarm/lane/mutable-branch',
		'squash',
		undefined,
		{ targetHead: 'a'.repeat(40), sourceHead: 'b'.repeat(40) },
	);

	expect(result).toMatchObject({ merged: true, strategy: 'squash' });
	expect(seenCommands[0]).toEqual(
		expect.arrayContaining([
			'merge-tree',
			'--write-tree',
			'a'.repeat(40),
			'b'.repeat(40),
		]),
	);
	expect(seenCommands[0]).not.toContain('HEAD');
	expect(seenCommands[0]).not.toContain('swarm/lane/mutable-branch');
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

test('squash settlement applies a reviewable worktree patch and preserves primary index state', async () => {
	const { root, worktreePath, dispatch } = createDispatchFixture('squash');
	fs.writeFileSync(path.join(root, 'user-unstaged.txt'), 'baseline\n');
	git(root, 'add', 'user-unstaged.txt');
	git(root, 'commit', '-m', 'user baseline');
	const headBefore = git(root, 'rev-parse', 'HEAD');
	fs.writeFileSync(
		path.join(root, 'user-unstaged.txt'),
		'unstaged user change\n',
	);
	fs.writeFileSync(path.join(root, 'user-staged.txt'), 'staged user change\n');
	git(root, 'add', 'user-staged.txt');
	fs.writeFileSync(
		path.join(root, 'user-untracked.txt'),
		'untracked user change\n',
	);
	let provenance: MergeOperationProvenance | undefined;
	let authorityPublishedBeforeSettlementCommit = false;

	const result = await finishStandardWorktreeDispatch(
		root,
		dispatch,
		undefined,
		dispatch.callID,
		{
			operationId: 'operation-squash',
			onBeforeMerge: async (record) => {
				provenance = record;
			},
			onMerged: async () => {
				const authorities = lookupWorktreeRecoveryAuthoritiesByTask(root, {
					parentSessionId: dispatch.parentSessionID,
					taskId: dispatch.taskId,
				});
				authorityPublishedBeforeSettlementCommit =
					authorities.status === 'ok' && authorities.authorities.length === 1;
			},
		},
	);

	expect(result.outcome).toBe('merged');
	expect(result.outcome === 'merged' ? result.strategy : '').toBe('squash');
	expect(provenance?.resultTree).toMatch(/^[0-9a-f]{40,64}$/);
	expect(provenance?.changedPaths).toContain('result.txt');
	expect(authorityPublishedBeforeSettlementCommit).toBe(true);
	expect(git(root, 'rev-parse', 'HEAD')).toBe(headBefore);
	expect(
		fs
			.readFileSync(path.join(root, 'result.txt'), 'utf8')
			.replace(/\r\n/g, '\n'),
	).toBe('squash\n');
	expect(git(root, 'diff', '--cached', '--name-only')).toContain(
		'user-staged.txt',
	);
	const status = git(root, 'status', '--porcelain');
	expect(status).toContain(' M user-unstaged.txt');
	expect(status).toContain('?? user-untracked.txt');
	expect(fs.existsSync(worktreePath)).toBe(false);
	expect(git(root, 'branch', '--list', dispatch.handle.branchName)).not.toBe(
		'',
	);
	if (!provenance) throw new Error('expected squash provenance');
	const reconciled = await reconcileLandedMerge(root, provenance);
	expect(reconciled).toEqual({
		landed: true,
		method: 'squash-worktree-tree',
	});

	git(root, 'add', 'result.txt');
	const indexDrift = await reconcileLandedMerge(root, provenance);
	expect(indexDrift.landed).toBe(false);
	expect(indexDrift.error).toContain('index changed on affected paths');
});
