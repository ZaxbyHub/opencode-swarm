/**
 * PR-review typed state boundary (issue #2385).
 *
 * The closed event/effect vocabulary for the PR-review transition authority
 * (`reducer.ts`) plus the PR-review slice of the workflow gate state. The
 * owning gate's full `PrWorkflowGateState` satisfies this slice structurally
 * (a compile-time assertion in the gate enforces it), so there is ONE field
 * definition — the gate adds only non-PR-review fields.
 *
 * Invalid transitions from issue #2385 are rejected with typed codes
 * (`PrReviewTransitionRejectionCode`) rather than made representable-by-type
 * alone: several of them depend on runtime evidence (generations, digests,
 * ledger state), so the reducer is the enforcement point.
 */

import type { PrReviewBaseDimensionId } from '../background/pr-review-contract.js';
import type {
	PrReviewCircuitSignal,
	PrReviewResiliencePolicyRecord,
} from './circuit.js';

// ---------------------------------------------------------------------------
// State slice
// ---------------------------------------------------------------------------

/** A declared base-dispatch lane (subset the reducer governs). */
export interface PrReviewBaseDispatchLane {
	laneId: string;
	workflowLane: PrReviewBaseDimensionId;
	ownedWorkflowLanes?: PrReviewBaseDimensionId[];
}

export interface PrReviewBaseDispatchRecordLite {
	batchId: string;
	lanes: PrReviewBaseDispatchLane[];
	validatedAt: string;
}

export interface PrReviewDimensionCancellationLite {
	reason: string;
	cancelledAt: string;
	source: 'armed_recovery';
}

export interface PrReviewResilienceSlice {
	policy: PrReviewResiliencePolicyRecord;
	/** Attempt bookkeeping is adapter-owned; the reducer carries it opaquely. */
	attempts: readonly unknown[];
	circuit?: import('./circuit.js').PrReviewCircuitRecord | undefined;
}

/**
 * The PR-review slice of the workflow gate state. The gate's full state type
 * satisfies this structurally; the reducer may therefore be applied to the
 * live gate state object without a projection step.
 */
export interface PrReviewWorkflowState {
	sessionID: string;
	workflowInstanceId?: string | undefined;
	revision: number;
	prHeadSha?: string | undefined;
	prReviewBaseSha?: string | undefined;
	prReviewBaseDispatches?: PrReviewBaseDispatchRecordLite[] | undefined;
	prReviewBaseDispatch?: PrReviewBaseDispatchRecordLite | undefined;
	prReviewResilience?: PrReviewResilienceSlice | undefined;
	prReviewContractRetryDimensions?: PrReviewBaseDimensionId[] | undefined;
	prReviewDimensionCancellations?:
		| Partial<
				Record<PrReviewBaseDimensionId, PrReviewDimensionCancellationLite>
		  >
		| undefined;
	/** Coverage disclosure fields are carried opaquely (owned by completion.ts). */
	prReviewPartialBaseCoverage?: unknown | undefined;
}

// ---------------------------------------------------------------------------
// Terminal coverage (values computed by completion.ts)
// ---------------------------------------------------------------------------

export type PrReviewTerminalCoverageKind =
	| 'COMPLETE'
	| 'PARTIAL'
	| 'NO_COVERAGE';

export type PrReviewReportVerdict =
	| 'APPROVE'
	| 'INCOMPLETE'
	| 'REQUEST_CHANGES';

export interface PrReviewCoverageSettlementInput {
	kind: PrReviewTerminalCoverageKind;
	coveredDimensions: PrReviewBaseDimensionId[];
	unresolvedDimensions: Array<{
		dimension: PrReviewBaseDimensionId;
		terminalState: 'FAILED' | 'CANCELLED' | 'NOT_LAUNCHED';
		reasonKind: string;
	}>;
	/** Dimensions with a live (non-terminal) lane — blocks finalization. */
	liveDimensions: PrReviewBaseDimensionId[];
}

// ---------------------------------------------------------------------------
// Effects
// ---------------------------------------------------------------------------

export type PrReviewEffect =
	| { kind: 'persist_state' }
	| {
			kind: 'settle_delegation';
			batchId: string;
			laneId: string;
			status: 'completed' | 'error' | 'cancelled' | 'stale';
			replay?: boolean;
	  }
	| {
			kind: 'emit_diagnostic';
			source: 'collection_observer';
			code: string;
			boundedDetail?: string | undefined;
	  }
	| { kind: 'block_dispatch'; reason: 'circuit_open' | 'probe_in_flight' };

/**
 * Effect kinds map to executors that exist in production (issue #2385
 * Phase 8b review): `persist_state` is executed by the gate through the
 * persistence CAS write; `settle_delegation` describes the settlement the
 * dispatch/collect adapters perform via `pending-delegations.ts`;
 * `emit_diagnostic` describes the collect observer's bounded diagnostics
 * channel; `block_dispatch` describes the circuit-open admission refusal.
 * A kind with no executor is not emitted and not declared.
 */

// ---------------------------------------------------------------------------
// Events (closed union)
// ---------------------------------------------------------------------------

export type PrReviewCircuitProbeOutcome =
	| { result: 'typed_success' }
	| { result: 'provider_failure'; providerClass: string }
	| { result: 'ignored' }
	| { result: 'rolled_back_admission' };

