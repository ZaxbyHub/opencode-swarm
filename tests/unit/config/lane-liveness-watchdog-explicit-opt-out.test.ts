/**
 * AC39 (issues #3312/#3313, honest incomplete-lane settlement): an EXPLICIT
 * `lane_liveness_watchdog: { enabled: false }` stays a byte-identical no-op
 * when the section flips default-on (AC38,
 * `tests/unit/config/lane-liveness-watchdog-default-on.test.ts`).
 *
 * Contract under test (asserted only through `PluginConfigSchema.parse` +
 * `laneLivenessWatchdogFeatures`): explicit `enabled: false` keeps BOTH
 * features off — `deadlineActive === false` and `stallActive === false` — and
 * explicit false beats a nonzero `timeout_ms` (a fully-populated
 * LANE_LIVENESS_WATCHDOG_DEFAULTS-shaped section with `enabled: false` is
 * still a complete no-op). These semantics hold identically at the pre-fix
 * base (commit 6c68fc7af, where the section is default-off) and after the
 * default-on fix, so this file is green at BOTH ends: the opt-out path must
 * not regress while the default flips.
 */

import { describe, expect, test } from 'bun:test';
import { PluginConfigSchema } from '../../../src/config/schema.js';
import { laneLivenessWatchdogFeatures } from '../../../src/hooks/lane-liveness-watchdog.js';

describe('AC39 lane_liveness_watchdog explicit opt-out (issues #3312/#3313)', () => {
	test('explicit enabled:false keeps the watchdog fully off', () => {
		const off = PluginConfigSchema.parse({
			lane_liveness_watchdog: { enabled: false },
		});
		expect(off.lane_liveness_watchdog?.enabled).toBe(false);
		expect(laneLivenessWatchdogFeatures(off.lane_liveness_watchdog)).toEqual({
			deadlineActive: false,
			stallActive: false,
		});

		// Explicit false beats a nonzero timeout: the deadline stays off.
		const offWithTimeout = PluginConfigSchema.parse({
			lane_liveness_watchdog: { enabled: false, timeout_ms: 1_800_000 },
		});
		expect(
			laneLivenessWatchdogFeatures(offWithTimeout.lane_liveness_watchdog)
				.deadlineActive,
		).toBe(false);
	});

	test('LANE_LIVENESS_WATCHDOG_DEFAULTS-era no-op semantics survive for explicit false', () => {
		// A fully-populated defaults-shaped section with the one-word opt-out:
		// both features must read exactly as if the watchdog did not exist.
		const features = laneLivenessWatchdogFeatures({
			enabled: false,
			timeout_ms: 1_800_000,
			stall_threshold_ms: 300_000,
			stall_min_steps: 5,
			stall_token_threshold: 200,
		});
		expect(features).toEqual({
			deadlineActive: false,
			stallActive: false,
		});
	});
});
