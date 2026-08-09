/**
 * Transactionally-consistent SQLite snapshot for `/swarm close` archival.
 *
 * Why this exists (issue #2030): the legacy `copySqliteSafe` in `close.ts`
 * copied ONLY the main `swarm.db` file, either via an external `sqlite3` CLI
 * (forbidden external dependency — AGENTS.md invariant 2/3) or, when that CLI
 * was absent (common on Windows), via a raw `fs.copyFile` of the main file with
 * NO checkpoint at all. For a WAL-mode database (`PRAGMA journal_mode = WAL`,
 * set in `src/db/project-db.ts`), committed rows live in `swarm.db-wal` while
 * the main file is a stale shell — so the archived copy silently lost every
 * committed row.
 *
 * The fix is an in-process `VACUUM INTO` snapshot taken from a dedicated
 * connection created through the shared, runtime-portable loader
 * (`src/db/sqlite-loader.ts`). Verified under both Bun — native bun:sqlite —
 * and Node — the loader's node:sqlite `DatabaseSync` adapter — by the issue #2030
 * spike (`.zcode/issue-traces/2030/spike-vacuum-into.mjs`): the destination is
 * a single self-contained file (journal_mode=delete, no WAL sidecars) that
 * contains ALL committed rows and EXCLUDES a concurrent uncommitted writer's
 * row, with `PRAGMA integrity_check = ok`.
 *
 * Contract: the source `main`/`wal`/`shm` are preserved on EVERY failure path.
 * This function never deletes the source. `source_disposition` is `retained`
 * (or `absent` when the source does not exist); the `'removed'` disposition is
 * reserved for the clean stage's archive-first guard, which is the only place
 * authorized to delete an archived source.
 */

import type { Database } from 'bun:sqlite';
import * as fsSync from 'node:fs';
import path from 'node:path';
import { loadDatabaseCtor } from '../db/sqlite-loader';

// ── Result types ────────────────────────────────────────────────────────────

export type ArchiveSqliteMethod = 'vacuum_into';

export type ArchiveSqliteReasonCode =
	| 'ok'
	| 'source_absent'
	| 'source_over_budget'
	| 'snapshot_failed'
	| 'validation_failed'
	| 'schema_mismatch'
	| 'publish_failed';

/**
 * Domain row counts captured during validation. Counts ONLY — no row content
 * is ever read into memory or logged, per issue #2030 item 4 ("without logging
 * row content"). A missing domain table (legacy schema) reports count 0 rather
 * than failing validation, because integrity + schema_migrations presence is the
 * real health signal.
 */
export interface SqliteRowCounts {
	schema_migrations_max_version: number | null;
	project_constraints: number;
	qa_gate_profile: number;
}

export interface ArchiveSqliteOptions {
	/** Absolute path to the live source DB, e.g. `.swarm/swarm.db`. */
	sourcePath: string;
	/** Absolute path to the archive bundle directory (must exist). */
	destDir: string;
	/** Filename to publish in the bundle, e.g. `swarm.db`. */
	destName: string;
	/**
	 * Hard byte-budget preflight: sum of source `main` + `wal` + `shm` sizes.
	 * If exceeded, the snapshot is not attempted (no expensive work). The
	 * default 2 GiB ceiling is generous for project DBs while still catching
	 * the pathological "archived the wrong 66 GB host DB" failure mode.
	 */
	maxSourceBytes?: number;
	/** `PRAGMA busy_timeout` on the snapshot connection. Default 5000 ms. */
	busyTimeoutMs?: number;
}

export interface ArchiveSqliteResult {
	requiredness: 'required';
	attempt: 'not_attempted' | 'succeeded' | 'failed';
	validation: 'not_applicable' | 'passed' | 'failed';
	source_disposition: 'absent' | 'retained';
	method: ArchiveSqliteMethod | 'none';
	reason_code: ArchiveSqliteReasonCode;
	/** Absolute, only on success. */
	destPath?: string;
	/** Counts only, present when validation runs. */
	rowCounts?: SqliteRowCounts;
	/** Non-sensitive diagnostic (errno / short message). No row content. */
	detail?: string;
}

const DEFAULT_MAX_SOURCE_BYTES = 2 * 1024 * 1024 * 1024; // 2 GiB
const DEFAULT_BUSY_TIMEOUT_MS = 5000;

