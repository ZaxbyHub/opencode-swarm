import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	_internals,
	claimWorktreeRecoveryAuthority,
	finalizeWorktreeRecoveryAuthority,
	publishWorktreeRecoveryAuthority,
	releaseWorktreeRecoveryClaim,
	renewWorktreeRecoveryClaim,
	replayWorktreeRecoveryClaimJournal,
	scanWorktreeRecoveryAuthoritiesForRecovery,
} from '../../../src/hooks/delegation-gate/worktree-recovery-authority';
import { createSafeTestDir } from '../../helpers/safe-test-dir';
import { withFrozenClock } from '../../helpers/test-clock';

const OID = (value: string) => value.repeat(40);
const AUTHORITY_LOCK_RELATIVE_PATH = path.join(
	'.swarm',
	'locks',
	'worktree-recovery-authority.lock',
);

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

	test('claim-token fencing rejects a forged token even with the current revision', async () => {
		const safe = createSafeTestDir('worktree-recovery-token-fence-2105-');
		cleanup = safe.cleanup;
		const published = publishWorktreeRecoveryAuthority(
			safe.dir,
			identity('2.2'),
		);
		expect(published.ok).toBe(true);
		if (!published.ok) throw new Error(published.reason);
		const claimed = await claimWorktreeRecoveryAuthority(safe.dir, {
			authorityDigest: published.authority.authorityDigest,
			claimantCallID: 'retry-token',
			claimantSessionId: 'parent',
			leaseMs: 60_000,
			createChildSession: () => 'child-token',
		});
		expect(claimed.ok).toBe(true);
		if (!claimed.ok || !claimed.authority.claim)
			throw new Error('claim failed');

		const forged = releaseWorktreeRecoveryClaim(safe.dir, {
			authorityDigest: published.authority.authorityDigest,
			claimantCallID: 'retry-token',
			claimRevision: claimed.authority.claim.claimRevision,
			rawToken: 'forged-token',
		});
		expect(forged).toMatchObject({ ok: false, code: 'stale_claim' });
		const scan = scanWorktreeRecoveryAuthoritiesForRecovery(safe.dir);
		expect(scan.status).toBe('ok');
		if (scan.status === 'ok')
			expect(scan.authorities[0]?.status).toBe('claimed');
	});

	test('claim renewal appends a durable journal entry', async () => {
		const safe = createSafeTestDir('worktree-recovery-renew-journal-2105-');
		cleanup = safe.cleanup;
		const published = publishWorktreeRecoveryAuthority(
			safe.dir,
			identity('2.3'),
		);
		expect(published.ok).toBe(true);
		if (!published.ok) throw new Error(published.reason);
		const claimed = await claimWorktreeRecoveryAuthority(safe.dir, {
			authorityDigest: published.authority.authorityDigest,
			claimantCallID: 'renew-call',
			claimantSessionId: 'parent',
			leaseMs: 60_000,
			createChildSession: () => 'renew-child',
		});
		expect(claimed.ok).toBe(true);
		if (!claimed.ok) throw new Error(claimed.reason);
		const renewed = renewWorktreeRecoveryClaim(safe.dir, {
			authorityDigest: published.authority.authorityDigest,
			claimantCallID: 'renew-call',
			claimRevision: claimed.authority.claim!.claimRevision,
			rawToken: claimed.rawToken,
			leaseMs: 120_000,
			now: 10_000,
		});
		expect(renewed.ok).toBe(true);
		expect(_internals.readClaimJournal(safe.dir).entries.at(-1)?.state).toBe(
			'CLAIM_RENEWED',
		);
	});

	test('claim re-reads the store after child-session creation before committing', async () => {
		const safe = createSafeTestDir('worktree-recovery-claim-cas-2105-');
		cleanup = safe.cleanup;
		const published = publishWorktreeRecoveryAuthority(
			safe.dir,
			identity('2.4'),
		);
		expect(published.ok).toBe(true);
		if (!published.ok) throw new Error(published.reason);

		await expect(
			claimWorktreeRecoveryAuthority(safe.dir, {
				authorityDigest: published.authority.authorityDigest,
				claimantCallID: 'cas-call',
				claimantSessionId: 'parent',
				leaseMs: 60_000,
				createChildSession: async () => {
					const storePath = _internals.getRecoveryStorePath(safe.dir);
					const store = JSON.parse(fs.readFileSync(storePath, 'utf8')) as {
						authorities: Array<{ immutable: { canonicalPath: string } }>;
					};
					store.authorities[0]!.immutable.canonicalPath += '-changed';
					fs.writeFileSync(storePath, JSON.stringify(store));
					return 'cas-child';
				},
			}),
		).rejects.toThrow(
			'authority changed while child session was being created',
		);
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

	test('acquire and release only clear a lock when the nonce still matches', () => {
		const safe = createSafeTestDir('worktree-recovery-lock-ownership-2105-');
		cleanup = safe.cleanup;
		const lockPath = path.join(safe.dir, AUTHORITY_LOCK_RELATIVE_PATH);

		const release = _internals.acquireAuthorityLock(safe.dir);
		expect(release).toBeDefined();
		expect(fs.existsSync(lockPath)).toBe(true);
		if (!release) throw new Error('expected lock acquisition');
		const original = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as {
			nonce: string;
		};
		fs.writeFileSync(
			lockPath,
			JSON.stringify({ ...original, nonce: 'replacement-nonce' }, null, 2),
		);

		release();

		expect(fs.existsSync(lockPath)).toBe(true);
		expect(JSON.parse(fs.readFileSync(lockPath, 'utf8'))).toMatchObject({
			nonce: 'replacement-nonce',
		});
	});

	test('a stale lock can be reclaimed, but a fresh live lock is left intact', () => {
		withFrozenClock(
			() => {
				const safe = createSafeTestDir('worktree-recovery-lock-stale-2105-');
				cleanup = safe.cleanup;
				const lockPath = path.join(safe.dir, AUTHORITY_LOCK_RELATIVE_PATH);
				fs.mkdirSync(path.dirname(lockPath), { recursive: true });

				fs.writeFileSync(
					lockPath,
					JSON.stringify(
						{
							nonce: 'live-stale-nonce',
							acquiredAt: Date.now() - 20 * 60_000,
							pid: process.pid,
						},
						null,
						2,
					),
				);
				const liveStaleTime = new Date(Date.now() - 20 * 60_000);
				fs.utimesSync(lockPath, liveStaleTime, liveStaleTime);
				expect(_internals.acquireAuthorityLock(safe.dir)).toBeUndefined();
				expect(fs.existsSync(lockPath)).toBe(true);

				fs.writeFileSync(
					lockPath,
					JSON.stringify(
						{
							nonce: 'stale-nonce',
							acquiredAt: Date.now() - 20 * 60_000,
							pid: Number.MAX_SAFE_INTEGER,
						},
						null,
						2,
					),
				);
				const staleTime = new Date(Date.now() - 20 * 60_000);
				fs.utimesSync(lockPath, staleTime, staleTime);

				const reacquired = _internals.acquireAuthorityLock(safe.dir);
				expect(reacquired).toBeDefined();
				expect(fs.existsSync(lockPath)).toBe(true);
				reacquired?.();
				expect(fs.existsSync(lockPath)).toBe(false);

				fs.writeFileSync(
					lockPath,
					JSON.stringify(
						{
							nonce: 'live-nonce',
							acquiredAt: Date.now(),
							pid: process.pid,
						},
						null,
						2,
					),
				);
				const fresh = _internals.acquireAuthorityLock(safe.dir);
				expect(fresh).toBeUndefined();
				expect(fs.existsSync(lockPath)).toBe(true);
			},
			{ fixedNow: 2_000_000 },
		);
	});
});
