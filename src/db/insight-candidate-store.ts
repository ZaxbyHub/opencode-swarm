/**
 * swarm.db store for insight candidates (issue #2480 D1 migration).
 *
 * Replaces `.swarm/insight-candidates.jsonl` (locked read-modify-write JSONL
 * queue) with the append-only event-stream pattern:
 *
 * - Table `insight_candidate` — PK (stream_id, version) is the
 *   UNIQUE(stream_id, version) stream contract; versions are assigned
 *   MAX(version)+1 inside the appending transaction.
 * - `appendInsightCandidatesDb` batches appends through the group-commit
 *   writer (queue -> one txn per flush).
 * - `consumeInsightCandidatesDb` is the dual-contract transaction: SELECT the
 *   pending batch + UPDATE consumed_at for exactly those versions in ONE
 *   `BEGIN IMMEDIATE` transaction, so concurrent appends and consumes can
 *   never lose or double-take a candidate.
 * - Telemetry-sink retention: consumed rows are DELETE-pruned after 7 days,
 *   and the pending queue is FIFO-capped at 500 (both bounds carried over
 *   from the legacy store's limits).
 *
 * Payloads are opaque serialized JSON strings; the hook layer owns parsing,
 * validation, and identity (`resolveInsightCandidateId` recomputes identity
 * from content, so no id column exists).
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalProjectKey } from './canonical-project.js';
import { DURABILITY_CLASSES } from './durability.js';
import { getGroupCommitWriter } from './group-commit-writer.js';
import { importLegacyJsonl } from './legacy-import.js';
import { getProjectDb, projectDbExists } from './project-db.js';

/** The single stream id used by this store (table is stream-shaped for D2+). */
export const INSIGHT_CANDIDATE_STREAM_ID = 'insight-candidates';

/** Legacy queue filename (imported then cold-archived as `.jsonl.imported`). */
export const INSIGHT_CANDIDATES_LEGACY_FILE = 'insight-candidates.jsonl';

/** FIFO cap on pending (unconsumed) candidates — carried over from the file store. */
export const INSIGHT_PENDING_CAP = 500;

/** Consumed-row retention window (telemetry-sink DELETE-based retention). */
export const INSIGHT_CONSUMED_RETENTION_DAYS = 7;

export interface InsightCandidateRow {
	payload: string;
	createdAt: string;
}

const importedRoots = new Set<string>();
/**
 * #2480 never-opens-for-create guard for read-shaped store entry points: a
 * project with neither a swarm.db NOR a legacy queue file has nothing to
 * read, and reading it must not materialize a DB. When the legacy file IS
 * present the read proceeds (the lazy import then creates the DB — the
 * sanctioned migration path).
 */
function hasAnyInsightState(directory: string): boolean {
	if (projectDbExists(directory)) return true;
	try {
		return existsSync(
			join(
				canonicalProjectKey(directory),
				'.swarm',
				INSIGHT_CANDIDATES_LEGACY_FILE,
			),
		);
	} catch {
		return false;
	}
}

interface InsightCandidateTableRow {
	payload: string;
}

/**
 * One-time (per process, per canonical root) lazy import of the legacy
 * `.swarm/insight-candidates.jsonl` queue. Never runs at plugin init.
 */
export function ensureInsightLegacyImported(directory: string): void {
	const root = canonicalProjectKey(directory);
	if (importedRoots.has(root)) return;
	importLegacyJsonl(directory, {
		fileName: INSIGHT_CANDIDATES_LEGACY_FILE,
		streamCount: (db) =>
			db
				.query<{ count: number }, [string]>(
					'SELECT COUNT(*) as count FROM insight_candidate WHERE stream_id = ?',
				)
				.get(INSIGHT_CANDIDATE_STREAM_ID)?.count ?? 0,
		insertRow: (db, version, payload) => {
			let createdAt = new Date().toISOString();
			try {
				const parsed = JSON.parse(payload) as { created_at?: unknown };
				if (typeof parsed.created_at === 'string')
					createdAt = parsed.created_at;
			} catch {
				// parseLine already validated parseability; defensive only.
			}
			db.run(
				'INSERT INTO insight_candidate (stream_id, version, payload, created_at) VALUES (?, ?, ?, ?)',
				[INSIGHT_CANDIDATE_STREAM_ID, version, payload, createdAt],
			);
		},
		parseLine: (line) => {
			try {
				JSON.parse(line);
				return line;
			} catch {
				return null;
			}
		},
	});
	// Mark imported ONLY on success: a transient import failure (e.g.
	// SQLITE_BUSY under two-windows contention) must retry on the next store
	// use — caching the failure would strand the legacy file forever once a
	// later append makes the table non-empty (final-critic finding).
	importedRoots.add(root);
}

/**
 * Append candidates to the stream via the group-commit writer and await the
 * flush (the legacy store's append was awaited too — durability semantics
 * are preserved; batching coalesces concurrent callers and multi-candidate
 * calls into one transaction).
 */
