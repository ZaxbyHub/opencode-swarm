import {
	linkSync,
	mkdirSync,
	readdirSync,
	rmSync,
	statSync,
	unlinkSync,
} from 'node:fs';
import * as path from 'node:path';
import { readSwarmFileAsync, validateSwarmPath } from '../hooks/utils';
import { resolveRetentionCap } from '../retention/caps';
import { warn } from '../utils';
import { bunWrite } from '../utils/bun-compat';
import { invalidateCachedArtifact } from '../utils/swarm-artifact-cache';

/**
 * Summary ID validation regex: S followed by one or more digits
 * Pattern: ^S\d+$
 * Examples: S1, S2, S99, S123
 */
const SUMMARY_ID_REGEX = /^S\d+$/;

/**
 * Validate and sanitize summary ID.
 * Must match regex ^S\d+$ (e.g., S1, S2, S99)
 * Rejects: empty string, null bytes, control characters, path traversal, non-matching patterns
 * @throws Error with descriptive message on failure
 */
export function sanitizeSummaryId(id: string): string {
	// Check for empty string
	if (!id || id.length === 0) {
		throw new Error('Invalid summary ID: empty string');
	}

	// Check for null bytes
	if (/\0/.test(id)) {
		throw new Error('Invalid summary ID: contains null bytes');
	}

	// Check for control characters (char codes < 32)
	for (let i = 0; i < id.length; i++) {
		if (id.charCodeAt(i) < 32) {
			throw new Error('Invalid summary ID: contains control characters');
		}
	}

	// Check for path traversal patterns
	if (id.includes('..') || id.includes('../') || id.includes('..\\')) {
		throw new Error('Invalid summary ID: path traversal detected');
	}

	// Validate against regex
	if (!SUMMARY_ID_REGEX.test(id)) {
		throw new Error(
			`Invalid summary ID: must match pattern ^S\\d+$, got "${id}"`,
		);
	}

	return id;
}

/**
 * Typed collision signal for the no-overwrite store contract (issue #2576):
 * the destination summary entry already exists and must never be replaced.
 * Callers distinguish this from storage errors by `instanceof` (or `name`).
 */
export class SummaryIdCollisionError extends Error {
	constructor(public readonly summaryId: string) {
		super(`Summary ID ${summaryId} already exists; refusing to overwrite`);
		this.name = 'SummaryIdCollisionError';
	}
}

function isEexistError(error: unknown): boolean {
	return (
		typeof error === 'object' &&
		error !== null &&
		(error as { code?: unknown }).code === 'EEXIST'
	);
}

/**
 * Interface for summary storage entry
 */
interface SummaryEntry {
	id: string;
	summaryText: string;
	fullOutput: string;
	timestamp: number;
	originalBytes: number;
}

/**
 * Store a summary entry to .swarm/summaries/{id}.json.
 * Performs an atomic, no-overwrite install: temp file + exclusive
 * hard-link install. Throws {@link SummaryIdCollisionError} if an entry
 * with this ID already exists (it is never replaced — issue #2576).
 * @throws Error if summary ID is invalid or size limit would be exceeded
 */
