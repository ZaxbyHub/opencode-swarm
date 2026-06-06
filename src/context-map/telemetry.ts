/**
 * Telemetry recording and persistence for the Context Capsule feature.
 *
 * Records capsule telemetry data (token estimates, cache hit/miss counts,
 * stale summary counts) per delegation. Aggregates telemetry written to
 * `.swarm/context-telemetry.jsonl` for user inspection.
 *
 * All functions are synchronous for simplicity and reliability. The module
 * uses the `_internals` DI seam pattern so tests can override filesystem
 * operations without `mock.module` (which leaks across files in Bun's
 * shared test-runner process).
 *
 * State lives exclusively under `.swarm/` (Invariant 4). No `process.cwd()`
 * usage — every function accepts an explicit `directory` parameter.
 *
 * No `bun:` imports — this module is Node-ESM-loadable (Invariant 2).
 *
 * See issue #1104, FR-007.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

// ---------------------------------------------------------------------------
// Structural validation
// ---------------------------------------------------------------------------

/**
 * Runtime validator for parsed JSONL lines. Ensures all required fields are
 * present and have the correct primitive types so that aggregation in
 * {@link getTelemetrySummary} does not produce `NaN` from undefined/non-number
 * fields.
 */
function isValidTelemetryEntry(value: unknown): value is TelemetryEntry {
	if (typeof value !== 'object' || value === null) {
		return false;
	}
	const obj = value as Record<string, unknown>;
	return (
		typeof obj.timestamp === 'string' &&
		typeof obj.task_id === 'string' &&
		typeof obj.agent_role === 'string' &&
		typeof obj.delegation_reason === 'string' &&
		typeof obj.token_estimate === 'number' &&
		typeof obj.cache_hits === 'number' &&
		typeof obj.cache_misses === 'number' &&
		typeof obj.stale_entries === 'number' &&
		typeof obj.recommended_reads === 'number' &&
		typeof obj.skipped_reads === 'number' &&
		typeof obj.success === 'boolean'
	);
}

// ---------------------------------------------------------------------------
// Read telemetry
// ---------------------------------------------------------------------------

/**
 * A single telemetry record for one capsule delegation.
 * Written as one JSON line to `.swarm/context-telemetry.jsonl`.
 */
export interface TelemetryEntry {
	/** ISO 8601 timestamp of when the telemetry was recorded */
	timestamp: string;
	/** Task ID the capsule was generated for (e.g. "1.1", "2.3") */
	task_id: string;
	/** Agent role that received the capsule */
	agent_role: string;
	/** Why the capsule was generated */
	delegation_reason: string;
	/** Estimated token count of the capsule content */
	token_estimate: number;
	/** Number of entries reused from the context map cache */
	cache_hits: number;
	/** Number of entries that required fresh computation */
	cache_misses: number;
	/** Number of stale entries detected during generation */
	stale_entries: number;
	/** Number of files the agent should read directly */
	recommended_reads: number;
	/** Number of files whose summaries were sufficient */
	skipped_reads: number;
	/** Whether capsule generation succeeded */
	success: boolean;
}

/**
 * Aggregate statistics computed from all telemetry entries.
 * Returned by {@link getTelemetrySummary}.
 */
export interface TelemetrySummary {
	/** Total number of capsule delegations recorded */
	total_delegations: number;
	/** Sum of all cache hits across entries */
	total_cache_hits: number;
	/** Sum of all cache misses across entries */
	total_cache_misses: number;
	/** Sum of all stale entries detected across entries */
	total_stale_entries: number;
	/** Average estimated token count across entries */
	avg_token_estimate: number;
	/** Sum of all recommended reads across entries */
	total_recommended_reads: number;
	/** Sum of all skipped reads across entries */
	total_skipped_reads: number;
	/** Percentage of successful capsule generations (0–100) */
	success_rate: number;
}

// ---------------------------------------------------------------------------
// DI seam — tests override these functions without touching real modules
// ---------------------------------------------------------------------------

/**
 * Test-only dependency-injection seam. Production code calls through this
 * object so tests can replace the underlying implementations without
 * `mock.module` (which leaks across files in Bun's shared test-runner process).
 * Mutating this local object is file-scoped and trivially restorable
 * via `afterEach`.
 */
