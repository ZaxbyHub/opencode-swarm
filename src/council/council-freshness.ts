/**
 * Centralized council evidence freshness evaluation (issue #2102 contract D).
 *
 * ONE evaluator + ONE bounded config field (`council.freshnessMaxAgeHours`,
 * default 24 hours to preserve prior behavior) govern the phase council,
 * architecture supervisor, and final council gates. Callers pass a single
 * captured `nowMs` (one clock per aggregate phase preflight) so gates cannot
 * disagree across an age boundary mid-run.
 *
 * Wall-clock age is never the sole identity check: generation binding is the
 * identity-digest comparison in the gates. Freshness only decides whether
 * otherwise-correctly-bound evidence is recent enough, not in the future,
 * and not older than a later required input (e.g. the phase retrospective).
 */

import type { CouncilConfig } from './types';

export const DEFAULT_FRESHNESS_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export type CouncilFreshnessFailureReason =
	| 'invalid_timestamp'
	| 'future_timestamp'
	| 'stale_evidence'
	| 'predates_required_input'
	| 'invalid_required_input';

export interface CouncilFreshnessOutcome {
	ok: boolean;
	reason?: CouncilFreshnessFailureReason;
	/** Human-facing explanation (gate message body). */
	message: string;
	/** Concrete recovery action. */
	recovery: string;
}

export function resolveCouncilFreshnessMaxAgeMs(
	config?: CouncilConfig,
): number {
	const hours = config?.freshnessMaxAgeHours ?? 24;
	if (!Number.isFinite(hours) || hours < 1) {
		return DEFAULT_FRESHNESS_MAX_AGE_MS;
	}
	return Math.min(hours, 720) * 60 * 60 * 1000;
}

/**
 * Evaluate one evidence timestamp against the shared policy.
 *
 * - `timestampMs: null` → invalid_timestamp (missing/unparseable).
 * - `timestampMs > nowMs` → future_timestamp (fail closed).
 * - age > maxAgeMs → stale_evidence.
 * - `mustPostdateMs` set (e.g. latest retrospective timestamp) and
 *   `timestampMs < mustPostdateMs` → predates_required_input.
 */
export function evaluateCouncilFreshness(input: {
	nowMs: number;
	timestampMs: number | null;
	maxAgeMs: number;
	mustPostdateMs?: number | null;
}): CouncilFreshnessOutcome {
	if (input.timestampMs === null || !Number.isFinite(input.timestampMs)) {
		return {
			ok: false,
			reason: 'invalid_timestamp',
			message: 'evidence has a missing or invalid timestamp',
			recovery: 'Re-run the council to generate fresh, timestamped evidence.',
		};
	}
	if (input.timestampMs > input.nowMs) {
		return {
			ok: false,
			reason: 'future_timestamp',
			message: 'evidence timestamp is in the future',
			recovery:
				'Re-run the council after the host clock is correct, then resubmit.',
		};
	}
	if (input.nowMs - input.timestampMs > input.maxAgeMs) {
		return {
			ok: false,
			reason: 'stale_evidence',
			message: `evidence is older than the configured freshness window (${Math.round(input.maxAgeMs / 3_600_000)} hours)`,
			recovery: 'Re-run the council for fresh review.',
		};
	}
	if (
		input.mustPostdateMs !== undefined &&
		input.mustPostdateMs !== null &&
		Number.isFinite(input.mustPostdateMs)
	) {
		// A required input stamped in the future is clock-skewed host data,
		// not an evidence problem: fail closed with a distinct reason so the
		// diagnostic does not blame the evidence (PRR-014).
		if (input.mustPostdateMs > input.nowMs) {
			return {
				ok: false,
				reason: 'invalid_required_input',
				message:
					'a later required input (e.g. the phase retrospective) is timestamped in the future — host clock skew suspected',
				recovery:
					'Correct the host clock / fix the skewed timestamp, then re-run the council.',
			};
		}
		if (input.timestampMs < input.mustPostdateMs) {
			return {
				ok: false,
				reason: 'predates_required_input',
				message:
					'evidence predates a later required input (e.g. the phase retrospective)',
				recovery:
					'Re-run the council after the latest required evidence is available.',
			};
		}
	}
	return {
		ok: true,
		message: 'evidence is fresh',
		recovery: '',
	};
}

export function parseTimestampMs(value: unknown): number | null {
	if (typeof value !== 'string') return null;
	const parsed = new Date(value).getTime();
	return Number.isNaN(parsed) ? null : parsed;
}

/**
 * Latest retrospective-relevant timestamp from an already-loaded retro bundle
 * (created_at/updated_at + this phase's retrospective entries). Shared by the
 * phase-council and final-council gates so both prefer the bundle captured by
 * the aggregate preflight over re-reading the disk (PRR-021(g)).
 */
export function latestRetroTimestampMsFromBundle(
	bundle: unknown,
	phase: number,
): number | null {
	if (!bundle || typeof bundle !== 'object') return null;
	const raw = bundle as {
		created_at?: unknown;
		updated_at?: unknown;
		entries?: unknown;
	};
	const entries = Array.isArray(raw.entries) ? raw.entries : [];
	const timestamps = [
		parseTimestampMs(raw.created_at),
		parseTimestampMs(raw.updated_at),
		...entries
			.filter(
				(
					entry,
				): entry is {
					type?: unknown;
					phase_number?: unknown;
					timestamp?: unknown;
				} => typeof entry === 'object' && entry !== null,
			)
			.filter(
				(entry) =>
					entry.type === 'retrospective' && entry.phase_number === phase,
			)
			.map((entry) => parseTimestampMs(entry.timestamp)),
	].filter((timestamp): timestamp is number => timestamp !== null);
	return timestamps.length > 0 ? Math.max(...timestamps) : null;
}
