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
import { scanWorktreeRecoveryAuthoritiesForRecovery } from '../../../src/hooks/delegation-gate/worktree-recovery-authority';
import {
	cleanupOrphanedBranches,
	getMergeStrategy,
} from '../../../src/worktree/merge';

const GIT_TIMEOUT_MS = 60_000;
const GIT_MAX_BUFFER = 32 * 1024 * 1024;
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

function branchExists(cwd: string, branchName: string): boolean {
	try {
		git(cwd, 'show-ref', '--verify', `refs/heads/${branchName}`);
		return true;
	} catch {
		return false;
	}
}

function createFixture(): {
	root: string;
	worktreePath: string;
	dispatch: StandardWorktreeDispatch;
} {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-squash-real-git-'));
	tempRoots.push(root);
	git(root, 'init', '--initial-branch=main');
	git(root, 'config', 'user.email', 'swarm-test@example.invalid');
	git(root, 'config', 'user.name', 'Swarm Test');
	fs.writeFileSync(path.join(root, 'base.txt'), 'base\n');
	git(root, 'add', 'base.txt');
	git(root, 'commit', '-m', 'base');

	const worktreePath = path.join(
		root,
		'.swarm',
		'worktrees',
		'session',
		'squash',
	);
	fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
	const branchName = 'swarm/lane/session/squash';
	git(root, 'worktree', 'add', '-b', branchName, worktreePath);
	const dispatch: StandardWorktreeDispatch = {
		callID: 'call-squash-real-git',
		parentSessionID: 'parent-squash-real-git',
		taskId: 'task-squash-real-git',
		handle: {
			worktreePath,
			branchName,
			purpose: 'lane',
			id: 'squash-real-git',
			sessionId: 'session',
		},
		mergeStrategy: 'squash',
		laneIndex: 0,
	};
	awaitingMergeByCallID.set(dispatch.callID, {
		callID: dispatch.callID,
		parentSessionID: dispatch.parentSessionID,
		taskId: dispatch.taskId,
		branch: branchName,
		worktreePath,
		mergeStrategy: 'squash',
		queuedAt: Date.now(),
	});
	return { root, worktreePath, dispatch };
}

async function settle(
	root: string,
	dispatch: StandardWorktreeDispatch,
): Promise<Awaited<ReturnType<typeof finishStandardWorktreeDispatch>>> {
	return finishStandardWorktreeDispatch(
		root,
		dispatch,
		undefined,
		dispatch.callID,
		{
			operationId: `operation-${dispatch.callID}`,
			onBeforeMerge: async () => {},
			onMerged: async () => {},
		},
	);
}

afterEach(() => {
	resetStandardWorktreeIsolationState();
	for (const root of tempRoots.splice(0)) {
		try {
			if (fs.existsSync(path.join(root, '.git')))
				git(root, 'worktree', 'prune');
		} catch {
			// Best-effort fixture cleanup after an assertion or Git failure.
		}
		fs.rmSync(root, { recursive: true, force: true });
	}
});

