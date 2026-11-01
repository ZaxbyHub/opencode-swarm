/**
 * Acceptance check C2 (issue #3260 section B / trace 3260-3252-teardown-hardening).
 *
 * A command-level clean-stage deadline constant must exist and be exported
 * from src/commands/close/constants.ts, expressed in milliseconds, and sized
 * to at least tolerate one full per-artifact unlink schedule (otherwise every
 * sqlite-class artifact would trip the cap). NEW-SURFACE: the export does not
 * exist at the base tree, so this file fails at module resolution (ERROR at
 * base); it turns GREEN when the fix introduces the constant.
 *
 * Frozen contract for the fix: the constant is named CLEAN_STAGE_DEADLINE_MS
 * and lives in src/commands/close/constants.ts.
 */
import { describe, expect, it } from 'bun:test';
import {
	ACTIVE_STATE_UNLINK_RETRY_DELAYS_MS,
	CLEAN_STAGE_DEADLINE_MS,
} from '../../../src/commands/close/constants.js';

describe('clean-stage deadline constant (3260-B)', () => {
	it('exists as a finite positive millisecond budget (ERROR at base, GREEN after the fix)', () => {
		expect(Number.isFinite(CLEAN_STAGE_DEADLINE_MS)).toBe(true);
		expect(CLEAN_STAGE_DEADLINE_MS).toBeGreaterThan(0);
	});

	it('unit is milliseconds and tolerates at least one full artifact schedule (ERROR at base, GREEN after the fix)', () => {
		const oneArtifactScheduleMs = ACTIVE_STATE_UNLINK_RETRY_DELAYS_MS.reduce(
			(total, delay) => total + delay,
			0,
		);
		// A stage cap smaller than a single artifact's own retry budget would
		// fire on the first slow-but-recoverable artifact, defeating the point
		// of the per-artifact schedule.
		expect(CLEAN_STAGE_DEADLINE_MS).toBeGreaterThanOrEqual(
			oneArtifactScheduleMs,
		);
	});
});
