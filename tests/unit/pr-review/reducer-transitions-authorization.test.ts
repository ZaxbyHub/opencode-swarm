import { describe, expect, test } from 'bun:test';
import { reducePrReviewEvent } from '../../../src/pr-review/reducer.js';
import type { PrReviewAuthorizationBinding, PrReviewWorkflowState } from '../../../src/pr-review/types.js';

const BASE: PrReviewWorkflowState = {
	sessionID: 'ses_auth_1',
	workflowInstanceId: 'wfi_1',
	revision: 7,
	prHeadSha: 'abc123def',
};

const VALID: PrReviewAuthorizationBinding = {
	sessionID: 'ses_auth_1',
	workflowInstanceId: 'wfi_1',
	prHeadSha: 'abc123def',
	generation: 7,
};

describe('reducer: authorization bindings fail closed', () => {
	test('an exact binding publishes', () => {
		const result = reducePrReviewEvent(BASE, {
			type: 'publication_published',
			binding: VALID,
		});
		expect(result.status).toBe('applied');
	});

	test('a foreign session binding is rejected', () => {
		const result = reducePrReviewEvent(BASE, {
			type: 'publication_published',
			binding: { ...VALID, sessionID: 'ses_other' },
		});
		expect(result.status).toBe('rejected');
		if (result.status !== 'rejected') return;
		expect(result.rejection.code).toBe('stale_foreign_authorization');
	});

	test('a different workflow instance is rejected', () => {
		const result = reducePrReviewEvent(BASE, {
			type: 'publication_published',
			binding: { ...VALID, workflowInstanceId: 'wfi_other' },
		});
		expect(result.status).toBe('rejected');
	});

	test('a wrong head SHA is rejected', () => {
		const result = reducePrReviewEvent(BASE, {
			type: 'publication_published',
			binding: { ...VALID, prHeadSha: 'deadbeef' },
		});
		expect(result.status).toBe('rejected');
	});

	test('a stale generation is rejected', () => {
		const result = reducePrReviewEvent(BASE, {
			type: 'publication_published',
			binding: { ...VALID, generation: 6 },
		});
		expect(result.status).toBe('rejected');
		if (result.status !== 'rejected') return;
		expect(result.rejection.detail).toContain('stale');
	});
});

describe('reducer: armed recovery', () => {
	test('an exact-binding recovery cancels dimensions, audits, and invalidates authorization', () => {
		const result = reducePrReviewEvent(BASE, {
			type: 'armed_recovery_requested',
			binding: VALID,
			dimensionsToCancel: ['tests', 'security'],
			nowIso: '2026-09-01T00:00:00.000Z',
		});
		expect(result.status).toBe('applied');
		if (result.status !== 'applied') return;
		expect(result.state.prReviewDimensionCancellations?.tests).toEqual({
			reason: 'armed-recovery cancellation of remaining lanes',
			cancelledAt: '2026-09-01T00:00:00.000Z',
			source: 'armed_recovery',
		});
		expect(result.state.prReviewDimensionCancellations?.security).toBeDefined();
		expect(result.effects).toContainEqual({
			kind: 'append_audit_event',
			code: 'armed_recovery_executed',
		});
		expect(result.effects).toContainEqual({
			kind: 'invalidate_publication_authorization',
		});
	});

	test('a stale-binding recovery is rejected without any cancellation', () => {
		const result = reducePrReviewEvent(BASE, {
			type: 'armed_recovery_requested',
			binding: { ...VALID, generation: 1 },
			dimensionsToCancel: ['tests'],
			nowIso: '2026-09-01T00:00:00.000Z',
		});
		expect(result.status).toBe('rejected');
		if (result.status !== 'rejected') return;
		expect(result.state.prReviewDimensionCancellations).toBeUndefined();
	});
});

describe('reducer: reviewer re-entry consumption', () => {
	test('an exact-binding consumption with the right role is applied', () => {
		const result = reducePrReviewEvent(BASE, {
			type: 'reviewer_authorization_consumed',
			binding: VALID,
			expectedRole: 'reviewer',
			role: 'reviewer',
		});
		expect(result.status).toBe('applied');
	});

	test('a wrong-role consumption is rejected', () => {
		const result = reducePrReviewEvent(BASE, {
			type: 'reviewer_authorization_consumed',
			binding: VALID,
			expectedRole: 'test_engineer',
			role: 'reviewer',
		});
		expect(result.status).toBe('rejected');
		if (result.status !== 'rejected') return;
		expect(result.rejection.code).toBe('stale_foreign_authorization');
	});

	test('a stale-binding consumption is rejected', () => {
		const result = reducePrReviewEvent(BASE, {
			type: 'reviewer_authorization_consumed',
			binding: { ...VALID, generation: 2 },
			expectedRole: 'reviewer',
			role: 'reviewer',
		});
		expect(result.status).toBe('rejected');
	});
});
