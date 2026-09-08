import { describe, expect, test } from 'bun:test';
import { reducePrReviewEvent } from '../../../src/pr-review/reducer.js';
import type {
	PrReviewCriticSettledReceipt,
	PrReviewWorkflowState,
} from '../../../src/pr-review/types.js';

const BASE: PrReviewWorkflowState = {
	sessionID: 'ses_completion_1',
	workflowInstanceId: 'wfi_1',
	revision: 4,
	prHeadSha: 'abc123def',
};

function settlement(overrides: {
	covered?: Array<
		| 'correctness-state'
		| 'security'
		| 'tests'
		| 'intent'
		| 'reliability-performance'
		| 'compatibility-delivery'
	>;
	live?: Array<
		| 'correctness-state'
		| 'security'
		| 'tests'
		| 'intent'
		| 'reliability-performance'
		| 'compatibility-delivery'
	>;
	unresolved?: Array<{
		dimension:
			| 'correctness-state'
			| 'security'
			| 'tests'
			| 'intent'
			| 'reliability-performance'
			| 'compatibility-delivery';
		terminalState: 'FAILED' | 'CANCELLED' | 'NOT_LAUNCHED';
	}>;
}) {
	const covered = overrides.covered ?? [];
	const live = overrides.live ?? [];
	const unresolved = overrides.unresolved ?? [];
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

function receipt(
	findingId: string,
	status: PrReviewCriticSettledReceipt['status'],
): PrReviewCriticSettledReceipt {
	return {
		findingId,
		status,
		reviewerRowDigest: `row-digest-${findingId}`,
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
				unresolved: [{ dimension: 'tests', terminalState: 'FAILED' }],
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

	test('NO_COVERAGE cannot approve (issue #2512: requires INCOMPLETE)', () => {
		const result = reducePrReviewEvent(BASE, {
			type: 'coverage_finalization_requested',
			settlement: settlement({ covered: [] }),
			requestedVerdict: 'APPROVE',
		});
		expect(result.status).toBe('rejected');
		if (result.status !== 'rejected') return;
		expect(result.rejection.code).toBe('no_coverage_requires_incomplete');
	});

	test('NO_COVERAGE with REQUEST_CHANGES is rejected (production matrix parity)', () => {
		const result = reducePrReviewEvent(BASE, {
			type: 'coverage_finalization_requested',
			settlement: settlement({ covered: [] }),
			requestedVerdict: 'REQUEST_CHANGES',
		});
		expect(result.status).toBe('rejected');
		if (result.status !== 'rejected') return;
		expect(result.rejection.code).toBe('no_coverage_requires_incomplete');
	});

	test('NO_COVERAGE with INCOMPLETE finalizes', () => {
		const result = reducePrReviewEvent(BASE, {
			type: 'coverage_finalization_requested',
			settlement: settlement({ covered: [] }),
			requestedVerdict: 'INCOMPLETE',
		});
		expect(result.status).toBe('applied');
	});

	test('finalization is validation-only; persistence stays with the completion adapter', () => {
		const result = reducePrReviewEvent(BASE, {
			type: 'coverage_finalization_requested',
			settlement: settlement({
				covered: ['correctness-state'],
				unresolved: [{ dimension: 'tests', terminalState: 'FAILED' }],
			}),
		});
		expect(result.status).toBe('applied');
		if (result.status !== 'applied') return;
		// Phase 8b review: the unresolved-dimension disclosure is the
		// completion module's durable artifact (coverage-disclosure.json),
		// written by the gate when it executes persist_state — not an
		// audit-event effect.
		// Issue #2512 review PRR-006: the transition mutates no state, so it
		// emits no effects — the completion adapter persists at its own
		// terminal clear.
		expect(result.effects).toEqual([]);
	});
});

describe('critic settled receipts (issue 2512)', () => {
	test('UPHELD satisfies coverage for its finding', () => {
		const result = reducePrReviewEvent(BASE, {
			type: 'critic_result_recorded',
			criticRequiredFindingIds: ['f-1'],
			criticSettledReceipts: [receipt('f-1', 'UPHELD')],
		});
		expect(result.status).toBe('applied');
	});

	test('DOWNGRADED satisfies coverage', () => {
		const result = reducePrReviewEvent(BASE, {
			type: 'critic_result_recorded',
			criticRequiredFindingIds: ['f-1', 'f-2'],
			criticSettledReceipts: [
				receipt('f-1', 'DOWNGRADED'),
				receipt('f-2', 'UPHELD'),
			],
		});
		expect(result.status).toBe('applied');
	});

	test('DISPROVED satisfies coverage', () => {
		const result = reducePrReviewEvent(BASE, {
			type: 'critic_result_recorded',
			criticRequiredFindingIds: ['f-1'],
			criticSettledReceipts: [receipt('f-1', 'DISPROVED')],
		});
		expect(result.status).toBe('applied');
	});

	test('a required finding with no settled receipt rejects settlement', () => {
		const result = reducePrReviewEvent(BASE, {
			type: 'critic_result_recorded',
			criticRequiredFindingIds: ['f-1', 'f-2', 'f-3'],
			criticSettledReceipts: [
				receipt('f-1', 'UPHELD'),
				receipt('f-3', 'UPHELD'),
			],
		});
		expect(result.status).toBe('rejected');
		if (result.status !== 'rejected') return;
		expect(result.rejection.code).toBe('critic_required_unfulfilled');
		expect(result.rejection.detail).toContain('f-2');
	});

	test('NEEDS_MORE_EVIDENCE does not satisfy (nonterminal; not a settled receipt)', () => {
		// NEEDS_MORE_EVIDENCE is not representable on a settled receipt (the
		// type admits only UPHELD/DOWNGRADED/DISPROVED), so the adapter
		// cannot emit one for it; the only representable way a finding stays
		// unfulfilled is the absence of its receipt, asserted here.
		const result = reducePrReviewEvent(BASE, {
			type: 'critic_result_recorded',
			criticRequiredFindingIds: ['f-1'],
			criticSettledReceipts: [],
		});
		expect(result.status).toBe('rejected');
		if (result.status !== 'rejected') return;
		expect(result.rejection.code).toBe('critic_required_unfulfilled');
		expect(result.rejection.detail).toContain('f-1');
	});

	test('an empty critic-required inventory settles trivially', () => {
		const result = reducePrReviewEvent(BASE, {
			type: 'critic_result_recorded',
			criticRequiredFindingIds: [],
			criticSettledReceipts: [],
		});
		expect(result.status).toBe('applied');
	});
});

// Issue #2512 wire-or-retire census: `publication_armed` was RETIRED from the
// PrReviewEvent union. Verdict/coverage compatibility at completion is owned by
// the wired `coverage_finalization_requested` transition (matrix parity with
// `allowedPrReviewReportVerdicts`); the PR_FEEDBACK arming write itself is the
// generation-governed transition documented in
// docs/pr-feedback-publication-generations.md.