export async function storeSummary(
	directory: string,
	id: string,
	fullOutput: string,
	summaryText: string,
	maxStoredBytes: number,
): Promise<void> {
	// Validate summary ID
	const sanitizedId = sanitizeSummaryId(id);

	// Check size limit against the serialized JSON entry (not just raw input)
	// to ensure the wrapper doesn't push the total beyond maxStoredBytes
	const preCheckEntry: SummaryEntry = {
		id: sanitizedId,
		summaryText,
		fullOutput,
		timestamp: Date.now(),
		originalBytes: Buffer.byteLength(fullOutput, 'utf8'),
	};
	const serializedSize = Buffer.byteLength(
		JSON.stringify(preCheckEntry),
		'utf8',
	);
	if (serializedSize > maxStoredBytes) {
		throw new Error(
			`Summary entry size (${serializedSize} bytes) exceeds maximum (${maxStoredBytes} bytes)`,
		);
	}

	// Construct and validate path
	const relativePath = path.join('summaries', `${sanitizedId}.json`);
	const summaryPath = validateSwarmPath(directory, relativePath);
	const summaryDir = path.dirname(summaryPath);

	// Create summary entry
	const entry: SummaryEntry = {
		id: sanitizedId,
		summaryText,
		fullOutput,
		timestamp: Date.now(),
		originalBytes: Buffer.byteLength(fullOutput, 'utf8'),
	};

	// Serialize to JSON
	const entryJson = JSON.stringify(entry);

	// Create directory (recursive)
	mkdirSync(summaryDir, { recursive: true });

	// Write atomically with no-overwrite install: temp file first, then an
	// exclusive `linkSync` install that fails with EEXIST when the destination
	// already exists — a persisted entry can never be replaced, and a reused
	// ID surfaces as a typed SummaryIdCollisionError instead of silent data
	// loss (issue #2576). The install and the cache invalidation below stay
	// adjacent: `loadFullOutput` / `cleanupSummaries` read this path back
	// through the stat-stamped swarm-artifact cache, so a same-size install
	// inside one filesystem timestamp tick could otherwise serve the previous
	// entry — issue #1729. Invalidate right after the install SUCCEEDS; on
	// failure the catch below removes the temp and rethrows (also on the
	// collision path, so no `.tmp.*` file is ever left behind), and the
	// cached bytes still match what is on disk.
	const tempPath = path.join(
		summaryDir,
		`${sanitizedId}.json.tmp.${Date.now()}.${process.pid}`,
	);
	try {
		await bunWrite(tempPath, entryJson);
		try {
			linkSync(tempPath, summaryPath);
		} catch (error) {
			if (isEexistError(error)) {
				throw new SummaryIdCollisionError(sanitizedId);
			}
			throw error;
		}
		// Best-effort temp cleanup (PRR-002): the entry is durably installed
		// once linkSync succeeds, so a failed unlink (Windows AV/indexer locks
		// on the freshly linked file are the realistic trigger) must not fail
		// the store — that would orphan the installed entry behind a
		// fail-open caller that never references it. A lingering temp is
		// inert: it never matches the `S\d+.json` entry grammar.
		try {
			unlinkSync(tempPath);
		} catch {}
		invalidateCachedArtifact(summaryPath);
	} catch (error) {
		// Clean up temp file on failure (including collisions, where the
		// failed link left the temp in place). Only pre-install failures
		// (temp write, non-EEXIST link errors) and cache-invalidation
		// failures reach this path.
		try {
			rmSync(tempPath, { force: true });
		} catch {}
		throw error;
	}
}

/**
 * Load fullOutput from a summary entry.
 * Returns null if file doesn't exist or validation fails.
 */
export async function loadFullOutput(
	directory: string,
	id: string,
): Promise<string | null> {
	// Validate summary ID
	const sanitizedId = sanitizeSummaryId(id);

	// Construct relative path
	const relativePath = path.join('summaries', `${sanitizedId}.json`);
	validateSwarmPath(directory, relativePath);

	// Read file
	const content = await readSwarmFileAsync(directory, relativePath);
	if (content === null) {
		return null;
	}

	// Parse and extract fullOutput
	try {
		const parsed = JSON.parse(content);
		if (typeof parsed.fullOutput === 'string') {
			return parsed.fullOutput;
		}
		warn(`Summary entry ${sanitizedId} missing valid fullOutput field`);
		return null;
	} catch (error) {
		warn(
			`Summary entry validation failed for ${sanitizedId}: ${error instanceof Error ? error.message : String(error)}`,
		);
		return null;
	}
}

/**
 * Listing cap for `.swarm/summaries/` enumeration (issue #2483 §2, R12): the
 * public list returns NEWEST-first (mtime descending, code-unit filename
 * tie-break — never localeCompare) and is capped, so every listing read is
 * O(cap), not O(unbounded summary history). The effective value resolves
 * through `resolveRetentionCap` so the #2483 acceptance checks can shrink it.
 * Retention cleanup does NOT go through this capped view — it enumerates the
 * directory directly so stale files beyond the newest N are still pruned.
 */
