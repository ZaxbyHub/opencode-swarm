/**
 * Issue #2473 (AC6/AC7) — frozen per-scenario launch budget manifest.
 *
 * This is a NON-TEST sibling module consumed by
 * `dispatch-lanes-launch-budget-2473.test.ts`. It freezes, for each launch
 * scenario, the effective configuration, the retry owner, and explicit INTEGER
 * bounds (`max_host_launches`, `max_attempts`, `wall_clock_ms`), plus SEPARATE
 * accounting rows for the four launch-retry/wake mechanisms:
 *
 *   1. same-model transient retry   — src/utils/model-dispatch-fallback.ts
 *      (both dispatch-lanes launch callbacks pass `maxTransientRetriesPerModel: 0`)
 *   2. model fallback               — src/utils/model-dispatch-fallback.ts
 *      (bound = configured fallback chain length)
 *   3. collection observation       — src/tools/dispatch-lanes.ts collect loop
 *      (poll backoff: initial 500 ms, doubling, ceiling 10 000 ms — derived
 *      below from `_test_exports.nextCollectPollInterval`, the same function
 *      the production collect loop uses)
 *   4. response wake                — src/background/pr-event-delivery.ts
 *      (`WAKE_PROMPT_TIMEOUT_MS`, imported)
 *
 * Integer values are DERIVED from the configured contract where possible:
 * `MAX_SESSION_CREATE_GENERATIONS` is imported from
 * `src/tools/dispatch-lanes.js`. At the issue-2473 base commit that const is
 * module-private, so this static import fails to load — intentional NEW-SURFACE
 * behavior pinning that the fix must export the existing contract constant
 * (never a re-hardcoded copy of its value).
 */
import { WAKE_PROMPT_TIMEOUT_MS } from '../../../src/background/pr-event-delivery.js';
import {
	_test_exports as dispatchLanesContract,
	MAX_SESSION_CREATE_GENERATIONS,
} from '../../../src/tools/dispatch-lanes.js';

/** The four launch-retry/wake mechanisms that must be accounted separately (AC7). */
export const LAUNCH_MECHANISM_KEYS = [
	'same_model_transient_retry',
	'model_fallback',
	'collection_observation',
	'response_wake',
] as const;

export type LaunchMechanismKey = (typeof LAUNCH_MECHANISM_KEYS)[number];

/**
 * Mechanism-qualified owner keys. Same-model retry and model fallback live in
 * the same source file but are DISTINCT mechanisms, so the owner key carries a
 * `#mechanism` qualifier — the four owner strings are pairwise distinct.
 */
export const LAUNCH_MECHANISM_OWNERS: Record<LaunchMechanismKey, string> = {
	same_model_transient_retry:
		'src/utils/model-dispatch-fallback.ts#same-model-transient-retry',
	model_fallback: 'src/utils/model-dispatch-fallback.ts#model-fallback',
	collection_observation: 'src/tools/dispatch-lanes.ts#collect-poll-loop',
	response_wake: 'src/background/pr-event-delivery.ts#wake-prompt-timeout',
};

export type MechanismAccountingRow = {
	mechanism: LaunchMechanismKey;
	owner: string;
	/** Explicit integer bound for this mechanism, in `unit` units. */
	bound: number;
	unit: 'attempts' | 'models' | 'ms';
	note: string;
};

export type ScenarioBudgetRow = {
	scenario: string;
	/** Which mechanism (if any) owns retries for this scenario. */
	retry_owner: string;
	/** The effective configuration the bounds are derived from. */
	effective_configuration: Record<string, string | number | boolean>;
	/** Maximum host-side launch calls (session.create + prompt + promptAsync). */
	max_host_launches: number;
	/** Maximum total attempts (host launches + same-model retries at launch). */
	max_attempts: number;
	/** Wall-clock ceiling for the scenario, in integer ms. */
	wall_clock_ms: number;
	/** Separate per-mechanism accounting — one row per mechanism, never conflated. */
	mechanisms: Record<LaunchMechanismKey, MechanismAccountingRow>;
};

export type ObservedLaunchCounts = {
	host_launches: number;
	attempts: number;
	wall_clock_ms?: number;
};

// ── Contract values (derived, never hand-copied where derivable) ──────────

/** Configured create-retry cap (the contract constant the fix must export). */
export const CONTRACT_MAX_SESSION_CREATE_GENERATIONS =
	MAX_SESSION_CREATE_GENERATIONS;
/** Blocking dispatch default timeout (ms). */
export const CONTRACT_DEFAULT_TIMEOUT_MS =
	dispatchLanesContract.DEFAULT_TIMEOUT_MS;
/** Async launch default timeout (ms). */
export const CONTRACT_DEFAULT_ASYNC_LAUNCH_TIMEOUT_MS =
	dispatchLanesContract.DEFAULT_ASYNC_LAUNCH_TIMEOUT_MS;
