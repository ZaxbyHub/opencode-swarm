import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	_internals,
	claimWorktreeRecoveryAuthority,
	finalizeWorktreeRecoveryAuthority,
	lookupWorktreeRecoveryAuthoritiesByTask,
	publishWorktreeRecoveryAuthority,
	releaseWorktreeRecoveryClaim,
	renewWorktreeRecoveryClaim,
	replayWorktreeRecoveryClaimJournal,
	scanWorktreeRecoveryAuthoritiesForRecovery,
} from '../../../src/hooks/delegation-gate/worktree-recovery-authority';
import { createSafeTestDir } from '../../helpers/safe-test-dir';

type Fixture = ReturnType<typeof createSafeTestDir>;

const BASE_AUTHORITY = {
	originalCallID: 'call-A',
	parentSessionId: 'parent-1',
	taskId: '2.1',
	reservationId: 'reservation-1',
	generation: 7,
	canonicalBranch: 'swarm/task-2-1',
	canonicalPath: 'C:/repo/.swarm-worktrees/task-2-1',
	laneBranch: 'lane/task-2-1',
	lanePath: 'C:/repo/.swarm-worktrees/task-2-1',
	expectedPrimaryHead: 'a'.repeat(40),
	sourceBaseOid: 'b'.repeat(40),
	sourceHeadOid: 'c'.repeat(40),
	targetHeadOid: 'd'.repeat(40),
	strategy: 'merge' as const,
	declaredConflictFiles: ['src/conflict.ts'],
};

function readJson(file: string): unknown {
	return JSON.parse(fs.readFileSync(file, 'utf8'));
}

