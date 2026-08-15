/**
 * Persistent, session-scoped record of which lane outputs have already been
 * delivered to a controller session (issue #1988, plan §7.4).
 *
 * `collect_lane_results` is polled repeatedly by the PR-review protocol;
 * re-delivering a settled lane's bounded preview on every poll is the
 * dominant controller-context driver behind compaction loops. The in-memory
 * `deliveredLaneOutputs` Set this store replaces fell open across plugin
 * restarts AND suppressed across sessions (a key delivered in session A
 * wrongly suppressed session B's first delivery when batch/lane/digest
 * collided). This store keys delivery state by session and persists it to
 * `.swarm/lane-delivery-cache.json` so dedupe survives restarts and
 * compaction cycles within a session.
 *
 * Failure semantics (both directions are safe):
 *   - Load is fail-open: a missing, corrupt, or version-mismatched file
 *     yields an empty bucket (a corrupt file is renamed `.corrupt` so the
 *     next mark heals it; delivery then repeats once, which is harmless
 *     because suppressed output is always recoverable via `output_ref`).
 *   - Write is best-effort: any error is swallowed — losing a key only
 *     causes one extra inline delivery.
 *
 * Bounds (invariant 8): at most MAX_DELIVERED_LANE_OUTPUT_KEYS keys per
 * directory bucket, evicted FIFO across sessions via the global `order`
 * list (oldest keys of the oldest sessions go first); at most
 * MAX_TRACKED_SESSIONS sessions and MAX_TRACKED_DIRECTORIES in-memory
 * buckets, each FIFO-evicted.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { writeAtomicJson } from './lane-output-store.js';

export const LANE_DELIVERY_CACHE_FILENAME = 'lane-delivery-cache.json';
export const MAX_DELIVERED_LANE_OUTPUT_KEYS = 1024;
const MAX_TRACKED_SESSIONS = 16;
// Mirrors MAX_CACHED_DIRECTORIES in repo-graph-injection.ts deliberately:
// both bound per-directory in-memory state at the same footprint.
const MAX_TRACKED_DIRECTORIES = 16;

const CORRUPT_SUFFIX = '.corrupt';

interface LaneDeliveryBucket {
	/** Session ids in first-touch order — the cross-session FIFO eviction order. */
	order: string[];
	/** Per-session delivered keys, each in insertion order. */
	sessions: Map<string, string[]>;
	total: number;
}

interface LaneDeliveryCacheFile {
	version: 1;
	order: string[];
	sessions: Record<string, string[]>;
}

const directoryBuckets = new Map<string, LaneDeliveryBucket>();

function bucketKey(directory: string | undefined): string {
	return directory ? path.normalize(path.resolve(directory)) : '';
}

function emptyBucket(): LaneDeliveryBucket {
	return { order: [], sessions: new Map(), total: 0 };
}

function cacheFilePath(directory: string): string {
	return path.join(directory, '.swarm', LANE_DELIVERY_CACHE_FILENAME);
}

function isValidCacheFile(value: unknown): value is LaneDeliveryCacheFile {
	if (
		!value ||
		typeof value !== 'object' ||
		(value as { version?: unknown }).version !== 1
	) {
		return false;
	}
	const { order, sessions } = value as {
		order?: unknown;
		sessions?: unknown;
	};
	if (!Array.isArray(order) || order.some((id) => typeof id !== 'string')) {
		return false;
	}
	if (!sessions || typeof sessions !== 'object') return false;
	return Object.values(sessions).every(
		(keys) =>
			Array.isArray(keys) && keys.every((key) => typeof key === 'string'),
	);
}