/** Collect poll interval floor (ms) — derived via the production poll function. */
export const CONTRACT_COLLECT_POLL_FLOOR_MS =
	dispatchLanesContract.nextCollectPollInterval(0);
/** Collect poll interval ceiling (ms) — derived via the production poll function. */
export const CONTRACT_COLLECT_POLL_CEILING_MS =
	dispatchLanesContract.nextCollectPollInterval(
		CONTRACT_COLLECT_POLL_FLOOR_MS * 40,
	);
/** Response wake timeout (ms) — imported from its owner module. */
export const CONTRACT_WAKE_PROMPT_TIMEOUT_MS = WAKE_PROMPT_TIMEOUT_MS;
/** Same-model transient retries configured at BOTH launch classify sites. */
export const CONTRACT_SAME_MODEL_TRANSIENT_RETRIES_AT_LAUNCH = 0;

function mechanismRows(
	fallbackChainLength: number,
): Record<LaunchMechanismKey, MechanismAccountingRow> {
	return {
		same_model_transient_retry: {
			mechanism: 'same_model_transient_retry',
			owner: LAUNCH_MECHANISM_OWNERS.same_model_transient_retry,
			bound: CONTRACT_SAME_MODEL_TRANSIENT_RETRIES_AT_LAUNCH,
			unit: 'attempts',
			note: 'dispatch-lanes launch callbacks pass maxTransientRetriesPerModel: 0',
		},
		model_fallback: {
			mechanism: 'model_fallback',
			owner: LAUNCH_MECHANISM_OWNERS.model_fallback,
			bound: fallbackChainLength,
			unit: 'models',
			note: 'bound = configured fallback chain length',
		},
		collection_observation: {
			mechanism: 'collection_observation',
			owner: LAUNCH_MECHANISM_OWNERS.collection_observation,
			bound: CONTRACT_COLLECT_POLL_CEILING_MS,
			unit: 'ms',
			note: `collect poll backoff ceiling (initial ${CONTRACT_COLLECT_POLL_FLOOR_MS} ms, doubling, capped)`,
		},
		response_wake: {
			mechanism: 'response_wake',
			owner: LAUNCH_MECHANISM_OWNERS.response_wake,
			bound: CONTRACT_WAKE_PROMPT_TIMEOUT_MS,
			unit: 'ms',
			note: 'WAKE_PROMPT_TIMEOUT_MS-bounded wake prompt',
		},
	};
}

function scenarioRow(input: {
	scenario: string;
	retry_owner: string;
	effective_configuration: Record<string, string | number | boolean>;
	max_host_launches: number;
	max_attempts: number;
	wall_clock_ms: number;
	fallback_models_configured: number;
}): ScenarioBudgetRow {
	return {
		scenario: input.scenario,
		retry_owner: input.retry_owner,
		effective_configuration: {
			...input.effective_configuration,
			same_model_transient_retries_at_launch:
				CONTRACT_SAME_MODEL_TRANSIENT_RETRIES_AT_LAUNCH,
		},
		max_host_launches: input.max_host_launches,
		max_attempts: input.max_attempts,
		wall_clock_ms: input.wall_clock_ms,
		mechanisms: mechanismRows(input.fallback_models_configured),
	};
}

/**
 * The frozen per-scenario budget manifest (AC6). Every row is validated at
 * module load — a row with an unspecified or non-integer bound cannot even
 * load, let alone pass.
 */
