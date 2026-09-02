/**
 * Group-commit writer (issue #2480 obligation 8): queue -> ONE BEGIN IMMEDIATE
 * transaction per flush, co-commit across stores, rollback on op failure,
 * backpressure overflow, and the degraded (disk-full) retention path.
 */

import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DbWriteError } from '../../../src/db/db-errors.js';
import {
	FLUSH_THRESHOLD_OPS,
	GroupCommitWriter,
	getGroupCommitWriter,
	getOpenGroupCommitWriterCount,
	MAX_QUEUED_OPS,
	_internals as writerInternals,
} from '../../../src/db/group-commit-writer.js';
import { appendInsightCandidatesDb } from '../../../src/db/insight-candidate-store.js';
import { closeProjectDb, getProjectDb } from '../../../src/db/project-db.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

let dir: string;
let db: ReturnType<typeof getProjectDb>;

beforeEach(() => {
	dir = canonicalMkdtemp('gcw-');
	mkdirSync(path.join(dir, '.swarm'), { recursive: true });
	db = getProjectDb(dir);
	db.run(
		"INSERT INTO project_constraints (constraint_type, content) VALUES ('seed', 'v0')",
	);
});

afterEach(() => {
	closeProjectDb(dir); // release the WAL lock before temp cleanup (EBUSY)
	rmSync(dir, { recursive: true, force: true });
});

