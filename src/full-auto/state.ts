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
import { compositeSessionKey } from '../utils/canonical-root.js';
import * as logger from '../utils/logger';

// proper-lockfile ships JS-only with no TS types; cast to a minimal interface
// covering the `lockSync` API we use. The synchronous adapter rejects positive
// retry options (ESYNC), so retries are owned by this module below.
type StateLockFile = {
	lockSync: (
		file: string,
		options?: {
			stale?: number;
			realpath?: boolean;
		},
	) => () => void;
};
const lockfile = lockfileImport as unknown as StateLockFile;

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
	consecutiveOversightFailures: number;
}

export interface FullAutoRunState {
	status: FullAutoStatus;
	sessionID: string;
	mode: 'assisted' | 'supervised' | 'strict';
	runGeneration?: number;
	pauseGeneration?: number;
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
	/** Consecutive oversight dispatch failures for auto-degrade. */
	consecutiveOversightFailures?: number;
	/**
	 * Issue #1781 E2: the most recent oversight-escalation detail, persisted so
	 * `/swarm status` can surface the reason + interaction/deadlock counts +
	 * phase without parsing the human-readable `.swarm/escalation-report.md`.
	 * Updated atomically by `recordFullAutoEscalation` at escalation time.
	 */
	lastEscalation?: {
		reason: string;
		interactionCount: number;
		deadlockCount: number;
		phase?: number;
		escalatedAt: string;
	};
	lastRecoveryProbe?: {
		pauseGeneration: number;
		checkedAt: string;
		expiresAt: string;
		attempts: number;
		outcome: 'healthy' | 'unhealthy';
		reason: string;
	};
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
const STATE_LOCK_STALE_MS = 5000;
// Keep caller-owned synchronous retries short. This path runs on the host's
// main thread; long backoffs starve timers while another process owns the lock.
const STATE_LOCK_RETRY_DELAYS_MS = [25, 50, 75, 100] as const;
const stateLockSleepScratch = new Int32Array(new SharedArrayBuffer(4));
const MAX_LOCK_FAILURE_OVERRIDES = 128;
const LOCK_FAILURE_OVERRIDE_TTL_MS = 60_000;
const lockFailureOverrides = new Map<
	string,
	{ expiresAt: number; reason: string }
>();

export type FullAutoStateLockErrorCategory =
	| 'contention'
	| 'configuration'
	| 'storage';

/**
 * Typed failure for acquiring or releasing the Full-Auto state lock.
 *
 * The callback is never invoked for these failures. Persistence errors thrown
 * by the callback retain their existing error shape so callers can distinguish
 * lock failures from read/write failures.
 */
export class FullAutoStateLockError extends Error {
	readonly category: FullAutoStateLockErrorCategory;
	readonly cause: unknown;
	readonly code: `FULL_AUTO_STATE_LOCK_${Uppercase<FullAutoStateLockErrorCategory>}`;

	constructor(
		category: FullAutoStateLockErrorCategory,
		message: string,
		cause?: unknown,
	) {
		super(message);
		this.name = 'FullAutoStateLockError';
		this.category = category;
		this.code =
			`FULL_AUTO_STATE_LOCK_${category.toUpperCase()}` as FullAutoStateLockError['code'];
		this.cause = cause;
	}
}

export function isFullAutoStateLockError(
	error: unknown,
): error is FullAutoStateLockError {
	return error instanceof FullAutoStateLockError;
}

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
		consecutiveOversightFailures: 0,
	};
}

const VALID_RUN_MODES = new Set<string>(['assisted', 'supervised', 'strict']);
const VALID_RUN_STATUSES = new Set<string>([
	'idle',
	'running',
	'paused',
	'terminated',
]);

/**
 * Sanitize a raw FullAutoRunState loaded from disk. Coerces unrecognised
 * `mode` and `status` values to safe defaults so a hand-edited state file
 * cannot inject an unknown mode into the permission classifier.
 *
 * Returns `null` if the input is not a usable run-state shape (missing
 * `sessionID` or wrong type) so callers can drop the entry rather than
 * silently materialising an invalid state record.
 */
