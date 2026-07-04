/**
 * Worktree merge-back status registry (leaf module — no app imports).
 *
 * Bridges two subsystems that otherwise cannot see each other:
 *
 *   - WORKTREE ISOLATION (`worktree-isolation.ts`) knows, at merge-back
 *     time, whether a Task-dispatched coder's isolated worktree merged
 *     cleanly back into the main tree.
 *   - EPIC MODE Rule 2 (`plan/manager.updateTaskStatus`) auto-commits a
 *     `swarm(task <id>):` marker on completion. That marker is the
 *     evidence Rule 3 scans to decide a downstream task's upstream is
 *     satisfied.
 *
 * Without this bridge, a coder whose worktree merge-back FAILED (conflict)
 * leaves its changes stranded in the preserved worktree, yet Rule 2 would
 * still fire an `--allow-empty` marker and Rule 3 would treat the task as
 * done — silently advancing the plan past work that never landed.
 *
 * This module is deliberately a LEAF: it imports nothing from the app so
 * that both `worktree-isolation.ts` (writer) and `plan/manager.ts` (reader)
 * can depend on it without creating an import cycle.
 *
 * STATE DURABILITY: Status is stored in an in-memory Map (fast, per-process)
 * AND persisted to `.swarm/worktree-merge-status.json` (survives plugin restart).
 * On each write, the JSON file is atomically updated. On read, the in-memory
 * map is checked first (fast path); on plugin restart, the map is empty but
 * the durable file is restored on first read or Rule 2 lookup.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

/** Why a task's worktree work did not fully reach the main tree. */
export type WorktreeMergeOutcome = 'partial' | 'failed';

export interface WorktreeMergeFailure {
	outcome: WorktreeMergeOutcome;
	/** Pipeline stage that failed (e.g. 'merge', 'auto-commit'). */
	stage: string;
	/** Human-readable detail surfaced in the Rule 2 skip warning. */
	message: string;
	/** Worktree path where the lane is preserved after a failed/partial merge. */
	worktreePath?: string;
	/** Branch name of the lane. */
	branch?: string;
	/** Timestamp (Date.now()) when the lane entered merge-back. */
	queuedAt?: number;
	/** Timestamp (Date.now()) when merge-back completed (success or failure). */
	completedAt?: number;
}

const failuresByTask = new Map<string, WorktreeMergeFailure>();
let durableStatusPath: string | undefined;
/**
 * True once the durable file has been read into `failuresByTask` for the
 * current `durableStatusPath`. Guards against re-reading (and re-clearing)
 * the in-memory map on every lookup: the disk file is loaded exactly once
 * per init (or once lazily if init was skipped), after which the in-memory
 * map is the live authority and is kept in sync by every record/clear write.
 */
let hasLoaded = false;

function getDurableStatusPath(projectDir?: string): string {
	if (durableStatusPath) return durableStatusPath;
	if (!projectDir)
		throw new Error('durableStatusPath not set and projectDir not provided');
	return path.join(projectDir, '.swarm', 'worktree-merge-status.json');
}

/**
 * Load the durable file into the in-memory map. The clear+repopulate is
 * synchronous (no `await`), so no read can observe a transiently-empty map
 * in Node's single-threaded model. Called only from init and the one-shot
 * lazy load — never on a steady-state lookup.
 */
function loadDurableStatus(statusPath: string): void {
	try {
		hasLoaded = true;
		if (!fs.existsSync(statusPath)) {
			failuresByTask.clear();
			return;
		}
		const data = JSON.parse(fs.readFileSync(statusPath, 'utf-8'));
		if (data && typeof data === 'object') {
			failuresByTask.clear();
			for (const [taskId, failure] of Object.entries(data)) {
				failuresByTask.set(taskId, failure as WorktreeMergeFailure);
			}
		}
	} catch {
		// Corrupt or unreadable file — fail open, start with empty registry
		failuresByTask.clear();
	}
}

