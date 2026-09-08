/**
 * PR-review reducer-backed transition slice (issue #2512).
 *
 * Pure `(state, event) -> { state, effects }` reducer over the six event
 * shapes that have production creators. Rule computation is delegated to the
 * focused circuit module; completion, publication, authorization, and
 * delegation settlement remain in their own lock/CAS-backed authorities. The
 * historical event census and retired replacement paths live in
 * `authority.ts`.
 *
 * - one lane → multiple circuit samples (delegated to circuit.ts's
 *   distinct-`(generation, batch, lane)` scan; asserted by property tests)
 * - late old-generation result → current-state mutation
 *
 * The owning gate and `dispatch-lanes` are orchestration adapters: they build
 * retained events from real I/O, apply the returned state, and map typed
 * rejections to operator-facing BLOCKED messages. Effects are the transition's OUTPUT
 * CONTRACT — every effect kind maps to an executor that exists in production
 * (see `PrReviewEffect` in types.ts): the gate executes `persist_state`
 * through the persistence CAS write; `settle_delegation` describes the
 * delegation settlement the dispatch/collect adapters perform through
 * `pending-delegations.ts`; `emit_diagnostic` describes the collect
 * observer's bounded diagnostics channel; `block_dispatch` describes the
 * circuit-open admission refusal. No effect kind is emitted without a real
 * executor (reviewer finding 1, issue #2385 Phase 8b).
 *
 * Probe outcomes other than an admission rollback are processed by the
 * machine on the NEXT staged admission: the gate feeds the recorded probe's
 * observation into `advancePrReviewCircuit` (`probeObservationForCircuit`),
 * which is the design's single advance-per-admission cadence.
 */

import {
	adoptPrReviewCircuit,
	advancePrReviewCircuit,
	type PrReviewCircuitRecordV2,
	resetPrReviewResilienceForReEnable,
	resolvePrReviewResiliencePolicy,
	rollbackPrReviewCircuitProbe,
} from './circuit.js';
import type {
	PrReviewEffect,
	PrReviewEvent,
	PrReviewTransitionRejection,
	PrReviewWorkflowState,
} from './types.js';

export type PrReviewReduceResult =
	| {
			status: 'applied';
			state: PrReviewWorkflowState;
			effects: PrReviewEffect[];
	  }
	| {
			status: 'rejected';
			state: PrReviewWorkflowState;
			rejection: PrReviewTransitionRejection;
	  };

function applied(
	state: PrReviewWorkflowState,
	effects: PrReviewEffect[] = [],
): PrReviewReduceResult {
	return { status: 'applied', state, effects };
}

function rejected(
	state: PrReviewWorkflowState,
	code: PrReviewTransitionRejection['code'],
	detail: string,
): PrReviewReduceResult {
	return { status: 'rejected', state, rejection: { code, detail } };
}

function currentGeneration(state: PrReviewWorkflowState): number {
	return state.revision;
}

function circuitRecordOf(
	state: PrReviewWorkflowState,
): PrReviewCircuitRecordV2 | null {
	const circuit = state.prReviewResilience?.circuit;
	if (!circuit || !('version' in circuit)) return null;
	return circuit as PrReviewCircuitRecordV2;
}

function withCircuit(
	state: PrReviewWorkflowState,
	circuit: PrReviewCircuitRecordV2 | undefined,
): PrReviewWorkflowState {
	if (!state.prReviewResilience) return state;
	return {
		...state,
		prReviewResilience: { ...state.prReviewResilience, circuit },
	};
}

/**
 * The transition authority. Pure: every I/O input arrives on the event; every
 * write leaves as an effect. The state is never mutated in place.
 */
