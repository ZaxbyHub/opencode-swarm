/**
 * Issue #2506 acceptance check C2 (AC2, DISCRIMINATING) — exactly ONE
 * effective PR lane timeout horizon in every configuration combination.
 *
 * Frozen contract pinned here (`resolveEffectivePrLaneHorizonMs` from
 * `src/hooks/lane-liveness-watchdog.ts`, re-exported through the gate seam):
 * - watchdog enabled AND timeout_ms > 0 → { timeout_ms, 'watchdog-timeout' }
 * - anything else (omitted, disabled, timeout_ms = 0) →
 *   { DEFAULT_STALE_DELEGATION_TIMEOUT_MS (30 min), 'reachability-floor' }
 * - conflictDisclosed is true ONLY when backgroundPendingTimeoutMs is
 *   provided, > 0, and differs from the effective horizon. Boundary equality
 *   (both 1_800_000, or both 600_000) discloses no conflict.
 *
 * The single-horizon invariant: in every combination the function returns
 * exactly one integer horizonMs drawn from exactly one of the two named
 * sources — never two horizons, never an undocumented source.
 */
import { describe, expect, test } from 'bun:test';
import { DEFAULT_STALE_DELEGATION_TIMEOUT_MS } from '../../../src/background/pending-delegations.js';
import { resolveEffectivePrLaneHorizonMs } from '../../../src/hooks/lane-liveness-watchdog.js';
import { _test_exports as gateInternals } from '../../../src/hooks/pr-workflow-gate.js';

const WATCHDOG_TIMEOUT = 600_000;
const CONFLICTING_BACKGROUND_TIMEOUT = 1_200_000;

const disabledConfig = {
	enabled: false,
	timeout_ms: WATCHDOG_TIMEOUT,
	stall_threshold_ms: 300_000,
	stall_min_steps: 5,
	stall_token_threshold: 200,
};

const enabledConfig = {
	enabled: true,
	timeout_ms: WATCHDOG_TIMEOUT,
	stall_threshold_ms: 300_000,
	stall_min_steps: 5,
	stall_token_threshold: 200,
};

const enabledZeroTimeoutConfig = {
	enabled: true,
	timeout_ms: 0,
	stall_threshold_ms: 300_000,
	stall_min_steps: 5,
	stall_token_threshold: 200,
};

type Horizon = {
	horizonMs: number;
	source: 'watchdog-timeout' | 'reachability-floor';
	conflictDisclosed: boolean;
};

const VALID_SOURCES = new Set(['watchdog-timeout', 'reachability-floor']);

describe('C2 — resolveEffectivePrLaneHorizonMs precedence', () => {
	test('no watchdog at all → the 30-minute reachability floor', () => {
		expect(resolveEffectivePrLaneHorizonMs()).toEqual({
			horizonMs: DEFAULT_STALE_DELEGATION_TIMEOUT_MS,
			source: 'reachability-floor',
			conflictDisclosed: false,
		} as Horizon);
	});

	test('the floor is the canonical 30-minute constant', () => {
		expect(DEFAULT_STALE_DELEGATION_TIMEOUT_MS).toBe(30 * 60_000);
		expect(resolveEffectivePrLaneHorizonMs().horizonMs).toBe(1_800_000);
	});

	test('disabled watchdog with a nonzero timeout_ms is IGNORED (floor wins)', () => {
		const result = resolveEffectivePrLaneHorizonMs(disabledConfig) as Horizon;
		expect(result.horizonMs).toBe(DEFAULT_STALE_DELEGATION_TIMEOUT_MS);
		expect(result.source).toBe('reachability-floor');
	});

	test('enabled watchdog with timeout_ms > 0 wins over the floor', () => {
		const result = resolveEffectivePrLaneHorizonMs(enabledConfig) as Horizon;
		expect(result.horizonMs).toBe(WATCHDOG_TIMEOUT);
		expect(result.source).toBe('watchdog-timeout');
	});

	test('enabled watchdog with timeout_ms = 0 disables the deadline feature (floor)', () => {
		// "0 disables the relevant feature": the watchdog cannot impose a
		// zero horizon, because that would settle every lane immediately.
		const result = resolveEffectivePrLaneHorizonMs(
			enabledZeroTimeoutConfig,
		) as Horizon;
		expect(result.horizonMs).toBe(DEFAULT_STALE_DELEGATION_TIMEOUT_MS);
		expect(result.source).toBe('reachability-floor');
	});
});

