import { describe, expect, test } from 'bun:test';
import { applySearchQueryPolicy } from '../council/search-query-policy.js';

const NOW = new Date('2026-06-07T12:00:00Z');

describe('applySearchQueryPolicy', () => {
	test('strips stale trailing cutoff year from current-intent queries', () => {
		const result = applySearchQueryPolicy(
			'latest multi agent debate research 2025',
			NOW,
		);
		expect(result.query).toBe('latest multi agent debate research');
		expect(result.temporalIntent).toBe('current');
		expect(result.freshness).toBe('year');
		expect(result.removedStaleYears).toEqual(['2025']);
	});

	test('does not strip explicit historical years inside the query', () => {
		const result = applySearchQueryPolicy('latest 2025 tax guidance', NOW);
		expect(result.query).toBe('latest 2025 tax guidance');
		expect(result.removedStaleYears).toEqual([]);
	});

	test('does not apply freshness to historical-intent queries', () => {
		const result = applySearchQueryPolicy('AI regulations as of 2025', NOW);
		expect(result.temporalIntent).toBe('historical');
		expect(result.freshness).toBeUndefined();
		expect(result.query).toBe('AI regulations as of 2025');
	});

	test('uses day freshness for today and now queries', () => {
		expect(applySearchQueryPolicy('stock news today', NOW).freshness).toBe(
			'day',
		);
		expect(applySearchQueryPolicy('current market now', NOW).freshness).toBe(
			'day',
		);
	});
});
