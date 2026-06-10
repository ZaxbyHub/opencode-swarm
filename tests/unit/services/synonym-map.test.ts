/**
 * Pure-function + poisoning tests for the tag co-occurrence synonym map
 * (Change 5 / Task 6.2).
 */

import { describe, expect, it } from 'bun:test';
import {
	_internals,
	buildSynonymIndex,
	buildSynonymMap,
	coerceSynonymMap,
	emptySynonymMap,
	expandTokens,
	pairKey,
	recordEntryCooccurrences,
	sanitizeToken,
	tokensForEntry,
} from '../../../src/services/synonym-map.js';

describe('sanitizeToken', () => {
	it('lowercases, collapses whitespace, and trims', () => {
		expect(sanitizeToken('  Module   Mocks ')).toBe('module mocks');
	});
	it('strips control characters (poisoning defence)', () => {
		expect(sanitizeToken('mo\x00ck\x1b[31m')).toBe('mo ck [31m');
	});
	it('rejects non-strings and empties', () => {
		expect(sanitizeToken(undefined)).toBeNull();
		expect(sanitizeToken(42)).toBeNull();
		expect(sanitizeToken('   ')).toBeNull();
		expect(sanitizeToken('\x00\x01')).toBeNull();
	});
	it('rejects over-length tokens', () => {
		expect(
			sanitizeToken('x'.repeat(_internals.MAX_TOKEN_LENGTH)),
		).not.toBeNull();
		expect(
			sanitizeToken('x'.repeat(_internals.MAX_TOKEN_LENGTH + 1)),
		).toBeNull();
	});
});

describe('pairKey', () => {
	it('is order-independent', () => {
		expect(pairKey('b', 'a')).toBe(pairKey('a', 'b'));
	});
});

describe('tokensForEntry', () => {
	it('unions triggers/tags/tools/agents, sanitised and de-duplicated', () => {
		const tokens = tokensForEntry({
			triggers: ['Mocks', 'mocks'],
			tags: ['seams'],
			applies_to_tools: ['edit'],
			applies_to_agents: ['coder'],
		});
		expect(tokens.sort()).toEqual(['coder', 'edit', 'mocks', 'seams']);
	});
});

describe('recordEntryCooccurrences', () => {
	it('increments each distinct pair once per entry', () => {
		const map = emptySynonymMap();
		recordEntryCooccurrences(map, { tags: ['a', 'b', 'a'] });
		expect(map.pairs[pairKey('a', 'b')].count).toBe(1);
		recordEntryCooccurrences(map, { tags: ['a', 'b'] });
		expect(map.pairs[pairKey('a', 'b')].count).toBe(2);
	});
	it('ignores entries with fewer than two distinct tokens', () => {
		const map = emptySynonymMap();
		recordEntryCooccurrences(map, { tags: ['solo'] });
		expect(Object.keys(map.pairs)).toHaveLength(0);
	});
	it('enforces the LRU cap, evicting the oldest pairs', () => {
		const map = emptySynonymMap();
		// Each entry of two unique tokens creates exactly one pair.
		recordEntryCooccurrences(map, { tags: ['old1', 'old2'] }, 2);
		recordEntryCooccurrences(map, { tags: ['mid1', 'mid2'] }, 2);
		recordEntryCooccurrences(map, { tags: ['new1', 'new2'] }, 2);
		const keys = Object.keys(map.pairs);
		expect(keys).toHaveLength(2);
		expect(map.pairs[pairKey('old1', 'old2')]).toBeUndefined();
		expect(map.pairs[pairKey('new1', 'new2')]).toBeDefined();
	});
	it('refreshes recency so a re-seen old pair survives eviction', () => {
		const map = emptySynonymMap();
		recordEntryCooccurrences(map, { tags: ['a', 'b'] }, 2);
		recordEntryCooccurrences(map, { tags: ['c', 'd'] }, 2);
		// Touch a/b again — now c/d is the oldest.
		recordEntryCooccurrences(map, { tags: ['a', 'b'] }, 2);
		recordEntryCooccurrences(map, { tags: ['e', 'f'] }, 2);
		expect(map.pairs[pairKey('a', 'b')]).toBeDefined();
		expect(map.pairs[pairKey('c', 'd')]).toBeUndefined();
	});
});

