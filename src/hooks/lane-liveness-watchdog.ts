/**
 * Issue #2506 (G2): the lane-liveness watchdog — typed liveness conditions,
 * the unified PR-lane settlement horizon, and stall-escalation policy for
 * PR-workflow lanes.
 *
 * Reimplemented on this repository's own settlement substrate per ADR 0002
 * (`docs/decisions/0002-opencode-ensemble-adoption.md`). The parameter
 * surface (timeoutMs 30 min, stallThresholdMs 5 min, stallMinSteps 5,
 * stallTokenThreshold 200, 0-disables) and the re-nudge-suppression idea
 * (never re-escalate a lane that has had no activity since the last
 * escalation) are adopted from opencode-ensemble with credit; NO upstream
 * code, strings, or assets are ported.
 *
 * The module is pure policy: it classifies, resolves, and decides. All I/O
 * (session status probes, aborts, event appends) stays behind the gate's
 * existing seams so the watchdog can never bypass the shared settlement
 * path or its evidence gates.
 */
import { DEFAULT_STALE_DELEGATION_TIMEOUT_MS } from '../background/pending-delegations.js';
import type { LaneLivenessWatchdogConfig } from '../config/schema.js';
import { LaneLivenessWatchdogConfigSchema } from '../config/schema.js';

/** The five frozen defaults from the #2506 contract (0 disables a feature). */
export const LANE_LIVENESS_WATCHDOG_DEFAULTS: LaneLivenessWatchdogConfig =
	LaneLivenessWatchdogConfigSchema.parse({});

/**
 * Upper bound on lane ids named in one `pr_workflow_lane_watchdog` event or
 * disclosure. Defined here (not imported from the gate) so this module never
 * depends on the gate layer.
 */
export const MAX_LANE_LIVENESS_DISCLOSED_IDS = 10;

/**
 * The typed liveness conditions #2506 requires to be distinguishable. A
 * temporarily slow provider or an expired observation budget must never be
 * reported as child failure.
 *
 * - `observer_deadline` — the CALLER's collection wait budget expired while
 *   the session is live or unknown. Says nothing about the child; never a
 *   terminal transition.
 * - `provider_retry_in_flight` — the host reports the session in `retry`:
 *   provider latency with its own bounded retry owner. Retained.
 * - `completed_failure` — the ledger already holds a terminal error: the
 *   lane completed, with a real (failed) outcome.
 * - `idle_failed_child` — an open record whose session is idle or absent
 *   below the horizon: the child failed without a terminal write.
 * - `execution_deadline` — the lane exceeded the effective execution
 *   horizon: aborted best-effort and settled with its real outcome.
 */
export type LaneLivenessCondition =
	| 'observer_deadline'
	| 'provider_retry_in_flight'
	| 'completed_failure'
	| 'idle_failed_child'
	| 'execution_deadline';

export interface ClassifyLaneLivenessInput {
	/** Host session status type, when a probe ran. `undefined` = unknown. */
	sessionStatusType?: string;
	/** Ledger record status string (e.g. `pending`, `running`, `error`). */
	recordStatus: string;
	/** Whether the caller's observation/collection budget expired. */
	waitBudgetExpired: boolean;
	/** Whether the lane's age exceeds the EFFECTIVE horizon. */
	exceededEffectiveHorizon: boolean;
}

/**
 * Classify one lane's liveness with the frozen precedence
 * `completed_failure > observer_deadline > provider_retry_in_flight >
 * execution_deadline > idle_failed_child`:
 * a terminal error is a real outcome and wins over every in-flight signal;
 * an expired observation budget on a live-or-unknown session is observer
 * noise, not child failure; a `retry` session is provider latency even past
 * the horizon; only then may the execution deadline fire; everything else
 * is an open, low-signal lane below the horizon.
 */
export function classifyLaneLivenessCondition(
	input: ClassifyLaneLivenessInput,
): LaneLivenessCondition {
	if (input.recordStatus === 'error') {
		return 'completed_failure';
	}
	const sessionLiveOrUnknown =
		input.sessionStatusType === undefined ||
		input.sessionStatusType === 'busy' ||
		input.sessionStatusType === 'retry';
	if (input.waitBudgetExpired && sessionLiveOrUnknown) {
		return 'observer_deadline';
	}
	if (input.sessionStatusType === 'retry') {
		return 'provider_retry_in_flight';
	}
	if (input.exceededEffectiveHorizon) {
		return 'execution_deadline';
	}
	return 'idle_failed_child';
}

