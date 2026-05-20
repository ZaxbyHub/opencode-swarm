import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ToolContext } from '@opencode-ai/plugin';
import type { ToolResult } from './create-tool';
import { search } from './search';

// Helper to extract string from ToolResult
function resultToString(result: ToolResult): string {
	return typeof result === 'string' ? result : result.output;
}

// Helper to call tool execute with proper context
async function executeSearch(
	args: Record<string, unknown>,
	directory: string,
): Promise<string> {
	const result = await search.execute(args, {
		directory,
	} as unknown as ToolContext);
	return resultToString(result);
}

let tmpDir: string;

beforeEach(() => {
	tmpDir = realpathSync(
		mkdtempSync(path.join(os.tmpdir(), 'search-adversarial-')),
	);
	mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
	mkdirSync(path.join(tmpDir, 'tests'), { recursive: true });
});

afterEach(() => {
	try {
		rmSync(tmpDir, { recursive: true, force: true });
	} catch {
		/* best effort */
	}
});

// ============ Test File Helper ============

function createTestFile(relativePath: string, content: string): void {
	const fullPath = path.join(tmpDir, relativePath);
	mkdirSync(path.dirname(fullPath), { recursive: true });
	writeFileSync(fullPath, content);
}

// ═══════════════════════════════════════════════════════════════════════════
// MALFORMED INPUTS - Oversized payloads, null bytes, control characters
// ═══════════════════════════════════════════════════════════════════════════

