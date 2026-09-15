/** Post-resolution SQLite snapshot import/readiness lifecycle (#2481). */

import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, renameSync } from 'node:fs';
import { canonicalProjectKey } from '../db/canonical-project.js';
import { validateSwarmPath } from '../hooks/utils.js';
import { loadPlan, PlanRecoverySupersededError } from '../plan/manager.js';
import { advisoryWarn } from '../services/warning-buffer.js';
import {
	applyRehydrationCache,
	buildRehydrationCache,
	swarmState,
} from '../state.js';
import { withTimeout } from '../utils/timeout.js';
import {
	beginHydrationScope,
	type HydrationScope,
	isHydrationScopeCurrent,
} from './hydration-ownership.js';
import { readSnapshotFileStrict, rehydrateState } from './snapshot-reader.js';
import { importSnapshotRowsOnce, readSnapshotRows } from './snapshot-store.js';
import type { SnapshotData } from './snapshot-writer.js';
import {
	SNAPSHOT_PROJECTION_FILE,
	writeSnapshotProjection,
} from './snapshot-writer.js';

const READY_TIMEOUT_MS = 10_000;
const MAX_READY_ROOTS = 32;
const ARCHIVE_RETRY_ATTEMPTS = 3;
const ARCHIVE_RETRY_DELAY_MS = 25;

type ReadinessState =
	| 'running'
	| 'succeeded'
	| 'superseded'
	| 'failed'
	| 'timed_out'
	| 'closing';
export type SnapshotCoordinationInitializationOutcome =
	| 'succeeded'
	| 'superseded';
interface ReadinessEntry {
	attemptId: number;
	generation: number;
	state: ReadinessState;
	settled: boolean;
	underlying: Promise<void>;
	error?: string;
}

function isReadinessEntryClosing(entry: ReadinessEntry | undefined): boolean {
	return entry?.state === 'closing';
}

export interface SnapshotCoordinationStatus {
	state: ReadinessState | 'idle';
	attemptId?: number;
	generation?: number;
	settled: boolean;
	error?: string;
}

/**
 * Held while reset-session removes the authoritative snapshot and its legacy
 * projection. Callers must release it after the destructive portion is done.
 */
export interface SnapshotCoordinationResetGuard {
	release(): void;
	closeError?: Error;
	/** True when the prior initializer did not settle before the reset deadline. */
	priorUnsettled?: boolean;
}

const entries = new Map<string, ReadinessEntry>();
let nextAttemptId = 1;

function isRetryableArchiveError(error: unknown): boolean {
	const code = (error as NodeJS.ErrnoException | undefined)?.code;
	return code === 'EBUSY' || code === 'EPERM' || code === 'EACCES';
}

type LegacyArchiveOutcome = 'archived' | 'not_archived' | 'superseded';

async function archiveLegacySnapshotIfPresent(
	legacyPath: string,
	expectedSnapshot?: SnapshotData,
	shouldCommit: () => boolean = () => true,
): Promise<LegacyArchiveOutcome> {
	if (!shouldCommit()) return 'superseded';
	if (!existsSync(legacyPath)) return 'not_archived';
	if (expectedSnapshot) {
		try {
			const current = JSON.stringify(
				JSON.parse(readFileSync(legacyPath, 'utf8')),
			);
			if (current !== JSON.stringify(expectedSnapshot)) {
				advisoryWarn(
					'[opencode-swarm] Legacy snapshot changed after SQLite coordination; preserving it for explicit recovery.',
				);
				return 'not_archived';
			}
		} catch {
			// Do not archive an unreadable source when a peer may have replaced it.
			return 'not_archived';
		}
	}
	const canonicalArchive = `${legacyPath}.imported`;
	const archivePath = existsSync(canonicalArchive)
		? `${canonicalArchive}.${randomUUID()}`
		: canonicalArchive;
	let lastError: unknown;
	for (let attempt = 1; attempt <= ARCHIVE_RETRY_ATTEMPTS; attempt += 1) {
		// The rename is the archive's publication boundary.  Check immediately
		// before it so a superseded initializer cannot move a newer legacy file.
		if (!shouldCommit()) return 'superseded';
		try {
			_snapshotCoordinationInternals.renameLegacySnapshot(
				legacyPath,
				archivePath,
			);
			return 'archived';
		} catch (error) {
			lastError = error;
			if (!isRetryableArchiveError(error) || attempt === ARCHIVE_RETRY_ATTEMPTS)
				break;
			await new Promise((resolve) =>
				setTimeout(resolve, ARCHIVE_RETRY_DELAY_MS),
			);
		}
	}
	advisoryWarn(
		`[opencode-swarm] SQLite snapshot is authoritative, but the legacy shadow could not be archived: ${
			lastError instanceof Error ? lastError.message : String(lastError)
		}`,
	);
	return 'not_archived';
}