function sanitizeRunState(raw: unknown): FullAutoRunState | null {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
	const r = raw as Record<string, unknown>;
	if (typeof r.sessionID !== 'string' || !r.sessionID) return null;
	const mode: FullAutoRunState['mode'] = VALID_RUN_MODES.has(r.mode as string)
		? (r.mode as FullAutoRunState['mode'])
		: 'supervised';
	const status: FullAutoStatus = VALID_RUN_STATUSES.has(r.status as string)
		? (r.status as FullAutoStatus)
		: 'idle';
	return { ...(raw as FullAutoRunState), mode, status };
}

function sanitizeSessions(
	raw: Record<string, unknown>,
): Record<string, FullAutoRunState> {
	const result: Record<string, FullAutoRunState> = {};
	for (const [id, session] of Object.entries(raw)) {
		const sanitized = sanitizeRunState(session);
		if (sanitized) result[id] = sanitized;
	}
	return result;
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
		runGeneration: 1,
		pauseGeneration: 0,
		startedAt: now,
		updatedAt: now,
		denialCounters: { consecutive: 0, total: 0 },
		denialHistory: [],
		counters: emptyCounters(),
	};
}

/** Bounded synchronous sleep for the caller-owned contention retry loop. */
function syncSleep(ms: number): void {
	try {
		Atomics.wait(stateLockSleepScratch, 0, 0, ms);
	} catch {
		const startedAt = Date.now();
		while (Date.now() - startedAt < ms) {
			// Bounded portability fallback for runtimes that reject Atomics.wait.
		}
	}
}

function errorCode(error: unknown): string | undefined {
	return typeof error === 'object' && error !== null && 'code' in error
		? String((error as { code?: unknown }).code)
		: undefined;
}

function makeLockError(
	category: FullAutoStateLockErrorCategory,
	message: string,
	cause?: unknown,
): FullAutoStateLockError {
	const code = errorCode(cause);
	// Do not echo storage/library details into tool-visible errors: they may
	// contain absolute paths or other host-specific information. Preserve the
	// typed cause for diagnostics, but expose only the stable code.
	const suffix = code ? ` (${code})` : '';
	return new FullAutoStateLockError(category, `${message}${suffix}`, cause);
}

function lockFailureKey(directory: string, sessionID: string): string {
	return compositeSessionKey(directory, sessionID);
}

function pruneLockFailureOverrides(now = Date.now()): void {
	for (const [key, value] of lockFailureOverrides) {
		if (value.expiresAt <= now) lockFailureOverrides.delete(key);
	}
	while (lockFailureOverrides.size > MAX_LOCK_FAILURE_OVERRIDES) {
		const oldest = lockFailureOverrides.keys().next().value;
		if (typeof oldest !== 'string') break;
		lockFailureOverrides.delete(oldest);
	}
}

/** Mark a session paused in-process when an observer cannot acquire state. */
export function markFullAutoStateLockFailure(
	directory: string,
	sessionID: string,
	reason = 'durable state lock unavailable',
): void {
	pruneLockFailureOverrides();
	const key = lockFailureKey(directory, sessionID);
	lockFailureOverrides.delete(key);
	lockFailureOverrides.set(key, {
		expiresAt: Date.now() + LOCK_FAILURE_OVERRIDE_TTL_MS,
		reason,
	});
	pruneLockFailureOverrides();
}

function clearFullAutoStateLockFailure(
	directory: string,
	sessionID: string,
): void {
	lockFailureOverrides.delete(lockFailureKey(directory, sessionID));
}

function acquireStateLock(lockTarget: string): () => void {
	let lastError: unknown;
	for (
		let attempt = 0;
		attempt <= STATE_LOCK_RETRY_DELAYS_MS.length;
		attempt += 1
	) {
		try {
			const release = _internals.lockfile.lockSync(lockTarget, {
				stale: STATE_LOCK_STALE_MS,
				realpath: false,
			});
			if (typeof release !== 'function') {
				throw makeLockError(
					'storage',
					'Full-Auto state lock returned an invalid release handle',
					release,
				);
			}
			return release;
		} catch (error) {
			lastError = error;
			if (errorCode(error) === 'ESYNC') {
				throw makeLockError(
					'configuration',
					'Full-Auto state lock configuration is unsupported',
					error,
				);
			}
			if (errorCode(error) !== 'ELOCKED') {
				throw makeLockError(
					'storage',
					'Full-Auto state lock acquisition failed',
					error,
				);
			}
			if (attempt < STATE_LOCK_RETRY_DELAYS_MS.length) {
				syncSleep(STATE_LOCK_RETRY_DELAYS_MS[attempt]);
			}
		}
	}
	throw makeLockError(
		'contention',
		'Full-Auto state lock contention after bounded retries',
		lastError,
	);
}

