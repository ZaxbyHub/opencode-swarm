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
import { loadPluginConfig } from '../config/loader';
import { closeProjectDb } from '../db/project-db';
import {
	isLocked,
	listActiveLocks,
	tryAcquireLock,
} from '../parallel/file-locks';
import { listLiveLaneOwners } from '../parallel/lane-owners';
import { swarmState } from '../state';
import {
	listRecoveryRecords,
	recoveryReadErrored,
} from '../turbo/lean/recovery';
import { canonicalRootKeyFresh } from '../utils/canonical-root.js';
import { log } from '../utils/index.js';
import { withTimeout } from '../utils/timeout.js';
import { migrateLegacyWorktreeBase } from '../worktree/base-migration';
import { removeWorktree, resolveWorktreeBaseDir } from '../worktree/core';
import {
	cleanupOrphanedBranches,
	scanRegisteredWorktreeLiveness,
} from '../worktree/merge';
import { removeOwnedWorktreeDir } from '../worktree/ownership';
import { reclaimDeadLanes } from './delegation-gate/dead-lane-reclaim';
import { scanWorktreeMergeFailuresForRecovery } from './delegation-gate/worktree-merge-status';
import { scanBackgroundWorktreeOwnershipTagsForRecovery } from './delegation-gate/worktree-ownership-tag';
import {
	removeWorktreeProvisioningOwner,
	scanWorktreeProvisioningLifecycleJournalForRecovery,
	scanWorktreeProvisioningOwnersForRecovery,
	WORKTREE_LIFECYCLE_LOCK_FILE,
	WORKTREE_PROVISIONING_OWNER_LEASE_MS,
} from './delegation-gate/worktree-provisioning-owner';
import {
	replayWorktreeRecoveryClaimJournal,
	scanWorktreeRecoveryAuthoritiesForRecovery,
} from './delegation-gate/worktree-recovery-authority';

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
	scanWorktreeRecoveryAuthoritiesForRecovery: typeof scanWorktreeRecoveryAuthoritiesForRecovery;
	replayWorktreeRecoveryClaimJournal: typeof replayWorktreeRecoveryClaimJournal;
	scanWorktreeProvisioningOwnersForRecovery: typeof scanWorktreeProvisioningOwnersForRecovery;
	scanWorktreeProvisioningLifecycleJournalForRecovery: typeof scanWorktreeProvisioningLifecycleJournalForRecovery;
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
	scanWorktreeRecoveryAuthoritiesForRecovery,
	replayWorktreeRecoveryClaimJournal,
	scanWorktreeProvisioningOwnersForRecovery,
	scanWorktreeProvisioningLifecycleJournalForRecovery,
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
 * Issue #2527: resolves the worktree bases this project enumerates for
 * reclamation — the project-internal default base plus every configured
 * `worktree_dir` override. The LEGACY parent-level shared base is never
 * enumerated for deletion (it is only read by the migration pass).
 */
export function resolveWorktreeEnumerationBases(directory: string): string[] {
	const bases = [resolveWorktreeBaseDir(directory)];
	try {
		// Bounded, fail-open: a single cached config read; no config or an
		// unreadable one degrades to the default base only.
		const config = loadPluginConfig(directory) as {
			worktree?: { worktree_dir?: string };
			turbo?: { lean?: { worktree_dir?: string } };
		};
		const overrides = [
			config?.worktree?.worktree_dir,
			config?.turbo?.lean?.worktree_dir,
		].filter((value): value is string => typeof value === 'string');
		for (const override of overrides) {
			const base = resolveWorktreeBaseDir(directory, override);
			if (!bases.some((existing) => existing === base)) bases.push(base);
		}
	} catch {
		// Fail-open: default base only.
	}
	return bases;
}

