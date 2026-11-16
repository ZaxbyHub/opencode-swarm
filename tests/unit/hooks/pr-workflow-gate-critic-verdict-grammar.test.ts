// Critic verdict-row grammar pins, split out of
// pr-workflow-gate-review-validation.test.ts (FR-006: that file sat at the
// 500-line ratchet cap and could not absorb the issue #3340 per-lane agent
// declarations). Pure parse-level assertions — no fixtures, no state.
import { describe, expect, test } from 'bun:test';
import { _test_exports as gateInternals } from '../../../src/hooks/pr-workflow-gate.js';

describe('critic verdict grammar', () => {
	test('critic verdicts reject unresolved and incoherent terminal rows', () => {
		expect(
			gateInternals.parseCriticVerdict(
				'[CRITIC] | C-1 | NEEDS_MORE_EVIDENCE | HIGH | missing proof | gather trace',
				'C-1',
			),
		).toBeNull();
		expect(
			gateInternals.parseCriticVerdict(
				'[CRITIC] | C-1 | UPHELD | NONE | valid reason | report change',
				'C-1',
			),
		).toBeNull();
		expect(
			gateInternals.parseCriticVerdict(
				'[CRITIC] | C-1 | DISPROVED | HIGH | valid reason | remove finding',
				'C-1',
			),
		).toBeNull();
		expect(
			gateInternals.parseCriticVerdict(
				'[CRITIC] | C-1 | DISPROVED | NONE | valid reason | remove finding',
				'C-1',
				'HIGH',
			),
		).toEqual({ status: 'DISPROVED', severity: 'NONE' });
		expect(
			gateInternals.parseCriticVerdict(
				'[CRITIC] | C-1 | DOWNGRADED | HIGH | valid reason | revise report',
				'C-1',
				'MEDIUM',
			),
		).toBeNull();
		expect(
			gateInternals.parseCriticVerdict(
				'[CRITIC] | C-1 | UPHELD | MEDIUM | valid reason | keep finding',
				'C-1',
				'HIGH',
			),
		).toBeNull();
	});
});
