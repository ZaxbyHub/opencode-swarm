import { describe, expect, test } from 'bun:test';
import {
	type PrReviewItemClaim,
	parseCriticVerdict,
	parsePrReviewVerdictRows,
	reviewerVerdictRowDigest,
} from '../../../src/pr-review/legacy-transcript-adapter.js';
import { reducePrReviewEvent } from '../../../src/pr-review/reducer.js';
import type {
	PrReviewCriticSettledReceipt,
	PrReviewWorkflowState,
} from '../../../src/pr-review/types.js';

/**
 * Issue #2512 focused registered-path evidence for #2585: substantive critic
 * settlement exercised through the registered transport boundary
 * (`parseCriticVerdict` / `parsePrReviewVerdictRows` — the same parse path
 * collection uses) composed with the `critic_result_recorded` transition.
 * UPHELD, DOWNGRADED and DISPROVED each satisfy the assigned critic
 * coverage; NEEDS_MORE_EVIDENCE never does (it is rejected at the parse
 * boundary as nonterminal, so it cannot even produce a receipt).
 */

function criticRow(itemId: string, status: string, severity: string): string {
	return `[CRITIC] | ${itemId} | ${status} | ${severity} | verified-independently | no-change-required-here`;
}

function reviewerClaim(itemId: string, severity: string): PrReviewItemClaim {
	const fields = [
		'[REVIEWED]',
		itemId,
		'CONFIRMED',
		'summary-that-is-long-enough',
		severity,
		'file.ts',
		'1-20',
		'ORDINARY',
		'',
		'',
		'ORDINARY',
		'',
	];
	return {
		itemId,
		phase: 'reviewer',
		classification: 'CONFIRMED',
		severity,
		rowDigest: reviewerVerdictRowDigest(fields),
	} as PrReviewItemClaim;
}

const BASE: PrReviewWorkflowState = {
	sessionID: 'ses_critic_paths',
	workflowInstanceId: 'wfi_critic_paths',
	revision: 3,
	prHeadSha: 'abc123def',
};