function evictSettledEntries(): boolean {
	while (entries.size >= MAX_READY_ROOTS) {
		const victim = [...entries].find(([, entry]) => entry.settled);
		if (!victim) return false;
		entries.delete(victim[0]);
	}
	return true;
}

async function initializeSnapshotCoordination(
	directory: string,
	scope?: HydrationScope,
): Promise<SnapshotCoordinationInitializationOutcome> {
	const isCurrent = () => scope === undefined || isHydrationScopeCurrent(scope);
	// Source selection and the first authority read are also publication
	// boundaries: a stale initializer must not even start a compatibility import.
	if (!isCurrent()) return 'superseded';
	let legacyArchiveAttempted = false;
	let snapshot = readSnapshotRows(directory);
	if (!snapshot) {
		if (!isCurrent()) return 'superseded';
		const legacyPath = validateSwarmPath(directory, 'session/state.json');
		const projectionPath = validateSwarmPath(
			directory,
			SNAPSHOT_PROJECTION_FILE,
		);
		// Keep bootstrap source selection aligned with readSnapshot(): the
		// SQLite-backed projection is the newest compatibility shadow and must
		// win whenever both candidates exist.  Choosing legacy first here would
		// let the early reader and the post-resolution importer hydrate different
		// snapshots during a mixed-version restart.
		const source = existsSync(projectionPath)
			? SNAPSHOT_PROJECTION_FILE
			: existsSync(legacyPath)
				? 'session/state.json'
				: null;
		if (source) {
			if (!isCurrent()) return 'superseded';
			// Unlike the compatibility reader, import never treats corruption or an
			// unsupported version as absence. Authority stays fail-closed.
			const candidate =
				await _snapshotCoordinationInternals.readSnapshotFileStrict(
					directory,
					source,
				);
			// Strict reading is asynchronous.  Re-check immediately before the
			// synchronous SQLite import so stale compatibility bytes cannot become
			// authoritative after a newer hydration starts.
			if (!isCurrent()) return 'superseded';
			const serialized = JSON.stringify(candidate);
			const outcome = _snapshotCoordinationInternals.importSnapshotRowsOnce(
				directory,
				candidate,
				createHash('sha256').update(serialized).digest('hex'),
				source,
			);
			snapshot = readSnapshotRows(directory);
			if (outcome === 'imported' && source === 'session/state.json') {
				legacyArchiveAttempted = true;
				const archiveOutcome = await archiveLegacySnapshotIfPresent(
					legacyPath,
					candidate,
					isCurrent,
				);
				if (archiveOutcome === 'superseded') return 'superseded';
			}
		}
	}
	if (!isCurrent()) return 'superseded';

	if (snapshot) {
		// A prior attempt may have committed SQLite and crashed before archival.
		// Repair that post-commit side effect on every authoritative restart without
		// ever overwriting an earlier cold archive.
		if (!legacyArchiveAttempted) {
			const archiveOutcome = await archiveLegacySnapshotIfPresent(
				validateSwarmPath(directory, 'session/state.json'),
				snapshot,
				isCurrent,
			);
			if (archiveOutcome === 'superseded') return 'superseded';
		}
		// Issues #2667/#2668: the apply is authority-fenced by the scope captured in
		// startSnapshotCoordinationInitialization — a timed-out initializer that
		// settles late cannot publish over the state of any newer hydration.
		const outcome = await rehydrateState(snapshot, directory, scope);
		if (!outcome.applied || !isCurrent()) return 'superseded';
	}

	// The early init reader intentionally uses only cheap projection data.  Once
	// post-resolution coordination is running, resolve the authoritative plan
	// through the ledger-aware manager before publishing the rehydration cache.
	let authoritativePlan: Awaited<ReturnType<typeof loadPlan>> | undefined;
	try {
		authoritativePlan = await _snapshotCoordinationInternals.loadPlan(
			directory,
			undefined,
			{
				preCommitCheck: () => {
					if (!isCurrent()) {
						throw new PlanRecoverySupersededError(
							'Snapshot coordination initialization superseded during plan recovery',
						);
					}
				},
			},
		);
	} catch (error) {
		// A superseded recovery no longer owns the plan authority. Preserve the
		// typed signal so the coordinator can mark readiness superseded and stop
		// before applying the pre-resolution cache or publishing its projection.
		if (error instanceof PlanRecoverySupersededError) throw error;
		advisoryWarn(
			`[opencode-swarm] Authoritative plan recovery failed; retaining pre-resolution cache: ${
				error instanceof Error ? error.message : String(error)
			}`.slice(0, 512),
		);
	}
	if (!isCurrent()) return 'superseded';
	if (authoritativePlan !== undefined) {
		const cacheResult = await buildRehydrationCache(directory, {
			planOverride: authoritativePlan,
			shouldCommit: isCurrent,
		});
		if (!cacheResult.committed || !isCurrent()) return 'superseded';
	}
	for (const session of swarmState.agentSessions.values()) {
		if (!isCurrent()) return 'superseded';
		applyRehydrationCache(session);
	}
	if (!snapshot || !isCurrent())
		return isCurrent() ? 'succeeded' : 'superseded';
	try {
		await _snapshotCoordinationInternals.writeProjection(
			directory,
			snapshot,
			isCurrent,
		);
	} catch (error) {
		// The projection is a derived compatibility shadow.  SQLite is already
		// authoritative and rehydrated above, so a shadow write failure must not
		// make readiness fail or strand the live in-memory state.
		advisoryWarn(
			`[opencode-swarm] SQLite snapshot is ready, but its compatibility projection could not be written: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
	}
	return isCurrent() ? 'succeeded' : 'superseded';
}

export function startSnapshotCoordinationInitialization(
	directory: string,
): Promise<void> {
	const root = canonicalProjectKey(directory);
	const existing = entries.get(root);
	if (existing?.state === 'closing') {
		return Promise.reject(
			new Error('coordination initialization is closing for reset-session'),
		);
	}
	if (existing && !existing.settled) return existing.underlying;
	if (existing?.state === 'succeeded') return existing.underlying;
	if (!evictSettledEntries()) {
		const error = new Error(
			`SQLite snapshot coordination capacity exhausted (${MAX_READY_ROOTS} unsettled roots)`,
		);
		advisoryWarn(`[opencode-swarm] ${error.message}; initialization refused.`);
		return Promise.reject(error);
	}
	const attemptId = nextAttemptId++;
	const generation = (existing?.generation ?? 0) + 1;
	// Issues #2667/#2668: fence token captured at INITIATION. Each fresh
	// initializer mints a process-unique authority that cannot be reused after
	// bounded-record eviction or reset.
	const scope = beginHydrationScope(root);
	const entry: ReadinessEntry = {
		attemptId,
		generation,
		state: 'running' as ReadinessState,
		settled: false,
		underlying: Promise.resolve(),
	};
	const underlying = _snapshotCoordinationInternals
		.initialize(root, scope)
		.then((outcome) => {
			if (entries.get(root) !== entry || entry.state === 'closing') return;
			if (outcome === 'superseded') {
				entry.state = 'superseded';
				entry.error =
					'coordination initialization superseded by a newer hydration generation';
				return;
			}
			entry.state = 'succeeded';
		})
		.catch((error: unknown) => {
			if (error instanceof PlanRecoverySupersededError) {
				if (entry.state !== 'closing' && entries.get(root) === entry) {
					entry.state = 'superseded';
					entry.error = error.message;
				}
			} else {
				entry.state = 'failed';
				entry.error = error instanceof Error ? error.message : String(error);
			}
			throw error;
		})
		.finally(() => {
			entry.settled = true;
		});
	entry.underlying = underlying;
	entries.set(root, entry);
	void withTimeout(
		underlying,
		_snapshotCoordinationInternals.timeoutMs,
		new Error('coordination initialization timed out'),
	).catch((error: unknown) => {
		if (!entry.settled && entries.get(root) === entry) {
			entry.state = 'timed_out';
			entry.error = error instanceof Error ? error.message : String(error);
			advisoryWarn(
				'[opencode-swarm] SQLite coordination initialization is still running; authority operations remain fail-closed.',
			);
		}
	});
	return underlying;
}

export async function ensureSnapshotCoordinationReady(
	directory: string,
): Promise<void> {
	const root = canonicalProjectKey(directory);
	const entry = entries.get(root);
	if (entry?.state === 'closing') {
		throw new Error('coordination initialization is closing for reset-session');
	}
	if (entry?.state === 'timed_out' && !entry.settled) {
		throw new Error(
			'coordination initialization remains unsettled after timeout',
		);
	}
	if (!entry || (entry.state === 'superseded' && entry.settled)) {
		// Supersession is retryable only on a later readiness request. Starting
		// exactly one attempt here coalesces concurrent callers and avoids an
		// unbounded retry loop when hydration keeps superseding initialization.
		await startSnapshotCoordinationInitialization(root);
		const retried = entries.get(root);
		if (retried?.state === 'closing') {
			throw new Error(
				'coordination initialization is closing for reset-session',
			);
		}
		if (retried?.state !== 'succeeded') {
			throw new Error(retried?.error ?? 'coordination initialization failed');
		}
		return;
	}
	await entry.underlying;
	if (isReadinessEntryClosing(entry)) {
		throw new Error('coordination initialization is closing for reset-session');
	}
	if (entry.state !== 'succeeded') {
		throw new Error(entry.error ?? 'coordination initialization failed');
	}
}

export function retrySnapshotCoordinationInitialization(
	directory: string,
): Promise<void> {
	const root = canonicalProjectKey(directory);
	const entry = entries.get(root);
	if (entry?.state === 'closing') {
		throw new Error('coordination initialization is closing for reset-session');
	}
	if (entry && !entry.settled) {
		throw new Error(
			'coordination initialization is still unsettled; recovery refused',
		);
	}
	entries.delete(root);
	return startSnapshotCoordinationInitialization(root);
}

export function getSnapshotCoordinationStatus(
	directory: string,
): SnapshotCoordinationStatus {
	const entry = entries.get(canonicalProjectKey(directory));
	if (!entry) return { state: 'idle', settled: true };
	return {
		state: entry.state,
		attemptId: entry.attemptId,
		generation: entry.generation,
		settled: entry.settled,
		...(entry.error ? { error: entry.error.slice(0, 512) } : {}),
	};
}

/**
 * Prevent any fresh initializer from observing state while reset-session
 * deletes the SQLite authority and legacy projection. The guard deliberately
 * survives a prior initialization failure: reset remains best-effort, but a
 * concurrent initializer cannot race through the destructive window.
 */
export async function beginSnapshotCoordinationReset(
	directory: string,
): Promise<SnapshotCoordinationResetGuard> {
	const root = canonicalProjectKey(directory);
	const prior = entries.get(root);
	let closeError: Error | undefined;
	let priorUnsettled = false;
	if (prior) {
		prior.state = 'closing';
		try {
			await withTimeout(
				prior.underlying,
				_snapshotCoordinationInternals.timeoutMs,
				new Error('coordination initialization close timed out'),
			);
		} catch (error) {
			closeError = error instanceof Error ? error : new Error(String(error));
			priorUnsettled = !prior.settled;
			if (priorUnsettled) {
				// The bounded reset path below deliberately does not abandon the
				// underlying promise. Observe a late rejection so a timed-out
				// initializer cannot become an unhandled rejection.
				void prior.underlying.catch(() => undefined);
			}
		}
	}

	const guard: ReadinessEntry = {
		attemptId: nextAttemptId++,
		generation: (prior?.generation ?? 0) + 1,
		state: 'closing',
		settled: true,
		underlying: Promise.resolve(),
		...(closeError ? { error: closeError.message } : {}),
	};
	entries.set(root, guard);
	let released = false;
	const release = () => {
		if (released) return;
		released = true;
		const removeGuard = () => {
			if (entries.get(root) === guard) entries.delete(root);
		};
		if (!prior || prior.settled) {
			removeGuard();
			return;
		}
		// A timed-out initializer may still be finishing a SQLite transaction.
		// Keep the closing guard installed until it settles so a fresh
		// initializer cannot race a reset and resurrect the old snapshot.
		void prior.underlying.then(removeGuard, removeGuard);
	};
	return {
		release,
		...(closeError ? { closeError } : {}),
		...(priorUnsettled ? { priorUnsettled: true } : {}),
	};
}

export async function closeSnapshotCoordinationInitialization(
	directory: string,
): Promise<void> {
	const guard = await beginSnapshotCoordinationReset(directory);
	try {
		if (guard.closeError) throw guard.closeError;
	} finally {
		guard.release();
	}
}

export function markSnapshotCoordinationClosing(directory: string): void {
	const entry = entries.get(canonicalProjectKey(directory));
	if (entry) entry.state = 'closing';
}

export const _snapshotCoordinationInternals: {
	entries: Map<string, ReadinessEntry>;
	initialize: (
		directory: string,
		scope?: HydrationScope,
	) => Promise<SnapshotCoordinationInitializationOutcome>;
	loadPlan: typeof loadPlan;
	readSnapshotFileStrict: typeof readSnapshotFileStrict;
	importSnapshotRowsOnce: typeof importSnapshotRowsOnce;
	renameLegacySnapshot: (from: string, to: string) => void;
	writeProjection: typeof writeSnapshotProjection;
	timeoutMs: number;
} = {
	entries,
	initialize: initializeSnapshotCoordination,
	loadPlan,
	readSnapshotFileStrict,
	importSnapshotRowsOnce,
	renameLegacySnapshot: renameSync,
	writeProjection: writeSnapshotProjection,
	timeoutMs: READY_TIMEOUT_MS,
};
