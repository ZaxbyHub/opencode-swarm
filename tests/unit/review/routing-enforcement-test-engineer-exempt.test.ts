import { afterEach, describe, expect, test } from 'bun:test';

import {
	buildReviewRouteReceipt,
	enforceReviewRouteReceipt,
} from '../../../src/review/routing-enforcement.js';

afterEach(() => {
	// No cross-module mocks in this file; nothing to restore. Kept for
	// convention parity with the sibling routing-enforcement suites.
});

/**
 * Regression (session 29b8ccea / Wirtschaftssimulation task 1.8): a
 * test-engineer-exempt task (docs-only, durable receipt-backed
 * `test_engineer_exempt` proof) whose dispatch-time route receipt still
 * listed a test-engineer slot could never reach route completeness — the
 * reviewer passed everything that can ever pass, and the workflow pinned at
 * `reviewer_run` with "all required proof exists but workflow state is
 * reviewer_run". The completeness barrier must honor the durable exemption:
 * only reviewer identities gate completeness for an exempt task.
 */
describe('routing enforcement — durable test-engineer exemption completeness', () => {
	const routeReceipt = buildReviewRouteReceipt({
		sessionId: 'session-exempt',
		taskId: '1.8',
		complexity: 'single',
		semanticRisk: 'Standard complexity: 1 files, 0 functions',
		requiredReviewers: ['1.8:reviewer:1'],
		// The pre-fix allocation shape: a test-engineer slot demanded from
		// observed complexity even though the durable evidence proves the
		// sanctioned exemption.
		requiredTestEngineers: ['1.8:test_engineer:1'],
	});

	const reviewerEvidence = {
		role: 'reviewer' as const,
		identity: '1.8:reviewer:1',
		sessionId: 'session-exempt',
		taskId: '1.8',
		slotId: '1.8:reviewer:1',
		callId: 'call-reviewer-1',
		childSessionId: 'child-reviewer-1',
		generation: 1,
	};

	test('without the exemption flag, a reviewer-only set stays incomplete (pins the wedge)', () => {
		const result = enforceReviewRouteReceipt({
			enforcementEnabled: true,
			routeReceipt,
			receipts: [reviewerEvidence],
			requireEvidenceBindings: true,
			requireCompleteEvidence: true,
		});
		expect(result).toMatchObject({
			canAdvance: false,
			reason: 'ROUTE_RECEIPT_INCOMPLETE',
		});
	});

	test('with the exemption flag, the reviewer-only set completes the barrier', () => {
		const result = enforceReviewRouteReceipt({
			enforcementEnabled: true,
			routeReceipt,
			receipts: [reviewerEvidence],
			requireEvidenceBindings: true,
			requireCompleteEvidence: true,
			testEngineerExempt: true,
		});
		expect(result).toMatchObject({ canAdvance: true, mode: 'enforced' });
	});

	test('the exemption never completes a barrier whose reviewer identity is missing', () => {
		const result = enforceReviewRouteReceipt({
			enforcementEnabled: true,
			routeReceipt,
			receipts: [],
			requireEvidenceBindings: true,
			requireCompleteEvidence: true,
			testEngineerExempt: true,
		});
		expect(result).toMatchObject({
			canAdvance: false,
			reason: 'ROUTE_RECEIPT_INCOMPLETE',
		});
	});

	test('the exemption keeps identity validation fully authoritative', () => {
		// An unlisted identity must still fail even under the exemption — the
		// flag only relaxes the completeness barrier, never the listing,
		// role, or duplicate checks.
		const result = enforceReviewRouteReceipt({
			enforcementEnabled: true,
			routeReceipt,
			receipts: [{ ...reviewerEvidence, identity: 'not-listed-anywhere' }],
			requireEvidenceBindings: true,
			requireCompleteEvidence: true,
			testEngineerExempt: true,
		});
		expect(result).toMatchObject({
			canAdvance: false,
			reason: 'ROUTE_RECEIPT_IDENTITY_UNLISTED',
		});
	});

	test('a fully-satisfied non-exempt route is unaffected by the flag', () => {
		const fullSet = [
			reviewerEvidence,
			{
				role: 'test_engineer' as const,
				identity: '1.8:test_engineer:1',
				sessionId: 'session-exempt',
				taskId: '1.8',
				slotId: '1.8:test_engineer:1',
				callId: 'call-te-1',
				childSessionId: 'child-te-1',
				generation: 1,
			},
		];
		for (const testEngineerExempt of [false, true] as const) {
			const result = enforceReviewRouteReceipt({
				enforcementEnabled: true,
				routeReceipt,
				receipts: fullSet,
				requireEvidenceBindings: true,
				requireCompleteEvidence: true,
				testEngineerExempt,
			});
			expect(result).toMatchObject({ canAdvance: true });
		}
	});

	test('the exemption does not bypass the admission-only mode (requireCompleteEvidence: false)', () => {
		// The pre-completion admission check authorizes one exact dispatch
		// tuple without the full route; the exemption must not change it.
		const result = enforceReviewRouteReceipt({
			enforcementEnabled: true,
			routeReceipt,
			receipts: [reviewerEvidence],
			requireEvidenceBindings: true,
			requireCompleteEvidence: false,
			expectedDispatch: {
				role: 'reviewer',
				identity: '1.8:reviewer:1',
				callId: 'call-reviewer-1',
				childSessionId: 'child-reviewer-1',
				generation: 1,
			},
			testEngineerExempt: true,
		});
		expect(result).toMatchObject({ canAdvance: true });
	});
});
