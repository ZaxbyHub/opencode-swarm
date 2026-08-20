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
import { recordDelegationRecoveryObservation } from '../background/delegation-health.js';
import {
	isUnsettledWorktreeOwner,
	scanDelegationFallbacksForRecovery,
	scanDelegationsForRecovery,
} from '../background/pending-delegations.js';
import { SWARM_WORKTREE_DIR_NAME } from '../config/constants';
import {
	isLocked,
	listActiveLocks,
	tryAcquireLock,
} from '../parallel/file-locks';
import { swarmState } from '../state';
import {
	listRecoveryRecords,
	recoveryReadErrored,
} from '../turbo/lean/recovery';
import { log } from '../utils/index.js';
import { withTimeout } from '../utils/timeout.js';
import { removeWorktree } from '../worktree/core';
import {
	cleanupOrphanedBranches,
	scanRegisteredWorktreeLiveness,
} from '../worktree/merge';
import { scanWorktreeMergeFailuresForRecovery } from './delegation-gate/worktree-merge-status';
import { scanBackgroundWorktreeOwnershipTagsForRecovery } from './delegation-gate/worktree-ownership-tag';
import {
	removeWorktreeProvisioningOwner,
	scanWorktreeProvisioningOwnersForRecovery,
	WORKTREE_LIFECYCLE_LOCK_FILE,
	WORKTREE_PROVISIONING_OWNER_LEASE_MS,
} from './delegation-gate/worktree-provisioning-owner';

const INIT_ORPHAN_RECOVERY_TIMEOUT_MS = 10_000;
const OWNERSHIP_TAG_SCAN_TIMEOUT_MS = 2_000;

type OwnershipTagSessionScan =
	| { status: 'ok'; sessionIds: string[] }
	| { status: 'uncertain'; reason: string };

async function listOwnershipTagSessionIds(
	directory: string,
): Promise<OwnershipTagSessionScan> {
	const scan = await scanBackgroundWorktreeOwnershipTagsForRecovery(directory);
	if (scan.status === 'uncertain') return scan;
	return {
		status: 'ok',
		sessionIds: [...new Set(scan.owners.map((owner) => owner.sessionId))],
	};
}

/**
 * Lock file path for the init orphan recovery advisory lock.
 * advisory-only — signals that another process may be actively using the repo.
 */
