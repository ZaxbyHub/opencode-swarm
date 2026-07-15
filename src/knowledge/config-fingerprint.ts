/**
 * Cohort config fingerprint (issue #1846 §4).
 *
 * @status planned-future-use. The helper and its tests ship in this foundation
 * PR, but it is NOT yet wired into `link`/`unlink` or the diagnostics surfaces.
 * Cohort-agreement enforcement (fail-closed on mismatch for destructive ops)
 * lands with #1847/#1823, which consume the cohort-status source this PR
 * establishes. Shipping the primitive + tests now lets those dependents adopt
 * it without re-deriving the field set.
 *
 * A deterministic hash of the configuration fields that change retrieval,
 * curation, validation, or lifecycle semantics for the swarm knowledge tier.
 * Two linked worktrees SHOULD share the same fingerprint; a mismatch means the
 * cohort members will rank/quarantine/promote lessons differently.
 *
 * Only fields that affect *what the cohort stores and how it behaves* are
 * fingerprinted — not cosmetic or session-local tuning. The set is deliberately
 * conservative: adding a field later only changes the fingerprint when that
 * field's value differs, which is exactly the signal we want.
 */

import { createHash } from 'node:crypto';

/**
 * The config-shape fingerprint input. Callers project their knowledge config
 * into this loose shape; only the keys present are hashed.
 */
export interface CohortConfigFingerprintInput {
	dedup_threshold?: number;
	scope_filter?: readonly string[];
	validation_enabled?: boolean;
	evergreen_confidence?: number;
	evergreen_utility?: number;
	low_utility_threshold?: number;
	default_max_phases?: number;
	todo_max_phases?: number;
	confidence_floor_action?: string;
	contradiction_threshold_action?: string;
	contradiction_quarantine_threshold?: number;
	directive_min_confidence?: number;
	schema_version?: number;
	swarm_max_entries?: number;
	retrieval?: {
		mmr_lambda?: number;
		cold_start_bonus?: number;
		synonym_min_cooccurrence?: number;
	};
}

/**
 * Compute a deterministic 12-hex fingerprint for cohort-agreement checks.
 * Stable key ordering (sorted JSON) ensures equivalent configs hash equally
 * regardless of field insertion order.
 */
export function cohortConfigFingerprint(
	input: CohortConfigFingerprintInput,
): string {
	// Sort keys at every level so equivalent configs produce identical strings.
	const canonical = JSON.stringify(sortKeys(input));
	return createHash('sha256').update(canonical).digest('hex').slice(0, 12);
}

function sortKeys(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map(sortKeys);
	}
	if (value && typeof value === 'object') {
		const obj = value as Record<string, unknown>;
		const out: Record<string, unknown> = {};
		for (const key of Object.keys(obj).sort()) {
			out[key] = sortKeys(obj[key]);
		}
		return out;
	}
	return value;
}

export const _internals = {
	cohortConfigFingerprint,
	sortKeys,
};