describe('GroupCommitWriter', () => {
	test('one flush = one transaction: ops from two stores co-commit', () => {
		const writer = new GroupCommitWriter(db);
		writer.enqueue({
			durability: 'normal',
			run: (handle) => {
				handle.run(
					"INSERT INTO project_constraints (constraint_type, content) VALUES ('a', '1')",
				);
			},
		});
		writer.enqueue({
			durability: 'normal',
			run: (handle) => {
				handle.run(
					"INSERT INTO project_constraints (constraint_type, content) VALUES ('b', '2')",
				);
			},
		});
		writer.flushSync();
		const n = db
			.query<{ n: number }, []>(
				"SELECT COUNT(*) as n FROM project_constraints WHERE constraint_type IN ('a','b')",
			)
			.get()?.n;
		expect(n).toBe(2);
		// The queue is drained.
		expect(writer.queuedOpCount).toBe(0);
	});

	test('an op failure rolls back the whole batch and rethrows', () => {
		const writer = new GroupCommitWriter(db);
		writer.enqueue({
			durability: 'normal',
			run: (handle) => {
				handle.run(
					"INSERT INTO project_constraints (constraint_type, content) VALUES ('c', '3')",
				);
			},
		});
		writer.enqueue({
			durability: 'normal',
			run: () => {
				throw new Error('op exploded');
			},
		});
		expect(() => writer.flushSync()).toThrow('op exploded');
		const n = db
			.query<{ n: number }, []>(
				"SELECT COUNT(*) as n FROM project_constraints WHERE constraint_type = 'c'",
			)
			.get()?.n;
		expect(n).toBe(0); // op 1 rolled back with op 2
		expect(writer.queuedOpCount).toBe(0); // non-retryable: queue emptied
	});

	test('a busy failure retains the batch as retryable', () => {
		const writer = new GroupCommitWriter(db);
		writer.enqueue({
			durability: 'normal',
			run: () => {
				throw new Error('database is locked (SQLITE_BUSY)');
			},
		});
		let caught: unknown;
		try {
			writer.flushSync();
		} catch (err) {
			caught = err;
		}
		// busy is thrown at op-execution (post-BEGIN): the batch was
		// classified busy and retained for the next flush.
		expect(caught).toBeDefined();
		// The op fails deterministically here; the writer must not lose it.
		expect(writer.queuedOpCount).toBe(1);
	});

	test('backpressure: reaching the threshold forces a synchronous flush', () => {
		const writer = new GroupCommitWriter(db);
		// The 64th enqueued op (FLUSH_THRESHOLD_OPS) triggers the flush.
		for (let i = 0; i < FLUSH_THRESHOLD_OPS; i++) {
			writer.enqueue({
				durability: 'normal',
				run: (handle) => {
					handle.run(
						`INSERT INTO project_constraints (constraint_type, content) VALUES ('bp', '${i}')`,
					);
				},
			});
		}
		const n = db
			.query<{ n: number }, []>(
				"SELECT COUNT(*) as n FROM project_constraints WHERE constraint_type = 'bp'",
			)
			.get()?.n;
		expect(n).toBe(64);
	});

	test('FULL-class escalation: a full op runs the batch at synchronous=FULL', () => {
		db.run('PRAGMA synchronous = NORMAL;'); // normalize the baseline
		const writer = new GroupCommitWriter(db);
		let observed = -1;
		writer.enqueue({ durability: 'normal', run: () => {} });
		writer.enqueue({
			durability: 'full',
			run: (handle) => {
				observed =
					handle.query<{ synchronous: number }, []>('PRAGMA synchronous').get()
						?.synchronous ?? -1;
			},
		});
		writer.flushSync();
		expect(observed).toBe(2); // FULL during the batch
		// …and restored afterwards.
		expect(
			db.query<{ synchronous: number }, []>('PRAGMA synchronous').get()
				?.synchronous,
		).toBe(1);
	});

	test('flush with an empty queue is a no-op; close drops the queue', async () => {
		const writer = new GroupCommitWriter(db);
		await expect(writer.flush()).resolves.toBeUndefined();
		writer.enqueue({
			durability: 'normal',
			run: () => {
				throw new Error('must never run');
			},
		});
		writer.close();
		await expect(writer.flush()).resolves.toBeUndefined();
	});

	test(
		'#2480 stale-writer regression: a closed underlying handle self-heals; the post-close write rebinds and lands',
		{ timeout: 30_000 },
		async () => {
			// Prime the cached writer + handle from THIS process, then close
			// ONLY the DB handle (the pre-fix /swarm close shape).
			await appendInsightCandidatesDb(dir, [
				{
					payload: JSON.stringify({ lesson: 'before-close' }),
					createdAt: '2026-01-01T00:00:00.000Z',
				},
			]);
			closeProjectDb(dir);
			// Post-close write: the flush hits a closed handle; the writer
			// must rebind to a fresh handle and complete the batch.
			await appendInsightCandidatesDb(dir, [
				{
					payload: JSON.stringify({ lesson: 'after-close' }),
					createdAt: '2026-01-02T00:00:00.000Z',
				},
			]);
			const n = getProjectDb(dir)
				.query<{ n: number }, []>(
					'SELECT COUNT(*) as n FROM insight_candidate WHERE consumed_at IS NULL',
				)
				.get()?.n;
			expect(n).toBe(2); // both writes durable
		},
	);

	test('#2480 double-closed-handle eviction: the retry failing closed evicts the writer; the next call gets a FRESH writer', () => {
		// Prime the cached writer through the public path.
		const original = getGroupCommitWriter(dir);
		const writersBefore = getOpenGroupCommitWriterCount();
		// Kill the cached handle (the pre-fix /swarm close shape)…
		closeProjectDb(dir);
		// …and make the self-heal rebind deterministically return an
		// ALREADY-CLOSED handle, so the retry also fails closed (the
		// eviction branch — unreachable deterministically otherwise).
		const realGet = writerInternals.getProjectDb;
		writerInternals.getProjectDb = (() => {
			const dead = new Database(':memory:');
			dead.close();
			return dead as unknown as ReturnType<typeof realGet>;
		}) as typeof realGet;
		let threw = false;
		try {
			original.enqueue({
				durability: 'normal',
				run: () => {},
			});
			original.flushSync();
		} catch {
			threw = true;
		} finally {
			writerInternals.getProjectDb = realGet;
		}
		expect(threw).toBe(true);
		// The writer was evicted from the registry…
		expect(getOpenGroupCommitWriterCount()).toBe(writersBefore - 1);
		// …and the next acquisition is a DIFFERENT, working writer object.
		const fresh = getGroupCommitWriter(dir);
		expect(fresh).not.toBe(original);
		fresh.enqueue({
			durability: 'normal',
			run: (handle) => {
				handle.run(
					"INSERT INTO project_constraints (constraint_type, content) VALUES ('evicted-fresh', 'ok')",
				);
			},
		});
		fresh.flushSync();
		expect(
			getProjectDb(dir)
				.query<{ n: number }, []>(
					"SELECT COUNT(*) as n FROM project_constraints WHERE constraint_type = 'evicted-fresh'",
				)
				.get()?.n,
		).toBe(1);
	});

	test('#2480 non-closed rebind failure (corrupt reopen) throws WITHOUT evicting; recovery is a second self-heal', async () => {
		await appendInsightCandidatesDb(dir, [
			{
				payload: JSON.stringify({ lesson: 'prime' }),
				createdAt: '2026-01-01T00:00:00.000Z',
			},
		]);
		const writerBefore = getGroupCommitWriter(dir);
		const writersBefore = getOpenGroupCommitWriterCount();
		closeProjectDb(dir);
		const dbPath = path.join(dir, '.swarm', 'swarm.db');
		writeFileSync(dbPath, 'not a sqlite database');
		// Flush fails (closed handle) → rebind tries to REOPEN the corrupt
		// file → "file is not a database" is NOT a closed-handle error, so
		// the writer must stay registered (no eviction on foreign errors).
		await expect(
			appendInsightCandidatesDb(dir, [
				{
					payload: JSON.stringify({ lesson: 'doomed' }),
					createdAt: '2026-01-02T00:00:00.000Z',
				},
			]),
		).rejects.toThrow();
		expect(getOpenGroupCommitWriterCount()).toBe(writersBefore);
		expect(getGroupCommitWriter(dir)).toBe(writerBefore);
		// Repair: the SAME writer self-heals again (rebind → fresh file).
		rmSync(dbPath, { force: true });
		await appendInsightCandidatesDb(dir, [
			{
				payload: JSON.stringify({ lesson: 'recovered' }),
				createdAt: '2026-01-03T00:00:00.000Z',
			},
		]);
		const n = getProjectDb(dir)
			.query<{ n: number }, []>(
				"SELECT COUNT(*) as n FROM insight_candidate WHERE payload LIKE '%recovered%'",
			)
			.get()?.n;
		expect(n).toBe(1);
	});

	test('#2480 review F-01: the hard queue bound forces flush attempts past MAX_QUEUED_OPS', () => {
		// Busy ops make every flush fail and RETAIN the batch, so the queue
		// grows across enqueues; the hard bound must still force flush
		// attempts (backpressure) instead of unbounded growth.
		const writer = new GroupCommitWriter(db);
		const busyOp = {
			durability: 'normal' as const,
			run: () => {
				throw new Error('database is locked (SQLITE_BUSY)');
			},
		};
		let enqueued = 0;
		// enqueue's inline threshold flush THROWS DbWriteError on busy
		// (documented contract) — expect and swallow; the pin below is the
		// hard bound on queue growth.
		for (let i = 0; i < MAX_QUEUED_OPS + 200; i++) {
			try {
				writer.enqueue({ ...busyOp });
			} catch {
				// expected once the threshold flush starts failing
			}
			enqueued++;
			if (writer.queuedOpCount > MAX_QUEUED_OPS) {
				break; // enforcement failed — fail the loop, assert below
			}
		}
		expect(enqueued).toBeGreaterThan(MAX_QUEUED_OPS - 64); // sanity: we really pushed
		// push-then-flush: with persistently failing flushes the queue sits at
		// MAX+1 — one beyond the cap, never unbounded, every enqueue attempted.
		expect(writer.queuedOpCount).toBeLessThanOrEqual(MAX_QUEUED_OPS + 1);
		writer.close();
	});

	test('#2480 review F-05: the closed-handle matcher covers bun query-path phrasing', () => {
		expect(
			writerInternals.isClosedHandleError(new Error('Database has closed')),
		).toBe(true);
		expect(
			writerInternals.isClosedHandleError(new Error('database is not open')),
		).toBe(true);
		expect(
			writerInternals.isClosedHandleError(
				new Error('Cannot use a closed database'),
			),
		).toBe(true);
		expect(
			writerInternals.isClosedHandleError(new Error('file is not a database')),
		).toBe(false);
	});

	test('enqueue after close throws a DbWriteError', () => {
		const writer = new GroupCommitWriter(db);
		writer.close();
		expect(() =>
			writer.enqueue({ durability: 'normal', run: () => {} }),
		).toThrow(DbWriteError);
	});
});