describe('buildSynonymIndex + expandTokens', () => {
	function corpus() {
		// "mocks" and "seams" co-occur 3×; "mocks"/"edit" only 1×.
		return buildSynonymMap([
			{ tags: ['mocks', 'seams'] },
			{ tags: ['mocks', 'seams'] },
			{ tags: ['mocks', 'seams', 'edit'] },
		]);
	}

	it('keeps only pairs at or above the threshold', () => {
		const index = buildSynonymIndex(corpus(), 3);
		expect(index.get('mocks')).toEqual(new Set(['seams']));
		// edit co-occurred with mocks only once → below threshold.
		expect(index.get('edit')).toBeUndefined();
	});

	it('expands a query token to its synonyms, excluding originals', () => {
		const index = buildSynonymIndex(corpus(), 3);
		expect(expandTokens(index, ['mocks'])).toEqual(['seams']);
		// Symmetric.
		expect(expandTokens(index, ['seams'])).toEqual(['mocks']);
	});

	it('never echoes an input token back as its own synonym', () => {
		const index = buildSynonymIndex(corpus(), 3);
		expect(expandTokens(index, ['mocks', 'seams'])).toEqual([]);
	});

	it('caps expansions per token', () => {
		const map = buildSynonymMap([
			{ tags: ['hub', 's1', 's2', 's3', 's4', 's5'] },
			{ tags: ['hub', 's1', 's2', 's3', 's4', 's5'] },
		]);
		const index = buildSynonymIndex(map, 2);
		expect(expandTokens(index, ['hub'], 2)).toHaveLength(2);
	});
});

describe('coerceSynonymMap (tamper resistance)', () => {
	it('returns empty for non-objects and wrong versions', () => {
		expect(coerceSynonymMap(null).pairs).toEqual({});
		expect(coerceSynonymMap('nope').pairs).toEqual({});
		expect(coerceSynonymMap({ version: 2, pairs: {} }).pairs).toEqual({});
	});

	it('drops malformed pairs and re-sanitises tokens', () => {
		const tampered = {
			version: 1,
			cursor: 5,
			pairs: {
				good: { a: 'alpha', b: 'beta', count: 4, seq: 1 },
				ctl: { a: 'ev\x00il', b: 'beta', count: 9, seq: 2 },
				badcount: { a: 'x', b: 'y', count: -3, seq: 3 },
				notpair: { a: 'x', count: 1 },
			},
		};
		const map = coerceSynonymMap(tampered);
		// The control-char token is re-sanitised, not dropped, but re-keyed.
		expect(map.pairs[pairKey('alpha', 'beta')]).toBeDefined();
		expect(map.pairs[pairKey('ev il', 'beta')]).toBeDefined();
		expect(map.pairs[pairKey('x', 'y')]).toBeUndefined();
		// No pair retains a raw control character in its members.
		for (const p of Object.values(map.pairs)) {
			expect(/[\x00-\x1f\x7f]/.test(p.a + p.b)).toBe(false);
		}
	});

	it('coalesces duplicate orderings, keeping the larger count', () => {
		const map = coerceSynonymMap({
			version: 1,
			cursor: 0,
			pairs: {
				k1: { a: 'a', b: 'b', count: 2, seq: 1 },
				k2: { a: 'b', b: 'a', count: 7, seq: 2 },
			},
		});
		expect(Object.keys(map.pairs)).toHaveLength(1);
		expect(map.pairs[pairKey('a', 'b')].count).toBe(7);
	});

	it('enforces the maxPairs cap on READ, keeping the most recent (unbounded-pairs poisoning)', () => {
		// A tampered file with far more pairs than the cap must not produce an
		// oversized in-memory map — the read path applies the same LRU cap as the
		// write path so every retrieval stays bounded.
		const pairs: Record<string, unknown> = {};
		for (let i = 0; i < 5000; i++) {
			pairs[`k${i}`] = { a: `a${i}`, b: `b${i}`, count: 2, seq: i + 1 };
		}
		const map = coerceSynonymMap({ version: 1, cursor: 5000, pairs }, 10);
		expect(Object.keys(map.pairs)).toHaveLength(10);
		// The highest-seq (most recent) survive; the oldest are evicted.
		expect(map.pairs[pairKey('a4999', 'b4999')]).toBeDefined();
		expect(map.pairs[pairKey('a4990', 'b4990')]).toBeDefined();
		expect(map.pairs[pairKey('a4989', 'b4989')]).toBeUndefined();
		expect(map.pairs[pairKey('a0', 'b0')]).toBeUndefined();
	});
});

describe('determinism', () => {
	it('build is independent of entry order for the derived index', () => {
		const a = buildSynonymMap([
			{ tags: ['x', 'y'] },
			{ tags: ['x', 'y'] },
			{ tags: ['x', 'y'] },
		]);
		const b = buildSynonymMap([
			{ tags: ['y', 'x'] },
			{ tags: ['x', 'y'] },
			{ tags: ['x', 'y'] },
		]);
		const ia = buildSynonymIndex(a, 3);
		const ib = buildSynonymIndex(b, 3);
		expect(expandTokens(ia, ['x'])).toEqual(expandTokens(ib, ['x']));
	});
});
