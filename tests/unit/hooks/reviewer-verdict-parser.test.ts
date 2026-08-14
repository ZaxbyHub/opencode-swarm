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
			'VERIFIED:trace-1:d-1 evidence=src/foo.ts:42',
			'VIOLATED:trace-2:d-2 evidence=predicate_failed: grep matched',
			'N/A:trace-3:d-3 reason=no UI in this change',
		].join('\n');

		const verdicts = parseReviewerDirectiveCompliance(text);
		expect(verdicts).toHaveLength(3);
		expect(verdicts[0]).toEqual({
			trace_id: 'trace-1',
			entry_id: 'd-1',
			verdict: 'verified',
			evidence: 'src/foo.ts:42',
		});
		expect(verdicts[1].entry_id).toBe('d-2');
		expect(verdicts[1].verdict).toBe('violated');
		expect(verdicts[2]).toEqual({
			trace_id: 'trace-3',
			entry_id: 'd-3',
			verdict: 'n_a',
			evidence: 'no UI in this change',
		});
	});

	it('handles verdicts without an evidence/reason clause', () => {
		const verdicts = parseReviewerDirectiveCompliance(
			'VERIFIED:trace-abc:entry-123',
		);
		expect(verdicts).toHaveLength(1);
		expect(verdicts[0].trace_id).toBe('trace-abc');
		expect(verdicts[0].entry_id).toBe('entry-123');
		expect(verdicts[0].verdict).toBe('verified');
		expect(verdicts[0].evidence).toBeUndefined();
	});

	it('parses multiple verdicts on the same line', () => {
		const verdicts = parseReviewerDirectiveCompliance(
			'VERIFIED:t-1:a-1111 VIOLATED:t-2:b-2222 reason=bad',
		);
		expect(verdicts.map((v) => v.entry_id)).toEqual(['a-1111', 'b-2222']);
		expect(verdicts.map((v) => v.verdict)).toEqual(['verified', 'violated']);
	});

	it('is case-insensitive on the verb', () => {
		const verdicts = parseReviewerDirectiveCompliance(
			'verified:trace-x:x-1\nVIOLATED:trace-y:y-2',
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

	it('decodes delimiter-safe correlation tokens and preserves repeated entry ids', () => {
		const verdicts = parseReviewerDirectiveCompliance(
			[
				'VERIFIED:trace%3Aone:shared%20entry evidence=first',
				'VIOLATED:trace%3Atwo:shared%20entry evidence=second',
			].join('\n'),
		);
		expect(
			verdicts.map(({ trace_id, entry_id }) => ({ trace_id, entry_id })),
		).toEqual([
			{ trace_id: 'trace:one', entry_id: 'shared entry' },
			{ trace_id: 'trace:two', entry_id: 'shared entry' },
		]);
	});

	it('rejects legacy, malformed, and over-delimited correlation grammar', () => {
		const tooLong = 'x'.repeat(513);
		expect(
			parseReviewerDirectiveCompliance(
				`VERIFIED:legacy-only\nVERIFIED:%ZZ:entry\nVERIFIED:a:b:c\nVERIFIED:${tooLong}:entry`,
			),
		).toEqual([]);
	});
});
