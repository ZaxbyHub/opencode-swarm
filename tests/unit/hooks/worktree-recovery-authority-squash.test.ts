import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import {
	_internals,
	publishWorktreeRecoveryAuthority,
	removeWorktreeRecoveryAuthority,
	scanWorktreeRecoveryAuthoritiesForRecovery,
} from '../../../src/hooks/delegation-gate/worktree-recovery-authority';
import { createSafeTestDir } from '../../helpers/safe-test-dir';

const BASE_AUTHORITY = {
	originalCallID: 'call-squash',
	parentSessionId: 'parent-squash',
	taskId: '2.8',
	reservationId: 'reservation-squash',
	generation: 1,
	canonicalBranch: 'swarm/task-2-8',
	canonicalPath: 'C:/repo/.swarm-worktrees/task-2-8',
	laneBranch: 'lane/task-2-8',
	lanePath: 'C:/repo/.swarm-worktrees/task-2-8',
	expectedPrimaryHead: 'a'.repeat(40),
	sourceBaseOid: 'b'.repeat(40),
	sourceHeadOid: 'c'.repeat(40),
	targetHeadOid: 'd'.repeat(40),
	strategy: 'squash' as const,
};

type RecoveryInput = Parameters<typeof publishWorktreeRecoveryAuthority>[1];

function publishWith(
	directory: string,
	overrides: Record<string, unknown> = {},
) {
	return publishWorktreeRecoveryAuthority(directory, {
		...BASE_AUTHORITY,
		...overrides,
	} as RecoveryInput);
}

describe('squash recovery authority provenance validation', () => {
	let fixture: ReturnType<typeof createSafeTestDir>;

	beforeEach(() => {
		fixture = createSafeTestDir('worktree-recovery-squash-');
	});

	afterEach(() => {
		fixture.cleanup();
	});

	test('requires a bounded result tree and changed-path set', () => {
		const cases = [
			['missing result tree', { changedPaths: ['result.txt'] }],
			['missing changed paths', { resultTree: 'e'.repeat(40) }],
			['malformed result tree', { resultTree: 'not-an-oid', changedPaths: [] }],
			[
				'NUL-containing path',
				{ resultTree: 'e'.repeat(40), changedPaths: ['bad\0path'] },
			],
			[
				'overlong path',
				{ resultTree: 'e'.repeat(40), changedPaths: ['x'.repeat(4097)] },
			],
			[
				'over-cap path array',
				{ resultTree: 'e'.repeat(40), changedPaths: Array(50_001).fill('x') },
			],
		] as const;

		for (const [label, overrides] of cases) {
			const result = publishWith(fixture.dir, {
				...overrides,
				reservationId: `reservation-${label.replaceAll(' ', '-')}`,
				taskId: `2.${label.length}`,
				generation: label.length,
			});
			expect(result, label).toMatchObject({
				ok: false,
				code: 'uncertain_store',
			});
		}
	});

	test('accepts 64-hex result trees and an empty changed-path set', () => {
		const result = publishWith(fixture.dir, {
			resultTree: 'e'.repeat(64),
			changedPaths: [],
		});
		expect(result).toMatchObject({ ok: true });
	});

	test('rejects persisted identity tampering before retained squash cleanup', () => {
		const published = publishWith(fixture.dir, {
			resultTree: 'e'.repeat(40),
			changedPaths: ['result.txt'],
		});
		expect(published).toMatchObject({ ok: true });
		if (!published.ok) throw new Error(published.code);

		const storePath = _internals.getRecoveryStorePath(fixture.dir);
		const store = JSON.parse(fs.readFileSync(storePath, 'utf8')) as {
			authorities: Array<{
				immutable: { laneBranch: string };
			}>;
		};
		store.authorities[0]!.immutable.laneBranch = 'lane/tampered';
		fs.writeFileSync(storePath, JSON.stringify(store), 'utf8');

		expect(
			scanWorktreeRecoveryAuthoritiesForRecovery(fixture.dir),
		).toMatchObject({
			status: 'uncertain',
		});

		let branchPresent = true;
		let deleteCalls = 0;
		const removed = removeWorktreeRecoveryAuthority(fixture.dir, {
			authorityDigest: published.authority.authorityDigest,
			branchName: 'lane/tampered',
			branchTipSha: 'f'.repeat(40),
			readBranchTip: () => (branchPresent ? 'f'.repeat(40) : undefined),
			deleteBranchIfTip: () => {
				deleteCalls += 1;
				branchPresent = false;
				return true;
			},
		});
		expect(removed.ok).toBe(false);
		expect(deleteCalls).toBe(0);
	});

	test('rejects persisted squash provenance tampering', () => {
		const published = publishWith(fixture.dir, {
			resultTree: 'e'.repeat(40),
			changedPaths: ['result.txt'],
		});
		expect(published).toMatchObject({ ok: true });
		if (!published.ok) throw new Error(published.code);

		const storePath = _internals.getRecoveryStorePath(fixture.dir);
		const store = JSON.parse(fs.readFileSync(storePath, 'utf8')) as {
			authorities: Array<{
				immutable: { resultTree?: string; changedPaths?: string[] };
			}>;
		};
		store.authorities[0]!.immutable.resultTree = 'f'.repeat(40);
		store.authorities[0]!.immutable.changedPaths = ['tampered.txt'];
		fs.writeFileSync(storePath, JSON.stringify(store), 'utf8');

		expect(
			scanWorktreeRecoveryAuthoritiesForRecovery(fixture.dir),
		).toMatchObject({ status: 'uncertain' });
	});
});
