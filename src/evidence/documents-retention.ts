/**
 * Retention for the web_search / web_fetch documents cache at
 * `.swarm/evidence-cache/documents.jsonl`.
 *
 * Background (issue #1184): `writeEvidenceDocuments` in `./documents.ts` is
 * purely append-only. Without this module the cache grows without bound.
 * This module provides a bounded, project-root-contained, atomic-rewrite
 * prune that is invoked only via `/swarm archive` and `/swarm finalize`
 * (never on the plugin init path — AGENTS.md invariant #1).
 *
 * Design contract (mirrors `archiveEvaluationArtifacts` in
 * `../evaluation/retention.ts` where applicable):
 *   - Optional byte cap and optional record-count cap. When both are unset the
 *     prune is a no-op (current append-only behavior preserved exactly).
 *   - Corrupt rows (failed `JSON.parse`) are dropped from the rewrite and
 *     reported via `corrupt` count. They are NOT relocated to a sidecar —
 *     matches the "report, don't relocate" precedent in
 *     `archiveEvaluationArtifacts` (retention.ts:246-254), while still
 *     preserving the bounded-growth contract (a corrupt row otherwise counts
 *     toward caps forever).
 *   - Atomic rewrite via temp file + fsync + rename. NOT under
 *     `withEvidenceLock`: web_search/web_fetch are hot paths and forcing a
 *     lockfile round-trip on every capture is an unjustified latency tax
 *     (issue-tracer critic item #2). The append-vs-rewrite race is a known,
 *     accepted data-loss window: a concurrent `appendFile` whose write is in
 *     flight when the prune renames the temp over the target will, on POSIX,
 *     complete against the now-unlinked old inode (the appended row is
 *     silently lost from the cache). This is accepted because refs are
 *     content-addressed (`evd_<sha256[:16]>`) so a lost row's ref
 *     re-materializes on the next capture of the same content, and because
 *     the prune runs only via explicit `/swarm archive` / `/swarm finalize`,
 *     not on every write.
 *   - Read is streamed line-by-line via `node:readline` with a hard 100 MiB
 *     cap. On cap breach the prune aborts, writes nothing, and leaves the
 *     file byte-identical.
 *   - Windows-safe rename: `EPERM`/`EBUSY`/`ENOTEMPTY`/`EACCES` are retried
 *     with bounded backoff (5× / 10ms). On final failure the temp file is
 *     removed and the original is left untouched (fail-safe).
 *
 * Memory tradeoff (L6-002): valid rows are parsed into a `ParsedRow[]` and
 * retained in memory (raw string + parsed object per row) before selection.
 * The 100 MiB read cap bounds input bytes, but the in-process heap footprint
 * is higher (V8 string + object overhead). This is an accepted tradeoff: the
 * prune runs once per explicit `/swarm archive` / `/swarm finalize` (never on
 * a hot path), the input is bounded, and a streaming rewrite would be a
 * materially larger refactor. If the cache ever needs to scale beyond the
 * current cap, switch `readCacheRows` + `selectSurvivors` to a streaming
 * selection (single pass, write survivors directly to the temp file).
 */
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as readline from 'node:readline';
import { validateSwarmPath } from '../hooks/utils';
import { warn } from '../utils';
import { assertProjectRoot } from '../utils/project-boundary';

const EVIDENCE_CACHE_FILE = 'evidence-cache/documents.jsonl';

/**
 * Hard upper bound on how many bytes `pruneEvidenceDocuments` will read
 * before aborting. Prevents OOM on an attacker-controlled or pathologically
 * large file. 100 MiB is far above any realistic evidence cache (per-record
 * text is capped at 4000 chars in `documents.ts:8`) yet small enough that the
 * read completes well within any reasonable command timeout.
 */
const MAX_READ_BYTES = 100 * 1024 * 1024;

/** Windows-safe rename retry shape (mirrors `readSwarmFileAsync` in hooks/utils.ts). */
const RENAME_MAX_ATTEMPTS = 5;
const RENAME_BACKOFF_MS = 10;
const RENAME_RETRY_CODES = new Set(['EPERM', 'EBUSY', 'ENOTEMPTY', 'EACCES']);

export interface DocumentsRetentionResult {
	/** Total valid (parseable) rows read before pruning. Excludes corrupt rows. */
	inventory: number;
	/** Rows marked for deletion by the policy (same as `inventory - surviving`). */
	selected: number;
	/** Rows actually removed from the file. Always 0 when `dryRun` or `aborted`. */
	archived: number;
	/** Unparseable rows dropped from the rewrite (count only; not preserved). */
	corrupt: number;
	/** File size in bytes before the prune (0 if the file did not exist). */
	bytesBefore: number;
	/** File size in bytes after the prune. Equal to `bytesBefore` on no-op. */
	bytesAfter: number;
	/** True when the prune produced no file mutation. */
	dryRun: boolean;
	/**
	 * True when the read cap (`MAX_READ_BYTES`) was exceeded. On abort the file
	 * is left byte-identical — no temp file, no rewrite, no sidecar.
	 */
	aborted: boolean;
}

