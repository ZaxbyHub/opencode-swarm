import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import { canonicalMkdtemp } from '../../tests/helpers/tmpdir.js';
import {
	_internals,
	acquireCoordinationLease,
	getCoordinationState,
	releaseCoordinationLease,
	transitionCoordinationState,
	withCoordinationTransaction,
} from './coordination-store.js';
import { closeAllProjectDbs, getProjectDb } from './project-db.js';

let tempDir: string;

beforeEach(() => {
	tempDir = canonicalMkdtemp('coordination-store-test-');
});

afterEach(() => {
	_internals.coordinationFaultInjector = undefined;
	_internals.maxEventsPerStream = 2_048;
	_internals.maxTotalEvents = 100_000;
	closeAllProjectDbs();
	fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('coordination store', () => {
	test('atomically appends an event and advances revisioned state', () => {
		const created = transitionCoordinationState(tempDir, {
			namespace: 'session',
			entityKey: 'session-a',
			expectedRevision: null,
			generation: 1,
			status: 'active',
			payload: JSON.stringify({ value: 1 }),
			event: {
				streamId: 'session:session-a',
				idempotencyKey: 'create-1',
				eventType: 'created',
				payload: '{}',
			},
		});
		expect(created.outcome).toBe('applied');
		expect(created.state?.revision).toBe(1);

		const updated = transitionCoordinationState(tempDir, {
			namespace: 'session',
			entityKey: 'session-a',
			expectedRevision: 1,
			generation: 1,
			status: 'active',
			payload: JSON.stringify({ value: 2 }),
			event: {
				streamId: 'session:session-a',
				idempotencyKey: 'update-1',
				eventType: 'updated',
				payload: '{}',
			},
		});
		expect(updated.outcome).toBe('applied');
		expect(updated.state?.revision).toBe(2);
		expect(
			JSON.parse(
				getCoordinationState(tempDir, 'session', 'session-a')!.payload,
			),
		).toEqual({ value: 2 });
	});

	test('returns duplicate without advancing state for a replayed idempotency key', () => {
		const input = {
			namespace: 'delegation',
			entityKey: 'corr-1',
			expectedRevision: null,
			generation: 2,
			status: 'pending',
			payload: '{}',
			event: {
				streamId: 'delegation:corr-1',
				idempotencyKey: 'dispatch-1',
				eventType: 'dispatched',
				payload: '{}',
			},
		} as const;
		expect(transitionCoordinationState(tempDir, input).outcome).toBe('applied');
		expect(transitionCoordinationState(tempDir, input).outcome).toBe(
			'duplicate',
		);
		expect(
			getCoordinationState(tempDir, 'delegation', 'corr-1')?.revision,
		).toBe(1);
	});

	test('rejects idempotency-key reuse with different event content', () => {
		const base = {
			namespace: 'delegation',
			entityKey: 'corr-conflict',
			generation: 1,
			status: 'pending',
			payload: '{}',
			event: {
				streamId: 'delegation:corr-conflict',
				idempotencyKey: 'dispatch-1',
				eventType: 'dispatched',
				payload: '{}',
				expectedStreamVersion: 0,
			},
		} as const;
		expect(
			transitionCoordinationState(tempDir, { ...base, expectedRevision: null })
				.outcome,
		).toBe('applied');
		expect(
			transitionCoordinationState(tempDir, {
				...base,
				expectedRevision: 1,
				event: { ...base.event, payload: '{"different":true}' },
			}).outcome,
		).toBe('idempotency_conflict');
		expect(
			getCoordinationState(tempDir, 'delegation', 'corr-conflict')?.revision,
		).toBe(1);
	});

	test('enforces an explicit append stream-version fence', () => {
		const first = transitionCoordinationState(tempDir, {
			namespace: 'workflow',
			entityKey: 'versioned',
			expectedRevision: null,
			generation: 1,
			status: 'active',
			payload: '{}',
			event: {
				streamId: 'workflow:versioned',
				idempotencyKey: 'event-1',
				eventType: 'advanced',
				payload: '{}',
				expectedStreamVersion: 0,
			},
		});
		expect(first.outcome).toBe('applied');
		const stale = transitionCoordinationState(tempDir, {
			namespace: 'workflow',
			entityKey: 'versioned',
			expectedRevision: 1,
			generation: 1,
			status: 'active',
			payload: '{}',
			event: {
				streamId: 'workflow:versioned',
				idempotencyKey: 'event-2',
				eventType: 'advanced',
				payload: '{}',
				expectedStreamVersion: 0,
			},
		});
		expect(stale.outcome).toBe('stream_version_conflict');
		expect(
			getCoordinationState(tempDir, 'workflow', 'versioned')?.revision,
		).toBe(1);
	});

	test('bounds retained event history without dropping current state', () => {
		_internals.maxEventsPerStream = 2;
		for (let index = 0; index < 3; index += 1) {
			const result = transitionCoordinationState(tempDir, {
				namespace: 'bounded',
				entityKey: 'one',
				expectedRevision: index === 0 ? null : index,
				generation: 1,
				status: 'active',
				payload: JSON.stringify({ index }),
				event: {
					streamId: 'bounded:one',
					idempotencyKey: `event-${index}`,
					eventType: 'advanced',
					payload: JSON.stringify({ index }),
					expectedStreamVersion: index,
				},
			});
			expect(result.outcome).toBe('applied');
		}
		const versions = getProjectDb(tempDir)
			.query<{ version: number }, []>(
				"SELECT version FROM coordination_event WHERE stream_id = 'bounded:one' ORDER BY version",
			)
			.all()
			.map((row) => row.version);
		expect(versions).toEqual([2, 3]);
		expect(getCoordinationState(tempDir, 'bounded', 'one')?.revision).toBe(3);
	});

	test('fails a pruned event replay at its state revision fence', () => {
		_internals.maxEventsPerStream = 2;
		for (let index = 0; index < 3; index += 1) {
			expect(
				transitionCoordinationState(tempDir, {
					namespace: 'bounded',
					entityKey: 'replay',
					expectedRevision: index === 0 ? null : index,
					generation: 1,
					status: 'active',
					payload: JSON.stringify({ index }),
					event: {
						streamId: 'bounded:replay',
						idempotencyKey: `event-${index}`,
						eventType: 'advanced',
						payload: JSON.stringify({ index }),
					},
				}),
			).toMatchObject({ outcome: 'applied' });
		}

		expect(
			transitionCoordinationState(tempDir, {
				namespace: 'bounded',
				entityKey: 'replay',
				expectedRevision: null,
				generation: 1,
				status: 'active',
				payload: '{"index":0}',
				event: {
					streamId: 'bounded:replay',
					idempotencyKey: 'event-0',
					eventType: 'advanced',
					payload: '{"index":0}',
				},
			}),
		).toMatchObject({ outcome: 'revision_conflict' });
		expect(getCoordinationState(tempDir, 'bounded', 'replay')?.revision).toBe(
			3,
		);
	});

	test('requires a state revision fence for an event-bearing transition', () => {
		expect(() =>
			transitionCoordinationState(tempDir, {
				namespace: 'bounded',
				entityKey: 'missing-fence',
				generation: 1,
				status: 'active',
				payload: '{}',
				event: {
					streamId: 'bounded:missing-fence',
					idempotencyKey: 'event-1',
					eventType: 'advanced',
					payload: '{}',
				},
			}),
		).toThrow(/require expectedRevision/i);
	});

	test('fences stale generations and revision conflicts', () => {
		transitionCoordinationState(tempDir, {
			namespace: 'scope',
			entityKey: 'binding',
			expectedRevision: null,
			generation: 4,
			status: 'active',
			payload: '{}',
		});
		expect(
			transitionCoordinationState(tempDir, {
				namespace: 'scope',
				entityKey: 'binding',
				expectedRevision: 1,
				generation: 3,
				status: 'active',
				payload: '{}',
			}).outcome,
		).toBe('stale_generation');
		expect(
			transitionCoordinationState(tempDir, {
				namespace: 'scope',
				entityKey: 'binding',
				expectedRevision: 0,
				generation: 4,
				status: 'active',
				payload: '{}',
			}).outcome,
		).toBe('revision_conflict');
	});

	test('nested mutations commit at FULL and restore NORMAL only after outer commit', () => {
		const seen: number[] = [];
		_internals.coordinationFaultInjector = (point, db) => {
			if (point === 'before_outer_commit') {
				seen.push(
					db.query<{ synchronous: number }, []>('PRAGMA synchronous').get()!
						.synchronous,
				);
			}
		};
		withCoordinationTransaction(tempDir, () => {
			transitionCoordinationState(tempDir, {
				namespace: 'workflow',
				entityKey: 'one',
				expectedRevision: null,
				generation: 1,
				status: 'armed',
				payload: '{}',
			});
			transitionCoordinationState(tempDir, {
				namespace: 'authorization',
				entityKey: 'one',
				expectedRevision: null,
				generation: 1,
				status: 'consumed',
				payload: '{}',
			});
		});
		expect(seen).toEqual([2]);
		expect(
			getProjectDb(tempDir)
				.query<{ synchronous: number }, []>('PRAGMA synchronous')
				.get()?.synchronous,
		).toBe(1);
	});

	test('rolls back every nested mutation when the outer composition throws', () => {
		expect(() =>
			withCoordinationTransaction(tempDir, () => {
				transitionCoordinationState(tempDir, {
					namespace: 'workflow',
					entityKey: 'rollback',
					expectedRevision: null,
					generation: 1,
					status: 'armed',
					payload: '{}',
				});
				throw new Error('inject rollback');
			}),
		).toThrow('inject rollback');
		expect(getCoordinationState(tempDir, 'workflow', 'rollback')).toBeNull();
	});

	test('crash between event append and state transition rolls back both', () => {
		_internals.coordinationFaultInjector = (point) => {
			if (point === 'after_event_before_state') throw new Error('crash');
		};
		expect(() =>
			transitionCoordinationState(tempDir, {
				namespace: 'delegation',
				entityKey: 'crash',
				expectedRevision: null,
				generation: 1,
				status: 'settled',
				payload: '{}',
				event: {
					streamId: 'delegation:crash',
					idempotencyKey: 'settle-1',
					eventType: 'settled',
					payload: '{}',
					expectedStreamVersion: 0,
				},
			}),
		).toThrow('crash');
		expect(getCoordinationState(tempDir, 'delegation', 'crash')).toBeNull();
		expect(
			getProjectDb(tempDir)
				.query<{ count: number }, []>(
					'SELECT COUNT(*) AS count FROM coordination_event',
				)
				.get()?.count,
		).toBe(0);
	});

	test('refuses nesting inside an unknown transaction', () => {
		const db = getProjectDb(tempDir);
		db.run('BEGIN');
		try {
			expect(() =>
				transitionCoordinationState(tempDir, {
					namespace: 'scope',
					entityKey: 'unsafe',
					expectedRevision: null,
					generation: 1,
					status: 'active',
					payload: '{}',
				}),
			).toThrow(/unknown|coordination-owned/i);
		} finally {
			db.run('ROLLBACK');
		}
	});

	test('leases require exact owner and generation to release', () => {
		expect(
			acquireCoordinationLease(tempDir, {
				namespace: 'background-owner',
				entityKey: 'job-1',
				generation: 2,
				ownerToken: 'owner-a',
				leaseExpiresAt: '2099-01-01T00:00:00.000Z',
				payload: '{}',
			}).outcome,
		).toBe('acquired');
		expect(
			releaseCoordinationLease(
				tempDir,
				'background-owner',
				'job-1',
				2,
				'owner-b',
			),
		).toBe(false);
		expect(
			releaseCoordinationLease(
				tempDir,
				'background-owner',
				'job-1',
				1,
				'owner-a',
			),
		).toBe(false);
		expect(
			releaseCoordinationLease(
				tempDir,
				'background-owner',
				'job-1',
				2,
				'owner-a',
			),
		).toBe(true);
	});
});
