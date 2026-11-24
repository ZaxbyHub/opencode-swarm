import { appendCoreEventSync } from '../../events/core-events.js';
import {
	type ExecutionAttemptClass,
	recordExecutionAttempt,
} from '../../services/execution-attempt.js';
import { warn } from '../../utils/logger.js';

/**
 * Stage A attribution route events (issue #2664).
 *
 * MANDATORY lifecycle bookkeeping: every completed gate-tool call outcome is
 * recorded as ONE bounded event in the core event store, in BOTH guardrails
 * modes. Optional enforcement (`guardrails.enabled=false`) removes policy
 * denials only — it never suppresses these receipts.
 *
 * Bounded by construction: route is a member of the closed vocabulary, IDs
 * are sanitized and sliced, and the serialized line stays far under both the
 * frozen 2048-byte contract bound and the store's 256 KiB maxLineBytes, so
 * the store's typed CORE_EVENT_LINE_TOO_LARGE / CORE_EVENT_LOCKED failures
 * are practically unreachable. The catch exists so a locked-store storm can
 * never turn a logged route event into a thrown exception inside the
 * lifecycle hook (plan-critic R1-F1).
 */

export type StageAGateRoute =
	| 'valid_pass'
	| 'pre_check_failed'
	| 'invalid_result'
	| 'no_task_correlation'
	| 'attribution_ambiguous'
	| 'late_result'
	| 'duplicate_result'
	| 'terminal_settlement_wedge';

export const STAGE_A_ROUTES: readonly StageAGateRoute[] = [
	'valid_pass',
	'pre_check_failed',
	'invalid_result',
	'no_task_correlation',
	'attribution_ambiguous',
	'late_result',
	'duplicate_result',
	'terminal_settlement_wedge',
] as const;

export const STAGE_A_ROUTE_EVENT_TYPE = 'stage_a_gate_route';

/** Sanitize an identifier for event emission: printable, bounded. */
function boundedId(value: string | null | undefined): string | null {
	if (typeof value !== 'string') return null;
	const cleaned = value.replace(/[\r\n\t]/g, '_').trim();
	if (cleaned === '') return null;
	return cleaned.slice(0, 128);
}

export interface StageAGateRouteEventInput {
	route: StageAGateRoute;
	sessionID: string;
	callID: string;
	/** Attributed task, or null when no single task is attributable. */
	taskId: string | null;
	guardrailsEnabled: boolean;
	/**
	 * The correlation's workflow generation cursor, when the caller holds one
	 * (the guardrails pending-gate-task map carries it). Required for the
	 * `late` attempt class to be recordable; absent leaves the recorder's
	 * fail-open refusal in force.
	 */
	generation?: number;
}

function buildEvent(input: StageAGateRouteEventInput): Record<string, unknown> {
	return {
		type: STAGE_A_ROUTE_EVENT_TYPE,
		route: input.route,
		sessionID: boundedId(input.sessionID),
		callID: boundedId(input.callID),
		taskId: boundedId(input.taskId),
		guardrailsEnabled: input.guardrailsEnabled === true,
		ts: new Date().toISOString(),
	};
}

/**
 * Route → execution-attempt class (issue #2676). Stage A route events fire at
 * gate-tool-call COMPLETION (toolAfter), so `valid_pass` is the completed
 * call's outcome record (`result`, success); the five refusal routes are
 * `denial` (outcome unknown — the gate refused before a task outcome
 * existed); `late_result` is `late`; `duplicate_result` is `duplicate`.
 */
export function stageARouteAttemptClass(
	route: StageAGateRoute,
): ExecutionAttemptClass {
	switch (route) {
		case 'valid_pass':
			return 'result';
		case 'pre_check_failed':
		case 'invalid_result':
		case 'no_task_correlation':
		case 'attribution_ambiguous':
		case 'terminal_settlement_wedge':
			return 'denial';
		case 'late_result':
			return 'late';
		case 'duplicate_result':
			return 'duplicate';
	}
}

/**
 * Record one Stage A route event. Fail-open for the hook: append failures
 * (typed CORE_EVENT_LOCKED / CORE_EVENT_LINE_TOO_LARGE) are logged warn-only
 * and never propagate into the lifecycle path. The exactly-one-event
 * contract holds under a healthy store; the warn line is the disclosure for
 * the exceptional window.
 */
export function recordStageAGateRoute(
	directory: string,
	input: StageAGateRouteEventInput,
): void {
	if (!STAGE_A_ROUTES.includes(input.route)) {
		warn('Stage A route event rejected: route outside closed vocabulary', {
			route: String(input.route),
		});
		return;
	}
	try {
		appendCoreEventSync(directory, buildEvent(input));
	} catch (error) {
		warn('Stage A route event append failed', {
			code: error instanceof Error ? error.message.slice(0, 80) : String(error),
			route: input.route,
		});
	}
	// Issue #2676: the same completed gate-tool call is also an
	// execution-attempt record. The hook natively holds `sessionID`/`callID`
	// (PascalCase) — normalized here to the recorder's lowercase join keys.
	// A `late` record without a generation cursor and a `duplicate` without
	// an original identity are refused inside the recorder (fail-open warn):
	// the seam threads the generation when the pending-gate-task map holds
	// it, and holds no original record identity for duplicates.
	recordExecutionAttempt({
		sessionId: input.sessionID ?? undefined,
		callId: input.callID ?? undefined,
		taskId: input.taskId ?? undefined,
		...(typeof input.generation === 'number'
			? { generation: input.generation }
			: {}),
		attemptClass: stageARouteAttemptClass(input.route),
		outcomeStatus: input.route === 'valid_pass' ? 'success' : 'unknown',
	});
}

export const _internals = {
	buildEvent,
	boundedId,
	append: appendCoreEventSync,
};