export interface PruneEvidenceDocumentsArgs {
	directory: string;
	/** Optional byte cap. When omitted, no byte-based pruning. */
	maxBytes?: number;
	/** Optional record-count cap. When omitted, no count-based pruning. */
	maxRecords?: number;
	/** When true, compute the plan but write nothing. */
	dryRun?: boolean;
}

interface ParsedRow {
	/** Original raw line (without trailing newline). */
	raw: string;
	/** Byte length of `raw` plus the newline that separated it. */
	bytes: number;
	/** Parsed record, or null when JSON.parse failed. */
	record: Record<string, unknown> | null;
}

/** Internal DI seam (AGENTS.md invariant #7 — preferred over mock.module). */
export const _internals: {
	stat: (path: string) => Promise<fs.Stats>;
	createReadStream: (
		path: string,
		options: { encoding: BufferEncoding; highWaterMark: number },
	) => fs.ReadStream;
	openSync: (path: string, flags: fs.OpenMode) => number;
	writeSync: (fd: number, data: string, position?: number | null) => number;
	fsyncSync: (fd: number) => void;
	closeSync: (fd: number) => void;
	renameWithRetry: (src: string, dst: string) => Promise<void>;
	unlink: (path: string) => Promise<void>;
} = {
	stat: (p) => fsp.stat(p),
	createReadStream: (p, options) => fs.createReadStream(p, options),
	openSync: (p, flags) => fs.openSync(p, flags),
	writeSync: (fd, data, position) => fs.writeSync(fd, data, position),
	fsyncSync: (fd) => fs.fsyncSync(fd),
	closeSync: (fd) => fs.closeSync(fd),
	renameWithRetry: atomicRenameWithRetry,
	unlink: (p) => fsp.unlink(p),
};

/**
 * Atomic rename with bounded retry for Windows.
 *
 * On Windows, `fs.rename` over an existing file can fail with `EPERM` when
 * another handle (e.g. a concurrent `appendFile` from web_search) holds the
 * target. We retry the rename a bounded number of times with a short backoff
 * (the `readSwarmFileAsync` precedent in `hooks/utils.ts:263` uses the same
 * 5× / 10ms shape for the macOS rename-visibility race). On final failure we
 * rethrow — the caller is responsible for cleaning up the temp file.
 *
 * The optional `renameFn` is a test seam (defaults to `fsp.rename`) so the
 * retry loop can be exercised deterministically on non-Windows hosts.
 */
export async function atomicRenameWithRetry(
	src: string,
	dst: string,
	renameFn: (s: string, d: string) => Promise<void> = fsp.rename,
): Promise<void> {
	let lastErr: unknown;
	for (let attempt = 0; attempt < RENAME_MAX_ATTEMPTS; attempt++) {
		try {
			await renameFn(src, dst);
			return;
		} catch (err) {
			lastErr = err;
			const code = (err as NodeJS.ErrnoException)?.code;
			if (!code || !RENAME_RETRY_CODES.has(code)) {
				throw err;
			}
			if (attempt < RENAME_MAX_ATTEMPTS - 1) {
				await new Promise((resolve) => setTimeout(resolve, RENAME_BACKOFF_MS));
			}
		}
	}
	throw lastErr;
}

function emptyResult(dryRun: boolean): DocumentsRetentionResult {
	return {
		inventory: 0,
		selected: 0,
		archived: 0,
		corrupt: 0,
		bytesBefore: 0,
		bytesAfter: 0,
		dryRun,
		aborted: false,
	};
}

/**
 * Stream the cache file line by line, parsing each row. Aborts if the total
 * bytes read would exceed `MAX_READ_BYTES`.
 *
 * Returns `{ rows, corrupt, aborted, bytesBefore }`. On `aborted: true` the
 * caller must not perform any rewrite.
 */