export function reducePrReviewEvent(
	state: PrReviewWorkflowState,
	event: PrReviewEvent,
): PrReviewReduceResult {
	switch (event.type) {
		// -----------------------------------------------------------------
		// Lane lifecycle
		// -----------------------------------------------------------------
		case 'base_admission_rolled_back': {
			const dispatches = state.prReviewBaseDispatches ?? [];
			if (dispatches.at(-1)?.batchId !== event.batchId) {
				return rejected(
					state,
					'rollback_preconditions_failed',
					`the last admitted base batch is not ${event.batchId}`,
				);
			}
			if (event.batchDelegationRecordsExist) {
				return rejected(
					state,
					'rollback_preconditions_failed',
					`base batch ${event.batchId} already has delegation records`,
				);
			}
			const nextDispatches = dispatches.slice(0, -1);
			return applied(
				{
					...state,
					prReviewBaseDispatches: nextDispatches,
					prReviewBaseDispatch: dispatches.at(-2),
				},
				[{ kind: 'persist_state' }],
			);
		}

		case 'collection_observed': {
			// Observation only: a wait-expiry / no-client / probe outcome NEVER
			// mutates lane or workflow state. The diagnostic is bounded and
			// structured; pending identities are reported, not settled.
			return applied(state, [
				{
					kind: 'emit_diagnostic',
					source: 'collection_observer',
					code: `collection_${event.diagnostic}`,
					boundedDetail: event.boundedDetail,
				},
			]);
		}

		case 'lane_structured_result_submitted': {
			if (event.generation !== currentGeneration(state)) {
				return rejected(
					state,
					'stale_generation_result',
					`result generation ${event.generation} does not match the active generation ${currentGeneration(state)}`,
				);
			}
			if (event.existingReceiptDigest !== undefined) {
				if (event.existingReceiptDigest === event.semanticEnvelopeDigest) {
					// Exactly-once: byte/semantic-equivalent replay returns the
					// existing receipt without another transition.
					return applied(state, [
						{
							kind: 'settle_delegation',
							batchId: event.batchId,
							laneId: event.laneId,
							status: 'completed',
							replay: true,
						},
					]);
				}
				return rejected(
					state,
					'duplicate_conflicting_result',
					`lane ${event.laneId} already carries a different structured receipt`,
				);
			}
			// CLEAN / FINDINGS settle completed when the child's ordinary
			// completion event transports the receipt (claimTerminalResult).
			// INCOMPLETE publishes the receipt and leaves the lane UNRESOLVED
			// by design (issue #2384: an incomplete lane is never credited as
			// covered) — no settle effect is emitted for it; coverage treats
			// the unresolved receipt as an unresolved dimension.
			if (event.outcome === 'INCOMPLETE') {
				return applied(state);
			}
			return applied(state, [
				{
					kind: 'settle_delegation',
					batchId: event.batchId,
					laneId: event.laneId,
					status: 'completed',
				},
			]);
		}

		// -----------------------------------------------------------------
		// Circuit
		// -----------------------------------------------------------------
		case 'circuit_advance_requested': {
			const adoption = adoptPrReviewCircuit(
				state.prReviewResilience?.circuit,
				event.nowMs,
			);
			let circuit: PrReviewCircuitRecordV2 | null = null;
			if (adoption.kind === 'v2' || adoption.kind === 'migrated') {
				circuit = adoption.record;
			}
			const decision = advancePrReviewCircuit(circuit, {
				nowMs: event.nowMs,
				threshold: event.policy.correlatedFailureThreshold,
				openDurationMs:
					event.policy.circuitOpenDurationMs ??
					resolvePrReviewResiliencePolicy().circuitOpenDurationMs ??
					60_000,
				admission: event.admission,
				laneSignals: event.laneSignals,
				probeObservation: event.probeObservation,
			});
			const effects: PrReviewEffect[] = [];
			let next = state;
			if (adoption.kind === 'migrated') {
				next = withCircuit(state, adoption.record);
			}
			if (decision.changed && decision.record) {
				next = withCircuit(next, decision.record);
				// An admitted HALF_OPEN probe persists together with the
				// admission's own success write (mark-on-success); every other
				// transition persists immediately.
				if (decision.action !== 'admit_as_probe') {
					effects.push({ kind: 'persist_state' });
				}
			}
			if (decision.action === 'block') {
				effects.push({ kind: 'block_dispatch', reason: decision.reason });
			}
			return applied(next, effects);
		}

		case 'circuit_probe_settled': {
			const circuit = circuitRecordOf(state);
			if (!circuit || circuit.state !== 'HALF_OPEN' || !circuit.probe) {
				return applied(state);
			}
			if (event.outcome.result === 'rolled_back_admission') {
				return applied(
					withCircuit(
						state,
						rollbackPrReviewCircuitProbe(
							circuit,
							event.nowMs,
							event.policy.circuitOpenDurationMs ?? 60_000,
						),
					),
					[{ kind: 'persist_state' }],
				);
			}
			// typed success / provider failure / ignored outcomes flow through
			// the machine's own probe-observation branches on the next
			// advance; the adapter passes the corresponding probeObservation.
			return applied(state);
		}

		case 'resilience_config_changed': {
			if (!event.enabled) {
				// Live disable: the circuit becomes inert; one guarded audit
				// write marks the persisted policy disabled.
				if (!state.prReviewResilience) return applied(state);
				if (state.prReviewResilience.policy.enabled === false) {
					return applied(state);
				}
				return applied(
					{
						...state,
						prReviewResilience: {
							...state.prReviewResilience,
							policy: {
								...state.prReviewResilience.policy,
								enabled: false,
							},
						},
					},
					// The persisted policy-disabled marker IS the #2382
					// detection anchor (the pre-reducer code emitted no core
					// event here).
					[{ kind: 'persist_state' }],
				);
			}
			// Re-enable: fresh v2 CLOSED generation with an evidence waterline
			// at now — pre-disable evidence can never resurrect.
			const policy = resolvePrReviewResiliencePolicy(event.policy);
			return applied(
				{
					...state,
					prReviewResilience: {
						policy,
						attempts: [],
						circuit: resetPrReviewResilienceForReEnable({
							previousCircuit: circuitRecordOf(state),
							policy,
							nowMs: event.nowMs,
						}),
					},
				},
				// The reset record itself (fresh generation + evidence
				// waterline) IS the evidence clear — there is no separate
				// evidence store.
				[{ kind: 'persist_state' }],
			);
		}

		default: {
			// Exhaustiveness: an event kind outside the closed union is a
			// compile error here, and an unknown runtime discriminant is
			// rejected rather than silently ignored.
			const exhausted: never = event;
			void exhausted;
			return rejected(
				state,
				'unknown_event',
				`unknown PR-review event discriminant: ${(event as { type?: string }).type ?? '(none)'}`,
			);
		}
	}
}
