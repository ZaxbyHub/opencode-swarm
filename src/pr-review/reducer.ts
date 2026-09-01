/**
 * PR-review transition authority (issue #2385).
 *
 * Pure `(state, event) -> { state, effects }` reducer over the closed
 * `PrReviewEvent` union. Rule computation is delegated to the focused
 * boundary modules (`circuit.ts`, `completion.ts` via its settlement inputs,
 * `critic-routing.ts`, `lifecycle.ts`); this module owns transition
 * composition and the explicit rejection of every invalid transition class
 * named by issue #2385:
 *
 * - observer deadline / client absence → terminal child failure
 * - raw transcript / parser failure → provider circuit signal
 * - one lane → multiple circuit samples (delegated to circuit.ts's
 *   distinct-`(generation, batch, lane)` scan; asserted by property tests)
 * - unresolved/live lane → terminal coverage report
 * - partial/no coverage → approval
 * - ordinary MEDIUM → critic without typed high-impact/vulnerability evidence
 *   (enforced where critic inventory is composed, via critic-routing.ts)
 * - stale/foreign authorization → reviewer or publication access
 * - late old-generation result → current-state mutation
 * - structured receipt → downgrade by later transcript parsing
 *
 * The owning gate and `dispatch-lanes` are orchestration adapters: they build
 * events from real I/O, apply the returned state, execute the returned
 * effects (persistence through `persistence.ts`, delegation settlement
 * through `pending-delegations.ts`), and map typed rejections to the
 * operator-facing BLOCKED messages.
 */