describe('registered critic settlement paths (issue 2512)', () => {
	test('an UPHELD row parses against its reviewer severity and settles coverage', () => {
		const claim = reviewerClaim('f-upheld', 'MEDIUM');
		const parsed = parseCriticVerdict(
			criticRow('f-upheld', 'UPHELD', 'MEDIUM'),
			'f-upheld',
			'MEDIUM',
		);
		expect(parsed).toEqual({ status: 'UPHELD', severity: 'MEDIUM' });
		const receipt: PrReviewCriticSettledReceipt = {
			findingId: 'f-upheld',
			status: 'UPHELD',
			reviewerRowDigest: claim.rowDigest,
		};
		const result = reducePrReviewEvent(BASE, {
			type: 'critic_result_recorded',
			criticRequiredFindingIds: ['f-upheld'],
			criticSettledReceipts: [receipt],
		});
		expect(result.status).toBe('applied');
	});

	test('a DOWNGRADED row parses below its reviewer severity and settles coverage', () => {
		const claim = reviewerClaim('f-downgraded', 'HIGH');
		const parsed = parseCriticVerdict(
			criticRow('f-downgraded', 'DOWNGRADED', 'MEDIUM'),
			'f-downgraded',
			'HIGH',
		);
		expect(parsed).toEqual({ status: 'DOWNGRADED', severity: 'MEDIUM' });
		const result = reducePrReviewEvent(BASE, {
			type: 'critic_result_recorded',
			criticRequiredFindingIds: ['f-downgraded'],
			criticSettledReceipts: [
				{
					findingId: 'f-downgraded',
					status: 'DOWNGRADED',
					reviewerRowDigest: claim.rowDigest,
				},
			],
		});
		expect(result.status).toBe('applied');
	});

	test('a DISPROVED row (severity NONE) parses and settles coverage', () => {
		const claim = reviewerClaim('f-disproved', 'HIGH');
		const parsed = parseCriticVerdict(
			criticRow('f-disproved', 'DISPROVED', 'NONE'),
			'f-disproved',
			'HIGH',
		);
		expect(parsed).toEqual({ status: 'DISPROVED', severity: 'NONE' });
		const result = reducePrReviewEvent(BASE, {
			type: 'critic_result_recorded',
			criticRequiredFindingIds: ['f-disproved'],
			criticSettledReceipts: [
				{
					findingId: 'f-disproved',
					status: 'DISPROVED',
					reviewerRowDigest: claim.rowDigest,
				},
			],
		});
		expect(result.status).toBe('applied');
	});

	test('a NEEDS_MORE_EVIDENCE row is rejected at the parse boundary and cannot settle', () => {
		// The transport schema refuses NEEDS_MORE_EVIDENCE outright — it is
		// deliberately nonterminal, so it can never produce a settled receipt.
		const parsed = parseCriticVerdict(
			criticRow('f-nme', 'NEEDS_MORE_EVIDENCE', 'MEDIUM'),
			'f-nme',
			'MEDIUM',
		);
		expect(parsed).toBeNull();
		// And with no receipt the transition stays rejected (the gate's
		// "require critic coverage for" BLOCKED shape).
		const result = reducePrReviewEvent(BASE, {
			type: 'critic_result_recorded',
			criticRequiredFindingIds: ['f-nme'],
			criticSettledReceipts: [],
		});
		expect(result.status).toBe('rejected');
		if (result.status !== 'rejected') return;
		expect(result.rejection.code).toBe('critic_required_unfulfilled');
		expect(result.rejection.detail).toContain('f-nme');
	});

	test('the registered row-contract parse composes receipts bound to reviewer-row digests', () => {
		const claims = new Map<string, PrReviewItemClaim>(
			[
				reviewerClaim('f-1', 'MEDIUM'),
				reviewerClaim('f-2', 'HIGH'),
				reviewerClaim('f-3', 'HIGH'),
			].map((c) => [c.itemId, c]),
		);
		const text = [
			criticRow('f-1', 'UPHELD', 'MEDIUM'),
			criticRow('f-2', 'DOWNGRADED', 'MEDIUM'),
			criticRow('f-3', 'DISPROVED', 'NONE'),
		].join('\n');
		const { parsed } = parsePrReviewVerdictRows(
			text,
			['f-1', 'f-2', 'f-3'],
			'critic',
			claims,
		);
		expect([...parsed.keys()].sort()).toEqual(['f-1', 'f-2', 'f-3']);
		const receipts: PrReviewCriticSettledReceipt[] = ['f-1', 'f-2', 'f-3'].map(
			(id) => ({
				findingId: id,
				status: parsed.get(id)!
					.classification as PrReviewCriticSettledReceipt['status'],
				reviewerRowDigest: claims.get(id)!.rowDigest,
			}),
		);
		const result = reducePrReviewEvent(BASE, {
			type: 'critic_result_recorded',
			criticRequiredFindingIds: ['f-1', 'f-2', 'f-3'],
			criticSettledReceipts: receipts,
		});
		expect(result.status).toBe('applied');
	});

	test('a row whose severity mismatches its reviewer row is refused at the parse boundary', () => {
		// UPHELD requires an exact severity match; a mismatched row cannot
		// produce a receipt, so its finding stays unfulfilled.
		const parsed = parseCriticVerdict(
			criticRow('f-mismatch', 'UPHELD', 'HIGH'),
			'f-mismatch',
			'MEDIUM',
		);
		expect(parsed).toBeNull();
		const result = reducePrReviewEvent(BASE, {
			type: 'critic_result_recorded',
			criticRequiredFindingIds: ['f-mismatch'],
			criticSettledReceipts: [],
		});
		expect(result.status).toBe('rejected');
	});
});
