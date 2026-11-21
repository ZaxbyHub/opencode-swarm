/**
 * [Workstream R — issue #3772, PR 5 of 21] Acceptance checks for the
 * group-commit writer's per-op durable-outcome contract
 * (src/db/group-commit-writer.ts).
 *
 * Posture (frozen docstring — do not reword):
 * - AC6: RED at base, GREEN after the fix (#3772).
 * - AC7: RED at base, GREEN after the fix (#3772).
 * - AC8: GREEN on both revisions (preserving control for the normal path).
 *
 * Construction follows tests/unit/db/group-commit-writer.test.ts: a real
 * `.swarm/swarm.db` under a canonical temp dir, a raw GroupCommitWriter over
 * the project DB handle, and closeProjectDb before temp cleanup (WAL EBUSY).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import * as path from 'node:path';
import { DbWriteError } from '../../../src/db/db-errors.js';
import {
	type GroupCommitOp,
	GroupCommitWriter,
} from '../../../src/db/group-commit-writer.js';
import { closeProjectDb, getProjectDb } from '../../../src/db/project-db.js';
import { canonicalMkdtemp, removeTreeWithRetry } from '../../helpers/tmpdir';

let dir: string;
let db: ReturnType<typeof getProjectDb>;

beforeEach(() => {
	dir = canonicalMkdtemp('gcw-durable-');
	mkdirSync(path.join(dir, '.swarm'), { recursive: true });
	db = getProjectDb(dir);
});

afterEach(() => {
	closeProjectDb(dir); // release the WAL lock before temp cleanup (EBUSY)
	removeTreeWithRetry(dir);
});

/** Count project_constraints rows for one constraint_type marker. */
function countByType(marker: string): number {
	return (
		db
			.query<{ n: number }, [string]>(
				'SELECT COUNT(*) as n FROM project_constraints WHERE constraint_type = ?',
			)
			.get(marker)?.n ?? 0
	);
}

/** Count DISTINCT content values for one constraint_type marker. */
function distinctContentByType(marker: string): number {
	return (
		db
			.query<{ n: number }, [string]>(
				'SELECT COUNT(DISTINCT content) as n FROM project_constraints WHERE constraint_type = ?',
			)
			.get(marker)?.n ?? 0
	);
}