function saveDurableStatus(statusPath: string): void {
	const dir = path.dirname(statusPath);
	try {
		if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
		// Atomic write: write to a UNIQUE temp file then rename. The unique
		// suffix avoids any chance of two writers (or a crashed prior write)
		// colliding on a shared `${statusPath}.tmp` path.
		const tempPath = `${statusPath}.tmp.${crypto.randomBytes(8).toString('hex')}`;
		const data = Object.fromEntries(failuresByTask);
		try {
			fs.writeFileSync(tempPath, JSON.stringify(data, null, 2), 'utf-8');
			fs.renameSync(tempPath, statusPath);
		} catch (err) {
			// Best-effort cleanup of the temp file on rename/write failure.
			try {
				fs.unlinkSync(tempPath);
			} catch {}
			throw err;
		}
	} catch {
		// Non-fatal — in-memory map still works; durable backup may be lost on restart
	}
}

/**
 * Initialize the durable status path for this project and load existing
 * status from disk. Called from `createDelegationGateHook` before any coder
 * dispatches. Re-initializing the SAME path is a no-op (the in-memory map is
 * already the live authority); switching to a DIFFERENT path reloads.
 */
export function initDurableStatusPath(projectDir: string): void {
	const nextPath = path.join(
		projectDir,
		'.swarm',
		'worktree-merge-status.json',
	);
	if (durableStatusPath === nextPath && hasLoaded) return;
	durableStatusPath = nextPath;
	hasLoaded = false;
	loadDurableStatus(durableStatusPath);
}

/**
 * Record that task `taskId`'s worktree merge-back did not fully land.
 * No-op when `taskId` is undefined (non-plan dispatches carry no plan id
 * and are never subject to Epic Rule 2).
 */
export function recordWorktreeMergeFailure(
	taskId: string | undefined,
	failure: WorktreeMergeFailure,
): void {
	if (!taskId) return;
	failuresByTask.set(taskId, failure);
	if (durableStatusPath) saveDurableStatus(durableStatusPath);
}

/**
 * Clear any recorded failure for `taskId`. Called when a (re-)dispatch of
 * the same task merges cleanly, so a later success supersedes an earlier
 * failure and Rule 2 is allowed to commit the marker again.
 */
export function clearWorktreeMergeStatus(taskId: string | undefined): void {
	if (!taskId) return;
	failuresByTask.delete(taskId);
	if (durableStatusPath) saveDurableStatus(durableStatusPath);
}

/**
 * Query whether task `taskId`'s most recent worktree merge-back failed.
 * Returns the failure detail, or undefined when the task merged cleanly,
 * was never worktree-isolated, or has no recorded status.
 * On first read after plugin restart, loads from durable storage.
 */
export function getWorktreeMergeFailure(
	taskId: string,
): WorktreeMergeFailure | undefined {
	// One-shot lazy load as a safety net if init was skipped. Gated on
	// `hasLoaded` (NOT on map size) so a steady-state lookup never re-reads
	// or clears the live in-memory map — that was the foot-gun where an
	// all-resolved (empty) map would re-hit disk on every lookup.
	if (!hasLoaded && durableStatusPath) {
		loadDurableStatus(durableStatusPath);
	}
	return failuresByTask.get(taskId);
}

/**
 * Iterate all worktree merge failures. Used by /swarm lanes to surface
 * conflicted lanes that are NOT in awaitingMergeByCallID (i.e., merge
 * has completed with partial/failed outcome).
 */
export function getAllWorktreeMergeFailures(): IterableIterator<
	[string, WorktreeMergeFailure]
> {
	// One-shot lazy load as a safety net if init was skipped.
	if (!hasLoaded && durableStatusPath) {
		loadDurableStatus(durableStatusPath);
	}
	return failuresByTask.entries();
}

/**
 * @internal test seam. Use `resetForTest()` in afterEach to isolate tests
 * that set durableStatusPath via `initDurableStatusPath`.
 */
export const _internals = {
	failuresByTask,
	getDurableStatusPath,
	loadDurableStatus,
	saveDurableStatus,
	initDurableStatusPath,
	/** Reset both in-memory and durable state for test isolation. */
	resetForTest(): void {
		failuresByTask.clear();
		durableStatusPath = undefined;
		hasLoaded = false;
	},
};