describe('issue #2105 worktree recovery authority store', () => {
	let fixture: Fixture;
	let directory: string;

	beforeEach(() => {
		fixture = createSafeTestDir('worktree-recovery-2105-');
		directory = fixture.dir;
		_internals.resetForTest();
	});

	afterEach(() => {
		_internals.resetForTest();
		fixture.cleanup();
	});

	test('publishes v2 authority, writes an atomic session-bound credential on claim, and preserves the legacy projection bytes', async () => {
		const projectionPath = path.join(
			directory,
			'.swarm',
			'worktree-merge-status.json',
		);
		fs.mkdirSync(path.dirname(projectionPath), { recursive: true });
		fs.writeFileSync(
			projectionPath,
			JSON.stringify({ legacy: { outcome: 'failed' } }),
			'utf8',
		);
		const projectionBefore = fs.readFileSync(projectionPath, 'utf8');

		const published = publishWorktreeRecoveryAuthority(
			directory,
			BASE_AUTHORITY,
		);
		expect(published.ok).toBe(true);
		if (!published.ok) throw new Error(published.code);

		const claimed = await claimWorktreeRecoveryAuthority(directory, {
			authorityDigest: published.authority.authorityDigest,
			claimantCallID: 'call-B',
			claimantSessionId: 'session-B',
			now: 1_000,
			leaseMs: 500,
			createChildSession: () => 'child-B',
		});
		expect(claimed.ok).toBe(true);
		if (!claimed.ok) throw new Error(claimed.code);
		expect(claimed.rawToken.length).toBeGreaterThanOrEqual(32);

		const store = readJson(_internals.getRecoveryStorePath(directory)) as {
			authorities: Array<{ claim?: { claimTokenDigest: string } }>;
		};
		expect(store.authorities).toHaveLength(1);
		expect(JSON.stringify(store)).not.toContain(claimed.rawToken);
		expect(store.authorities[0]?.claim?.claimTokenDigest).toBe(
			claimed.authority.claim?.claimTokenDigest,
		);

		const credential = readJson(claimed.credentialPath) as {
			childSessionId: string;
			rawToken: string;
			claimRevision: number;
		};
		expect(credential.childSessionId).toBe('child-B');
		expect(credential.rawToken).toBe(claimed.rawToken);
		expect(credential.claimRevision).toBe(1);
		expect(fs.readFileSync(projectionPath, 'utf8')).toBe(projectionBefore);
	});

	test('blocks a concurrent C claim while B still holds a live lease', async () => {
		const published = publishWorktreeRecoveryAuthority(
			directory,
			BASE_AUTHORITY,
		);
		expect(published.ok).toBe(true);
		if (!published.ok) throw new Error(published.code);
		expect(
			(
				await claimWorktreeRecoveryAuthority(directory, {
					authorityDigest: published.authority.authorityDigest,
					claimantCallID: 'call-B',
					claimantSessionId: 'session-B',
					now: 1_000,
					leaseMs: 1_000,
					createChildSession: () => 'child-B',
				})
			).ok,
		).toBe(true);

		const second = await claimWorktreeRecoveryAuthority(directory, {
			authorityDigest: published.authority.authorityDigest,
			claimantCallID: 'call-C',
			claimantSessionId: 'session-C',
			now: 1_100,
			leaseMs: 1_000,
			createChildSession: () => 'child-C',
		});
		expect(second).toMatchObject({ ok: false, code: 'busy' });
	});

	test('expired B can be reclaimed only after full revalidation and late B mutations are fenced stale', async () => {
		const published = publishWorktreeRecoveryAuthority(
			directory,
			BASE_AUTHORITY,
		);
		expect(published.ok).toBe(true);
		if (!published.ok) throw new Error(published.code);
		const b = await claimWorktreeRecoveryAuthority(directory, {
			authorityDigest: published.authority.authorityDigest,
			claimantCallID: 'call-B',
			claimantSessionId: 'session-B',
			now: 1_000,
			leaseMs: 50,
			createChildSession: () => 'child-B',
		});
		expect(b.ok).toBe(true);
		if (!b.ok) throw new Error(b.code);

		let revalidated = 0;
		const c = await claimWorktreeRecoveryAuthority(directory, {
			authorityDigest: published.authority.authorityDigest,
			claimantCallID: 'call-C',
			claimantSessionId: 'session-C',
			now: 1_100,
			leaseMs: 75,
			createChildSession: () => 'child-C',
			revalidateExpiredClaim: ({ previousClaim, authority }) => {
				revalidated += 1;
				expect(previousClaim.claimantCallID).toBe('call-B');
				expect(authority.immutable.taskId).toBe('2.1');
				return { ok: true };
			},
		});
		expect(c.ok).toBe(true);
		if (!c.ok) throw new Error(c.code);
		expect(revalidated).toBe(1);
		expect(c.authority.claim?.claimRevision).toBe(2);
		expect(c.authority.claim?.attempt).toBe(2);

		const staleRenew = renewWorktreeRecoveryClaim(directory, {
			authorityDigest: published.authority.authorityDigest,
			claimantCallID: 'call-B',
			claimRevision: 1,
			rawToken: b.rawToken,
			now: 1_120,
			leaseMs: 100,
		});
		expect(staleRenew).toMatchObject({ ok: false, code: 'stale_claim' });

		const staleRelease = releaseWorktreeRecoveryClaim(directory, {
			authorityDigest: published.authority.authorityDigest,
			claimantCallID: 'call-B',
			claimRevision: 1,
			rawToken: b.rawToken,
			now: 1_130,
		});
		expect(staleRelease).toMatchObject({ ok: false, code: 'stale_claim' });

		const staleFinalize = finalizeWorktreeRecoveryAuthority(directory, {
			authorityDigest: published.authority.authorityDigest,
			claimantCallID: 'call-B',
			claimRevision: 1,
			rawToken: b.rawToken,
			now: 1_140,
		});
		expect(staleFinalize).toMatchObject({ ok: false, code: 'stale_claim' });
	});

	test('enforces the durable retry cap', async () => {
		const published = publishWorktreeRecoveryAuthority(directory, {
			...BASE_AUTHORITY,
			generation: 8,
			taskId: '2.2',
		});
		expect(published.ok).toBe(true);
		if (!published.ok) throw new Error(published.code);
		const b = await claimWorktreeRecoveryAuthority(directory, {
			authorityDigest: published.authority.authorityDigest,
			claimantCallID: 'call-B',
			claimantSessionId: 'session-B',
			now: 10,
			leaseMs: 5,
			maxAttempts: 1,
			createChildSession: () => 'child-B',
		});
		expect(b.ok).toBe(true);

		const c = await claimWorktreeRecoveryAuthority(directory, {
			authorityDigest: published.authority.authorityDigest,
			claimantCallID: 'call-C',
			claimantSessionId: 'session-C',
			now: 20,
			leaseMs: 5,
			maxAttempts: 1,
			createChildSession: () => 'child-C',
			revalidateExpiredClaim: () => ({ ok: true }),
		});
		expect(c).toMatchObject({ ok: false, code: 'retry_cap_exceeded' });
	});

	test('replays a PREPARED child-created credential-failed crash to ABORTED and cleans the child once', async () => {
		const published = publishWorktreeRecoveryAuthority(directory, {
			...BASE_AUTHORITY,
			generation: 9,
			taskId: '2.3',
		});
		expect(published.ok).toBe(true);
		if (!published.ok) throw new Error(published.code);

		const realWriteCredential = _internals.writeCredentialFile;
		_internals.writeCredentialFile = () => {
			throw new Error('simulated credential failure');
		};
		await expect(
			claimWorktreeRecoveryAuthority(directory, {
				authorityDigest: published.authority.authorityDigest,
				claimantCallID: 'call-B',
				claimantSessionId: 'session-B',
				now: 1_000,
				leaseMs: 100,
				createChildSession: () => 'child-B',
			}),
		).rejects.toThrow('simulated credential failure');
		_internals.writeCredentialFile = realWriteCredential;

		const journalBefore = _internals.readClaimJournal(directory);
		expect(journalBefore.entries.at(-1)?.state).toBe('PREPARED');
		expect(journalBefore.entries.at(-1)?.childSessionId).toBe('child-B');

		const cleanedChildren: string[] = [];
		const replay = replayWorktreeRecoveryClaimJournal(directory, {
			onAbortPreparedClaim: ({ childSessionId }) => {
				if (childSessionId) cleanedChildren.push(childSessionId);
			},
		});
		expect(replay).toHaveLength(1);
		expect(replay[0]?.outcome).toBe('aborted_prepared_claim');
		expect(cleanedChildren).toEqual(['child-B']);
		expect(_internals.readClaimJournal(directory).entries.at(-1)?.state).toBe(
			'ABORTED',
		);
	});

	test('replays a credential-installed commit-failed crash by removing only the uncommitted credential and aborting the prepared claim', async () => {
		const published = publishWorktreeRecoveryAuthority(directory, {
			...BASE_AUTHORITY,
			generation: 10,
			taskId: '2.4',
		});
		expect(published.ok).toBe(true);
		if (!published.ok) throw new Error(published.code);

		const realWriteStore = _internals.writeRecoveryStore;
		_internals.writeRecoveryStore = (target, store, phase) => {
			if (phase === 'claim-commit') {
				throw new Error('simulated commit failure');
			}
			return realWriteStore(target, store, phase);
		};
		await expect(
			claimWorktreeRecoveryAuthority(directory, {
				authorityDigest: published.authority.authorityDigest,
				claimantCallID: 'call-B',
				claimantSessionId: 'session-B',
				now: 2_000,
				leaseMs: 100,
				createChildSession: () => 'child-B',
			}),
		).rejects.toThrow('simulated commit failure');
		_internals.writeRecoveryStore = realWriteStore;

		const journal = _internals.readClaimJournal(directory);
		expect(journal.entries.at(-1)?.state).toBe('PREPARED');
		expect(journal.entries.at(-1)?.credentialInstalledAt).toBeDefined();
		const credentialPath = _internals.getCredentialPath(
			directory,
			published.authority.authorityDigest,
		);
		expect(fs.existsSync(credentialPath)).toBe(true);

		const replay = replayWorktreeRecoveryClaimJournal(directory);
		expect(replay[0]?.outcome).toBe('removed_uncommitted_credential');
		expect(fs.existsSync(credentialPath)).toBe(false);
		expect(_internals.readClaimJournal(directory).entries.at(-1)?.state).toBe(
			'ABORTED',
		);
	});

	test('rebuilds task lookup from authoritative records even when the persisted index is stale', () => {
		const first = publishWorktreeRecoveryAuthority(directory, {
			...BASE_AUTHORITY,
			generation: 11,
			taskId: '2.5',
		});
		const second = publishWorktreeRecoveryAuthority(directory, {
			...BASE_AUTHORITY,
			originalCallID: 'call-A2',
			reservationId: 'reservation-2',
			generation: 12,
			taskId: '2.5',
		});
		expect(first.ok && second.ok).toBe(true);
		if (!first.ok || !second.ok) throw new Error('publish failed');

		const storePath = _internals.getRecoveryStorePath(directory);
		const store = readJson(storePath) as {
			schemaVersion: number;
			authorities: unknown[];
			index: { bySessionTask: Record<string, string[]> };
		};
		store.index.bySessionTask['parent-1::2.5'] = ['bogus-digest'];
		fs.writeFileSync(storePath, JSON.stringify(store, null, 2), 'utf8');

		const lookedUp = lookupWorktreeRecoveryAuthoritiesByTask(directory, {
			parentSessionId: 'parent-1',
			taskId: '2.5',
		});
		expect(lookedUp.status).toBe('ok');
		if (lookedUp.status !== 'ok') throw new Error(lookedUp.reason);
		expect(
			lookedUp.authorities.map((entry) => entry.immutable.generation),
		).toEqual([12, 11]);
	});

	test('scans fail closed for legacy, future, malformed, and over-cap stores while ignoring the legacy projection file', () => {
		const cases = [
			{
				label: 'legacy',
				payload: {
					schemaVersion: 1,
					authorities: [],
					index: { bySessionTask: {} },
				},
				expectStatus: 'unsupported-legacy',
			},
			{
				label: 'future',
				payload: {
					schemaVersion: 3,
					authorities: [],
					index: { bySessionTask: {} },
				},
				expectStatus: 'uncertain',
			},
			{ label: 'malformed', raw: '{', expectStatus: 'uncertain' },
			{
				label: 'over-cap',
				payload: {
					schemaVersion: 2,
					authorities: Array.from({ length: 513 }, (_, index) => ({
						schemaVersion: 2,
						authorityDigest: `digest-${index}`,
						immutable: {
							...BASE_AUTHORITY,
							originalCallID: `call-${index}`,
							reservationId: `reservation-${index}`,
							taskId: `task-${index}`,
							generation: index + 1,
						},
						status: 'preserved',
					})),
					index: { bySessionTask: {} },
				},
				expectStatus: 'uncertain',
			},
		] as const;

		for (const scenario of cases) {
			const storePath = _internals.getRecoveryStorePath(directory);
			fs.mkdirSync(path.dirname(storePath), { recursive: true });
			if ('raw' in scenario) {
				fs.writeFileSync(storePath, scenario.raw, 'utf8');
			} else {
				fs.writeFileSync(storePath, JSON.stringify(scenario.payload), 'utf8');
			}
			fs.writeFileSync(
				path.join(directory, '.swarm', 'worktree-merge-status.json'),
				JSON.stringify({ unrelated: true }),
				'utf8',
			);
			expect(scanWorktreeRecoveryAuthoritiesForRecovery(directory).status).toBe(
				scenario.expectStatus,
			);
		}
	});

	test('exact renew, release, and finalize mutate only the current matching claim', async () => {
		const published = publishWorktreeRecoveryAuthority(directory, {
			...BASE_AUTHORITY,
			generation: 13,
			taskId: '2.6',
		});
		expect(published.ok).toBe(true);
		if (!published.ok) throw new Error(published.code);
		const claim = await claimWorktreeRecoveryAuthority(directory, {
			authorityDigest: published.authority.authorityDigest,
			claimantCallID: 'call-B',
			claimantSessionId: 'session-B',
			now: 4_000,
			leaseMs: 10,
			createChildSession: () => 'child-B',
		});
		expect(claim.ok).toBe(true);
		if (!claim.ok) throw new Error(claim.code);

		const renewed = renewWorktreeRecoveryClaim(directory, {
			authorityDigest: published.authority.authorityDigest,
			claimantCallID: 'call-B',
			claimRevision: 1,
			rawToken: claim.rawToken,
			now: 4_005,
			leaseMs: 25,
		});
		expect(renewed.ok).toBe(true);
		if (!renewed.ok) throw new Error(renewed.code);
		expect(renewed.authority.claim?.leaseExpiresAt).toBe(4_030);

		const released = releaseWorktreeRecoveryClaim(directory, {
			authorityDigest: published.authority.authorityDigest,
			claimantCallID: 'call-B',
			claimRevision: 1,
			rawToken: claim.rawToken,
			now: 4_010,
		});
		expect(released.ok).toBe(true);
		if (!released.ok) throw new Error(released.code);
		expect(released.authority.claim).toBeUndefined();

		const second = await claimWorktreeRecoveryAuthority(directory, {
			authorityDigest: published.authority.authorityDigest,
			claimantCallID: 'call-C',
			claimantSessionId: 'session-C',
			now: 4_020,
			leaseMs: 10,
			createChildSession: () => 'child-C',
		});
		expect(second.ok).toBe(true);
		if (!second.ok) throw new Error(second.code);

		const finalized = finalizeWorktreeRecoveryAuthority(directory, {
			authorityDigest: published.authority.authorityDigest,
			claimantCallID: 'call-C',
			claimRevision: 2,
			rawToken: second.rawToken,
			now: 4_030,
		});
		expect(finalized.ok).toBe(true);
		if (!finalized.ok) throw new Error(finalized.code);
		expect(finalized.authority.status).toBe('finalized');
		expect(finalized.authority.claim).toBeUndefined();
		expect(
			fs.existsSync(
				_internals.getCredentialPath(
					directory,
					published.authority.authorityDigest,
				),
			),
		).toBe(false);
	});
});
