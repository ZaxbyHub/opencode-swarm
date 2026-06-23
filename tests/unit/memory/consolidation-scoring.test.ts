import { describe, expect, test } from 'bun:test';
import {
	clusterByJaccard,
	type ImportanceWeights,
	importanceScore,
	jaccard,
	tokenize,
} from '../../../src/memory/scoring';

const WEIGHTS: ImportanceWeights = {
	wRecency: 0.2,
	wFrequency: 0.2,
	wFreshness: 0.15,
	wConfidence: 0.25,
	lambda: 0.05,
	mu: 0.01,
	n: 50,
};
const THRESHOLD = 0.2;

describe('jaccard', () => {
	test('identical token sets score 1', () => {
		expect(
			jaccard(tokenize('bun runs the tests'), tokenize('bun runs the tests')),
		).toBe(1);
	});

	test('disjoint sets score 0', () => {
		expect(jaccard(tokenize('alpha beta'), tokenize('gamma delta'))).toBe(0);
	});

	test('two empty sets score 0 (not NaN)', () => {
		expect(jaccard(new Set(), new Set())).toBe(0);
	});

	test('partial overlap is intersection over union', () => {
		// {a,b,c} vs {b,c,d}: intersection 2, union 4 => 0.5
		expect(jaccard(tokenize('a b c'), tokenize('b c d'))).toBeCloseTo(0.5, 5);
	});
});

describe('clusterByJaccard', () => {
	test('groups items sharing tokens above threshold', () => {
		const items = [
			'the build uses bun for tests',
			'bun is used for the build tests',
			'authentication uses oauth tokens',
		];
		const clusters = clusterByJaccard(items, (s) => s, 0.3);
		expect(clusters.length).toBe(2);
		expect(clusters[0].length).toBe(2);
		expect(clusters[1].length).toBe(1);
	});

	test('a high threshold prevents grouping distinct phrasings', () => {
		const items = ['bun runs tests', 'bun executes the suite'];
		const clusters = clusterByJaccard(items, (s) => s, 0.9);
		expect(clusters.length).toBe(2);
	});

	test('is deterministic for a fixed input order', () => {
		const items = ['x y z', 'x y z', 'q r s'];
		const a = clusterByJaccard(items, (s) => s, 0.5);
		const b = clusterByJaccard(items, (s) => s, 0.5);
		expect(a).toEqual(b);
	});
});

describe('importanceScore (DD-11)', () => {
	test('high-confidence, never-recalled, aged memory stays above the low-utility threshold', () => {
		// This is the exact DD-11 scenario: under the old `||` heuristic a
		// confidence>0.45, age>30d, never-recalled memory was flagged low-utility.
		const importance = importanceScore(
			{
				confidence: 0.9,
				retrievalCount: 0,
				daysSinceLastRecall: null,
				daysSinceCreated: 60,
			},
			WEIGHTS,
		);
		expect(importance).toBeGreaterThan(THRESHOLD);
	});

	test('low-confidence, never-recalled, stale memory falls below the threshold', () => {
		const importance = importanceScore(
			{
				confidence: 0.1,
				retrievalCount: 0,
				daysSinceLastRecall: null,
				daysSinceCreated: 200,
			},
			WEIGHTS,
		);
		expect(importance).toBeLessThan(THRESHOLD);
	});

	test('recency increases importance monotonically (more recent recall scores higher)', () => {
		const recent = importanceScore(
			{
				confidence: 0.5,
				retrievalCount: 3,
				daysSinceLastRecall: 1,
				daysSinceCreated: 10,
			},
			WEIGHTS,
		);
		const old = importanceScore(
			{
				confidence: 0.5,
				retrievalCount: 3,
				daysSinceLastRecall: 100,
				daysSinceCreated: 10,
			},
			WEIGHTS,
		);
		expect(recent).toBeGreaterThan(old);
	});

	test('frequency increases importance monotonically', () => {
		const more = importanceScore(
			{
				confidence: 0.5,
				retrievalCount: 20,
				daysSinceLastRecall: 5,
				daysSinceCreated: 10,
			},
			WEIGHTS,
		);
		const fewer = importanceScore(
			{
				confidence: 0.5,
				retrievalCount: 1,
				daysSinceLastRecall: 5,
				daysSinceCreated: 10,
			},
			WEIGHTS,
		);
		expect(more).toBeGreaterThan(fewer);
	});

	test('never-recalled contributes zero recency and frequency', () => {
		const score = importanceScore(
			{
				confidence: 0,
				retrievalCount: 0,
				daysSinceLastRecall: null,
				daysSinceCreated: 0,
			},
			WEIGHTS,
		);
		// Only freshness (=1 at age 0) * wFreshness remains.
		expect(score).toBeCloseTo(WEIGHTS.wFreshness, 5);
	});
});
