/**
 * AC38 (issues #3312/#3313, honest incomplete-lane settlement): the
 * lane-liveness watchdog must be DEFAULT-ON.
 *
 * Contract under test (implementation-agnostic — asserted only through
 * `PluginConfigSchema.parse` + `laneLivenessWatchdogFeatures`, never through
 * internal registry wiring): after the fix, an OMITTED
 * `lane_liveness_watchdog` section resolves to an ENABLED watchdog —
 * `enabled === true`, `timeout_ms >= 1_800_000`, and an active execution
 * deadline (`deadlineActive === true`). An empty section object `{}` resolves
 * the same way, and an explicit partial section (e.g. `timeout_ms: 600_000`)
 * keeps its explicit knobs while inheriting `enabled: true`.
 *
 * RED signature at the pre-fix base (commit 6c68fc7af), verified by probe:
 * `PluginConfigSchema.parse({}).lane_liveness_watchdog` is `undefined`
 * (section registered `.optional()` with no section default) and
 * `parse({ lane_liveness_watchdog: {} }).enabled === false` (field default
 * `false`), so every test in this file fails at base and must pass after the
 * default-on fix. Companion preserving coverage lives in
 * `tests/unit/config/lane-liveness-watchdog-explicit-opt-out.test.ts` (AC39).
 */

import { describe, expect, test } from 'bun:test';
import { PluginConfigSchema } from '../../../src/config/schema.js';
import { laneLivenessWatchdogFeatures } from '../../../src/hooks/lane-liveness-watchdog.js';

describe('AC38 lane_liveness_watchdog default-on (issues #3312/#3313)', () => {
	test('omitted section resolves an enabled watchdog with an active deadline', () => {
		const cfg = PluginConfigSchema.parse({});
		expect(cfg.lane_liveness_watchdog).toBeDefined();
		expect(cfg.lane_liveness_watchdog?.enabled).toBe(true);
		expect(cfg.lane_liveness_watchdog?.timeout_ms).toBeGreaterThanOrEqual(
			1_800_000,
		);
		expect(
			laneLivenessWatchdogFeatures(cfg.lane_liveness_watchdog).deadlineActive,
		).toBe(true);
	});

	test('empty section object also resolves enabled', () => {
		const cfg = PluginConfigSchema.parse({ lane_liveness_watchdog: {} });
		expect(cfg.lane_liveness_watchdog?.enabled).toBe(true);
		expect(
			laneLivenessWatchdogFeatures(cfg.lane_liveness_watchdog).deadlineActive,
		).toBe(true);
	});

	test('partial section keeps explicit knobs', () => {
		const cfg = PluginConfigSchema.parse({
			lane_liveness_watchdog: { timeout_ms: 600_000 },
		});
		expect(cfg.lane_liveness_watchdog?.enabled).toBe(true);
		expect(cfg.lane_liveness_watchdog?.timeout_ms).toBe(600_000);
		// The #2506 frozen parameter surface fills every other knob.
		expect(cfg.lane_liveness_watchdog?.stall_threshold_ms).toBe(300_000);
		expect(cfg.lane_liveness_watchdog?.stall_min_steps).toBe(5);
		expect(cfg.lane_liveness_watchdog?.stall_token_threshold).toBe(200);
	});
});