describe('real-Git squash settlement edge cases', () => {
	test('preserves a Windows autocrlf text roundtrip', async () => {
		const { root, worktreePath, dispatch } = createFixture();
		git(root, 'config', 'core.autocrlf', 'true');
		fs.writeFileSync(path.join(worktreePath, 'crlf.txt'), 'lane text\n');
		git(worktreePath, 'add', 'crlf.txt');
		git(worktreePath, 'commit', '-m', 'lane text');

		const headBefore = git(root, 'rev-parse', 'HEAD');
		const result = await settle(root, dispatch);

		expect(result.outcome).toBe('merged');
		expect(git(root, 'rev-parse', 'HEAD')).toBe(headBefore);
		expect(
			fs
				.readFileSync(path.join(root, 'crlf.txt'), 'utf8')
				.replace(/\r\n/g, '\n'),
		).toBe('lane text\n');
	});

	test('round-trips a binary blob through the full-index patch', async () => {
		const { root, worktreePath, dispatch } = createFixture();
		const binary = Buffer.from([0, 1, 2, 127, 128, 200, 255, 0, 42]);
		fs.writeFileSync(path.join(worktreePath, 'blob.bin'), binary);
		git(worktreePath, 'add', 'blob.bin');
		git(worktreePath, 'commit', '-m', 'lane binary blob');

		const result = await settle(root, dispatch);

		expect(result.outcome).toBe('merged');
		expect(fs.readFileSync(path.join(root, 'blob.bin'))).toEqual(binary);
	});

	test('fails an over-16-MiB patch before mutating the primary worktree', async () => {
		const { root, worktreePath, dispatch } = createFixture();
		const headBefore = git(root, 'rev-parse', 'HEAD');
		fs.writeFileSync(
			path.join(worktreePath, 'large.bin'),
			Buffer.alloc(17 * 1024 * 1024, 0x78),
		);
		git(worktreePath, 'add', 'large.bin');
		git(worktreePath, 'commit', '-m', 'lane oversized blob');

		const result = await settle(root, dispatch);

		expect(result.outcome).toBe('failed');
		expect(git(root, 'rev-parse', 'HEAD')).toBe(headBefore);
		expect(fs.existsSync(path.join(root, 'large.bin'))).toBe(false);
		expect(scanWorktreeRecoveryAuthoritiesForRecovery(root)).toMatchObject({
			status: 'ok',
			authorities: [],
		});
	});

	test('applies a lane change against a diverged target without landing a commit', async () => {
		const { root, worktreePath, dispatch } = createFixture();
		fs.writeFileSync(path.join(worktreePath, 'lane.txt'), 'lane\n');
		git(worktreePath, 'add', 'lane.txt');
		git(worktreePath, 'commit', '-m', 'lane change');
		fs.writeFileSync(path.join(root, 'target.txt'), 'target\n');
		git(root, 'add', 'target.txt');
		git(root, 'commit', '-m', 'diverged target');
		const headBefore = git(root, 'rev-parse', 'HEAD');

		const result = await settle(root, dispatch);

		expect(result.outcome).toBe('merged');
		expect(git(root, 'rev-parse', 'HEAD')).toBe(headBefore);
		expect(
			fs
				.readFileSync(path.join(root, 'lane.txt'), 'utf8')
				.replace(/\r\n/g, '\n'),
		).toBe('lane\n');
		expect(fs.readFileSync(path.join(root, 'target.txt'), 'utf8')).toBe(
			'target\n',
		);
	});

	test('preserves the primary worktree on a rename/rename conflict', async () => {
		const { root, worktreePath, dispatch } = createFixture();
		git(worktreePath, 'mv', 'base.txt', 'lane-name.txt');
		git(worktreePath, 'commit', '-m', 'lane rename');
		git(root, 'mv', 'base.txt', 'primary-name.txt');
		git(root, 'commit', '-m', 'primary rename');
		const headBefore = git(root, 'rev-parse', 'HEAD');

		const result = await settle(root, dispatch);

		expect(result.outcome).toBe('partial');
		expect(git(root, 'rev-parse', 'HEAD')).toBe(headBefore);
		expect(fs.existsSync(path.join(root, 'primary-name.txt'))).toBe(true);
		expect(fs.existsSync(path.join(root, 'lane-name.txt'))).toBe(false);
		expect(fs.existsSync(worktreePath)).toBe(true);
		expect(scanWorktreeRecoveryAuthoritiesForRecovery(root)).toMatchObject({
			status: 'ok',
			authorities: [],
		});
	});

	test('settles an empty lane without changing primary HEAD', async () => {
		const { root, dispatch } = createFixture();
		const headBefore = git(root, 'rev-parse', 'HEAD');

		const result = await settle(root, dispatch);

		expect(result.outcome).toBe('merged');
		expect(git(root, 'rev-parse', 'HEAD')).toBe(headBefore);
	});

	test('auto-clears retained authority only after committed artifact equality', async () => {
		const { root, worktreePath, dispatch } = createFixture();
		fs.writeFileSync(path.join(worktreePath, 'result.txt'), 'artifact\n');
		git(worktreePath, 'add', 'result.txt');
		git(worktreePath, 'commit', '-m', 'lane artifact');
		const settled = await settle(root, dispatch);
		expect(settled.outcome).toBe('merged');
		expect(scanWorktreeRecoveryAuthoritiesForRecovery(root)).toMatchObject({
			status: 'ok',
			authorities: [expect.anything()],
		});

		git(root, 'add', 'result.txt');
		git(root, 'commit', '-m', 'operator committed artifact');
		const cleanup = await cleanupOrphanedBranches(root, []);

		expect(cleanup.skippedRecoveryBranches).not.toContain(
			dispatch.handle.branchName,
		);
		expect(branchExists(root, dispatch.handle.branchName)).toBe(false);
		expect(scanWorktreeRecoveryAuthoritiesForRecovery(root)).toEqual({
			status: 'ok',
			authorities: [],
		});
	});

	test('preserves authority when the committed artifact is ambiguous', async () => {
		const { root, worktreePath, dispatch } = createFixture();
		fs.writeFileSync(path.join(worktreePath, 'result.txt'), 'artifact\n');
		git(worktreePath, 'add', 'result.txt');
		git(worktreePath, 'commit', '-m', 'lane artifact');
		const settled = await settle(root, dispatch);
		expect(settled.outcome).toBe('merged');
		fs.writeFileSync(path.join(root, 'result.txt'), 'different\n');
		git(root, 'add', 'result.txt');
		git(root, 'commit', '-m', 'operator changed artifact');

		await cleanupOrphanedBranches(root, []);

		expect(branchExists(root, dispatch.handle.branchName)).toBe(true);
		expect(scanWorktreeRecoveryAuthoritiesForRecovery(root)).toMatchObject({
			status: 'ok',
			authorities: [expect.anything()],
		});
	});
});

test('standard strategy helper remains explicit for Lean callers', () => {
	expect(getMergeStrategy({ merge_strategy: 'merge' })).toBe('merge');
});
