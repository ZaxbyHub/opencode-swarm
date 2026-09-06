import * as fs from 'node:fs';
import { closeProjectDb } from '../../db/project-db';
import { atomicWriteSwarmFileSync } from '../../utils/atomic-write';
import {
	type BunCompatSpawnOptions,
	type BunCompatSubprocess,
	bunSpawn,
} from '../../utils/bun-compat';
import { canonicalRootKeyFresh } from '../../utils/canonical-root';
import { resolveGitExecutable } from '../../utils/git-executable.js';
import * as logger from '../../utils/logger.js';
import { removeWorktree } from '../../worktree/core';
import { validateSwarmPath } from '../utils';

/**
 * Issue #2599: deferred dead-lane reclaim.
 *
 * When a lane-directory cleanup fails on a held handle (EBUSY on Windows —
 * typically the leaked child session's `swarm.db` WAL), the failure is
 * recorded here and the next plugin start (init orphan recovery) retries the
 * removal with `closeProjectDb` FIRST. This converts a "task wedged until
 * host restart" state into a typed, actionable, self-healing one.
 *
 * Deliberately NOT alternate lane-id suffixes: the deterministic lane path is
 * the identity key for ownership matching (worktree-collision-ownership), and
 * suffixed lanes would strand one new locked directory per retry.
 *
 * Store pattern mirrors `worktree-provisioning-owner.ts`: a bounded JSON file
 * under `.swarm/`, written via `atomicWriteSwarmFileSync`, never grown past
 * the entry/byte caps.
 */

// validateSwarmPath joins `.swarm/` itself — keep this filename-only.
const DEAD_LANE_RECLAIM_PATH = 'dead-lane-reclaims.json';
const MAX_DEAD_LANE_RECLAIMS = 512;
const MAX_DEAD_LANE_RECLAIM_BYTES = 256 * 1024;
const LANE_DIRTY_CHECK_TIMEOUT_MS = 5_000;
/** Only the first 4 KiB of `git status --porcelain` matter (emptiness check). */
const LANE_DIRTY_STDOUT_CAP_BYTES = 4096;

export interface DeadLaneReclaimEntry {
	lanePath: string;
	branchName: string;
	parentSessionId: string;
	taskId: string;
	/** The removal error that stranded the lane (e.g. `EBUSY: ...`). */
	reason: string;
	recordedAt: number;
}

interface DeadLaneReclaimStore {
	schemaVersion: 1;
	entries: DeadLaneReclaimEntry[];
}

export interface ReclaimDeadLanesContext {
	/**
	 * Session ids that still own live state (#2527 interplay: a lane whose
	 * parent session is active, or whose path is protected by recovery/
	 * ownership machinery, is NOT reclaimable — it is not dead).
	 */
	activeSessionIds?: Iterable<string>;
	protectedWorktreePaths?: Iterable<string>;
}

export interface ReclaimDeadLanesResult {
	reclaimed: string[];
	retained: Array<{ lanePath: string; reason: string }>;
}

function storePath(directory: string): string {
	return validateSwarmPath(directory, DEAD_LANE_RECLAIM_PATH);
}

function isDeadLaneReclaimEntry(value: unknown): value is DeadLaneReclaimEntry {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
	const candidate = value as Record<string, unknown>;
	return (
		typeof candidate.lanePath === 'string' &&
		candidate.lanePath.length > 0 &&
		typeof candidate.branchName === 'string' &&
		typeof candidate.parentSessionId === 'string' &&
		typeof candidate.taskId === 'string' &&
		typeof candidate.reason === 'string' &&
		typeof candidate.recordedAt === 'number'
	);
}

function readStore(directory: string): DeadLaneReclaimStore {
	try {
		const raw = fs.readFileSync(storePath(directory), 'utf-8');
		if (raw.length > MAX_DEAD_LANE_RECLAIM_BYTES) {
			return { schemaVersion: 1, entries: [] };
		}
		const parsed = JSON.parse(raw) as Partial<DeadLaneReclaimStore>;
		if (
			!parsed ||
			parsed.schemaVersion !== 1 ||
			!Array.isArray(parsed.entries)
		) {
			return { schemaVersion: 1, entries: [] };
		}
		return {
			schemaVersion: 1,
			entries: parsed.entries.filter(isDeadLaneReclaimEntry),
		};
	} catch {
		return { schemaVersion: 1, entries: [] };
	}
}