/**
 * A settled critic receipt: a critic verdict that terminates its assigned
 * coverage obligation (issue #2512). UPHELD, DOWNGRADED, and DISPROVED each
 * satisfy the critic coverage their finding was assigned; NEEDS_MORE_EVIDENCE
 * is deliberately nonterminal and is not representable here. The digest is the
 * authoritative reviewer verdict row the critic claim was bound to at
 * composition time (`reviewerVerdictRowDigest`; composition rejects unbound
 * claims), so a receipt can only be built from the current authoritative
 * reviewer rows.
 */
export interface PrReviewCriticSettledReceipt {
	findingId: string;
	status: 'UPHELD' | 'DOWNGRADED' | 'DISPROVED';
	reviewerRowDigest: string;
}

/**
 * The closed event vocabulary for the PR-review transition authority
 * (`reducer.ts`), issue #2512's registered-path contract: every declared event
 * member has a production construction site (see
 * docs/pr-review-transition-authority.md for the wire-or-retire table). Events
 * whose production authority lives at a richer executor boundary — transcript
 * downgrade protection (`validateExactStructuredReceiptCoverage`), provider
 * terminal evidence classification (`classifyPrReviewCircuitSignal`),
 * operator lane cancellation (`collectOnce` cancel_pending), publication
 * arming/settlement (`completePrWorkflow`), and reviewer re-entry consumption
 * (`reservePrReviewReentryAuthorizationAgainstBinding`) — are deliberately
 * RETIRED from this union rather than declared without a dispatch site.
 */
export type PrReviewEvent =
	// --- lane lifecycle -----------------------------------------------------
	| {
			type: 'base_admission_requested';
			batchId: string;
			lanes: PrReviewBaseDispatchLane[];
			depthTier: 'S' | 'M' | 'L';
			maxBatches: number;
			validatedAt: string;
	  }
	| {
			type: 'base_admission_rolled_back';
			batchId: string;
			batchDelegationRecordsExist: boolean;
	  }
	| {
			type: 'collection_observed';
			diagnostic:
				| 'busy'
				| 'retry'
				| 'idle_unknown'
				| 'host_unavailable'
				| 'probe_error'
				| 'wait_expired';
			pendingLaneIds: readonly string[];
			boundedDetail?: string | undefined;
	  }
	| {
			type: 'lane_structured_result_submitted';
			batchId: string;
			laneId: string;
			generation: number;
			semanticEnvelopeDigest: string;
			outcome: 'CLEAN' | 'FINDINGS' | 'INCOMPLETE';
			existingReceiptDigest?: string | undefined;
	  }
	// --- circuit ------------------------------------------------------------
	| {
			type: 'circuit_advance_requested';
			nowMs: number;
			laneSignals: readonly PrReviewCircuitSignal[];
			probeObservation?:
				| {
						terminalStatus: string;
						signal: PrReviewCircuitSignal | null;
						terminalAtMs: number;
				  }
				| undefined;
			admission?: { batchId: string; laneId: string } | undefined;
			policy: PrReviewResiliencePolicyRecord;
	  }
	| {
			type: 'circuit_probe_settled';
			outcome: PrReviewCircuitProbeOutcome;
			nowMs: number;
			policy: PrReviewResiliencePolicyRecord;
	  }
	| {
			type: 'resilience_config_changed';
			enabled: boolean;
			policy?:
				| import('../config/schema.js').PrReviewResilienceConfig
				| undefined;
			nowMs: number;
	  }
	// --- coverage / completion ----------------------------------------------
	| {
			type: 'coverage_finalization_requested';
			settlement: PrReviewCoverageSettlementInput;
			requestedVerdict?: PrReviewReportVerdict;
	  }
	| {
			type: 'critic_result_recorded';
			criticRequiredFindingIds: readonly string[];
			criticSettledReceipts: readonly PrReviewCriticSettledReceipt[];
	  }
	// --- recovery / authorization ---------------------------------------------
	| {
			type: 'armed_recovery_requested';
			binding: PrReviewAuthorizationBinding;
			dimensionsToCancel: PrReviewBaseDimensionId[];
			nowIso: string;
			/** The operator's sanitized reason; the transition persists it verbatim. */
			reason: string;
	  };

/**
 * The exact-identity binding an armed recovery authorization must carry
 * (issues #2383/#2385/#2512). Stale or foreign values are rejected with
 * `stale_foreign_authorization`.
 *
 * Authority split (issue #2512): the reducer validates the fields the workflow
 * state itself carries — `sessionID`, `workflowInstanceId`, `prHeadSha`, and
 * `generation` (`bindingRejection` in reducer.ts). `revisionDigest` is only
 * observable by the executor that resolved it (the armed publication record or
 * the live binding context), so it is validated THERE — never here; a pure
 * reducer cannot independently observe a concurrent storage mutation.
 */
export interface PrReviewAuthorizationBinding {
	sessionID: string;
	workflowInstanceId?: string | undefined;
	prHeadSha: string;
	revisionDigest?: string;
	generation: number;
}

// ---------------------------------------------------------------------------
// Rejections
// ---------------------------------------------------------------------------

export type PrReviewTransitionRejectionCode =
	| 'live_lane_blocks_coverage'
	| 'partial_coverage_cannot_approve'
	| 'no_coverage_requires_incomplete'
	| 'critic_required_unfulfilled'
	| 'stale_foreign_authorization'
	| 'stale_generation_result'
	| 'duplicate_conflicting_result'
	| 'base_batch_limit_reached'
	| 'rollback_preconditions_failed'
	| 'unknown_event';

export interface PrReviewTransitionRejection {
	code: PrReviewTransitionRejectionCode;
	detail: string;
}
