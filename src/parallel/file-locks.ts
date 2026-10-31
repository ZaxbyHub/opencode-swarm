import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import lockfile from 'proper-lockfile';
import { emit } from '../telemetry.js';

const LOCKS_DIR = '.swarm/locks';
/** Lock TTL. Exported for the doctor's read-only `--integrity` report
 *  (issue #2969), which classifies `.lck` artifacts against the same TTL
 *  the acquire/cleanup paths use — never a second, drifting constant. */
export const LOCK_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
/** #2967: a break marker whose recorded breaker pid is provably dead AND
 *  whose age exceeds this bound is takeable by a new breaker. A LIVE breaker
 *  blocks takeover and acquisition indefinitely — no age converts a live
 *  pid into a dead classification (plan 05 v8, critic rounds 5-8). */
const MARKER_STALE_MS = 60 * 1000;
/** Cooldown window for liveness break attempts per lock target. */
const MAX_TRACKED_BREAK_TARGETS = 256;

/**
 * Test-only dependency-injection seam. Tests replace members on this object
 * so they can inject behaviour without `mock.module` (which leaks across
 * files in Bun's shared test-runner process). Production code calls through
 * the `kill`/`now` members of this seam for liveness and clock reads so
 * tests can make both deterministic; the fs surface stays real.
 */
export const _internals: {
	tryAcquireLock: typeof tryAcquireLock;
	writeFile: typeof fs.promises.writeFile;
	kill: (pid: number, signal?: number | string) => void;
	now: () => number;
} = {
	tryAcquireLock,
	writeFile: fs.promises.writeFile,
	kill: (pid, signal) => process.kill(pid, signal),
	now: () => Date.now(),
};

/** Owner identity + payload stored INSIDE the wx lock file (#2967). The
 *  payload's lifetime IS the lock's lifetime: releasing or breaking the lock
 *  removes the file and therefore the record — no stale sidecar can ever
 *  outlive the generation it describes (critic rounds 1-4). */
export interface OwnerLockPayload {
	v: 1;
	nonce: string;
	ownerPid: number;
	/** Approximate process-start wall clock: Date.now() - uptime*1000. Used
	 *  ONLY as part of the identity triple matched at release — no time
	 *  window ever converts a live pid into a dead classification. */
	startBoundMs: number;
	agent: string;
	taskId: string;
	acquiredAtMs: number;
}

export interface LockMetadata {
	originalPath: string; // Normalized original file path
	laneId: string; // Lane ID (e.g., "lane-1")
	taskId: string; // Task ID (e.g., "4.1")
	agent: string; // Agent name
	sessionID: string; // Session ID
	acquiredAt: string; // ISO timestamp
	expiresAt: number; // Unix timestamp (ms)
	ownerPid: number; // #2967: lane-sidecar owner identity
	startBoundMs: number; // #2967: lane-sidecar identity fence input
}

export interface FileLock {
	filePath: string;
	agent: string;
	taskId: string;
	timestamp: string;
	expiresAt: number;
	laneId?: string; // Optional: present when acquired via acquireLaneLocks
	_release?: () => Promise<void>;
}

/** Liveness probe: ESRCH => provably dead; anything else (success, EPERM)
 *  => alive. PID reuse therefore reads ALIVE and fails safe to TTL-only
 *  degradation — a live pid is never broken, paused or not. */
