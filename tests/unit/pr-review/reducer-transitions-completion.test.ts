import { describe, expect, test } from 'bun:test';
import { reducePrReviewEvent } from '../../../src/pr-review/reducer.js';
import type { PrReviewWorkflowState } from '../../../src/pr-review/types.js';

const BASE: PrReviewWorkflowState = {
	sessionID: 'ses_completion_1',
	workflowInstanceId: 'wfi_1',
	revision: 4,
	prHeadSha: 'abc123def',
};

function settlement(overrides: {
	covered?: Array<'correctness-state' | 'security' | 'tests' | 'intent' | 'reliability-performance' | 'compatibility-delivery'>;
	live?: Array<'correctness-state' | 'security' | 'tests' | 'intent' | 'reliability-performance' | 'compatibility-delivery'>;
	unresolved?: Array<{ dimension: 'correctness-state' | 'security' | 'tests' | 'intent' | 'reliability-performance' | 'compatibility-delivery'; terminalState: 'FAILED' | 'CANCELLED' | 'NOT_LAUNCHED' }> ;
}) {
	const covered = overrides.covered ?? [];
	const live = overrides.live ?? [];
	const unresolved =
		overrides.unresolved ??
		([]);
	return {
		kind: (covered.length === 6
			? 'COMPLETE'
			: covered.length > 0
				? 'PARTIAL'
				: 'NO_COVERAGE') as 'COMPLETE' | 'PARTIAL' | 'NO_COVERAGE',
		coveredDimensions: covered,
		unresolvedDimensions: unresolved.map((u) => ({
			...u,
			reasonKind: 'lane_failure',
		})),
		liveDimensions: live,
	};
}

describe('reducer: coverage finalization (N-of-6 truthfulness)', () => {
	test('a live lane blocks terminal coverage', () => {
		const result = reducePrReviewEvent(BASE, {
			type: 'coverage_finalization_requested',
			settlement: settlement({
				covered: ['correctness-state', 'security'],
				live: ['tests'],
			}),
			requestedVerdict: 'INCOMPLETE',
		});
		expect(result.status).toBe('rejected');
		if (result.status !== 'rejected') return;
		expect(result.rejection.code).toBe('live_lane_blocks_coverage');
		expect(result.rejection.detail).toContain('tests');
	});

	test('COMPLETE coverage finalizes', () => {
		const all = [
			'correctness-state',
			'security',
			'tests',
			'intent',
			'reliability-performance',
			'compatibility-delivery',
		] as const;
		const result = reducePrReviewEvent(BASE, {
			type: 'coverage_finalization_requested',
			settlement: settlement({ covered: [...all] }),
			requestedVerdict: 'APPROVE',
		});
		expect(result.status).toBe('applied');
	});

	test('PARTIAL coverage cannot approve', () => {
		const result = reducePrReviewEvent(BASE, {
			type: 'coverage_finalization_requested',
			settlement: settlement({
				covered: ['correctness-state', 'security'],
				unresolved: [
					{ dimension: 'tests', terminalState: 'FAILED' },
				],
			}),
			requestedVerdict: 'APPROVE',
		});
		expect(result.status).toBe('rejected');
		if (result.status !== 'rejected') return;
		expect(result.rejection.code).toBe('partial_coverage_cannot_approve');
	});

	test('PARTIAL coverage may finalize INCOMPLETE or REQUEST_CHANGES', () => {
		for (const verdict of ['INCOMPLETE', 'REQUEST_CHANGES'] as const) {
			const result = reducePrReviewEvent(BASE, {
				type: 'coverage_finalization_requested',
				settlement: settlement({
					covered: ['correctness-state'],
					unresolved: [{ dimension: 'tests', terminalState: 'FAILED' }],
				}),
				requestedVerdict: verdict,
			});
			expect(result.status).toBe('applied');
		}
	});

	test('NO_COVERAGE cannot approve', () => {
		const result = reducePrReviewEvent(BASE, {
			type: 'coverage_finalization_requested',
			settlement: settlement({ covered: [] }),
			requestedVerdict: 'APPROVE',
		});
		expect(result.status).toBe('rejected');
		if (result.status !== 'rejected') return;
		expect(result.rejection.code).toBe('no_coverage_cannot_approve');
	});

	test('finalization emits a bounded audit event naming unresolved dimensions', () => {
		const result = reducePrReviewEvent(BASE, {
			type: 'coverage_finalization_requested',
			settlement: settlement({
				covered: ['correctness-state'],
				unresolved: [{ dimension: 'tests', terminalState: 'FAILED' }],
			}),
		});
		expect(result.status).toBe('applied');
		if (result.status !== 'applied') return;
		const audit = result.effects.find((e) => e.kind === 'append_audit_event');
		expect(audit).toMatchObject({
			code: 'coverage_partial',
			boundedDetail: 'tests:FAILED',
		});
	});
});

describe('reducer: critic result admission', () => {
	test('unfulfilled critic-required findings reject settlement', () => {
		const result = reducePrReviewEvent(BASE, {
			type: 'critic_result_recorded',
			criticRequiredFindingIds: ['f-1', 'f-2', 'f-3'],
			criticConfirmedFindingIds: ['f-1', 'f-3'],
		});
		expect(result.status).toBe('rejected');
		if (result.status !== 'rejected') return;
		expect(result.rejection.code).toBe('critic_required_unfulfilled');
		expect(result.rejection.detail).toContain('f-2');
	});

	test('fully confirmed critic inventory settles', () => {
		const result = reducePrReviewEvent(BASE, {
			type: 'critic_result_recorded',
			criticRequiredFindingIds: ['f-1', 'f-2'],
			criticConfirmedFindingIds: ['f-2', 'f-1'],
		});
		expect(result.status).toBe('applied');
	});

	test('an empty critic-required inventory settles trivially', () => {
		const result = reducePrReviewEvent(BASE, {
			type: 'critic_result_recorded',
			criticRequiredFindingIds: [],
			criticConfirmedFindingIds: [],
		});
		expect(result.status).toBe('applied');
	});
});

describe('reducer: publication arming', () => {
	test('arming APPROVAL on COMPLETE coverage is allowed', () => {
		const result = reducePrReviewEvent(BASE, {
			type: 'publication_armed',
			coverageKind: 'COMPLETE',
			verdict: 'APPROVE',
		});
		expect(result.status).toBe('applied');
	});

	test('arming APPROVAL on PARTIAL coverage is rejected', () => {
		const result = reducePrReviewEvent(BASE, {
			type: 'publication_armed',
			coverageKind: 'PARTIAL',
			verdict: 'APPROVE',
		});
		expect(result.status).toBe('rejected');
		if (result.status !== 'rejected') return;
		expect(result.rejection.code).toBe('partial_coverage_cannot_approve');
	});

	test('arming REQUEST_CHANGES on NO_COVERAGE is allowed (truthful verdict)', () => {
		const result = reducePrReviewEvent(BASE, {
			type: 'publication_armed',
			coverageKind: 'NO_COVERAGE',
			verdict: 'INCOMPLETE',
		});
		expect(result.status).toBe('applied');
	});
});
