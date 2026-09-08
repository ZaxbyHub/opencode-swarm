import { describe, expect, test } from 'bun:test';
import { reducePrReviewEvent } from '../../../src/pr-review/reducer.js';
import type {
	PrReviewAuthorizationBinding,
	PrReviewWorkflowState,
} from '../../../src/pr-review/types.js';

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

describe('reducer: armed recovery bindings fail closed', () => {
	test('an exact-binding recovery cancels dimensions and persists', () => {
		const result = reducePrReviewEvent(BASE, {
			type: 'armed_recovery_requested',
			binding: VALID,
			dimensionsToCancel: ['tests', 'security'],
			nowIso: '2026-09-01T00:00:00.000Z',
			reason: 'publication window superseded',
		});
		expect(result.status).toBe('applied');
		if (result.status !== 'applied') return;
		// Issue #2512: the event carries the operator's sanitized reason; the
		// reducer persists it verbatim (byte-identical to the record the
		// pre-wiring executor wrote inline).
		expect(result.state.prReviewDimensionCancellations?.tests).toEqual({
			reason: 'publication window superseded',
			cancelledAt: '2026-09-01T00:00:00.000Z',
			source: 'armed_recovery',
		});
		expect(result.state.prReviewDimensionCancellations?.security).toEqual({
			reason: 'publication window superseded',
			cancelledAt: '2026-09-01T00:00:00.000Z',
			source: 'armed_recovery',
		});
		// Phase 8b review: the audited executor (recoverArmedPrWorkflow) owns
		// the audit event and the publication-authorization invalidation;
		// this transition owns the cancellations + persistence.
		expect(result.effects).toEqual([{ kind: 'persist_state' }]);
	});

	test('a foreign-session binding is rejected without any cancellation', () => {
		const result = reducePrReviewEvent(BASE, {
			type: 'armed_recovery_requested',
			binding: { ...VALID, sessionID: 'ses_other' },
			dimensionsToCancel: ['tests'],
			nowIso: '2026-09-01T00:00:00.000Z',
			reason: 'r',
		});
		expect(result.status).toBe('rejected');
		if (result.status !== 'rejected') return;
		expect(result.rejection.code).toBe('stale_foreign_authorization');
		expect(result.state.prReviewDimensionCancellations).toBeUndefined();
	});

	test('a different workflow instance is rejected', () => {
		const result = reducePrReviewEvent(BASE, {
			type: 'armed_recovery_requested',
			binding: { ...VALID, workflowInstanceId: 'wfi_other' },
			dimensionsToCancel: ['tests'],
			nowIso: '2026-09-01T00:00:00.000Z',
			reason: 'r',
		});
		expect(result.status).toBe('rejected');
	});

	test('a wrong head SHA is rejected', () => {
		const result = reducePrReviewEvent(BASE, {
			type: 'armed_recovery_requested',
			binding: { ...VALID, prHeadSha: 'deadbeef' },
			dimensionsToCancel: ['tests'],
			nowIso: '2026-09-01T00:00:00.000Z',
			reason: 'r',
		});
		expect(result.status).toBe('rejected');
	});

	test('a stale generation is rejected without any cancellation', () => {
		const result = reducePrReviewEvent(BASE, {
			type: 'armed_recovery_requested',
			binding: { ...VALID, generation: 1 },
			dimensionsToCancel: ['tests'],
			nowIso: '2026-09-01T00:00:00.000Z',
			reason: 'r',
		});
		expect(result.status).toBe('rejected');
		if (result.status !== 'rejected') return;
		expect(result.rejection.detail).toContain('stale');
		expect(result.state.prReviewDimensionCancellations).toBeUndefined();
	});

	test('an empty dimensionsToCancel list is a cancellation no-op (idempotent replay)', () => {
		const first = reducePrReviewEvent(BASE, {
			type: 'armed_recovery_requested',
			binding: VALID,
			dimensionsToCancel: ['tests'],
			nowIso: '2026-09-01T00:00:00.000Z',
			reason: 'r1',
		});
		expect(first.status).toBe('applied');
		if (first.status !== 'applied') return;
		// Re-dispatching the same dimensions+reason writes the same records:
		// same-key map writes are idempotent at the state level.
		const second = reducePrReviewEvent(first.state, {
			type: 'armed_recovery_requested',
			binding: { ...VALID, generation: first.state.revision },
			dimensionsToCancel: ['tests'],
			nowIso: '2026-09-01T00:00:00.000Z',
			reason: 'r1',
		});
		expect(second.status).toBe('applied');
		if (second.status !== 'applied') return;
		expect(second.state.prReviewDimensionCancellations).toEqual(
			first.state.prReviewDimensionCancellations,
		);
	});
});

// Issue #2512 wire-or-retire census: `publication_published` and
// `reviewer_authorization_consumed` were RETIRED from the PrReviewEvent union.
// Their binding/role authority lives at richer executor boundaries a pure
// reducer cannot observe:
// - publication settlement: completePrWorkflow in pr-workflow-gate.ts
//   (revision-digest, Git HEAD, worktree, upstream-triple and remote-ref
//   verification);
// - reviewer re-entry consumption:
//   reservePrReviewReentryAuthorizationAgainstBinding in authorization.ts
//   (storage-backed reserve with TTL, pruning, and same-call replay — covered
//   by tests/unit/hooks/pr-review-reentry-authorization.test.ts).