/**
 * Cross-process lock around the complete read-modify-write cycle on
 * `.swarm/full-auto-state.json`. Bun/Node within a single process is
 * single-threaded, so intra-process RMW is already safe; the lock guards
 * against two processes (e.g. an OpenCode plugin and a CLI invocation)
 * touching the same project root concurrently. Lock failures are surfaced as
 * typed non-successes; no update is ever run unlocked.
 */
function withStateLock<T>(directory: string, fn: () => T): T {
	let release: (() => void) | undefined;
	try {
		ensureSwarmDir(directory);
		const lockTarget = validateSwarmPath(directory, STATE_FILE);
		release = acquireStateLock(lockTarget);
	} catch (error) {
		const lockError =
			error instanceof FullAutoStateLockError
				? error
				: makeLockError('storage', 'Full-Auto state lock setup failed', error);
		logger.warn(`[full-auto/state] ${lockError.message}`);
		throw lockError;
	}
	let callbackFailed = false;
	let callbackError: unknown;
	let result!: T;
	try {
		result = fn();
	} catch (error) {
		callbackFailed = true;
		callbackError = error;
	}
	let releaseError: FullAutoStateLockError | undefined;
	if (release) {
		try {
			release();
		} catch (error) {
			releaseError = makeLockError(
				'storage',
				'Full-Auto state lock release failed',
				error,
			);
		}
	}
	if (callbackFailed) {
		if (releaseError) logger.warn(`[full-auto/state] ${releaseError.message}`);
		throw callbackError;
	}
	if (releaseError) throw releaseError;
	return result;
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
 * mtime+size-keyed read cache. The always-armed full-auto v2 hooks (or the
 * per-tool `readPersisted` call from any consumer when a run is active) pay
 * for a full read+parse on the hot path forever without it; once a state
 * file exists, caching by `mtimeMs + size` reduces each subsequent read to
 * a single `fs.statSync`. The cache returns a `structuredClone` of the parsed
 * state when the file's mtimeMs+size are unchanged — cloning keeps caller
 * mutations (which are always followed by `writePersisted` under the state
 * lock) from poisoning the cache. Locked read-modify-write callbacks use
 * `readPersistedForMutation`, which bypasses this cache so an external writer
 * that preserves both metadata fields cannot be overwritten from a stale
 * snapshot. Unlocked observational reads retain the inexpensive cache path.
 */
const readCache = new Map<
	string,
	{ mtimeMs: number; size: number; state: FullAutoPersistedState }
>();

interface ReadPersistedOptions {
	bypassCache?: boolean;
}

function readPersisted(
	directory: string,
	options: ReadPersistedOptions = {},
): FullAutoPersistedState {
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
			!options.bypassCache &&
			cached &&
			cached.mtimeMs === stats.mtimeMs &&
			cached.size === stats.size
		) {
			clearStateUnreadable();
			// structuredClone is a Node.js 17+ global API. The project requires
			// bun >=1.3.13 (Node 20+ runtime), so no fallback is needed.
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
			sessions: sanitizeSessions(parsed.sessions as Record<string, unknown>),
		};
		readCache.set(filePath, {
			mtimeMs: stats.mtimeMs,
			size: stats.size,
			// structuredClone is a Node.js 17+ global API. The project requires
			// bun >=1.3.13 (Node 20+ runtime), so no fallback is needed.
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
						sessions: sanitizeSessions(
							parsed.sessions as Record<string, unknown>,
						),
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

/** Always read the canonical file for a locked read-modify-write operation. */
function readPersistedForMutation(directory: string): FullAutoPersistedState {
	return readPersisted(directory, { bypassCache: true });
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
		throw new Error('Full-Auto state persistence prepare failed');
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
		throw new Error('Full-Auto state persistence failed');
	}
}

export function loadFullAutoRunState(
	directory: string,
	sessionID: string,
): FullAutoRunState | undefined {
	pruneLockFailureOverrides();
	const override = lockFailureOverrides.get(
		lockFailureKey(directory, sessionID),
	);
	const persisted = readPersisted(directory);
	const state = persisted.sessions[sessionID];
	if (!override || !state) return state;
	return { ...state, status: 'paused', pauseReason: override.reason };
}

export function saveFullAutoRunState(
	directory: string,
	state: FullAutoRunState,
): void {
	withStateLock(directory, () => {
		const persisted = _internals.readPersisted(directory);
		state.updatedAt = nowISO();
		persisted.sessions[state.sessionID] = state;
		writePersisted(directory, persisted);
		clearFullAutoStateLockFailure(directory, state.sessionID);
	});
}

export function startFullAutoRun(
	directory: string,
	sessionID: string,
	config: FullAutoConfigShape | undefined,
	options: { planID?: string; phase?: number; taskID?: string } = {},
): FullAutoRunState {
	return withStateLock(directory, () => {
		const persisted = _internals.readPersisted(directory);
		const existing = persisted.sessions[sessionID];
		const mode = config?.mode ?? existing?.mode ?? 'supervised';
		const state: FullAutoRunState = existing
			? {
					...existing,
					status: 'running',
					mode,
					runGeneration: (existing.runGeneration ?? 0) + 1,
					planID: options.planID ?? existing.planID,
					currentPhase: options.phase ?? existing.currentPhase,
					currentTaskID: options.taskID ?? existing.currentTaskID,
					pauseReason: undefined,
					terminateReason: undefined,
					lastRecoveryProbe: undefined,
					updatedAt: nowISO(),
					denialCounters: {
						consecutive: 0,
						total: existing.denialCounters.total,
					},
					consecutiveOversightFailures: 0,
					counters: {
						...existing.counters,
						consecutiveOversightFailures: 0,
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
		clearFullAutoStateLockFailure(directory, sessionID);
		return state;
	});
}

export function pauseFullAutoRun(
	directory: string,
	sessionID: string,
	reason: string,
): FullAutoRunState | undefined {
	return withStateLock(directory, () => {
		const persisted = _internals.readPersisted(directory);
		const state = persisted.sessions[sessionID];
		if (!state) return undefined;
		state.status = 'paused';
		state.pauseReason = reason;
		state.pauseGeneration = (state.pauseGeneration ?? 0) + 1;
		state.updatedAt = nowISO();
		persisted.sessions[sessionID] = state;
		writePersisted(directory, persisted);
		clearFullAutoStateLockFailure(directory, sessionID);
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
		const persisted = _internals.readPersisted(directory);
		const state = persisted.sessions[sessionID];
		if (!state) return undefined;
		state.status = 'idle';
		state.pauseReason = reason;
		state.terminateReason = undefined;
		state.lastRecoveryProbe = undefined;
		state.updatedAt = nowISO();
		persisted.sessions[sessionID] = state;
		writePersisted(directory, persisted);
		clearFullAutoStateLockFailure(directory, sessionID);
		return state;
	});
}

export function terminateFullAutoRun(
	directory: string,
	sessionID: string,
	reason: string,
): FullAutoRunState | undefined {
	return withStateLock(directory, () => {
		const persisted = _internals.readPersisted(directory);
		const state = persisted.sessions[sessionID];
		if (!state) return undefined;
		state.status = 'terminated';
		state.terminateReason = reason;
		state.pauseGeneration = (state.pauseGeneration ?? 0) + 1;
		state.lastRecoveryProbe = undefined;
		state.updatedAt = nowISO();
		persisted.sessions[sessionID] = state;
		writePersisted(directory, persisted);
		clearFullAutoStateLockFailure(directory, sessionID);
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
		const persisted = _internals.readPersisted(directory);
		const state = persisted.sessions[sessionID];
		if (!state) return undefined;
		state.counters[counter] = (state.counters[counter] ?? 0) + delta;
		state.updatedAt = nowISO();
		persisted.sessions[sessionID] = state;
		writePersisted(directory, persisted);
		return state;
	});
}

/**
 * Record a subagent return and, for an accepted severe envelope, pause the
 * run in the same locked read-modify-write. This prevents a successful
 * counter write from being separated from the safety pause by a second lock
 * acquisition.
 */
export function recordFullAutoSubagentOutcome(
	directory: string,
	sessionID: string,
	options: { severe: boolean; pauseReason?: string },
): FullAutoRunState | undefined {
	return withStateLock(directory, () => {
		const persisted = _internals.readPersisted(directory);
		const state = persisted.sessions[sessionID];
		if (!state) return undefined;
		if (options.severe) {
			state.counters.consecutiveNoProgressTurns =
				(state.counters.consecutiveNoProgressTurns ?? 0) + 1;
			if (state.status === 'running') {
				state.status = 'paused';
				state.pauseReason =
					options.pauseReason ?? 'severe subagent return envelope';
				state.pauseGeneration = (state.pauseGeneration ?? 0) + 1;
			}
		}
		state.updatedAt = nowISO();
		persisted.sessions[sessionID] = state;
		writePersisted(directory, persisted);
		return state;
	});
}

/**
 * Increment the consecutive-oversight-failure counter.
 * Returns the new value after incrementing.
 */
export function incrementOversightFailureCounter(
	directory: string,
	sessionID: string,
): number {
	let result = 0;
	withStateLock(directory, () => {
		const persisted = _internals.readPersisted(directory);
		const state = persisted.sessions[sessionID];
		if (!state) return;
		state.counters.consecutiveOversightFailures =
			(state.counters.consecutiveOversightFailures ?? 0) + 1;
		// Also record it in the top-level field for quick access
		state.consecutiveOversightFailures =
			state.counters.consecutiveOversightFailures;
		state.updatedAt = nowISO();
		persisted.sessions[sessionID] = state;
		writePersisted(directory, persisted);
		result = state.counters.consecutiveOversightFailures;
	});
	return result;
}

/**
 * Reset the consecutive-oversight-failure counter to 0.
 */
export function resetOversightFailureCounter(
	directory: string,
	sessionID: string,
): void {
	withStateLock(directory, () => {
		const persisted = _internals.readPersisted(directory);
		const state = persisted.sessions[sessionID];
		if (!state) return;
		state.counters.consecutiveOversightFailures = 0;
		state.consecutiveOversightFailures = 0;
		state.updatedAt = nowISO();
		persisted.sessions[sessionID] = state;
		writePersisted(directory, persisted);
	});
}

export function recordFullAutoDenial(
	directory: string,
	sessionID: string,
	denial: { tool?: string; code?: string; reason: string },
): FullAutoRunState | undefined {
	return withStateLock(directory, () => {
		const persisted = _internals.readPersisted(directory);
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
		const persisted = _internals.readPersisted(directory);
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
		const persisted = _internals.readPersisted(directory);
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
		const persisted = _internals.readPersisted(directory);
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

/**
 * Issue #1781 E2: persist the most recent oversight-escalation detail
 * (reason, interaction/deadlock counts, phase) to the durable run state so
 * `/swarm status` can surface it. Called from `handleEscalation` in
 * `src/hooks/full-auto-intercept.ts` alongside the existing pause/terminate
 * state writes — those writes spread `...state`, so this field survives them.
 */
export function recordFullAutoEscalation(
	directory: string,
	sessionID: string,
	detail: {
		reason: string;
		interactionCount: number;
		deadlockCount: number;
		phase?: number;
	},
): FullAutoRunState | undefined {
	return withStateLock(directory, () => {
		const persisted = _internals.readPersisted(directory);
		const state = persisted.sessions[sessionID];
		if (!state) return undefined;
		state.lastEscalation = {
			reason: detail.reason,
			interactionCount: detail.interactionCount,
			deadlockCount: detail.deadlockCount,
			phase: detail.phase,
			escalatedAt: nowISO(),
		};
		state.updatedAt = nowISO();
		persisted.sessions[sessionID] = state;
		writePersisted(directory, persisted);
		return state;
	});
}

export function recordFullAutoRecoveryProbe(
	directory: string,
	sessionID: string,
	probe: {
		pauseGeneration: number;
		checkedAt: string;
		expiresAt: string;
		attempts: number;
		outcome: 'healthy' | 'unhealthy';
		reason: string;
	},
): FullAutoRunState | undefined {
	return withStateLock(directory, () => {
		const persisted = _internals.readPersisted(directory);
		const state = persisted.sessions[sessionID];
		if (!state) return undefined;
		state.lastRecoveryProbe = probe;
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
	readPersisted: typeof readPersistedForMutation;
	writePersisted: typeof writePersisted;
	lockfile: StateLockFile;
} = { readPersisted: readPersistedForMutation, writePersisted, lockfile };