export const MAX_SUMMARIES_LISTED = 500;

/**
 * Enumerate every valid summary ID in the summaries directory (UNCAPPED).
 * Shared by the capped public listing and by retention cleanup, which must
 * see every entry file regardless of the listing cap. Returns an empty array
 * if the summaries directory doesn't exist.
 */
function enumerateSummaryIds(directory: string): string[] {
	// Validate summaries base directory path
	const summariesBasePath = validateSwarmPath(directory, 'summaries');

	// Check if directory exists
	try {
		statSync(summariesBasePath);
	} catch {
		return [];
	}

	// Read directory entries
	let entries: string[];
	try {
		entries = readdirSync(summariesBasePath);
	} catch {
		return [];
	}

	// Filter to only valid summary ID files (.json)
	const summaryIds: string[] = [];
	for (const entry of entries) {
		// Only process .json files
		if (!entry.endsWith('.json')) {
			continue;
		}

		// Only regular files count as entries (PRR-005): a directory named
		// like a summary must neither be listed nor occupy an allocated ID
		// slot forever — cleanup cannot remove directories and would warn on
		// every sweep. Unreadable entries are skipped like invalid names.
		try {
			if (!statSync(path.join(summariesBasePath, entry)).isFile()) {
				continue;
			}
		} catch {
			continue;
		}

		// Extract ID from filename (remove .json extension)
		const summaryId = entry.slice(0, -5);

		try {
			// Validate as summary ID
			sanitizeSummaryId(summaryId);
			summaryIds.push(summaryId);
		} catch (error) {
			// Only log unexpected errors (not invalid summary ID names)
			if (
				error instanceof Error &&
				!error.message.startsWith('Invalid summary ID')
			) {
				warn(`Error reading summary entry '${entry}': ${error.message}`);
			}
		}
	}

	return summaryIds;
}

/**
 * Durable summary ID allocation (issue #2576): returns the next free numeric
 * ID (`S<max+1>`) derived from the entries that actually exist on disk, so a
 * restarted process continues after persisted IDs instead of reusing `S1`.
 *
 * The scan uses the strict write-side grammar (`^S\d+`) via
 * {@link enumerateSummaryIds} — large timestamp-suffixed IDs (e.g. Stage A's
 * `S<ms><random>`) match and are included; filenames outside the grammar are
 * ignored. The max is computed with BigInt so 16-digit IDs stay exact past
 * 2^53 (a float max could alias two distinct large IDs and hand the retry
 * loop an already-occupied slot); `max + 1n` always stringifies back to a
 * valid `^S\d+$` ID, and leading-zero legacy entries (`S007`) normalize
 * numerically so allocation never regresses.
 */
export function allocateSummaryId(directory: string): string {
	let max = 0n;
	for (const id of enumerateSummaryIds(directory)) {
		const value = BigInt(id.slice(1));
		if (value > max) max = value;
	}
	return `S${(max + 1n).toString()}`;
}

/**
 * List summary IDs that have summary entries, newest-first (mtime
 * descending, code-unit filename tie-break), capped at
 * {@link MAX_SUMMARIES_LISTED} entries. Returns an empty array if the
 * summaries directory doesn't exist.
 */
export async function listSummaries(directory: string): Promise<string[]> {
	const summaryIds = enumerateSummaryIds(directory);
	if (summaryIds.length === 0) return [];

	const summariesBasePath = validateSwarmPath(directory, 'summaries');
	const mtimeById = new Map<string, number>();
	for (const id of summaryIds) {
		try {
			mtimeById.set(
				id,
				statSync(path.join(summariesBasePath, `${id}.json`)).mtimeMs,
			);
		} catch {
			mtimeById.set(id, 0); // unreadable mtime sorts oldest, never throws
		}
	}
	const cap = resolveRetentionCap('MAX_SUMMARIES_LISTED', MAX_SUMMARIES_LISTED);
	return summaryIds
		.sort((a, b) => {
			const mtimeDelta = (mtimeById.get(b) ?? 0) - (mtimeById.get(a) ?? 0);
			if (mtimeDelta !== 0) return mtimeDelta;
			// Code-unit tie-break (never localeCompare).
			return a < b ? -1 : a > b ? 1 : 0;
		})
		.slice(0, cap);
}

