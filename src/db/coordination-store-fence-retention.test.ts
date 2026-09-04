import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import { canonicalMkdtemp } from '../../tests/helpers/tmpdir.js';
import {
	_internals,
	getCoordinationState,
	transitionCoordinationState,
} from './coordination-store.js';
import { closeAllProjectDbs, getProjectDb } from './project-db.js';

let tempDir: string;

beforeEach(() => {
	tempDir = canonicalMkdtemp('coordination-fence-retention-test-');
});

afterEach(() => {
	_internals.maxEventsPerStream = 2_048;
	_internals.maxTotalEvents = 100_000;
	_internals.maxEventFencesPerStream = 8_192;
	_internals.maxTotalEventFences = 400_000;
	closeAllProjectDbs();
	fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('coordination idempotency-fence retention', () => {
	test('bounds fences per stream and globally without replaying an evicted request', () => {
		_internals.maxEventsPerStream = 1;
		_internals.maxTotalEvents = 2;
		_internals.maxEventFencesPerStream = 3;
		_internals.maxTotalEventFences = 4;
		let revision = 0;
		for (const [streamId, key] of [
			['fence:a', 'a-0'],
			['fence:a', 'a-1'],
			['fence:a', 'a-2'],
			['fence:a', 'a-3'],
			['fence:b', 'b-0'],
			['fence:b', 'b-1'],
		] as const) {
			const result = transitionCoordinationState(tempDir, {
				namespace: 'bounded-fence',
				entityKey: 'state',
				expectedRevision: revision === 0 ? null : revision,
				generation: 1,
				status: 'active',
				payload: JSON.stringify({ revision }),
				event: {
					streamId,
					idempotencyKey: key,
					eventType: 'advanced',
					payload: JSON.stringify({ key }),
				},
			});
			expect(result.outcome).toBe('applied');
			revision += 1;
		}
		const db = getProjectDb(tempDir);
		expect(
			db
				.query<{ count: number }, []>(
					'SELECT COUNT(*) AS count FROM coordination_event_fence',
				)
				.get()?.count,
		).toBe(4);
		expect(
			db
				.query<{ count: number }, [string]>(
					'SELECT COUNT(*) AS count FROM coordination_event_fence WHERE stream_id = ?',
				)
				.get('fence:a')?.count,
		).toBeLessThanOrEqual(3);
		expect(
			db
				.query<{ idempotency_key: string }, []>(
					'SELECT idempotency_key FROM coordination_event_fence ORDER BY created_at, stream_id, rowid',
				)
				.all()
				.map((row) => row.idempotency_key),
		).toEqual(['a-2', 'a-3', 'b-0', 'b-1']);
		expect(
			transitionCoordinationState(tempDir, {
				namespace: 'bounded-fence',
				entityKey: 'state',
				expectedRevision: revision,
				generation: 1,
				status: 'active',
				payload: JSON.stringify({ revision: 5 }),
				event: {
					streamId: 'fence:b',
					idempotencyKey: 'b-1',
					eventType: 'advanced',
					payload: JSON.stringify({ key: 'b-1' }),
				},
			}),
		).toMatchObject({ outcome: 'duplicate' });
		expect(
			transitionCoordinationState(tempDir, {
				namespace: 'bounded-fence',
				entityKey: 'state',
				expectedRevision: null,
				generation: 1,
				status: 'active',
				payload: JSON.stringify({ revision: 0 }),
				event: {
					streamId: 'fence:a',
					idempotencyKey: 'a-0',
					eventType: 'advanced',
					payload: JSON.stringify({ key: 'a-0' }),
				},
			}),
		).toMatchObject({ outcome: 'revision_conflict' });
		expect(
			getCoordinationState(tempDir, 'bounded-fence', 'state')?.revision,
		).toBe(revision);
	});
});
