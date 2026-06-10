/**
 * Unit tests for parseReviewerDirectiveCompliance (Change 2 / Task 2.3).
 */

import { describe, expect, it } from 'bun:test';
import { parseReviewerDirectiveCompliance } from '../../../src/hooks/reviewer-verdict-parser.js';

describe('parseReviewerDirectiveCompliance', () => {
	it('parses VERIFIED / VIOLATED / N/A verdicts with evidence', () => {
		const text = [
			'VERDICT: APPROVED',
			'DIRECTIVE_COMPLIANCE:',
			'VERIFIED:d-1 evidence=src/foo.ts:42',
			'VIOLATED:d-2 evidence=predicate_failed: grep matched',
			'N/A:d-3 reason=no UI in this change',
		].join('\n');

		const verdicts = parseReviewerDirectiveCompliance(text);
		expect(verdicts).toHaveLength(3);
		expect(verdicts[0]).toEqual({
			id: 'd-1',
			verdict: 'verified',
			evidence: 'src/foo.ts:42',
		});
		expect(verdicts[1].id).toBe('d-2');
		expect(verdicts[1].verdict).toBe('violated');
		expect(verdicts[2]).toEqual({
			id: 'd-3',
			verdict: 'n_a',
			evidence: 'no UI in this change',
		});
	});

	it('handles verdicts without an evidence/reason clause', () => {
		const verdicts = parseReviewerDirectiveCompliance('VERIFIED:abc-123');
		expect(verdicts).toHaveLength(1);
		expect(verdicts[0].id).toBe('abc-123');
		expect(verdicts[0].verdict).toBe('verified');
		expect(verdicts[0].evidence).toBeUndefined();
	});

	it('parses multiple verdicts on the same line', () => {
		const verdicts = parseReviewerDirectiveCompliance(
			'VERIFIED:a-1111 VIOLATED:b-2222 reason=bad',
		);
		expect(verdicts.map((v) => v.id)).toEqual(['a-1111', 'b-2222']);
		expect(verdicts.map((v) => v.verdict)).toEqual(['verified', 'violated']);
	});

	it('is case-insensitive on the verb', () => {
		const verdicts = parseReviewerDirectiveCompliance(
			'verified:x-1\nVIOLATED:y-2',
		);
		expect(verdicts.map((v) => v.verdict)).toEqual(['verified', 'violated']);
	});

	it('returns [] for empty or non-string input', () => {
		expect(parseReviewerDirectiveCompliance('')).toEqual([]);
		// @ts-expect-error testing defensive path
		expect(parseReviewerDirectiveCompliance(null)).toEqual([]);
	});

	it('does not match unrelated text', () => {
		expect(
			parseReviewerDirectiveCompliance('This was VERIFIED by hand earlier.'),
		).toEqual([]);
	});
});
