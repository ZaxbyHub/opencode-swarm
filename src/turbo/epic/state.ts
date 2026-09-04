/**
 * Durable Epic Mode session state.
 *
 * The authoritative store is the per-project SQLite coordination DB, with one
 * row per session. `.swarm/epic-state.json` remains a compatibility
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
} from '../../db/coordination-store.js';
import { canonicalRootKeyFresh } from '../../utils/canonical-root.js';
import * as logger from '../../utils/logger.js';

/** Top-level state for a single session. */
export interface EpicSessionState {
	sessionID: string;
	/** When epic mode was last enabled for this session (ISO 8601). */
	enabledAt?: string;
	/** When epic mode was last disabled for this session (ISO 8601). */
	disabledAt?: string;
	/** Most recent activation decision recorded for this session, if any. */
	lastDecision?: EpicLastDecision;
	/** Whether epic mode is currently active for this session. */
	active: boolean;
}

/** Minimal snapshot of the last activation decision. */
export interface EpicLastDecision {
	decidedAt: string;
	phase?: number;
	decision: 'promote' | 'demote';
	p: number;
	blockingReasons: string[];
}

/** Persisted shape of `.swarm/epic-state.json`. */
export interface EpicPersistedState {
	version: 1;
	updatedAt: string;
	sessions: Record<string, EpicSessionState>;
}

const STATE_FILE = 'epic-state.json';
const COORDINATION_NAMESPACE = 'turbo.epic.session';
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
	throw new Error('Epic state legacy archive collision limit exceeded');
}

