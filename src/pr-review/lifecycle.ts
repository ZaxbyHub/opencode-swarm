/**
 * PR-review lane lifecycle rules (issues #2385).
 *
 * The single owner of lane-mode classification, presumed-stale eligibility,
 * late-result acceptance, and observer-diagnostic classification for
 * PR-review lanes. Previously these rules were distributed between
 * `src/tools/dispatch-lanes.ts` and `src/hooks/pr-workflow-gate.ts` (two
 * stale-sweep authorities with different liveness sources — recurrence class
 * G-5); both adapters now consult the predicates defined here.
 *
 * The terminal delegation-status vocabulary itself is owned by
 * `src/pr-review/circuit.ts` (`CIRCUIT_TERMINAL_DELEGATION_STATUSES`) and the
 * stale horizon by `src/background/pending-delegations.ts`
 * (`DEFAULT_STALE_DELEGATION_TIMEOUT_MS`) — re-exported here for lane-rule
 * consumers; there is exactly one definition of each.
 */

import {
	DEFAULT_STALE_DELEGATION_TIMEOUT_MS,
	type BackgroundDelegationRecord,
} from '../background/pending-delegations.js';

export { DEFAULT_STALE_DELEGATION_TIMEOUT_MS };

/** Lane modes that belong to the PR-review workflow (canonical prefixes). */
export const PR_REVIEW_LANE_MODE_PREFIX = 'swarm-pr-review:';

/** Discovery lanes produce structured result envelopes (submit-tool baseline). */
export const PR_REVIEW_DISCOVERY_LANE_MODES: ReadonlySet<string> = new Set([
	'swarm-pr-review:base',
	'swarm-pr-review:micro',
]);

/** Verdict lanes transport reviewer/critic verdict rows. */
export const PR_REVIEW_VERDICT_LANE_MODES: ReadonlySet<string> = new Set([
	'swarm-pr-review:reviewer',
	'swarm-pr-review:critic',
]);

/** All concrete PR-review lane modes. */
export const PR_REVIEW_LANE_MODES: ReadonlySet<string> = new Set([
	...PR_REVIEW_DISCOVERY_LANE_MODES,
	...PR_REVIEW_VERDICT_LANE_MODES,
	'swarm-pr-review:council',
]);

export function isPrReviewLaneMode(mode: string | undefined): boolean {
	return (
		mode !== undefined && mode.startsWith(PR_REVIEW_LANE_MODE_PREFIX)
	);
}

export function isPrReviewDiscoveryLaneMode(mode: string | undefined): boolean {
	return mode !== undefined && PR_REVIEW_DISCOVERY_LANE_MODES.has(mode);
}

export function isPrReviewVerdictLaneMode(mode: string | undefined): boolean {
	return mode !== undefined && PR_REVIEW_VERDICT_LANE_MODES.has(mode);
}

// ---------------------------------------------------------------------------
// Presumed-stale eligibility (issue #2381/#2385: the ONLY terminal backstop)
// ---------------------------------------------------------------------------

/**
 * Delegation statuses the presumed-stale sweep may consider. Mirrors
 * `SweepableDelegationStatus` in `src/background/pending-delegations.ts` (its
 * private type); the sweepable SET is that module's canonical export — this
 * readonly copy exists so lane-rule consumers can reason about eligibility
 * without importing the private type. Kept in sync by test
 * (presumed-stale status set matches the delegation ledger's sweepable set).
 */
export const SWEEPABLE_PR_REVIEW_LANE_STATUSES: ReadonlySet<string> = new Set([
	'pending',
	'running',
	'ingestion_error',
]);

/**
 * A lane's liveness as seen by ONE observation source. The two historical
 * sweep authorities used different sources (`session.status` readiness in
 * dispatch-lanes, session probes in the gate); this classification is the
 * common language they must both map into before consulting the shared
 * eligibility predicate.
 */
export type PrReviewLaneLiveness = 'alive' | 'unresponsive' | 'unknown';

export interface PrReviewLaneStaleEvidence {
	status: string;
	/** Age of the lane's latest record, in milliseconds. */
	ageMs: number;
	liveness: PrReviewLaneLiveness;
}

/**
 * The presumed-stale rule (single authority, issue #2385 recurrence class
 * G-5): a lane is eligible for the terminal stale sweep only when its status
 * is sweepable, its age has reached the stale horizon, AND its observed
 * liveness is not `alive`. An `unknown` liveness (probe error / host client
 * unavailable) does NOT block the sweep once the age horizon is reached —
 * the 30-minute backstop remains the only terminal backstop — but a lane
 * observed alive is never swept by an observer path.
 */
export function presumedStaleLaneEligible(
	evidence: PrReviewLaneStaleEvidence,
	staleTimeoutMs: number = DEFAULT_STALE_DELEGATION_TIMEOUT_MS,
): boolean {
	return (
		SWEEPABLE_PR_REVIEW_LANE_STATUSES.has(evidence.status) &&
		evidence.ageMs >= staleTimeoutMs &&
		evidence.liveness !== 'alive'
	);
}

// ---------------------------------------------------------------------------
// Late-result acceptance (generation isolation)
// ---------------------------------------------------------------------------

/**
 * Whether a terminal result observed for a lane may still mutate the CURRENT
 * workflow state. A result carries its dispatch generation; once the workflow
 * has advanced to a newer generation, the late result is evidence only — it
 * must never settle, clear, or credit anything in the current generation.
 */
export function laneResultCreditableToGeneration(
	resultGeneration: number | undefined,
	currentGeneration: number,
): boolean {
	return (resultGeneration ?? 1) === currentGeneration;
}

/**
 * Observer diagnostics (issue #2381): the closed vocabulary a collection
 * observer may produce. NONE of these is terminal provider evidence — the
 * reducer rejects any attempt to treat one as a child failure, and the
 * observer-terminalization guardrail enforces the same at the source level.
 */
export type PrReviewObserverDiagnosticKind =
	| 'busy'
	| 'retry'
	| 'idle_unknown'
	| 'host_unavailable'
	| 'probe_error'
	| 'wait_expired';

export const PR_REVIEW_OBSERVER_DIAGNOSTIC_KINDS: readonly PrReviewObserverDiagnosticKind[] =
	[
		'busy',
		'retry',
		'idle_unknown',
		'host_unavailable',
		'probe_error',
		'wait_expired',
	];

/**
 * Total function over the closed diagnostic union: an observer diagnostic is
 * NEVER terminal child-failure evidence (issue #2385 invalid-transition rule
 * "observer deadline/client absence -> terminal child failure").
 */
export function observerDiagnosticIsTerminalEvidence(
	kind: PrReviewObserverDiagnosticKind,
): false {
	void kind;
	return false;
}

// ---------------------------------------------------------------------------
// Lane record helpers
// ---------------------------------------------------------------------------

/**
 * The generation a delegation record was dispatched under. Records written
 * before the field existed belong to the first generation.
 */
export function prReviewLaneGeneration(
	record: Pick<BackgroundDelegationRecord, 'generation'>,
): number {
	return record.generation ?? 1;
}
