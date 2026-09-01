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
	PrReviewCircuitRecordV2,
	PrReviewCircuitSignal,
	PrReviewResiliencePolicyRecord,
} from './circuit.js';
import type { PrReviewObserverDiagnosticKind } from './lifecycle.js';

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
	attempts: Array<Record<string, unknown>>;
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
		| Partial<Record<PrReviewBaseDimensionId, PrReviewDimensionCancellationLite>>
		| undefined;
	/** Coverage disclosure fields are carried opaquely (owned by completion.ts). */
	prReviewPartialBaseCoverage?: unknown | undefined;
}

// ---------------------------------------------------------------------------
// Terminal coverage (values computed by completion.ts)
// ---------------------------------------------------------------------------

export type PrReviewTerminalCoverageKind = 'COMPLETE' | 'PARTIAL' | 'NO_COVERAGE';

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
			source: 'collection_observer' | 'legacy_transcript_adapter';
			code: string;
			boundedDetail?: string | undefined;
	  }
	| { kind: 'append_audit_event'; code: string; boundedDetail?: string | undefined }
	| { kind: 'block_dispatch'; reason: 'circuit_open' | 'probe_in_flight' }
	| { kind: 'invalidate_publication_authorization' }
	| { kind: 'clear_resilience_evidence' };

// ---------------------------------------------------------------------------
// Events (closed union)
// ---------------------------------------------------------------------------

export type PrReviewCircuitProbeOutcome =
	| { result: 'typed_success' }
	| { result: 'provider_failure'; providerClass: string }
	| { result: 'ignored' }
	| { result: 'rolled_back_admission' };

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
			diagnostic: PrReviewObserverDiagnosticKind;
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
	| {
			type: 'transcript_evidence_presented';
			batchId: string;
			laneId: string;
			laneHasStructuredReceipt: boolean;
	  }
	| {
			type: 'provider_terminal_observed';
			batchId: string;
			laneId: string;
			generation: number;
			evidence:
				| { source: 'typed_terminal_error_class'; category: string; kind: string }
				| { source: 'observer_deadline' }
				| { source: 'client_unavailable' }
				| { source: 'parser_or_transcript' }
				| { source: 'stale_observation' };
	  }
	| {
			type: 'lane_cancelled';
			batchId: string;
			laneId: string;
			generation: number;
	  }
	| {
			type: 'presumed_stale_swept';
			batchId: string;
			laneId: string;
			status: string;
			ageMs: number;
			liveness: 'alive' | 'unresponsive' | 'unknown';
			staleTimeoutMs?: number | undefined;
	  }
	// --- circuit ------------------------------------------------------------
	| {
			type: 'circuit_advance_requested';
			nowMs: number;
			laneSignals: readonly PrReviewCircuitSignal[];
			probeObservation?: {
				terminalStatus: string;
				signal: PrReviewCircuitSignal | null;
				terminalAtMs: number;
			} | undefined;
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
			policy?: import('../config/schema.js').PrReviewResilienceConfig | undefined;
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
			criticConfirmedFindingIds: readonly string[];
	  }
	// --- publication / recovery / authorization ------------------------------
	| {
			type: 'publication_armed';
			coverageKind: PrReviewTerminalCoverageKind;
			verdict: PrReviewReportVerdict;
	  }
	| {
			type: 'publication_published';
			binding: PrReviewAuthorizationBinding;
	  }
	| {
			type: 'armed_recovery_requested';
			binding: PrReviewAuthorizationBinding;
			dimensionsToCancel: PrReviewBaseDimensionId[];
			nowIso: string;
	  }
	| {
			type: 'reviewer_authorization_consumed';
			binding: PrReviewAuthorizationBinding;
			expectedRole: 'reviewer' | 'test_engineer';
			role: 'reviewer' | 'test_engineer';
	  };

/**
 * The exact-identity binding an armed recovery, publication, or re-entry
 * authorization must carry (issue #2383/#2385). Stale or foreign values are
 * rejected with `stale_foreign_authorization`.
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
	| 'observer_deadline_not_terminal_evidence'
	| 'client_absence_not_terminal_evidence'
	| 'parser_failure_not_provider_signal'
	| 'stale_observation_not_provider_signal'
	| 'lane_already_sampled'
	| 'live_lane_blocks_coverage'
	| 'partial_coverage_cannot_approve'
	| 'no_coverage_cannot_approve'
	| 'critic_required_unfulfilled'
	| 'stale_foreign_authorization'
	| 'stale_generation_result'
	| 'receipt_cannot_be_downgraded'
	| 'duplicate_conflicting_result'
	| 'base_batch_limit_reached'
	| 'rollback_preconditions_failed'
	| 'lane_not_stale_eligible'
	| 'unknown_event';

export interface PrReviewTransitionRejection {
	code: PrReviewTransitionRejectionCode;
	detail: string;
}
