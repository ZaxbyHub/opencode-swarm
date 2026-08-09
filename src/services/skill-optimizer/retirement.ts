/**
 * Wall-clock retirement gate (Workstream A, issue #1822).
 *
 * Uses the REAL usage signal (#1770) plus minimum-age and support safeguards.
 * Retirement is always REVERSIBLE: `retireSkill` (skill-generator.ts) records a
 * `retired.marker` and the skill can be restored via the existing restore path.
 *
 * Also exposes the explicit `outcomeSignal === 0` (zero-evidence) boundary
 * classification used by eligibility — distinct from the existing
 * strongOutcomes test (`tests/unit/services/skill-generator.test.ts:731-758`),
 * which covers `outcomeSignal === 0` WITH `strongOutcomes=true`. This module
 * covers the zero-evidence branch (no positives, no negatives) explicitly.
 */

import { computeOutcomeSignal } from '../../hooks/knowledge-store.js';
import type { RetrievalOutcome } from '../../hooks/knowledge-types.js';

export type OutcomeSignalClass = 'positive' | 'negative' | 'zero_evidence';

/**
 * Classify an outcome signal. The zero-evidence branch (`=== 0` with no
 * outcomes at all) is distinct from "balanced positives and negatives" —
 * `computeOutcomeSignal` returns 0 for BOTH cases, but the eligibility gate
 * treats zero as "neither boost nor penalize" only when there is genuinely no
 * evidence. Callers that want the strict zero-evidence classification should
 * pass the raw outcome counts.
 */
export function classifyOutcomeSignal(outcomes: RetrievalOutcome | undefined): {
	signal: number;
	classification: OutcomeSignalClass;
} {
	const signal = computeOutcomeSignal(outcomes);
	const positives =
		(outcomes?.applied_explicit_count ?? 0) +
		(outcomes?.succeeded_after_shown_count ?? 0);
	const negatives =
		(outcomes?.ignored_count ?? 0) +
		(outcomes?.violated_count ?? 0) +
		(outcomes?.contradicted_count ?? 0) +
		(outcomes?.failed_after_shown_count ?? 0);
	const total = positives + negatives;
	let classification: OutcomeSignalClass;
	if (total === 0) {
		classification = 'zero_evidence'; // genuine no-evidence boundary
	} else if (signal > 0) {
		classification = 'positive';
	} else if (signal < 0) {
		classification = 'negative';
	} else {
		// signal === 0 but total > 0 → exactly balanced; treat as zero_evidence
		// for retirement purposes (no decisive signal either way).
		classification = 'zero_evidence';
	}
	return { signal, classification };
}

export interface RetirementEvaluation {
	retire: boolean;
	reason: string;
}

/**
 * Evaluate whether a skill should be retired on the wall-clock schedule.
 *
 * Safeguards (issue #1822 Workstream A):
 *   - minimum age: `ageDays >= minAgeDays` (floor, not a trigger);
 *   - real usage: a decisive negative signal is required (#1770);
 *   - support: a skill that is still occasionally applied is NOT retired even
 *     if old (`applied > 0` blocks retirement unless the negative ratio is
 *     extreme).
 *
 * Returns `{ retire: false }` for any skill failing the safeguards. Retirement
 * is reversible (the caller uses `retireSkill`, which only marks).
 */
export function evaluateRetirement(args: {
	usage: {
		appliedExplicitCount: number;
		ignoredCount: number;
		violatedCount: number;
		failedAfterShownCount: number;
	};
	ageDays: number;
	minAgeDays: number;
}): RetirementEvaluation {
	const { usage, ageDays, minAgeDays } = args;
	if (ageDays < minAgeDays) {
		return {
			retire: false,
			reason: `below minimum age floor (${ageDays}d < ${minAgeDays}d)`,
		};
	}
	const applied = usage.appliedExplicitCount;
	const negative =
		usage.ignoredCount + usage.violatedCount + usage.failedAfterShownCount;
	// Never-applied AND materially-negative → retire.
	if (applied === 0 && negative >= 3) {
		return {
			retire: true,
			reason: `never applied, ${negative} negative signals, ${ageDays}d old`,
		};
	}
	// Still-supported but overwhelmingly negative → retire only if extreme.
	if (applied > 0 && negative / applied >= 5) {
		return {
			retire: true,
			reason: `extreme negative ratio ${negative}/${applied}, ${ageDays}d old`,
		};
	}
	return {
		retire: false,
		reason: `supported (applied ${applied}, negative ${negative}, ${ageDays}d)`,
	};
}
