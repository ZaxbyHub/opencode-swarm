import { describe, expect, test } from 'bun:test';

import { applySoundingBoardResponsePolicy } from '../../src/index.js';

describe('issue #2491 — live sounding-board handoff boundary', () => {
	test('uses the decision-packet category even when the model echoes another one', () => {
		const result = applySoundingBoardResponsePolicy(
			'Category: routine_feedback\nVerdict: UNNECESSARY\nReasoning: already known.',
			{
				prompt:
					'Question: choose the compatibility policy.\nCategory: backward_compatibility',
			},
		);

		expect(result).toMatchObject({
			category: 'backward_compatibility',
			categorySource: 'caller',
			verdict: 'APPROVED',
			alwaysSurface: true,
		});
	});

	test('surfaces an unclassified UNNECESSARY response as APPROVED with a warning', () => {
		const result = applySoundingBoardResponsePolicy(
			'Verdict: UNNECESSARY\nReasoning: enough context.',
		);

		expect(result).toMatchObject({
			verdict: 'APPROVED',
			protocolError: 'CATEGORY_MISSING',
		});
		expect(result?.warning).toContain('Category metadata');
	});

	test('does not let malformed caller metadata fall back to model category', () => {
		const result = applySoundingBoardResponsePolicy(
			'Category: security_privacy\nVerdict: UNNECESSARY\nReasoning: enough context.',
			{ category: 'not-a-protocol-category' },
		);

		expect(result).toMatchObject({
			verdict: 'APPROVED',
			protocolError: 'CALLER_CATEGORY_INVALID',
		});
		expect(result?.category).toBeUndefined();
	});
});