/**
 * Test-only dependency-injection seam. `loadDatabaseCtor` is imported directly
 * (it is a stable public API) and is NOT part of this seam. The fields here are
 * only those tests genuinely substitute: `DatabaseCtor` lets a failure-injection
 * test swap the constructor without touching the real loader; the fs/time
 * helpers let deterministic tests control temp-path generation and filesystem
 * behavior. Mutate this object in `beforeEach` and restore in `afterEach`
 * (AGENTS.md invariant 7 — prefer `_internals` DI over `mock.module`).
 */
export const _internals: {
	existsSync: typeof fsSync.existsSync;
	statSync: typeof fsSync.statSync;
	renameSync: typeof fsSync.renameSync;
	rmSync: typeof fsSync.rmSync;
	now: () => number;
	randomSuffix: () => string;
	/**
	 * When non-null, overrides `loadDatabaseCtor()` for failure injection
	 * (e.g. a fake ctor whose `VACUUM INTO` throws). Leave null in production
	 * and in tests that exercise the real driver.
	 */
	DatabaseCtor: typeof Database | null;
} = {
	existsSync: fsSync.existsSync,
	statSync: fsSync.statSync,
	renameSync: fsSync.renameSync,
	rmSync: fsSync.rmSync,
	now: () => Date.now(),
	randomSuffix: () => Math.random().toString(36).slice(2, 8),
	DatabaseCtor: null,
};

/**
 * Resolve the Database constructor to use for this invocation: the injected
 * fake when set, otherwise the runtime-portable loader.
 */
function resolveDatabaseCtor(): typeof Database {
	return _internals.DatabaseCtor ?? loadDatabaseCtor();
}

/**
 * Remove a failed temp destination without throwing. On Windows an antivirus
 * indexer can briefly hold the file (EPERM); `rmSync` with `maxRetries` waits
 * it out. A leftover temp inside the unique archive dir is harmless — the dir
 * is fresh per close, so it never collides with real artifacts.
 */
function safeRemoveTemp(tempPath: string): void {
	try {
		// `recursive: true` is required for `maxRetries`/`retryDelay` to take
		// effect on Node (the retry logic only runs in recursive mode), which is
		// what makes the Windows antivirus-EPERM retry actually fire.
		_internals.rmSync(tempPath, {
			force: true,
			recursive: true,
			maxRetries: 3,
			retryDelay: 100,
		});
	} catch {
		// Stale temp in a unique archive dir is acceptable and non-fatal.
	}
}

/**
 * Build a `VACUUM INTO '<path>'` SQL string with the destination POSIX-normalized
 * and single-quote-escaped. SQLite's `VACUUM INTO` accepts a quoted string
 * literal for the destination filename; forward slashes work on all platforms
 * and avoid Windows-backslash escaping pitfalls inside SQL.
 */