export interface EffectivePrLaneHorizon {
	/** The ONE effective PR-lane settlement horizon, in ms. */
	horizonMs: number;
	/** Which configured value won. */
	source: 'watchdog-timeout' | 'reachability-floor';
	/**
	 * True when `backgroundPendingTimeoutMs` was provided, is > 0, and
	 * disagrees with the effective horizon. The disagreement is disclosed,
	 * never resolved into a second horizon.
	 */
	conflictDisclosed: boolean;
}

/**
 * Resolve the single effective PR-lane settlement horizon (#2506 AC2).
 *
 * Precedence: an ENABLED watchdog with `timeout_ms > 0` owns the horizon;
 * everything else (no config, `enabled: false`, or `timeout_ms: 0` — "0
 * disables the feature") falls back to the 30-minute reachability floor
 * (`DEFAULT_STALE_DELEGATION_TIMEOUT_MS`), which must never disappear: it is
 * the guarantee that abort and completion cannot be permanently blocked by a
 * lane whose backing process died.
 */
export function resolveEffectivePrLaneHorizonMs(
	watchdog?: LaneLivenessWatchdogConfig,
	backgroundPendingTimeoutMs?: number,
): EffectivePrLaneHorizon {
	const watchdogOwnsHorizon =
		watchdog?.enabled === true && (watchdog.timeout_ms ?? 0) > 0;
	const horizonMs = watchdogOwnsHorizon
		? (watchdog?.timeout_ms as number)
		: DEFAULT_STALE_DELEGATION_TIMEOUT_MS;
	return {
		horizonMs,
		source: watchdogOwnsHorizon ? 'watchdog-timeout' : 'reachability-floor',
		conflictDisclosed:
			backgroundPendingTimeoutMs !== undefined &&
			backgroundPendingTimeoutMs > 0 &&
			backgroundPendingTimeoutMs !== horizonMs,
	};
}

/** Per-lane activity within the last `stall_threshold_ms` window. */
export interface LaneActivity {
	/** Observable transcript steps in the window. */
	stepsObserved: number;
	/**
	 * Token ESTIMATE derived from transcript text length — the host API does
	 * not expose provider-true token counts; every surface that reports this
	 * value must label it an estimate.
	 */
	estimatedTokens: number;
	/** Epoch-ms timestamp of the last observed activity, when known. */
	lastActivityAtMs?: number;
}

export const ZERO_LANE_ACTIVITY: LaneActivity = {
	stepsObserved: 0,
	estimatedTokens: 0,
};

/** The overridable activity reader the gate seam exposes for tests. */
export type ReadLaneActivity = (
	directory: string,
	subagentSessionId: string,
) => LaneActivity | null | Promise<LaneActivity | null>;

/**
 * Default transcript-derived activity reader. The host API exposes no
 * per-session token counts and no bounded transcript read on this path (a
 * per-lane `session.messages` call would violate the frozen one-status-call
 * budget), so a lane with no stored activity information reads as ZERO
 * activity — the conservative direction for stall escalation (escalate,
 * then let the operator inspect). This is the #2506 frozen contract: "an
 * absent transcript reads as zero activity".
 */
export const defaultReadLaneActivity: ReadLaneActivity = () =>
	ZERO_LANE_ACTIVITY;

/** Feature activation derived from the config (each knob disables at 0). */
export function laneLivenessWatchdogFeatures(
	watchdog?: LaneLivenessWatchdogConfig,
): {
	deadlineActive: boolean;
	stallActive: boolean;
} {
	const enabled = watchdog?.enabled === true;
	return {
		deadlineActive: enabled && (watchdog?.timeout_ms ?? 0) > 0,
		stallActive:
			enabled &&
			(watchdog?.stall_threshold_ms ?? 0) > 0 &&
			(watchdog?.stall_min_steps ?? 0) > 0 &&
			(watchdog?.stall_token_threshold ?? 0) > 0,
	};
}
