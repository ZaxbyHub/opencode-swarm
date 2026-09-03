/**
 * Durable Lean Turbo run state.
 *
 * The authoritative store is the per-project SQLite coordination DB, with one
 * row per session. `.swarm/turbo-state.json` remains a compatibility
 * projection and import source during the cutover.
 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	deleteCoordinationState,
	getCoordinationState,
	importCoordinationOnce,
	listCoordinationStates,
	transitionCoordinationState,
	withCoordinationTransaction,
} from '../../db/coordination-store.js';
import { canonicalRootKeyFresh } from '../../utils/canonical-root.js';
import * as logger from '../../utils/logger';

export type LeanTurboStatus = 'idle' | 'running' | 'paused' | 'terminated';

export interface LeanTurboLane {
	laneId: string;
	taskIds: string[];
	files: string[];
	status: 'pending' | 'running' | 'completed' | 'failed' | 'blocked';
	startedAt?: string;
	completedAt?: string;
	error?: string;
	agent?: string;
	sessionId?: string;
	/** Worktree path for isolated lane execution (undefined when worktree_isolation is disabled) */
	worktreePath?: string;
	/** Branch name for the lane's worktree (swarm-lane/<sessionId>/<laneId>) */
	branchName?: string;
	/**
	 * In-memory-only flag: set when dispatch fails with a provisioned worktree.
	 * Signals that _sequentialWorktreeCleanup should run attemptMergeBackFromDirty
	 * + removeWorktree for this lane. Never persisted to disk.
	 */
	_failureCleanupPending?: boolean;
}

export interface LeanTurboDegradedTask {
	taskId: string;
	reason: string;
	files: string[];
	requiredMode: 'standard' | 'balanced';
}

export interface LeanTurboCounters {
	lanesPlanned: number;
	lanesStarted: number;
	lanesCompleted: number;
	lanesFailed: number;
	tasksSerialized: number;
	tasksDegraded: number;
}

export interface LeanTurboRunState {
	status: LeanTurboStatus;
	sessionID: string;
	strategy: 'lean';
	phase?: number;
	maxParallelCoders: number;
	planId?: string;
	activeLanePlanId?: string;
	lanes: LeanTurboLane[];
	degradedTasks: LeanTurboDegradedTask[];
	/** Task IDs excluded from parallel lanes, must complete via standard serial flow */
	serializedTasks: string[];
	lastReviewerVerdict?: 'APPROVED' | 'NEEDS_REVISION' | 'REJECTED';
	lastCriticVerdict?: string;
	pauseReason?: string;
	terminateReason?: string;
	counters: LeanTurboCounters;
}

export interface LeanTurboPersistedState {
	version: 1;
	updatedAt: string;
	sessions: Record<string, LeanTurboRunState>;
}

const STATE_FILE = 'turbo-state.json';
const COORDINATION_NAMESPACE = 'turbo.lean.session';
const MAX_SESSION_WRITE_ATTEMPTS = 5;

function nowISO(): string {
	return new Date().toISOString();
}

function ensureSwarmDir(directory: string): string {
	const swarmDir = path.resolve(directory, '.swarm');
	if (!fs.existsSync(swarmDir)) {
		fs.mkdirSync(swarmDir, { recursive: true });
	}
	return swarmDir;
}

function stateFilePath(directory: string): string {
	return path.join(directory, '.swarm', STATE_FILE);
}

function importedStateFilePath(directory: string): string {
	return `${stateFilePath(directory)}.imported`;
}

function archiveStateFileWithoutOverwrite(directory: string): void {
	const filePath = stateFilePath(directory);
	if (!fs.existsSync(filePath)) return;
	const canonical = importedStateFilePath(directory);
	if (!fs.existsSync(canonical)) {
		fs.renameSync(filePath, canonical);
		return;
	}
	for (let suffix = 1; suffix <= 1_000; suffix += 1) {
		const candidate = `${canonical}.${suffix}`;
		if (fs.existsSync(candidate)) continue;
		fs.renameSync(filePath, candidate);
		return;
	}
	throw new Error('Lean Turbo legacy archive collision limit exceeded');
}