describe('group-commit writer durable outcomes (#3772)', () => {
	test('AC6: an earlier accepted op sharing a batch with a permanently failing op is committed once or gets its own observable failure', () => {
		// AC6: WHEN two previously accepted operations share a batch with an
		// operation that fails permanently, THE SYSTEM SHALL commit each
		// earlier operation once OR expose its own observable failure.
		// Posture: RED at base, GREEN after the fix (#3772).
		const writer = new GroupCommitWriter(db);
		// op1: a valid, previously ACCEPTED write (enqueue returned without
		// throwing). Note: op1's run function executing inside the rolled-back
		// transaction is NOT an outcome signal — only a committed row, the
		// flush error naming op1's disposition, or a per-op failure channel is.
		const op1: GroupCommitOp = {
			durability: 'normal',
			run: (handle) => {
				handle.run(
					"INSERT INTO project_constraints (constraint_type, content) VALUES ('ac6-op1', 'v1')",
				);
			},
		};
		// Observation hook ONLY — NOT a required API: an extra property the
		// current implementation ignores. If the #3772 fix adds a per-op
		// outcome channel that invokes an `onDrop`-style callback on the op
		// object, this test observes op1's OWN failure; the assertion below
		// treats that observation as equivalent evidence to the commit arm.
		let op1OutcomeObserved = false;
		(op1 as unknown as { onDrop?: () => void }).onDrop = () => {
			op1OutcomeObserved = true;
		};
		writer.enqueue(op1);
		// op2: PERMANENT (non-retryable) failure — a plain Error classifies
		// 'unknown' in db-errors.ts, so the batch is dropped, not retained.
		writer.enqueue({
			durability: 'normal',
			run: () => {
				throw new Error('ac6-permanent-boom');
			},
		});
		let flushErrorMessage = '';
		try {
			writer.flushSync();
		} catch (err) {
			flushErrorMessage = err instanceof Error ? err.message : String(err);
		}
		const committedRows = countByType('ac6-op1');
		// The flush error may name op2's failure; only a mention of op1's own
		// marker counts as accounting for op1's disposition.
		const errorNamesOp1Disposition = /ac6-op1/.test(flushErrorMessage);
		// AC contract — op1 is NOT silently lost. RED at base: 0 rows, the
		// flush error names only op2 ('ac6-permanent-boom'), and no per-op
		// channel fires → neither arm holds.
		expect(
			committedRows === 1 || errorNamesOp1Disposition || op1OutcomeObserved,
		).toBe(true);
		// The commit arm must hold "once", not "at least": if op1 committed,
		// exactly one row — never a duplicate.
		expect(committedRows).toBeLessThanOrEqual(1);
	}, 30000);

	test('AC7: a caller retry after a retryable-flush rejection commits the logical write at most once', () => {
		// AC7: WHEN an enqueue is reported as rejected after a retryable flush
		// error and the caller retries it, THE SYSTEM SHALL commit the retried
		// operation at most once.
		// Posture: RED at base, GREEN after the fix (#3772).
		const writer = new GroupCommitWriter(db);
		let busy = true;
		writer.enqueue({
			durability: 'normal',
			run: (handle) => {
				if (busy) {
					// busy-classified (db-errors.ts: 'database is locked') → the
					// batch is RETAINED and the flush throws DbWriteError: the
					// enqueue is REPORTED as rejected while the op stays queued.
					throw new Error('database is locked (SQLITE_BUSY)');
				}
				handle.run(
					"INSERT INTO project_constraints (constraint_type, content) VALUES ('ac7', 'ac7-logical')",
				);
			},
		});
		let firstFlushError: unknown = null;
		try {
			writer.flushSync();
		} catch (err) {
			firstFlushError = err;
		}
		// Premise (holds at base): the caller is told the write was rejected.
		expect(firstFlushError).toBeInstanceOf(DbWriteError);
		expect((firstFlushError as DbWriteError).category).toBe('busy');
		// The caller believes the rejection and retries the SAME logical
		// write as a fresh op.
		writer.enqueue({
			durability: 'normal',
			run: (handle) => {
				handle.run(
					"INSERT INTO project_constraints (constraint_type, content) VALUES ('ac7', 'ac7-logical')",
				);
			},
		});
		// Recovery: the lock clears and the retried flush succeeds.
		busy = false;
		writer.flushSync();
		// At-most-once for the logical write. RED at base: the retained
		// original op AND the retry both commit → 2 rows.
		expect(countByType('ac7')).toBe(1);
		// The dedup contract is about the LOGICAL write: one distinct content
		// value, not two colliding copies of the same write.
		expect(distinctContentByType('ac7')).toBe(1);
		// The queue drained after the successful flush.
		expect(writer.queuedOpCount).toBe(0);
	}, 30000);

	test('AC8: a normal all-success batch commits in order exactly once', () => {
		// AC8: WHEN all operations in a normal batch succeed, THE SYSTEM SHALL
		// commit the batch in order exactly once.
		// Posture: GREEN on both revisions (preserving control).
		const writer = new GroupCommitWriter(db);
		const marks = ['ac8-n1', 'ac8-n2', 'ac8-n3'];
		for (const mark of marks) {
			writer.enqueue({
				durability: 'normal',
				run: (handle) => {
					handle.run(
						`INSERT INTO project_constraints (constraint_type, content) VALUES ('${mark}', 'v-${mark}')`,
					);
				},
			});
		}
		writer.flushSync();
		const rows = db
			.query<{ id: number; constraint_type: string }, []>(
				"SELECT id, constraint_type FROM project_constraints WHERE constraint_type IN ('ac8-n1','ac8-n2','ac8-n3') ORDER BY id",
			)
			.all();
		// FIFO commit order (id is the INTEGER PRIMARY KEY rowid alias).
		expect(rows.map((row) => row.constraint_type)).toEqual(marks);
		expect(rows[0].id).toBeLessThan(rows[1].id);
		expect(rows[1].id).toBeLessThan(rows[2].id);
		// Exactly once each.
		for (const mark of marks) {
			expect(countByType(mark)).toBe(1);
		}
		// The queue drained.
		expect(writer.queuedOpCount).toBe(0);
	}, 30000);
});