/**
 * Enumerates orphaned worktree directories under this project's worktree
 * bases (default project-internal base + `worktree_dir` overrides —
 * `resolveWorktreeEnumerationBases`), laid out `<base>/<sessionId>/<laneId>`
 * per `provisionWorktree` in `core.ts`.
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

	for (const worktreeRoot of resolveWorktreeEnumerationBases(directory)) {
		let entries: fs.Dirent[];
		try {
			entries = await fsPromises.readdir(worktreeRoot, { withFileTypes: true });
		} catch {
			// This base doesn't exist — nothing to reclaim from it
			continue;
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
				if (protectedWorktreePaths.has(canonicalRootKeyFresh(worktreePath)))
					continue;
				orphanedDirs.push(worktreePath);
			}
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
	return canonicalRootKeyFresh(absolutePath);
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
	const recoveryReplayWarnings: string[] = [];

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
		// Issue #2105: repair interrupted claim publication before consulting the
		// authoritative v2 store. Replay is idempotent and runs under the same
		// lifecycle exclusion as destructive cleanup, so a PREPARED claimant can
		// never race orphan reclamation.
		const replayedClaims =
			_internals.replayWorktreeRecoveryClaimJournal(directory);
		const uncertainReplay = replayedClaims.find(
			(entry) => entry.outcome === 'uncertain_committed_without_authority',
		);
		if (uncertainReplay) {
			_internals.recordDelegationRecoveryObservation(directory, {
				source: 'unknown',
				ok: false,
				reason: `worktree recovery replay is uncertain for authority ${uncertainReplay.authorityDigest}: committed claim is missing its authoritative record`,
			});
			throw new Error(
				`worktree recovery replay is uncertain for authority ${uncertainReplay.authorityDigest}; destructive orphan cleanup skipped`,
			);
		}
		const replayRepairs = replayedClaims.filter(
			(entry) =>
				entry.outcome === 'aborted_prepared_claim' ||
				entry.outcome === 'removed_uncommitted_credential' ||
				entry.outcome === 'released_orphaned_committed_claim',
		);
		if (replayRepairs.length > 0) {
			recoveryReplayWarnings.push(
				`Recovered ${replayRepairs.length} interrupted worktree recovery claim${
					replayRepairs.length === 1 ? '' : 's'
				} during startup replay before orphan cleanup.`,
			);
		}
		const recoveryAuthorityScan =
			_internals.scanWorktreeRecoveryAuthoritiesForRecovery(directory);
		if (recoveryAuthorityScan.status !== 'ok') {
			_internals.recordDelegationRecoveryObservation(directory, {
				source: 'unknown',
				ok: false,
				reason: `worktree recovery authority state is uncertain: ${recoveryAuthorityScan.reason}`,
			});
			throw new Error(
				`worktree recovery authority state is uncertain; destructive orphan cleanup skipped: ${recoveryAuthorityScan.reason}`,
			);
		}
		const liveRecoveryAuthorities = recoveryAuthorityScan.authorities.filter(
			(authority) => authority.status !== 'finalized',
		);
		for (const authority of liveRecoveryAuthorities) {
			for (const sessionId of [
				authority.immutable.parentSessionId,
				authority.claim?.claimantSessionId,
				authority.claim?.childSessionId,
			]) {
				if (sessionId && !activeSessionIds.includes(sessionId)) {
					activeSessionIds.push(sessionId);
				}
			}
			if (
				authority.status === 'claimed' &&
				authority.claim &&
				!swarmState.agentSessions.has(authority.claim.childSessionId)
			) {
				recoveryReplayWarnings.push(
					`Preserved claimed recovery lane "${authority.immutable.laneBranch}" for task ${authority.immutable.taskId}; restart reconciliation may still need to resume prompt delivery for child session ${authority.claim.childSessionId}.`,
				);
			}
		}
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
		const provisioningLifecycleScan =
			_internals.scanWorktreeProvisioningLifecycleJournalForRecovery(directory);
		if (provisioningLifecycleScan.status === 'uncertain') {
			throw new Error(
				`worktree provisioning lifecycle state is uncertain; destructive orphan cleanup skipped: ${provisioningLifecycleScan.reason}`,
			);
		}
		const latestLifecycleByCall = new Map(
			provisioningLifecycleScan.entries.map((entry) => [entry.callID, entry]),
		);
		for (const owner of provisioningOwnerScan.owners) {
			if (owner.schemaVersion !== 3) continue;
			const lifecycle = latestLifecycleByCall.get(owner.callID);
			if (
				!lifecycle ||
				lifecycle.state !== 'OWNER_PUBLISHED' ||
				lifecycle.parentSessionId !== owner.parentSessionId ||
				lifecycle.worktreeSessionId !== owner.worktreeSessionId ||
				lifecycle.taskId !== owner.taskId ||
				lifecycle.reservationId !== owner.reservationId ||
				lifecycle.generation !== owner.generation ||
				lifecycle.branchName !== owner.branchName
			) {
				throw new Error(
					`worktree provisioning owner ${owner.callID} is not corroborated by its exact lifecycle journal entry; destructive orphan cleanup skipped`,
				);
			}
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
					!_internals.removeWorktreeProvisioningOwner(
						directory,
						owner.callID,
						owner.schemaVersion === 3
							? {
									reservationId: owner.reservationId,
									generation: owner.generation,
									branchName: owner.branchName,
								}
							: undefined,
					)
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
				...(primaryOwnerScan.repairHint
					? { repairHint: primaryOwnerScan.repairHint }
					: {}),
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
				...liveRecoveryAuthorities.map(
					(authority) => authority.immutable.lanePath,
				),
			]
				.filter((value): value is string => typeof value === 'string')
				.map((value) => worktreePathKey(value, directory)),
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

		// Issue #2527 step A (after every fail-closed uncertainty guard, before
		// migration and enumeration): durable live-lane owners. Liveness here
		// is the lane's own (PID alive within the 24h claim window), not the
		// five-minute lock TTL — a long-running lane must never look orphaned
		// to a second process. The read GCs records whose lane path is gone.
		const liveLaneOwners = listLiveLaneOwners(directory);
		for (const owner of liveLaneOwners.live) {
			protectedWorktreePaths.add(worktreePathKey(owner.lanePath, directory));
			if (!activeSessionIds.includes(owner.sessionId)) {
				activeSessionIds.push(owner.sessionId);
			}
		}

		// Issue #2527 step B: migrate the legacy parent-level shared base into
		// the project-internal base. Runs only now — after the uncertainty
		// guards (mutation under uncertain state is unacceptable) and with the
		// liveness answer in hand. Fail-open and non-throwing; NEVER deletes
		// anything (foreign/live/gitless legacy entries are left for their
		// owners; the legacy base itself is rmdir'd only when empty).
		const migration = await withTimeout(
			migrateLegacyWorktreeBase(directory, liveLaneOwners.live),
			INIT_ORPHAN_RECOVERY_TIMEOUT_MS,
			new Error(
				'legacy worktree-base migration exceeded its bounded budget; retried next start',
			),
		).catch((error: unknown) => ({
			attempted: true,
			legacyBaseExists: true,
			moved: [] as string[],
			retained: [
				{
					lanePath: '<pass>',
					reason: `migration pass exceeded its budget: ${error instanceof Error ? error.message : String(error)}`,
				},
			],
			legacyBaseRemoved: false,
		}));
		if (migration.moved.length > 0) {
			recoveryReplayWarnings.push(
				`Migrated ${migration.moved.length} worktree(s) from the legacy shared base into the project base (issue #2527).`,
			);
			// Review-round hardening: a just-moved lane is protected for THIS
			// pass at its NEW path, so the enumeration below can never see it
			// as an unprotected orphan before its durable owner record is
			// (re-)established.
			for (const movedPath of migration.moved) {
				protectedWorktreePaths.add(worktreePathKey(movedPath, directory));
			}
		}
		if (migration.retained.length > 0) {
			recoveryReplayWarnings.push(
				`${migration.retained.length} legacy-base worktree entr${migration.retained.length === 1 ? 'y remains' : 'ies remain'} left for their owning checkouts (never deleted by this project).`,
			);
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

				// Issue #2527: every deletion goes through the ownership-gated
				// helper — foreign/uncertain candidates are skipped and
				// reported, git refusals are a stop (never an rmSync
				// escalation), and .git-less remnants are only removable
				// inside this project's own base.
				// Issue #2599 AC5 (integrated): release the lane's swarm.db
				// handle BEFORE deletion (Windows WAL lock would EBUSY the rm).
				closeProjectDb(worktreePath);
				const outcome = await removeOwnedWorktreeDir(worktreePath, directory);
				if (outcome.status === 'removed') {
					removedWorktrees.push(worktreePath);
				} else if (outcome.status === 'skipped') {
					worktreeWarnings.push(
						`Preserved worktree candidate "${worktreePath}": ${outcome.reason}.`,
					);
				} else {
					worktreeWarnings.push(
						`Could not reclaim orphaned worktree "${worktreePath}" (git refused; left in place): ${outcome.reason}`,
					);
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

		// Step 3 (issue #2599): reclaim lanes whose removal previously failed
		// on a held handle (EBUSY). Bounded and fail-open like every other
		// step: per-lane failures retain their reclaim record for the next
		// start instead of blocking init.
		const reclaimResult = await withTimeout(
			reclaimDeadLanes(directory, {
				activeSessionIds,
				protectedWorktreePaths,
			}),
			INIT_ORPHAN_RECOVERY_TIMEOUT_MS,
			new Error(
				`runInitOrphanRecovery exceeded ${INIT_ORPHAN_RECOVERY_TIMEOUT_MS}ms budget during dead-lane reclaim; continuing without reclaim`,
			),
		).catch((error: unknown) => ({
			reclaimed: [] as string[],
			retained: [] as Array<{ lanePath: string; reason: string }>,
			error: error instanceof Error ? error.message : String(error),
		}));
		if (reclaimResult.reclaimed.length > 0) {
			removedWorktrees.push(...reclaimResult.reclaimed);
		}
		for (const retained of reclaimResult.retained) {
			worktreeWarnings.push(
				`Preserved dead lane "${retained.lanePath}" (${retained.reason}); reclaim scheduled at next start.`,
			);
		}

		const allWarnings = [...worktreeWarnings, ...branchWarnings];
		const mergedWarnings = [...recoveryReplayWarnings, ...allWarnings];

		result = {
			attempted: true,
			crossProcessLockHeld: false,
			warnings: mergedWarnings,
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
			mergedWarnings,
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
