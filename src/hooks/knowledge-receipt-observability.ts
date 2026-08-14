/**
 * Best-effort observability projection for authoritative receipt transitions.
 *
 * The V2 receipt journal is authoritative: telemetry failure must never change
 * whether a transition commits, and telemetry must only run after that commit.
 */
import { emit } from '../telemetry.js';
import type { ReceiptOutcome } from './knowledge-receipt-validator.js';

export type KnowledgeReceiptObservedTransition =
	| 'membership_committed'
	| 'empty_retrieval_committed'
	| 'terminal_committed'
	| 'terminal_attempt_rejected'
	| 'terminal_attempt_idempotent'
	| 'authorized_transition_committed'
	| 'application_marker_committed'
	| 'phase_close_intent'
	| 'phase_closed'
	| 'legacy_imported'
	| 'legacy_unverifiable'
	| 'cutover_completed'
	| 'checkpoint';

export type KnowledgeReceiptObservationReasonCode =
	| 'committed'
	| 'idempotent'
	| 'trace_not_found'
	| 'id_not_in_trace'
	| 'wrong_session'
	| 'wrong_phase'
	| 'wrong_task'
	| 'duplicate_conflicting_terminal'
	| 'event_id_conflict'
	| 'invalid_outcome'
	| 'empty_receipt'
	| 'lock_timeout'
	| 'store_unavailable'
	| 'store_corrupt'
	| 'legacy_unverifiable'
	| 'unauthorized_transition';

export interface KnowledgeReceiptTransitionObservation {
	transition: KnowledgeReceiptObservedTransition;
	reasonCode: KnowledgeReceiptObservationReasonCode;
	schemaVersion: number;
	knowledgeTraceId?: string;
	knowledgeEntryId?: string;
	sessionId?: string;
	taskId?: string;
	phase?: string;
	/** Domain value only; never projected to the generic observability outcome. */
	receiptOutcome?: ReceiptOutcome;
	/** Bounded domain code only; arbitrary prose is deliberately rejected. */
	receiptSource?: string;
}

const TRANSITIONS = new Set<KnowledgeReceiptObservedTransition>([
	'membership_committed',
	'empty_retrieval_committed',
	'terminal_committed',
	'terminal_attempt_rejected',
	'terminal_attempt_idempotent',
	'authorized_transition_committed',
	'application_marker_committed',
	'phase_close_intent',
	'phase_closed',
	'legacy_imported',
	'legacy_unverifiable',
	'cutover_completed',
	'checkpoint',
]);

const REASON_CODES = new Set<KnowledgeReceiptObservationReasonCode>([
	'committed',
	'idempotent',
	'trace_not_found',
	'id_not_in_trace',
	'wrong_session',
	'wrong_phase',
	'wrong_task',
	'duplicate_conflicting_terminal',
	'event_id_conflict',
	'invalid_outcome',
	'empty_receipt',
	'lock_timeout',
	'store_unavailable',
	'store_corrupt',
	'legacy_unverifiable',
	'unauthorized_transition',
]);

const RECEIPT_OUTCOMES = new Set<ReceiptOutcome>([
	'applied',
	'ignored',
	'contradicted',
	'violated',
	'n_a',
	'no_relevant',
]);

// Keeps source extensible until #2032 normalizes domain semantics while still
// forbidding whitespace, prose, paths, and unbounded attacker-controlled text.
const BOUNDED_CODE = /^[a-z][a-z0-9_-]{0,63}$/;

function addIdentifier(
	payload: Record<string, unknown>,
	key: string,
	value: unknown,
): void {
	if (typeof value === 'string' && value.length > 0) payload[key] = value;
}

/**
 * Emit a bounded diagnostic projection after an authoritative transition.
 * Invalid input or telemetry failure is fail-open and produces no exception.
 */
export function emitKnowledgeReceiptTransition(
	observation: KnowledgeReceiptTransitionObservation,
): void {
	try {
		if (
			!TRANSITIONS.has(observation.transition) ||
			!REASON_CODES.has(observation.reasonCode) ||
			!Number.isSafeInteger(observation.schemaVersion) ||
			observation.schemaVersion < 1
		) {
			return;
		}

		const payload: Record<string, unknown> = {
			transition: observation.transition,
			reasonCode: observation.reasonCode,
			schemaVersion: observation.schemaVersion,
		};
		addIdentifier(payload, 'knowledgeTraceId', observation.knowledgeTraceId);
		addIdentifier(payload, 'knowledgeEntryId', observation.knowledgeEntryId);
		addIdentifier(payload, 'sessionId', observation.sessionId);
		addIdentifier(payload, 'taskId', observation.taskId);
		addIdentifier(payload, 'phase', observation.phase);

		if (
			observation.receiptOutcome !== undefined &&
			RECEIPT_OUTCOMES.has(observation.receiptOutcome)
		) {
			payload.receiptOutcome = observation.receiptOutcome;
		}
		if (
			typeof observation.receiptSource === 'string' &&
			BOUNDED_CODE.test(observation.receiptSource)
		) {
			payload.receiptSource = observation.receiptSource;
		}

		_internals.emit('knowledge_receipt_transition', payload);
	} catch {
		// Diagnostics are never part of receipt correctness or availability.
	}
}

/** Dependency seam for focused fail-open tests. */
export const _internals = { emit };
