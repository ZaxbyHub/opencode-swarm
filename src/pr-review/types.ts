/**
 * PR-review typed state boundary (issue #2512).
 *
 * The reducer-backed PR-review state slice and the small event/effect
 * vocabulary used by its six production adapters. The owning gate's full
 * `PrWorkflowGateState` satisfies this slice structurally (a compile-time
 * assertion in the gate enforces it), so there is ONE field definition — the
 * gate adds only non-PR-review fields.
 *
 * Completion, publication, authorization, and delegation settlement have
 * their own lock/CAS-backed authorities. They are intentionally not mirrored
 * as reducer events: see `authority.ts` for the historical event census and
 * each retired event's replacement authority.
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

export type PrReviewEvent =
	// --- lane lifecycle -----------------------------------------------------
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
	  };

// ---------------------------------------------------------------------------
// Rejections
// ---------------------------------------------------------------------------

export type PrReviewTransitionRejectionCode =
	| 'stale_generation_result'
	| 'duplicate_conflicting_result'
	| 'rollback_preconditions_failed'
	| 'unknown_event';

export interface PrReviewTransitionRejection {
	code: PrReviewTransitionRejectionCode;
	detail: string;
}