describe('C2 — conflict disclosure against background_pending_timeout_minutes', () => {
	test('watchdog horizon vs a differing background timeout discloses the conflict, horizon stays single', () => {
		const result = resolveEffectivePrLaneHorizonMs(
			enabledConfig,
			CONFLICTING_BACKGROUND_TIMEOUT,
		) as Horizon;
		expect(result.horizonMs).toBe(WATCHDOG_TIMEOUT);
		expect(result.source).toBe('watchdog-timeout');
		expect(result.conflictDisclosed).toBe(true);
	});

	test('floor vs a differing background timeout also discloses the conflict', () => {
		const result = resolveEffectivePrLaneHorizonMs(
			disabledConfig,
			WATCHDOG_TIMEOUT,
		) as Horizon;
		expect(result.horizonMs).toBe(DEFAULT_STALE_DELEGATION_TIMEOUT_MS);
		expect(result.source).toBe('reachability-floor');
		expect(result.conflictDisclosed).toBe(true);
	});

	test('boundary equality at the floor value discloses NO conflict', () => {
		const result = resolveEffectivePrLaneHorizonMs(
			{ ...enabledConfig, timeout_ms: 1_800_000 },
			1_800_000,
		) as Horizon;
		expect(result.horizonMs).toBe(1_800_000);
		expect(result.source).toBe('watchdog-timeout');
		expect(result.conflictDisclosed).toBe(false);
	});

	test('boundary equality at the watchdog value discloses NO conflict', () => {
		const result = resolveEffectivePrLaneHorizonMs(
			enabledConfig,
			WATCHDOG_TIMEOUT,
		) as Horizon;
		expect(result.conflictDisclosed).toBe(false);
	});

	test('a background timeout of 0 is "not set" and never discloses a conflict', () => {
		const result = resolveEffectivePrLaneHorizonMs(enabledConfig, 0) as Horizon;
		expect(result.conflictDisclosed).toBe(false);
	});

	test('an undefined background timeout never discloses a conflict', () => {
		const result = resolveEffectivePrLaneHorizonMs(
			enabledConfig,
			undefined,
		) as Horizon;
		expect(result.conflictDisclosed).toBe(false);
	});
});

describe('C2 — the single-horizon invariant across every combination', () => {
	test('every combination yields exactly one integer horizon from one of the two sources', () => {
		const watchdogConfigs = [
			undefined,
			disabledConfig,
			enabledConfig,
			enabledZeroTimeoutConfig,
		];
		const backgroundTimeouts = [
			undefined,
			0,
			WATCHDOG_TIMEOUT,
			CONFLICTING_BACKGROUND_TIMEOUT,
			DEFAULT_STALE_DELEGATION_TIMEOUT_MS,
		];
		for (const watchdog of watchdogConfigs) {
			for (const background of backgroundTimeouts) {
				const result = resolveEffectivePrLaneHorizonMs(
					watchdog,
					background,
				) as Horizon;
				expect(Number.isInteger(result.horizonMs)).toBe(true);
				expect(result.horizonMs).toBeGreaterThanOrEqual(0);
				expect(VALID_SOURCES.has(result.source)).toBe(true);
				expect(typeof result.conflictDisclosed).toBe('boolean');
				// "Exactly one" also means deterministic: resolving the same
				// combination twice must agree byte-for-byte.
				expect(resolveEffectivePrLaneHorizonMs(watchdog, background)).toEqual(
					result,
				);
				// The effective horizon is always one of the two configured
				// candidates — never a blend, never a third value.
				const candidates = new Set(
					[WATCHDOG_TIMEOUT, DEFAULT_STALE_DELEGATION_TIMEOUT_MS].map(
						(n) => `${n}`,
					),
				);
				expect(candidates.has(`${result.horizonMs}`)).toBe(true);
			}
		}
	});

	test('a conflict never changes the effective horizon, only discloses it', () => {
		const without = resolveEffectivePrLaneHorizonMs(enabledConfig) as Horizon;
		const withConflict = resolveEffectivePrLaneHorizonMs(
			enabledConfig,
			CONFLICTING_BACKGROUND_TIMEOUT,
		) as Horizon;
		expect(withConflict.horizonMs).toBe(without.horizonMs);
		expect(withConflict.source).toBe(without.source);
		expect(withConflict.conflictDisclosed).toBe(true);
		expect(without.conflictDisclosed).toBe(false);
	});

	test('the gate seam exposes the same resolver behavior', () => {
		const viaGate = (
			gateInternals.laneLivenessWatchdog as unknown as {
				resolveEffectivePrLaneHorizonMs: typeof resolveEffectivePrLaneHorizonMs;
			}
		).resolveEffectivePrLaneHorizonMs;
		expect(viaGate(enabledConfig, CONFLICTING_BACKGROUND_TIMEOUT)).toEqual(
			resolveEffectivePrLaneHorizonMs(
				enabledConfig,
				CONFLICTING_BACKGROUND_TIMEOUT,
			),
		);
	});
});