/**
 * List summary IDs past the retention horizon WITHOUT deleting them (review
 * FB-9: the single detection predicate shared by `cleanupSummaries` and the
 * sweep's dry-run counter, so rehearsal and deletion can never diverge).
 *
 * Retention cleanup enumerates the directory DIRECTLY (uncapped): the
 * public listSummaries is capped to the newest MAX_SUMMARIES_LISTED, and
 * routing cleanup through it would skip stale files beyond that window
 * (issue #2483).
 *
 * Retention also enumerates LENIENTLY: `enumerateSummaryIds` applies the
 * strict write-side `^S\d+$` id grammar, but retention's job is to bound
 * the keyspace — ANY `S*.json` occupant past the horizon is stale
 * regardless of whether its id would pass write validation (legacy or
 * foreign producers included).
 *
 * Detection is content-timestamp-first: a numeric `timestamp` older than the
 * cutoff marks the entry stale; a missing/unparsable timestamp falls back to
 * the file mtime (issue #2483); unreadable content or a parse failure is
 * never stale (a `warn` is emitted for the latter, as deletion does).
 */
export async function listStaleSummaryIds(
	directory: string,
	retentionDays: number,
	options?: { now?: number },
): Promise<string[]> {
	const summariesBasePath = validateSwarmPath(directory, 'summaries');
	let retentionFiles: string[] = [];
	try {
		retentionFiles = readdirSync(summariesBasePath).filter(
			(name) => name.endsWith('.json') && /^S.+$/.test(name.slice(0, -5)),
		);
	} catch {
		retentionFiles = [];
	}
	const now = options?.now ?? Date.now();
	const cutoffTime = now - retentionDays * 24 * 60 * 60 * 1000;

	const stale: string[] = [];

	for (const filename of retentionFiles) {
		const id = filename.slice(0, -5);
		// Construct and validate path
		const relativePath = path.join('summaries', filename);
		const summaryPath = validateSwarmPath(directory, relativePath);

		// Read the summary to check timestamp
		const content = await readSwarmFileAsync(directory, relativePath);
		if (content === null) {
			continue;
		}

		try {
			const parsed = JSON.parse(content);
			const timestamp = parsed.timestamp as number;

			// Stale if older than cutoff. A missing/unparsable timestamp
			// falls back to the file mtime (issue #2483: the retention sweep
			// prunes summaries whose content carries no timestamp field).
			if (
				(typeof timestamp === 'number' &&
					Number.isFinite(timestamp) &&
					timestamp < cutoffTime) ||
				(typeof timestamp !== 'number' &&
					(() => {
						try {
							return statSync(summaryPath).mtimeMs < cutoffTime;
						} catch {
							return false;
						}
					})())
			) {
				stale.push(id);
			}
		} catch (error) {
			warn(
				`Failed to inspect summary ${id} for retention: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	return stale;
}

/**
 * Delete summaries older than retentionDays.
 * Returns array of deleted summary IDs.
 */
export async function cleanupSummaries(
	directory: string,
	retentionDays: number,
	options?: { now?: number },
): Promise<string[]> {
	const staleIds = await listStaleSummaryIds(directory, retentionDays, options);
	const deleted: string[] = [];
	for (const id of staleIds) {
		try {
			rmSync(
				validateSwarmPath(directory, path.join('summaries', `${id}.json`)),
			);
			deleted.push(id);
		} catch (error) {
			warn(
				`Failed to cleanup summary ${id}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
	return deleted;
}
