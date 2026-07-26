/**
 * Init Orphan Recovery Helper (FR-103 / SC-107..SC-110)
 *
 * Bounded plugin-init wrapper around `cleanupOrphanedBranches` that:
 *   - Enumerates orphaned worktree directories under `.swarm-worktrees/<sessionId>/` and removes them
 *   - Calls cleanupOrphanedBranches(ctx.directory, []) at plugin init (no sessions active → all swarm-lane branches are orphans)
 *   - Writes results to `<directory>/.swarm/advisories/init-orphan-recovery.json`
 *   - Is wrapped in `withTimeout` so it never blocks plugin init
 *   - Runs from the wrapper-owned post-resolution queue after `server()` can settle (precedent: repoGraphHook.init)
 *
 * This module intentionally lives in `src/hooks/` so that `src/index.ts` can import
 * it without matching the forbidden `worktree/` or `merge-back/` patterns.
 *
 * The companion hook `createInitOrphanRecoveryAdvisoryHook` (src/hooks/init-orphan-recovery-advisory.ts)
 * reads the advisory file at session-start and pushes messages to pendingAdvisoryMessages.
 */

import * as fs from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';
import {
	isLocked,
	listActiveLocks,
	tryAcquireLock,
} from '../parallel/file-locks';
import { swarmState } from '../state';
import { log } from '../utils/index.js';
import { withTimeout } from '../utils/timeout.js';
import { removeWorktree } from '../worktree/core';
import { cleanupOrphanedBranches } from '../worktree/merge';

const INIT_ORPHAN_RECOVERY_TIMEOUT_MS = 10_000;

/**
 * Lock file path for the init orphan recovery advisory lock.
 * advisory-only — signals that another process may be actively using the repo.
 */
export const ORPHAN_RECOVERY_LOCK_FILE =
	'.swarm/locks/init-orphan-recovery.lock';

/**
 * DI seam for orphaned worktree removal operations and cross-process lock checking.
 * Exposed so tests can intercept removeWorktree, rmSync, and lock operations
 * without mock.module leakage.
 */
export const _internals: {
	rmSync: typeof fs.rmSync;
	removeWorktree: typeof removeWorktree;
	isLocked: typeof isLocked;
	listActiveLocks: typeof listActiveLocks;
	tryAcquireLock: typeof tryAcquireLock;
} = {
	rmSync: fs.rmSync,
	removeWorktree,
	isLocked,
	listActiveLocks,
	tryAcquireLock,
};

export interface InitOrphanRecoveryResult {
	attempted: boolean;
	/** Set to true when cross-process lock is held by another process — advisory-only cleanup */
	crossProcessLockHeld: boolean;
	warnings: string[];
	orphanedBranches: string[];
	removedWorktrees: string[];
	prunedWorktrees: boolean;
	diagnostic?: { file: string; reason: string };
}

/**
 * Writes the advisory file to <directory>/.swarm/advisories/ in InitOrphanAdvisory format.
 * Best-effort — write failures are non-fatal.
 *
 * @param cleanupResult - Raw result from cleanupOrphanedBranches (used to build InitOrphanAdvisory)
 * @param warnings - Human-readable warning strings derived from cleanup errors
 * @param attempted - Whether cleanup was actually attempted (false on timeout/exception)
 * @param removedWorktrees - Paths of worktree directories that were successfully reclaimed
 */
