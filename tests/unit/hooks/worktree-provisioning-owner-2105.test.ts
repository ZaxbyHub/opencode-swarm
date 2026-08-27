import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	_internals,
	recordWorktreeProvisioningOwner,
	removeWorktreeProvisioningOwner,
	scanWorktreeProvisioningLifecycleJournalForRecovery,
	scanWorktreeProvisioningOwnersForRecovery,
} from '../../../src/hooks/delegation-gate/worktree-provisioning-owner';
import { createSafeTestDir } from '../../helpers/safe-test-dir';

type Fixture = ReturnType<typeof createSafeTestDir>;

describe('issue #2105 worktree provisioning owner v3 journal', () => {
	let fixture: Fixture;
	let directory: string;

	beforeEach(() => {
		fixture = createSafeTestDir('worktree-owner-2105-');
		directory = fixture.dir;
	});

	afterEach(() => {
		fixture.cleanup();
	});

	test('records exact v3 reservation identity and journals publish/remove transitions', () => {
		const owner = recordWorktreeProvisioningOwner(directory, {
			callID: 'call-v3',
			parentSessionId: 'parent-1',
			worktreeSessionId: 'child-1',
			taskId: '2.1',
			reservationId: 'reservation-1',
			generation: 4,
			branchName: 'swarm/lane/child-1/2.1',
		});
		expect(owner).toMatchObject({
			schemaVersion: 3,
			callID: 'call-v3',
			taskId: '2.1',
			reservationId: 'reservation-1',
			generation: 4,
			branchName: 'swarm/lane/child-1/2.1',
		});

		const owners = scanWorktreeProvisioningOwnersForRecovery(directory);
		expect(owners.status).toBe('ok');
		if (owners.status !== 'ok') throw new Error(owners.reason);
		expect(owners.owners).toHaveLength(1);
		expect(owners.owners[0]).toMatchObject({
			schemaVersion: 3,
			callID: 'call-v3',
			taskId: '2.1',
			reservationId: 'reservation-1',
			generation: 4,
			branchName: 'swarm/lane/child-1/2.1',
		});

		const published =
			scanWorktreeProvisioningLifecycleJournalForRecovery(directory);
		expect(published.status).toBe('ok');
		if (published.status !== 'ok') throw new Error(published.reason);
		expect(published.entries.map((entry) => entry.state)).toEqual([
			'OWNER_PUBLISHED',
		]);
		expect(published.entries[0]).toMatchObject({
			callID: 'call-v3',
			taskId: '2.1',
			reservationId: 'reservation-1',
			generation: 4,
			branchName: 'swarm/lane/child-1/2.1',
		});

		expect(
			removeWorktreeProvisioningOwner(directory, 'call-v3', {
				reservationId: 'reservation-1',
				generation: 4,
				branchName: 'swarm/lane/child-1/2.1',
			}),
		).toBe(true);
		expect(scanWorktreeProvisioningOwnersForRecovery(directory)).toEqual({
			status: 'ok',
			owners: [],
		});

		const journal =
			scanWorktreeProvisioningLifecycleJournalForRecovery(directory);
		expect(journal.status).toBe('ok');
		if (journal.status !== 'ok') throw new Error(journal.reason);
		expect(journal.entries.map((entry) => entry.state)).toEqual([
			'OWNER_PUBLISHED',
			'OWNER_REMOVED',
		]);
		expect(journal.entries[1]).toMatchObject({
			callID: 'call-v3',
			taskId: '2.1',
			reservationId: 'reservation-1',
			generation: 4,
			branchName: 'swarm/lane/child-1/2.1',
		});
	});

	test('rejects partial v3 identity so reservation-aware markers are never ambiguous', () => {
		expect(() =>
			recordWorktreeProvisioningOwner(directory, {
				callID: 'call-bad',
				parentSessionId: 'parent-1',
				worktreeSessionId: 'child-1',
				taskId: '2.1',
				reservationId: 'reservation-1',
			}),
		).toThrow(
			'worktree provisioning owner v3 requires taskId, reservationId, generation, and branchName',
		);
	});

	test('fails closed when the lifecycle journal is malformed', () => {
		const journalPath = _internals.getJournalPath(directory);
		fs.mkdirSync(path.dirname(journalPath), { recursive: true });
		fs.writeFileSync(journalPath, '{broken', 'utf8');

		expect(
			scanWorktreeProvisioningLifecycleJournalForRecovery(directory),
		).toEqual({
			status: 'uncertain',
			reason: expect.stringContaining(
				'worktree-provisioning-lifecycle.json is unreadable or malformed',
			),
		});
	});
});