export const LAUNCH_SCENARIO_BUDGETS: readonly ScenarioBudgetRow[] = [
	scenarioRow({
		scenario: 'create-transient-retry',
		retry_owner:
			'src/tools/dispatch-lanes.ts#createLaneSession (pre-prompt session.create retry)',
		effective_configuration: {
			entry: 'executeDispatchLanes',
			create_generations: CONTRACT_MAX_SESSION_CREATE_GENERATIONS,
			fallback_models_configured: 0,
			transient_create_failure: '503-returned-error-result',
			timeout_ms: CONTRACT_DEFAULT_TIMEOUT_MS,
		},
		max_host_launches: CONTRACT_MAX_SESSION_CREATE_GENERATIONS + 1,
		max_attempts: CONTRACT_MAX_SESSION_CREATE_GENERATIONS + 1,
		wall_clock_ms: CONTRACT_DEFAULT_TIMEOUT_MS,
		fallback_models_configured: 0,
	}),
	scenarioRow({
		scenario: 'ambiguous-transport-single-shot',
		retry_owner:
			'none — a thrown transport failure (no server response) cannot prove non-acceptance; the launch stays single-shot',
		effective_configuration: {
			entry: 'executeDispatchLanesAsync',
			create_generations: CONTRACT_MAX_SESSION_CREATE_GENERATIONS,
			fallback_models_configured: 1,
			launch_timeout_ms: CONTRACT_DEFAULT_ASYNC_LAUNCH_TIMEOUT_MS,
			ambiguous_failure: 'thrown ECONNRESET at session.promptAsync',
		},
		max_host_launches: 2,
		max_attempts: 2,
		wall_clock_ms: CONTRACT_DEFAULT_ASYNC_LAUNCH_TIMEOUT_MS,
		fallback_models_configured: 1,
	}),
	scenarioRow({
		scenario: 'definitive-rejection-fallback',
		retry_owner:
			'src/utils/model-dispatch-fallback.ts#model-fallback (definitive server rejection: error RESULT, the server responded)',
		effective_configuration: {
			entry: 'executeDispatchLanesAsync',
			create_generations: CONTRACT_MAX_SESSION_CREATE_GENERATIONS,
			fallback_models_configured: 1,
			launch_timeout_ms: 5_000,
			definitive_failure: '429-returned-error-result on the primary model',
		},
		max_host_launches: 3,
		max_attempts: 3,
		wall_clock_ms: 5_000,
		fallback_models_configured: 1,
	}),
	scenarioRow({
		scenario: 'timeout-no-retry',
		retry_owner:
			'none — an acceptance timeout is pre-classified permanent (/timed out/i) at both launch sites',
		effective_configuration: {
			entry: 'executeDispatchLanesAsync',
			create_generations: CONTRACT_MAX_SESSION_CREATE_GENERATIONS,
			fallback_models_configured: 1,
			launch_timeout_ms: 10,
			launch_timeout_default_ms: CONTRACT_DEFAULT_ASYNC_LAUNCH_TIMEOUT_MS,
			ambiguous_failure: 'promptAsync acceptance never settles',
		},
		max_host_launches: 2,
		max_attempts: 2,
		wall_clock_ms: CONTRACT_DEFAULT_ASYNC_LAUNCH_TIMEOUT_MS,
		fallback_models_configured: 1,
	}),
	scenarioRow({
		scenario: 'create-cap-exhaustion',
		retry_owner:
			'src/tools/dispatch-lanes.ts#createLaneSession (cap-enforced; exhaustion surfaced)',
		effective_configuration: {
			entry: 'executeDispatchLanes',
			create_generations: CONTRACT_MAX_SESSION_CREATE_GENERATIONS,
			fallback_models_configured: 0,
			transient_create_failure: '503-returned-error-result (always)',
			timeout_ms: CONTRACT_DEFAULT_TIMEOUT_MS,
		},
		max_host_launches: CONTRACT_MAX_SESSION_CREATE_GENERATIONS,
		max_attempts: CONTRACT_MAX_SESSION_CREATE_GENERATIONS,
		wall_clock_ms: CONTRACT_DEFAULT_TIMEOUT_MS,
		fallback_models_configured: 0,
	}),
	scenarioRow({
		scenario: 'late-stale-generation-ignored',
		retry_owner:
			'src/tools/dispatch-lanes.ts#createLaneSession late-session cleanup + delegation generation fence',
		effective_configuration: {
			entry: 'executeDispatchLanesAsync',
			create_generations: CONTRACT_MAX_SESSION_CREATE_GENERATIONS,
			fallback_models_configured: 0,
			launch_timeout_ms: 10,
			late_artifact:
				'generation-1 create resolves after the generation-2 retry launched',
		},
		max_host_launches: CONTRACT_MAX_SESSION_CREATE_GENERATIONS + 1,
		max_attempts: CONTRACT_MAX_SESSION_CREATE_GENERATIONS + 1,
		wall_clock_ms: CONTRACT_DEFAULT_ASYNC_LAUNCH_TIMEOUT_MS,
		fallback_models_configured: 0,
	}),
];

// ── Validators (AC6: unspecified bounds cannot pass) ──────────────────────

const REQUIRED_INTEGER_BOUNDS = [
	'max_host_launches',
	'max_attempts',
	'wall_clock_ms',
] as const;

function describeValue(value: unknown): string {
	if (value === undefined) return 'undefined';
	if (value === null) return 'null';
	if (typeof value === 'number')
		return Number.isInteger(value) ? String(value) : `${value} (non-integer)`;
	return `${typeof value}`;
}

/**
 * Throws when any scenario bound is missing/non-integer, any mechanism
 * accounting row is missing, or an owner/bound is not an exact integer.
 * A scenario with unspecified bounds can NEVER pass validation.
 */
