import { describe, expect, test } from 'bun:test';

import { applyAlwaysSurfacePolicy } from '../../../src/agents/critic.js';

describe('issue #2491 — always-surface clarification policy (AC1)', () => {
	const alwaysSurfaceCategories = [
		'scope',
		'data_loss',
		'security_privacy',
		'backward_compatibility',
		'breaking_api',
		'new_dependency',
		'deprecation',
		'cross_platform',
		'cost_performance',
		'user_visible_ux',
		'rollout',
		'qa_policy',
		'advisory_vs_blocking',
	] as const;

	for (const category of alwaysSurfaceCategories) {
		test(`overrides UNNECESSARY for ${category}`, () => {
			const result = applyAlwaysSurfacePolicy({
				category,
				verdict: 'UNNECESSARY',
			});

			expect(result).toMatchObject({
				category,
				verdict: 'APPROVED',
				alwaysSurface: true,
			});
		});
	}

	test('preserves an ordinary UNNECESSARY outcome', () => {
		const result = applyAlwaysSurfacePolicy({
			category: 'routine_feedback',
			verdict: 'UNNECESSARY',
		});

		expect(result).toMatchObject({
			category: 'routine_feedback',
			verdict: 'UNNECESSARY',
			alwaysSurface: false,
		});
	});

	for (const verdict of ['REPHRASE', 'RESOLVE', 'APPROVED'] as const) {
		test(`preserves ${verdict} for an always-surface category`, () => {
			const result = applyAlwaysSurfacePolicy({
				category: 'security_privacy',
				verdict,
			});

			expect(result).toMatchObject({
				category: 'security_privacy',
				verdict,
				alwaysSurface: true,
			});
		});
	}

	test('does not rewrite a non-sticky approved outcome', () => {
		const result = applyAlwaysSurfacePolicy({
			category: 'routine_feedback',
			verdict: 'APPROVED',
		});

		expect(result.verdict).toBe('APPROVED');
	});

	test('leaves an unknown category unchanged and non-sticky', () => {
		const result = applyAlwaysSurfacePolicy({
			category: 'future_category_not_in_contract',
			verdict: 'UNNECESSARY',
		});

		expect(result).toMatchObject({
			category: 'future_category_not_in_contract',
			verdict: 'UNNECESSARY',
			alwaysSurface: false,
		});
	});
});
