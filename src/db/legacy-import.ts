/**
 * Idempotent legacy file → swarm.db import (issue #2480 obligation 3).
 *
 * Contract (docs/sqlite-durable-state.md §Legacy import):
 * - Legacy artifact PRESENT + target table/stream EMPTY → import every record
 *   in ONE `BEGIN IMMEDIATE` transaction (emptiness re-checked inside the
 *   transaction so a concurrent importer cannot double-import) → on commit,
 *   rename the artifact to `<name>.imported` (bounded Windows rename retry).
 * - Crash before commit → nothing imported; the next run retries (idempotent).
 * - Crash after commit before rename → the next run sees a NON-empty table;
 *   the stale file is left in place (never re-imported, never silently
 *   deleted) with a once-per-process warning. This also covers a file that
 *   reappeared because an older plugin version wrote it again: those lines
 *   are preserved on disk rather than destroyed.
 * - Artifact absent, or table already populated → no-op.
 *
 * Import runs lazily on first store use, never at plugin init (the
 * knowledge-receipts migration precedent).
 */

import {
	existsSync,
	readdirSync,
	readFileSync,
	renameSync,
	statSync,
} from 'node:fs';
import { join } from 'node:path';
import { warn } from '../utils/logger.js';
import { canonicalProjectKey } from './canonical-project.js';
import { getProjectDb } from './project-db.js';

/** Bounded rename retry (Windows EPERM/EACCES on freshly-written files). */
const RENAME_RETRIES = 20;
const RENAME_RETRY_DELAY_MS = 5;

const warnedStaleLegacy = new Set<string>();

/**
 * Size cap for a single legacy artifact import (#2480 review F-02 — same
 * guard convention as MAX_TRACEABILITY_BYTES in design-doc-drift). The live
 * stores were FIFO/entry-bounded when they were files, so anything beyond
 * this is pathological; it is skipped inert (never imported, never renamed)
 * rather than loaded into memory.
 */
export const MAX_LEGACY_IMPORT_BYTES = 32 * 1024 * 1024;

export interface LegacyImportResult {
	/** Rows imported (0 when the import conditions were not met). */
	imported: number;
	/** Lines/files skipped because they failed validation. */
	skipped: number;
	/** True when the legacy artifact was renamed to `.imported`. */
	archived: boolean;
}

function sleepSync(ms: number): void {
	const shared = new SharedArrayBuffer(4);
	Atomics.wait(new Int32Array(shared), 0, 0, ms);
}

function renameWithRetry(from: string, to: string): void {
	let lastErr: unknown;
	for (let attempt = 0; attempt < RENAME_RETRIES; attempt++) {
		try {
			_internals.renameSync(from, to);
			return;
		} catch (err) {
			lastErr = err;
			const code = (err as NodeJS.ErrnoException | null)?.code;
			if (code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY') throw err;
			sleepSync(RENAME_RETRY_DELAY_MS);
		}
	}
	throw lastErr;
}

function warnStaleLegacyOnce(key: string, fileName: string): void {
	const guard = `${key}::${fileName}`;
	if (warnedStaleLegacy.has(guard)) return;
	warnedStaleLegacy.add(guard);
	warn(
		`[swarm.db] legacy artifact ${fileName} is present but the target table is non-empty; leaving the file untouched (it is inert — readers use swarm.db)`,
	);
}

/**
 * DI seam for tests: the LOW-LEVEL rename is fault-injectable so the retry
 * loop itself stays under test (replacing the loop would test nothing).
 */
export const _internals: {
	renameSync: typeof renameSync;
	warnStaleLegacyOnce: typeof warnStaleLegacyOnce;
	maxLegacyImportBytes: () => number;
} = {
	renameSync,
	warnStaleLegacyOnce,
	maxLegacyImportBytes: () => MAX_LEGACY_IMPORT_BYTES,
};

/**
 * Import a legacy `.jsonl` file into an append-only stream table.
 *
 * `parseLine` returns the row payload string for a valid line or null to skip
 * (corrupt line). Rows are inserted with versions 1..n in file order. The
 * emptiness probe is `streamCount(db)` (e.g. rows for the stream).
 */
export function importLegacyJsonl(
	directory: string,
	opts: {
		fileName: string;
		/** Count existing rows for the target stream (inside the txn). */
		streamCount: (db: ReturnType<typeof getProjectDb>) => number;
		/** Insert one row at the given version; payload from the parsed line. */
		insertRow: (
			db: ReturnType<typeof getProjectDb>,
			version: number,
			payload: string,
		) => void;
		parseLine: (line: string) => string | null;
	},
): LegacyImportResult {
	const root = canonicalProjectKey(directory);
	const filePath = join(root, '.swarm', opts.fileName);
	if (!existsSync(filePath)) {
		return { imported: 0, skipped: 0, archived: false };
	}
	const db = getProjectDb(directory);

	let content: string;
	try {
		if (statSync(filePath).size > _internals.maxLegacyImportBytes()) {
			warn(
				`[swarm.db] legacy artifact ${opts.fileName} exceeds the import size cap; leaving it inert (not imported, not renamed)`,
			);
			return { imported: 0, skipped: 0, archived: false };
		}
		content = readFileSync(filePath, 'utf-8');
	} catch {
		return { imported: 0, skipped: 0, archived: false };
	}

	const payloads: string[] = [];
	let skipped = 0;
	for (const line of content.split('\n')) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		const payload = opts.parseLine(trimmed);
		if (payload === null) {
			skipped++;
			continue;
		}
		payloads.push(payload);
	}

	let imported = 0;
	db.run('BEGIN IMMEDIATE');
	try {
		if (opts.streamCount(db) === 0) {
			for (const payload of payloads) {
				imported += 1;
				opts.insertRow(db, imported, payload);
			}
		}
		db.run('COMMIT');
	} catch (err) {
		try {
			db.run('ROLLBACK');
		} catch {
			// connection may already be out of the transaction
		}
		throw err;
	}

	if (imported > 0) {
		try {
			renameWithRetry(filePath, `${filePath}.imported`);
			return { imported, skipped, archived: true };
		} catch {
			// Committed but not archived: idempotent next-run no-op (table is
			// non-empty) + the stale-file warning below on later runs.
			return { imported, skipped, archived: false };
		}
	}
	// Warn only when the file held VALID content that was not imported (the
	// table was non-empty — a stale leftover). A file of only blank/corrupt
	// lines imported nothing legitimately; it is inert, not stale.
	if (payloads.length > 0) {
		_internals.warnStaleLegacyOnce(root, opts.fileName);
	}
	return { imported: 0, skipped, archived: false };
}