async function readCacheRows(filePath: string): Promise<{
	rows: ParsedRow[];
	corrupt: number;
	aborted: boolean;
	bytesBefore: number;
}> {
	const stat = await _internals.stat(filePath);
	const bytesBefore = stat.size;
	const stream = _internals.createReadStream(filePath, {
		encoding: 'utf8',
		// 64 KiB chunks balance syscall overhead against memory pressure.
		highWaterMark: 64 * 1024,
	});
	const rl = readline.createInterface({
		input: stream,
		crlfDelay: Infinity,
	});

	const rows: ParsedRow[] = [];
	let corrupt = 0;
	let bytesRead = 0;
	let aborted = false;

	// Cleanup runs in finally so a stream 'error' event (e.g. EIO mid-read)
	// cannot skip rl.close()/stream.destroy() and leak the file handle (PRR-003).
	try {
		for await (const line of rl) {
			// readline strips the trailing newline; account for it (LF or CRLF).
			// We cannot know which without inspecting the raw stream, so use LF
			// (1 byte) as the conservative lower bound — the cap is a safety
			// guard, not an exact budget. Note: the rewrite (see rewriteAtomic)
			// always joins survivors with '\n', so a CRLF source is normalized
			// to LF on rewrite; bytesAfter reflects the post-normalization size
			// (PRR-013).
			const lineBytes = Buffer.byteLength(line, 'utf8') + 1;
			bytesRead += lineBytes;
			if (bytesRead > MAX_READ_BYTES) {
				aborted = true;
				break;
			}
			if (line.length === 0) continue;
			let record: Record<string, unknown> | null = null;
			try {
				const parsed = JSON.parse(line);
				if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
					record = parsed as Record<string, unknown>;
				} else {
					corrupt++;
					continue;
				}
			} catch {
				corrupt++;
				continue;
			}
			rows.push({ raw: line, bytes: lineBytes, record });
		}
	} finally {
		// Ensure the stream is fully released on every path (normal exit,
		// break, or thrown stream error).
		rl.close();
		stream.destroy();
	}

	return { rows, corrupt, aborted, bytesBefore };
}

/**
 * Sort comparator: oldest first by `capturedAt` (ISO string). Falls back to
 * original raw content for a stable, deterministic tiebreak — never to array
 * index (which would be non-deterministic across reads on some platforms).
 */
function oldestFirst(a: ParsedRow, b: ParsedRow): number {
	const at =
		typeof a.record?.capturedAt === 'string'
			? (a.record.capturedAt as string)
			: '';
	const bt =
		typeof b.record?.capturedAt === 'string'
			? (b.record.capturedAt as string)
			: '';
	if (at === bt) return a.raw.localeCompare(b.raw);
	return at.localeCompare(bt);
}

/** Select which rows survive after applying count and byte caps. */
function selectSurvivors(
	rows: ParsedRow[],
	maxRecords?: number,
	maxBytes?: number,
): { survivors: ParsedRow[]; selected: number } {
	// Work on a oldest-first copy so "drop oldest" is index-based and stable.
	const ordered = [...rows].sort(oldestFirst);

	// Count cap: keep the newest `maxRecords` rows (drop oldest via slice).
	let keepFrom = 0;
	if (typeof maxRecords === 'number' && ordered.length > maxRecords) {
		keepFrom = ordered.length - maxRecords;
	}

	// Byte cap: advance `keepFrom` forward (dropping oldest) until the
	// surviving tail is at or under the byte cap. Using an index instead of
	// repeated Array.shift() keeps this O(n) rather than O(n²) (L6-001).
	// `total` must start from the post-count-cap survivors (ordered[keepFrom:])
	// — NOT all rows — so rows already dropped by the count cap are not
	// double-subtracted (final-critic regression: without this, tight combined
	// caps over-prune to an empty file).
	if (typeof maxBytes === 'number' && maxBytes > 0) {
		let total = 0;
		for (let i = keepFrom; i < ordered.length; i++) {
			total += ordered[i].bytes;
		}
		while (keepFrom < ordered.length && total > maxBytes) {
			total -= ordered[keepFrom].bytes;
			keepFrom++;
		}
	}

	const survivors = ordered.slice(keepFrom);
	const selected = rows.length - survivors.length;
	return { survivors, selected };
}

/**
 * Atomically rewrite the cache file with the surviving rows.
 *
 * Writes to `${filePath}.tmp.${ts}.${pid}`, fsyncs, then renames over the
 * target with Windows-safe retry. On ANY failure (open, write, fsync, or
 * rename) the temp file is removed and the original is left untouched
 * (fail-safe: prefer no-change over partial-change). The temp file is
 * tracked from open through successful rename so every error path cleans
 * it up.
 */
