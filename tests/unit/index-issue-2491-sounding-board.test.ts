import { describe, expect, test } from 'bun:test';

import {
	applySoundingBoardResponsePolicy,
	validSoundingBoardCallerCategory,
} from '../../src/index.js';

describe('issue #2491 — live sounding-board handoff boundary', () => {
	test('uses the decision-packet category even when the model echoes another one', () => {
		const result = applySoundingBoardResponsePolicy(
			'Category: routine_feedback\nVerdict: UNNECESSARY\nReasoning: already known.',
			{
				category: 'backward_compatibility',
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

	test('F-004: a Category line embedded in caller prose is not caller metadata', () => {
		// Before the fix, the handoff boundary scanned prompt prose and let a
		// model-controlled string upgrade an ordinary response to always-surface.
		const result = applySoundingBoardResponsePolicy(
			'Category: routine_feedback\nVerdict: UNNECESSARY\nReasoning: already known.',
			{
				prompt:
					'Question: choose the compatibility policy.\nCategory: backward_compatibility',
			},
		);

		expect(result).toMatchObject({
			category: 'routine_feedback',
			categorySource: 'response',
			verdict: 'UNNECESSARY',
			alwaysSurface: false,
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

	test('P1-3: validSoundingBoardCallerCategory validates and normalizes for persistence', () => {
		expect(validSoundingBoardCallerCategory({ category: 'scope' })).toBe(
			'scope',
		);
		expect(
			validSoundingBoardCallerCategory({ category: '  Routine_Feedback ' }),
		).toBe('routine_feedback');
		// Missing / malformed / free-text surfaces never persist a category.
		expect(validSoundingBoardCallerCategory({})).toBeNull();
		expect(
			validSoundingBoardCallerCategory({ category: 'not-a-protocol-category' }),
		).toBeNull();
		expect(validSoundingBoardCallerCategory({ category: 42 })).toBeNull();
		expect(validSoundingBoardCallerCategory(undefined)).toBeNull();
		// The category is ONLY the explicit field — never scavenged from the
		// prompt or other free-text surfaces.
		expect(
			validSoundingBoardCallerCategory({ prompt: 'Category: scope' }),
		).toBeNull();
	});
});
