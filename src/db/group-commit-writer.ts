/**
 * Group-commit writer for `.swarm/swarm.db` low-risk stores (issue #2480
 * obligation 8: "queue -> one txn per flush").
 *
 * Design:
 * - One writer per canonical project root, created lazily on first use and
 *   closed with the DB handle (`closeGroupCommitWriter`). Nothing here runs at
 *   plugin init.
 * - `enqueue(op)` queues a write op. A flush applies EVERY queued op inside
 *   ONE `BEGIN IMMEDIATE` transaction (the qa-gate-profile lock precedent —
 *   plain `db.transaction()` issues a deferred BEGIN that lets two writers
 *   deadlock-escalate to SQLITE_BUSY under two-windows contention).
 * - Durability escalation: if any op in the batch is `full`-class, the whole
 *   transaction runs with `PRAGMA synchronous = FULL` (authoritative state
 *   never inherits the rebuildable-index setting); otherwise NORMAL.
 * - Backpressure: the queue is bounded; overflow forces a synchronous flush
 *   rather than dropping writes.
 * - Failure handling: a `BEGIN IMMEDIATE` busy or a disk-full/read-only
 *   failure keeps the queue intact, classifies the error (`db-errors.ts`),
 *   and coalesces to ONE advisory/telemetry signal per degradation episode
 *   (cooldown); the next flush retries. Ops themselves throwing rolls the
 *   transaction back and rethrows (the enqueuing store decides fail-open).
 */

import type { Database } from 'bun:sqlite';
import { warn } from '../utils/logger.js';
import { canonicalProjectKey } from './canonical-project.js';
import {
	classifyDbWriteError,
	DbWriteError,
	type DbWriteErrorCategory,
} from './db-errors.js';
import {
	applySynchronousForClass,
	batchDurabilityClass,
} from './durability.js';
import { getProjectDb } from './project-db.js';

/** A single durable write, applied inside a flush transaction. */
export interface GroupCommitOp {
	/** Durability class of the target table/stream (escalation input). */
	durability: 'full' | 'normal';
	/** Apply the write. Must only touch `.swarm/swarm.db` via the given handle. */
	run: (db: Database) => void;
}

/** Queue bound — overflow forces a synchronous flush (never a silent drop). */
const _MAX_QUEUED_OPS = 1024;

/** Ops at or above this count trigger an immediate synchronous flush. */
export const FLUSH_THRESHOLD_OPS = 64;

/** Cooldown between repeated degradation advisories (session-scoped bound). */
const DEGRADED_COOLDOWN_MS = 60_000;

const _writers: Map<string, GroupCommitWriter> = new Map();

export class GroupCommitWriter {
	private readonly db: Database;
	private queue: GroupCommitOp[] = [];
	private flushing = false;
	private degraded: { category: DbWriteErrorCategory; until: number } | null =
		null;
	private lastAdvisoryAt = 0;
	private closed = false;

	constructor(db: Database) {
		this.db = db;
	}

	get queuedOpCount(): number {
		return this.queue.length;
	}

	/**
	 * Queue a write op. When the queue reaches the flush threshold, a
	 * synchronous flush runs immediately (backpressure). Throws `DbWriteError`
	 * only from that inline flush; a bare enqueue never throws.
	 */
	enqueue(op: GroupCommitOp): void {
		if (this.closed) {
			throw new DbWriteError('unknown', 'group-commit writer is closed');
		}
		this.queue.push(op);
		if (this.queue.length >= FLUSH_THRESHOLD_OPS) {
			this.flushSync();
		}
	}

	/**
	 * Apply every queued op in ONE immediate transaction. On op failure the
	 * transaction rolls back and the error rethrows (queue emptied — the ops
	 * are not idempotently retryable by this layer). On busy/disk-full/
	 * read-only the queue is RETAINED and a typed `DbWriteError` throws.
	 */
	flushSync(): void {
		if (this.closed || this.flushing || this.queue.length === 0) return;
		this.flushing = true;
		const batch = this.queue;
		this.queue = [];
		try {
			this.applyBatch(batch);
		} catch (err) {
			const category = classifyDbWriteError(err);
			if (
				category === 'busy' ||
				category === 'disk_full' ||
				category === 'read_only'
			) {
				// Retryable/environmental: retain the batch for the next flush
				// and coalesce the advisory.
				this.queue = [...batch, ...this.queue];
				this.noteDegraded(category);
			} else {
				this.noteDegraded(category);
			}
			throw new DbWriteError(
				category,
				`swarm.db group-commit flush failed (${category}): ${
					err instanceof Error ? err.message : String(err)
				}`,
			);
		} finally {
			this.flushing = false;
		}
	}

	/** Async facade over the synchronous flush (callers `await` durability). */
	async flush(): Promise<void> {
		this.flushSync();
	}

	/** Close the writer and drop any unflushed queue. */
	close(): void {
		this.closed = true;
		this.queue = [];
	}

	private applyBatch(batch: GroupCommitOp[]): void {
		const cls = batchDurabilityClass(batch.map((op) => op.durability));
		applySynchronousForClass(this.db, cls);
		try {
			this.db.run('BEGIN IMMEDIATE');
		} catch (err) {
			applySynchronousForClass(this.db, 'normal');
			throw err;
		}
		try {
			for (const op of batch) {
				op.run(this.db);
			}
			this.db.run('COMMIT');
		} catch (err) {
			try {
				this.db.run('ROLLBACK');
			} catch {
				// The connection may already be out of the transaction
				// (post-COMMIT failure, closed handle). Surface the original.
			}
			throw err;
		} finally {
			applySynchronousForClass(this.db, 'normal');
		}
	}

	private noteDegraded(category: DbWriteErrorCategory): void {
		const now = Date.now();
		this.degraded = { category, until: now + DEGRADED_COOLDOWN_MS };
		if (now - this.lastAdvisoryAt < DEGRADED_COOLDOWN_MS) return;
		this.lastAdvisoryAt = now;
		// Bounded advisory — no SQL text, no paths, no payloads.
		warn(
			`[swarm.db] durable-state writer degraded (category=${category}); queued writes retry on the next flush`,
		);
	}

	/** Test/observability access to the degradation state. */
	get degradation(): { category: DbWriteErrorCategory; until: number } | null {
		if (!this.degraded) return null;
		if (Date.now() > this.degraded.until) return null;
		return this.degraded;
	}
}

/**
 * Return the group-commit writer for a project root, creating it (and the DB
 * handle) lazily on first use. Never runs at plugin init.
 */
export function getGroupCommitWriter(directory: string): GroupCommitWriter {
	const key = canonicalProjectKey(directory);
	let writer = _writers.get(key);
	if (!writer) {
		writer = new GroupCommitWriter(getProjectDb(directory));
		_writers.set(key, writer);
	}
	return writer;
}

/** Flush + close the writer for a root (dispose/exit/close paths). */
export function closeGroupCommitWriter(directory: string): void {
	const key = canonicalProjectKey(directory);
	const writer = _writers.get(key);
	if (writer) {
		try {
			writer.flushSync();
		} catch {
			// Best-effort: dispose/close paths never throw.
		}
		writer.close();
		_writers.delete(key);
	}
}

/** Flush + close every writer, then close every DB handle. Test/close use. */
export function closeAllGroupCommitWriters(): void {
	for (const writer of _writers.values()) {
		try {
			writer.flushSync();
		} catch {
			// best-effort
		}
		writer.close();
	}
	_writers.clear();
}

/** Number of open writers (tests/observability). */
export function getOpenGroupCommitWriterCount(): number {
	return _writers.size;
}
