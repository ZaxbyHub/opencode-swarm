/**
 * Group-commit writer drop accounting (#3772 AC6/AC7, plan v3 D4/D5).
 *
 * RED at base, GREEN after the fix (#3772) for the onDrop/flag legs. Pins
 * the three exactly-once accounting shapes (critic round 2 blocker 5):
 * threshold-inline drop (flagged), delayed-flush drop (unflagged callback),
 * and not-accepted failures (listener-owned, unflagged).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import * as path from 'node:path';
import { DbWriteError } from '../../../src/db/db-errors.js';
import {
	FLUSH_THRESHOLD_OPS,
	GroupCommitWriter,
} from '../../../src/db/group-commit-writer.js';
import { closeProjectDb, getProjectDb } from '../../../src/db/project-db.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

let dir: string;
let db: ReturnType<typeof getProjectDb>;

beforeEach(() => {
	dir = canonicalMkdtemp('gcw-drop-');
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

const busyError = () => new Error('database is locked (SQLITE_BUSY)');

describe('group-commit writer drop accounting (#3772)', () => {
	test('threshold-inline drop: onDrop fires once per accepted op and the throw carries droppedAcceptedOp', () => {
		const writer = new GroupCommitWriter(db);
		let dropped = 0;
		const busyOp = {
			durability: 'normal' as const,
			run: () => {
				throw busyError();
			},
			onDrop: () => {
				dropped += 1;
			},
		};
		let thrown: DbWriteError | undefined;
		try {
			for (let i = 0; i < FLUSH_THRESHOLD_OPS; i++) {
				writer.enqueue({ ...busyOp });
			}
		} catch (err) {
			thrown = err as DbWriteError;
		}
		// The 64th enqueue's threshold flush failed busy: the whole batch
		// (all 64 accepted ops) was dropped, every onDrop fired exactly once,
		// and the rethrown error tells the listener THIS call's op was
		// already accounted (flag set) so it must not double-count.
		expect(thrown).toBeInstanceOf(DbWriteError);
		expect(thrown?.category).toBe('busy');
		expect((thrown as DbWriteError | undefined)?.droppedAcceptedOp).toBe(true);
		expect(dropped).toBe(FLUSH_THRESHOLD_OPS);
		expect(writer.queuedOpCount).toBe(0);
	}, 30000);

	test('delayed-flush drop: a direct flushSync reports unflagged and callbacks fire once', () => {
		const writer = new GroupCommitWriter(db);
		let droppedA = 0;
		let droppedB = 0;
		writer.enqueue({
			durability: 'normal',
			run: () => {
				throw busyError();
			},
			onDrop: () => {
				droppedA += 1;
			},
		});
		writer.enqueue({
			durability: 'normal',
			run: (handle) => {
				handle.run(
					"INSERT INTO project_constraints (constraint_type, content) VALUES ('d','1')",
				);
			},
			onDrop: () => {
				droppedB += 1;
			},
		});
		let thrown: unknown;
		try {
			writer.flushSync();
		} catch (err) {
			thrown = err;
		}
		expect(thrown).toBeInstanceOf(DbWriteError);
		// Direct flush call — no enqueue involvement, so no flag.
		expect((thrown as DbWriteError).droppedAcceptedOp).toBeUndefined();
		expect(droppedA).toBe(1);
		// The sibling op rolled back with the batch: its drop is observable
		// too (this is the frozen AC6 contract).
		expect(droppedB).toBe(1);
		expect(writer.queuedOpCount).toBe(0);
	}, 30000);

	test('a not-accepted failure (closed writer) throws unflagged with no callbacks', () => {
		const writer = new GroupCommitWriter(db);
		writer.close();
		let thrown: unknown;
		try {
			writer.enqueue({
				durability: 'normal',
				run: () => {},
				onDrop: () => {
					throw new Error('must not fire for a never-accepted op');
				},
			});
		} catch (err) {
			thrown = err;
		}
		expect(thrown).toBeInstanceOf(DbWriteError);
		expect((thrown as DbWriteError).droppedAcceptedOp).toBeUndefined();
		expect((thrown as DbWriteError).category).toBe('unknown');
	}, 30000);

	test('a throwing onDrop callback never masks the original flush failure', () => {
		const writer = new GroupCommitWriter(db);
		writer.enqueue({
			durability: 'normal',
			run: () => {
				throw busyError();
			},
			onDrop: () => {
				throw new Error('callback explosion');
			},
		});
		let thrown: unknown;
		try {
			writer.flushSync();
		} catch (err) {
			thrown = err;
		}
		expect(thrown).toBeInstanceOf(DbWriteError);
		expect((thrown as DbWriteError).category).toBe('busy');
		expect((thrown as DbWriteError).message).not.toContain(
			'callback explosion',
		);
	}, 30000);
});
