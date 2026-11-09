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

/** Raw fs bindings captured at module load for the lock primitive's
 *  EXCLUSIVE CREATE + payload write. Consumer suites spyOn(fs, 'openSync')
 *  etc. to steer their own code paths; the lock substrate must keep real
 *  filesystem exclusivity regardless (the pre-#2967 substrate had the same
 *  property for free — proper-lockfile captured its fs at its own import). */
const rawOpenSync = fs.openSync;
const rawWriteSync = fs.writeSync;
const rawCloseSync = fs.closeSync;

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
 *  against the acquire-time triple — byte-stable, no drift exposure.
 *  Feedback PRR-005: the lane-release fence compares meta.startBoundMs
 *  (sampled at lane-acquire time) with a freshly recomputed bound, and a
 *  lane can outlive its acquire by minutes — quantization drift across a
 *  wall-clock-second boundary is ±2-4 ms, so 5 ms misfenced OUR OWN
 *  generation, leaked the `.lck` and orphaned a live-pid lock for process
 *  lifetime. 250 ms keeps second-scale discrimination (a recycled-pid
 *  foreign process starts seconds+ apart) with a wide margin. */
const START_BOUND_TOLERANCE_MS = 250;

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
	// Era-A base64 alias forms. Feedback PRR-012: a win32 path with case
	// variance has TWO alias forms (the verbatim path AND the lowercased
	// hash input — getLockFilePath probes both), but only the verbatim form
	// was probed here, so a legacy lock keyed under the lowercased alias
	// stayed invisible to the exclusion probe on win32 uppercase paths.
	if (process.platform === 'win32' && normalized !== pathForHash) {
		candidates.push(
			Buffer.from(normalized).toString('base64').replace(/[/+=]/g, '_'),
		);
	}
	candidates.push(
		Buffer.from(pathForHash).toString('base64').replace(/[/+=]/g, '_'),
	);
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

/** True when the sibling meta names a lane (feedback PRR-026 telemetry
 *  discriminator: 'lane' vs 'generic' for cleanup/release-time breaks). */
