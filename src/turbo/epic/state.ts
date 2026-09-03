/**
 * Durable Epic Mode session state (Capability C).
 *
 * Persists per-session Epic Mode activation state under
 * `<projectRoot>/.swarm/epic-state.json` so toggling survives process
 * restarts. Mirrors the pattern in `src/turbo/lean/state.ts` (atomic
 * `tmp + rename`, per-directory `stateUnreadableMap` for fail-closed
 * semantics, sessions-keyed shape) — without modifying that file.
 *
 * Dependency direction is one-way: this module imports nothing from
 * `src/turbo/lean/`. The shape is parallel but independent.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
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

export function emptyPersisted(): EpicPersistedState {
	return { version: 1, updatedAt: nowISO(), sessions: {} };
}

export function emptySessionState(sessionID: string): EpicSessionState {
	return { sessionID, active: false };
}

/**
 * Per-directory fail-closed marker. When the canonical state file is corrupt
 * (bad JSON, unknown shape, version mismatch), we set a flag and refuse to
 * read it until `repairStateUnreadable` is called.
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
		`[turbo/epic/state] state file unreadable for ${directory}: ${reason} — failing closed`,
	);
}

export function repairStateUnreadable(directory: string): void {
	const filePath = path.join(directory, '.swarm', STATE_FILE);
	if (!fs.existsSync(filePath)) {
		stateUnreadableMap.delete(stateKey(directory));
		return;
	}
	try {
		const raw = fs.readFileSync(filePath, 'utf-8');
		const parsed = JSON.parse(raw) as Partial<EpicPersistedState>;
		if (
			!parsed ||
			typeof parsed !== 'object' ||
			Array.isArray(parsed) ||
			parsed.version !== 1 ||
			!parsed.sessions ||
			typeof parsed.sessions !== 'object' ||
			Array.isArray(parsed.sessions)
		) {
			stateUnreadableMap.set(stateKey(directory), true);
			return;
		}
		stateUnreadableMap.delete(stateKey(directory));
	} catch {
		stateUnreadableMap.set(stateKey(directory), true);
	}
}

function readPersisted(directory: string): EpicPersistedState | null {
	try {
		const filePath = path.join(directory, '.swarm', STATE_FILE);
		if (!fs.existsSync(filePath)) {
			// Seed an empty persisted file so subsequent writes don't race on
			// directory creation. Matches lean/state.ts behaviour.
			const seed = emptyPersisted();
			try {
				ensureSwarmDir(directory);
				fs.writeFileSync(
					filePath,
					`${JSON.stringify(seed, null, 2)}\n`,
					'utf-8',
				);
			} catch {
				// best-effort seed
			}
			return seed;
		}
		const raw = fs.readFileSync(filePath, 'utf-8');
		const parsed = JSON.parse(raw) as Partial<EpicPersistedState>;
		if (
			!parsed ||
			typeof parsed !== 'object' ||
			Array.isArray(parsed) ||
			parsed.version !== 1 ||
			!parsed.sessions ||
			typeof parsed.sessions !== 'object' ||
			Array.isArray(parsed.sessions)
		) {
			markStateUnreadable(
				directory,
				`malformed shape (version=${parsed?.version}, sessions type=${Array.isArray(parsed?.sessions) ? 'array' : typeof parsed?.sessions})`,
			);
			return null;
		}
		return {
			version: 1,
			updatedAt: parsed.updatedAt ?? nowISO(),
			sessions: parsed.sessions as Record<string, EpicSessionState>,
		};
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		markStateUnreadable(directory, reason);
		return null;
	}
}

function writePersisted(
	directory: string,
	persisted: EpicPersistedState,
): void {
	if (stateUnreadableMap.get(stateKey(directory))) {
		throw new Error(
			`Epic state is unreadable. Please repair .swarm/${STATE_FILE} before continuing.`,
		);
	}
	let filePath: string;
	let tmpPath: string;
	let payload: string;
	try {
		ensureSwarmDir(directory);
		filePath = path.join(directory, '.swarm', STATE_FILE);
		tmpPath = `${filePath}.tmp.${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		persisted.updatedAt = nowISO();
		payload = `${JSON.stringify(persisted, null, 2)}\n`;
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		logger.error(
			`[turbo/epic/state] Failed to prepare ${STATE_FILE} write: ${msg}`,
		);
		throw new Error(`Epic state persistence prepare failed: ${msg}`);
	}
	try {
		fs.writeFileSync(tmpPath, payload, 'utf-8');
		fs.renameSync(tmpPath, filePath);
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		logger.error(
			`[turbo/epic/state] Failed to persist ${STATE_FILE} atomically: ${msg}`,
		);
		try {
			if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
		} catch {
			// best-effort cleanup
		}
		throw new Error(`Epic state persistence failed: ${msg}`);
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
	if (stateUnreadableMap.get(stateKey(directory))) {
		throw new Error(
			`Epic state is unreadable for ${directory}. Repair .swarm/${STATE_FILE} before continuing.`,
		);
	}
	const persisted = readPersisted(directory);
	if (!persisted) {
		throw new Error(
			`Epic state is unreadable for ${directory}. Repair .swarm/${STATE_FILE} before continuing.`,
		);
	}
	persisted.sessions[state.sessionID] = state;
	writePersisted(directory, persisted);
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
 * Use this when a code path needs to know "is the project running under
 * Epic Mode right now" without caring which session toggled it. The
 * session-scoped `isEpicModeActive` answers "did THIS session toggle it" —
 * a different question with a different answer.
 *
 * The architect's session enables Epic via `/swarm epic on`; sub-agents
 * (coders, reviewers) dispatched through the `Task` tool run in their own
 * sessions and have no record of that toggle. Asking the project-scoped
 * check is the only correct way to honor Epic Mode from those flows.
 * Rule 2's auto-commit (centralized in Phase 5) is the canonical caller.
 *
 * Fail-closed: returns `false` on unreadable state, matching the rest of
 * this module's defaults.
 */