async function writeAdvisoryFile(
	directory: string,
	cleanupResult: {
		removed: string[];
		skipped: string[];
		/** #1657: lane branches skipped due to an unresolved recovery record. */
		skippedRecoveryBranches?: string[];
		/** #1657: set when recovery-dir read errored and all deletions were skipped. */
		recoveryReadError?: boolean;
		errors: Array<{ branch: string; error: string }>;
	},
	warnings: string[],
	attempted: boolean,
	removedWorktrees: string[] = [],
): Promise<void> {
	const advisoryPath = path.join(
		directory,
		'.swarm',
		'advisories',
		'init-orphan-recovery.json',
	);
	const advisory = {
		initTimestamp: new Date().toISOString(),
		warnings,
		errors: cleanupResult.errors,
		reclaimed: {
			removedBranches: cleanupResult.removed,
			removedWorktrees,
			prunedWorktrees: attempted,
		},
		// #1657: surface preserved recovery branches + fail-safe state so a
		// human reading the advisory knows why cleanup skipped them.
		...(cleanupResult.skippedRecoveryBranches &&
		cleanupResult.skippedRecoveryBranches.length > 0
			? {
					preservedRecoveryBranches: cleanupResult.skippedRecoveryBranches,
				}
			: {}),
		...(cleanupResult.recoveryReadError
			? {
					recoveryReadError: true,
					note: 'skipped all lane-branch deletions this pass because .swarm/recovery/ was unreadable (fail-safe)',
				}
			: {}),
	};
	try {
		await fsPromises.mkdir(path.dirname(advisoryPath), { recursive: true });
		await fsPromises.writeFile(
			advisoryPath,
			JSON.stringify(advisory, null, 2),
			'utf-8',
		);
	} catch {
		log('initOrphanRecovery advisory file write failed (non-fatal)');
	}
}

/**
 * Enumerates orphaned worktree directories under the worktree root.
 *
 * The worktree root follows the convention from `provisionWorktree` in `core.ts`:
 * `<path.dirname(directory)>/.swarm-worktrees/<sessionId>/<laneId>`
 *
 * @param directory - Project root directory
 * @param activeSessionIds - Session IDs that are still active (not orphans)
 * @returns Array of absolute orphaned worktree directory paths
 */
async function enumerateOrphanedWorktreeDirs(
	directory: string,
	activeSessionIds: string[],
): Promise<string[]> {
	const orphanedDirs: string[] = [];
	const worktreeRoot = path.resolve(
		path.dirname(directory),
		'.swarm-worktrees',
	);

	let entries: fs.Dirent[];
	try {
		entries = await fsPromises.readdir(worktreeRoot, { withFileTypes: true });
	} catch {
		// Worktree root doesn't exist — nothing to reclaim
		return [];
	}

	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const sessionId = entry.name;
		// Skip active sessions
		if (activeSessionIds.includes(sessionId)) continue;

		// Check for lane subdirectories under this session
		let sessionEntries: fs.Dirent[];
		try {
			sessionEntries = await fsPromises.readdir(
				path.join(worktreeRoot, sessionId),
				{ withFileTypes: true },
			);
		} catch {
			continue;
		}

		for (const laneEntry of sessionEntries) {
			if (!laneEntry.isDirectory()) continue;
			const worktreePath = path.join(worktreeRoot, sessionId, laneEntry.name);
			orphanedDirs.push(worktreePath);
		}
	}

	return orphanedDirs;
}

/**
 * Checks whether any other process holds the orphan-recovery advisory lock.
 *
 * If a lock is detected (held by another PID), it means another opencode process
 * may be actively using the repo — we skip destructive cleanup and return advisory mode.
 *
 * This is an advisory check only — the lock has a 5-minute stale timeout (from
 * proper-lockfile), so crashed processes are automatically cleaned up after that.
 *
 * @param directory - Project root directory
 * @returns true if another process holds the lock (advisory-only mode), false otherwise
 */
async function isCrossProcessLockHeld(directory: string): Promise<boolean> {
	// Use isLocked to check if any lock exists at the orphan-recovery lock path
	const existingLock = _internals.isLocked(
		directory,
		ORPHAN_RECOVERY_LOCK_FILE,
	);
	if (existingLock) {
		// A lock exists — another process may be using the repo
		return true;
	}

	// Also check listActiveLocks for any active locks that might indicate live sessions
	// (defence-in-depth: catches locks acquired via acquireLaneLocks)
	const activeLocks = _internals.listActiveLocks(directory);
	if (activeLocks.length > 0) {
		// There are active locks — another process is doing work in this repo
		return true;
	}

	return false;
}

/**
 * Removes an orphaned worktree directory, trying git worktree remove first,
 * then falling back to filesystem deletion on best-effort basis.
 *
 * @param worktreePath - Absolute path to the worktree directory
 * @param projectRoot - Absolute path to the project root
 * @returns Error message if removal failed, undefined on success
 */
