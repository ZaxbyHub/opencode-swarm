/**
 * Durable merge-back conflict recovery records (#1657).
 *
 * When a lean-turbo lane's merge-back fails (conflict / partial / error), the
 * runner preserves the lane's worktree + branch for manual recovery but —
 * before this module — that information lived only in:
 *   - the in-memory `LeanTurboLane` state (lost when the session ends), and
 *   - a scrolled-away log line.
 *
 * Problem #1: `cleanupOrphanedBranches` (`src/worktree/merge.ts`) force-deletes
 * any lane branch whose session isn't active, including a branch just preserved
 * for recovery. The only copy of unmerged lane work could be deleted by routine
 * init-time cleanup before a human ever sees the recovery message.
 *
 * Problem #2: `/swarm status` had no concept of preserved worktrees, so the
 * architect was blind to pending recovery work unless it re-read the tool
 * result inline.
 *
 * This module writes a durable record under `.swarm/recovery/` on every
 * merge-back failure, lets `cleanupOrphanedBranches` EXEMPT recovery branches
 * (fail-safe on read error), and lets `/swarm status` surface them. Records are
 * auto-cleared when the lane later merges back successfully (no accumulation).
 *
 * Records live ONLY under `.swarm/recovery/` (AGENTS.md invariant 4 — `.swarm/`
 * containment). They are intentionally NOT part of the plan ledger or
 * turbo-state: recovery is a side-channel safety net, not authoritative plan
 * or run state.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * A durable merge-back recovery record. Mirrors `MergeBackFailureInfo` plus
 * the session/bookkeeping fields needed for orphan-cleanup exemption and
 * status surfacing.
 */
export interface RecoveryRecord {
	/** Lane identifier (e.g. "lane-1"). */
	laneId: string;
	/** Session that created the record (for scoping/status). */
	sessionId: string;
	/** Lane branch preserved for recovery (e.g. "swarm-lane/<sid>/<laneId>"). */
	branchName?: string;
	/** Lane worktree filesystem path preserved for recovery. */
	worktreePath: string;
	/** Merge-back failure class. */
	status: 'failed' | 'partial' | 'conflict';
	/** Human-readable reason for the merge-back failure. */
	reason: string;
	/** Conflict files (when status === 'conflict'). */
	conflictFiles?: string[];
	/** Epoch ms when the record was written. */
	recordedAt: number;
	/** Portable human guidance for inspecting the preserved worktree. */
	replayHint: string;
}

const RECOVERY_DIR_NAME = 'recovery';

interface RecoveryReadResult {
	records: RecoveryRecord[];
	errored: boolean;
}

function recoveryDir(directory: string): string {
	return path.join(directory, '.swarm', RECOVERY_DIR_NAME);
}

function recordPath(
	directory: string,
	sessionId: string,
	laneId: string,
): string {
	// Sanitize laneId/sessionId for the filesystem (they are internal IDs but
	// defense-in-depth against any surprising character).
	const safeSession = sessionId.replace(/[^a-zA-Z0-9._-]/g, '_');
	const safeLane = laneId.replace(/[^a-zA-Z0-9._-]/g, '_');
	return path.join(recoveryDir(directory), `${safeSession}-${safeLane}.json`);
}

/**
 * Validate the complete on-disk RecoveryRecord contract.
 *
 * Recovery records are a deletion-safety boundary: accepting a parseable but
 * incomplete record can both render `undefined` in status and hide which
 * worktree/branch must be preserved. Keep this validator shared by listing and
 * fail-safe detection so those paths cannot disagree.
 */
function isRecoveryRecord(value: unknown): value is RecoveryRecord {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		return false;
	}

	const record = value as Record<string, unknown>;
	const validStatus =
		record.status === 'failed' ||
		record.status === 'partial' ||
		record.status === 'conflict';

	return (
		typeof record.laneId === 'string' &&
		typeof record.sessionId === 'string' &&
		typeof record.worktreePath === 'string' &&
		validStatus &&
		typeof record.reason === 'string' &&
		typeof record.recordedAt === 'number' &&
		Number.isFinite(record.recordedAt) &&
		typeof record.replayHint === 'string' &&
		(record.branchName === undefined ||
			typeof record.branchName === 'string') &&
		(record.conflictFiles === undefined ||
			(Array.isArray(record.conflictFiles) &&
				record.conflictFiles.every((file) => typeof file === 'string')))
	);
}