function hasLaneMeta(lockPath: string): boolean {
	const meta = readMetaFile(getMetaPath(lockPath));
	return meta !== null && typeof meta.laneId === 'string' && meta.laneId !== '';
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
		// Strict shape validation (feedback PRR-016 + posted-review invalid-PID
		// finding): a payload with a non-positive pid or garbage in ANY
		// identity field is ownerless — TTL-only. Without this, ownerPid 0/-1
		// reads as a valid owner that isPidAlive then classifies dead, letting
		// a FRESH malformed lock be broken before its TTL.
		if (
			parsed?.v !== 1 ||
			!Number.isSafeInteger(parsed.ownerPid) ||
			parsed.ownerPid <= 0 ||
			typeof parsed.nonce !== 'string' ||
			parsed.nonce.length === 0 ||
			!Number.isFinite(parsed.startBoundMs) ||
			!Number.isFinite(parsed.acquiredAtMs) ||
			typeof parsed.agent !== 'string' ||
			typeof parsed.taskId !== 'string'
		) {
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
		// Unparsable/absent-but-locked marker: NOT a barrier. Markers are
		// pure protocol state written only by the fenced breaker (wx + one
		// JSON write), so foreign bytes mean the file is corrupt or orphaned
		// — never a live protocol participant. Blocking acquisition on it
		// forever is exactly the permanent-wedge class #2967 eliminates;
		// the rename-atomic takeover already serializes real breakers.
		return false;
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
		fd = rawOpenSync(ownerLockPath, 'wx');
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
		rawWriteSync(fd, JSON.stringify(payload), 0, 'utf-8');
	} catch {
		try {
			rawCloseSync(fd);
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
		rawCloseSync(fd);
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
	acquiredNonces.set(ownerLockPath, payload.nonce);
	return {
		acquired: true,
		payload,
		release: () => releaseOwnerLock(ownerLockPath, payload),
	};
}

/** In-process acquire record: proves ownership at release even when the
 *  payload READ is unreliable (a consumer's DI/mocked fs surface returning
 *  foreign bytes for the lock path would otherwise make the identity fence
 *  refuse forever and leak the lock — wedging every later acquire in the
 *  directory). Keyed by path, bounded by the acquire itself. */
const acquiredNonces = new Map<string, string>();

/** Identity-fenced release: unlinks the lock ONLY if our ownership is
 *  proven — either the on-disk payload still names OUR identity triple, or
 *  the path is in this process's acquire record with the same nonce. A
 *  successor's lock (installed after a legitimate break of a provably-dead
 *  us) can never be deleted by our late release: a broken generation
 *  removes the acquire record, and the successor's payload matches neither
 *  the fence nor the nonce. Exported for the events store's finally-unlink. */
export function releaseOwnerLock(
	ownerLockPath: string,
	self: { ownerPid: number; startBoundMs: number; nonce: string },
): void {
	const ours = acquiredNonces.get(ownerLockPath) === self.nonce;
	try {
		const current = parseOwnerPayload(readOwnerPayload(ownerLockPath));
		const identityMatch =
			current !== null &&
			current.ownerPid === self.ownerPid &&
			current.startBoundMs === self.startBoundMs &&
			current.nonce === self.nonce;
		if (!identityMatch && !ours) {
			return;
		}
		fs.unlinkSync(ownerLockPath);
	} catch {
		// Read or unlink failed: fall back to the acquire record alone.
		if (ours) {
			try {
				fs.unlinkSync(ownerLockPath);
			} catch {
				/* already gone */
			}
		}
	} finally {
		acquiredNonces.delete(ownerLockPath);
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
	/** Telemetry discriminator for the one bounded event. 'lane' marks lane
	 *  release/cleanup breaks; 'generic' marks the plain-path acquire probe
	 *  (PRR-002) and meta-less cleanup sweeps. */
	store: 'evidence' | 'events' | 'lane' | 'generic';
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

/** Sync sleep for the bounded takeover retry (this breaker is a sync API).
 *  Atomics.wait blocks the thread without a busy loop; falls back to a
 *  bounded spin on runtimes without SharedArrayBuffer. */
function breakSyncSleep(ms: number): void {
	try {
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
	} catch {
		const start = Date.now();
		while (Date.now() - start < ms) {
			/* bounded spin */
		}
	}
}

/** Fenced liveness break. Callers: withEvidenceLock (first contention), the
 *  events-store lock loop, and the plain-path acquire probe (PRR-002).
 *  Every property below is load-bearing and was adversarially derived across
 *  eight plan-critic rounds, then revised in the PR #3533 feedback round —
 *  see the trace's 06-critic-review.md before changing anything:
 *  - cooldown marks only when a break ATTEMPT commits (after the break
 *    right is secured) — read-only 'live'/'unknown' verdicts never consume
 *    the budget (feedback PRR-003 + review Finding 1: pre-marking made a
 *    live verdict suppress re-probe for the whole LOCK_TIMEOUT_MS,
 *    re-creating the TTL wedge this substrate exists to remove); the one
 *    disclosed exception is the mutation-adjacent pid-reuse 'live' after
 *    the record, inside the marker window (report-only corner);
 *  - a LIVE pid is NEVER broken — no time window exists that says otherwise;
 *  - marker takeover = atomic rename (bounded retry — Windows EPERM/EBUSY,
 *    feedback PRR-013) AND (age > MARKER_STALE_MS) AND the recorded breaker
 *    provably dead — a live breaker blocks indefinitely;
 *  - an UNPARSABLE existing marker is never taken over — it belongs to a
 *    breaker mid-publish (posted-review HIGH); markers are published
 *    atomically via unique-candidate + no-replace link, so a complete
 *    marker is always parseable and an incomplete one is an orphan the
 *    aged sweep collects;
 *  - the lock payload is re-read for byte-identity between takeover and
 *    unlink, so a successor that arrived mid-protocol aborts the break;
 *  - all failures fail closed to 'unknown' (legacy TTL-only behaviour). */
export function breakStaleLockIfOwnerDead(
	ownerLockPath: string,
	opts: StaleLockBreakOptions,
): StaleLockBreakResult {
	const now = _internals.now();
	if (opts.deadlineMs !== undefined && opts.deadlineMs <= 0) return 'unknown';
	// 1. Cooldown admission — bounds MUTATION attempts (takeover/publish/
	//    unlink), never read-only verdicts.
	if (!cooldownAllows(ownerLockPath, now)) return 'live';

	// 2. Payload pre-validation — READ-ONLY, before any marker or cooldown
	//    mutation. Every 'live'/'unknown' verdict here returns WITHOUT
	//    consuming the budget (review Finding 1: the old order published the
	//    marker first, so a live-owner verdict on the evidence wrapper's
	//    common path still consumed the cooldown — the exact PRR-003 stall).
	//    The byte-identity re-read after publication remains the successor
	//    guard; validating first cannot strand a breaker: an owner that dies
	//    (or a payload that changes) between pre-validation and unlink
	//    simply re-probes on the next attempt.
	const rawBefore = readOwnerPayload(ownerLockPath);
	const parsedBefore = parseOwnerPayload(rawBefore);
	if (opts.class === 'dead-owner') {
		if (parsedBefore === null) return 'unknown'; // legacy shape: TTL-only
		if (isPidAlive(parsedBefore.ownerPid)) return 'live';
	} else {
		// ttl-cleanup: ownerless allowed, but only past the mtime TTL.
		if (parsedBefore !== null && isPidAlive(parsedBefore.ownerPid)) {
			return 'live';
		}
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

	const markerPath = markerPathFor(ownerLockPath);
	const nonce = newNonce();
	// 2. Marker acquisition — rename-based atomic single taker over an aged,
	//    dead-breaker marker. (The plan's "re-loop" arms both collapse to
	//    immediate back-offs here — a lost takeover reads the winner's
	//    marker on the NEXT break attempt via the cooldown window, so a
	//    longer retry loop would only re-race it.)
	if (fs.existsSync(markerPath)) {
		const marker = readMarker(markerPath);
		if (marker === null) {
			// Incompletely-published or corrupt marker: NEVER take over —
			// a mid-write marker belongs to a LIVE breaker under the
			// atomic-publish protocol (the old wx-then-write window let a
			// second breaker read half a marker and steal the break right;
			// posted-review HIGH). Fail safe; the aged sweep collects it.
			return 'unknown';
		}
		if (isPidAlive(marker.breakerPid)) return 'live';
		if (_internals.now() - marker.createdAtMs <= MARKER_STALE_MS) {
			// Dead breaker, marker not yet aged: leave it for aging.
			return 'unknown';
		}
		// Stale marker of a provably-dead breaker: take it over via an
		// atomic rename, bounded retry (Windows AV/finder EPERM/EBUSY
		// holds; feedback PRR-013). Exactly one contender can win.
		const takePath = `${markerPath}.take.${nonce}`;
		let took = false;
		for (const delay of [0, 25, 50, 100]) {
			if (delay > 0) breakSyncSleep(delay);
			try {
				fs.renameSync(markerPath, takePath);
				took = true;
				break;
			} catch (err) {
				if ((err as NodeJS.ErrnoException).code === 'ENOENT') break;
				/* EPERM/EBUSY: retry */
			}
		}
		if (!took) return 'unknown'; // someone else took/replaced it — fail safe
		try {
			fs.unlinkSync(takePath);
		} catch {
			/* ignore */
		}
		// fall through to publish OUR marker
	}
	// 3. Publish OUR marker ATOMICALLY: write a uniquely-named candidate
	//    completely, then hardlink it into the marker path (no-replace on
	//    POSIX and Windows). A reader therefore either sees the complete
	//    marker or nothing — never half of one.
	const candPath = `${markerPath}.cand.${nonce}`;
	const ourMarker: MarkerPayload = {
		v: 1,
		breakerPid: process.pid,
		nonce,
		createdAtMs: _internals.now(),
	};
	let published = false;
	try {
		const cfd = rawOpenSync(candPath, 'wx');
		try {
			rawWriteSync(cfd, JSON.stringify(ourMarker), 0, 'utf-8');
		} finally {
			rawCloseSync(cfd);
		}
		try {
			fs.linkSync(candPath, markerPath);
			published = true;
		} catch {
			// EEXIST — another breaker published first. Back off.
		}
	} catch {
		/* candidate create/write failed */
	}
	try {
		fs.unlinkSync(candPath);
	} catch {
		/* ignore */
	}
	if (!published) return 'live';
	// 4. We hold the break right — record the cooldown budget NOW, before
	//    the unlink (a real mutation is committed from here). All live/
	//    unknown verdicts already returned during read-only pre-validation,
	//    so the budget is only ever consumed by an actual break attempt.
	recordBreakAttempt(ownerLockPath, _internals.now());
	// From here on we hold the break right; never return without cleanup.
	let result: StaleLockBreakResult = 'unknown';
	try {
		// 5. Byte-identity re-read: a successor arriving mid-protocol
		//    changes the payload and aborts the break.
		const rawAfter = readOwnerPayload(ownerLockPath);
		if (rawAfter !== rawBefore) return 'unknown';
		// 6. Liveness re-check at the last possible moment (review round-2
		//    nit): pre-validation is separated from the unlink by the marker
		//    protocol, so a pid-reuse resurrection inside that window must
		//    not be broken. Byte-identity guarantees parsedBefore describes
		//    the CURRENT payload, so the verdict rides the same read.
		//    Mutation-adjacent: the budget is already recorded.
		if (parsedBefore !== null && isPidAlive(parsedBefore.ownerPid)) {
			return 'live';
		}
		// 7. Break (we are THE taker; successors self-release against our
		//    fresh marker and cannot complete acquire past it). Dropping the
		//    acquire record keeps the identity fence closed for the
		//    successor generation.
		try {
			fs.unlinkSync(ownerLockPath);
		} catch {
			return 'unknown';
		}
		acquiredNonces.delete(ownerLockPath);
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
	opts?: {
		/** Telemetry store discriminator for the in-path dead-owner breaker
		 *  probe (feedback PRR-002). Callers with their own attribution
		 *  (evidence) pass it through; every other target reports 'generic'. */
		breakStore?: StaleLockBreakOptions['store'];
	},
): Promise<
	| { acquired: true; lock: FileLock; brokeStale?: boolean }
	| { acquired: false; existing?: FileLock }
> {
	// normalizedTarget/getOwnerLockPath throw synchronously for traversal —
	// keep that behaviour.
	const ownerLockPath = getOwnerLockPath(directory, filePath);
	const locksDir = path.dirname(ownerLockPath);
	if (!fs.existsSync(locksDir)) {
		fs.mkdirSync(locksDir, { recursive: true });
	}

	const backoffs = [10, 20, 40, 80, 160];
	let brokeStale = false;
	for (let attempt = 0; attempt < 5; attempt += 1) {
		const result = acquireOwnerLockOnce(ownerLockPath, agent, taskId);
		if (result.acquired && result.payload) {
			// Legacy probe (once, NOT held): exclude a possibly-live
			// old-version holder of the same target. A dead NEW holder holds
			// no legacy artifact, so this probe never wedges recovery.
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
				} catch {
					probeBlocked = true;
					break;
				}
			}
			if (probeBlocked) {
				result.release();
				return { acquired: false };
			}
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
			return { acquired: true, lock, brokeStale };
		}
		if (attempt < 4) {
			// #2967 feedback PRR-002: contention on ANY target class gets a
			// stale-recovery route. Base (proper-lockfile) self-healed every
			// lock target via the acquire-path stale window; this PR's fenced
			// breaker was wired only to evidence/events, leaving a dead owner's
			// `.lck` wedging plan/save/close targets permanently. Probe the
			// payload: a parsable dead-owner payload runs the fenced breaker
			// once (never-break-live-pid holds; the cooldown bounds mutation to
			// one attempt per target per LOCK_TIMEOUT_MS). Ownerless/foreign
			// payloads keep TTL-only semantics here — 'ttl-cleanup' on the
			// acquire path would let a plain mtime age break a lock whose
			// holder is merely slow, so the aged sweep stays the only route.
			const parsed = parseOwnerPayload(readOwnerPayload(ownerLockPath));
			if (parsed !== null && !isPidAlive(parsed.ownerPid)) {
				if (
					breakStaleLockIfOwnerDead(ownerLockPath, {
						class: 'dead-owner',
						store: opts?.breakStore ?? 'generic',
					}) === 'broken'
				) {
					brokeStale = true;
				}
			}
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
							// Feedback PRR-026: the lane release/cleanup sweep and
							// the plain evidence path were both reported as
							// 'evidence' — a lane crash and an evidence break were
							// indistinguishable in telemetry. The sibling meta
							// carries lane identity.
							store: hasLaneMeta(lockPath) ? 'lane' : 'generic',
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

		// Feedback PRR-006/014: break markers and takeover residue are swept
		// once aged past MARKER_STALE_MS. A LIVE breaker removes its own
		// marker in the protocol's finally — a marker this old is either a
		// dead breaker's (takeover handles it) or a crash orphan (nothing
		// else ever will). Without this, a planted/recycled marker or a
		// crash between rename and unlink wedges acquisition forever.
		if (file.includes('.breaking') || file.includes('.take.')) {
			try {
				const stat = fs.statSync(lockPath);
				if (Date.now() - stat.mtimeMs > MARKER_STALE_MS) {
					fs.unlinkSync(lockPath);
					cleaned++;
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
					// Feedback PRR-001: lane identity lives in the sibling .meta
					// sidecar — project originalPath/laneId so the lean lane
					// gates (phase-ready/task-completion) see held lane locks.
					// Plain-path locks have no meta and keep the hash-path
					// identity. Additionally, a live lane lock whose meta names
					// OUR pid is released below (the self-release fence); the
					// wx lock itself is already gone there, so only foreign
					// holders reach this projection.
					const meta = readMetaFile(getMetaPath(lockPath));
					const laneMeta =
						meta !== null &&
						typeof meta.laneId === 'string' &&
						meta.laneId !== ''
							? meta
							: null;
					locks.push({
						filePath: laneMeta?.originalPath ? laneMeta.originalPath : lockPath,
						agent: payload.agent,
						taskId: payload.taskId,
						timestamp: new Date(payload.acquiredAtMs).toISOString(),
						expiresAt: Number.MAX_SAFE_INTEGER,
						laneId: laneMeta !== null ? laneMeta.laneId : undefined,
					});
					continue;
				}
				// Dead-owner or ownerless: mtime TTL governs listing.
				if (now - stat.mtimeMs <= LOCK_TIMEOUT_MS) {
					// Feedback PRR-001: crashed lane holders list here (dead
					// pid) — project the sibling .meta so the lean lane gates
					// still see laneId/originalPath and fire their backstop.
					const deadMeta = readMetaFile(getMetaPath(lockPath));
					const deadLaneMeta =
						deadMeta !== null &&
						typeof deadMeta.laneId === 'string' &&
						deadMeta.laneId !== ''
							? deadMeta
							: null;
					locks.push({
						filePath: deadLaneMeta?.originalPath
							? deadLaneMeta.originalPath
							: lockPath,
						agent: 'unknown',
						taskId: 'unknown',
						timestamp: new Date(stat.mtimeMs).toISOString(),
						expiresAt: stat.mtimeMs + LOCK_TIMEOUT_MS,
						laneId: deadLaneMeta !== null ? deadLaneMeta.laneId : undefined,
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
 *
 * Feedback PRR-005: the `.meta` sidecar is unlinked ONLY when the `.lck` is
 * actually released or removed — a refused fence (live foreign holder)
 * keeps the meta as the lane's bookkeeping so releaseLaneLocks can retry
 * later, instead of orphaning a live `.lck` with zero bookkeeping.
 * Feedback PRR-007 (reworked per review Finding 2): a pre-upgrade legacy
 * lane pairing (`.lock` sentinel beside the meta) is only dropped when its
 * `<sentinel>.lock` dir lock is ALREADY GONE — a live-ish legacy dir lock
 * (cross-process unlock is impossible and no liveness probe exists for dir
 * locks) keeps its meta untouched and counts 0, so the Era-A holder's own
 * release and the legacy TTL sweep own the artifact and the mutual-
 * exclusion probe keeps seeing the sentinel while a holder may be live.
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

		const stem = metaPath.replace(/\.meta$/, '');

		try {
			// Feedback PRR-007 (reworked per review Finding 2): pre-upgrade
			// legacy lane pairing — a `.lock` sentinel beside this meta (no
			// `.lck`). The real exclusion artifact is the `<sentinel>.lock`
			// DIRECTORY: cross-process lockfile.unlock always throws
			// ENOTACQUIRED and no liveness probe exists for dir locks, so the
			// dir lock is NEVER unlinked here — while it exists we keep the
			// meta as bookkeeping and count 0 (the Era-A holder's own release
			// and the legacy TTL sweep own the artifact). Only a bare sentinel
			// (dir lock already gone — released or swept) is stale bookkeeping
			// and gets dropped with its meta. This preserves the no-
			// unconditional-unlink invariant; the mutual-exclusion probe
			// (existingLegacySentinels) keeps seeing the sentinel while a
			// legacy holder may still be live.
			const legacyPath = `${stem}.lock`;
			const lckPath = `${stem}.lck`;
			if (!fs.existsSync(lckPath) && fs.existsSync(legacyPath)) {
				if (fs.existsSync(`${legacyPath}.lock`)) {
					// Live-ish legacy dir lock: leave everything for its owner —
					// the acquire probe's stale window steals a crashed dir on
					// the next acquisition of that target, and the bare-sentinel
					// branch below drops the residue once the dir is gone.
					// (An orphaned meta can persist until then: cleanupExpiredLocks
					// has no production caller and the doctor lists locks, not
					// metas — disclosed residue, bounded at 3 small files.)
					continue;
				}
				try {
					fs.unlinkSync(legacyPath);
				} catch {
					/* ignore */
				}
				try {
					fs.unlinkSync(metaPath);
				} catch {
					/* ignore */
				}
				releasedCount++;
				continue;
			}

			let released = false;
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
					released = !fs.existsSync(lckPath);
				} else {
					// Foreign or unknown generation: fenced breaker validates
					// liveness (dead-only removal, mtime-TTL bounded).
					released =
						breakStaleLockIfOwnerDead(lckPath, {
							class: 'ttl-cleanup',
							store: 'lane',
						}) === 'broken';
				}
			} else {
				// No `.lck` artifact: already gone (e.g. crashed before the
				// wx create, or swept) — the meta alone is stale bookkeeping.
				released = true;
			}
			// Feedback PRR-005: drop the meta ONLY when the lock is actually
			// gone — a refused fence (live foreign holder) keeps the meta so
			// a later releaseLaneLocks can retry, and no live `.lck` is left
			// orphaned without bookkeeping.
			if (released) {
				try {
					fs.unlinkSync(metaPath);
				} catch {
					/* ignore */
				}
				releasedCount++;
			}
		} catch {
			/* Best-effort: continue with other locks */
		}
	}

	return releasedCount;
}
