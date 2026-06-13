/**
 * Durable Full-Auto v2 run state.
 *
 * Persists per-session Full-Auto execution state under
 * `<projectRoot>/.swarm/full-auto-state.json` so that pause/terminate decisions
 * survive process restarts and so that hooks running across sessions see a
 * consistent picture of denial counters, oversight cadence, and run status.
 *
 * The legacy session-scoped flag `AgentSessionState.fullAutoMode` continues to
 * gate the reactive intercept hook for backward compatibility. v2 layers a
 * durable record on top so the new permission/oversight infrastructure can
 * fail-closed when the runtime cannot be trusted.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import lockfileImport from 'proper-lockfile';
import { validateSwarmPath } from '../hooks/utils';
import * as logger from '../utils/logger';

// proper-lockfile ships JS-only with no TS types; cast to a minimal interface
// covering the `lockSync` API we use.
const lockfile = lockfileImport as unknown as {
	lockSync: (
		file: string,
		options?: {
			retries?:
				| number
				| { retries?: number; minTimeout?: number; maxTimeout?: number };
			stale?: number;
		},
	) => () => void;
};

export type FullAutoStatus = 'idle' | 'running' | 'paused' | 'terminated';

export interface FullAutoDenialRecord {
	timestamp: string;
	tool?: string;
	code?: string;
	reason: string;
}

export interface FullAutoCounters {
	architectTurns: number;
	toolCalls: number;
	coderDelegations: number;
	reviewerRejections: number;
	testFailures: number;
	oversightChecks: number;
	consecutiveNoProgressTurns: number;
}

export interface FullAutoRunState {
	status: FullAutoStatus;
	sessionID: string;
	mode: 'assisted' | 'supervised' | 'strict';
	planID?: string;
	currentPhase?: number;
	currentTaskID?: string;
	startedAt: string;
	updatedAt: string;
	lastOversightAt?: string;
	lastOversightReason?: string;
	lastOversightVerdict?: string;
	denialCounters: {
		consecutive: number;
		total: number;
	};
	denialHistory: FullAutoDenialRecord[];
	counters: FullAutoCounters;
	pauseReason?: string;
	terminateReason?: string;
}

export interface FullAutoPersistedState {
	version: 2;
	updatedAt: string;
	/**
	 * Monotonic counter for `full_auto_oversight` evidence-file sequencing.
	 * Persisted so the per-phase filename `full-auto-{seq}.json` does not
	 * collide after a process restart. (C4 fix.)
	 */
	oversightSequence?: number;
	sessions: Record<string, FullAutoRunState>;
}

export interface FullAutoConfigShape {
	enabled?: boolean;
	mode?: 'assisted' | 'supervised' | 'strict';
	denials?: {
		max_consecutive?: number;
		max_total?: number;
		on_limit?: 'pause' | 'terminate';
	};
}

const STATE_FILE = 'full-auto-state.json';
const MAX_DENIAL_HISTORY = 100;

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

function emptyCounters(): FullAutoCounters {
	return {
		architectTurns: 0,
		toolCalls: 0,
		coderDelegations: 0,
		reviewerRejections: 0,
		testFailures: 0,
		oversightChecks: 0,
		consecutiveNoProgressTurns: 0,
	};
}

function emptyState(
	sessionID: string,
	mode: FullAutoRunState['mode'] = 'supervised',
): FullAutoRunState {
	const now = nowISO();
	return {
		status: 'idle',
		sessionID,
		mode,
		startedAt: now,
		updatedAt: now,
		denialCounters: { consecutive: 0, total: 0 },
		denialHistory: [],
		counters: emptyCounters(),
	};
}

/**
 * Cross-process lock around the read-modify-write cycle on
 * `.swarm/full-auto-state.json`. Bun/Node within a single process is
 * single-threaded, so intra-process RMW is already safe; the lock guards
 * against the rare case where two processes (e.g. an OpenCode plugin and
 * a CLI invocation) touch the same project root concurrently. (H8 fix.)
 *
 * On lock acquisition failure, fall back to running the operation without
 * a lock and log a warning — Full-Auto state safety is best-effort and
 * must not deadlock callers.
 */