function projectionTmpPath(filePath: string): string {
	return `${filePath}.tmp.${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validatePersistedShape(
	parsed: unknown,
): parsed is LeanTurboPersistedState {
	return isRecord(parsed) && parsed.version === 1 && isRecord(parsed.sessions);
}

function parsePersistedJson(raw: string): LeanTurboPersistedState {
	const parsed = JSON.parse(raw) as unknown;
	if (!validatePersistedShape(parsed)) {
		const maybe = parsed as Partial<LeanTurboPersistedState> | undefined;
		throw new Error(
			`malformed shape (version=${maybe?.version}, sessions type=${Array.isArray(maybe?.sessions) ? 'array' : typeof maybe?.sessions})`,
		);
	}
	return {
		version: 1,
		updatedAt:
			typeof parsed.updatedAt === 'string' && parsed.updatedAt.length > 0
				? parsed.updatedAt
				: nowISO(),
		sessions: parsed.sessions,
	};
}

function parseRunStatePayload(
	payload: string,
	entityKey: string,
): LeanTurboRunState {
	const parsed = JSON.parse(payload) as unknown;
	if (!isRecord(parsed) || parsed.sessionID !== entityKey) {
		throw new Error(
			`session payload malformed for ${entityKey}: sessionID mismatch`,
		);
	}
	return parsed as unknown as LeanTurboRunState;
}

function buildPersistedFromCoordination(
	directory: string,
): LeanTurboPersistedState | null {
	const rows = listCoordinationStates(directory, COORDINATION_NAMESPACE);
	if (rows.length === 0) return null;
	const sessions: Record<string, LeanTurboRunState> = {};
	let updatedAt = '';
	for (const row of rows) {
		sessions[row.entityKey] = parseRunStatePayload(row.payload, row.entityKey);
		if (!updatedAt || row.updatedAt > updatedAt) updatedAt = row.updatedAt;
	}
	return {
		version: 1,
		updatedAt: updatedAt || nowISO(),
		sessions,
	};
}

function readLegacyPersisted(
	directory: string,
): { persisted: LeanTurboPersistedState; sourceDigest: string } | null {
	const filePath = stateFilePath(directory);
	if (!fs.existsSync(filePath)) return null;
	const raw = fs.readFileSync(filePath, 'utf-8');
	return {
		persisted: parsePersistedJson(raw),
		sourceDigest: createHash('sha256').update(raw).digest('hex'),
	};
}

function seedProjectionBestEffort(
	directory: string,
	persisted: LeanTurboPersistedState,
): void {
	try {
		writeProjection(directory, persisted);
	} catch {
		// best-effort seed for backward-compatible readers/tests
	}
}

function preflightProjectionTarget(directory: string): void {
	ensureSwarmDir(directory);
	const filePath = stateFilePath(directory);
	if (fs.existsSync(filePath) && fs.lstatSync(filePath).isDirectory()) {
		throw new Error(
			`Lean Turbo state persistence prepare failed: ${STATE_FILE} is a directory`,
		);
	}
}

function writeProjection(
	directory: string,
	persisted: LeanTurboPersistedState,
): void {
	ensureSwarmDir(directory);
	const filePath = stateFilePath(directory);
	if (fs.existsSync(filePath) && fs.lstatSync(filePath).isDirectory()) {
		throw new Error(`${STATE_FILE} is a directory`);
	}
	const tmpPath = projectionTmpPath(filePath);
	const payload = `${JSON.stringify(persisted, null, 2)}\n`;
	try {
		fs.writeFileSync(tmpPath, payload, 'utf-8');
		fs.renameSync(tmpPath, filePath);
	} catch (error) {
		try {
			if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
		} catch {
			// best-effort cleanup
		}
		throw error;
	}
}

function importLegacyStateIfNeeded(
	directory: string,
): LeanTurboPersistedState | null {
	const legacy = readLegacyPersisted(directory);
	if (!legacy) return null;
	const outcome = importCoordinationOnce(
		directory,
		{
			source: STATE_FILE,
			sourceDigest: legacy.sourceDigest,
			rowCount: Object.keys(legacy.persisted.sessions).length,
			emptyNamespace: COORDINATION_NAMESPACE,
		},
		() => {
			for (const [sessionID, state] of Object.entries(
				legacy.persisted.sessions,
			)) {
				const result = transitionCoordinationState(directory, {
					namespace: COORDINATION_NAMESPACE,
					entityKey: sessionID,
					expectedRevision: null,
					generation: 1,
					status: state.status,
					payload: JSON.stringify(state),
				});
				if (result.outcome !== 'applied') {
					throw new Error('Lean Turbo legacy import conflict');
				}
			}
		},
	);
	if (outcome === 'imported') {
		archiveStateFileWithoutOverwrite(directory);
	}
	const authoritative =
		buildPersistedFromCoordination(directory) ?? emptyPersisted();
	seedProjectionBestEffort(directory, authoritative);
	return authoritative;
}

function unreadableStateError(directory: string): Error {
	return new Error(
		`Lean Turbo state is unreadable for ${directory}. Please repair .swarm/${STATE_FILE} before continuing.`,
	);
}

function ensureReadableState(directory: string): void {
	if (stateUnreadableMap.get(stateKey(directory))) throw unreadableStateError(directory);
	if (!readPersisted(directory)) throw unreadableStateError(directory);
}

function refreshProjectionFromCoordination(directory: string): void {
	const persisted =
		buildPersistedFromCoordination(directory) ?? emptyPersisted();
	persisted.updatedAt = nowISO();
	writeProjection(directory, persisted);
}

function saveSessionRowAtomic(
	directory: string,
	runState: LeanTurboRunState,
): void {
	preflightProjectionTarget(directory);
	ensureReadableState(directory);
	for (let attempt = 0; attempt < MAX_SESSION_WRITE_ATTEMPTS; attempt++) {
		const current = getCoordinationState(
			directory,
			COORDINATION_NAMESPACE,
			runState.sessionID,
		);
		const result = transitionCoordinationState(directory, {
			namespace: COORDINATION_NAMESPACE,
			entityKey: runState.sessionID,
			expectedRevision: current?.revision ?? null,
			generation: (current?.generation ?? 0) + 1,
			status: runState.status,
			payload: JSON.stringify(runState),
		});
		if (result.outcome === 'applied') {
			refreshProjectionFromCoordination(directory);
			return;
		}
		if (
			result.outcome === 'revision_conflict' ||
			result.outcome === 'stale_generation'
		) {
			continue;
		}
		throw new Error(
			`Lean Turbo state persistence failed: ${result.outcome} for ${runState.sessionID}`,
		);
	}
	throw new Error(
		`Lean Turbo state persistence failed: contention for ${runState.sessionID}`,
	);
}

function mutateSessionRowAtomic(
	directory: string,
	sessionID: string,
	mutate: (state: LeanTurboRunState) => void,
): LeanTurboRunState | null {
	preflightProjectionTarget(directory);
	ensureReadableState(directory);
	for (let attempt = 0; attempt < MAX_SESSION_WRITE_ATTEMPTS; attempt++) {
		const current = getCoordinationState(
			directory,
			COORDINATION_NAMESPACE,
			sessionID,
		);
		if (!current) return null;
		const nextState = parseRunStatePayload(current.payload, sessionID);
		mutate(nextState);
		const result = transitionCoordinationState(directory, {
			namespace: COORDINATION_NAMESPACE,
			entityKey: sessionID,
			expectedRevision: current.revision,
			generation: current.generation + 1,
			status: nextState.status,
			payload: JSON.stringify(nextState),
		});
		if (result.outcome === 'applied') {
			refreshProjectionFromCoordination(directory);
			return nextState;
		}
		if (
			result.outcome === 'revision_conflict' ||
			result.outcome === 'stale_generation'
		) {
			continue;
		}
		throw new Error(
			`Lean Turbo state persistence failed: ${result.outcome} for ${sessionID}`,
		);
	}
	throw new Error(
		`Lean Turbo state persistence failed: contention for ${sessionID}`,
	);
}

function deleteSessionRowAtomic(directory: string, sessionID: string): void {
	preflightProjectionTarget(directory);
	ensureReadableState(directory);
	for (let attempt = 0; attempt < MAX_SESSION_WRITE_ATTEMPTS; attempt++) {
		const current = getCoordinationState(
			directory,
			COORDINATION_NAMESPACE,
			sessionID,
		);
		if (!current) {
			refreshProjectionFromCoordination(directory);
			return;
		}
		if (
			deleteCoordinationState(
				directory,
				COORDINATION_NAMESPACE,
				sessionID,
				current.revision,
			)
		) {
			refreshProjectionFromCoordination(directory);
			return;
		}
	}
	throw new Error(
		`Lean Turbo state persistence failed: contention for ${sessionID}`,
	);
}

export function emptyCounters(): LeanTurboCounters {
	return {
		lanesPlanned: 0,
		lanesStarted: 0,
		lanesCompleted: 0,
		lanesFailed: 0,
		tasksSerialized: 0,
		tasksDegraded: 0,
	};
}

export function emptyRunState(
	sessionID: string,
	maxParallelCoders: number,
): LeanTurboRunState {
	return {
		status: 'idle',
		sessionID,
		strategy: 'lean',
		maxParallelCoders,
		lanes: [],
		degradedTasks: [],
		serializedTasks: [],
		counters: emptyCounters(),
	};
}

export function emptyPersisted(): LeanTurboPersistedState {
	return {
		version: 1,
		updatedAt: nowISO(),
		sessions: {},
	};
}

/**
 * Directory-keyed map set by `readPersisted` when canonical state is
 * unreadable (corrupt legacy JSON, malformed row payloads, import conflicts).
 */
const stateUnreadableMap = new Map<string, boolean>();

function stateKey(directory: string): string {
	return canonicalRootKeyFresh(directory);
}

export function isStateUnreadable(directory: string): boolean {
	return stateUnreadableMap.get(stateKey(directory)) ?? false;
}

function markStateUnreadable(directory: string, reason: string): void {
	stateUnreadableMap.set(stateKey(directory), true);
	logger.error(
		`[turbo/lean/state] state unreadable for ${directory}: ${reason} — failing closed`,
	);
}

export function repairStateUnreadable(directory: string): void {
	try {
		const filePath = stateFilePath(directory);
		if (fs.existsSync(filePath)) {
			parsePersistedJson(fs.readFileSync(filePath, 'utf-8'));
		}
		buildPersistedFromCoordination(directory);
		stateUnreadableMap.delete(stateKey(directory));
	} catch {
		stateUnreadableMap.set(stateKey(directory), true);
	}
}

export function readPersisted(
	directory: string,
): LeanTurboPersistedState | null {
	try {
		const coordinated = buildPersistedFromCoordination(directory);
		if (coordinated) {
			const filePath = stateFilePath(directory);
			if (fs.existsSync(filePath)) {
				let matches = false;
				try {
					matches =
						JSON.stringify(
							parsePersistedJson(fs.readFileSync(filePath, 'utf-8')),
						) === JSON.stringify(coordinated);
				} catch {
					matches = false;
				}
				if (!matches) archiveStateFileWithoutOverwrite(directory);
			}
			seedProjectionBestEffort(directory, coordinated);
			return coordinated;
		}
		const imported = importLegacyStateIfNeeded(directory);
		if (imported) return imported;
		const seed = emptyPersisted();
		seedProjectionBestEffort(directory, seed);
		return seed;
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		markStateUnreadable(directory, reason);
		return null;
	}
}

export function writePersisted(
	directory: string,
	persisted: LeanTurboPersistedState,
): void {
	if (stateUnreadableMap.get(stateKey(directory))) {
		throw new Error(
			`Lean Turbo state is unreadable. Please repair .swarm/${STATE_FILE} before continuing.`,
		);
	}
	preflightProjectionTarget(directory);
	const nextUpdatedAt = nowISO();
	const nextPersisted: LeanTurboPersistedState = {
		version: 1,
		updatedAt: nextUpdatedAt,
		sessions: persisted.sessions,
	};
	try {
		withCoordinationTransaction(directory, () => {
			const currentRows = new Map(
				listCoordinationStates(directory, COORDINATION_NAMESPACE).map((row) => [
					row.entityKey,
					row,
				]),
			);
			const nextKeys = new Set(Object.keys(nextPersisted.sessions));
			for (const [entityKey, row] of currentRows) {
				if (nextKeys.has(entityKey)) continue;
				const deleted = deleteCoordinationState(
					directory,
					COORDINATION_NAMESPACE,
					entityKey,
					row.revision,
				);
				if (!deleted) {
					throw new Error(
						`Lean Turbo state persistence failed: delete conflict for ${entityKey}`,
					);
				}
			}
			for (const [sessionID, runState] of Object.entries(
				nextPersisted.sessions,
			)) {
				const current = currentRows.get(sessionID);
				const result = transitionCoordinationState(directory, {
					namespace: COORDINATION_NAMESPACE,
					entityKey: sessionID,
					expectedRevision: current?.revision ?? null,
					generation: (current?.generation ?? 0) + 1,
					status: runState.status,
					payload: JSON.stringify(runState),
				});
				if (result.outcome !== 'applied') {
					throw new Error(
						`Lean Turbo state persistence failed: ${result.outcome} for ${sessionID}`,
					);
				}
			}
		});
		writeProjection(directory, nextPersisted);
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		logger.error(`[turbo/lean/state] Failed to persist ${STATE_FILE}: ${msg}`);
		throw new Error(
			msg.startsWith('Lean Turbo state persistence')
				? msg
				: `Lean Turbo state persistence failed: ${msg}`,
		);
	}
}

export function loadLeanTurboRunState(
	directory: string,
	sessionID: string,
): LeanTurboRunState | null {
	if (stateUnreadableMap.get(stateKey(directory))) return null;
	const persisted = readPersisted(directory);
	if (!persisted) return null;
	return persisted.sessions[sessionID] ?? null;
}

export function saveLeanTurboRunState(
	directory: string,
	runState: LeanTurboRunState,
): void {
	saveSessionRowAtomic(directory, runState);
}

export function isLeanTurboRunActive(
	directory: string,
	sessionID: string,
): boolean {
	if (stateUnreadableMap.get(stateKey(directory))) return false;
	const persisted = readPersisted(directory);
	if (!persisted) return false;
	const state = persisted.sessions[sessionID];
	return state?.status === 'running';
}

export function pauseLeanTurboRun(
	directory: string,
	sessionID: string,
	reason: string,
): void {
	mutateSessionRowAtomic(directory, sessionID, (state) => {
		state.status = 'paused';
		state.pauseReason = reason;
	});
}

export function resetLeanTurboRun(directory: string, sessionID: string): void {
	deleteSessionRowAtomic(directory, sessionID);
}
