import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	_internals,
	claimWorktreeRecoveryAuthority,
	finalizeWorktreeRecoveryAuthority,
	publishWorktreeRecoveryAuthority,
	releaseWorktreeRecoveryClaim,
	replayWorktreeRecoveryClaimJournal,
	scanWorktreeRecoveryAuthoritiesForRecovery,
} from '../../../src/hooks/delegation-gate/worktree-recovery-authority';
import { createSafeTestDir } from '../../helpers/safe-test-dir';

const OID = (value: string) => value.repeat(40);

function identity(taskId: string) {
	return {
		originalCallID: `call-${taskId}`,
		parentSessionId: 'parent',
		taskId,
		reservationId: `reservation-${taskId}`,
		generation: 1,
		canonicalBranch: 'main',
		canonicalPath: 'C:/repo',
		laneBranch: `swarm/lane/parent/${taskId}`,
		lanePath: `C:/repo/.swarm-worktrees/parent/${taskId}`,
		expectedPrimaryHead: OID('a'),
		sourceBaseOid: OID('b'),
		sourceHeadOid: OID('c'),
		targetHeadOid: OID('d'),
		strategy: 'merge' as const,
	};
}

describe('issue #2105 recovery authority transaction/restart safety', () => {
	let cleanup: (() => void) | undefined;

	afterEach(() => cleanup?.());

	test('a contended cross-process transaction fails closed without losing another authority', () => {
		const safe = createSafeTestDir('worktree-recovery-lock-2105-');
		cleanup = safe.cleanup;
		expect(publishWorktreeRecoveryAuthority(safe.dir, identity('1.1')).ok).toBe(
			true,
		);
		const lockPath = path.join(
			safe.dir,
			'.swarm',
			'locks',
			'worktree-recovery-authority.lock',
		);
		fs.mkdirSync(path.dirname(lockPath), { recursive: true });
		fs.writeFileSync(lockPath, 'held\n', { flag: 'wx' });

		const blocked = publishWorktreeRecoveryAuthority(safe.dir, identity('1.2'));
		expect(blocked).toMatchObject({ ok: false, code: 'busy' });
		fs.unlinkSync(lockPath);
		const scan = scanWorktreeRecoveryAuthoritiesForRecovery(safe.dir);
		expect(scan.status).toBe('ok');
		if (scan.status === 'ok') {
			expect(scan.authorities.map((entry) => entry.immutable.taskId)).toEqual([
				'1.1',
			]);
		}
	});

	test('startup replay releases a COMMITTED-before-prompt claim for exact redispatch', async () => {
		const safe = createSafeTestDir('worktree-recovery-restart-2105-');
		cleanup = safe.cleanup;
		const published = publishWorktreeRecoveryAuthority(
			safe.dir,
			identity('2.1'),
		);
		expect(published.ok).toBe(true);
		if (!published.ok) throw new Error(published.reason);
		const claimed = await claimWorktreeRecoveryAuthority(safe.dir, {
			authorityDigest: published.authority.authorityDigest,
			claimantCallID: 'retry-B',
			claimantSessionId: 'parent',
			leaseMs: 60_000,
			createChildSession: () => 'child-B',
		});
		expect(claimed.ok).toBe(true);

		const replayed = replayWorktreeRecoveryClaimJournal(safe.dir);
		expect(replayed).toContainEqual({
			authorityDigest: published.authority.authorityDigest,
			outcome: 'released_orphaned_committed_claim',
		});
		const scan = scanWorktreeRecoveryAuthoritiesForRecovery(safe.dir);
		expect(scan.status).toBe('ok');
		if (scan.status === 'ok') {
			expect(scan.authorities[0]?.status).toBe('preserved');
			expect(scan.authorities[0]?.claim).toBeUndefined();
		}
	});

	test('release and finalize advance the journal to terminal states before restart replay', async () => {
		const safe = createSafeTestDir('worktree-recovery-terminal-2105-');
		cleanup = safe.cleanup;
		for (const [taskId, terminal] of [
			['3.1', 'release'],
			['3.2', 'finalize'],
		] as const) {
			const published = publishWorktreeRecoveryAuthority(
				safe.dir,
				identity(taskId),
			);
			expect(published.ok).toBe(true);
			if (!published.ok) throw new Error(published.reason);
			const claimed = await claimWorktreeRecoveryAuthority(safe.dir, {
				authorityDigest: published.authority.authorityDigest,
				claimantCallID: `retry-${taskId}`,
				claimantSessionId: 'parent',
				leaseMs: 60_000,
				createChildSession: () => `child-${taskId}`,
			});
			expect(claimed.ok).toBe(true);
			if (!claimed.ok) throw new Error(claimed.reason);
			const request = {
				authorityDigest: published.authority.authorityDigest,
				claimantCallID: `retry-${taskId}`,
				claimRevision: claimed.authority.claim!.claimRevision,
				rawToken: claimed.rawToken,
			};
			const result =
				terminal === 'release'
					? releaseWorktreeRecoveryClaim(safe.dir, request)
					: finalizeWorktreeRecoveryAuthority(safe.dir, request);
			expect(result.ok).toBe(true);
		}

		expect(replayWorktreeRecoveryClaimJournal(safe.dir)).toEqual([
			expect.objectContaining({ outcome: 'noop' }),
			expect.objectContaining({ outcome: 'noop' }),
		]);
	});

	test('replay repairs a crash between the released store write and terminal journal append', async () => {
		const safe = createSafeTestDir('worktree-recovery-terminal-crash-2105-');
		cleanup = safe.cleanup;
		const published = publishWorktreeRecoveryAuthority(
			safe.dir,
			identity('4.1'),
		);
		if (!published.ok) throw new Error(published.reason);
		const claimed = await claimWorktreeRecoveryAuthority(safe.dir, {
			authorityDigest: published.authority.authorityDigest,
			claimantCallID: 'retry-4.1',
			claimantSessionId: 'parent',
			leaseMs: 60_000,
			createChildSession: () => 'child-4.1',
		});
		if (!claimed.ok) throw new Error(claimed.reason);
		const originalWriteJournal = _internals.writeClaimJournal;
		_internals.writeClaimJournal = () => {
			throw new Error('simulated crash before terminal journal append');
		};
		try {
			expect(() =>
				releaseWorktreeRecoveryClaim(safe.dir, {
					authorityDigest: published.authority.authorityDigest,
					claimantCallID: 'retry-4.1',
					claimRevision: claimed.authority.claim!.claimRevision,
					rawToken: claimed.rawToken,
				}),
			).toThrow('simulated crash');
		} finally {
			_internals.writeClaimJournal = originalWriteJournal;
		}
		expect(replayWorktreeRecoveryClaimJournal(safe.dir)).toContainEqual({
			authorityDigest: published.authority.authorityDigest,
			outcome: 'repaired_terminal_claim',
		});
	});
});