function isPidAlive(pid: number): boolean {
	if (!Number.isSafeInteger(pid) || pid <= 0) return false;
	try {
		_internals.kill(pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code !== 'ESRCH';
	}
}

function processStartBoundMs(): number {
	return Date.now() - Math.floor(process.uptime() * 1000);
}

function newNonce(): string {
	return crypto.randomBytes(8).toString('hex');
}

// ---------------------------------------------------------------------------
// Lock artifact paths
// ---------------------------------------------------------------------------

function normalizedTarget(directory: string, filePath: string): string {
	const normalized = path.resolve(directory, filePath);
	const baseDir = path.resolve(directory) + path.sep;
	const pathOk =
		process.platform === 'win32'
			? normalized.toLowerCase().startsWith(baseDir.toLowerCase())
			: normalized.startsWith(baseDir);
	if (!pathOk) {
		throw new Error('Invalid file path: path traversal not allowed');
	}
	return normalized;
}

/** Stable NEW lock artifact path (`<sha256>.lck`), computed independently of
 *  the legacy alias state so a target's new-lock identity can never switch
 *  (plan 05 v8 §1.1; critic r4-#5). Exported: contention callers (the
 *  evidence lock wrapper, doctor) derive the same artifact path the acquire
 *  path uses. */
export function getOwnerLockPath(directory: string, filePath: string): string {
	const normalized = normalizedTarget(directory, filePath);
	const pathForHash =
		process.platform === 'win32' ? normalized.toLowerCase() : normalized;
	const hash = crypto.createHash('sha256').update(pathForHash).digest('hex');
	return path.join(directory, LOCKS_DIR, `${hash}.lck`);
}

function markerPathFor(ownerLockPath: string): string {
	return `${ownerLockPath}.breaking`;
}

/** #2967: `processStartBoundMs()` = `Date.now() - floor(uptime*1000)` is a
 *  RE-SAMPLED approximation — two samples a few hundred ms apart legitimately
 *  differ by ±1-2 ms (ms clock ticks vs truncated uptime). The lane
 *  self-release fence compares a stored meta.startBoundMs against a freshly
 *  recomputed one, so exact equality intermittently misclassifies OUR OWN
 *  generation as foreign and leaks the `.lck` until the TTL. The fence's
 *  purpose is second-scale discrimination (our incarnation vs a recycled-pid
 *  foreign process, which starts seconds+ apart), so a small tolerance keeps
 *  the fence exact where it matters while immune to quantization drift. The
 *  identity-fence release itself (releaseOwnerLock) compares the file payload
 *  against the acquire-time triple — byte-stable, no drift exposure. */
const START_BOUND_TOLERANCE_MS = 5;

/** Legacy sentinel path resolution (pre-#2967 substrate). Kept byte-identical
 *  for the legacy probe and cleanup; new code never creates these. */
function getLockFilePath(directory: string, filePath: string): string {
	const normalized = normalizedTarget(directory, filePath);
	const pathForHash =
		process.platform === 'win32' ? normalized.toLowerCase() : normalized;
	const hash = crypto.createHash('sha256').update(pathForHash).digest('hex');
	const lockPath = path.join(directory, LOCKS_DIR, `${hash}.lock`);
	const legacyPaths = [pathForHash];
	if (process.platform === 'win32' && normalized !== pathForHash) {
		legacyPaths.push(normalized);
	}
	for (const legacyPath of legacyPaths) {
		const oldHash = Buffer.from(legacyPath)
			.toString('base64')
			.replace(/[/+=]/g, '_');
		const oldLockPath = path.join(directory, LOCKS_DIR, `${oldHash}.lock`);
		if (fs.existsSync(oldLockPath)) {
			return oldLockPath;
		}
	}
	return lockPath;
}

/** All legacy sentinel paths that exist for a target (both alias forms). */
function existingLegacySentinels(
	directory: string,
	filePath: string,
): string[] {
	const normalized = normalizedTarget(directory, filePath);
	const pathForHash =
		process.platform === 'win32' ? normalized.toLowerCase() : normalized;
	const candidates = [
		crypto.createHash('sha256').update(pathForHash).digest('hex'),
	];
	if (process.platform === 'win32' && normalized !== pathForHash) {
		candidates.push(
			Buffer.from(normalized).toString('base64').replace(/[/+=]/g, '_'),
		);
	} else {
		candidates.push(
			Buffer.from(pathForHash).toString('base64').replace(/[/+=]/g, '_'),
		);
	}
	const found: string[] = [];
	for (const c of candidates) {
		const p = path.join(directory, LOCKS_DIR, `${c}.lock`);
		if (fs.existsSync(p) && !found.includes(p)) found.push(p);
	}
	return found;
}

/**
 * Get the path for the sidecar metadata file corresponding to a lock file
 * (handles both the legacy `.lock` and new `.lck` extensions).
 */
function getMetaPath(lockPath: string): string {
	return `${lockPath.replace(/\.(lock|lck)$/, '')}.meta`;
}

// ---------------------------------------------------------------------------
// Owner-lock payload I/O
// ---------------------------------------------------------------------------

/** Raw payload reader for contention callers (class selection). */
export function readOwnerLockPayload(ownerLockPath: string): string | null {
	return readOwnerPayload(ownerLockPath);
}

function readOwnerPayload(ownerLockPath: string): string | null {
	try {
		return fs.readFileSync(ownerLockPath, 'utf-8');
	} catch {
		return null;
	}
}

function parseOwnerPayload(raw: string | null): OwnerLockPayload | null {
	if (raw === null || raw.length === 0) return null;
	try {
		const parsed = JSON.parse(raw) as OwnerLockPayload;
		if (parsed?.v !== 1 || !Number.isSafeInteger(parsed.ownerPid)) {
			return null;
		}
		return parsed;
	} catch {
		return null;
	}
}

interface MarkerPayload {
	v: 1;
	breakerPid: number;
	nonce: string;
	createdAtMs: number;
}

function readMarker(markerPath: string): MarkerPayload | null {
	try {
		const parsed = JSON.parse(
			fs.readFileSync(markerPath, 'utf-8'),
		) as MarkerPayload;
		if (parsed?.v !== 1 || !Number.isSafeInteger(parsed.breakerPid)) {
			return null;
		}
		return parsed;
	} catch {
		return null;
	}
}

/** The acquire-side marker test: a marker blocks acquisition ONLY while its
 *  recorded breaker is ALIVE — unconditionally, regardless of marker age.
 *  A dead breaker's stale marker is the fenced breaker's business, not a
 *  barrier (plan 05 v8 §1.0 step 1, identical rule to the takeover gate). */
function markerBlocksAcquisition(markerPath: string): boolean {
	const marker = readMarker(markerPath);
	if (marker === null) {
		// Unparsable marker: treat as a live unknown breaker (fail-safe —
		// the fenced breaker's takeover gate will age it out safely).
		return true;
	}
	return isPidAlive(marker.breakerPid);
}

export interface AcquireOwnerLockResult {
	acquired: boolean;
	release: () => void;
	payload: OwnerLockPayload | null;
}

/** ONE attempt of the two-phase owner-lock acquire (sync, pure fs ops).
 *  Returns the identity-fenced release when acquired. Exported for the
 *  events store's synchronous lock loop (`attempts: 1` policy — its outer
 *  bounded retry IS the retry, keeping live-owner fail-fast ~100 ms). */
export function acquireOwnerLockOnce(
	ownerLockPath: string,
	agent: string,
	taskId: string,
): AcquireOwnerLockResult {
	const markerPath = markerPathFor(ownerLockPath);
	// Phase 1: a live breaker's marker blocks us.
	if (fs.existsSync(markerPath) && markerBlocksAcquisition(markerPath)) {
		return { acquired: false, release: () => {}, payload: null };
	}
	// Phase 2: exclusive create. EEXIST = held.
	let fd: number;
	try {
		fd = fs.openSync(ownerLockPath, 'wx');
	} catch {
		return { acquired: false, release: () => {}, payload: null };
	}
	const payload: OwnerLockPayload = {
		v: 1,
		nonce: newNonce(),
		ownerPid: process.pid,
		startBoundMs: processStartBoundMs(),
		agent,
		taskId,
		acquiredAtMs: Date.now(),
	};
	try {
		fs.writeSync(fd, JSON.stringify(payload), 0, 'utf-8');
	} catch {
		try {
			fs.closeSync(fd);
		} catch {
			/* ignore */
		}
		try {
			fs.unlinkSync(ownerLockPath);
		} catch {
			/* ignore */
		}
		return { acquired: false, release: () => {}, payload: null };
	}
	try {
		fs.closeSync(fd);
	} catch {
		/* ignore */
	}
	// Phase 3: marker re-check. A breaker that appeared between phases 1
	// and 2 wins — self-release and retry after it finishes.
	if (fs.existsSync(markerPath) && markerBlocksAcquisition(markerPath)) {
		try {
			fs.unlinkSync(ownerLockPath);
		} catch {
			/* ignore */
		}
		return { acquired: false, release: () => {}, payload: null };
	}
	return {
		acquired: true,
		payload,
		release: () => releaseOwnerLock(ownerLockPath, payload),
	};
}

/** Identity-fenced release: unlinks the lock ONLY if its current payload
 *  still names OUR identity triple. A successor's lock (installed after a
 *  legitimate break of a provably-dead us) can never be deleted by our
 *  late release. Exported for the events store's finally-unlink. */
export function releaseOwnerLock(
	ownerLockPath: string,
	self: { ownerPid: number; startBoundMs: number; nonce: string },
): void {
	const current = parseOwnerPayload(readOwnerPayload(ownerLockPath));
	if (
		current === null ||
		current.ownerPid !== self.ownerPid ||
		current.startBoundMs !== self.startBoundMs ||
		current.nonce !== self.nonce
	) {
		return;
	}
	try {
		fs.unlinkSync(ownerLockPath);
	} catch {
		/* already gone */
	}
}

// ---------------------------------------------------------------------------
// Fenced liveness break (plan 05 v8 §1.2)
// ---------------------------------------------------------------------------

/** Cooldown map: at most one break ATTEMPT per target per LOCK_TIMEOUT_MS.
 *  Target-keyed, FIFO-evicted, bounded (invariant 8). */
const breakAttemptAt = new Map<string, number>();
const breakAttemptOrder: string[] = [];

function cooldownAllows(ownerLockPath: string, now: number): boolean {
	const last = breakAttemptAt.get(ownerLockPath);
	return last === undefined || now - last >= LOCK_TIMEOUT_MS;
}

function recordBreakAttempt(ownerLockPath: string, now: number): void {
	if (!breakAttemptAt.has(ownerLockPath)) {
		breakAttemptOrder.push(ownerLockPath);
		if (breakAttemptOrder.length > MAX_TRACKED_BREAK_TARGETS) {
			const evicted = breakAttemptOrder.shift();
			if (evicted !== undefined) breakAttemptAt.delete(evicted);
		}
	}
	breakAttemptAt.set(ownerLockPath, now);
}

export type StaleLockBreakResult = 'broken' | 'live' | 'unknown';

export interface StaleLockBreakOptions {
	/** Abort when the remaining deadline (ms from now) would be exceeded. */
	deadlineMs?: number;
	/** 'dead-owner' requires a parsable payload; 'ttl-cleanup' accepts an
	 *  unparsable/ownerless lock past its mtime TTL (AC4's TTL-only legacy
	 *  semantics, routed through the same serialized protocol). */
	class: 'dead-owner' | 'ttl-cleanup';
	/** Telemetry discriminator for the one bounded event. */
	store: 'evidence' | 'events';
}

function removeOwnMarker(markerPath: string, nonce: string): void {
	const marker = readMarker(markerPath);
	if (marker !== null && marker.nonce === nonce) {
		try {
			fs.unlinkSync(markerPath);
		} catch {
			/* ignore */
		}
	}
}

/** Fenced liveness break. Callers: withEvidenceLock (first contention) and
 *  the events-store lock loop. Every property below is load-bearing and was
 *  adversarially derived across eight plan-critic rounds — see the trace's
 *  06-critic-review.md before changing anything:
 *  - cooldown pre-marks BEFORE any mutation;
 *  - a LIVE pid is NEVER broken — no time window exists that says otherwise;
 *  - marker takeover = atomic rename AND (age > MARKER_STALE_MS) AND the
 *    recorded breaker provably dead — a live breaker blocks indefinitely;
 *  - the lock payload is re-read for byte-identity between takeover and
 *    unlink, so a successor that arrived mid-protocol aborts the break;
 *  - all failures fail closed to 'unknown' (legacy TTL-only behaviour). */
export function breakStaleLockIfOwnerDead(
	ownerLockPath: string,
	opts: StaleLockBreakOptions,
): StaleLockBreakResult {
	const now = _internals.now();
	if (opts.deadlineMs !== undefined && opts.deadlineMs <= 0) return 'unknown';
	// 1. Cooldown pre-mark FIRST (before any mutation).
	if (!cooldownAllows(ownerLockPath, now)) return 'live';
	recordBreakAttempt(ownerLockPath, now);

	const markerPath = markerPathFor(ownerLockPath);
	// 2. Marker acquisition — rename-based atomic single taker. (The plan's
	//    "re-loop" arms both collapse to immediate back-offs here — a lost
	//    create reads the winner's marker on the NEXT break attempt via the
	//    cooldown window, so a retry loop would only re-race it.)
	const nonce = newNonce();
	if (fs.existsSync(markerPath)) {
		const marker = readMarker(markerPath);
		if (marker !== null) {
			if (isPidAlive(marker.breakerPid)) return 'live';
			if (_internals.now() - marker.createdAtMs <= MARKER_STALE_MS) {
				// Dead breaker, marker not yet aged: leave it for aging.
				return 'unknown';
			}
		}
		// Stale marker of a provably-dead breaker: take it over via an
		// atomic rename. Exactly one contender can win the rename.
		const takePath = `${markerPath}.take.${nonce}`;
		try {
			fs.renameSync(markerPath, takePath);
		} catch {
			return 'unknown'; // someone else took/replaced it — fail safe
		}
		try {
			fs.unlinkSync(takePath);
		} catch {
			/* ignore */
		}
		// fall through to create OUR marker
	}
	const ourMarker: MarkerPayload = {
		v: 1,
		breakerPid: process.pid,
		nonce,
		createdAtMs: _internals.now(),
	};
	try {
		const mfd = fs.openSync(markerPath, 'wx');
		fs.writeSync(mfd, JSON.stringify(ourMarker), 0, 'utf-8');
		fs.closeSync(mfd);
	} catch {
		// Another breaker won creation — back off.
		return 'live';
	}
	// From here on we hold the break right; never return without cleanup.
	let result: StaleLockBreakResult = 'unknown';
	try {
		// 3. Payload + class validation.
		const rawBefore = readOwnerPayload(ownerLockPath);
		if (opts.class === 'dead-owner') {
			const parsed = parseOwnerPayload(rawBefore);
			if (parsed === null) return 'unknown'; // legacy shape: TTL-only
			if (isPidAlive(parsed.ownerPid)) return 'live';
		} else {
			// ttl-cleanup: ownerless allowed, but only past the mtime TTL.
			const parsed = parseOwnerPayload(rawBefore);
			if (parsed !== null && isPidAlive(parsed.ownerPid)) return 'live';
			try {
				const mtimeMs = fs.statSync(ownerLockPath).mtimeMs;
				if (_internals.now() - mtimeMs <= LOCK_TIMEOUT_MS) return 'unknown';
			} catch {
				return 'unknown';
			}
		}
		if (opts.deadlineMs !== undefined && opts.deadlineMs < 1500) {
			return 'unknown';
		}
		// 4. Byte-identity re-read: a successor arriving mid-protocol
		//    changes the payload and aborts the break.
		const rawAfter = readOwnerPayload(ownerLockPath);
		if (rawAfter !== rawBefore) return 'unknown';
		// 5. Break (we are THE taker; successors self-release against our
		//    fresh marker and cannot complete acquire past it).
		try {
			fs.unlinkSync(ownerLockPath);
		} catch {
			return 'unknown';
		}
		result = 'broken';
		const payload = parseOwnerPayload(rawBefore);
		const ageMs = payload
			? Math.max(0, _internals.now() - payload.acquiredAtMs)
			: Math.max(0, _internals.now() - fs.statSync(markerPath).mtimeMs);
		// One bounded telemetry event per actual break; identifier-free
		// payload (operational privacy class — no paths, no pids).
		emit('store_lock_stale_broken', {
			store: opts.store,
			ageMs,
		});
		return result;
	} finally {
		removeOwnMarker(markerPath, nonce);
	}
}

// ---------------------------------------------------------------------------
// Public lock API
// ---------------------------------------------------------------------------

/**
 * Try to acquire a lock on a file (#2967 substrate: wx owner-payload lock).
 * Contention returns `{ acquired: false }`; the internal bounded retry loop
 * (5 attempts, 10–500 ms backoff) preserves the historical F-09 budget for
 * every caller. The legacy proper-lockfile artifact is only ever PROBED
 * (acquire + immediate release) so a live old-version holder still excludes
 * us; we never hold it.
 */
export async function tryAcquireLock(
	directory: string,
	filePath: string,
	agent: string,
	taskId: string,
): Promise<
	{ acquired: true; lock: FileLock } | { acquired: false; existing?: FileLock }
> {
	// normalizedTarget/getOwnerLockPath throw synchronously for traversal —
	// keep that behaviour.
	const ownerLockPath = getOwnerLockPath(directory, filePath);
	const locksDir = path.dirname(ownerLockPath);
	if (!fs.existsSync(locksDir)) {
		fs.mkdirSync(locksDir, { recursive: true });
	}

	const backoffs = [10, 20, 40, 80, 160];
	for (let attempt = 0; attempt < 5; attempt += 1) {
		const result = acquireOwnerLockOnce(ownerLockPath, agent, taskId);
		if (result.acquired && result.payload) {
			// Legacy probe (once, NOT held): exclude a possibly-live
			// old-version holder of the same target. A dead NEW holder holds
			// no legacy artifact, so this probe never wedges recovery.
			let probeRelease: (() => Promise<void>) | undefined;
			let probeBlocked = false;
			for (const sentinel of existingLegacySentinels(directory, filePath)) {
				try {
					const release = await lockfile.lock(sentinel, {
						stale: LOCK_TIMEOUT_MS,
						retries: { retries: 0 },
						realpath: false,
					});
					try {
						await release();
					} catch {
						/* probe release best-effort */
					}
					probeRelease = undefined;
				} catch {
					probeBlocked = true;
					break;
				}
			}
			if (probeBlocked) {
				result.release();
				return { acquired: false };
			}
			void probeRelease;
			const payload = result.payload;
			const lock: FileLock = {
				filePath,
				agent,
				taskId,
				timestamp: new Date(payload.acquiredAtMs).toISOString(),
				expiresAt: payload.acquiredAtMs + LOCK_TIMEOUT_MS,
				_release: async () => {
					releaseOwnerLock(ownerLockPath, payload);
				},
			};
			return { acquired: true, lock };
		}
		if (attempt < 4) {
			await new Promise((resolve) =>
				setTimeout(resolve, backoffs[attempt] ?? 500),
			);
		}
	}
	return { acquired: false };
}

/**
 * Release a lock on a file.
 *
 * The preferred release path is `lockResult.lock._release()` at the call site
 * (identity-fenced). This function is kept for API compatibility and is a
 * no-op.
 */
export async function releaseLock(
	_directory: string,
	_filePath: string,
	_taskId: string,
): Promise<boolean> {
	return true;
}

/**
 * Check if a file is locked (#2967: the wx owner lock; legacy dirs checked
 * as a fallback for pre-upgrade state).
 */
export function isLocked(directory: string, filePath: string): FileLock | null {
	const ownerLockPath = getOwnerLockPath(directory, filePath);
	const raw = readOwnerPayload(ownerLockPath);
	const parsed = parseOwnerPayload(raw);
	if (raw !== null) {
		// The artifact exists. A live owner makes it active unconditionally;
		// a dead owner's lock stays visible until the TTL sweep removes it.
		const alive = parsed !== null && isPidAlive(parsed.ownerPid);
		return {
			filePath,
			agent: parsed?.agent ?? 'unknown',
			taskId: parsed?.taskId ?? 'unknown',
			timestamp: new Date(parsed?.acquiredAtMs ?? Date.now()).toISOString(),
			expiresAt: alive ? Number.MAX_SAFE_INTEGER : Date.now() + LOCK_TIMEOUT_MS,
		};
	}
	// Legacy proper-lockfile dir fallback (pre-upgrade holders).
	const legacy = getLockFilePath(directory, filePath);
	const plLockDir = `${legacy}.lock`;
	if (fs.existsSync(plLockDir)) {
		let acquiredAt = Date.now();
		try {
			acquiredAt = fs.statSync(plLockDir).mtimeMs;
		} catch {
			/* fallback to now */
		}
		return {
			filePath,
			agent: 'unknown',
			taskId: 'unknown',
			timestamp: new Date(acquiredAt).toISOString(),
			expiresAt: acquiredAt + LOCK_TIMEOUT_MS,
		};
	}
	return null;
}

/**
 * Clean up expired locks. `.lck` owner locks: a pid-ALIVE lock is NEVER
 * removed (no time window converts a live pid into a dead classification);
 * a dead-owner or ownerless lock is removed once past the mtime TTL — via
 * the same fenced protocol (never an unconditional unlink). Legacy sentinel
 * artifacts keep their historical sweep semantics byte-for-byte.
 */
export function cleanupExpiredLocks(directory: string): number {
	const locksDir = path.join(directory, LOCKS_DIR);
	if (!fs.existsSync(locksDir)) {
		return 0;
	}
	let cleaned = 0;
	const files = fs.readdirSync(locksDir);

	for (const file of files) {
		const lockPath = path.join(locksDir, file);

		if (file.endsWith('.lck')) {
			const payload = parseOwnerPayload(readOwnerPayload(lockPath));
			if (payload !== null && isPidAlive(payload.ownerPid)) {
				continue; // live owner: never cleaned, regardless of age
			}
			try {
				const stat = fs.statSync(lockPath);
				if (Date.now() - stat.mtimeMs > LOCK_TIMEOUT_MS) {
					if (
						breakStaleLockIfOwnerDead(lockPath, {
							class: 'ttl-cleanup',
							store: 'evidence',
						}) === 'broken'
					) {
						cleaned++;
					}
				}
			} catch {
				/* already removed */
			}
			continue;
		}

		// Legacy sentinel sweep (historical semantics, unchanged).
		if (!file.endsWith('.lock')) continue;
		try {
			const stat = fs.statSync(lockPath);
			if (stat.isDirectory()) continue;
		} catch {
			continue;
		}
		try {
			const stat = fs.statSync(lockPath);
			const ageMs = Date.now() - stat.mtimeMs;
			if (ageMs > LOCK_TIMEOUT_MS) {
				const metaPath = getMetaPath(lockPath);
				try {
					fs.unlinkSync(metaPath);
				} catch {
					/* ignore if missing */
				}
				fs.unlinkSync(lockPath);
				cleaned++;
			}
		} catch {
			/* Already removed */
		}
	}

	return cleaned;
}

/**
 * List all active locks. `.lck` owner locks with a LIVE payload pid are
 * ALWAYS active (liveness is the heartbeat — old-but-live locks are never
 * delisted); dead/ownerless ones follow the mtime TTL.
 */
export function listActiveLocks(directory: string): FileLock[] {
	const locksDir = path.join(directory, LOCKS_DIR);
	const locks: FileLock[] = [];
	if (!fs.existsSync(locksDir)) {
		return locks;
	}
	const files = fs.readdirSync(locksDir);
	const now = Date.now();

	for (const file of files) {
		const lockPath = path.join(locksDir, file);
		try {
			if (file.endsWith('.lck')) {
				const payload = parseOwnerPayload(readOwnerPayload(lockPath));
				const stat = fs.statSync(lockPath);
				if (payload !== null && isPidAlive(payload.ownerPid)) {
					locks.push({
						filePath: payload.taskId ? lockPath : lockPath, // identity is the hash name; meta carries the original path for lanes
						agent: payload.agent,
						taskId: payload.taskId,
						timestamp: new Date(payload.acquiredAtMs).toISOString(),
						expiresAt: Number.MAX_SAFE_INTEGER,
					});
					continue;
				}
				// Dead-owner or ownerless: mtime TTL governs listing.
				if (now - stat.mtimeMs <= LOCK_TIMEOUT_MS) {
					locks.push({
						filePath: lockPath,
						agent: 'unknown',
						taskId: 'unknown',
						timestamp: new Date(stat.mtimeMs).toISOString(),
						expiresAt: stat.mtimeMs + LOCK_TIMEOUT_MS,
					});
				}
				continue;
			}
			if (!file.endsWith('.lock')) continue;
			const stat = fs.statSync(lockPath);
			if (stat.isFile()) {
				const plLockDir = `${lockPath}.lock`;
				if (fs.existsSync(plLockDir)) {
					const metaPath = getMetaPath(lockPath);
					const meta = readMetaFile(metaPath);
					if (meta) {
						if (meta.expiresAt < now) continue;
						locks.push({
							filePath: meta.originalPath,
							agent: meta.agent,
							taskId: meta.taskId,
							timestamp: meta.acquiredAt,
							expiresAt: meta.expiresAt,
							laneId: meta.laneId,
						});
					} else {
						let acquiredAt = Date.now();
						try {
							acquiredAt = fs.statSync(plLockDir).mtimeMs;
						} catch {
							/* fallback to now */
						}
						const expiresAt = acquiredAt + LOCK_TIMEOUT_MS;
						if (expiresAt < now) continue;
						locks.push({
							// No metadata sidecar: report the FULL lock path
							// (PR review PRR-008 — never the bare hash name).
							filePath: lockPath,
							agent: 'unknown',
							taskId: 'unknown',
							timestamp: new Date(acquiredAt).toISOString(),
							expiresAt,
						});
					}
				}
			}
		} catch {
			/* Ignore inaccessible entries */
		}
	}

	return locks;
}

/**
 * Atomically write metadata to a sidecar file using temp + rename.
 */
async function writeMetaFile(
	metaPath: string,
	metadata: LockMetadata,
): Promise<void> {
	const tmpPath = `${metaPath}.tmp`;
	try {
		await _internals.writeFile(tmpPath, JSON.stringify(metadata), 'utf-8');
		await fs.promises.rename(tmpPath, metaPath);
	} catch (err) {
		try {
			await fs.promises.unlink(tmpPath);
		} catch {
			/* ignore */
		}
		throw err;
	}
}

/**
 * Safely read and parse a metadata file, returning null on error.
 */
function readMetaFile(metaPath: string): LockMetadata | null {
	try {
		const content = fs.readFileSync(metaPath, 'utf-8');
		return JSON.parse(content) as LockMetadata;
	} catch {
		return null;
	}
}

/**
 * Acquire locks for all files in a lane (all-or-nothing). The lane
 * ALGORITHM is unchanged from the historical contract; the substrate moved
 * onto the same wx owner lock as the plain path (#2967: one mutually
 * exclusive protocol for every caller sharing a target).
 */
export async function acquireLaneLocks(
	directory: string,
	laneId: string,
	files: string[],
	agent: string,
	taskId: string,
	sessionID: string,
): Promise<
	| { acquired: true; locks: FileLock[] }
	| { acquired: false; conflicts: string[] }
> {
	const acquiredLocks: FileLock[] = [];
	const conflicts: string[] = [];

	const releaseOne = async (lock: FileLock) => {
		try {
			if (lock._release) {
				await lock._release();
			}
			const ownerLockPath = getOwnerLockPath(directory, lock.filePath);
			const metaPath = getMetaPath(ownerLockPath);
			try {
				fs.unlinkSync(metaPath);
			} catch {
				/* ignore if missing */
			}
		} catch {
			/* Best-effort cleanup */
		}
	};

	for (const file of files) {
		const result = await tryAcquireLock(directory, file, agent, taskId);

		if (!result.acquired) {
			for (const lock of acquiredLocks) {
				await releaseOne(lock);
			}
			conflicts.push(file);
			return { acquired: false, conflicts };
		}

		const ownerLockPath = getOwnerLockPath(directory, file);
		const metaPath = getMetaPath(ownerLockPath);
		const meta: LockMetadata = {
			originalPath: file,
			laneId,
			taskId,
			agent,
			sessionID,
			acquiredAt: result.lock.timestamp,
			expiresAt: result.lock.expiresAt,
			ownerPid: process.pid,
			startBoundMs: processStartBoundMs(),
		};

		try {
			await writeMetaFile(metaPath, meta);
		} catch (err) {
			for (const lock of acquiredLocks) {
				await releaseOne(lock);
			}
			if (result.lock._release) {
				await result.lock._release();
			}
			throw err;
		}

		result.lock.laneId = laneId;
		acquiredLocks.push(result.lock);
	}

	return { acquired: true, locks: acquiredLocks };
}

/**
 * Release all locks for a given lane. Locks this process still owns
 * (meta ownerPid + startBoundMs match ours) are identity-released; locks of
 * a FOREIGN pid are only removed when that pid is provably dead, via the
 * same fenced breaker — a live foreign lane holder is never force-released
 * (#2967: no unconditional lock-file unlink exists anywhere).
 */
export async function releaseLaneLocks(
	directory: string,
	laneId: string,
): Promise<number> {
	const locksDir = path.join(directory, LOCKS_DIR);
	if (!fs.existsSync(locksDir)) {
		return 0;
	}

	const files = fs.readdirSync(locksDir);
	let releasedCount = 0;
	const ourStart = processStartBoundMs();

	for (const file of files) {
		if (!file.endsWith('.meta')) continue;
		const metaPath = path.join(locksDir, file);
		const meta = readMetaFile(metaPath);
		if (!meta || meta.laneId !== laneId) continue;

		// New-substrate lane lock: `<stem>.lck` beside this `<stem>.meta`.
		const lckPath = metaPath.replace(/\.meta$/, '.lck');

		try {
			if (fs.existsSync(lckPath)) {
				const payload = parseOwnerPayload(readOwnerPayload(lckPath));
				if (
					payload !== null &&
					payload.ownerPid === process.pid &&
					meta.ownerPid === process.pid &&
					Math.abs(meta.startBoundMs - ourStart) <= START_BOUND_TOLERANCE_MS
				) {
					// Ours: identity-fenced self-release.
					releaseOwnerLock(lckPath, payload);
				} else {
					// Foreign or unknown generation: fenced breaker validates
					// liveness (dead-only removal, mtime-TTL bounded).
					breakStaleLockIfOwnerDead(lckPath, {
						class: 'ttl-cleanup',
						store: 'evidence',
					});
				}
			}
			// The meta sidecar is OUR lane's bookkeeping — remove it.
			try {
				fs.unlinkSync(metaPath);
			} catch {
				/* ignore */
			}
			releasedCount++;
		} catch {
			/* Best-effort: continue with other locks */
		}
	}

	return releasedCount;
}