export function validateScenarioBudget(row: ScenarioBudgetRow): void {
	if (row === null || typeof row !== 'object') {
		throw new Error('scenario budget row: row object is missing');
	}
	if (typeof row.scenario !== 'string' || row.scenario.length === 0) {
		throw new Error('scenario budget row: scenario id is missing');
	}
	if (typeof row.retry_owner !== 'string' || row.retry_owner.length === 0) {
		throw new Error(
			`scenario "${row.scenario}": retry owner is missing (unspecified owner cannot pass)`,
		);
	}
	if (
		row.effective_configuration === null ||
		typeof row.effective_configuration !== 'object' ||
		Object.keys(row.effective_configuration).length === 0
	) {
		throw new Error(
			`scenario "${row.scenario}": effective configuration is missing`,
		);
	}
	for (const key of REQUIRED_INTEGER_BOUNDS) {
		const value = row[key];
		if (!Number.isInteger(value)) {
			throw new Error(
				`scenario "${row.scenario}": bound ${key} is unspecified or non-integer (got ${describeValue(value)})`,
			);
		}
		if (value <= 0) {
			throw new Error(
				`scenario "${row.scenario}": bound ${key} must be a positive integer (got ${value})`,
			);
		}
	}
	const mechanisms = row.mechanisms as Partial<
		Record<LaunchMechanismKey, MechanismAccountingRow>
	>;
	if (mechanisms === null || typeof mechanisms !== 'object') {
		throw new Error(
			`scenario "${row.scenario}": mechanism accounting is missing`,
		);
	}
	for (const key of LAUNCH_MECHANISM_KEYS) {
		const mechanismRow = mechanisms[key];
		if (mechanismRow === undefined || mechanismRow === null) {
			throw new Error(
				`scenario "${row.scenario}": mechanism accounting row missing for ${key}`,
			);
		}
		if (mechanismRow.mechanism !== key) {
			throw new Error(
				`scenario "${row.scenario}": mechanism row ${key} is mislabeled ${String(mechanismRow.mechanism)}`,
			);
		}
		if (mechanismRow.owner !== LAUNCH_MECHANISM_OWNERS[key]) {
			throw new Error(
				`scenario "${row.scenario}": mechanism ${key} owner mismatch (got ${String(mechanismRow.owner)})`,
			);
		}
		if (!Number.isInteger(mechanismRow.bound) || mechanismRow.bound < 0) {
			throw new Error(
				`scenario "${row.scenario}": mechanism ${key} bound is unspecified or non-integer (got ${describeValue(mechanismRow.bound)})`,
			);
		}
	}
}

/** Alias for {@link validateScenarioBudget} — throws on any unspecified bound. */
export function assertLaunchBudgetRow(row: ScenarioBudgetRow): void {
	validateScenarioBudget(row);
}

/**
 * Compares observed host launches / attempts (and optionally observed wall
 * clock) against the frozen INTEGER bounds. Throws when any observed total
 * exceeds its bound or any observed value is not a non-negative integer.
 */
export function assertWithinBudget(
	row: ScenarioBudgetRow,
	observed: ObservedLaunchCounts,
): void {
	validateScenarioBudget(row);
	if (observed === null || typeof observed !== 'object') {
		throw new Error(`scenario "${row.scenario}": observed counts are missing`);
	}
	for (const key of ['host_launches', 'attempts'] as const) {
		const value = observed[key];
		if (!Number.isInteger(value) || value < 0) {
			throw new Error(
				`scenario "${row.scenario}": observed ${key} is not a non-negative integer (got ${describeValue(value)})`,
			);
		}
	}
	if (observed.host_launches > row.max_host_launches) {
		throw new Error(
			`scenario "${row.scenario}": observed ${observed.host_launches} host launches exceeds the frozen bound ${row.max_host_launches}`,
		);
	}
	if (observed.attempts > row.max_attempts) {
		throw new Error(
			`scenario "${row.scenario}": observed ${observed.attempts} attempts exceeds the frozen bound ${row.max_attempts}`,
		);
	}
	if (observed.wall_clock_ms !== undefined) {
		if (
			!Number.isInteger(observed.wall_clock_ms) ||
			observed.wall_clock_ms < 0
		) {
			throw new Error(
				`scenario "${row.scenario}": observed wall_clock_ms is not a non-negative integer (got ${describeValue(observed.wall_clock_ms)})`,
			);
		}
		if (observed.wall_clock_ms > row.wall_clock_ms) {
			throw new Error(
				`scenario "${row.scenario}": observed wall clock ${observed.wall_clock_ms}ms exceeds the frozen bound ${row.wall_clock_ms}ms`,
			);
		}
	}
}

/** Returns the frozen budget row for a scenario id; throws when unknown. */
export function getScenarioBudget(scenario: string): ScenarioBudgetRow {
	const row = LAUNCH_SCENARIO_BUDGETS.find(
		(candidate) => candidate.scenario === scenario,
	);
	if (row === undefined) {
		throw new Error(`unknown launch budget scenario: ${scenario}`);
	}
	return row;
}

// Freeze at load: every shipped row must validate, or this module cannot load.
for (const row of LAUNCH_SCENARIO_BUDGETS) {
	validateScenarioBudget(row);
}
