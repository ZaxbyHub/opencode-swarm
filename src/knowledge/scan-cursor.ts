/**
 * Fair, durable scanning cursor for cohort curation (issue #1848 §4).
 *
 * Replaces the fixed oldest-~500-entry window in curator-postmortem with
 * durable, fair pagination/cursor semantics. Every eligible record is
 * eventually visited; progress survives restart; concurrent append/update does
 * not permanently skip or duplicate destructive handling; retry after crash is
 * idempotent.
 *
 * TWO-LAYER IDEMPOTENCY (C-5 fix from the critic review):
 *
 *  1. ATOMIC BATCH CLAIM: `claimNextScanBatch` reads the cursor AND advances it
 *     in ONE locked transaction, BEFORE curation. This prevents two concurrent
 *     cohort worktrees (W1, W2) from taking the same batch — W1 claims batch B,
 *     advances the cursor; W2 sees the advanced cursor and takes the next batch.
 *     Crash-after-claim-before-commit → that batch's work is lost for THIS run
 *     (picked up next generation); crash-before-claim → cursor unchanged →
 *     retry is idempotent.
 *
 *  2. PER-ENTRY GENERATION STAMP: each entry carries `last_curated_generation`.
 *     Non-idempotent actions (rewrite/demote/confidence-delta) are skipped if
 *     `entry.last_curated_generation === currentGeneration`. Status-idempotent
 *     actions (archive/quarantine/remove) need no stamp (re-application is a
 *     no-op). This makes the cursor safe even if a batch is somehow processed
 *     twice (e.g. recovery from a crash-after-claim that was partially applied).
 *
 * Cursor state is cohort-scoped (under `resolveKnowledgeStoreDir`, so it is
 * shared across linked worktrees) and lives at `curation-cursor.json`. It is
 * NOT a KNOWLEDGE_FAMILY migration member — it's regenerable state, not
 * id-mergeable data.
 *
 * This module is never imported on the plugin-init path.
 */

import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { resolveKnowledgeStoreDir } from '../hooks/knowledge-link.js';
import { readKnowledge, transactKnowledge } from '../hooks/knowledge-store.js';
import type { KnowledgeEntryBase } from '../hooks/knowledge-types.js';
import { isActiveStatus } from '../hooks/knowledge-types.js';
import * as logger from '../utils/logger.js';
import { resolveCohortId } from './cohort-identity.js';

const CURSOR_FILENAME = 'curation-cursor.json';
const DEFAULT_BATCH_SIZE = 500;

/** Cursor state persisted to disk (cohort-scoped). */
export interface ScanCursorState {
	cohort_id: string;
	/** `${created_at}|${id}` — stable ordering + deterministic tie-breaker. */
	last_visited_sort_key: string;
	/** Monotonically increasing sweep generation. */
	generation: number;
	/** True when the last sweep reached the tail; next call starts fresh. */
	completed: boolean;
	/** Approximate count of entries still eligible to visit this generation. */
	remaining_estimate: number;
	updated_at: string;
}

/** A claimed batch + its generation (for the generation-stamp idempotency). */
export interface ScanBatch {
	entries: KnowledgeEntryBase[];
	generation: number;
	/** True when this batch completed the current sweep. */
	sweepCompleted: boolean;
	remaining_estimate: number;
}

/** Lightweight status for diagnostics. */
export interface ScanStatus {
	generation: number;
	completed: boolean;
	remaining_estimate: number;
	cohort_id: string;
}

/**
 * DI seam for tests.
 */
export const _internals = {
	readFile,
	writeFile,
	existsSync,
	mkdir,
	readKnowledge,
	transactKnowledge,
	resolveCohortId,
	resolveKnowledgeStoreDir,
};

function resolveCursorPath(directory: string): string {
	const storeDir = _internals.resolveKnowledgeStoreDir(directory);
	return path.join(storeDir, CURSOR_FILENAME);
}

/** Stable sort key: `${created_at}|${id}`. */
function entrySortKey(entry: { created_at?: string; id: string }): string {
	return `${entry.created_at ?? ''}|${entry.id}`;
}

async function readCursor(directory: string): Promise<ScanCursorState | null> {
	const cursorPath = resolveCursorPath(directory);
	try {
		if (!_internals.existsSync(cursorPath)) return null;
		const raw = await _internals.readFile(cursorPath, 'utf-8');
		return JSON.parse(raw) as ScanCursorState;
	} catch {
		return null;
	}
}

async function writeCursor(
	directory: string,
	state: ScanCursorState,
): Promise<void> {
	const cursorPath = resolveCursorPath(directory);
	const storeDir = path.dirname(cursorPath);
	try {
		await _internals.mkdir(storeDir, { recursive: true });
		await _internals.writeFile(
			cursorPath,
			JSON.stringify(state, null, 2),
			'utf-8',
		);
	} catch (err) {
		logger.log(
			`[scan-cursor] writeCursor failed (non-blocking): ${String(err)}`,
		);
	}
}