function writeStore(directory: string, store: DeadLaneReclaimStore): void {
	// Bound the store on BOTH axes — newest records kept, oldest dropped —
	// so the on-disk file never exceeds the byte cap the bounded read enforces.
	let entries = store.entries.slice(-MAX_DEAD_LANE_RECLAIMS);
	for (;;) {
		const serialized = JSON.stringify({ schemaVersion: 1, entries }, null, 2);
		if (
			serialized.length <= MAX_DEAD_LANE_RECLAIM_BYTES ||
			entries.length === 0
		) {
			// PRR-104: bound-dropping is logged (debug-gated via logger.log —
			// set OPENCODE_SWARM_DEBUG=1 to audit a missing strand record).
			if (entries.length < store.entries.length) {
				logger.log(
					`[dead-lane-reclaim] store bound dropped ${
						store.entries.length - entries.length
					} oldest entries (caps: ${MAX_DEAD_LANE_RECLAIMS} entries / ${MAX_DEAD_LANE_RECLAIM_BYTES} bytes)`,
				);
			}
			_internals.atomicWriteSwarmFileSync(storePath(directory), serialized);
			return;
		}
		entries = entries.slice(1);
	}
}

/** Record a dead lane for next-start reclaim. Dedupes by lanePath. */
export function recordDeadLaneReclaim(
	directory: string,
	entry: Omit<DeadLaneReclaimEntry, 'recordedAt'>,
): void {
	try {
		const store = readStore(directory);
		const filtered = store.entries.filter(
			(existing) => existing.lanePath !== entry.lanePath,
		);
		filtered.push({ ...entry, recordedAt: Date.now() });
		writeStore(directory, { schemaVersion: 1, entries: filtered });
	} catch (error) {
		logger.log(
			`[dead-lane-reclaim] could not record stranded lane ${entry.lanePath}: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
	}
}

/** Read-only view for diagnostics and tests. */
export function listDeadLaneReclaims(
	directory: string,
): DeadLaneReclaimEntry[] {
	return readStore(directory).entries;
}

function isLaneOwnedByActiveSession(
	lanePath: string,
	activeSessionIds: Set<string>,
	parentSessionId?: string,
): boolean {
	if (activeSessionIds.has(parentSessionId ?? '')) {
		return true;
	}
	// PRR-108 hardening: the strand record pairs lanePath with its parent
	// session id at write time (the lane path embeds the session segment).
	// A record whose path does NOT embed its own session id is
	// self-inconsistent (tampered/malformed store) — never trust it for
	// deletion; preserve so the mismatch surfaces on every start.
	if (
		parentSessionId &&
		!lanePathIncludesSessionSegment(lanePath, parentSessionId)
	) {
		return true;
	}
	return false;
}

function lanePathIncludesSessionSegment(
	lanePath: string,
	sessionId: string,
): boolean {
	return lanePath.replace(/\\/g, '/').split('/').includes(sessionId);
}

/**
 * Dirty-lane gate (#2508 interplay): a lane with uncommitted changes is NEVER
 * purged without the shared confirmation primitive — fail closed. Any git
 * error also counts as dirty: an unknowable state is not a purgeable state.
 */
async function isLaneDirty(lanePath: string): Promise<boolean> {
	let proc: BunCompatSubprocess | undefined;
	try {
		const options: BunCompatSpawnOptions = {
			cwd: lanePath,
			stdin: 'ignore',
			stdout: 'pipe',
			stderr: 'pipe',
			timeout: LANE_DIRTY_CHECK_TIMEOUT_MS,
			killProcessTree: true,
		};
		proc = _internals.bunSpawn(
			[
				_internals.resolveGitExecutable(),
				'-C',
				lanePath,
				'status',
				'--porcelain',
			],
			options,
		);
		let stdout = '';
		if (proc.stdout) {
			const reader = proc.stdout.getReader();
			for (;;) {
				const { done, value } = await reader.read();
				if (done || !value) break;
				stdout += Buffer.from(value).toString('utf-8');
				if (stdout.length > LANE_DIRTY_STDOUT_CAP_BYTES) break;
			}
		}
		const code = await proc.exited;
		if (code !== 0) return true; // fail closed: git error ⇒ treat as dirty
		return stdout.trim().length > 0;
	} catch {
		return true; // fail closed
	} finally {
		try {
			proc?.kill?.();
		} catch {
			// Already exited.
		}
	}
}

/**
 * Reclaim every recorded dead lane whose gates pass. Runs inside the bounded,
 * fail-open next-start init task (`runInitOrphanRecovery`), so it never throws
 * and never blocks init: per-lane failures retain the entry for the next start.
 */
export async function reclaimDeadLanes(
	directory: string,
	context: ReclaimDeadLanesContext = {},
): Promise<ReclaimDeadLanesResult> {
	const result: ReclaimDeadLanesResult = { reclaimed: [], retained: [] };
	let store: DeadLaneReclaimStore;
	try {
		store = readStore(directory);
	} catch {
		return result;
	}
	if (store.entries.length === 0) return result;

	const activeSessionIds = new Set(context.activeSessionIds ?? []);
	const protectedPaths = new Set(context.protectedWorktreePaths ?? []);
	const retained: DeadLaneReclaimEntry[] = [];

	for (const entry of store.entries) {
		// Issue #2599 critic round 1: the production caller builds
		// protectedWorktreePaths with worktreePathKey() — canonicalized
		// (realpath + win32 lowercasing) — while the store records the raw
		// strand-time spelling. Match BOTH forms or the gate is a guaranteed
		// miss on Windows (drive-letter case), the platform this fix targets.
		const protectedLane =
			protectedPaths.has(entry.lanePath) ||
			protectedPaths.has(_internals.canonicalRootKeyFresh(entry.lanePath));
		if (
			_internals.isLaneOwnedByActiveSession(
				entry.lanePath,
				activeSessionIds,
				entry.parentSessionId,
			) ||
			protectedLane
		) {
			retained.push(entry);
			result.retained.push({
				lanePath: entry.lanePath,
				reason: 'owned-by-active-session-or-protected',
			});
			continue;
		}
		if (!(await _internals.pathExists(entry.lanePath))) {
			// The lane is already gone — the entry is stale; drop it.
			continue;
		}
		if (await _internals.isLaneDirty(entry.lanePath)) {
			retained.push(entry);
			result.retained.push({
				lanePath: entry.lanePath,
				reason: 'dirty-lane-preserved',
			});
			continue;
		}
		// Issue #2599 AC5: release the lane DB handle BEFORE deleting the
		// directory (Windows WAL lock ⇒ EBUSY otherwise).
		_internals.closeProjectDb(entry.lanePath);
		let removalError: string | undefined;
		try {
			const removal = await _internals.removeWorktree(
				entry.lanePath,
				directory,
			);
			if ('error' in removal) removalError = removal.error;
		} catch (error) {
			// A throwing removal (EBUSY from any layer) is a retained entry,
			// never an abort of the whole reclaim pass.
			removalError = error instanceof Error ? error.message : String(error);
		}
		if (removalError !== undefined) {
			retained.push(entry);
			result.retained.push({ lanePath: entry.lanePath, reason: removalError });
			continue;
		}
		result.reclaimed.push(entry.lanePath);
	}

	try {
		if (retained.length === 0) {
			// Nothing left: remove the store file entirely.
			fs.rmSync(storePath(directory), { force: true });
		} else {
			writeStore(directory, { schemaVersion: 1, entries: retained });
		}
	} catch (error) {
		logger.log(
			`[dead-lane-reclaim] could not persist reclaim state: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
	}
	return result;
}

async function pathExists(target: string): Promise<boolean> {
	try {
		await fs.promises.stat(target);
		return true;
	} catch {
		return false;
	}
}

export const _internals: {
	removeWorktree: typeof removeWorktree;
	closeProjectDb: typeof closeProjectDb;
	isLaneOwnedByActiveSession: typeof isLaneOwnedByActiveSession;
	isLaneDirty: typeof isLaneDirty;
	pathExists: typeof pathExists;
	bunSpawn: typeof bunSpawn;
	resolveGitExecutable: typeof resolveGitExecutable;
	atomicWriteSwarmFileSync: typeof atomicWriteSwarmFileSync;
	canonicalRootKeyFresh: typeof canonicalRootKeyFresh;
} = {
	removeWorktree,
	closeProjectDb,
	isLaneOwnedByActiveSession,
	isLaneDirty,
	pathExists,
	bunSpawn,
	resolveGitExecutable,
	atomicWriteSwarmFileSync,
	canonicalRootKeyFresh,
};
