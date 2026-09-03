/** Post-resolution SQLite snapshot import/readiness lifecycle (#2481). */

import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, renameSync } from 'node:fs';
import { canonicalProjectKey } from '../db/canonical-project.js';
import { validateSwarmPath } from '../hooks/utils.js';
import { advisoryWarn } from '../services/warning-buffer.js';
import { applyRehydrationCache, swarmState } from '../state.js';
import { withTimeout } from '../utils/timeout.js';
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
	| 'failed'
	| 'timed_out'
	| 'closing';
interface ReadinessEntry {
	attemptId: number;
	generation: number;
	state: ReadinessState;
	settled: boolean;
	underlying: Promise<void>;
	error?: string;
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
}

const entries = new Map<string, ReadinessEntry>();
let nextAttemptId = 1;

function isRetryableArchiveError(error: unknown): boolean {
	const code = (error as NodeJS.ErrnoException | undefined)?.code;
	return code === 'EBUSY' || code === 'EPERM' || code === 'EACCES';
}

async function archiveLegacySnapshotIfPresent(
	legacyPath: string,
	expectedSnapshot?: SnapshotData,
): Promise<void> {
	if (!existsSync(legacyPath)) return;
	if (expectedSnapshot) {
		try {
			const current = JSON.stringify(
				JSON.parse(readFileSync(legacyPath, 'utf8')),
			);
			if (current !== JSON.stringify(expectedSnapshot)) {
				advisoryWarn(
					'[opencode-swarm] Legacy snapshot changed after SQLite coordination; preserving it for explicit recovery.',
				);
				return;
			}
		} catch {
			// Do not archive an unreadable source when a peer may have replaced it.
			return;
		}
	}
	const canonicalArchive = `${legacyPath}.imported`;
	const archivePath = existsSync(canonicalArchive)
		? `${canonicalArchive}.${randomUUID()}`
		: canonicalArchive;
	let lastError: unknown;
	for (let attempt = 1; attempt <= ARCHIVE_RETRY_ATTEMPTS; attempt += 1) {
		try {
			_snapshotCoordinationInternals.renameLegacySnapshot(
				legacyPath,
				archivePath,
			);
			return;
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
}

function evictSettledEntries(): void {
	while (entries.size >= MAX_READY_ROOTS) {
		const victim = [...entries].find(([, entry]) => entry.settled);
		if (!victim) return;
		entries.delete(victim[0]);
	}
}

async function initializeSnapshotCoordination(
	directory: string,
): Promise<void> {
	let legacyArchiveAttempted = false;
	let snapshot = readSnapshotRows(directory);
	if (!snapshot) {
		const legacyPath = validateSwarmPath(directory, 'session/state.json');
		const projectionPath = validateSwarmPath(
			directory,
			SNAPSHOT_PROJECTION_FILE,
		);
		const source = existsSync(legacyPath)
			? 'session/state.json'
			: existsSync(projectionPath)
				? SNAPSHOT_PROJECTION_FILE
				: null;
		if (source) {
			// Unlike the compatibility reader, import never treats corruption or an
			// unsupported version as absence. Authority stays fail-closed.
			const candidate = await readSnapshotFileStrict(directory, source);
			const serialized = JSON.stringify(candidate);
			const outcome = importSnapshotRowsOnce(
				directory,
				candidate,
				createHash('sha256').update(serialized).digest('hex'),
				source,
			);
			snapshot = readSnapshotRows(directory);
			if (outcome === 'imported' && source === 'session/state.json') {
				legacyArchiveAttempted = true;
				await archiveLegacySnapshotIfPresent(legacyPath, candidate);
			}
		}
	}
	if (!snapshot) return;
	// A prior attempt may have committed SQLite and crashed before archival.
	// Repair that post-commit side effect on every authoritative restart without
	// ever overwriting an earlier cold archive.
	if (!legacyArchiveAttempted) {
		await archiveLegacySnapshotIfPresent(
			validateSwarmPath(directory, 'session/state.json'),
			snapshot,
		);
	}
	await rehydrateState(snapshot, directory);
	for (const session of swarmState.agentSessions.values())
		applyRehydrationCache(session);
	await writeSnapshotProjection(directory, snapshot);
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
	evictSettledEntries();
	const attemptId = nextAttemptId++;
	const generation = (existing?.generation ?? 0) + 1;
	const entry: ReadinessEntry = {
		attemptId,
		generation,
		state: 'running' as ReadinessState,
		settled: false,
		underlying: Promise.resolve(),
	};
	const underlying = _snapshotCoordinationInternals
		.initialize(root)
		.then(() => {
			if (entries.get(root) === entry && entry.state !== 'closing')
				entry.state = 'succeeded';
		})
		.catch((error: unknown) => {
			entry.state = 'failed';
			entry.error = error instanceof Error ? error.message : String(error);
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
	if (!entry) return startSnapshotCoordinationInitialization(root);
	if (entry.state === 'closing') {
		throw new Error('coordination initialization is closing for reset-session');
	}
	if (entry.state === 'timed_out' && !entry.settled) {
		throw new Error(
			'coordination initialization remains unsettled after timeout',
		);
	}
	await entry.underlying;
	if (entry.state !== 'succeeded')
		throw new Error(entry.error ?? 'coordination initialization failed');
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
	if (prior) {
		prior.state = 'closing';
		try {
			await prior.underlying;
		} catch (error) {
			closeError = error instanceof Error ? error : new Error(String(error));
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
	return {
		release: () => {
			if (entries.get(root) === guard) entries.delete(root);
		},
		...(closeError ? { closeError } : {}),
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
	initialize: (directory: string) => Promise<void>;
	renameLegacySnapshot: (from: string, to: string) => void;
	timeoutMs: number;
} = {
	entries,
	initialize: initializeSnapshotCoordination,
	renameLegacySnapshot: renameSync,
	timeoutMs: READY_TIMEOUT_MS,
};
