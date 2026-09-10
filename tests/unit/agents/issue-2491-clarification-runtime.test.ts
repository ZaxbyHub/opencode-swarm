import { describe, expect, test } from 'bun:test';

import {
	ALWAYS_SURFACE_CATEGORIES,
	applyAlwaysSurfacePolicy,
	parseSoundingBoardResponse,
} from '../../../src/agents/critic.js';

describe('issue #2491 — sounding-board clarification runtime contract', () => {
	test('keeps the sticky category allowlist exactly thirteen entries', () => {
		expect(ALWAYS_SURFACE_CATEGORIES).toHaveLength(13);
		expect(new Set(ALWAYS_SURFACE_CATEGORIES).size).toBe(13);
	});

	test('parses response category and applies DROP protection at the parser boundary', () => {
		const result = parseSoundingBoardResponse(
			'Category: security_privacy\nVerdict: UNNECESSARY\nReasoning: already covered.',
		);

		expect(result).toMatchObject({
			category: 'security_privacy',
			categorySource: 'response',
			verdict: 'APPROVED',
			alwaysSurface: true,
		});
	});

	test('caller-owned category takes precedence over a model echo', () => {
		const result = parseSoundingBoardResponse(
			'Category: routine_feedback\nVerdict: UNNECESSARY\nReasoning: enough context.',
			{ category: 'scope' },
		);

		expect(result).toMatchObject({
			category: 'scope',
			categorySource: 'caller',
			verdict: 'APPROVED',
			alwaysSurface: true,
		});
	});

	test('missing category is observable and remains unchanged for the pure parser', () => {
		const result = parseSoundingBoardResponse(
			'Verdict: UNNECESSARY\nReasoning: enough context.',
		);

		expect(result).toMatchObject({
			verdict: 'UNNECESSARY',
			protocolError: 'CATEGORY_MISSING',
		});
		expect(result?.warning).toContain('Category metadata');
	});

	test('unknown categories remain non-sticky for direct policy callers', () => {
		const result = applyAlwaysSurfacePolicy({
			category: 'future_category',
			verdict: 'UNNECESSARY',
		});

		expect(result).toMatchObject({
			category: 'future_category',
			verdict: 'UNNECESSARY',
			alwaysSurface: false,
		});
	});
});
