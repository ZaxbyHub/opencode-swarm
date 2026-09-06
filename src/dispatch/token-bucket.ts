/**
 * Token-bucket dispatch rate limiting for native task delegations
 * (issue #2507 / ADR 0002 G3 — reimplemented, no upstream code ported).
 *
 * Pacing, never denial: an empty bucket awaits until a token refills, so
 * dispatch rate is bounded WITHOUT blocking diagnosis or recovery (only the
 * `task` tool acquires tokens; read/diagnose/repair/rescope/abort controls
 * never wait).
 *
 * Restart-state integration: the per-PROJECT bucket level and refill
 * timestamp persist as one row in the existing `coordination_state` table
 * under namespace `dispatch.token-bucket` (entity `project`), written when
 * tokens are consumed. A fresh process rehydrates from that row and refills
 * by elapsed wall time — an exhausted bucket does not grant a fresh burst
 * after restart. Write failures fail OPEN (debug log, never break
 * dispatch): the in-memory bucket stays authoritative for the process
 * lifetime, and a restart after persistent write failure sees no row and
 * grants a fresh burst (documented limitation — the limiter's purpose is
 * runaway containment within a process).
 */

import {
	getCoordinationState,
	transitionCoordinationState,
} from '../db/coordination-store';
import { log } from '../utils/logger';

export const TOKEN_BUCKET_NAMESPACE = 'dispatch.token-bucket';
export const TOKEN_BUCKET_ENTITY_KEY = 'project';

interface BucketState {
	level: number;
	lastRefillMs: number;
	hydrated: boolean;
}

const buckets = new Map<string, BucketState>();

interface BucketPayload {
	level: number;
	lastRefillMs: number;
}

function refill(
	bucket: BucketState,
	ratePerSecond: number,
	capacity: number,
	now: number,
): void {
	const elapsedSeconds = Math.max(0, (now - bucket.lastRefillMs) / 1000);
	if (elapsedSeconds > 0 && ratePerSecond > 0) {
		bucket.level = Math.min(
			capacity,
			bucket.level + elapsedSeconds * ratePerSecond,
		);
		bucket.lastRefillMs = now;
	}
}

function persist(directory: string, bucket: BucketState): void {
	// Fail-open by design (see module doc); best-effort synchronous write so
	// a consumer reading coordination_state right after paced launches sees
	// the row (the frozen C4 restart arm relies on this).
	try {
		const payload: BucketPayload = {
			level: bucket.level,
			lastRefillMs: bucket.lastRefillMs,
		};
		transitionCoordinationState(directory, {
			namespace: TOKEN_BUCKET_NAMESPACE,
			entityKey: TOKEN_BUCKET_ENTITY_KEY,
			generation: 1,
			status: 'active',
			payload: JSON.stringify(payload),
		});
	} catch (err) {
		_internals.onPersistError(err);
	}
}

function hydrate(directory: string, capacity: number): BucketState {
	const existing = buckets.get(directory);
	if (existing) return existing;
	let bucket: BucketState = {
		level: capacity,
		lastRefillMs: _internals.now(),
		hydrated: true,
	};
	try {
		const row = _internals.readState(directory);
		if (row) {
			const parsed = JSON.parse(row.payload) as Partial<BucketPayload>;
			if (typeof parsed.level === 'number' && Number.isFinite(parsed.level)) {
				bucket = {
					// Rehydrate at >= 0; refill below clamps to capacity.
					level: Math.max(0, parsed.level),
					lastRefillMs:
						typeof parsed.lastRefillMs === 'number' &&
						Number.isFinite(parsed.lastRefillMs)
							? parsed.lastRefillMs
							: _internals.now(),
					hydrated: true,
				};
			}
		}
	} catch (err) {
		_internals.onPersistError(err);
	}
	buckets.set(directory, bucket);
	return bucket;
}

/**
 * Acquire one dispatch token, awaiting until one is available (paced, never
 * denied). `ratePerSecond === 0` disables the limiter entirely.
 *
 * Persistence is debounced to the acquires that matter for restart
 * semantics: only a PACED acquire (one that had to wait for a refill)
 * writes the coordination row. Immediate burst consumption is
 * reconstructible within the documented one-burst over-permission bound,
 * and skipping those writes keeps the common fast path free of SQLite I/O
 * (composing gates run under tight timing windows).
 */
export async function acquireDispatchToken(input: {
	directory: string;
	ratePerSecond: number;
	burstCapacity: number;
}): Promise<void> {
	const rate = input.ratePerSecond;
	if (!(rate > 0)) return; // 0 (or invalid) disables limiting.
	const capacity = Math.max(1, input.burstCapacity);
	const bucket = hydrate(input.directory, capacity);
	let waited = false;
	for (;;) {
		const now = _internals.now();
		refill(bucket, rate, capacity, now);
		if (bucket.level >= 1) {
			bucket.level -= 1;
			if (waited) persist(input.directory, bucket);
			return;
		}
		waited = true;
		const waitMs = Math.max(1, ((1 - bucket.level) / rate) * 1000);
		await _internals.sleep(Math.min(waitMs, 1000));
	}
}

/** Test seam: forget all in-memory buckets (does not touch persisted rows). */
export function _resetDispatchTokenBuckets(): void {
	buckets.clear();
}

export const _internals = {
	now: (): number => Date.now(),
	sleep: (ms: number): Promise<void> =>
		new Promise((resolve) => setTimeout(resolve, ms)),
	readState: (directory: string) =>
		getCoordinationState(
			directory,
			TOKEN_BUCKET_NAMESPACE,
			TOKEN_BUCKET_ENTITY_KEY,
		),
	onPersistError: (err: unknown): void => {
		// Debug-gated: a limiter write failure is never operational noise.
		if (process.env.DEBUG_SWARM) {
			log('[dispatch.token-bucket] persist failed', err);
		}
	},
};