export const _internals = {
	appendFileSync: fs.appendFileSync,
	readFileSync: fs.readFileSync,
	existsSync: fs.existsSync,
	mkdirSync: fs.mkdirSync,
} as const;

// ---------------------------------------------------------------------------
// Telemetry file path
// ---------------------------------------------------------------------------

/**
 * Compute the telemetry file path for the given project directory.
 */
function telemetryFilePath(directory: string): string {
	return path.join(directory, '.swarm', 'context-telemetry.jsonl');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Append a telemetry entry to `.swarm/context-telemetry.jsonl`.
 *
 * Creates the `.swarm/` directory if it does not exist. The entry is
 * serialized as a single JSON line and appended to the file.
 *
 * Returns `true` on success, `false` on any error. Never throws.
 *
 * @param entry - The telemetry record to append
 * @param directory - Project root directory (must contain `.swarm/`)
 */
export function recordTelemetry(
	entry: TelemetryEntry,
	directory: string,
): boolean {
	const filePath = telemetryFilePath(directory);
	const swarmDir = path.join(directory, '.swarm');

	try {
		_internals.mkdirSync(swarmDir, { recursive: true });
		const line = `${JSON.stringify(entry)}\n`;
		_internals.appendFileSync(filePath, line, 'utf-8');
		return true;
	} catch {
		return false;
	}
}

/**
 * Read all telemetry entries from `.swarm/context-telemetry.jsonl`.
 *
 * Parses each line as JSON and returns the array of valid entries.
 * Malformed lines are silently skipped. Returns an empty array if the
 * file does not exist. Never throws.
 *
 * @param directory - Project root directory
 * @returns Array of parsed telemetry entries (empty if none or on error)
 */
export function readTelemetry(directory: string): TelemetryEntry[] {
	const filePath = telemetryFilePath(directory);
	const entries: TelemetryEntry[] = [];

	try {
		if (!_internals.existsSync(filePath)) {
			return entries;
		}

		const raw = _internals.readFileSync(filePath, 'utf-8');
		const lines = raw.split('\n');

		for (const line of lines) {
			if (line.trim() === '') {
				continue;
			}
			try {
				const parsed: unknown = JSON.parse(line);
				if (isValidTelemetryEntry(parsed)) {
					entries.push(parsed);
				}
			} catch {
				// Skip malformed lines — don't let one bad entry break the rest
			}
		}

		return entries;
	} catch {
		return entries;
	}
}

/**
 * Compute aggregate statistics from all telemetry entries.
 *
 * Reads all entries via {@link readTelemetry}, then computes totals
 * and averages across the dataset.
 *
 * Returns a summary with zeroed fields if no entries exist or on error.
 * Never throws.
 *
 * @param directory - Project root directory
 * @returns Aggregate telemetry summary
 */
export function getTelemetrySummary(directory: string): TelemetrySummary {
	const entries = readTelemetry(directory);

	if (entries.length === 0) {
		return {
			total_delegations: 0,
			total_cache_hits: 0,
			total_cache_misses: 0,
			total_stale_entries: 0,
			avg_token_estimate: 0,
			total_recommended_reads: 0,
			total_skipped_reads: 0,
			success_rate: 0,
		};
	}

	let totalCacheHits = 0;
	let totalCacheMisses = 0;
	let totalStaleEntries = 0;
	let totalTokenEstimate = 0;
	let totalRecommendedReads = 0;
	let totalSkippedReads = 0;
	let totalSuccess = 0;

	for (const entry of entries) {
		totalCacheHits += entry.cache_hits;
		totalCacheMisses += entry.cache_misses;
		totalStaleEntries += entry.stale_entries;
		totalTokenEstimate += entry.token_estimate;
		totalRecommendedReads += entry.recommended_reads;
		totalSkippedReads += entry.skipped_reads;
		if (entry.success) {
			totalSuccess++;
		}
	}

	return {
		total_delegations: entries.length,
		total_cache_hits: totalCacheHits,
		total_cache_misses: totalCacheMisses,
		total_stale_entries: totalStaleEntries,
		avg_token_estimate: Math.round(totalTokenEstimate / entries.length),
		total_recommended_reads: totalRecommendedReads,
		total_skipped_reads: totalSkippedReads,
		success_rate: Math.round((totalSuccess / entries.length) * 100),
	};
}