import {
	advancePrReviewCircuit,
	adoptPrReviewCircuit,
	type PrReviewCircuitRecordV2,
	resetPrReviewResilienceForReEnable,
	resolvePrReviewResiliencePolicy,
	rollbackPrReviewCircuitProbe,
} from './circuit.js';
import { presumedStaleLaneEligible } from './lifecycle.js';
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
		case 'base_admission_requested': {
			const dispatches = state.prReviewBaseDispatches ?? [];
			if (dispatches.length >= event.maxBatches) {
				return rejected(
					state,
					'base_batch_limit_reached',
					`PR_REVIEW base batch limit reached (${dispatches.length} >= ${event.maxBatches})`,
				);
			}
			const record = {
				batchId: event.batchId,
				lanes: event.lanes,
				validatedAt: event.validatedAt,
			};
			const nextDispatches = [...dispatches, record];
			return applied(
				{
					...state,
					prReviewBaseDispatches: nextDispatches,
					prReviewBaseDispatch: record,
				},
				[{ kind: 'persist_state' }],
			);
		}

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
			const status =
				event.outcome === 'INCOMPLETE' ? 'error' : 'completed';
			return applied(state, [
				{
					kind: 'settle_delegation',
					batchId: event.batchId,
					laneId: event.laneId,
					status,
				},
			]);
		}

		case 'transcript_evidence_presented': {
			// A structured receipt can never be downgraded by later transcript
			// parsing (issue #2384 invalid-transition rule).
			if (event.laneHasStructuredReceipt) {
				return rejected(
					state,
					'receipt_cannot_be_downgraded',
					`lane ${event.laneId} has a structured receipt; transcript evidence cannot alter it`,
				);
			}
			return applied(state);
		}

		case 'provider_terminal_observed': {
			if (event.evidence.source === 'observer_deadline') {
				return rejected(
					state,
					'observer_deadline_not_terminal_evidence',
					'a collection wait deadline is never terminal provider evidence',
				);
			}
			if (event.evidence.source === 'client_unavailable') {
				return rejected(
					state,
					'client_absence_not_terminal_evidence',
					'an unavailable host messages client is never terminal provider evidence',
				);
			}
			if (event.evidence.source === 'parser_or_transcript') {
				return rejected(
					state,
					'parser_failure_not_provider_signal',
					'parser/transcript rejection is never a provider circuit signal',
				);
			}
			if (event.evidence.source === 'stale_observation') {
				return rejected(
					state,
					'stale_observation_not_provider_signal',
					'a presumed-stale sweep is never terminal provider evidence',
				);
			}
			if (event.generation !== currentGeneration(state)) {
				return rejected(
					state,
					'stale_generation_result',
					`terminal evidence generation ${event.generation} is not the active generation`,
				);
			}
			// Admitted as typed circuit evidence; the durable ledger owns the
			// record and the next circuit advance consumes it.
			return applied(state);
		}

		case 'lane_cancelled': {
			if (event.generation !== currentGeneration(state)) {
				return rejected(
					state,
					'stale_generation_result',
					`cancellation generation ${event.generation} does not match the active generation`,
				);
			}
			return applied(state, [
				{
					kind: 'settle_delegation',
					batchId: event.batchId,
					laneId: event.laneId,
					status: 'cancelled',
				},
			]);
		}

		case 'presumed_stale_swept': {
			const eligible = presumedStaleLaneEligible(
				{
					status: event.status,
					ageMs: event.ageMs,
					liveness: event.liveness,
				},
				event.staleTimeoutMs,
			);
			if (!eligible) {
				return rejected(
					state,
					'lane_not_stale_eligible',
					`lane ${event.laneId} does not meet the presumed-stale eligibility rule`,
				);
			}
			return applied(state, [
				{
					kind: 'settle_delegation',
					batchId: event.batchId,
					laneId: event.laneId,
					status: 'stale',
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
					[
						{ kind: 'persist_state' },
						{ kind: 'append_audit_event', code: 'resilience_disabled' },
					],
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
				[
					{ kind: 'persist_state' },
					{ kind: 'clear_resilience_evidence' },
				],
			);
		}

		// -----------------------------------------------------------------
		// Coverage / completion
		// -----------------------------------------------------------------
		case 'coverage_finalization_requested': {
			const { settlement } = event;
			if (settlement.liveDimensions.length > 0) {
				return rejected(
					state,
					'live_lane_blocks_coverage',
					`coverage finalization blocked by live dimension(s): ${settlement.liveDimensions.join(', ')}`,
				);
			}
			const verdict = event.requestedVerdict;
			if (verdict === 'APPROVE') {
				if (settlement.kind === 'PARTIAL') {
					return rejected(
						state,
						'partial_coverage_cannot_approve',
						'a partial review can never emit APPROVE',
					);
				}
				if (settlement.kind === 'NO_COVERAGE') {
					return rejected(
						state,
						'no_coverage_cannot_approve',
						'a zero-coverage report can never emit APPROVE',
					);
				}
			}
			return applied(state, [
				{ kind: 'persist_state' },
				{
					kind: 'append_audit_event',
					code: `coverage_${settlement.kind.toLowerCase()}`,
					boundedDetail: settlement.unresolvedDimensions
						.map((entry) => `${entry.dimension}:${entry.terminalState}`)
						.join(','),
				},
			]);
		}

		case 'critic_result_recorded': {
			const unfulfilled = event.criticRequiredFindingIds.filter(
				(id) => !event.criticConfirmedFindingIds.includes(id),
			);
			if (unfulfilled.length > 0) {
				return rejected(
					state,
					'critic_required_unfulfilled',
					`critic confirmation missing for finding(s): ${unfulfilled.join(', ')}`,
				);
			}
			return applied(state, [{ kind: 'persist_state' }]);
		}

		// -----------------------------------------------------------------
		// Publication / recovery / authorization
		// -----------------------------------------------------------------
		case 'publication_armed': {
			if (
				event.verdict === 'APPROVE' &&
				event.coverageKind !== 'COMPLETE'
			) {
				return rejected(
					state,
					event.coverageKind === 'NO_COVERAGE'
						? 'no_coverage_cannot_approve'
						: 'partial_coverage_cannot_approve',
					`cannot arm publication of ${event.verdict} on ${event.coverageKind} coverage`,
				);
			}
			return applied(state, [{ kind: 'persist_state' }]);
		}

		case 'publication_published':
		case 'armed_recovery_requested':
		case 'reviewer_authorization_consumed': {
			const reason = bindingRejection(state, event);
			if (reason) {
				return rejected(
					state,
					'stale_foreign_authorization',
					reason.detail,
				);
			}
			if (
				event.type === 'reviewer_authorization_consumed' &&
				event.role !== event.expectedRole
			) {
				return rejected(
					state,
					'stale_foreign_authorization',
					`authorization role ${event.role} does not match the expected role ${event.expectedRole}`,
				);
			}
			if (event.type === 'armed_recovery_requested') {
				const cancellations = {
					...(state.prReviewDimensionCancellations ?? {}),
				};
				for (const dimension of event.dimensionsToCancel) {
					cancellations[dimension] = {
						reason: 'armed-recovery cancellation of remaining lanes',
						cancelledAt: event.nowIso,
						source: 'armed_recovery',
					};
				}
				return applied(
					{ ...state, prReviewDimensionCancellations: cancellations },
					[
						{ kind: 'persist_state' },
						{ kind: 'append_audit_event', code: 'armed_recovery_executed' },
						{ kind: 'invalidate_publication_authorization' },
					],
				);
			}
			return applied(state, [{ kind: 'persist_state' }]);
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

function bindingRejection(
	state: PrReviewWorkflowState,
	event:
		| Extract<PrReviewEvent, { type: 'publication_published' }>
		| Extract<PrReviewEvent, { type: 'armed_recovery_requested' }>
		| Extract<PrReviewEvent, { type: 'reviewer_authorization_consumed' }>,
): { detail: string } | null {
	const binding = event.binding;
	if (binding.sessionID !== state.sessionID) {
		return { detail: `authorization session ${binding.sessionID} is foreign to the active workflow session` };
	}
	if (
		binding.workflowInstanceId !== undefined &&
		state.workflowInstanceId !== undefined &&
		binding.workflowInstanceId !== state.workflowInstanceId
	) {
		return { detail: 'authorization belongs to a different workflow instance' };
	}
	if (!state.prHeadSha || binding.prHeadSha !== state.prHeadSha) {
		return { detail: `authorization head ${binding.prHeadSha} does not match the bound head` };
	}
	if (binding.generation !== currentGeneration(state)) {
		return { detail: `authorization generation ${binding.generation} is stale (active: ${currentGeneration(state)})` };
	}
	return null;
}