export async function appendInsightCandidatesDb(
	directory: string,
	rows: InsightCandidateRow[],
): Promise<void> {
	if (rows.length === 0) return;
	ensureInsightLegacyImported(directory);
	const writer = getGroupCommitWriter(directory);
	writer.enqueue({
		durability: DURABILITY_CLASSES.insight_candidate,
		run: (db) => {
			const next =
				db
					.query<{ max: number | null }, [string]>(
						'SELECT MAX(version) as max FROM insight_candidate WHERE stream_id = ?',
					)
					.get(INSIGHT_CANDIDATE_STREAM_ID)?.max ?? 0;
			let version = next;
			for (const row of rows) {
				version += 1;
				db.run(
					'INSERT INTO insight_candidate (stream_id, version, payload, created_at) VALUES (?, ?, ?, ?)',
					[INSIGHT_CANDIDATE_STREAM_ID, version, row.payload, row.createdAt],
				);
			}
			// FIFO cap on the pending queue (same semantics as the legacy
			// `slice(-500)`): drop pending rows OLDER than the 500 newest
			// pending. Strict `<` keeps exactly INSIGHT_PENDING_CAP rows (the
			// newest); `<=` would eat into the retained set.
			db.run(
				`DELETE FROM insight_candidate
				WHERE stream_id = ?
					AND consumed_at IS NULL
					AND version < (
						SELECT MIN(version) FROM (
							SELECT version FROM insight_candidate
							WHERE stream_id = ? AND consumed_at IS NULL
							ORDER BY version DESC
							LIMIT ${INSIGHT_PENDING_CAP}
						)
					)`,
				[INSIGHT_CANDIDATE_STREAM_ID, INSIGHT_CANDIDATE_STREAM_ID],
			);
		},
	});
	await writer.flush();
}

/**
 * Atomically consume up to `limit` pending candidates: the SELECT and the
 * consumed_at UPDATE happen in ONE immediate transaction (dual-contract
 * event+state transition). Consumed rows older than the retention window are
 * DELETE-pruned in the same transaction. Returns the consumed payloads,
 * oldest first.
 */
export function consumeInsightCandidatesDb(
	directory: string,
	limit: number,
): string[] {
	if (!hasAnyInsightState(directory)) return [];
	ensureInsightLegacyImported(directory);
	const db = getProjectDb(directory);
	const payloads: string[] = [];
	db.run('BEGIN IMMEDIATE');
	try {
		const rows = db
			.query<InsightCandidateTableRow, [string, number]>(
				`SELECT payload FROM insight_candidate
				WHERE stream_id = ? AND consumed_at IS NULL
				ORDER BY version
				LIMIT ?`,
			)
			.all(INSIGHT_CANDIDATE_STREAM_ID, limit);
		if (rows.length > 0) {
			// Mark exactly the selected versions consumed: the sub-select pins
			// the batch by version, not by an OFFSET a concurrent append could
			// shift.
			db.run(
				`UPDATE insight_candidate
				SET consumed_at = datetime('now')
				WHERE stream_id = ?
					AND consumed_at IS NULL
					AND version IN (
						SELECT version FROM insight_candidate
						WHERE stream_id = ? AND consumed_at IS NULL
						ORDER BY version
						LIMIT ?
					)`,
				[INSIGHT_CANDIDATE_STREAM_ID, INSIGHT_CANDIDATE_STREAM_ID, rows.length],
			);
		}
		db.run(
			`DELETE FROM insight_candidate
			WHERE consumed_at IS NOT NULL
				AND consumed_at < datetime('now', '-${INSIGHT_CONSUMED_RETENTION_DAYS} days')`,
		);
		db.run('COMMIT');
		for (const row of rows) {
			payloads.push(row.payload);
		}
	} catch (err) {
		try {
			db.run('ROLLBACK');
		} catch {
			// connection may already be out of the transaction
		}
		throw err;
	}
	return payloads;
}

/** Count pending (unconsumed) candidates — status/diagnostics surface. */
export function countPendingInsightCandidatesDb(directory: string): number {
	if (!hasAnyInsightState(directory)) return 0;
	ensureInsightLegacyImported(directory);
	const db = getProjectDb(directory);
	return (
		db
			.query<{ count: number }, [string]>(
				'SELECT COUNT(*) as count FROM insight_candidate WHERE stream_id = ? AND consumed_at IS NULL',
			)
			.get(INSIGHT_CANDIDATE_STREAM_ID)?.count ?? 0
	);
}

/** List pending payloads, oldest first (postmortem raw-content surface). */
export function listPendingInsightCandidatesDb(
	directory: string,
	max: number,
): string[] {
	if (!hasAnyInsightState(directory)) return [];
	ensureInsightLegacyImported(directory);
	const db = getProjectDb(directory);
	return db
		.query<InsightCandidateTableRow, [string, number]>(
			`SELECT payload FROM insight_candidate
			WHERE stream_id = ? AND consumed_at IS NULL
			ORDER BY version
			LIMIT ?`,
		)
		.all(INSIGHT_CANDIDATE_STREAM_ID, max)
		.map((row) => row.payload);
}

/** Test hook: reset the per-process import guards. */
export function _resetInsightImportGuards(): void {
	importedRoots.clear();
}