export function isEpicModeActiveForProject(directory: string): boolean {
	if (stateUnreadableMap.get(stateKey(directory))) return false;
	// Phase 8: probe for the state file BEFORE calling `readPersisted`,
	// which would otherwise seed an empty `.swarm/epic-state.json` (and
	// the `.swarm/` directory itself) for any project that hasn't run
	// Epic Mode. Centralized Rule 2 (`plan/manager.updateTaskStatus`)
	// calls this on every `status === 'completed'` transition, so the
	// seeding would leak into every project using `update_task_status`,
	// including non-Epic Lean Turbo and plain plan-only flows. The
	// contract is unchanged: no file ⇒ no session is active ⇒ false.
	if (!fs.existsSync(path.join(directory, '.swarm', STATE_FILE))) {
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
	const current =
		loadEpicSessionState(directory, sessionID) ?? emptySessionState(sessionID);
	current.active = true;
	current.enabledAt = nowISO();
	current.disabledAt = undefined;
	saveEpicSessionState(directory, current);
}

/** Disable epic mode for the session; records `disabledAt`. */
export function disableEpicMode(directory: string, sessionID: string): void {
	const current = loadEpicSessionState(directory, sessionID);
	if (!current) {
		// Nothing to disable — record an inactive state for telemetry parity.
		saveEpicSessionState(directory, {
			...emptySessionState(sessionID),
			disabledAt: nowISO(),
		});
		return;
	}
	current.active = false;
	current.disabledAt = nowISO();
	saveEpicSessionState(directory, current);
}

/** Reset the session's state entry entirely. */
export function resetEpicSession(directory: string, sessionID: string): void {
	if (stateUnreadableMap.get(stateKey(directory))) {
		throw new Error(
			`Epic state is unreadable for ${directory}. Repair .swarm/${STATE_FILE} before continuing.`,
		);
	}
	const persisted = readPersisted(directory);
	if (!persisted) {
		throw new Error(
			`Epic state is unreadable for ${directory}. Repair .swarm/${STATE_FILE} before continuing.`,
		);
	}
	delete persisted.sessions[sessionID];
	writePersisted(directory, persisted);
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
	current.lastDecision = decision;
	saveEpicSessionState(directory, current);
}