function buildVacuumIntoSql(destPath: string): string {
	const posix = destPath.replace(/\\/g, '/');
	const escaped = posix.replace(/'/g, "''");
	return `VACUUM INTO '${escaped}'`;
}

/**
 * Coerce a `PRAGMA`/`SELECT` result row — a plain object under both the bun
 * and node sqlite drivers — into a string value for the given column. Returns
 * '' when the row or column is absent.
 */
function rowString(row: unknown, col: string): string {
	if (
		row &&
		typeof row === 'object' &&
		col in (row as Record<string, unknown>)
	) {
		const v = (row as Record<string, unknown>)[col];
		return v === null || v === undefined ? '' : String(v);
	}
	return '';
}

function rowNumber(row: unknown, col: string): number | null {
	if (
		row &&
		typeof row === 'object' &&
		col in (row as Record<string, unknown>)
	) {
		const v = (row as Record<string, unknown>)[col];
		if (typeof v === 'number' && Number.isFinite(v)) return v;
		if (typeof v === 'bigint') return Number(v);
		if (typeof v === 'string') {
			const n = Number(v);
			if (Number.isFinite(n)) return n;
		}
	}
	return null;
}

/**
 * Capture domain row counts from the snapshot WITHOUT reading row content.
 * A missing domain table (legacy/older schema) reports 0 — validation does not
 * fail on table absence, only on integrity failure or a missing `schema_migrations`.
 */
function captureRowCounts(db: Database): SqliteRowCounts {
	const tableExists = (name: string): boolean => {
		const row = db
			.query(
				"SELECT COUNT(*) AS c FROM sqlite_master WHERE type='table' AND name=?",
			)
			.get(name);
		return rowNumber(row, 'c') !== null && (rowNumber(row, 'c') ?? 0) > 0;
	};

	let schemaMigrationsMax: number | null = null;
	if (tableExists('schema_migrations')) {
		const row = db
			.query('SELECT MAX(version) AS m FROM schema_migrations')
			.get();
		schemaMigrationsMax = rowNumber(row, 'm');
	}

	const projectConstraints = tableExists('project_constraints')
		? (rowNumber(
				db.query('SELECT COUNT(*) AS c FROM project_constraints').get(),
				'c',
			) ?? 0)
		: 0;
	const qaGateProfile = tableExists('qa_gate_profile')
		? (rowNumber(
				db.query('SELECT COUNT(*) AS c FROM qa_gate_profile').get(),
				'c',
			) ?? 0)
		: 0;

	return {
		schema_migrations_max_version: schemaMigrationsMax,
		project_constraints: projectConstraints,
		qa_gate_profile: qaGateProfile,
	};
}

/**
 * Produce a transactionally-consistent single-file snapshot of the source WAL
 * database via in-process `VACUUM INTO`, validate it read-only through the
 * shared loader, then atomically publish it into the archive bundle.
 *
 * Non-destructive: on every error path the source `main`/`wal`/`shm` are left
 * untouched and `source_disposition` is `retained` (or `absent`).
 */
export async function archiveSqliteSnapshot(
	opts: ArchiveSqliteOptions,
): Promise<ArchiveSqliteResult> {
	const maxSourceBytes = opts.maxSourceBytes ?? DEFAULT_MAX_SOURCE_BYTES;
	const busyTimeoutMs = opts.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS;

	// 1) Source existence. VACUUM INTO on a missing source would fabricate an
	//    empty DB; gate explicitly so absence is reported as `absent`.
	if (!_internals.existsSync(opts.sourcePath)) {
		return {
			requiredness: 'required',
			attempt: 'not_attempted',
			validation: 'not_applicable',
			source_disposition: 'absent',
			method: 'none',
			reason_code: 'source_absent',
		};
	}

	// 2) Byte-budget preflight over main + wal + shm before any expensive work.
	//    A stat failure on the MAIN file is fatal (the budget cannot be
	//    meaningfully computed without it and the snapshot would likely fail
	//    anyway); a stat failure on a transient sidecar is tolerated so a
	//    temporary EBUSY on -wal/-shm does not abort a viable snapshot.
	let sourceBytes = 0;
	for (const suffix of ['', '-wal', '-shm']) {
		const sidecar = opts.sourcePath + suffix;
		if (!_internals.existsSync(sidecar)) continue;
		try {
			sourceBytes += _internals.statSync(sidecar).size;
		} catch (err) {
			if (suffix === '') {
				// Main-file stat failure — the "hard" budget must not fail open.
				return {
					requiredness: 'required',
					attempt: 'failed',
					validation: 'not_applicable',
					source_disposition: 'retained',
					method: 'vacuum_into',
					reason_code: 'snapshot_failed',
					detail: `source stat failed: ${err instanceof Error ? err.message : String(err)}`,
				};
			}
			// Sidecar stat failure — tolerate; the snapshot may still succeed.
		}
	}
	if (sourceBytes > maxSourceBytes) {
		return {
			requiredness: 'required',
			attempt: 'not_attempted',
			validation: 'not_applicable',
			source_disposition: 'retained',
			method: 'none',
			reason_code: 'source_over_budget',
			detail: `source bytes ${sourceBytes} > budget ${maxSourceBytes}`,
		};
	}

	// 3) Snapshot to a unique, non-existing temp path via VACUUM INTO from a
	//    DEDICATED connection (does not disturb the app's long-lived connection).
	const destFinal = path.join(opts.destDir, opts.destName);
	const destTemp = path.join(
		opts.destDir,
		`.${opts.destName}.tmp.${_internals.now()}.${_internals.randomSuffix()}`,
	);

	let Db: typeof Database;
	try {
		Db = resolveDatabaseCtor();
	} catch (err) {
		return {
			requiredness: 'required',
			attempt: 'failed',
			validation: 'not_applicable',
			source_disposition: 'retained',
			method: 'vacuum_into',
			reason_code: 'snapshot_failed',
			detail: `driver unavailable: ${err instanceof Error ? err.message : String(err)}`,
		};
	}

	let snapshotDb: Database | null = null;
	try {
		snapshotDb = new Db(opts.sourcePath);
		try {
			snapshotDb.run(`PRAGMA busy_timeout = ${busyTimeoutMs};`);
			snapshotDb.run(buildVacuumIntoSql(destTemp));
		} finally {
			snapshotDb.close();
			snapshotDb = null;
		}
	} catch (err) {
		if (snapshotDb) {
			try {
				snapshotDb.close();
			} catch {
				// best-effort
			}
		}
		safeRemoveTemp(destTemp);
		return {
			requiredness: 'required',
			attempt: 'failed',
			validation: 'not_applicable',
			source_disposition: 'retained',
			method: 'vacuum_into',
			reason_code: 'snapshot_failed',
			detail: err instanceof Error ? err.message : String(err),
		};
	}

	// 4) Validate the snapshot read-only via the shared loader.
	let rowCounts: SqliteRowCounts;
	let verifyDb: Database | null = null;
	try {
		verifyDb = new Db(destTemp);
		// PRAGMA query_only blocks ALL writes for this connection. Verified
		// under node:sqlite (INSERT raises "attempt to write a readonly
		// database") and identical under bun:sqlite. This is the single
		// deterministic read-only mechanism across both drivers (URI ?mode=ro
		// is NOT supported by node:sqlite's DatabaseSync).
		verifyDb.run('PRAGMA query_only = ON;');

		const integrityRow = verifyDb.query('PRAGMA integrity_check').get();
		const integrity = rowString(integrityRow, 'integrity_check');
		if (integrity !== 'ok') {
			verifyDb.close();
			verifyDb = null;
			safeRemoveTemp(destTemp);
			return {
				requiredness: 'required',
				attempt: 'failed',
				validation: 'failed',
				source_disposition: 'retained',
				method: 'vacuum_into',
				reason_code: 'validation_failed',
				detail: `integrity_check: ${integrity || '(empty)'}`,
			};
		}

		const hasMigrations =
			rowNumber(
				verifyDb
					.query(
						"SELECT COUNT(*) AS c FROM sqlite_master WHERE type='table' AND name='schema_migrations'",
					)
					.get(),
				'c',
			) ?? 0;
		if (hasMigrations < 1) {
			verifyDb.close();
			verifyDb = null;
			safeRemoveTemp(destTemp);
			return {
				requiredness: 'required',
				attempt: 'failed',
				validation: 'failed',
				source_disposition: 'retained',
				method: 'vacuum_into',
				reason_code: 'schema_mismatch',
				detail: 'schema_migrations table absent',
			};
		}

		rowCounts = captureRowCounts(verifyDb);
		verifyDb.close();
		verifyDb = null;
	} catch (err) {
		if (verifyDb) {
			try {
				verifyDb.close();
			} catch {
				// best-effort
			}
		}
		safeRemoveTemp(destTemp);
		return {
			requiredness: 'required',
			attempt: 'failed',
			validation: 'failed',
			source_disposition: 'retained',
			method: 'vacuum_into',
			reason_code: 'validation_failed',
			detail: err instanceof Error ? err.message : String(err),
		};
	}

	// 5) Atomic publish: rename temp -> final (same filesystem → atomic).
	try {
		_internals.renameSync(destTemp, destFinal);
	} catch (err) {
		safeRemoveTemp(destTemp);
		return {
			requiredness: 'required',
			attempt: 'failed',
			validation: 'passed',
			source_disposition: 'retained',
			method: 'vacuum_into',
			reason_code: 'publish_failed',
			detail: err instanceof Error ? err.message : String(err),
			rowCounts,
		};
	}

	// 6) Success.
	return {
		requiredness: 'required',
		attempt: 'succeeded',
		validation: 'passed',
		source_disposition: 'retained',
		method: 'vacuum_into',
		reason_code: 'ok',
		destPath: destFinal,
		rowCounts,
	};
}