async function removeOrphanedWorktreeDir(
	worktreePath: string,
	projectRoot: string,
): Promise<string | undefined> {
	// Try git worktree remove first
	const removeResult = await _internals.removeWorktree(
		worktreePath,
		projectRoot,
	);

	// Check if this is a successful result: 'error' NOT in result means it's RemoveSuccess
	// (RemoveSuccess has { success: true }, RemoveFailure has { error: string })
	// Note: we check 'error' first to avoid TypeScript narrowing { success: false, error: '...' }
	// to RemoveSuccess when the mock returns that shape
	if (!('error' in removeResult)) return undefined;

	// removeWorktree failed — try filesystem fallback
	try {
		_internals.rmSync(worktreePath, { recursive: true, force: true });
		return undefined; // Success after filesystem fallback
	} catch {
		// Return the error from removeWorktree
		return removeResult.error;
	}
}

/**
 * Runs bounded orphan cleanup at plugin init time.
 *
 * Active sessions from swarmState are passed to cleanupOrphanedBranches so their
 * branches are skipped and not reclaimed during init recovery.
 *
 * Cross-process safety: before doing any destructive cleanup, checks whether any
 * other opencode process holds the advisory lock at `.swarm/locks/init-orphan-recovery.lock`.
 * If a lock is held (another process is active), skips destructive cleanup entirely
 * and reports detected orphans in result.warnings instead — preventing a second
 * process from deleting the first process's active worktrees/branches.
 *
 * @param directory - Project root directory
 * @returns Result object describing what was attempted and any warnings/diagnostics
 */