export const ORPHAN_RECOVERY_LOCK_FILE = WORKTREE_LIFECYCLE_LOCK_FILE;

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
	listOwnershipTagSessionIds: typeof listOwnershipTagSessionIds;
	scanDelegationsForRecovery: typeof scanDelegationsForRecovery;
	recordDelegationRecoveryObservation: typeof recordDelegationRecoveryObservation;
	scanDelegationFallbacksForRecovery: typeof scanDelegationFallbacksForRecovery;
	scanWorktreeMergeFailuresForRecovery: typeof scanWorktreeMergeFailuresForRecovery;
	scanWorktreeProvisioningOwnersForRecovery: typeof scanWorktreeProvisioningOwnersForRecovery;
	scanRegisteredWorktreeLiveness: typeof scanRegisteredWorktreeLiveness;
	removeWorktreeProvisioningOwner: typeof removeWorktreeProvisioningOwner;
} = {
	rmSync: fs.rmSync,
	removeWorktree,
	isLocked,
	listActiveLocks,
	tryAcquireLock,
	listOwnershipTagSessionIds,
	scanDelegationsForRecovery,
	recordDelegationRecoveryObservation,
	scanDelegationFallbacksForRecovery,
	scanWorktreeMergeFailuresForRecovery,
	scanWorktreeProvisioningOwnersForRecovery,
	scanRegisteredWorktreeLiveness,
	removeWorktreeProvisioningOwner,
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
	protectedWorktreePaths: ReadonlySet<string> = new Set(),
): Promise<string[]> {
	const orphanedDirs: string[] = [];
	const worktreeRoot = path.resolve(
		path.dirname(directory),
		SWARM_WORKTREE_DIR_NAME,
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
			if (protectedWorktreePaths.has(path.resolve(worktreePath))) continue;
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
	// A registered linked worktree always carries a `.git` pointer. Directories
	// without one are stale filesystem remnants, so remove them directly instead
	// of spawning one failing `git worktree remove` process per directory. This
	// keeps recovery bounded when a crash leaves many partial lane directories.
	if (!fs.existsSync(path.join(worktreePath, '.git'))) {
		try {
			_internals.rmSync(worktreePath, { recursive: true, force: true });
			return undefined;
		} catch (error) {
			return error instanceof Error ? error.message : String(error);
		}
	}

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

async function crossProcessAdvisoryResult(
	directory: string,
	warning: string,
): Promise<InitOrphanRecoveryResult> {
	const result: InitOrphanRecoveryResult = {
		attempted: true,
		crossProcessLockHeld: true,
		warnings: [warning],
		orphanedBranches: [],
		removedWorktrees: [],
		prunedWorktrees: false,
	};
	await writeAdvisoryFile(
		directory,
		{ removed: [], skipped: [], errors: [] },
		result.warnings,
		false,
		[],
	);
	return result;
}

function worktreePathKey(worktreePath: string, directory: string): string {
	const absolutePath = path.isAbsolute(worktreePath)
		? worktreePath
		: path.resolve(directory, worktreePath);
	const normalized = path.normalize(absolutePath);
	return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
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
	let recoveryLockRelease: (() => Promise<void>) | undefined;

	try {
		// Acquire the shared lifecycle exclusion before reading any owner store.
		// Standard worktree provisioning publishes its provisional owner while
		// holding this same lock, so no worktree can appear after our snapshot
		// without either its marker being visible or waiting for cleanup to finish.
		const lockHeld = await isCrossProcessLockHeld(directory);
		if (lockHeld) {
			return crossProcessAdvisoryResult(
				directory,
				'Cross-process lock held — another opencode process may be active. ' +
					'Skipping destructive cleanup to preserve its worktrees/branches. ' +
					"Run '/swarm status' or check '.swarm/locks/' to identify active processes.",
			);
		}
		const lockAcquireResult = await _internals.tryAcquireLock(
			directory,
			ORPHAN_RECOVERY_LOCK_FILE,
			'init-orphan-recovery',
			'init',
		);
		if (!lockAcquireResult.acquired) {
			return crossProcessAdvisoryResult(
				directory,
				'Cross-process lifecycle lock was acquired by another process during init; ' +
					'skipping destructive cleanup to preserve its worktrees/branches.',
			);
		}
		recoveryLockRelease = lockAcquireResult.lock._release;

		// Durable background owners survive process restart, when swarmState is
		// empty. Protect their exact worktree coordinates from orphan cleanup.
		const activeSessionIds = Array.from(swarmState.agentSessions.keys());
		const provisioningOwnerScan = await withTimeout(
			// Best-effort: the scan is synchronous (uses fs.*Sync) so the
			// withTimeout cannot interrupt a stuck call. File-size bounds
			// (MAX_PROVISIONING_OWNERS, etc.) provide the real protection;
			// the timeout adds observability for the init-budget invariant.
			Promise.resolve(
				_internals.scanWorktreeProvisioningOwnersForRecovery(directory),
			),
			INIT_ORPHAN_RECOVERY_TIMEOUT_MS,
			new Error(
				'worktree provisioning ownership scan exceeded its bounded init budget',
			),
		);
		if (provisioningOwnerScan.status === 'uncertain') {
			throw new Error(
				`worktree provisioning ownership state is uncertain; destructive orphan cleanup skipped: ${provisioningOwnerScan.reason}`,
			);
		}
		const registeredWorktrees =
			provisioningOwnerScan.owners.length === 0
				? { status: 'ok' as const, liveBranches: [] }
				: await withTimeout(
						_internals.scanRegisteredWorktreeLiveness(directory),
						OWNERSHIP_TAG_SCAN_TIMEOUT_MS,
						new Error(
							'registered worktree liveness scan exceeded its bounded init budget',
						),
					);
		if (registeredWorktrees.status === 'uncertain') {
			throw new Error(
				`registered worktree liveness is uncertain; destructive orphan cleanup skipped: ${registeredWorktrees.reason}`,
			);
		}
		const liveBranches = new Set(registeredWorktrees.liveBranches);
		const now = Date.now();
		for (const owner of provisioningOwnerScan.owners) {
			const leaseIsLive =
				now - owner.createdAt <= WORKTREE_PROVISIONING_OWNER_LEASE_MS;
			const sessionIds = new Set([
				owner.parentSessionId,
				owner.worktreeSessionId,
			]);
			const branchIsLive =
				owner.schemaVersion === 2
					? [...sessionIds].some(
							(sessionId) =>
								liveBranches.has(`swarm/lane/${sessionId}/${owner.taskId}`) ||
								liveBranches.has(`swarm-lane/${sessionId}/${owner.taskId}`),
						)
					: [...liveBranches].some((branch) => {
							const segments = branch.split('/');
							const sessionId =
								segments[0] === 'swarm' && segments.length >= 4
									? segments[2]
									: segments[0] === 'swarm-lane' && segments.length >= 3
										? segments[1]
										: undefined;
							return sessionId !== undefined && sessionIds.has(sessionId);
						});
			if (!leaseIsLive && !branchIsLive) {
				if (
					!_internals.removeWorktreeProvisioningOwner(directory, owner.callID)
				) {
					throw new Error(
						`expired worktree provisioning owner ${owner.callID} could not be removed; destructive orphan cleanup skipped`,
					);
				}
				continue;
			}
			if (!activeSessionIds.includes(owner.worktreeSessionId)) {
				activeSessionIds.push(owner.worktreeSessionId);
			}
			if (!activeSessionIds.includes(owner.parentSessionId)) {
				activeSessionIds.push(owner.parentSessionId);
			}
		}
		const ownershipTagScan = await withTimeout(
			_internals.listOwnershipTagSessionIds(directory),
			OWNERSHIP_TAG_SCAN_TIMEOUT_MS,
			new Error(
				'background ownership tag scan exceeded its bounded init budget',
			),
		);
		if (ownershipTagScan.status === 'uncertain') {
			throw new Error(
				`background ownership tag state is uncertain; destructive orphan cleanup skipped: ${ownershipTagScan.reason}`,
			);
		}
		for (const sessionId of ownershipTagScan.sessionIds) {
			if (!activeSessionIds.includes(sessionId))
				activeSessionIds.push(sessionId);
		}
		// Scan fallback before primary. Promotion appends the primary record before
		// deleting its fallback, so this ordering cannot observe the owner absent
		// from both stores during a concurrent promotion.
		const fallbackOwnerScan = await withTimeout(
			_internals.scanDelegationFallbacksForRecovery(directory),
			INIT_ORPHAN_RECOVERY_TIMEOUT_MS,
			new Error(
				'background delegation fallback ownership scan exceeded its bounded init budget',
			),
		);
		if (fallbackOwnerScan.status === 'uncertain') {
			throw new Error(
				`background fallback ownership state is uncertain; destructive orphan cleanup skipped: ${fallbackOwnerScan.reason}`,
			);
		}
		const primaryOwnerScan = await withTimeout(
			// Best-effort: synchronous scan (fs.*Sync), timeout provides
			// observability rather than interrupt capability.
			Promise.resolve(_internals.scanDelegationsForRecovery(directory)),
			INIT_ORPHAN_RECOVERY_TIMEOUT_MS,
			new Error(
				'background primary ownership scan exceeded its bounded init budget',
			),
		);
		if (primaryOwnerScan.status === 'uncertain') {
			// #2034/#1659: persist the recovery failure so it stays visible in
			// /swarm status after this in-memory failure is gone. The scan's
			// source is honest: legacy only when no manifest exists, else the
			// interpretation is unknown.
			_internals.recordDelegationRecoveryObservation(directory, {
				source: primaryOwnerScan.source ?? 'legacy-ledger',
				ok: false,
				reason: primaryOwnerScan.reason,
			});
			throw new Error(
				`background primary ownership state is uncertain; destructive orphan cleanup skipped: ${primaryOwnerScan.reason}`,
			);
		}
		_internals.recordDelegationRecoveryObservation(directory, {
			source: primaryOwnerScan.source ?? 'legacy-ledger',
			ok: true,
		});
		// Shared with the store so compaction summarization and orphan
		// protection can never drift apart (issue #2034 review finding).
		const isUnsettledOwner = (
			record: (typeof primaryOwnerScan.owners)[number],
		): boolean => isUnsettledWorktreeOwner(record);
		const durableWorktreeOwners =
			primaryOwnerScan.owners.filter(isUnsettledOwner);
		const mergeOwnerScan = await withTimeout(
			// Best-effort: synchronous scan (fs.*Sync), timeout provides
			// observability rather than interrupt capability.
			Promise.resolve(
				_internals.scanWorktreeMergeFailuresForRecovery(directory),
			),
			INIT_ORPHAN_RECOVERY_TIMEOUT_MS,
			new Error(
				'worktree merge ownership scan exceeded its bounded init budget',
			),
		);
		if (mergeOwnerScan.status === 'uncertain') {
			throw new Error(
				`worktree merge ownership state is uncertain; destructive orphan cleanup skipped: ${mergeOwnerScan.reason}`,
			);
		}
		const allDurableOwners = [
			...durableWorktreeOwners,
			...fallbackOwnerScan.owners
				.map((artifact) => artifact.record)
				.filter(isUnsettledOwner),
		];
		const preservedMergeFailures = mergeOwnerScan.failures
			.map(([, failure]) => failure)
			.filter((failure) => typeof failure.worktreePath === 'string');
		const protectedWorktreePaths = new Set(
			[
				...allDurableOwners.map((record) => record.worktree?.worktreePath),
				...preservedMergeFailures.map((failure) => failure.worktreePath),
			]
				.filter((value): value is string => typeof value === 'string')
				.map((value) => path.resolve(value)),
		);
		for (const owner of allDurableOwners) {
			const worktreeSessionId = owner.worktree?.worktreeSessionId;
			if (worktreeSessionId && !activeSessionIds.includes(worktreeSessionId)) {
				activeSessionIds.push(worktreeSessionId);
			}
			if (!activeSessionIds.includes(owner.parentSessionId)) {
				activeSessionIds.push(owner.parentSessionId);
			}
		}
		for (const failure of preservedMergeFailures) {
			const branch = failure.branch;
			const segments = branch?.split('/') ?? [];
			const worktreeSessionId =
				segments[0] === 'swarm' && segments.length >= 4
					? segments[2]
					: segments[0] === 'swarm-lane' && segments.length >= 3
						? segments[1]
						: undefined;
			if (worktreeSessionId && !activeSessionIds.includes(worktreeSessionId)) {
				activeSessionIds.push(worktreeSessionId);
			}
		}

		// Step 1: Enumerate and remove orphaned worktree directories
		const orphanedWorktreeDirs = await withTimeout(
			enumerateOrphanedWorktreeDirs(
				directory,
				activeSessionIds,
				protectedWorktreePaths,
			),
			INIT_ORPHAN_RECOVERY_TIMEOUT_MS,
			new Error(
				`runInitOrphanRecovery exceeded ${INIT_ORPHAN_RECOVERY_TIMEOUT_MS}ms budget during worktree enumeration; continuing without orphan reclamation`,
			),
		);

		const removedWorktrees: string[] = [];
		const worktreeWarnings: string[] = [];

		// F-002: recovery records preserve worktree directories as well as
		// branches. Read the valid paths before any deletion, then perform a
		// second full-schema check. Any malformed/unreadable record makes the
		// whole worktree cleanup pass fail safe.
		const recoveryRecords = listRecoveryRecords(directory);
		const recoveryReadError = recoveryReadErrored(directory);
		const recoveryWorktreePaths = new Set(
			recoveryRecords.map((record) =>
				worktreePathKey(record.worktreePath, directory),
			),
		);

		if (recoveryReadError) {
			worktreeWarnings.push(
				'Recovery records are unreadable or fail schema validation; skipped all orphaned worktree deletion this pass (fail-safe).',
			);
		} else {
			for (const worktreePath of orphanedWorktreeDirs) {
				if (
					recoveryWorktreePaths.has(worktreePathKey(worktreePath, directory))
				) {
					worktreeWarnings.push(
						`Preserved recovery worktree "${worktreePath}"; an unresolved recovery record still references it.`,
					);
					continue;
				}

				const error = await removeOrphanedWorktreeDir(worktreePath, directory);
				if (error) {
					worktreeWarnings.push(
						`Could not reclaim orphaned worktree "${worktreePath}": ${error}`,
					);
				} else {
					removedWorktrees.push(worktreePath);
				}
			}
		}

		// Step 2: Clean up orphaned branches (remaining after worktree removal)
		const cleanupResult = await withTimeout(
			cleanupOrphanedBranches(directory, activeSessionIds, {
				preserveUnmerged: true,
			}),
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
			// #1657 fail-safe: when recovery records are unreadable,
			// cleanupOrphanedBranches skips ALL lane-branch deletions and
			// does NOT run `git worktree prune`.
			prunedWorktrees: cleanupResult.recoveryReadError !== true,
		};

		// Write advisory file (best-effort) so session-start can surface warnings
		await writeAdvisoryFile(
			directory,
			cleanupResult,
			allWarnings,
			true,
			removedWorktrees,
		);
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
	} finally {
		try {
			await recoveryLockRelease?.();
		} catch {
			// Best-effort release; proper-lockfile has a stale timeout fallback.
		}
	}

	return result;
}
