/**
 * Best-effort observability projection for authoritative receipt transitions.
 * The V2 journal remains authoritative; telemetry runs best-effort after commit.
 */
import { emit } from '../telemetry.js';
import type { ReceiptOutcome } from './knowledge-receipt-validator.js';

/**
 * Semantic version of the outcome/source MEANING contract (issue #2032).
 * 1 = pre-#2032 producer semantics (outcome words meant different things per
 * producer; delegate terminals carried no source). 2 = the #2032 atomic
 * semantics: one typed outcome/source vocabulary, delegate terminals stamped
 * `source: 'delegate'`, `n_a` neutral everywhere, legacy ambiguity `unknown`.
 * Distinct from the journal `RECEIPT_SCHEMA_VERSION` (a hard format gate).
 * Bump this whenever a producer or consumer changes what an outcome or source
 * MEANS, so health/reports consumers can distinguish producer behavior and
 * migration uncertainty.
 */
export const RECEIPT_SEMANTICS_VERSION = 2;

/**
 * Outcomes observable on a transition. Terminal outcomes plus the trace-level
 * `no_relevant` tombstone that closes an empty retrieval (not a terminal).
 */
export type ReceiptObservationOutcome = ReceiptOutcome | 'no_relevant';

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
	receiptOutcome?: ReceiptObservationOutcome;
	/** Bounded domain code only; arbitrary prose is deliberately rejected. */
	receiptSource?: string;
	/**
	 * Outcome/source semantics contract version. Optional so existing ledger
	 * observation constructors need no churn; the emitter defaults it to
	 * {@link RECEIPT_SEMANTICS_VERSION}.
	 */
	receiptSemantics?: number;
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

const RECEIPT_OUTCOMES = new Set<ReceiptObservationOutcome>([
	'applied',
	'ignored',
	'contradicted',
	'violated',
	'n_a',
	'no_relevant',
]);

// BOUNDED_CODE is the post-#2032 stable contract for receiptSource; further
// extensions require a RECEIPT_SEMANTICS_VERSION bump.
const BOUNDED_CODE = /^[a-z][a-z0-9_-]{0,63}$/;

function boundedCode(value: unknown): string | undefined {
	return typeof value === 'string' && BOUNDED_CODE.test(value)
		? value
		: undefined;
}

function boundedPhase(value: unknown): string | undefined {
	const code = boundedCode(value);
	return code && /^phase(?:[_-][a-z0-9_-]+)?$/.test(code) ? code : undefined;
}

function addIdentifier(
	payload: Record<string, unknown>,
	key: string,
	value: unknown,
): void {
	if (typeof value === 'string' && value.length > 0) payload[key] = value;
}

/** Emit bounded diagnostics fail-open after an authoritative transition. */
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
		const semanticsVersion =
			observation.receiptSemantics ?? RECEIPT_SEMANTICS_VERSION;
		if (Number.isSafeInteger(semanticsVersion) && semanticsVersion >= 1) {
			payload.receiptSemantics = semanticsVersion;
		}
		addIdentifier(payload, 'knowledgeTraceId', observation.knowledgeTraceId);
		addIdentifier(payload, 'knowledgeEntryId', observation.knowledgeEntryId);
		addIdentifier(payload, 'sessionId', observation.sessionId);
		addIdentifier(payload, 'taskId', observation.taskId);
		addIdentifier(payload, 'phase', boundedPhase(observation.phase));

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
