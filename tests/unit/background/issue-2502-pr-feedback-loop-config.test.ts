/**
 * Configuration contract regressions for issue #2502.
 */
import { describe, expect, test } from 'bun:test';
import { PrFeedbackLoopConfigSchema } from '../../../src/config/schema.js';

describe('issue #2502 PrFeedbackLoopConfigSchema', () => {
	test('defaults to disabled, bounded budgets, publication none', () => {
		expect(PrFeedbackLoopConfigSchema.parse({})).toEqual({
			enabled: false,
			max_actions_per_pr: 3,
			max_session_actions: 10,
			publication: 'none',
		});
	});

	test('rejects a non-none publication mode (single-value enum)', () => {
		expect(() =>
			PrFeedbackLoopConfigSchema.parse({ publication: 'push' }),
		).toThrow();
	});
});
