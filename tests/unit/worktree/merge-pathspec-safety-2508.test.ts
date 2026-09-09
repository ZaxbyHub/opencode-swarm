import { afterEach, describe, expect, test } from 'bun:test';
import { publishWorktreeRecoveryAuthority } from '../../../src/hooks/delegation-gate/worktree-recovery-authority';
import type { BunCompatSubprocess } from '../../../src/utils/bun-compat';
import {
	_internals,
	cleanupOrphanedBranches,
	reconcileLandedMerge,
} from '../../../src/worktree/merge';
import { createSafeTestDir } from '../../helpers/safe-test-dir';

const OID = 'a'.repeat(40);
const realSpawn = _internals.bunSpawn;
const realSpawnSync = _internals.spawnSync;

function successProcess(stdout = ''): BunCompatSubprocess {
	return {
		exited: Promise.resolve(0),
		exitCode: 0,
		stdout: { text: () => Promise.resolve(stdout) },
		stderr: { text: () => Promise.resolve('') },
		kill: () => {},
	} as unknown as BunCompatSubprocess;
}

afterEach(() => {
	_internals.bunSpawn = realSpawn;
	_internals.spawnSync = realSpawnSync;
});

describe('squash reconciliation pathspec safety (#2508)', () => {
	test('passes leading-dash and colon paths as literal pathspecs', async () => {
		const calls: string[][] = [];
		_internals.bunSpawn = ((args: string[]) => {
			calls.push(args.slice(1));
			return successProcess(args.includes('rev-parse') ? `${OID}\n` : '');
		}) as typeof _internals.bunSpawn;

		const result = await reconcileLandedMerge('C:/repo', {
			operationId: 'operation-pathspec',
			sourceHead: OID,
			targetHeadBefore: OID,
			branchName: 'swarm/lane/session/lane',
			strategy: 'squash',
			resultTree: OID,
			changedPaths: ['-leading.txt', ':colon.txt'],
		});

		expect(result).toEqual({ landed: true, method: 'squash-worktree-tree' });
		const diffCalls = calls.filter((args) => args.includes('diff'));
		expect(diffCalls).toHaveLength(2);
		for (const args of diffCalls) {
			expect(args[0]).toBe('--literal-pathspecs');
			expect(args).toContain('--');
			expect(args).toContain('-leading.txt');
			expect(args).toContain(':colon.txt');
		}
	});

	test('cleanup uses the synchronous Git DI seam for retained authority refs', async () => {
		const fixture = createSafeTestDir('merge-di-seam-');
		try {
			const published = publishWorktreeRecoveryAuthority(fixture.dir, {
				originalCallID: 'call-di',
				parentSessionId: 'parent-di',
				taskId: 'task-di',
				reservationId: 'reservation-di',
				generation: 1,
				canonicalBranch: 'main',
				canonicalPath: fixture.dir,
				laneBranch: 'swarm-lane/session/lane',
				lanePath: fixture.dir,
				expectedPrimaryHead: OID,
				sourceBaseOid: OID,
				sourceHeadOid: OID,
				targetHeadOid: OID,
				strategy: 'squash',
				resultTree: OID,
				changedPaths: ['result.txt'],
			});
			expect(published).toMatchObject({ ok: true });
			const syncCalls: string[][] = [];
			_internals.spawnSync = ((command: string, args: string[]) => {
				syncCalls.push([command, ...args]);
				return { status: 0, stdout: `${OID}\n`, stderr: '' };
			}) as typeof _internals.spawnSync;
			_internals.bunSpawn = ((args: string[]) => {
				const stdout = args.includes('--format=%(refname:short)')
					? 'swarm-lane/session/lane\n'
					: '';
				return successProcess(stdout);
			}) as typeof _internals.bunSpawn;

			await cleanupOrphanedBranches(fixture.dir, []);

			expect(syncCalls.some((args) => args.includes('for-each-ref'))).toBe(
				true,
			);
			expect(syncCalls.some((args) => args.includes('update-ref'))).toBe(true);
		} finally {
			fixture.cleanup();
		}
	});
});
