/** Post-resolution SQLite snapshot import/readiness lifecycle (#2481). */

import { createHash, randomUUID } from 'node:crypto';
import { existsSync, renameSync } from 'node:fs';
import { canonicalProjectKey } from '../db/canonical-project.js';
import { validateSwarmPath } from '../hooks/utils.js';
import { advisoryWarn } from '../services/warning-buffer.js';
import { applyRehydrationCache, swarmState } from '../state.js';
import { withTimeout } from '../utils/timeout.js';
import { readSnapshotFileStrict, rehydrateState } from './snapshot-reader.js';
import { importSnapshotRowsOnce, readSnapshotRows } from './snapshot-store.js';
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

const entries = new Map<string, ReadinessEntry>();
let nextAttemptId = 1;

function isRetryableArchiveError(error: unknown): boolean {
	const code = (error as NodeJS.ErrnoException | undefined)?.code;
	return code === 'EBUSY' || code === 'EPERM' || code === 'EACCES';
}

async function archiveLegacySnapshotIfPresent(
	legacyPath: string,
): Promise<void> {
	if (!existsSync(legacyPath)) return;
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
				await archiveLegacySnapshotIfPresent(legacyPath);
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

export async function closeSnapshotCoordinationInitialization(
	directory: string,
): Promise<void> {
	const root = canonicalProjectKey(directory);
	const entry = entries.get(root);
	if (!entry) return;
	entry.state = 'closing';
	let failure: unknown;
	try {
		await entry.underlying;
	} catch (error) {
		failure = error;
	} finally {
		entries.delete(root);
	}
	if (failure) throw failure;
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