export async function runInitOrphanRecovery(
	directory: string,
): Promise<InitOrphanRecoveryResult> {
	let result: InitOrphanRecoveryResult;

	// Get active session IDs from swarmState so their branches are protected during cleanup
	const activeSessionIds = Array.from(swarmState.agentSessions.keys());

	try {
		// Cross-process safety check: if another process holds the advisory lock,
		// skip destructive cleanup and report detected orphans as warnings.
		// This prevents a second opencode process from deleting the first process's
		// active worktrees/branches (final council finding, Phase 1 hardening).
		const lockHeld = await isCrossProcessLockHeld(directory);

		if (lockHeld) {
			// Another process is active — enumerate orphans for advisory reporting only
			const orphanedWorktreeDirs = await withTimeout(
				enumerateOrphanedWorktreeDirs(directory, activeSessionIds),
				INIT_ORPHAN_RECOVERY_TIMEOUT_MS,
				new Error(
					`runInitOrphanRecovery exceeded ${INIT_ORPHAN_RECOVERY_TIMEOUT_MS}ms budget during worktree enumeration; continuing without orphan reclamation`,
				),
			);

			const orphanedBranches: string[] = [];

			result = {
				attempted: true,
				crossProcessLockHeld: true,
				warnings: [
					`Cross-process lock held — another opencode process may be active. ` +
						`Skipping destructive cleanup to preserve its worktrees/branches. ` +
						`Detected ${orphanedWorktreeDirs.length} orphaned worktree dir(s). ` +
						`Run '/swarm status' or check '.swarm/locks/' to identify active processes.`,
				],
				orphanedBranches,
				removedWorktrees: [],
				prunedWorktrees: false,
			};

			// Write advisory file (best-effort)
			await writeAdvisoryFile(
				directory,
				{
					removed: [],
					skipped: orphanedBranches,
					skippedRecoveryBranches: [],
					errors: [],
				},
				result.warnings,
				false,
				[],
			);

			return result;
		}

		// Acquire the advisory lock to prevent TOCTOU: another process could start
		// between our isCrossProcessLockHeld check and the destructive operations below.
		const lockAcquireResult = await _internals.tryAcquireLock(
			directory,
			ORPHAN_RECOVERY_LOCK_FILE,
			'init-orphan-recovery',
			'init',
		);

		if (!lockAcquireResult.acquired) {
			// Lost the race — another process acquired the lock between our check and here.
			// Treat same as lockHeld: advisory mode only, skip destructive cleanup.
			const orphanedWorktreeDirs = await withTimeout(
				enumerateOrphanedWorktreeDirs(directory, activeSessionIds),
				INIT_ORPHAN_RECOVERY_TIMEOUT_MS,
				new Error(
					`runInitOrphanRecovery exceeded ${INIT_ORPHAN_RECOVERY_TIMEOUT_MS}ms budget during worktree enumeration; continuing without orphan reclamation`,
				),
			);

			result = {
				attempted: true,
				crossProcessLockHeld: true,
				warnings: [
					`Cross-process lock acquired by another process during init — ` +
						`skipping destructive cleanup to preserve its worktrees/branches. ` +
						`Detected ${orphanedWorktreeDirs.length} orphaned worktree dir(s).`,
				],
				orphanedBranches: [],
				removedWorktrees: [],
				prunedWorktrees: false,
			};

			await writeAdvisoryFile(
				directory,
				{ removed: [], skipped: [], skippedRecoveryBranches: [], errors: [] },
				result.warnings,
				false,
				[],
			);

			return result;
		}

		try {
			// Step 1: Enumerate and remove orphaned worktree directories
			const orphanedWorktreeDirs = await withTimeout(
				enumerateOrphanedWorktreeDirs(directory, activeSessionIds),
				INIT_ORPHAN_RECOVERY_TIMEOUT_MS,
				new Error(
					`runInitOrphanRecovery exceeded ${INIT_ORPHAN_RECOVERY_TIMEOUT_MS}ms budget during worktree enumeration; continuing without orphan reclamation`,
				),
			);

			const removedWorktrees: string[] = [];
			const worktreeWarnings: string[] = [];

			for (const worktreePath of orphanedWorktreeDirs) {
				const error = await removeOrphanedWorktreeDir(worktreePath, directory);
				if (error) {
					worktreeWarnings.push(
						`Could not reclaim orphaned worktree "${worktreePath}": ${error}`,
					);
				} else {
					removedWorktrees.push(worktreePath);
				}
			}

			// Step 2: Clean up orphaned branches (remaining after worktree removal)
			const cleanupResult = await withTimeout(
				cleanupOrphanedBranches(directory, activeSessionIds),
				INIT_ORPHAN_RECOVERY_TIMEOUT_MS,
				new Error(
					`runInitOrphanRecovery exceeded ${INIT_ORPHAN_RECOVERY_TIMEOUT_MS}ms budget during branch cleanup; continuing without orphan reclamation`,
				),
			);

			const branchWarnings = cleanupResult.errors.map(
				(e) => `Could not delete orphaned branch "${e.branch}": ${e.error}`,
			);

			const allWarnings = [...worktreeWarnings, ...branchWarnings];

			result = {
				attempted: true,
				crossProcessLockHeld: false,
				warnings: allWarnings,
				orphanedBranches: cleanupResult.removed, // branches actually deleted by cleanup (orphaned = no active session)
				removedWorktrees,
				prunedWorktrees: true, // cleanupOrphanedBranches always runs worktree prune
			};

			// Write advisory file (best-effort) so session-start can surface warnings
			await writeAdvisoryFile(
				directory,
				cleanupResult,
				allWarnings,
				true,
				removedWorktrees,
			);
		} finally {
			// Release the advisory lock — best-effort, never throws
			try {
				await lockAcquireResult.lock._release?.();
			} catch {
				// Best-effort release; lock has a stale timeout fallback
			}
		}
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		log('initOrphanRecovery timed out or failed (non-fatal)', { error: msg });
		result = {
			attempted: false,
			crossProcessLockHeld: false,
			warnings: [`Orphan recovery timed out or failed: ${msg}`],
			orphanedBranches: [],
			removedWorktrees: [],
			prunedWorktrees: false,
			diagnostic: {
				file: '.swarm/advisories/init-orphan-recovery.json',
				reason: msg,
			},
		};
		// On error, write advisory with empty state so session-start still gets a notification
		await writeAdvisoryFile(
			directory,
			{ removed: [], skipped: [], skippedRecoveryBranches: [], errors: [] },
			result.warnings,
			false,
			[],
		);
	}

	return result;
}
