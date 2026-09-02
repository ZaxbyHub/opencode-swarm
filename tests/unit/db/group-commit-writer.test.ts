/**
 * Group-commit writer (issue #2480 obligation 8): queue -> ONE BEGIN IMMEDIATE
 * transaction per flush, co-commit across stores, rollback on op failure,
 * backpressure overflow, and the degraded (disk-full) retention path.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DbWriteError } from '../../../src/db/db-errors.js';
import {
	FLUSH_THRESHOLD_OPS,
	GroupCommitWriter,
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
		'#2480 stale-writer regression: a closed underlying handle self-evicts; the next write rebinds',
		{ timeout: 30_000 },
		async () => {
			const repoRoot = path.resolve(import.meta.dir, '..', '..', '..');
			const projectDbUrl = pathToFileURL(
				path.join(repoRoot, 'src', 'db', 'project-db.ts'),
			).href;
			const writerSrc = `import { getProjectDb } from ${JSON.stringify(projectDbUrl)};
const dir = process.env.SWARM_CONC_DIR;
if (!dir) throw new Error('SWARM_CONC_DIR missing');
const db = getProjectDb(dir);
`;
			const workerPath = path.join(dir, 'worker.ts');
			writeFileSync(workerPath, writerSrc, 'utf8');
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
			// must self-evict so the retried append rebinds and SUCCEEDS.
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

	test('enqueue after close throws a DbWriteError', () => {
		const writer = new GroupCommitWriter(db);
		writer.close();
		expect(() =>
			writer.enqueue({ durability: 'normal', run: () => {} }),
		).toThrow(DbWriteError);
	});
});