/**
 * Read recovery records once while retaining whether any entry was malformed.
 * Valid siblings are returned for status visibility, while `errored` lets
 * destructive cleanup fail safe for the whole pass.
 */
function readRecoveryRecords(directory: string): RecoveryReadResult {
	const dir = recoveryDir(directory);
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return {
			records: [],
			// An absent directory means there are no recoveries; a present but
			// unreadable directory is a safety error.
			errored: fs.existsSync(dir),
		};
	}

	const records: RecoveryRecord[] = [];
	let errored = false;
	for (const entry of entries) {
		if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
		const full = path.join(dir, entry.name);
		try {
			const parsed: unknown = JSON.parse(fs.readFileSync(full, 'utf-8'));
			if (isRecoveryRecord(parsed)) {
				records.push(parsed);
			} else {
				errored = true;
			}
		} catch {
			errored = true;
		}
	}

	return { records, errored };
}

/**
 * Write a recovery record atomically (temp file + rename, mirroring the
 * `turbo-state.json` pattern in `src/turbo/lean/state.ts`). Best-effort:
 * swallows errors so a recovery-write failure can never break the merge-back
 * path that called it.
 */
export function writeRecoveryRecord(
	directory: string,
	record: Omit<RecoveryRecord, 'recordedAt'> & { recordedAt?: number },
): void {
	try {
		const dir = recoveryDir(directory);
		fs.mkdirSync(dir, { recursive: true });
		const filePath = recordPath(directory, record.sessionId, record.laneId);
		const payload: RecoveryRecord = {
			...record,
			recordedAt: record.recordedAt ?? Date.now(),
		};
		const tmpPath = `${filePath}.tmp.${Date.now()}`;
		fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2), 'utf-8');
		fs.renameSync(tmpPath, filePath);
	} catch {
		// Non-fatal: recovery is a safety net, not a critical path. The
		// merge-back failure itself is already recorded in the tool result
		// and lane state; losing the durable copy only means orphan-cleanup
		// won't exempt this branch — the same behavior as before this module.
	}
}

/**
 * List all recovery records under `.swarm/recovery/`. Tolerates malformed
 * files (skips + continues). Returns `[]` if the directory is absent or
 * unreadable.
 */
export function listRecoveryRecords(directory: string): RecoveryRecord[] {
	return readRecoveryRecords(directory).records;
}

/**
 * Fast check: does any recovery record reference the given branch name?
 * Used by `cleanupOrphanedBranches` to exempt recovery branches. Returns
 * `false` on any read error (the caller decides fail-open vs fail-safe —
 * see `cleanupOrphanedBranches`).
 */
export function hasRecoveryRecordForBranch(
	directory: string,
	branchName: string,
): boolean {
	const records = listRecoveryRecords(directory);
	return records.some((r) => r.branchName === branchName);
}

/**
 * Remove the recovery record for a specific lane + session. Called on
 * SUCCESSFUL merge-back so records don't accumulate (a record exists only
 * while a lane is in a failed/preserved state). Best-effort.
 */
export function clearRecoveryRecord(
	directory: string,
	laneId: string,
	sessionId: string,
): void {
	try {
		const filePath = recordPath(directory, sessionId, laneId);
		if (fs.existsSync(filePath)) {
			fs.unlinkSync(filePath);
		}
	} catch {
		// Non-fatal.
	}
}

/**
 * Did the recovery-directory read itself throw (vs simply being empty)?
 * `cleanupOrphanedBranches` uses this to decide fail-safe behavior: on a
 * genuine read error it skips ALL lane-branch deletions for that pass
 * (recovery safety trumps orphan cleanliness). Returns `true` if the
 * directory exists but could not be read, OR if any record file exists but
 * is unreadable.
 */
export function recoveryReadErrored(directory: string): boolean {
	return readRecoveryRecords(directory).errored;
}