function projectionTmpPath(filePath: string): string {
	return `${filePath}.tmp.${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validatePersistedShape(parsed: unknown): parsed is EpicPersistedState {
	return isRecord(parsed) && parsed.version === 1 && isRecord(parsed.sessions);
}

function parsePersistedJson(raw: string): EpicPersistedState {
	const parsed = JSON.parse(raw) as unknown;
	if (!validatePersistedShape(parsed)) {
		const maybe = parsed as Partial<EpicPersistedState> | undefined;
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

function parseSessionPayload(
	payload: string,
	entityKey: string,
): EpicSessionState {
	const parsed = JSON.parse(payload) as unknown;
	if (!isRecord(parsed) || parsed.sessionID !== entityKey) {
		throw new Error(
			`session payload malformed for ${entityKey}: sessionID mismatch`,
		);
	}
	return parsed as unknown as EpicSessionState;
}

function buildPersistedFromCoordination(
	directory: string,
): EpicPersistedState | null {
	const rows = listCoordinationStates(directory, COORDINATION_NAMESPACE);
	if (rows.length === 0) return null;
	const sessions: Record<string, EpicSessionState> = {};
	let updatedAt = '';
	for (const row of rows) {
		sessions[row.entityKey] = parseSessionPayload(row.payload, row.entityKey);
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
): { persisted: EpicPersistedState; sourceDigest: string } | null {
	const filePath = stateFilePath(directory);
	if (!fs.existsSync(filePath)) return null;
	const raw = fs.readFileSync(filePath, 'utf-8');
	return {
		persisted: parsePersistedJson(raw),
		sourceDigest: createHash('sha256').update(raw).digest('hex'),
	};
}

function writeProjection(
	directory: string,
	persisted: EpicPersistedState,
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

function seedProjectionBestEffort(
	directory: string,
	persisted: EpicPersistedState,
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
			`Epic state persistence prepare failed: ${STATE_FILE} is a directory`,
		);
	}
}

function importLegacyStateIfNeeded(
	directory: string,
): EpicPersistedState | null {
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
					status: state.active ? 'active' : 'inactive',
					payload: JSON.stringify(state),
				});
				if (result.outcome !== 'applied') {
					throw new Error('Epic legacy import conflict');
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
		`Epic state is unreadable for ${directory}. Repair .swarm/${STATE_FILE} before continuing.`,
	);
}

function ensureReadableState(directory: string): void {
	if (stateUnreadableMap.get(stateKey(directory)))
		throw unreadableStateError(directory);
	if (!readPersisted(directory)) throw unreadableStateError(directory);
}

function refreshProjectionFromCoordination(directory: string): void {
	const persisted =
		buildPersistedFromCoordination(directory) ?? emptyPersisted();
	writeProjection(directory, persisted);
}

function saveSessionRowAtomic(
	directory: string,
	state: EpicSessionState,
): void {
	preflightProjectionTarget(directory);
	ensureReadableState(directory);
	for (let attempt = 0; attempt < MAX_SESSION_WRITE_ATTEMPTS; attempt++) {
		const current = getCoordinationState(
			directory,
			COORDINATION_NAMESPACE,
			state.sessionID,
		);
		const result = transitionCoordinationState(directory, {
			namespace: COORDINATION_NAMESPACE,
			entityKey: state.sessionID,
			expectedRevision: current?.revision ?? null,
			generation: (current?.generation ?? 0) + 1,
			status: state.active ? 'active' : 'inactive',
			payload: JSON.stringify(state),
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
			`Epic state persistence failed: ${result.outcome} for ${state.sessionID}`,
		);
	}
	throw new Error(
		`Epic state persistence failed: contention for ${state.sessionID}`,
	);
}

function mutateSessionRowAtomic(
	directory: string,
	sessionID: string,
	mutate: (state: EpicSessionState) => void,
): EpicSessionState | null {
	preflightProjectionTarget(directory);
	ensureReadableState(directory);
	for (let attempt = 0; attempt < MAX_SESSION_WRITE_ATTEMPTS; attempt++) {
		const current = getCoordinationState(
			directory,
			COORDINATION_NAMESPACE,
			sessionID,
		);
		if (!current) return null;
		const nextState = parseSessionPayload(current.payload, sessionID);
		mutate(nextState);
		const result = transitionCoordinationState(directory, {
			namespace: COORDINATION_NAMESPACE,
			entityKey: sessionID,
			expectedRevision: current.revision,
			generation: current.generation + 1,
			status: nextState.active ? 'active' : 'inactive',
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
			`Epic state persistence failed: ${result.outcome} for ${sessionID}`,
		);
	}
	throw new Error(`Epic state persistence failed: contention for ${sessionID}`);
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
	throw new Error(`Epic state persistence failed: contention for ${sessionID}`);
}

export function emptyPersisted(): EpicPersistedState {
	return { version: 1, updatedAt: nowISO(), sessions: {} };
}

export function emptySessionState(sessionID: string): EpicSessionState {
	return { sessionID, active: false };
}

/**
 * Per-directory fail-closed marker. When canonical state is corrupt
 * (bad legacy JSON, malformed row payloads, import conflicts), we set a flag
 * and refuse to read it until `repairStateUnreadable` is called.
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
		`[turbo/epic/state] state unreadable for ${directory}: ${reason} — failing closed`,
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

function readPersisted(directory: string): EpicPersistedState | null {
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

function _writePersisted(
	directory: string,
	persisted: EpicPersistedState,
): void {
	if (stateUnreadableMap.get(stateKey(directory))) {
		throw new Error(
			`Epic state is unreadable. Please repair .swarm/${STATE_FILE} before continuing.`,
		);
	}
	preflightProjectionTarget(directory);
	const nextUpdatedAt = nowISO();
	const nextPersisted: EpicPersistedState = {
		version: 1,
		updatedAt: nextUpdatedAt,
		sessions: persisted.sessions,
	};
	try {
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
					`Epic state persistence failed: delete conflict for ${entityKey}`,
				);
			}
		}
		for (const [sessionID, state] of Object.entries(nextPersisted.sessions)) {
			const current = currentRows.get(sessionID);
			const result = transitionCoordinationState(directory, {
				namespace: COORDINATION_NAMESPACE,
				entityKey: sessionID,
				expectedRevision: current?.revision ?? null,
				generation: (current?.generation ?? 0) + 1,
				status: state.active ? 'active' : 'inactive',
				payload: JSON.stringify(state),
			});
			if (result.outcome !== 'applied') {
				throw new Error(
					`Epic state persistence failed: ${result.outcome} for ${sessionID}`,
				);
			}
		}
		writeProjection(directory, nextPersisted);
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		logger.error(`[turbo/epic/state] Failed to persist ${STATE_FILE}: ${msg}`);
		throw new Error(
			msg.startsWith('Epic state persistence')
				? msg
				: `Epic state persistence failed: ${msg}`,
		);
	}
}

/** Read this session's state, or null if not yet recorded. */
export function loadEpicSessionState(
	directory: string,
	sessionID: string,
): EpicSessionState | null {
	if (stateUnreadableMap.get(stateKey(directory))) return null;
	const persisted = readPersisted(directory);
	if (!persisted) return null;
	return persisted.sessions[sessionID] ?? null;
}

/** Write the given session state, replacing any prior entry for that sessionID. */
export function saveEpicSessionState(
	directory: string,
	state: EpicSessionState,
): void {
	saveSessionRowAtomic(directory, state);
}

/** True iff epic mode is currently active for the given session. */
export function isEpicModeActive(
	directory: string,
	sessionID: string,
): boolean {
	const state = loadEpicSessionState(directory, sessionID);
	return state?.active === true;
}

/**
 * True iff epic mode is currently active for ANY session in the project.
 *
 * Fail-closed: returns `false` on unreadable state, matching the rest of
 * this module's defaults.
 */
export function isEpicModeActiveForProject(directory: string): boolean {
	// This read-only probe is also called by a few direct tool entry points that
	// bypass `resolveWorkingDirectory`. Never follow raw traversal segments into
	// an ancestor's `.swarm/` database; the caller will fail closed at its normal
	// retrospective/project-root gate instead.
	if (directory.split(/[\\/]/).includes('..')) return false;
	if (stateUnreadableMap.get(stateKey(directory))) return false;
	const hasLegacyFile = fs.existsSync(stateFilePath(directory));
	let hasCoordinationRows = false;
	try {
		hasCoordinationRows =
			listCoordinationStates(directory, COORDINATION_NAMESPACE, 1).length > 0;
	} catch {
		// A missing/inaccessible or corrupt coordination DB must not turn this
		// advisory read into a tool crash. The state is unreadable, so fail closed.
		return false;
	}
	if (!hasLegacyFile && !hasCoordinationRows) {
		return false;
	}
	const persisted = readPersisted(directory);
	if (!persisted) return false;
	for (const session of Object.values(persisted.sessions)) {
		if (session?.active === true) return true;
	}
	return false;
}

/** Enable epic mode for the session; records `enabledAt`. */
export function enableEpicMode(directory: string, sessionID: string): void {
	const current = loadEpicSessionState(directory, sessionID);
	if (!current) {
		saveSessionRowAtomic(directory, {
			...emptySessionState(sessionID),
			active: true,
			enabledAt: nowISO(),
			disabledAt: undefined,
		});
		return;
	}
	mutateSessionRowAtomic(directory, sessionID, (state) => {
		state.active = true;
		state.enabledAt = nowISO();
		state.disabledAt = undefined;
	});
}

/** Disable epic mode for the session; records `disabledAt`. */
export function disableEpicMode(directory: string, sessionID: string): void {
	const current = loadEpicSessionState(directory, sessionID);
	if (!current) {
		// Nothing to disable — record an inactive state for telemetry parity.
		saveSessionRowAtomic(directory, {
			...emptySessionState(sessionID),
			disabledAt: nowISO(),
		});
		return;
	}
	mutateSessionRowAtomic(directory, sessionID, (state) => {
		state.active = false;
		state.disabledAt = nowISO();
	});
}

/** Reset the session's state entry entirely. */
export function resetEpicSession(directory: string, sessionID: string): void {
	deleteSessionRowAtomic(directory, sessionID);
}

/**
 * Update the session's `lastDecision` field. Used by the runner after each
 * activation evaluation so `/swarm epic status` can show the most recent
 * decision rationale without re-reading the evidence JSONL.
 *
 * Precondition: the session must already have an entry (i.e. the caller has
 * called `enableEpicMode` previously). This is intentional — recording a
 * decision for a never-toggled session would produce phantom state that
 * `/swarm epic status` could not distinguish from a legitimately-active
 * session. Callers that reach this function should have already verified
 * `isEpicModeActive(...)` returned `true`. Throws if no session entry exists.
 */
export function recordEpicDecision(
	directory: string,
	sessionID: string,
	decision: EpicLastDecision,
): void {
	const current = loadEpicSessionState(directory, sessionID);
	if (!current) {
		throw new Error(
			`Cannot record decision for sessionID '${sessionID}': no session entry exists. Call enableEpicMode first.`,
		);
	}
	mutateSessionRowAtomic(directory, sessionID, (state) => {
		state.lastDecision = decision;
	});
}
