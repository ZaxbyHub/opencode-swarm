/**
 * Context Map persistence module — handles reading, writing, and invalidating
 * the durable Context Map stored at `.swarm/context-map.json`.
 *
 * All functions are synchronous for simplicity and reliability. The module
 * uses the `_internals` DI seam pattern so tests can override filesystem
 * and crypto operations without `mock.module` (which leaks across files in
 * Bun's shared test-runner process).
 *
 * State lives exclusively under `.swarm/` (Invariant 4). No `process.cwd()`
 * usage — every function accepts an explicit `directory` parameter.
 *
 * No `bun:` imports — this module is Node-ESM-loadable (Invariant 2).
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import type {
	ContentHash,
	ContextMap,
	ContextMapStaleEntry,
	DecisionEntry,
	TaskContextSummary,
} from '../types/context-map';

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
	readFileSync: fs.readFileSync,
	writeFileSync: fs.writeFileSync,
	mkdirSync: fs.mkdirSync,
	renameSync: fs.renameSync,
	existsSync: fs.existsSync,
	statSync: fs.statSync,
	createHash: crypto.createHash.bind(crypto),
} as const;

// ---------------------------------------------------------------------------
// Content hash computation
// ---------------------------------------------------------------------------

/**
 * Compute a SHA-256 content hash for the given string content.
 * Returns the hash as a 64-character lowercase hex string.
 */
export function computeContentHash(content: string): ContentHash {
	return _internals.createHash('sha256').update(content, 'utf-8').digest('hex');
}

// ---------------------------------------------------------------------------
// Context Map lifecycle
// ---------------------------------------------------------------------------

/**
 * Create a new empty ContextMap with sensible defaults.
 * The `repo_fingerprint` is left empty and populated by the caller later.
 */
export function createEmptyContextMap(): ContextMap {
	return {
		schema_version: 1,
		generated_at: new Date().toISOString(),
		repo_fingerprint: '',
		files: {},
		task_history: {},
		decisions: [],
	};
}

/**
 * Load the Context Map from `.swarm/context-map.json` in the given directory.
 * Returns `null` if the file doesn't exist or cannot be parsed (corrupt file).
 * Never throws.
 */
export function loadContextMap(directory: string): ContextMap | null {
	const filePath = path.join(directory, '.swarm', 'context-map.json');

	try {
		if (!_internals.existsSync(filePath)) {
			return null;
		}
		const raw = _internals.readFileSync(filePath, 'utf-8');
		const parsed = JSON.parse(raw) as ContextMap;

		// Basic structural validation — reject clearly corrupt data
		if (
			typeof parsed !== 'object' ||
			parsed === null ||
			parsed.schema_version !== 1
		) {
			return null;
		}

		return parsed;
	} catch {
		return null;
	}
}

/**
 * Save the Context Map to `.swarm/context-map.json` using an atomic
 * temp-then-rename write pattern to avoid partial-write corruption.
 *
 * Updates `generated_at` to the current timestamp before writing.
 * Creates the `.swarm/` directory if it does not exist.
 */
export function saveContextMap(map: ContextMap, directory: string): void {
	const swarmDir = path.join(directory, '.swarm');
	const tmpPath = path.join(swarmDir, 'context-map.tmp');
	const finalPath = path.join(swarmDir, 'context-map.json');

	// Ensure .swarm/ directory exists
	_internals.mkdirSync(swarmDir, { recursive: true });

	// Update generated_at timestamp
	const updated: ContextMap = {
		...map,
		generated_at: new Date().toISOString(),
	};

	const json = JSON.stringify(updated, null, 2);
	_internals.writeFileSync(tmpPath, json, 'utf-8');
	_internals.renameSync(tmpPath, finalPath);
}

// ---------------------------------------------------------------------------
// Staleness detection
// ---------------------------------------------------------------------------

/**
 * Scan all file entries in the context map and detect which ones have
 * changed or been deleted since the map was last generated.
 *
 * Uses an mtime pre-check before computing the expensive SHA-256 hash —
 * only files with a modified timestamp undergo hashing.
 *
 * Returns the list of stale entries. Files that don't exist on disk or
 * whose content hash differs from the stored hash are included.
 * This function is read-only and does NOT modify the input map.
 */
export function markStaleEntries(
	map: ContextMap,
	directory: string,
): ContextMapStaleEntry[] {
	const stale: ContextMapStaleEntry[] = [];
	const now = new Date().toISOString();
	const entries = Object.values(map.files);

	for (const entry of entries) {
		const filePath = path.join(directory, entry.path);

		try {
			if (!_internals.existsSync(filePath)) {
				// File no longer exists — mark stale
				stale.push({
					path: entry.path,
					old_hash: entry.content_hash,
					detected_at: now,
				});
				continue;
			}

			const stat = _internals.statSync(filePath);

			// Fast path: if mtime hasn't changed, skip the expensive hash
			if (stat.mtimeMs === entry.mtime_ms) {
				continue;
			}

			// mtime changed — verify with content hash
			const currentContent = _internals.readFileSync(filePath, 'utf-8');
			const currentHash = computeContentHash(currentContent);

			if (currentHash !== entry.content_hash) {
				stale.push({
					path: entry.path,
					old_hash: entry.content_hash,
					detected_at: now,
				});
			}
		} catch {
			// File might be unreadable (permissions, etc.) — mark stale
			stale.push({
				path: entry.path,
				old_hash: entry.content_hash,
				detected_at: now,
			});
		}
	}

	return stale;
}

// ---------------------------------------------------------------------------
// Immutable append operations
// ---------------------------------------------------------------------------

/**
 * Add or update a task history entry in the context map.
 * Returns a new ContextMap with the entry added/updated (input is not mutated).
 */
export function appendTaskHistory(
	map: ContextMap,
	summary: TaskContextSummary,
): ContextMap {
	return {
		...map,
		task_history: {
			...map.task_history,
			[summary.task_id]: summary,
		},
	};
}

/**
 * Append an architectural decision to the context map's decisions array.
 * Returns a new ContextMap with the decision appended (input is not mutated).
 */
export function appendDecision(
	map: ContextMap,
	decision: DecisionEntry,
): ContextMap {
	return {
		...map,
		decisions: [...map.decisions, decision],
	};
}
