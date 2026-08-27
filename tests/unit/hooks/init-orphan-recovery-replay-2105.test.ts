import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	_internals,
	runInitOrphanRecovery,
} from '../../../src/hooks/init-orphan-recovery';
import { createSafeTestDir } from '../../helpers/safe-test-dir';

type Fixture = ReturnType<typeof createSafeTestDir>;

function git(directory: string, args: string[]): string {
	const result = spawnSync('git', ['-C', directory, ...args], {
		cwd: directory,
		stdin: 'ignore',
		stdout: 'pipe',
		stderr: 'pipe',
		encoding: 'utf8',
		timeout: 10_000,
		maxBuffer: 256 * 1024,
	});
	if (result.error) throw result.error;
	if (result.status !== 0) throw new Error(result.stderr || result.stdout);
	return result.stdout.trim();
}

function initGitRepo(directory: string): void {
	fs.mkdirSync(directory, { recursive: true });
	git(directory, ['init']);
	git(directory, ['config', 'user.email', 'tests@example.com']);
	git(directory, ['config', 'user.name', 'Tests']);
	fs.writeFileSync(path.join(directory, 'README.md'), 'seed\n');
	git(directory, ['add', 'README.md']);
	git(directory, ['commit', '-m', 'seed']);
}

describe('issue #2105 init orphan recovery replay signaling', () => {
	let fixture: Fixture;
	let directory: string;
	let root: string;
	let originals: Record<string, unknown>;

	beforeEach(() => {
		fixture = createSafeTestDir('init-orphan-replay-2105-');
		directory = path.join(fixture.dir, 'project');
		root = fixture.dir;
		originals = {
			tryAcquireLock: _internals.tryAcquireLock,
			replayWorktreeRecoveryClaimJournal:
				_internals.replayWorktreeRecoveryClaimJournal,
			scanWorktreeRecoveryAuthoritiesForRecovery:
				_internals.scanWorktreeRecoveryAuthoritiesForRecovery,
			scanWorktreeProvisioningOwnersForRecovery:
				_internals.scanWorktreeProvisioningOwnersForRecovery,
			scanRegisteredWorktreeLiveness: _internals.scanRegisteredWorktreeLiveness,
			listOwnershipTagSessionIds: _internals.listOwnershipTagSessionIds,
			scanDelegationFallbacksForRecovery:
				_internals.scanDelegationFallbacksForRecovery,
			scanDelegationsForRecovery: _internals.scanDelegationsForRecovery,
			scanWorktreeMergeFailuresForRecovery:
				_internals.scanWorktreeMergeFailuresForRecovery,
			recordDelegationRecoveryObservation:
				_internals.recordDelegationRecoveryObservation,
		};
	});

	afterEach(() => {
		Object.assign(_internals, originals);
		fixture.cleanup();
	});

	test('fails closed when replay finds a committed claim without its authoritative record', async () => {
		fs.mkdirSync(path.join(directory, '.swarm'), { recursive: true });
		const recordObservation = mock(() => {});
		_internals.tryAcquireLock = mock(async () => ({
			acquired: true,
			lock: { _release: async () => {} },
		})) as never;
		_internals.replayWorktreeRecoveryClaimJournal = mock(() => [
			{
				authorityDigest: 'digest-missing',
				outcome: 'uncertain_committed_without_authority',
			},
		]) as never;
		_internals.recordDelegationRecoveryObservation = recordObservation as never;

		const result = await runInitOrphanRecovery(directory);

		expect(result.attempted).toBe(false);
		expect(result.diagnostic?.reason).toContain(
			'worktree recovery replay is uncertain for authority digest-missing',
		);
		expect(recordObservation).toHaveBeenCalledWith(
			directory,
			expect.objectContaining({
				source: 'unknown',
				ok: false,
				reason: expect.stringContaining('digest-missing'),
			}),
		);
	});

	test('surfaces a startup warning for a preserved claimed recovery lane after restart', async () => {
		initGitRepo(directory);
		const worktreePath = path.join(root, '.swarm-worktrees', 'child-1', '2.1');
		fs.mkdirSync(worktreePath, { recursive: true });
		fs.writeFileSync(path.join(worktreePath, 'valuable.txt'), 'keep\n');
		_internals.tryAcquireLock = mock(async () => ({
			acquired: true,
			lock: { _release: async () => {} },
		})) as never;
		_internals.replayWorktreeRecoveryClaimJournal = mock(() => [
			{
				authorityDigest: 'digest-claimed',
				outcome: 'committed_claim_stable',
			},
		]) as never;
		_internals.scanWorktreeRecoveryAuthoritiesForRecovery = mock(() => ({
			status: 'ok' as const,
			authorities: [
				{
					schemaVersion: 2 as const,
					authorityDigest: 'digest-claimed',
					status: 'claimed' as const,
					immutable: {
						originalCallID: 'call-original',
						parentSessionId: 'parent-1',
						taskId: '2.1',
						reservationId: 'reservation-1',
						generation: 3,
						canonicalBranch: 'main',
						canonicalPath: directory,
						laneBranch: 'swarm/lane/child-1/2.1',
						lanePath: worktreePath,
						expectedPrimaryHead: 'a'.repeat(40),
						sourceBaseOid: 'b'.repeat(40),
						sourceHeadOid: 'c'.repeat(40),
						targetHeadOid: 'd'.repeat(40),
						strategy: 'merge' as const,
						createdAt: 1,
					},
					claim: {
						claimantCallID: 'call-recovery',
						claimantSessionId: 'parent-1',
						childSessionId: 'child-1',
						claimRevision: 2,
						attempt: 1,
						leaseExpiresAt: 60_000,
						claimTokenDigest: 'digest-token',
						claimedAt: 1,
					},
				},
			],
		})) as never;
		_internals.scanWorktreeProvisioningOwnersForRecovery = mock(() => ({
			status: 'ok' as const,
			owners: [],
		})) as never;
		_internals.scanRegisteredWorktreeLiveness = mock(async () => ({
			status: 'ok' as const,
			liveBranches: [],
		})) as never;
		_internals.listOwnershipTagSessionIds = mock(async () => ({
			status: 'ok' as const,
			sessionIds: [],
		})) as never;
		_internals.scanDelegationFallbacksForRecovery = mock(async () => ({
			status: 'ok' as const,
			owners: [],
		})) as never;
		_internals.scanDelegationsForRecovery = mock(() => ({
			status: 'ok' as const,
			owners: [],
			source: 'legacy-ledger' as const,
		})) as never;
		_internals.scanWorktreeMergeFailuresForRecovery = mock(() => ({
			status: 'ok' as const,
			failures: [],
		})) as never;

		const result = await runInitOrphanRecovery(directory);

		expect(result.attempted).toBe(true);
		expect(result.removedWorktrees).not.toContain(worktreePath);
		expect(
			result.warnings.some((warning) =>
				warning.includes(
					'Preserved claimed recovery lane "swarm/lane/child-1/2.1"',
				),
			),
		).toBe(true);
		expect(
			fs.readFileSync(path.join(worktreePath, 'valuable.txt'), 'utf8'),
		).toBe('keep\n');
	});
});