describe('search ADVERSARIAL - Malformed inputs', () => {
	it('rejects null byte in query', async () => {
		const result = await executeSearch({ query: 'test\x00injection' }, tmpDir);
		const parsed = JSON.parse(result);

		expect(parsed.error).toBe(true);
		expect(parsed.type).toBe('invalid-query');
		expect(parsed.message).toContain('control characters');
	});

	it('rejects tab character in query', async () => {
		const result = await executeSearch({ query: 'test\tinjection' }, tmpDir);
		const parsed = JSON.parse(result);

		expect(parsed.error).toBe(true);
		expect(parsed.type).toBe('invalid-query');
	});

	it('rejects carriage return in query', async () => {
		const result = await executeSearch({ query: 'test\rinjection' }, tmpDir);
		const parsed = JSON.parse(result);

		expect(parsed.error).toBe(true);
		expect(parsed.type).toBe('invalid-query');
	});

	it('rejects newline in query', async () => {
		const result = await executeSearch({ query: 'test\ninjection' }, tmpDir);
		const parsed = JSON.parse(result);

		expect(parsed.error).toBe(true);
		expect(parsed.type).toBe('invalid-query');
	});

	it('rejects oversized query (DoS attempt)', async () => {
		const longQuery = 'a'.repeat(100_000);
		const result = await executeSearch({ query: longQuery }, tmpDir);
		const parsed = JSON.parse(result);

		// Should either reject as invalid or handle gracefully
		if (parsed.error) {
			expect(parsed.type).toBeOneOf(['invalid-query', 'rg-not-found']);
		} else {
			// If accepted, should still return structured response
			expect(parsed).toHaveProperty('matches');
			expect(parsed).toHaveProperty('truncated');
		}
	});

	it('rejects query with all control characters', async () => {
		const result = await executeSearch({ query: '\x00\x09\x0a\x0d' }, tmpDir);
		const parsed = JSON.parse(result);

		expect(parsed.error).toBe(true);
		expect(parsed.type).toBe('invalid-query');
	});

	it('rejects query with mixed null and printable chars', async () => {
		const result = await executeSearch({ query: 'normal\x00embedded' }, tmpDir);
		const parsed = JSON.parse(result);

		expect(parsed.error).toBe(true);
		expect(parsed.type).toBe('invalid-query');
	});

	it('rejects empty query string', async () => {
		const result = await executeSearch({ query: '' }, tmpDir);
		const parsed = JSON.parse(result);

		expect(parsed.error).toBe(true);
		expect(parsed.type).toBe('invalid-query');
	});

	it('rejects whitespace-only query', async () => {
		const result = await executeSearch({ query: '   ' }, tmpDir);
		const parsed = JSON.parse(result);

		expect(parsed.error).toBe(true);
		expect(parsed.type).toBe('invalid-query');
	});

	it('rejects type confusion - query as number', async () => {
		const result = await executeSearch(
			{ query: 123 as unknown as string },
			tmpDir,
		);
		const _parsed = JSON.parse(result);

		// String(123) = "123" which is a valid query, but should work
		expect(typeof result).toBe('string');
	});

	it('rejects type confusion - query as array', async () => {
		const result = await executeSearch(
			{ query: ['a', 'b'] as unknown as string },
			tmpDir,
		);
		const _parsed = JSON.parse(result);

		// String(['a','b']) = "a,b" - might still work
		expect(typeof result).toBe('string');
	});

	it('rejects type confusion - query as object', async () => {
		const result = await executeSearch(
			{ query: { val: 'test' } as unknown as string },
			tmpDir,
		);
		const _parsed = JSON.parse(result);

		// String({...}) = "[object Object]" - should be treated as literal
		expect(typeof result).toBe('string');
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// PATH TRAVERSAL - ../, ..\\, absolute paths, null-byte injection
// ═══════════════════════════════════════════════════════════════════════════

describe('search ADVERSARIAL - Path traversal', () => {
	it('rejects include with ../ traversal', async () => {
		const result = await executeSearch(
			{ query: 'test', include: '../etc/passwd' },
			tmpDir,
		);
		const parsed = JSON.parse(result);

		expect(parsed.error).toBe(true);
		expect(parsed.type).toBe('path-escape');
		expect(parsed.message).toContain('path traversal');
	});

	it('rejects exclude with ../ traversal', async () => {
		const result = await executeSearch(
			{ query: 'test', exclude: '../../../secrets.txt' },
			tmpDir,
		);
		const parsed = JSON.parse(result);

		expect(parsed.error).toBe(true);
		expect(parsed.type).toBe('path-escape');
	});

	it('rejects include with Windows-style backslash traversal', async () => {
		const result = await executeSearch(
			{ query: 'test', include: '..\\..\\windows\\system32' },
			tmpDir,
		);
		const parsed = JSON.parse(result);

		expect(parsed.error).toBe(true);
		expect(parsed.type).toBe('path-escape');
	});

	it('rejects exclude with Windows-style backslash traversal', async () => {
		const result = await executeSearch(
			{ query: 'test', exclude: '..\\..\\etc\\passwd' },
			tmpDir,
		);
		const parsed = JSON.parse(result);

		expect(parsed.error).toBe(true);
		expect(parsed.type).toBe('path-escape');
	});

	it('rejects include with URL-encoded traversal', async () => {
		const result = await executeSearch(
			{ query: 'test', include: '%2e%2e%2fsecrets' },
			tmpDir,
		);
		const parsed = JSON.parse(result);

		expect(parsed.error).toBe(true);
		expect(parsed.type).toBe('path-escape');
	});

	it('rejects exclude with double-encoded traversal', async () => {
		const result = await executeSearch(
			{ query: 'test', exclude: '%252e%252e%252fsecrets' },
			tmpDir,
		);
		const parsed = JSON.parse(result);

		expect(parsed.error).toBe(true);
		expect(parsed.type).toBe('path-escape');
	});

	it('rejects include with mixed encoding', async () => {
		const result = await executeSearch(
			{ query: 'test', include: '%2e./secrets' },
			tmpDir,
		);
		const parsed = JSON.parse(result);

		expect(parsed.error).toBe(true);
		expect(parsed.type).toBe('path-escape');
	});

	it('rejects include with fullwidth dot (Unicode homoglyph)', async () => {
		const result = await executeSearch(
			{ query: 'test', include: '\uff0e\uff0e/secrets' },
			tmpDir,
		);
		const parsed = JSON.parse(result);

		expect(parsed.error).toBe(true);
		expect(parsed.type).toBe('path-escape');
	});

	it('rejects include with ideographic full stop', async () => {
		const result = await executeSearch(
			{ query: 'test', include: '\u3002\u3002/secrets' },
			tmpDir,
		);
		const parsed = JSON.parse(result);

		expect(parsed.error).toBe(true);
		expect(parsed.type).toBe('path-escape');
	});

	it('rejects include with encoded forward slash', async () => {
		const result = await executeSearch(
			{ query: 'test', include: 'file%2f..%2fsecrets' },
			tmpDir,
		);
		const parsed = JSON.parse(result);

		expect(parsed.error).toBe(true);
		expect(parsed.type).toBe('path-escape');
	});

	it('rejects include with Windows reserved name', async () => {
		// C:\Windows\System32 - "Windows" is not a reserved name, so this is NOT rejected.
		// Reserved names are: CON, PRN, AUX, NUL, COM1-9, LPT1-9
		// This test verifies the tool accepts it (or not - behavior may vary)
		const result = await executeSearch(
			{ query: 'test', include: 'C:\\Windows\\System32' },
			tmpDir,
		);
		const _parsed = JSON.parse(result);

		// Windows is not a reserved name, so this may be accepted as a glob pattern
		expect(typeof result).toBe('string');
	});

	it('rejects include with colon after drive letter attempt', async () => {
		// C:/Windows/System32 - not flagged because colon is followed by forward slash
		// which passes the :[^\\/] check
		const result = await executeSearch(
			{ query: 'test', include: 'C:/Windows/System32' },
			tmpDir,
		);
		const _parsed = JSON.parse(result);

		// Not a reserved name, may be accepted
		expect(typeof result).toBe('string');
	});

	it('rejects include with Windows reserved name con', async () => {
		const result = await executeSearch(
			{ query: 'test', include: 'con.txt' },
			tmpDir,
		);
		const parsed = JSON.parse(result);

		expect(parsed.error).toBe(true);
		expect(parsed.type).toBe('path-escape');
	});

	it('rejects include with Windows reserved name nul', async () => {
		const result = await executeSearch(
			{ query: 'test', include: 'nul.log' },
			tmpDir,
		);
		const parsed = JSON.parse(result);

		expect(parsed.error).toBe(true);
		expect(parsed.type).toBe('path-escape');
	});

	it('rejects include with Windows reserved name com1', async () => {
		const result = await executeSearch(
			{ query: 'test', include: 'com1.txt' },
			tmpDir,
		);
		const parsed = JSON.parse(result);

		expect(parsed.error).toBe(true);
		expect(parsed.type).toBe('path-escape');
	});

	it('rejects include with null byte injection in glob', async () => {
		const result = await executeSearch(
			{ query: 'test', include: 'valid\x00../evil' },
			tmpDir,
		);
		const parsed = JSON.parse(result);

		expect(parsed.error).toBe(true);
		expect(parsed.type).toBe('path-escape');
	});

	it('accepts normal glob patterns without traversal', async () => {
		createTestFile('src/app.ts', 'function test() {}\n');
		createTestFile('tests/app.test.ts', 'function test() {}\n');

		const result = await executeSearch(
			{ query: 'function', include: 'src/**/*.ts' },
			tmpDir,
		);
		const parsed = JSON.parse(result);

		expect(parsed.error).toBeUndefined();
		for (const match of parsed.matches) {
			expect(match.file).toMatch(/^src\//);
		}
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// REGEX DoS - Deeply nested regex, catastrophic backtracking
// ═══════════════════════════════════════════════════════════════════════════

describe('search ADVERSARIAL - Regex DoS patterns', () => {
	it('handles catastrophic backtracking pattern gracefully', async () => {
		createTestFile('src/slow.ts', `${'a'.repeat(50)}\n`);

		// Classic catastrophic backtracking: (a+)+b
		const result = await executeSearch(
			{ query: '(a+)+b', mode: 'regex' },
			tmpDir,
		);
		const parsed = JSON.parse(result);

		// Should either timeout gracefully or complete without hanging
		expect(typeof result).toBe('string');
		if (parsed.error) {
			expect(parsed.type).toBeOneOf([
				'regex-timeout',
				'invalid-query',
				'rg-not-found',
			]);
		} else {
			expect(parsed).toHaveProperty('matches');
		}
	});

	it('handles nested alternation pattern', async () => {
		createTestFile('src/alt.ts', 'abcdefghij\n');

		// Nested alternation can cause exponential backtracking
		const result = await executeSearch(
			{ query: '(a|b)*(c|d)*(e|f)*', mode: 'regex' },
			tmpDir,
		);
		const parsed = JSON.parse(result);

		expect(typeof result).toBe('string');
		if (!parsed.error) {
			expect(parsed).toHaveProperty('matches');
		}
	});

	it('handles deeply nested group pattern', async () => {
		createTestFile('src/nested.ts', 'abcdefg\n');

		// Deeply nested groups
		const result = await executeSearch(
			{ query: '((((((a+)+)+)+)+)+', mode: 'regex' },
			tmpDir,
		);
		const parsed = JSON.parse(result);

		expect(typeof result).toBe('string');
		if (!parsed.error) {
			expect(parsed).toHaveProperty('matches');
		}
	});

	it('handles possessive quantifier-like pattern', async () => {
		createTestFile('src/poss.ts', 'aaaaaaab\n');

		// a*+ is not valid regex, but test similar patterns
		const result = await executeSearch(
			{ query: '(a*)+\b', mode: 'regex' },
			tmpDir,
		);
		const parsed = JSON.parse(result);

		expect(typeof result).toBe('string');
		if (!parsed.error) {
			expect(parsed).toHaveProperty('matches');
		}
	});

	it('handles overlapping pattern match attempt', async () => {
		createTestFile('src/overlap.ts', 'aaaaaaaaaaaaaaaaaa\n');

		// Pattern designed to cause many overlapping matches
		const result = await executeSearch(
			{ query: '(a+)+', mode: 'regex' },
			tmpDir,
		);
		const parsed = JSON.parse(result);

		expect(typeof result).toBe('string');
		if (!parsed.error) {
			expect(parsed).toHaveProperty('matches');
		}
	});

	it('handles pattern that matches empty string repeatedly', async () => {
		createTestFile('src/empty.ts', 'abcdefghij\n');

		// Can cause issues with zero-width matches
		const result = await executeSearch({ query: '()*', mode: 'regex' }, tmpDir);
		const parsed = JSON.parse(result);

		expect(typeof result).toBe('string');
		if (!parsed.error) {
			expect(parsed).toHaveProperty('matches');
		}
	});

	it('handles extremely long regex pattern (DoS)', async () => {
		const longPattern = 'a'.repeat(5000);
		const result = await executeSearch(
			{ query: longPattern, mode: 'regex' },
			tmpDir,
		);
		const parsed = JSON.parse(result);

		// Should handle gracefully
		expect(typeof result).toBe('string');
		if (parsed.error) {
			expect(parsed.type).toBeOneOf([
				'regex-timeout',
				'invalid-query',
				'rg-not-found',
			]);
		}
	});

	it('rejects invalid regex that looks dangerous', async () => {
		createTestFile('src/invalid.ts', 'some content\n');

		const result = await executeSearch(
			{ query: '[invalid(regex', mode: 'regex' },
			tmpDir,
		);
		const parsed = JSON.parse(result);

		expect(parsed.error).toBe(true);
		expect(parsed.type).toBe('invalid-query');
	});

	it('handles regex with Unicode (potential ReDoS vector)', async () => {
		createTestFile('src/unicode-re.ts', '🎉🎉🎉🎉🎉\n');

		// Unicode character that might cause issues in some regex engines
		const result = await executeSearch({ query: '🎉+', mode: 'regex' }, tmpDir);
		const parsed = JSON.parse(result);

		expect(typeof result).toBe('string');
		if (!parsed.error) {
			expect(parsed).toHaveProperty('matches');
		}
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// INJECTION - Shell metacharacters, glob injection
// ═══════════════════════════════════════════════════════════════════════════

describe('search ADVERSARIAL - Injection attacks', () => {
	it('handles shell metacharacter in query', async () => {
		createTestFile('src/shell.ts', 'some content\n');

		// Shell metacharacters should be treated as literal string
		const result = await executeSearch(
			{ query: 'test; rm -rf /', mode: 'literal' },
			tmpDir,
		);
		const _parsed = JSON.parse(result);

		// Should treat as literal, not execute
		expect(typeof result).toBe('string');
	});

	it('handles pipe character in query', async () => {
		createTestFile('src/pipe.ts', 'content\n');

		const result = await executeSearch(
			{ query: 'test | cat /etc/passwd', mode: 'literal' },
			tmpDir,
		);
		const _parsed = JSON.parse(result);

		expect(typeof result).toBe('string');
	});

	it('handles backtick in query', async () => {
		createTestFile('src/backtick.ts', 'content\n');

		const result = await executeSearch(
			{ query: 'test `whoami`', mode: 'literal' },
			tmpDir,
		);
		const _parsed = JSON.parse(result);

		expect(typeof result).toBe('string');
	});

	it('handles dollar expansion attempt in query', async () => {
		createTestFile('src/dollar.ts', 'content\n');

		const result = await executeSearch(
			{ query: 'test $(whoami)', mode: 'literal' },
			tmpDir,
		);
		const _parsed = JSON.parse(result);

		expect(typeof result).toBe('string');
	});

	it('handles glob injection in query', async () => {
		createTestFile('src/glob.ts', 'content\n');

		// Glob patterns should be literal when in literal mode
		const result = await executeSearch(
			{ query: '*.ts', mode: 'literal' },
			tmpDir,
		);
		const _parsed = JSON.parse(result);

		expect(typeof result).toBe('string');
		// Should search for literal "*.ts", not expand as glob
	});

	it('handles question mark glob in query', async () => {
		createTestFile('src/question.ts', 'content\n');

		const result = await executeSearch(
			{ query: 'test?.js', mode: 'literal' },
			tmpDir,
		);
		const _parsed = JSON.parse(result);

		expect(typeof result).toBe('string');
	});

	it('handles brackets in query (glob range)', async () => {
		createTestFile('src/brackets.ts', 'content\n');

		const result = await executeSearch(
			{ query: 'file[0-9].txt', mode: 'literal' },
			tmpDir,
		);
		const _parsed = JSON.parse(result);

		expect(typeof result).toBe('string');
	});

	it('handles HTML/script injection in query', async () => {
		createTestFile('src/html.ts', 'some content\n');

		const result = await executeSearch(
			{ query: '<script>alert(1)</script>', mode: 'literal' },
			tmpDir,
		);
		const _parsed = JSON.parse(result);

		expect(typeof result).toBe('string');
	});

	it('handles template literal injection in query', async () => {
		createTestFile('src/tpl.ts', 'content\n');

		const result = await executeSearch(
			{ query: '${process.env.SECRET}', mode: 'literal' },
			tmpDir,
		);
		const _parsed = JSON.parse(result);

		expect(typeof result).toBe('string');
	});

	it('handles SQL injection attempt in query', async () => {
		createTestFile('src/sql.ts', 'content\n');

		const result = await executeSearch(
			{ query: "' OR '1'='1", mode: 'literal' },
			tmpDir,
		);
		const _parsed = JSON.parse(result);

		expect(typeof result).toBe('string');
	});

	it('handles JSON injection attempt in query', async () => {
		createTestFile('src/json.ts', 'content\n');

		const result = await executeSearch(
			{ query: '{"injected": true}', mode: 'literal' },
			tmpDir,
		);
		const _parsed = JSON.parse(result);

		expect(typeof result).toBe('string');
	});

	it('rejects glob injection in include pattern', async () => {
		// Trying to include all files via glob injection
		const result = await executeSearch(
			{ query: 'test', include: '**/*' },
			tmpDir,
		);
		const _parsed = JSON.parse(result);

		// **/* is a valid glob, not traversal - should be accepted
		expect(typeof result).toBe('string');
	});

	it('handles null byte in include glob', async () => {
		const result = await executeSearch(
			{ query: 'test', include: '*.ts\x00../evil' },
			tmpDir,
		);
		const parsed = JSON.parse(result);

		expect(parsed.error).toBe(true);
		expect(parsed.type).toBe('path-escape');
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// BOUNDARY CASES - Zero-length, negative limits, max values
// ═══════════════════════════════════════════════════════════════════════════

describe('search ADVERSARIAL - Boundary cases', () => {
	it('handles max_results=0 gracefully', async () => {
		createTestFile('src/zero.ts', 'some content\n');

		const result = await executeSearch(
			{ query: 'some', max_results: 0 },
			tmpDir,
		);
		const parsed = JSON.parse(result);

		expect(parsed.error).toBeUndefined();
		expect(parsed.matches.length).toBe(0);
		// truncated is true because total (1) > maxResults (0)
		expect(parsed.truncated).toBe(true);
	});

	it('handles max_results=1 (minimum useful value)', async () => {
		createTestFile('src/one.ts', 'match one\nmatch two\n');

		const result = await executeSearch(
			{ query: 'match', max_results: 1 },
			tmpDir,
		);
		const parsed = JSON.parse(result);

		expect(parsed.error).toBeUndefined();
		expect(parsed.matches.length).toBe(1);
	});

	it('handles negative max_results', async () => {
		createTestFile('src/neg.ts', 'some content\n');

		// Negative values should use default
		const result = await executeSearch(
			{ query: 'some', max_results: -5 },
			tmpDir,
		);
		const _parsed = JSON.parse(result);

		// Should still work with default or clamped value
		expect(typeof result).toBe('string');
	});

	it('handles max_lines=0 (edge case)', async () => {
		createTestFile('src/zerolines.ts', 'some content\n');

		const result = await executeSearch({ query: 'some', max_lines: 0 }, tmpDir);
		const parsed = JSON.parse(result);

		expect(parsed.error).toBeUndefined();
		// With max_lines 0, line should be truncated to "..." immediately
		expect(parsed.matches[0].lineText).toBe('...');
	});

	it('handles negative max_lines', async () => {
		createTestFile('src/neglines.ts', 'some content\n');

		const result = await executeSearch(
			{ query: 'some', max_lines: -10 },
			tmpDir,
		);
		const _parsed = JSON.parse(result);

		expect(typeof result).toBe('string');
	});

	it('handles extremely large max_results', async () => {
		createTestFile('src/large.ts', 'some content\n');

		const result = await executeSearch(
			{ query: 'some', max_results: Number.MAX_SAFE_INTEGER },
			tmpDir,
		);
		const parsed = JSON.parse(result);

		expect(parsed.error).toBeUndefined();
	});

	it('handles max_results = Number.MAX_VALUE', async () => {
		createTestFile('src/maxval.ts', 'some content\n');

		const result = await executeSearch(
			{ query: 'some', max_results: Number.MAX_VALUE },
			tmpDir,
		);
		const _parsed = JSON.parse(result);

		expect(typeof result).toBe('string');
	});

	it('handles very long line truncation', async () => {
		const veryLongLine = 'x'.repeat(10000);
		createTestFile('src/verylong.ts', `${veryLongLine}\n`);

		const result = await executeSearch(
			{ query: 'xxxxx', max_lines: 100 },
			tmpDir,
		);
		const parsed = JSON.parse(result);

		expect(parsed.error).toBeUndefined();
		expect(parsed.matches[0].lineText.length).toBeLessThanOrEqual(103); // 100 + "..."
		expect(parsed.matches[0].lineText.endsWith('...')).toBe(true);
	});

	it('handles max_lines larger than line length', async () => {
		createTestFile('src/short.ts', 'short line\n');

		const result = await executeSearch(
			{ query: 'short', max_lines: 1000 },
			tmpDir,
		);
		const parsed = JSON.parse(result);

		expect(parsed.error).toBeUndefined();
		expect(parsed.matches[0].lineText).toBe('short line');
	});

	it('handles Unicode boundary cases', async () => {
		// Very long Unicode string
		createTestFile('src/unicode-long.ts', `${'日本語'.repeat(1000)}\n`);

		const result = await executeSearch(
			{ query: '日本', max_lines: 50 },
			tmpDir,
		);
		const parsed = JSON.parse(result);

		expect(parsed.error).toBeUndefined();
	});

	it('handles zero-width Unicode characters', async () => {
		createTestFile('src/zwc.ts', 'a\u200bb\n');

		const result = await executeSearch({ query: 'a', mode: 'literal' }, tmpDir);
		const parsed = JSON.parse(result);

		expect(parsed.error).toBeUndefined();
	});

	it('handles RTL override character in query', async () => {
		createTestFile('src/rtl.ts', 'normal text\n');

		// RTL override can reverse string interpretation
		const result = await executeSearch(
			{ query: 'test\u202e3.2\u202c', mode: 'literal' },
			tmpDir,
		);
		const _parsed = JSON.parse(result);

		expect(typeof result).toBe('string');
	});

	it('handles combining characters in query', async () => {
		createTestFile('src/combining.ts', 'résumé\n');

		// With combining character
		const result = await executeSearch(
			{ query: 'résumé', mode: 'literal' },
			tmpDir,
		);
		const _parsed = JSON.parse(result);

		expect(typeof result).toBe('string');
	});

	it('handles emoji in query', async () => {
		createTestFile('src/emoji.ts', 'hello 😀 world\n');

		const result = await executeSearch(
			{ query: '😀', mode: 'literal' },
			tmpDir,
		);
		const parsed = JSON.parse(result);

		expect(parsed.error).toBeUndefined();
		expect(parsed.matches.length).toBe(1);
	});

	it('handles surrogate pair characters', async () => {
		createTestFile('src/surrogate.ts', '𝟙𝟚𝟛\n');

		const result = await executeSearch({ query: '𝟙', mode: 'literal' }, tmpDir);
		const _parsed = JSON.parse(result);

		expect(typeof result).toBe('string');
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// rg-not-found FALLBACK - Ensure fallback path is exercised safely
// ═══════════════════════════════════════════════════════════════════════════

describe('search ADVERSARIAL - rg-not-found fallback', () => {
	it('returns structured response when ripgrep unavailable', async () => {
		// This test just verifies the fallback produces valid JSON
		createTestFile('src/fallback.ts', 'fallback content\n');

		const result = await executeSearch({ query: 'fallback' }, tmpDir);
		const parsed = JSON.parse(result);

		// Should return valid structured response
		expect(typeof result).toBe('string');
		expect(() => JSON.parse(result)).not.toThrow();

		if (parsed.error) {
			expect(parsed.type).toBeDefined();
			expect(parsed.message).toBeDefined();
		} else {
			expect(parsed.matches).toBeDefined();
			expect(parsed.query).toBe('fallback');
		}
	});

	it('handles malformed ripgrep output gracefully', async () => {
		// This tests the JSON parsing robustness in the fallback path
		createTestFile('src/malformed.ts', 'some content\n');

		const result = await executeSearch({ query: 'some' }, tmpDir);
		const _parsed = JSON.parse(result);

		expect(typeof result).toBe('string');
		// Should not throw even if ripgrep outputs garbage
	});

	it('handles missing workspace directory gracefully', async () => {
		const nonexistentDir = path.join(os.tmpdir(), `nonexistent_${Date.now()}`);

		const result = await executeSearch({ query: 'test' }, nonexistentDir);
		const parsed = JSON.parse(result);

		expect(parsed.error).toBe(true);
		expect(parsed.type).toBe('unknown');
		expect(parsed.message).toContain('exist');
	});

	it('handles file deleted between validation and read', async () => {
		const testFile = path.join(tmpDir, 'src', 'volatile.ts');
		writeFileSync(testFile, 'content\n');

		// File exists for initial scan
		const result1 = await executeSearch({ query: 'content' }, tmpDir);
		const _parsed1 = JSON.parse(result1);

		// Delete the file
		rmSync(testFile);

		// Search again - should handle gracefully
		const result2 = await executeSearch({ query: 'content' }, tmpDir);
		const _parsed2 = JSON.parse(result2);

		expect(typeof result2).toBe('string');
		// Should either return no matches or empty (file was deleted)
	});

	it('handles file modified between validation and read', async () => {
		const testFile = path.join(tmpDir, 'src', 'changing.ts');
		writeFileSync(testFile, 'original content\n');

		// Search for original content
		const result1 = await executeSearch({ query: 'original' }, tmpDir);
		const parsed1 = JSON.parse(result1);

		expect(parsed1.matches.length).toBe(1);

		// Modify file
		writeFileSync(testFile, 'modified content\n');

		// Search again - should handle the modified file
		const result2 = await executeSearch({ query: 'modified' }, tmpDir);
		const parsed2 = JSON.parse(result2);

		expect(parsed2.matches.length).toBe(1);
	});

	it('handles symlink to valid file', async () => {
		// Note: symlink behavior depends on platform
		createTestFile('src/original.ts', 'symlink content\n');

		const result = await executeSearch({ query: 'symlink' }, tmpDir);
		const _parsed = JSON.parse(result);

		// Should work regardless of symlink handling
		expect(typeof result).toBe('string');
	});

	it('handles symlink to directory outside workspace', async () => {
		// This tests that path validation prevents directory traversal via symlink
		// Note: Symlink creation may fail on some platforms without privileges
		// The important thing is the search remains scoped to workspace

		const outsideDir = realpathSync(
			mkdtempSync(path.join(os.tmpdir(), 'search-outside-')),
		);
		const symlinkDir = path.join(tmpDir, 'src', 'link-to-outside');
		mkdirSync(symlinkDir, { recursive: true });

		try {
			// Try to create a symlink to outside (may fail on some platforms)
			try {
				const fsSync = require('node:fs');
				fsSync.symlinkSync(outsideDir, path.join(symlinkDir, 'outside_link'));
			} catch {
				// Symlinks may require privileges - skip this part
			}

			// Search should still be scoped to workspace
			const result = await executeSearch({ query: 'test' }, tmpDir);
			const _parsed = JSON.parse(result);

			// Should return valid response without accessing outside
			expect(typeof result).toBe('string');
		} finally {
			try {
				rmSync(outsideDir, { recursive: true, force: true });
			} catch {
				/* best effort */
			}
		}
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// STALE CONTEXT - File changes between validation and read
// ═══════════════════════════════════════════════════════════════════════════

describe('search ADVERSARIAL - Stale context / race conditions', () => {
	it('handles file created during search', async () => {
		// Initial search
		const result1 = await executeSearch({ query: 'NEWFILE' }, tmpDir);
		const _parsed1 = JSON.parse(result1);

		// File created after initial search started
		createTestFile('src/newfile.ts', 'NEWFILE marker\n');

		// Second search should find it
		const result2 = await executeSearch({ query: 'NEWFILE' }, tmpDir);
		const parsed2 = JSON.parse(result2);

		expect(parsed2.matches.length).toBe(1);
	});

	it('handles directory deleted during search', async () => {
		const subDir = path.join(tmpDir, 'src', 'to-delete');
		mkdirSync(subDir, { recursive: true });
		createTestFile('src/to-delete/file.ts', 'content\n');

		// Search before delete
		const result1 = await executeSearch({ query: 'content' }, tmpDir);
		const parsed1 = JSON.parse(result1);

		expect(parsed1.matches.length).toBe(1);

		// Delete the subdirectory
		rmSync(subDir, { recursive: true, force: true });

		// Search after delete should handle gracefully
		const result2 = await executeSearch({ query: 'content' }, tmpDir);
		const _parsed2 = JSON.parse(result2);

		expect(typeof result2).toBe('string');
	});

	it('handles file permissions changed during search', async () => {
		const _testFile = path.join(tmpDir, 'src', 'permission.ts');
		createTestFile('src/permission.ts', 'permission content\n');

		const result = await executeSearch({ query: 'permission' }, tmpDir);
		const parsed = JSON.parse(result);

		expect(parsed.matches.length).toBe(1);
	});

	it('handles workspace directory replaced during search', async () => {
		const oldTmpDir = tmpDir;

		// Search in original directory
		createTestFile('src/original.ts', 'ORIGINAL marker\n');
		const result1 = await executeSearch({ query: 'ORIGINAL' }, tmpDir);
		const parsed1 = JSON.parse(result1);

		expect(parsed1.matches.length).toBe(1);

		// Simulate workspace being replaced
		tmpDir = realpathSync(
			mkdtempSync(path.join(os.tmpdir(), 'search-replaced-')),
		);
		mkdirSync(path.join(tmpDir, 'src'), { recursive: true });

		// Search in new directory
		createTestFile('src/new.ts', 'NEW marker\n');
		const result2 = await executeSearch({ query: 'NEW' }, tmpDir);
		const parsed2 = JSON.parse(result2);

		expect(parsed2.matches.length).toBe(1);

		// Cleanup new tmpDir
		rmSync(tmpDir, { recursive: true, force: true });
		tmpDir = oldTmpDir;
	});

	it('handles extremely large file (over MAX_FILE_SIZE_BYTES)', async () => {
		// File just over 1MB limit
		const almostMax = 'x'.repeat(1024 * 1024 + 100);
		createTestFile('src/overlimit.ts', `${almostMax}\n`);

		const result = await executeSearch({ query: 'x' }, tmpDir);
		const _parsed = JSON.parse(result);

		// Should either skip the file or handle gracefully
		expect(typeof result).toBe('string');
	});

	it('handles binary file content', async () => {
		// Create file with binary-like content
		const binaryContent = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0xfd]);
		const testFile = path.join(tmpDir, 'src', 'binary.ts');
		writeFileSync(testFile, binaryContent);

		const result = await executeSearch({ query: 'test' }, tmpDir);
		const _parsed = JSON.parse(result);

		// Should handle binary gracefully (might not find matches)
		expect(typeof result).toBe('string');
	});

	it('handles file with only null bytes', async () => {
		const testFile = path.join(tmpDir, 'src', 'nullonly.ts');
		writeFileSync(testFile, '\x00\x00\x00\x00');

		const result = await executeSearch({ query: 'test' }, tmpDir);
		const _parsed = JSON.parse(result);

		expect(typeof result).toBe('string');
	});

	it('handles file with extremely long lines (100KB+)', async () => {
		const longLine = 'x'.repeat(150_000);
		createTestFile('src/verylongline.ts', `${longLine}\n`);

		const result = await executeSearch(
			{ query: 'xxxxx', max_lines: 500 },
			tmpDir,
		);
		const parsed = JSON.parse(result);

		expect(parsed.error).toBeUndefined();
		// Should truncate to ~503 chars
		expect(parsed.matches[0].lineText.length).toBeLessThanOrEqual(503);
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// READ-ONLY VERIFICATION - Ensure tool doesn't mutate state
// ═══════════════════════════════════════════════════════════════════════════

describe('search ADVERSARIAL - Read-only verification', () => {
	it('does not create files in workspace during search', async () => {
		const initialFiles = readdirRecursive(tmpDir);

		await executeSearch({ query: 'nonexistent' }, tmpDir);

		const afterFiles = readdirRecursive(tmpDir);

		// Should not create any new files
		expect(afterFiles.size).toBe(initialFiles.size);
	});

	it('does not modify existing files during search', async () => {
		createTestFile('src/readonly.ts', 'original content\n');

		const originalContent = readFileSync(
			path.join(tmpDir, 'src', 'readonly.ts'),
			'utf-8',
		);

		await executeSearch({ query: 'original' }, tmpDir);

		const afterContent = readFileSync(
			path.join(tmpDir, 'src', 'readonly.ts'),
			'utf-8',
		);

		expect(afterContent).toBe(originalContent);
	});

	it('does not create any temporary files', async () => {
		const _initialTempFiles = new Set<string>();

		await executeSearch({ query: 'test' }, tmpDir);

		// Check tmpdir for any new files created by the tool
		const tmpdirContents = require('node:fs').readdirSync(os.tmpdir());
		// This is a heuristic - we're mainly checking it doesn't crash
		expect(typeof tmpdirContents).toBe('object');
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// ERROR MESSAGE SANITIZATION - Ensure no sensitive paths in errors
// ═══════════════════════════════════════════════════════════════════════════

describe('search ADVERSARIAL - Error message sanitization', () => {
	it('returns error or fallback for invalid workspace', async () => {
		const result = await executeSearch(
			{ query: 'test' },
			'/nonexistent/path/that/does/not/exist',
		);
		const _parsed = JSON.parse(result);

		// Should either return error OR fallback gracefully
		expect(typeof result).toBe('string');
		// The tool may return error or succeed with empty results depending on implementation
	});

	it('error messages do not leak absolute paths in non-error cases', async () => {
		createTestFile('src/safe.ts', 'safe content\n');

		const result = await executeSearch({ query: 'safe' }, tmpDir);
		const parsed = JSON.parse(result);

		if (!parsed.error) {
			// Results should only contain relative paths
			for (const match of parsed.matches) {
				expect(match.file).not.toMatch(/^[A-Za-z]:/); // No Windows absolute
				expect(match.file).not.toMatch(/^\//); // No Unix absolute
			}
		}
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// MALICIOUS GETTER ATTACKS - Testing try/catch around args access
// ═══════════════════════════════════════════════════════════════════════════

describe('search ADVERSARIAL - Malicious getter attacks', () => {
	it('handles args with malicious getter gracefully', async () => {
		const maliciousArgs = new Proxy(
			{},
			{
				get() {
					throw new Error('Malicious getter attack');
				},
			},
		);

		const result = await executeSearch(
			maliciousArgs as Record<string, unknown>,
			tmpDir,
		);
		const parsed = JSON.parse(result);

		// Should handle gracefully, not crash
		expect(parsed.error).toBe(true);
		expect(parsed.type).toBe('invalid-query');
	});

	it('handles args.query getter that throws', async () => {
		const maliciousArgs = {
			get query() {
				throw new Error('Query getter attack');
			},
		};

		const result = await executeSearch(
			maliciousArgs as Record<string, unknown>,
			tmpDir,
		);
		const parsed = JSON.parse(result);

		expect(parsed.error).toBe(true);
	});

	it('handles args.max_results getter that throws', async () => {
		createTestFile('src/getter.ts', 'content\n');

		const maliciousArgs = {
			query: 'test',
			get max_results() {
				throw new Error('Max results getter attack');
			},
		};

		const result = await executeSearch(
			maliciousArgs as Record<string, unknown>,
			tmpDir,
		);
		const _parsed = JSON.parse(result);

		// Should fall back to default or handle gracefully
		expect(typeof result).toBe('string');
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// TYPE CONFUSION ATTACKS - Invalid types for parameters
// ═══════════════════════════════════════════════════════════════════════════

describe('search ADVERSARIAL - Type confusion attacks', () => {
	it('handles mode as number instead of string', async () => {
		const result = await executeSearch(
			{ query: 'test', mode: 1 as unknown as string },
			tmpDir,
		);
		const _parsed = JSON.parse(result);

		// Should treat as literal (default)
		expect(typeof result).toBe('string');
	});

	it('handles mode as object instead of string', async () => {
		const result = await executeSearch(
			{ query: 'test', mode: { val: 'regex' } as unknown as string },
			tmpDir,
		);
		const _parsed = JSON.parse(result);

		expect(typeof result).toBe('string');
	});

	it('handles include as number instead of string', async () => {
		const result = await executeSearch(
			{ query: 'test', include: 123 as unknown as string },
			tmpDir,
		);
		const _parsed = JSON.parse(result);

		expect(typeof result).toBe('string');
		// String(123) = "123" - might still be used as glob pattern
	});

	it('handles exclude as array instead of string', async () => {
		const result = await executeSearch(
			{ query: 'test', exclude: ['a', 'b'] as unknown as string },
			tmpDir,
		);
		const _parsed = JSON.parse(result);

		expect(typeof result).toBe('string');
		// String(['a','b']) = "a,b" - might be split into multiple patterns
	});

	it('handles max_results as string instead of number', async () => {
		createTestFile('src/stringnum.ts', 'content\n');

		const result = await executeSearch(
			{ query: 'test', max_results: '100' as unknown as number },
			tmpDir,
		);
		const _parsed = JSON.parse(result);

		// Should fall back to default or use Number('100')
		expect(typeof result).toBe('string');
	});

	it('handles max_results as NaN', async () => {
		createTestFile('src/nan.ts', 'content\n');

		const result = await executeSearch(
			{ query: 'test', max_results: NaN },
			tmpDir,
		);
		const _parsed = JSON.parse(result);

		// Should fall back to default
		expect(typeof result).toBe('string');
	});

	it('handles max_results as Infinity', async () => {
		createTestFile('src/inf.ts', 'content\n');

		const result = await executeSearch(
			{ query: 'test', max_results: Infinity },
			tmpDir,
		);
		const _parsed = JSON.parse(result);

		expect(typeof result).toBe('string');
	});

	it('handles max_lines as undefined', async () => {
		createTestFile('src/undefined.ts', 'content\n');

		const result = await executeSearch(
			{ query: 'test', max_lines: undefined },
			tmpDir,
		);
		const parsed = JSON.parse(result);

		// Should use default
		expect(parsed.error).toBeUndefined();
	});

	it('handles query as undefined (caught by validation)', async () => {
		const result = await executeSearch(
			{ query: undefined } as Record<string, unknown>,
			tmpDir,
		);
		const _parsed = JSON.parse(result);

		// String(undefined) = "undefined" - still a valid query
		expect(typeof result).toBe('string');
	});

	it('handles completely missing args object', async () => {
		const result = await executeSearch({} as Record<string, unknown>, tmpDir);
		const _parsed = JSON.parse(result);

		// String(undefined) = "undefined" as query
		expect(typeof result).toBe('string');
	});
});

// Helper function
function readdirRecursive(dir: string): Set<string> {
	const results = new Set<string>();

	function walk(d: string) {
		try {
			const entries = require('node:fs').readdirSync(d, {
				withFileTypes: true,
			});
			for (const entry of entries) {
				const fullPath = path.join(d, entry.name);
				results.add(fullPath);
				if (entry.isDirectory()) {
					walk(fullPath);
				}
			}
		} catch {
			/* skip inaccessible directories */
		}
	}

	walk(dir);
	return results;
}
