import { appendCoreEventSync } from '../../events/core-events.js';
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
	| 'duplicate_result';

export const STAGE_A_ROUTES: readonly StageAGateRoute[] = [
	'valid_pass',
	'pre_check_failed',
	'invalid_result',
	'no_task_correlation',
	'attribution_ambiguous',
	'late_result',
	'duplicate_result',
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
}

export const _internals = {
	buildEvent,
	boundedId,
	append: appendCoreEventSync,
};
