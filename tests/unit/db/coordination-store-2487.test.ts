import { afterEach, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import {
	acquireCoordinationLease,
	getCoordinationLease,
	getCoordinationState,
	importCoordinationOnce,
	transitionCoordinationState,
} from '../../../src/db/coordination-store';
import { closeProjectDb, getProjectDb } from '../../../src/db/project-db';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const roots: string[] = [];

afterEach(() => {
	while (roots.length > 0) {
		const root = roots.pop()!;
		closeProjectDb(root);
		rmSync(root, { recursive: true, force: true });
	}
});

test('issue #2487 coordination production APIs persist every coordination table family', () => {
	const directory = canonicalMkdtemp('coordination-2487-');
	roots.push(directory);
	const transition = transitionCoordinationState(directory, {
		namespace: 'issue-2487',
		entityKey: 'state',
		expectedRevision: null,
		generation: 1,
		status: 'qualified',
		payload: '{}',
		event: {
			streamId: 'issue-2487-stream',
			idempotencyKey: 'issue-2487-key',
			eventType: 'qualified',
			payload: '{}',
		},
	});
	expect(transition.outcome).toBe('applied');
	expect(
		acquireCoordinationLease(directory, {
			namespace: 'issue-2487',
			entityKey: 'lease',
			generation: 1,
			ownerToken: 'issue-2487-owner',
			leaseExpiresAt: '2030-01-01T00:00:00.000Z',
			payload: '{}',
		}),
	).toEqual({ outcome: 'acquired' });
	expect(
		importCoordinationOnce(
			directory,
			{
				source: 'issue-2487-legacy',
				sourceDigest: 'issue-2487-digest',
				rowCount: 0,
				emptyNamespace: 'issue-2487-import',
			},
			() => {},
		),
	).toBe('imported');
	expect(getCoordinationState(directory, 'issue-2487', 'state')?.status).toBe(
		'qualified',
	);
	expect(
		getCoordinationLease(directory, 'issue-2487', 'lease')?.ownerToken,
	).toBe('issue-2487-owner');
	const tables = getProjectDb(directory)
		.query<{ name: string }, []>(
			"SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'coordination_%' ORDER BY name",
		)
		.all()
		.map((row) => row.name);
	expect(tables).toEqual([
		'coordination_event',
		'coordination_event_fence',
		'coordination_import',
		'coordination_lease',
		'coordination_state',
	]);
});
