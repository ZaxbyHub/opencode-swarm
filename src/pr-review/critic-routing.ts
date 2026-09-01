/**
 * PR-review critic routing — the single severity/impact/tag predicate
 * (issues #2383, #2385).
 *
 * Issue #2385 makes `src/pr-review/critic-routing.ts` the canonical home of
 * the shared production critic-routing predicate. `src/background/
 * pr-review-contract.ts` re-exports it (single definition, two import paths —
 * no duplication). Every production consumer (critic inventory derivation,
 * artifact-record validation, coverage admission, reducer transitions)
 * imports THIS predicate; inline severity triples are forbidden and a
 * centralization guard test enforces it.
 */

import type { PrReviewRiskImpact, PrReviewRiskTag } from '../background/pr-review-contract.js';

export interface PrReviewCriticRoutingInput {
	classification?: string;
	severity?: string;
	risk_impact?: PrReviewRiskImpact;
	risk_tags?: readonly PrReviewRiskTag[];
}

/**
 * THE shared production critic-routing predicate (issue #2383).
 *
 * Exactly one definition, imported by every production consumer (critic
 * inventory derivation, artifact-record validation, coverage admission).
 * Inline severity triples are forbidden — a parity/centralization guard test
 * enforces it. Accepts only the normalized canonical shape:
 *
 * - non-CONFIRMED classifications are never critic-routed;
 * - UNKNOWN/missing/invalid risk metadata routes to critic (fail-safe);
 * - CRITICAL/HIGH always route to critic;
 * - MEDIUM routes iff HIGH_IMPACT or at least one risk tag;
 * - LOW/INFO/NONE follow the existing no-critic policy once metadata is known.
 *
 * Paths, dimensions, keywords, and prompt prose may suggest risk to the model
 * but can never override this typed result.
 */
export function prReviewFindingRequiresCritic(
	input: PrReviewCriticRoutingInput,
): boolean {
	if (input.classification !== 'CONFIRMED') return false;
	const impact = input.risk_impact ?? 'UNKNOWN';
	const tags = input.risk_tags ?? [];
	if (impact === 'UNKNOWN') return true;
	if (input.severity === undefined) return true;
	if (input.severity === 'CRITICAL' || input.severity === 'HIGH') return true;
	if (input.severity === 'MEDIUM') {
		return impact === 'HIGH_IMPACT' || tags.length > 0;
	}
	return false;
}
