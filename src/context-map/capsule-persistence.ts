/**
 * Capsule persistence module — handles saving, loading, deleting, and
 * listing Context Capsules stored at `.swarm/capsules/{task_id}.json`.
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
 * No imports from capsule-builder to avoid circular dependencies.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import type { CapsuleMetadata, ContextCapsule } from '../types/context-capsule';

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
	writeFileSync: fs.writeFileSync,
	readFileSync: fs.readFileSync,
	existsSync: fs.existsSync,
	mkdirSync: fs.mkdirSync,
	readdirSync: fs.readdirSync,
	unlinkSync: fs.unlinkSync,
	renameSync: fs.renameSync,
} as const;

// ---------------------------------------------------------------------------
// Task ID validation — prevents path traversal (Invariant 4)
// ---------------------------------------------------------------------------

const TASK_ID_RE = /^\d+(?:\.\d+)+$/;

function isValidTaskId(taskId: string): boolean {
	return TASK_ID_RE.test(taskId);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Compute the filesystem path for a capsule given its task ID.
 */
function capsulePath(taskId: string, directory: string): string {
	return path.join(directory, '.swarm', 'capsules', `${taskId}.json`);
}

/**
 * Estimate token count from raw content length.
 * Inline implementation to avoid importing from capsule-builder (circular dep).
 * Returns at least 1 token.
 */
function estimateTokens(content: string): number {
	return Math.max(1, Math.ceil(content.length / 4));
}

// ---------------------------------------------------------------------------
// Capsule persistence operations
// ---------------------------------------------------------------------------

/**
 * Save a capsule to `.swarm/capsules/{task_id}.json` using an atomic
 * temp-then-rename write pattern to avoid partial-write corruption.
 *
 * Creates the `.swarm/capsules/` directory if it does not exist.
 *
 * Returns {@link CapsuleMetadata} with diagnostics. On error, returns
 * metadata with `success: false` — never throws.
 */
export function saveCapsule(
	capsule: ContextCapsule,
	directory: string,
): CapsuleMetadata {
	try {
		if (!isValidTaskId(capsule.task_id)) {
			return {
				success: false,
				capsule_path: '',
				token_estimate: 0,
				cache_hits: 0,
				cache_misses: 0,
				stale_entries: 0,
				recommended_reads: [],
				skipped_reads: [],
			};
		}

		const capsulesDir = path.join(directory, '.swarm', 'capsules');
		const finalPath = capsulePath(capsule.task_id, directory);
		const tmpPath = path.join(capsulesDir, `capsule-${capsule.task_id}.tmp`);

		// Ensure directory exists
		_internals.mkdirSync(capsulesDir, { recursive: true });

		// Atomic write: temp file then rename
		const json = JSON.stringify(capsule, null, 2);
		_internals.writeFileSync(tmpPath, json, 'utf-8');
		_internals.renameSync(tmpPath, finalPath);

		return {
			success: true,
			capsule_path: finalPath,
			token_estimate: estimateTokens(capsule.content),
			cache_hits: 0,
			cache_misses: 0,
			stale_entries: 0,
			recommended_reads: capsule.read_policy
				.filter((p) => p.read_original)
				.map((p) => p.file_path),
			skipped_reads: capsule.read_policy
				.filter((p) => p.trust_summary)
				.map((p) => p.file_path),
		};
	} catch {
		return {
			success: false,
			capsule_path: '',
			token_estimate: 0,
			cache_hits: 0,
			cache_misses: 0,
			stale_entries: 0,
			recommended_reads: [],
			skipped_reads: [],
		};
	}
}

/**
 * Load a capsule from `.swarm/capsules/{task_id}.json`.
 *
 * Returns the parsed {@link ContextCapsule}, or `null` if the file
 * doesn't exist or the JSON is invalid. Never throws.
 */
export function loadCapsule(
	taskId: string,
	directory: string,
): ContextCapsule | null {
	if (!isValidTaskId(taskId)) {
		return null;
	}

	const filePath = capsulePath(taskId, directory);

	try {
		if (!_internals.existsSync(filePath)) {
			return null;
		}
		const raw = _internals.readFileSync(filePath, 'utf-8');
		const parsed = JSON.parse(raw) as ContextCapsule;

		// Basic structural validation — reject clearly corrupt data
		if (
			typeof parsed !== 'object' ||
			parsed === null ||
			typeof parsed.task_id !== 'string' ||
			typeof parsed.content !== 'string'
		) {
			return null;
		}

		return parsed;
	} catch {
		return null;
	}
}

/**
 * Delete a capsule from `.swarm/capsules/{task_id}.json`.
 *
 * Returns `true` if the file was deleted, `false` if it didn't exist.
 * Never throws.
 */
export function deleteCapsule(taskId: string, directory: string): boolean {
	if (!isValidTaskId(taskId)) {
		return false;
	}

	const filePath = capsulePath(taskId, directory);

	try {
		if (!_internals.existsSync(filePath)) {
			return false;
		}
		_internals.unlinkSync(filePath);
		return true;
	} catch {
		return false;
	}
}

/**
 * List all saved capsule task IDs in `.swarm/capsules/`.
 *
 * Returns an array of task IDs derived from filenames (stripping the
 * `.json` extension). Returns an empty array if the directory doesn't
 * exist. Never throws.
 */
export function listCapsules(directory: string): string[] {
	const capsulesDir = path.join(directory, '.swarm', 'capsules');

	try {
		if (!_internals.existsSync(capsulesDir)) {
			return [];
		}
		const entries = _internals.readdirSync(capsulesDir);
		return entries
			.filter((entry) => entry.endsWith('.json'))
			.map((entry) => entry.slice(0, -5));
	} catch {
		return [];
	}
}
