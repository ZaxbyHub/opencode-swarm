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
import { atomicWriteSwarmFileSync } from '../utils/atomic-write';

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
	/**
	 * r16 (P2): the canonical atomic swarm writer (unique registered temp,
	 * fsync, bounded Windows rename retry, artifact-cache invalidation).
	 * Seamed so tests can capture the persisted bytes without real I/O —
	 * the same pattern the previous writeFileSync/renameSync seam served.
	 */
	atomicWriteSwarmFileSync: atomicWriteSwarmFileSync as (
		targetPath: string,
		content: string,
	) => void,
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
 *
 * Structural validation (#3016): every field downstream code iterates or
 * spreads must have the shape the writers produce — `decisions` an array,
 * `files` and `task_history` non-null non-array objects. Absent keys fail
 * closed the same way: every in-repo writer (`createEmptyContextMap`,
 * `saveContextMap`, the append paths) always materializes all three keys, so
 * a map missing or mis-shaping them is foreign or hand-mangled and is
 * replaced by a fresh map rather than silently dropped mid-update or
 * corrupted by spread semantics.
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
			parsed.schema_version !== 1 ||
			!Array.isArray(parsed.decisions) ||
			typeof parsed.files !== 'object' ||
			parsed.files === null ||
			Array.isArray(parsed.files) ||
			typeof parsed.task_history !== 'object' ||
			parsed.task_history === null ||
			Array.isArray(parsed.task_history)
		) {
			return null;
		}

		return parsed;
	} catch {
		return null;
	}
}

/**
 * Discriminated context-map read (r16 audit P1): distinguishes "no file
 * exists" (`missing`) from "the file exists but is corrupt, unreadable, or
 * structurally invalid" (`unreadable`).
 *
 * `loadContextMap` collapses both cases into `null`, which is the right
 * contract for its existing callers — but rebuild-on-null callers must NOT
 * treat them the same: a genuinely missing map may be rebuilt from
 * authoritative state, while an EXISTING corrupt map must be preserved
 * byte-for-byte so an operator can still recover decisions, task history,
 * and file summaries from the damaged file. Overwriting it with a fresh
 * empty map destroys that recovery path.
 *
 * `loadContextMap`'s null-returning contract is deliberately unchanged.
 */
export type ContextMapReadState =
	| { kind: 'ok'; map: ContextMap }
	| { kind: 'missing' }
	| { kind: 'unreadable' };

export function readContextMapState(directory: string): ContextMapReadState {
	const filePath = path.join(directory, '.swarm', 'context-map.json');
	try {
		if (!_internals.existsSync(filePath)) {
			return { kind: 'missing' };
		}
	} catch {
		// existsSync threw (e.g. invalid path) — absence is not provable, so
		// fail toward preservation rather than rebuild.
		return { kind: 'unreadable' };
	}
	const map = loadContextMap(directory);
	if (map === null) {
		return { kind: 'unreadable' };
	}
	return { kind: 'ok', map };
}

/**
 * Save the Context Map to `.swarm/context-map.json` using the canonical
 * atomic write (unique registered temp file + fsync + rename).
 *
 * r16 audit repair (P2): the previous hand-rolled write used a FIXED temp
 * name (`.swarm/context-map.tmp`) with no cross-process coordination — two
 * concurrent writers could clobber each other's temp file (one rename then
 * failed with ENOENT, or installed the OTHER writer's bytes). The canonical
 * writer gives every write its own unique temp, so unlocked writers can no
 * longer collide on the temp artifact; cross-process lost UPDATES (both
 * writers extending a map they both loaded earlier) are prevented by the
 * coordinating lock at the mutation entry points
 * (`withContextMapLock` in post-agent-update.ts) — a unique temp alone does
 * not serialize read-modify-write cycles.
 *
 * Updates `generated_at` to the current timestamp before writing.
 * Creates the `.swarm/` directory if it does not exist.
 */
export function saveContextMap(map: ContextMap, directory: string): void {
	const finalPath = path.join(directory, '.swarm', 'context-map.json');

	// Update generated_at timestamp
	const updated: ContextMap = {
		...map,
		generated_at: new Date().toISOString(),
	};

	const json = JSON.stringify(updated, null, 2);
	_internals.atomicWriteSwarmFileSync(finalPath, json);
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