function withStateLock<T>(directory: string, fn: () => T): T {
	let release: (() => void) | undefined;
	try {
		const lockTarget = validateSwarmPath(directory, STATE_FILE);
		// Ensure the file exists so proper-lockfile can lock it. Seed with a
		// valid empty-persisted shape so `readPersisted` does not log a parse
		// error on first call.
		if (!fs.existsSync(lockTarget)) {
			ensureSwarmDir(directory);
			const seed: FullAutoPersistedState = {
				version: 2,
				updatedAt: nowISO(),
				oversightSequence: 0,
				sessions: {},
			};
			fs.writeFileSync(
				lockTarget,
				`${JSON.stringify(seed, null, 2)}\n`,
				'utf-8',
			);
		}
		release = lockfile.lockSync(lockTarget, {
			retries: { retries: 5, minTimeout: 5, maxTimeout: 50 },
			stale: 5000,
		});
	} catch (error) {
		logger.warn(
			`[full-auto/state] cross-process lock unavailable; proceeding unlocked: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	try {
		return fn();
	} finally {
		if (release) {
			try {
				release();
			} catch (releaseError) {
				logger.warn(
					`[full-auto/state] lock release failed: ${releaseError instanceof Error ? releaseError.message : String(releaseError)}`,
				);
			}
		}
	}
}

function emptyPersisted(): FullAutoPersistedState {
	return {
		version: 2,
		updatedAt: nowISO(),
		oversightSequence: 0,
		sessions: {},
	};
}

/**
 * Module-level flag set by `readPersisted` when the canonical state file
 * is unreadable (corrupt JSON, version mismatch, malformed shape) AND
 * `.bak` recovery also fails. Consulted by `loadFullAutoRunState` and
 * `isFullAutoRunActive` so the permission hook can fail-closed instead of
 * treating "no record" as "not enforced". (Adversarial review C2 fix.)
 */
let stateUnreadable = false;
let stateUnreadableReason = '';

export class FullAutoStateUnreadableError extends Error {
	constructor(reason: string) {
		super(
			`Full-Auto durable state is unreadable (${reason}). Treating this as a fail-closed condition: read tools are still permitted, but write/shell/network/delegation tools must be blocked until the state file is restored. Inspect .swarm/full-auto-state.json (and .bak) and restart with /swarm full-auto on once recovered.`,
		);
		this.name = 'FullAutoStateUnreadableError';
	}
}

function markStateUnreadable(reason: string): void {
	stateUnreadable = true;
	stateUnreadableReason = reason;
	logger.error(
		`[full-auto/state] state file unreadable: ${reason} — failing closed`,
	);
}

function clearStateUnreadable(): void {
	stateUnreadable = false;
	stateUnreadableReason = '';
}

export function isFullAutoStateUnreadable(): {
	unreadable: boolean;
	reason: string;
} {
	return { unreadable: stateUnreadable, reason: stateUnreadableReason };
}

/**
 * mtime+size-keyed read cache (adversarial review F6). The always-armed hooks
 * call `readPersisted` on every tool call; once a state file exists, an
 * uncached implementation pays a full read+parse on the hot path forever.
 * The cache returns a structuredClone of the parsed state when the file's
 * mtimeMs+size are unchanged — cloning keeps caller mutations (which are
 * always followed by `writePersisted` under the state lock) from poisoning
 * the cache. Cross-process writers bump mtime, which invalidates the entry.
 */
const readCache = new Map<
	string,
	{ mtimeMs: number; size: number; state: FullAutoPersistedState }
>();

function readPersisted(directory: string): FullAutoPersistedState {
	try {
		const filePath = validateSwarmPath(directory, STATE_FILE);
		let stats: fs.Stats;
		try {
			stats = fs.statSync(filePath);
		} catch {
			clearStateUnreadable();
			readCache.delete(filePath);
			return emptyPersisted();
		}
		const cached = readCache.get(filePath);
		if (
			cached &&
			cached.mtimeMs === stats.mtimeMs &&
			cached.size === stats.size
		) {
			clearStateUnreadable();
			return structuredClone(cached.state);
		}
		const raw = fs.readFileSync(filePath, 'utf-8');
		const parsed = JSON.parse(raw) as Partial<FullAutoPersistedState>;
		if (
			!parsed ||
			typeof parsed !== 'object' ||
			Array.isArray(parsed) ||
			parsed.version !== 2 ||
			!parsed.sessions ||
			typeof parsed.sessions !== 'object' ||
			Array.isArray(parsed.sessions)
		) {
			markStateUnreadable(
				`malformed shape (version=${parsed?.version}, sessions type=${Array.isArray(parsed?.sessions) ? 'array' : typeof parsed?.sessions})`,
			);
			readCache.delete(filePath);
			return emptyPersisted();
		}
		clearStateUnreadable();
		const state: FullAutoPersistedState = {
			version: 2,
			updatedAt: parsed.updatedAt ?? nowISO(),
			oversightSequence:
				typeof parsed.oversightSequence === 'number'
					? parsed.oversightSequence
					: 0,
			sessions: parsed.sessions as Record<string, FullAutoRunState>,
		};
		readCache.set(filePath, {
			mtimeMs: stats.mtimeMs,
			size: stats.size,
			state: structuredClone(state),
		});
		return state;
	} catch (error) {
		// C5 partial: a corrupt JSON (truncated mid-write) MUST NOT silently
		// disable Full-Auto. Try to recover from the .bak copy first; if that
		// also fails, mark state unreadable so the permission hook can
		// fail-closed.
		const reason = error instanceof Error ? error.message : String(error);
		logger.error(
			`[full-auto/state] Failed to read ${STATE_FILE}: ${reason} — attempting .bak recovery`,
		);
		try {
			const bakPath = validateSwarmPath(directory, `${STATE_FILE}.bak`);
			if (fs.existsSync(bakPath)) {
				const raw = fs.readFileSync(bakPath, 'utf-8');
				const parsed = JSON.parse(raw) as Partial<FullAutoPersistedState>;
				if (
					parsed?.version === 2 &&
					parsed.sessions &&
					!Array.isArray(parsed.sessions)
				) {
					logger.warn(`[full-auto/state] Recovered from ${STATE_FILE}.bak`);
					clearStateUnreadable();
					return {
						version: 2,
						updatedAt: parsed.updatedAt ?? nowISO(),
						oversightSequence:
							typeof parsed.oversightSequence === 'number'
								? parsed.oversightSequence
								: 0,
						sessions: parsed.sessions as Record<string, FullAutoRunState>,
					};
				}
			}
		} catch (bakError) {
			logger.error(
				`[full-auto/state] .bak recovery also failed: ${bakError instanceof Error ? bakError.message : String(bakError)}`,
			);
		}
		markStateUnreadable(`canonical=${reason}; .bak=missing-or-corrupt`);
		readCache.clear();
		return emptyPersisted();
	}
}

/**
 * Atomically persist Full-Auto durable state.
 *
 * TASK 3 fix: persistence failures MUST propagate. The previous
 * implementation caught and logged write errors, which let
 * `startFullAutoRun` (and the `/swarm full-auto on` command) silently
 * report success even when nothing was written. Callers relied on the
 * durable record to fail-closed; that contract is now enforced.
 *
 * Behavior:
 *   - Writes via `tmp -> fsync -> rename`, so a crash mid-write cannot
 *     truncate the canonical file.
 *   - Keeps `.bak` of the prior canonical file as a recovery hint.
 *   - Reads the file back after the rename and confirms the JSON
 *     round-trips. Any failure throws.
 */
function writePersisted(
	directory: string,
	persisted: FullAutoPersistedState,
): void {
	let filePath: string;
	let tmpPath: string;
	let bakPath: string;
	let payload: string;
	try {
		ensureSwarmDir(directory);
		filePath = validateSwarmPath(directory, STATE_FILE);
		tmpPath = validateSwarmPath(directory, `${STATE_FILE}.tmp`);
		bakPath = validateSwarmPath(directory, `${STATE_FILE}.bak`);
		persisted.updatedAt = nowISO();
		payload = `${JSON.stringify(persisted, null, 2)}\n`;
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		logger.error(
			`[full-auto/state] Failed to prepare ${STATE_FILE} write: ${msg}`,
		);
		throw new Error(`Full-Auto state persistence prepare failed: ${msg}`);
	}
	// Best-effort backup; never block the primary write.
	try {
		if (fs.existsSync(filePath)) {
			fs.copyFileSync(filePath, bakPath);
		}
	} catch {
		// best-effort backup
	}
	try {
		fs.writeFileSync(tmpPath, payload, 'utf-8');
		// fsync the data so the rename below cannot leave us with an empty
		// canonical file on power-loss / kill -9.
		try {
			const fd = fs.openSync(tmpPath, 'r+');
			try {
				fs.fsyncSync(fd);
			} finally {
				fs.closeSync(fd);
			}
		} catch {
			// fsync is best-effort; OSes that don't support it shouldn't
			// block the main path.
		}
		fs.renameSync(tmpPath, filePath);
		// Invalidate the read cache — the next read re-stats and re-parses.
		readCache.delete(filePath);
		// Read back the canonical file to confirm the rename succeeded and
		// the payload round-trips. This is what makes the durable write
		// genuinely durable from the caller's perspective.
		const readback = fs.readFileSync(filePath, 'utf-8');
		const parsed = JSON.parse(readback) as Partial<FullAutoPersistedState>;
		if (parsed?.version !== 2) {
			throw new Error('Round-trip readback returned wrong version');
		}
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		logger.error(
			`[full-auto/state] Failed to persist ${STATE_FILE} atomically: ${msg}`,
		);
		throw new Error(`Full-Auto state persistence failed: ${msg}`);
	}
}

export function loadFullAutoRunState(
	directory: string,
	sessionID: string,
): FullAutoRunState | undefined {
	const persisted = readPersisted(directory);
	return persisted.sessions[sessionID];
}

export function saveFullAutoRunState(
	directory: string,
	state: FullAutoRunState,
): void {
	withStateLock(directory, () => {
		const persisted = readPersisted(directory);
		state.updatedAt = nowISO();
		persisted.sessions[state.sessionID] = state;
		writePersisted(directory, persisted);
	});
}

export function startFullAutoRun(
	directory: string,
	sessionID: string,
	config: FullAutoConfigShape | undefined,
	options: { planID?: string; phase?: number; taskID?: string } = {},
): FullAutoRunState {
	return withStateLock(directory, () => {
		const persisted = readPersisted(directory);
		const existing = persisted.sessions[sessionID];
		const mode = config?.mode ?? existing?.mode ?? 'supervised';
		const state: FullAutoRunState = existing
			? {
					...existing,
					status: 'running',
					mode,
					planID: options.planID ?? existing.planID,
					currentPhase: options.phase ?? existing.currentPhase,
					currentTaskID: options.taskID ?? existing.currentTaskID,
					pauseReason: undefined,
					terminateReason: undefined,
					updatedAt: nowISO(),
					denialCounters: {
						consecutive: 0,
						total: existing.denialCounters.total,
					},
				}
			: {
					...emptyState(sessionID, mode),
					status: 'running',
					planID: options.planID,
					currentPhase: options.phase,
					currentTaskID: options.taskID,
				};
		persisted.sessions[sessionID] = state;
		writePersisted(directory, persisted);
		return state;
	});
}

export function pauseFullAutoRun(
	directory: string,
	sessionID: string,
	reason: string,
): FullAutoRunState | undefined {
	return withStateLock(directory, () => {
		const persisted = readPersisted(directory);
		const state = persisted.sessions[sessionID];
		if (!state) return undefined;
		state.status = 'paused';
		state.pauseReason = reason;
		state.updatedAt = nowISO();
		persisted.sessions[sessionID] = state;
		writePersisted(directory, persisted);
		return state;
	});
}

/**
 * Disarm a Full-Auto run in response to an explicit user `off`.
 *
 * Unlike `pauseFullAutoRun` / `terminateFullAutoRun` (system-initiated halts
 * that fail-closed-block non-read-only tools until the user re-enables),
 * disarming returns the session to normal interactive operation: the record
 * transitions to `'idle'`, which every enforcement path treats as
 * "no active Full-Auto run". Counters and denial history are preserved for
 * audit. (Adversarial review F3: `off` must not be a one-way door into a
 * write-blocked session.)
 */
export function disarmFullAutoRun(
	directory: string,
	sessionID: string,
	reason: string,
): FullAutoRunState | undefined {
	return withStateLock(directory, () => {
		const persisted = readPersisted(directory);
		const state = persisted.sessions[sessionID];
		if (!state) return undefined;
		state.status = 'idle';
		state.pauseReason = reason;
		state.terminateReason = undefined;
		state.updatedAt = nowISO();
		persisted.sessions[sessionID] = state;
		writePersisted(directory, persisted);
		return state;
	});
}

export function terminateFullAutoRun(
	directory: string,
	sessionID: string,
	reason: string,
): FullAutoRunState | undefined {
	return withStateLock(directory, () => {
		const persisted = readPersisted(directory);
		const state = persisted.sessions[sessionID];
		if (!state) return undefined;
		state.status = 'terminated';
		state.terminateReason = reason;
		state.updatedAt = nowISO();
		persisted.sessions[sessionID] = state;
		writePersisted(directory, persisted);
		return state;
	});
}

export function isFullAutoRunActive(
	directory: string,
	sessionID: string,
): boolean {
	const state = loadFullAutoRunState(directory, sessionID);
	return state?.status === 'running';
}

export type FullAutoCounterKey = keyof FullAutoCounters;

export function incrementFullAutoCounter(
	directory: string,
	sessionID: string,
	counter: FullAutoCounterKey,
	delta = 1,
): FullAutoRunState | undefined {
	return withStateLock(directory, () => {
		const persisted = readPersisted(directory);
		const state = persisted.sessions[sessionID];
		if (!state) return undefined;
		state.counters[counter] = (state.counters[counter] ?? 0) + delta;
		state.updatedAt = nowISO();
		persisted.sessions[sessionID] = state;
		writePersisted(directory, persisted);
		return state;
	});
}

export function recordFullAutoDenial(
	directory: string,
	sessionID: string,
	denial: { tool?: string; code?: string; reason: string },
): FullAutoRunState | undefined {
	return withStateLock(directory, () => {
		const persisted = readPersisted(directory);
		const state = persisted.sessions[sessionID];
		if (!state) return undefined;
		state.denialCounters.consecutive += 1;
		state.denialCounters.total += 1;
		state.denialHistory.push({
			timestamp: nowISO(),
			tool: denial.tool,
			code: denial.code,
			reason: denial.reason,
		});
		if (state.denialHistory.length > MAX_DENIAL_HISTORY) {
			state.denialHistory.splice(
				0,
				state.denialHistory.length - MAX_DENIAL_HISTORY,
			);
		}
		state.updatedAt = nowISO();
		persisted.sessions[sessionID] = state;
		writePersisted(directory, persisted);
		return state;
	});
}

export function resetFullAutoDenials(
	directory: string,
	sessionID: string,
): FullAutoRunState | undefined {
	return withStateLock(directory, () => {
		const persisted = readPersisted(directory);
		const state = persisted.sessions[sessionID];
		if (!state) return undefined;
		state.denialCounters.consecutive = 0;
		state.updatedAt = nowISO();
		persisted.sessions[sessionID] = state;
		writePersisted(directory, persisted);
		return state;
	});
}

/**
 * Atomically increment and return the durable oversight-evidence sequence
 * counter. Used by `writeFullAutoOversightEvidence` to produce stable,
 * non-colliding evidence filenames across process restarts. (C4 fix.)
 */
export function nextFullAutoOversightSequence(directory: string): number {
	return withStateLock(directory, () => {
		const persisted = readPersisted(directory);
		const next = (persisted.oversightSequence ?? 0) + 1;
		persisted.oversightSequence = next;
		writePersisted(directory, persisted);
		return next;
	});
}

export function recordFullAutoOversight(
	directory: string,
	sessionID: string,
	verdict: string,
	reason: string,
): FullAutoRunState | undefined {
	return withStateLock(directory, () => {
		const persisted = readPersisted(directory);
		const state = persisted.sessions[sessionID];
		if (!state) return undefined;
		state.lastOversightAt = nowISO();
		state.lastOversightVerdict = verdict;
		state.lastOversightReason = reason;
		state.counters.oversightChecks += 1;
		state.updatedAt = nowISO();
		persisted.sessions[sessionID] = state;
		writePersisted(directory, persisted);
		return state;
	});
}

export interface DenialLimitDecision {
	pause: boolean;
	reason?: string;
	mode?: 'pause' | 'terminate';
}

export function shouldPauseForDenials(
	state: FullAutoRunState,
	config: FullAutoConfigShape | undefined,
): DenialLimitDecision {
	const denials = config?.denials ?? {};
	const maxConsecutive = denials.max_consecutive ?? 3;
	const maxTotal = denials.max_total ?? 20;
	const onLimit = denials.on_limit ?? 'pause';
	if (state.denialCounters.consecutive >= maxConsecutive) {
		return {
			pause: true,
			reason: `denial-limit:consecutive>=${maxConsecutive}`,
			mode: onLimit,
		};
	}
	if (state.denialCounters.total >= maxTotal) {
		return {
			pause: true,
			reason: `denial-limit:total>=${maxTotal}`,
			mode: onLimit,
		};
	}
	return { pause: false };
}

/**
 * Test-only DI seam — same rationale as `src/state.ts:_internals`.
 */
export const _internals: {
	readPersisted: typeof readPersisted;
	writePersisted: typeof writePersisted;
} = { readPersisted, writePersisted };
