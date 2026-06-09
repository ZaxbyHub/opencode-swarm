/**
 * Durable Lean Turbo run state.
 *
 * Persists per-session Lean Turbo execution state under
 * `<projectRoot>/.swarm/turbo-state.json` so that pause/terminate decisions
 * survive process restarts.
 *
 * Lean Turbo is a lighter-weight alternative to Full-Auto, using a lane-based
 * task distribution model with degraded-task tracking.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
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
 * Directory-keyed map set by `readPersisted` when a canonical state file
 * is unreadable (corrupt JSON, version mismatch, malformed shape).
 * Consulted by `isLeanTurboRunActive` so the system can fail-closed
 * instead of treating "no record" as "not running".
 *
 * Keyed by project root directory so one corrupted session does not
 * poison all sessions across different projects.
 */
const stateUnreadableMap = new Map<string, boolean>();

export function isStateUnreadable(directory: string): boolean {
	return stateUnreadableMap.get(directory) ?? false;
}

function _clearStateUnreadable(directory: string): void {
	stateUnreadableMap.delete(directory);
}

function markStateUnreadable(directory: string, reason: string): void {
	stateUnreadableMap.set(directory, true);
	logger.error(
		`[turbo/lean/state] state file unreadable for ${directory}: ${reason} — failing closed`,
	);
}

export function repairStateUnreadable(directory: string): void {
	const filePath = path.join(directory, '.swarm', STATE_FILE);
	if (!fs.existsSync(filePath)) {
		stateUnreadableMap.delete(directory);
		return;
	}
	try {
		const raw = fs.readFileSync(filePath, 'utf-8');
		const parsed = JSON.parse(raw) as Partial<LeanTurboPersistedState>;
		if (
			!parsed ||
			typeof parsed !== 'object' ||
			Array.isArray(parsed) ||
			parsed.version !== 1 ||
			!parsed.sessions ||
			typeof parsed.sessions !== 'object' ||
			Array.isArray(parsed.sessions)
		) {
			stateUnreadableMap.set(directory, true);
			return;
		}
		stateUnreadableMap.delete(directory);
	} catch {
		stateUnreadableMap.set(directory, true);
	}
}

export function readPersisted(
	directory: string,
): LeanTurboPersistedState | null {
	try {
		const filePath = path.join(directory, '.swarm', STATE_FILE);
		if (!fs.existsSync(filePath)) {
			// Seed with empty persisted state
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
		const parsed = JSON.parse(raw) as Partial<LeanTurboPersistedState>;
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
			sessions: parsed.sessions as Record<string, LeanTurboRunState>,
		};
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
	if (stateUnreadableMap.get(directory)) {
		throw new Error(
			`Lean Turbo state is unreadable. Please repair .swarm/${STATE_FILE} before continuing.`,
		);
	}
	let filePath: string;
	let tmpPath: string;
	let payload: string;
	try {
		ensureSwarmDir(directory);
		filePath = path.join(directory, '.swarm', STATE_FILE);
		tmpPath = `${filePath}.tmp.${Date.now()}`;
		persisted.updatedAt = nowISO();
		payload = `${JSON.stringify(persisted, null, 2)}\n`;
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		logger.error(
			`[turbo/lean/state] Failed to prepare ${STATE_FILE} write: ${msg}`,
		);
		throw new Error(`Lean Turbo state persistence prepare failed: ${msg}`);
	}
	try {
		fs.writeFileSync(tmpPath, payload, 'utf-8');
		fs.renameSync(tmpPath, filePath);
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		logger.error(
			`[turbo/lean/state] Failed to persist ${STATE_FILE} atomically: ${msg}`,
		);
		// Clean up temp file if it exists
		try {
			if (fs.existsSync(tmpPath)) {
				fs.unlinkSync(tmpPath);
			}
		} catch {
			// best-effort cleanup
		}
		throw new Error(`Lean Turbo state persistence failed: ${msg}`);
	}
}

export function loadLeanTurboRunState(
	directory: string,
	sessionID: string,
): LeanTurboRunState | null {
	if (stateUnreadableMap.get(directory)) return null;
	const persisted = readPersisted(directory);
	if (!persisted) return null;
	return persisted.sessions[sessionID] ?? null;
}

export function saveLeanTurboRunState(
	directory: string,
	runState: LeanTurboRunState,
): void {
	if (stateUnreadableMap.get(directory)) {
		throw new Error(
			`Lean Turbo state is unreadable for ${directory}. Please repair .swarm/${STATE_FILE} before continuing.`,
		);
	}
	const persisted = readPersisted(directory);
	if (!persisted) {
		throw new Error(
			`Lean Turbo state is unreadable for ${directory}. Please repair .swarm/${STATE_FILE} before continuing.`,
		);
	}
	persisted.sessions[runState.sessionID] = runState;
	writePersisted(directory, persisted);
}

export function isLeanTurboRunActive(
	directory: string,
	sessionID: string,
): boolean {
	if (stateUnreadableMap.get(directory)) return false;
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
	if (stateUnreadableMap.get(directory)) {
		throw new Error(
			`Lean Turbo state is unreadable for ${directory}. Please repair .swarm/${STATE_FILE} before continuing.`,
		);
	}
	const persisted = readPersisted(directory);
	if (!persisted) {
		throw new Error(
			`Lean Turbo state is unreadable for ${directory}. Please repair .swarm/${STATE_FILE} before continuing.`,
		);
	}
	const state = persisted.sessions[sessionID];
	if (!state) return;
	state.status = 'paused';
	state.pauseReason = reason;
	persisted.sessions[sessionID] = state;
	writePersisted(directory, persisted);
}

export function resetLeanTurboRun(directory: string, sessionID: string): void {
	if (stateUnreadableMap.get(directory)) {
		throw new Error(
			`Lean Turbo state is unreadable for ${directory}. Please repair .swarm/${STATE_FILE} before continuing.`,
		);
	}
	const persisted = readPersisted(directory);
	if (!persisted) {
		throw new Error(
			`Lean Turbo state is unreadable for ${directory}. Please repair .swarm/${STATE_FILE} before continuing.`,
		);
	}
	delete persisted.sessions[sessionID];
	writePersisted(directory, persisted);
}