async function rewriteAtomic(
	filePath: string,
	survivors: ParsedRow[],
): Promise<number> {
	const tmpPath = `${filePath}.tmp.${Date.now()}.${process.pid}`;
	const payload =
		survivors.length > 0
			? `${survivors.map((row) => row.raw).join('\n')}\n`
			: '';
	// `succeeded` flips to true only after the rename lands. The outer
	// finally uses it to decide whether to clean up the temp file: on every
	// error path (open/write/fsync/rename) the temp is removed; on success
	// the temp no longer exists (it became the target via rename).
	let succeeded = false;
	const fd = _internals.openSync(tmpPath, 'w');
	try {
		_internals.writeSync(fd, payload, 0);
		_internals.fsyncSync(fd);
		_internals.closeSync(fd);
		await _internals.renameWithRetry(tmpPath, filePath);
		succeeded = true;
	} catch (err) {
		// Ensure the fd is closed on write/fsync/rename failure (closeSync is
		// idempotent-ish: a double-close throws EBADF which we swallow).
		try {
			_internals.closeSync(fd);
		} catch {
			// Already closed or close failed — best effort.
		}
		const msg = err instanceof Error ? err.message : String(err);
		throw new Error(`documents-cache rewrite failed: ${msg}`);
	} finally {
		if (!succeeded) {
			try {
				await _internals.unlink(tmpPath);
			} catch {
				// Best-effort cleanup; the OS will reap an orphaned tmp file.
			}
		}
	}
	return Buffer.byteLength(payload, 'utf8');
}

/**
 * Apply the configured byte/count retention policy to the documents cache.
 *
 * Safe to call on a missing file (returns an idempotent zeroed result) and
 * safe to call with both caps unset (no-op). Never throws for routine cases;
 * surfaces unexpected I/O errors to the caller (archive command fails open).
 */
export async function pruneEvidenceDocuments(
	args: PruneEvidenceDocumentsArgs,
): Promise<DocumentsRetentionResult> {
	assertProjectRoot(args.directory);
	const dryRun = args.dryRun === true;
	const capsUnset =
		(typeof args.maxBytes !== 'number' || args.maxBytes <= 0) &&
		(typeof args.maxRecords !== 'number' || args.maxRecords <= 0);

	const filePath = validateSwarmPath(args.directory, EVIDENCE_CACHE_FILE);

	// Missing file: idempotent no-op. Only ENOENT is treated as "missing";
	// other stat errors (EACCES, EIO, ELOOP, ...) are rethrown so the caller
	// (archive command, fail-open) can log the real cause instead of masking
	// it as a benign missing-file no-op (PRR-002).
	let stat: fs.Stats;
	try {
		stat = await _internals.stat(filePath);
	} catch (err) {
		const code = (err as NodeJS.ErrnoException)?.code;
		if (code === 'ENOENT') return emptyResult(dryRun);
		throw err;
	}

	// No caps configured: preserve append-only behavior, report size only.
	if (capsUnset) {
		return {
			inventory: 0,
			selected: 0,
			archived: 0,
			corrupt: 0,
			bytesBefore: stat.size,
			bytesAfter: stat.size,
			dryRun,
			aborted: false,
		};
	}

	let readResult: {
		rows: ParsedRow[];
		corrupt: number;
		aborted: boolean;
		bytesBefore: number;
	};
	try {
		readResult = await readCacheRows(filePath);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		warn(`documents-cache prune: read failed: ${msg}`);
		throw err;
	}

	if (readResult.aborted) {
		warn(
			`documents-cache prune: aborted, file exceeds ${MAX_READ_BYTES} bytes; left untouched`,
		);
		return {
			inventory: readResult.rows.length,
			selected: 0,
			archived: 0,
			corrupt: readResult.corrupt,
			bytesBefore: readResult.bytesBefore,
			bytesAfter: readResult.bytesBefore,
			dryRun,
			aborted: true,
		};
	}

	const { survivors, selected } = selectSurvivors(
		readResult.rows,
		args.maxRecords,
		args.maxBytes,
	);

	if (dryRun) {
		// Compute the post-prune byte size without writing.
		const bytesAfter = survivors.reduce((sum, row) => sum + row.bytes, 0);
		return {
			inventory: readResult.rows.length,
			selected,
			archived: 0,
			corrupt: readResult.corrupt,
			bytesBefore: readResult.bytesBefore,
			bytesAfter,
			dryRun: true,
			aborted: false,
		};
	}

	if (selected === 0 && readResult.corrupt === 0) {
		// Nothing to do — avoid an unnecessary rewrite entirely.
		return {
			inventory: readResult.rows.length,
			selected: 0,
			archived: 0,
			corrupt: 0,
			bytesBefore: readResult.bytesBefore,
			bytesAfter: readResult.bytesBefore,
			dryRun: false,
			aborted: false,
		};
	}

	const bytesAfter = await rewriteAtomic(filePath, survivors);

	return {
		inventory: readResult.rows.length,
		selected,
		archived: selected,
		corrupt: readResult.corrupt,
		bytesBefore: readResult.bytesBefore,
		bytesAfter,
		dryRun: false,
		aborted: false,
	};
}
