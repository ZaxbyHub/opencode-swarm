import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	preserveBackgroundWorktreeOwnershipForCallId,
	resetStandardWorktreeIsolationState,
	type StandardWorktreeDispatch,
	standardWorktreeByCallID,
} from '../../../src/hooks/delegation-gate/worktree-isolation';
import type { WorktreeHandle } from '../../../src/worktree';
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

describe('background worktree ownership preservation', () => {
	afterEach(() => resetStandardWorktreeIsolationState());

	test('tags the current branch without committing or touching dirty files', async () => {
		const { dir, cleanup } = createSafeTestDir('swarm-bg-owner-tag-');
		try {
			git(dir, ['init']);
			git(dir, ['config', 'user.email', 'tests@example.com']);
			git(dir, ['config', 'user.name', 'Tests']);
			fs.writeFileSync(path.join(dir, 'base.txt'), 'base\n');
			git(dir, ['add', 'base.txt']);
			git(dir, ['commit', '-m', 'seed']);
			const head = git(dir, ['rev-parse', 'HEAD']);
			fs.writeFileSync(path.join(dir, 'dirty.txt'), 'still owned by child\n');
			const callID = 'background-call';
			standardWorktreeByCallID.set(callID, {
				callID,
				parentSessionID: 'parent',
				taskId: '1.1',
				planTaskId: '1.1',
				handle: {
					worktreePath: dir,
					branchName: 'swarm/lane/child/lane-1',
					purpose: 'lane',
					id: 'lane-1',
					sessionId: 'child',
				} as WorktreeHandle,
				mergeStrategy: 'merge',
				laneIndex: 0,
			} satisfies StandardWorktreeDispatch);

			const result = await preserveBackgroundWorktreeOwnershipForCallId(callID);

			expect(result.outcome).toBe('preserved');
			expect(result.ref).toBe(head);
			expect(git(dir, ['rev-parse', 'HEAD'])).toBe(head);
			expect(git(dir, ['status', '--porcelain'])).toContain('?? dirty.txt');
			expect(git(dir, ['tag', '--list', result.tag!])).toBe(result.tag);
		} finally {
			cleanup();
		}
	});
});
