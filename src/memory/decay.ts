import type { MemoryKind, MemoryRecord } from './types';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Compute the kind-specific decay expiry for a memory (issue #1464).
 *
 * Returns the new `expiresAt` ISO string to apply, or `undefined` when no
 * change should be made. Rules:
 *  - `scratch` is never re-decayed here — it already receives a ≤7-day expiry
 *    at creation time and is bounded by `validateMemoryRecordRules`.
 *  - A half-life of `0` means "never auto-expire" (the durable 365+ kinds).
 *  - Decay sets `expiresAt = createdAt + halfLifeDays`, but never SHORTENS an
 *    existing earlier expiry (a memory already set to expire sooner keeps that
 *    sooner expiry).
 *
 * Pure and deterministic: callers pass the existing record and apply the
 * returned expiry by patching only `expiresAt` (preserving id/hash/timestamps).
 */
export function computeDecayExpiry(
	memory: Pick<MemoryRecord, 'kind' | 'createdAt' | 'expiresAt'>,
	halfLifeDays: Record<MemoryKind, number>,
	_now: Date = new Date(),
): string | undefined {
	if (memory.kind === 'scratch') return undefined;
	const halfLife = halfLifeDays[memory.kind] ?? 0;
	if (halfLife <= 0) return undefined;
	const created = Date.parse(memory.createdAt);
	if (!Number.isFinite(created)) return undefined;
	const candidateMs = created + halfLife * MS_PER_DAY;
	const existing = memory.expiresAt ? Date.parse(memory.expiresAt) : undefined;
	// Never shorten an existing earlier (or equal) expiry.
	if (
		existing !== undefined &&
		Number.isFinite(existing) &&
		existing <= candidateMs
	) {
		return undefined;
	}
	const candidate = new Date(candidateMs).toISOString();
	if (memory.expiresAt === candidate) return undefined;
	return candidate;
}

/**
 * Check whether a record's natural half-life date is in the past (i.e., the record
 * is older than its decay horizon). Used to guard against upgrade-time auto-expiry
 * when migrating from pre-decay code: a record written under a previous config
 * without decay should not be silently expired on the first consolidation pass.
 */
export function isPastDecayHorizon(
	memory: Pick<MemoryRecord, 'kind' | 'createdAt'>,
	halfLifeDays: Record<MemoryKind, number>,
	now: Date = new Date(),
): boolean {
	if (memory.kind === 'scratch') return false;
	const halfLife = halfLifeDays[memory.kind] ?? 0;
	if (halfLife <= 0) return false;
	const created = Date.parse(memory.createdAt);
	if (!Number.isFinite(created)) return false;
	return created + halfLife * MS_PER_DAY <= now.getTime();
}
