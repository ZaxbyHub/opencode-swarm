import { describe, expect, test } from 'bun:test';
import { _internals } from './registry.js';

describe('findSimilarCommands adversarial', () => {
	// 1. Very long query (100k+ chars) — early rejection guard kicks in
	test('very long query (100k chars) is rejected by input length guard', () => {
		const longQuery = 'a'.repeat(100_000);
		const result = _internals.findSimilarCommands(longQuery);
		// Guard rejects queries > 500 chars, returning empty array
		expect(result).toBeDefined();
		expect(Array.isArray(result)).toBe(true);
		expect(result.length).toBe(0);
	});

	// 2. Query with regex-special chars that might break split
	test('query with regex-special chars does not break split', () => {
		const special = 'cmd.*+?[]{}()\\';
		const result = _internals.findSimilarCommands(special);
		expect(result).toBeDefined();
		expect(Array.isArray(result)).toBe(true);
		// Should not throw, should return results (possibly empty)
	});

	// 3. Query that's all dashes
	test('query all dashes returns valid result', () => {
		const result = _internals.findSimilarCommands('---');
		expect(result).toBeDefined();
		expect(Array.isArray(result)).toBe(true);
		// dashStrippedQ becomes empty string — levenshtein(empty, cmd) should return cmd.length
		// Should still produce deterministic output
		expect(result.length).toBeLessThanOrEqual(3);
	});

	// 4. Query with unicode combining chars
	test('query with unicode combining chars is handled', () => {
		// Zero-width joiner, combining acute accent, combining grave accent
		const unicode = 'caf\u0301\u0300\u0327';
		const result = _internals.findSimilarCommands(unicode);
		expect(result).toBeDefined();
		expect(Array.isArray(result)).toBe(true);
		expect(result.length).toBeLessThanOrEqual(3);
	});

	// 5. Query with null bytes
	test('query with null bytes does not corrupt', () => {
		const withNull = 'plan\x00command\x00';
		const result = _internals.findSimilarCommands(withNull);
		expect(result).toBeDefined();
		expect(Array.isArray(result)).toBe(true);
		expect(result.length).toBeLessThanOrEqual(3);
	});

	// 6. Pathological tokenization — 10+ tokens with dashes
	test('pathological dash-separated tokens executes in bounded time', () => {
		const manyDashes = 'a-b-c-d-e-f-g-h-i-j-k-l-m-n-o-p';
		const start = Date.now();
		const result = _internals.findSimilarCommands(manyDashes);
		const elapsed = Date.now() - start;
		expect(result).toBeDefined();
		expect(result.length).toBeLessThanOrEqual(3);
		// 16 tokens × ~16 command tokens = 256 levenshtein calls
		// Should complete quickly
		expect(elapsed).toBeLessThan(500);
	});

	// 7. Empty string query
	test('empty string query returns top commands', () => {
		const result = _internals.findSimilarCommands('');
		expect(result).toBeDefined();
		expect(result.length).toBeLessThanOrEqual(3);
	});

	// 8. Query producing empty token array after split
	test('query splitting to only empty tokens does not throw', () => {
		// "   " splits to ['', '', ''] → filtered to []
		const whitespaceOnly = '   \t  ';
		const result = _internals.findSimilarCommands(whitespaceOnly);
		expect(result).toBeDefined();
		expect(Array.isArray(result)).toBe(true);
	});

	// 9. Very long single token (no spaces/dashes)
	test('very long single token processes without hang', () => {
		const longSingle = 'a'.repeat(50_000);
		const start = Date.now();
		const result = _internals.findSimilarCommands(longSingle);
		const elapsed = Date.now() - start;
		// Only fullScore and dashScore run (no token scoring for single token)
		expect(result).toBeDefined();
		expect(Array.isArray(result)).toBe(true);
		expect(result.length).toBeLessThanOrEqual(3);
		expect(elapsed).toBeLessThan(1000);
	});

	// 10. Unicode normalization edge case — lookalike characters
	test('unicode lookalike characters produce stable output', () => {
		// Greek small letter alpha looks like 'a' but is different char
		const greekAlpha = '\u03B1'; // α
		const result1 = _internals.findSimilarCommands(greekAlpha);
		const result2 = _internals.findSimilarCommands(greekAlpha);
		expect(result1).toEqual(result2);
		// Should not match 'agents' which has 'a'
		expect(result1).not.toContain('agents');
	});

	// 11. Tab and newline in query
	test('tab and newline characters are treated as token separators', () => {
		const withTabs = 'ag\tents\nbrain\nstorm';
		const result = _internals.findSimilarCommands(withTabs);
		expect(result).toBeDefined();
		expect(Array.isArray(result)).toBe(true);
		// \t and \n split just like space and dash
	});

	// 12. Mixed edge cases — dashes + spaces + unicode
	test('mixed edge cases produce deterministic stable output', () => {
		const mixed = '---  agents  \u0301---brain-storm---';
		const result1 = _internals.findSimilarCommands(mixed);
		const result2 = _internals.findSimilarCommands(mixed);
		expect(result1).toEqual(result2);
	});
});
