import { beforeEach, describe, expect, it } from 'bun:test';
import {
	clearParserCache,
	getSupportedLanguages,
	isGrammarAvailable,
	loadGrammar,
	parserCache,
} from '../../../src/lang/runtime';

describe('runtime.ts - Security Verification Tests', () => {
	beforeEach(() => {
		clearParserCache();
	});

	describe('1. New language support (kotlin, swift, dart)', () => {
		it('should include kotlin in supported languages', () => {
			const supported = getSupportedLanguages();
			expect(supported).toContain('kotlin');
		});

		it('should include swift in supported languages', () => {
			const supported = getSupportedLanguages();
			expect(supported).toContain('swift');
		});

		it('should include dart in supported languages', () => {
			const supported = getSupportedLanguages();
			expect(supported).toContain('dart');
		});

		it('should report kotlin as available (WASM exists)', async () => {
			const available = await isGrammarAvailable('kotlin');
			expect(available).toBe(true);
		});

		it('should report swift as available (WASM exists)', async () => {
			const available = await isGrammarAvailable('swift');
			expect(available).toBe(true);
		});

		it('should report dart as available (WASM exists)', async () => {
			const available = await isGrammarAvailable('dart');
			expect(available).toBe(true);
		});
	});

	describe('2. Tab in language ID (kotlin\\tscript)', () => {
		it('should throw when loading with tab in language ID', async () => {
			// Whitelist rejects: 'kotlin\tscript' contains tab, not in [a-z0-9-]
			let threw = false;
			try {
				await loadGrammar('kotlin\tscript');
			} catch (e) {
				threw = true;
				expect((e as Error).message).toMatch(/Invalid language ID/);
			}
			expect(threw).toBe(true);
		});
	});

	describe('3. Length validation > 100 characters', () => {
		it('should throw when loadGrammar receives languageId > 100 chars', async () => {
			const longId = 'a'.repeat(101);
			let threw = false;
			try {
				await loadGrammar(longId);
			} catch (e) {
				threw = true;
				expect((e as Error).message).toMatch(
					/must be a string of at most 100 characters/,
				);
			}
			expect(threw).toBe(true);
		});

		it('should throw when loadGrammar receives exactly 101 chars', async () => {
			const longId = 'javascript' + 'x'.repeat(93); // 101 total
			let threw = false;
			try {
				await loadGrammar(longId);
			} catch (e) {
				threw = true;
				expect((e as Error).message).toMatch(
					/must be a string of at most 100 characters/,
				);
			}
			expect(threw).toBe(true);
		});

		it('should accept languageId of exactly 100 characters', async () => {
			// Note: This will fail with "Grammar file not found" but should pass length check
			// 'javascript' is 10 chars, so we need 90 more to make 100
			const hundredCharId = 'javascript' + 'x'.repeat(90); // 100 total
			let threw = false;
			try {
				await loadGrammar(hundredCharId);
			} catch (e) {
				threw = true;
				expect((e as Error).message).toMatch(/Grammar file not found/);
			}
			expect(threw).toBe(true);
			// The error should NOT be about length (we verify by checking it threw for file not found)
			expect(threw).toBe(true);
		});
	});

	describe('4. Type validation - non-string input', () => {
		it('isGrammarAvailable should return false for null', async () => {
			const result = await isGrammarAvailable(null as unknown as string);
			expect(result).toBe(false);
		});

		it('isGrammarAvailable should return false for undefined', async () => {
			const result = await isGrammarAvailable(undefined as unknown as string);
			expect(result).toBe(false);
		});

		it('isGrammarAvailable should return false for number', async () => {
			const result = await isGrammarAvailable(123 as unknown as string);
			expect(result).toBe(false);
		});

		it('isGrammarAvailable should return false for object', async () => {
			const result = await isGrammarAvailable({
				foo: 'bar',
			} as unknown as string);
			expect(result).toBe(false);
		});

		it('isGrammarAvailable should return false for array', async () => {
			const result = await isGrammarAvailable([
				'javascript',
			] as unknown as string);
			expect(result).toBe(false);
		});

		it('loadGrammar should throw for null', async () => {
			let threw = false;
			try {
				await loadGrammar(null as unknown as string);
			} catch (e) {
				threw = true;
				expect((e as Error).message).toMatch(
					/must be a string of at most 100 characters/,
				);
			}
			expect(threw).toBe(true);
		});

		it('loadGrammar should throw for undefined', async () => {
			let threw = false;
			try {
				await loadGrammar(undefined as unknown as string);
			} catch (e) {
				threw = true;
				expect((e as Error).message).toMatch(
					/must be a string of at most 100 characters/,
				);
			}
			expect(threw).toBe(true);
		});

		it('loadGrammar should throw for number', async () => {
			let threw = false;
			try {
				await loadGrammar(123 as unknown as string);
			} catch (e) {
				threw = true;
				expect((e as Error).message).toMatch(
					/must be a string of at most 100 characters/,
				);
			}
			expect(threw).toBe(true);
		});

		it('loadGrammar should throw for object', async () => {
			let threw = false;
			try {
				await loadGrammar({ foo: 'bar' } as unknown as string);
			} catch (e) {
				threw = true;
				expect((e as Error).message).toMatch(
					/must be a string of at most 100 characters/,
				);
			}
			expect(threw).toBe(true);
		});
	});

	describe('5. Empty after sanitization', () => {
		it('isGrammarAvailable should return false for empty string', async () => {
			const result = await isGrammarAvailable('');
			expect(result).toBe(false);
		});

		it('isGrammarAvailable should return false for whitespace-only string', async () => {
			// Only control characters (tabs, newlines, etc.) are stripped
			// Regular spaces (ASCII 32) are NOT stripped, so '   ' is valid (just not a language)
			const result = await isGrammarAvailable('\t\n\r');
			expect(result).toBe(false); // After sanitization, becomes empty
		});

		it('loadGrammar should throw for empty string', async () => {
			let threw = false;
			try {
				await loadGrammar('');
			} catch (e) {
				threw = true;
				expect((e as Error).message).toMatch(
					/Invalid language ID|empty after sanitization/,
				);
			}
			expect(threw).toBe(true);
		});

		it('loadGrammar should throw for control-char-only string', async () => {
			let threw = false;
			try {
				await loadGrammar('\t\n\r');
			} catch (e) {
				threw = true;
				expect((e as Error).message).toMatch(/Invalid language ID/);
			}
			expect(threw).toBe(true);
		});
	});

	describe('6. Length validation > 100 for isGrammarAvailable', () => {
		it('isGrammarAvailable should return false for languageId > 100 chars', async () => {
			const longId = 'a'.repeat(101);
			const result = await isGrammarAvailable(longId);
			expect(result).toBe(false);
		});

		it('isGrammarAvailable should return false for exactly 101 chars', async () => {
			const longId = 'javascript' + 'x'.repeat(93); // 101 total
			const result = await isGrammarAvailable(longId);
			expect(result).toBe(false);
		});
	});

	describe('7. Cache uses sanitized key', () => {
		it('should reject language IDs with tab/newline via whitelist', async () => {
			// First, load javascript normally
			const parser1 = await loadGrammar('javascript');
			expect(parser1).toBeDefined();
			expect(parserCache.size).toBe(1);
			expect(parserCache.has('javascript')).toBe(true);

			// Tab/newline in language ID is now rejected by whitelist
			let threw = false;
			try {
				await loadGrammar('java\tscript');
			} catch {
				threw = true;
			}
			expect(threw).toBe(true);
			expect(parserCache.size).toBe(1); // No new cache entry
		});

		it('should reject language IDs with path chars via whitelist', async () => {
			// Load a valid language
			const parser1 = await loadGrammar('kotlin');
			expect(parser1).toBeDefined();
			expect(parserCache.size).toBe(1);
			expect(parserCache.has('kotlin')).toBe(true);

			// Path chars in language ID rejected by whitelist
			let threw = false;
			try {
				await loadGrammar('kot/lin');
			} catch {
				threw = true;
			}
			expect(threw).toBe(true);
			expect(parserCache.size).toBe(1); // No new cache entry
		});
	});

	describe('8. Normal languages still work', () => {
		it('getSupportedLanguages should include javascript', () => {
			const supported = getSupportedLanguages();
			expect(supported).toContain('javascript');
		});

		it('getSupportedLanguages should include python', () => {
			const supported = getSupportedLanguages();
			expect(supported).toContain('python');
		});

		it('getSupportedLanguages should include typescript', () => {
			const supported = getSupportedLanguages();
			expect(supported).toContain('typescript');
		});

		it('getSupportedLanguages should include go', () => {
			const supported = getSupportedLanguages();
			expect(supported).toContain('go');
		});

		it('getSupportedLanguages should include rust', () => {
			const supported = getSupportedLanguages();
			expect(supported).toContain('rust');
		});

		it('getSupportedLanguages should include java', () => {
			const supported = getSupportedLanguages();
			expect(supported).toContain('java');
		});

		it('isGrammarAvailable should return true for javascript', async () => {
			const result = await isGrammarAvailable('javascript');
			expect(result).toBe(true);
		});

		it('isGrammarAvailable should return true for python', async () => {
			const result = await isGrammarAvailable('python');
			expect(result).toBe(true);
		});

		it('isGrammarAvailable should return true for typescript', async () => {
			const result = await isGrammarAvailable('typescript');
			expect(result).toBe(true);
		});

		it('loadGrammar should work for javascript', async () => {
			const parser = await loadGrammar('javascript');
			expect(parser).toBeDefined();
			expect(typeof parser).toBe('object');
		});

		it('loadGrammar should work for python', async () => {
			const parser = await loadGrammar('python');
			expect(parser).toBeDefined();
			expect(typeof parser).toBe('object');
		});

		it('loadGrammar should work for typescript', async () => {
			const parser = await loadGrammar('typescript');
			expect(parser).toBeDefined();
			expect(typeof parser).toBe('object');
		});

		it('loadGrammar should cache parsers correctly', async () => {
			clearParserCache();
			const parser1 = await loadGrammar('javascript');
			const parser2 = await loadGrammar('javascript');
			expect(parser1).toBe(parser2);
			expect(parserCache.size).toBe(1);
		});
	});

	describe('9. Case insensitivity after sanitization', () => {
		it('should treat "JavaScript" and "javascript" as same (case insensitive)', async () => {
			clearParserCache();
			const parser1 = await loadGrammar('JavaScript');
			const parser2 = await loadGrammar('javascript');
			expect(parser1).toBe(parser2);
			expect(parserCache.size).toBe(1);
		});

		it('should treat "PYTHON" and "python" as same (case insensitive)', async () => {
			clearParserCache();
			const parser1 = await loadGrammar('PYTHON');
			const parser2 = await loadGrammar('python');
			expect(parser1).toBe(parser2);
			expect(parserCache.size).toBe(1);
		});
	});

	describe('10. Clear cache functionality', () => {
		it('should clear parser cache', async () => {
			await loadGrammar('javascript');
			await loadGrammar('python');
			expect(parserCache.size).toBeGreaterThan(0);

			clearParserCache();
			expect(parserCache.size).toBe(0);
		});

		it('should allow reloading after cache clear', async () => {
			const parser1 = await loadGrammar('javascript');
			clearParserCache();
			const parser2 = await loadGrammar('javascript');

			expect(parser1).not.toBe(parser2); // Different instances
			expect(parserCache.size).toBe(1);
		});
	});

	describe('11. Concurrent initialization safety', () => {
		it('should handle concurrent loadGrammar calls without multiple Parser.init races', async () => {
			clearParserCache();
			// All three race on initTreeSitter() before any completes.
			// The promise-memoization fix ensures Parser.init() fires exactly once.
			const [p1, p2, p3] = await Promise.all([
				loadGrammar('javascript'),
				loadGrammar('python'),
				loadGrammar('typescript'),
			]);
			expect(p1).toBeDefined();
			expect(p2).toBeDefined();
			expect(p3).toBeDefined();
			expect(parserCache.size).toBeGreaterThanOrEqual(3);
		});

		it('should resolve all concurrent same-language loads without error', async () => {
			clearParserCache();
			// Concurrent calls for the same language all resolve successfully.
			// Each caller creates its own parser instance (a pre-existing per-language
			// race not addressed by this fix), but none crash or produce ENOENT.
			const [p1, p2, p3] = await Promise.all([
				loadGrammar('javascript'),
				loadGrammar('javascript'),
				loadGrammar('javascript'),
			]);
			expect(p1).toBeDefined();
			expect(p2).toBeDefined();
			expect(p3).toBeDefined();
			// Cache settles to one entry after all callers complete
			expect(parserCache.size).toBe(1);
		});
	});
});