/**
 * Claim the next scan batch ATOMICALLY (issue #1848 §4 / C-5 fix).
 *
 * Reads the cursor, selects the next `batchSize` unvisited eligible entries,
 * and ADVANCES the cursor past them in ONE step — all before curation runs.
 * This means a concurrent cohort worktree calling this in parallel will see
 * the already-advanced cursor and take the NEXT batch, never the same one.
 *
 * Eligible = active status (not archived/quarantined/unactionable) and sort-key
 * beyond the cursor's last-visited position for this generation.
 *
 * Returns an empty batch when the sweep is complete; the caller may then start
 * a fresh sweep (generation bumped) on the next invocation.
 */
export async function claimNextScanBatch(
	directory: string,
	batchSize: number = DEFAULT_BATCH_SIZE,
): Promise<ScanBatch> {
	// Read ALL entries once (link-aware, uncapped) and sort stably.
	const knowledgePath = path.join(
		_internals.resolveKnowledgeStoreDir(directory),
		'knowledge.jsonl',
	);
	const allEntries =
		await _internals.readKnowledge<KnowledgeEntryBase>(knowledgePath);
	const eligible = allEntries
		.filter((e) => isActiveStatus(e.status))
		.sort((a, b) => {
			const ka = entrySortKey(a);
			const kb = entrySortKey(b);
			return ka < kb ? -1 : ka > kb ? 1 : 0;
		});

	// Resolve cohort id (used in cursor state for audit; fail-open if it throws).
	let cohortId = 'unknown';
	try {
		cohortId = (await _internals.resolveCohortId(directory)).cohortId;
	} catch {
		// keep 'unknown'
	}

	// IR-2 fix: ATOMIC CLAIM under the directory lock. The cursor file lives in
	// the same store dir as knowledge.jsonl, so locking the store dir serializes
	// cursor claims against all knowledge I/O. This prevents two concurrent
	// cohort postmortems from both reading the same cursor position and claiming
	// the same batch. The read+select+advance happens in ONE locked section.
	const lockfile = (await import('proper-lockfile')).default;
	const storeDir = _internals.resolveKnowledgeStoreDir(directory);
	let batch: KnowledgeEntryBase[] = [];
	let generation = 1;
	let sweepCompleted = false;
	let remainingAfter = 0;

	let release: (() => Promise<void>) | undefined;
	try {
		release = await lockfile.lock(storeDir, {
			retries: { retries: 5, minTimeout: 100, maxTimeout: 500 },
			stale: 5000,
		});

		// Read cursor INSIDE lock.
		const now = new Date().toISOString();
		let cursor = await readCursor(directory);

		// Initialize or roll to a fresh sweep if the previous one completed.
		if (!cursor) {
			cursor = {
				cohort_id: cohortId,
				last_visited_sort_key: '',
				generation: 1,
				completed: false,
				remaining_estimate: eligible.length,
				updated_at: now,
			};
		} else if (cursor.completed) {
			cursor = {
				...cursor,
				cohort_id: cohortId,
				last_visited_sort_key: '',
				generation: cursor.generation + 1,
				completed: false,
				remaining_estimate: eligible.length,
				updated_at: now,
			};
		}

		// Select entries beyond the cursor's last-visited position.
		const cursorKey = cursor.last_visited_sort_key;
		const pending = eligible.filter((e) => entrySortKey(e) > cursorKey);
		batch = pending.slice(0, batchSize);
		remainingAfter = pending.length - batch.length;

		const sweepDone = remainingAfter === 0;
		const lastVisited =
			batch.length > 0 ? entrySortKey(batch[batch.length - 1]) : cursorKey;

		const nextCursor: ScanCursorState = {
			...cursor,
			last_visited_sort_key: lastVisited,
			completed: sweepDone,
			remaining_estimate: remainingAfter,
			updated_at: now,
		};
		generation = nextCursor.generation;
		sweepCompleted = sweepDone;

		// Write cursor INSIDE lock (atomic claim).
		await writeCursor(directory, nextCursor);
	} finally {
		if (release) {
			try {
				await release();
			} catch {
				/* non-blocking */
			}
		}
	}

	return {
		entries: batch,
		generation,
		sweepCompleted,
		remaining_estimate: remainingAfter,
	};
}

/**
 * Read scan status for diagnostics (issue #1848 §4 "remaining eligible work").
 */
export async function getScanStatus(directory: string): Promise<ScanStatus> {
	let cohortId = 'unknown';
	try {
		cohortId = (await _internals.resolveCohortId(directory)).cohortId;
	} catch {
		// keep 'unknown'
	}
	const cursor = await readCursor(directory);
	if (!cursor) {
		return {
			generation: 0,
			completed: false,
			remaining_estimate: 0,
			cohort_id: cohortId,
		};
	}
	return {
		generation: cursor.generation,
		completed: cursor.completed,
		remaining_estimate: cursor.remaining_estimate,
		cohort_id: cursor.cohort_id,
	};
}

/**
 * Check whether a non-idempotent action should be skipped for this entry in the
 * current generation (C-5 fix, second layer of idempotency). Returns true if
 * the entry was already curated in this generation → skip the action.
 */
export function alreadyCuratedThisGeneration(
	entry: { last_curated_generation?: number },
	generation: number,
): boolean {
	return entry.last_curated_generation === generation;
}
