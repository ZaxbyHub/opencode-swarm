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

import { estimateTokens } from '../hooks/utils';
import { resolveRetentionCap } from '../retention/caps';
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
	statSync: fs.statSync,
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

// Token estimation delegates to the canonical estimator
// (`estimateTokens` in src/hooks/utils.ts — issue #1616/#2107; this was a
// silent fourth ratio, length/4). Capsules need at least 1 token to avoid
// degenerate budget math, so the canonical result is floored at 1. Importing
// hooks/utils is safe — the old circular-dep ban applied to capsule-builder
// only.
function estimateCapsuleTokens(content: string): number {
	return Math.max(1, estimateTokens(content));
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
			token_estimate: estimateCapsuleTokens(capsule.content),
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
 * Listing cap for `.swarm/capsules/` enumeration (issue #2483 §2, R12): the
 * list returns NEWEST-first (mtime descending, code-unit filename
 * tie-break — never localeCompare) and is capped, so every listing read is
 * O(cap), not O(unbounded capsule history). The effective value resolves
 * through `resolveRetentionCap` so the #2483 acceptance checks can shrink it.
 */
export const MAX_CAPSULES_LISTED = 500;

/**
 * List saved capsule task IDs in `.swarm/capsules/`, newest-first.
 *
 * Returns an array of task IDs derived from filenames (stripping the
 * `.json` extension), ordered by capsule file mtime descending (code-unit
 * filename tie-break) and capped at {@link MAX_CAPSULES_LISTED} entries.
 * A capsule whose file cannot be `stat`-ed sorts oldest (fail-open per
 * entry). Returns an empty array if the directory doesn't exist. Never
 * throws.
 */
export function listCapsules(directory: string): string[] {
	const capsulesDir = path.join(directory, '.swarm', 'capsules');

	try {
		if (!_internals.existsSync(capsulesDir)) {
			return [];
		}
		const entries = _internals.readdirSync(capsulesDir);
		const ids = entries
			.filter((entry) => entry.endsWith('.json'))
			.map((entry) => entry.slice(0, -5));
		const mtimeById = new Map<string, number>();
		for (const id of ids) {
			try {
				mtimeById.set(
					id,
					_internals.statSync(path.join(capsulesDir, `${id}.json`)).mtimeMs,
				);
			} catch {
				mtimeById.set(id, 0); // unreadable mtime sorts oldest, never throws
			}
		}
		const cap = resolveRetentionCap('MAX_CAPSULES_LISTED', MAX_CAPSULES_LISTED);
		return ids
			.sort((a, b) => {
				const mtimeDelta = (mtimeById.get(b) ?? 0) - (mtimeById.get(a) ?? 0);
				if (mtimeDelta !== 0) return mtimeDelta;
				// Code-unit tie-break (never localeCompare).
				return a < b ? -1 : a > b ? 1 : 0;
			})
			.slice(0, cap);
	} catch {
		return [];
	}
}