function loadBucketFromDisk(directory: string): LaneDeliveryBucket {
	const file = cacheFilePath(directory);
	let raw: string;
	try {
		raw = fs.readFileSync(file, 'utf-8');
	} catch {
		return emptyBucket();
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		parsed = null;
	}
	if (!isValidCacheFile(parsed)) {
		// Rename the unusable file out of the way (best-effort) so every
		// subsequent read does not re-parse it; the next mark() writes a
		// fresh, valid cache.
		try {
			fs.renameSync(file, `${file}${CORRUPT_SUFFIX}`);
		} catch {
			/* best-effort — reads stay fail-open either way */
		}
		return emptyBucket();
	}
	const bucket = emptyBucket();
	const seen = new Set<string>();
	for (const sessionID of parsed.order) {
		if (seen.has(sessionID)) continue;
		const keys = parsed.sessions[sessionID];
		if (!keys || keys.length === 0) continue;
		seen.add(sessionID);
		bucket.order.push(sessionID);
		bucket.sessions.set(sessionID, [...keys]);
		bucket.total += keys.length;
	}
	// Sessions present but missing from `order` (torn write) are dropped:
	// re-delivering a preview once is harmless; trusting un-ordered state
	// would break the FIFO eviction contract.
	return bucket;
}

function persistBucket(directory: string, bucket: LaneDeliveryBucket): void {
	const file: LaneDeliveryCacheFile = {
		version: 1,
		order: bucket.order,
		sessions: Object.fromEntries(bucket.sessions),
	};
	try {
		writeAtomicJson(cacheFilePath(directory), file);
	} catch {
		// Best-effort by contract (see module doc): a lost write only causes
		// one extra inline delivery after a restart.
	}
}

function evictOverflow(bucket: LaneDeliveryBucket): void {
	while (bucket.total > MAX_DELIVERED_LANE_OUTPUT_KEYS) {
		let evicted = false;
		for (const sessionID of bucket.order) {
			const keys = bucket.sessions.get(sessionID);
			if (!keys || keys.length === 0) continue;
			keys.shift();
			bucket.total -= 1;
			if (keys.length === 0) {
				bucket.sessions.delete(sessionID);
				bucket.order = bucket.order.filter((id) => id !== sessionID);
			}
			evicted = true;
			break;
		}
		if (!evicted) break;
	}
}

function bucketFor(directory: string | undefined): LaneDeliveryBucket {
	const key = bucketKey(directory);
	const existing = directoryBuckets.get(key);
	if (existing) return existing;
	while (directoryBuckets.size >= MAX_TRACKED_DIRECTORIES) {
		const oldestDirectory = directoryBuckets.keys().next().value;
		if (oldestDirectory === undefined) break;
		directoryBuckets.delete(oldestDirectory);
	}
	const bucket = directory ? loadBucketFromDisk(directory) : emptyBucket();
	directoryBuckets.set(key, bucket);
	return bucket;
}

function sessionKeys(
	bucket: LaneDeliveryBucket,
	sessionID: string | undefined,
): string[] {
	const key = sessionID ?? '';
	let keys = bucket.sessions.get(key);
	if (!keys) {
		while (bucket.order.length >= MAX_TRACKED_SESSIONS) {
			const oldest = bucket.order.shift();
			if (oldest === undefined) break;
			const oldestKeys = bucket.sessions.get(oldest);
			bucket.sessions.delete(oldest);
			bucket.total -= oldestKeys?.length ?? 0;
		}
		keys = [];
		bucket.sessions.set(key, keys);
		bucket.order.push(key);
	}
	return keys;
}

/**
 * Whether this session has already received the lane output identified by
 * `key` in this directory. Memory-only (no persistence) when `directory` is
 * undefined — the direct test-seam path.
 */
export function hasLaneOutputBeenDelivered(
	directory: string | undefined,
	sessionID: string | undefined,
	key: string,
): boolean {
	if (!key) return false;
	const bucket = bucketFor(directory);
	return bucket.sessions.get(sessionID ?? '')?.includes(key) ?? false;
}

/**
 * Record that `key` was delivered to this session in this directory and
 * persist the cache best-effort. FIFO bounds are enforced after recording.
 */
export function markLaneOutputDelivered(
	directory: string | undefined,
	sessionID: string | undefined,
	key: string,
): void {
	if (!key) return;
	const bucket = bucketFor(directory);
	const keys = sessionKeys(bucket, sessionID);
	if (keys.includes(key)) return;
	keys.push(key);
	bucket.total += 1;
	evictOverflow(bucket);
	if (directory) persistBucket(directory, bucket);
}

/** Test-only: clear all in-memory buckets (disk state is untouched). */
export function resetLaneDeliveryStoreForTests(): void {
	directoryBuckets.clear();
}