/**
 * Import a family of legacy `.json` files into an entity table keyed by
 * `(kind, phase)`. Files are discovered by exact prefix/suffix match in
 * `.swarm/` (readdir — no user-supplied paths), the phase is parsed from the
 * filename, and each file's parsed+validated object becomes the row payload.
 */
export function importLegacyJsonFiles(
	directory: string,
	opts: {
		filePrefix: string;
		kind: string;
		/** Count existing rows for the kind (inside the txn). */
		kindCount: (db: ReturnType<typeof getProjectDb>) => number;
		/** Upsert one row; payload is the serialized JSON file content. */
		upsertRow: (
			db: ReturnType<typeof getProjectDb>,
			phase: number,
			payload: string,
		) => void;
	},
): LegacyImportResult {
	const root = canonicalProjectKey(directory);
	const swarmDir = join(root, '.swarm');
	let entries: string[];
	try {
		entries = readdirSync(swarmDir);
	} catch {
		return { imported: 0, skipped: 0, archived: false };
	}
	const suffix = '.json';
	const phaseRe = new RegExp(`^${opts.filePrefix}(\\d+)\\${suffix}$`);
	const files = entries.filter(
		(name) =>
			name.startsWith(opts.filePrefix) &&
			name.endsWith(suffix) &&
			!name.includes('.imported'),
	);
	if (files.length === 0) {
		return { imported: 0, skipped: 0, archived: false };
	}

	const parsed: Array<{ phase: number; payload: string; fileName: string }> =
		[];
	let skipped = 0;
	for (const fileName of files) {
		const match = phaseRe.exec(fileName);
		if (!match) {
			skipped++;
			continue;
		}
		try {
			const abs = join(swarmDir, fileName);
			if (statSync(abs).size > _internals.maxLegacyImportBytes()) {
				skipped++;
				continue;
			}
			const raw = readFileSync(abs, 'utf-8');
			JSON.parse(raw);
			parsed.push({ phase: Number(match[1]), payload: raw, fileName });
		} catch {
			skipped++;
		}
	}

	const db = getProjectDb(directory);
	let imported = 0;
	const archivedNames: string[] = [];
	db.run('BEGIN IMMEDIATE');
	try {
		if (opts.kindCount(db) === 0 && parsed.length > 0) {
			for (const item of parsed) {
				imported += 1;
				opts.upsertRow(db, item.phase, item.payload);
				archivedNames.push(item.fileName);
			}
		}
		db.run('COMMIT');
	} catch (err) {
		try {
			db.run('ROLLBACK');
		} catch {
			// connection may already be out of the transaction
		}
		throw err;
	}

	if (imported > 0) {
		for (const fileName of archivedNames) {
			try {
				renameWithRetry(
					join(swarmDir, fileName),
					join(swarmDir, `${fileName}.imported`),
				);
			} catch {
				// committed-but-unarchived: inert leftover, warned on later runs
			}
		}
		return { imported, skipped, archived: archivedNames.length > 0 };
	}
	if (parsed.length > 0) {
		_internals.warnStaleLegacyOnce(root, `${opts.filePrefix}*`);
	}
	return { imported: 0, skipped, archived: false };
}
