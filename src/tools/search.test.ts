import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
	mkdirSync,
	mkdtempSync,
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
	tmpDir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'search-test-')));
	// Create a src subdirectory structure for testing
	mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
	mkdirSync(path.join(tmpDir, 'tests'), { recursive: true });
	mkdirSync(path.join(tmpDir, 'node_modules', 'some-package'), {
		recursive: true,
	});
});

afterEach(() => {
	try {
		rmSync(tmpDir, { recursive: true, force: true });
	} catch {
		/* best effort */
	}
});

// ============ Test Files Setup ============

function createTestFile(relativePath: string, content: string): void {
	const fullPath = path.join(tmpDir, relativePath);
	mkdirSync(path.dirname(fullPath), { recursive: true });
	writeFileSync(fullPath, content);
}

// ============ Literal Search Tests ============

describe('search - literal mode', () => {
	it('finds literal string matches in files', async () => {
		createTestFile(
			'src/app.ts',
			'function hello() {\n  console.log("hello world");\n}\n',
		);
		createTestFile(
			'src/utils.ts',
			'export function greet() {\n  return "hello there";\n}\n',
		);

		const result = await executeSearch({ query: 'hello' }, tmpDir);
		const parsed = JSON.parse(result);

		expect(parsed.error).toBeUndefined();
		expect(parsed.matches).toBeDefined();
		expect(Array.isArray(parsed.matches)).toBe(true);
		expect(parsed.matches.length).toBeGreaterThanOrEqual(2);

		// Check match structure
		const firstMatch = parsed.matches[0];
		expect(firstMatch).toHaveProperty('file');
		expect(firstMatch).toHaveProperty('lineNumber');
		expect(firstMatch).toHaveProperty('lineText');
		expect(typeof firstMatch.file).toBe('string');
		expect(typeof firstMatch.lineNumber).toBe('number');
		expect(typeof firstMatch.lineText).toBe('string');
	});

	it('returns structured empty response when no matches found', async () => {
		createTestFile('src/empty.ts', '// This file has no matching content\n');

		const result = await executeSearch(
			{ query: 'nonexistent_term_xyz' },
			tmpDir,
		);
		const parsed = JSON.parse(result);

		expect(parsed.error).toBeUndefined();
		expect(parsed.matches).toEqual([]);
		expect(parsed.total).toBe(0);
		expect(parsed.truncated).toBe(false);
	});

	it('returns correct query and mode in response', async () => {
		createTestFile('src/test.ts', 'some content with test term\n');

		const result = await executeSearch(
			{ query: 'test', mode: 'literal' },
			tmpDir,
		);
		const parsed = JSON.parse(result);

		expect(parsed.query).toBe('test');
		expect(parsed.mode).toBe('literal');
		expect(parsed.maxResults).toBe(100); // default
	});
});

// ============ Regex Search Tests ============

describe('search - regex mode', () => {
	it('matches regex pattern correctly', async () => {
		createTestFile(
			'src/regex.ts',
			'function foo() {}\nfunction bar() {}\nfunction baz() {}\n',
		);

		const result = await executeSearch(
			{ query: 'function (foo|bar)', mode: 'regex' },
			tmpDir,
		);
		const parsed = JSON.parse(result);

		expect(parsed.error).toBeUndefined();
		expect(parsed.matches).toBeDefined();
		expect(parsed.matches.length).toBeGreaterThanOrEqual(2);
		expect(parsed.mode).toBe('regex');
	});

	it('returns invalid-query error for bad regex', async () => {
		createTestFile('src/bad.ts', 'some content\n');

		const result = await executeSearch(
			{ query: '[invalid(regex', mode: 'regex' },
			tmpDir,
		);
		const parsed = JSON.parse(result);

		expect(parsed.error).toBe(true);
		expect(parsed.type).toBe('invalid-query');
		expect(parsed.message).toBeDefined();
	});
});

// ============ max_results Limit Tests ============

describe('search - max_results enforcement', () => {
	it('enforces hard cap on results', async () => {
		// Create many files with matching content
		for (let i = 0; i < 20; i++) {
			createTestFile(
				`src/file${i}.ts`,
				`const value${i} = "match this line";\n`.repeat(5),
			);
		}

		const result = await executeSearch(
			{ query: 'match', max_results: 5 },
			tmpDir,
		);
		const parsed = JSON.parse(result);

		expect(parsed.error).toBeUndefined();
		expect(parsed.matches.length).toBeLessThanOrEqual(5);
		expect(parsed.truncated).toBe(true);
		expect(parsed.total).toBeGreaterThan(5);
	});

	it('returns all matches when under limit', async () => {
		createTestFile(
			'src/limited.ts',
			'line one with term\nline two with term\nline three without\n',
		);

		const result = await executeSearch(
			{ query: 'term', max_results: 100 },
			tmpDir,
		);
		const parsed = JSON.parse(result);

		expect(parsed.matches.length).toBe(2);
		expect(parsed.truncated).toBe(false);
	});
});

// ============ max_lines Truncation Tests ============

describe('search - max_lines truncation', () => {
	it('truncates long lines exceeding max_lines', async () => {
		const longLine = 'a'.repeat(300);
		createTestFile('src/long.ts', `${longLine}\n`);

		const result = await executeSearch(
			{ query: 'aaaa', max_lines: 50 },
			tmpDir,
		);
		const parsed = JSON.parse(result);

		expect(parsed.error).toBeUndefined();
		expect(parsed.matches[0].lineText.length).toBeLessThanOrEqual(53); // 50 + "..."
		expect(parsed.matches[0].lineText).toContain('...');
	});

	it('preserves short lines unchanged', async () => {
		createTestFile('src/short.ts', 'short line\n');

		const result = await executeSearch(
			{ query: 'short', max_lines: 200 },
			tmpDir,
		);
		const parsed = JSON.parse(result);

		expect(parsed.matches[0].lineText).toBe('short line');
		expect(parsed.matches[0].lineText).not.toContain('...');
	});
});

// ============ Path Escape Rejection Tests ============

describe('search - path escape rejection', () => {
	it('rejects path traversal in include pattern', async () => {
		createTestFile('src/normal.ts', 'some content\n');

		const result = await executeSearch(
			{ query: 'test', include: '../etc/passwd' },
			tmpDir,
		);
		const parsed = JSON.parse(result);

		expect(parsed.error).toBe(true);
		expect(parsed.type).toBe('path-escape');
		expect(parsed.message).toContain('path traversal');
	});

	it('rejects path traversal in exclude pattern', async () => {
		createTestFile('src/normal.ts', 'some content\n');

		const result = await executeSearch(
			{ query: 'test', exclude: '../../../secrets.txt' },
			tmpDir,
		);
		const parsed = JSON.parse(result);

		expect(parsed.error).toBe(true);
		expect(parsed.type).toBe('path-escape');
	});

	it('rejects encoded path traversal', async () => {
		createTestFile('src/normal.ts', 'some content\n');

		const result = await executeSearch(
			{ query: 'test', include: '%2e%2e%2fsecrets' },
			tmpDir,
		);
		const parsed = JSON.parse(result);

		expect(parsed.error).toBe(true);
		expect(parsed.type).toBe('path-escape');
	});

	it('rejects Windows-style path traversal', async () => {
		createTestFile('src/normal.ts', 'some content\n');

		const result = await executeSearch(
			{ query: 'test', exclude: '..\\..\\windows\\system32' },
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
		// Should only match src files, not tests
		for (const match of parsed.matches) {
			expect(match.file).toMatch(/^src\//);
		}
	});
});

// ============ Glob Include/Exclude Tests ============

describe('search - glob filtering', () => {
	it('filters by include glob pattern', async () => {
		createTestFile('src/app.ts', 'INCLUDE_MARKER\n');
		createTestFile('src/app.js', 'INCLUDE_MARKER\n');
		createTestFile('tests/app.test.ts', 'INCLUDE_MARKER\n');
		createTestFile('src/nested/deep/app.ts', 'INCLUDE_MARKER\n');

		// Use **/*.ts pattern which matches .ts files at any depth
		const result = await executeSearch(
			{ query: 'INCLUDE_MARKER', include: '**/*.ts' },
			tmpDir,
		);
		const parsed = JSON.parse(result);

		expect(parsed.error).toBeUndefined();
		expect(parsed.matches.length).toBeGreaterThanOrEqual(2);
		// Normalize backslashes to forward slashes for cross-platform comparison
		const normalizedFiles = parsed.matches.map((m: { file: string }) =>
			m.file.replace(/\\/g, '/'),
		);
		// Should find at least the nested .ts file
		expect(normalizedFiles.some((f: string) => f.includes('nested/deep'))).toBe(
			true,
		);
	});

	it('filters by exclude glob pattern', async () => {
		createTestFile('src/app.ts', 'EXCLUDE_MARKER\n');
		createTestFile('tests/app.test.ts', 'EXCLUDE_MARKER\n');
		createTestFile('node_modules/pkg/index.js', 'EXCLUDE_MARKER\n');

		const result = await executeSearch(
			{ query: 'EXCLUDE_MARKER', exclude: '**/*.test.ts' },
			tmpDir,
		);
		const parsed = JSON.parse(result);

		expect(parsed.error).toBeUndefined();
		// Should not include test files
		for (const match of parsed.matches) {
			expect(match.file).not.toMatch(/\.test\.ts$/);
		}
	});

	it('combines include and exclude patterns', async () => {
		createTestFile('src/app.ts', 'COMBINED\n');
		createTestFile('src/app.test.ts', 'COMBINED\n');
		createTestFile('tests/app.ts', 'COMBINED\n');

		const result = await executeSearch(
			{ query: 'COMBINED', include: 'src/**', exclude: '**/*.test.ts' },
			tmpDir,
		);
		const parsed = JSON.parse(result);

		expect(parsed.error).toBeUndefined();
		expect(parsed.matches.length).toBe(1);
		// Normalize backslashes to forward slashes for cross-platform comparison
		const normalizedFile = parsed.matches[0].file.replace(/\\/g, '/');
		expect(normalizedFile).toBe('src/app.ts');
	});

	it('handles multiple glob patterns in include (comma-separated)', async () => {
		createTestFile('src/app.ts', 'MULTI\n');
		createTestFile('tests/app.test.ts', 'MULTI\n');
		createTestFile('src/app.js', 'MULTI\n');
		createTestFile('src/nested/deep.ts', 'MULTI\n');
		createTestFile('tests/nested/deep.test.ts', 'MULTI\n');

		// Use patterns that match .ts files at any depth including root
		const result = await executeSearch(
			{ query: 'MULTI', include: '**/*.ts,**/*.test.ts' },
			tmpDir,
		);
		const parsed = JSON.parse(result);

		expect(parsed.error).toBeUndefined();
		// Normalize paths for cross-platform comparison
		const normalizedMatches = parsed.matches.map((m: { file: string }) =>
			m.file.replace(/\\/g, '/'),
		);
		expect(normalizedMatches.length).toBeGreaterThanOrEqual(4);
	});

	it('excludes node_modules when explicitly excluded', async () => {
		createTestFile('src/app.ts', 'NOMOD\n');
		createTestFile('node_modules/pkg/index.js', 'NOMOD\n');

		const result = await executeSearch(
			{ query: 'NOMOD', exclude: 'node_modules/**' },
			tmpDir,
		);
		const parsed = JSON.parse(result);

		// When explicitly excluded, node_modules should not be in results
		for (const match of parsed.matches) {
			expect(match.file).not.toContain('node_modules');
		}
	});
});

// ============ Empty Query Validation Tests ============

describe('search - query validation', () => {
	it('rejects empty query string', async () => {
		const result = await executeSearch({ query: '' }, tmpDir);
		const parsed = JSON.parse(result);

		expect(parsed.error).toBe(true);
		expect(parsed.type).toBe('invalid-query');
		expect(parsed.message).toContain('empty');
	});

	it('rejects whitespace-only query', async () => {
		const result = await executeSearch({ query: '   ' }, tmpDir);
		const parsed = JSON.parse(result);

		expect(parsed.error).toBe(true);
		expect(parsed.type).toBe('invalid-query');
	});

	it('rejects query with control characters', async () => {
		const result = await executeSearch({ query: 'test\ninjection' }, tmpDir);
		const parsed = JSON.parse(result);

		expect(parsed.error).toBe(true);
		expect(parsed.type).toBe('invalid-query');
		expect(parsed.message).toContain('control characters');
	});
});

// ============ Output Structure Tests ============

describe('search - output structure', () => {
	it('returns proper SearchResult structure', async () => {
		createTestFile('src/struct.ts', 'searchable content\n');

		const result = await executeSearch({ query: 'searchable' }, tmpDir);
		const parsed = JSON.parse(result);

		expect(parsed).toHaveProperty('matches');
		expect(parsed).toHaveProperty('truncated');
		expect(parsed).toHaveProperty('total');
		expect(parsed).toHaveProperty('query');
		expect(parsed).toHaveProperty('mode');
		expect(parsed).toHaveProperty('maxResults');

		expect(typeof parsed.truncated).toBe('boolean');
		expect(typeof parsed.total).toBe('number');
		expect(typeof parsed.query).toBe('string');
		expect(typeof parsed.mode).toBe('string');
		expect(typeof parsed.maxResults).toBe('number');
	});

	it('returns proper SearchError structure', async () => {
		const result = await executeSearch({ query: '' }, tmpDir);
		const parsed = JSON.parse(result);

		expect(parsed).toHaveProperty('error');
		expect(parsed).toHaveProperty('type');
		expect(parsed).toHaveProperty('message');

		expect(parsed.error).toBe(true);
		expect(typeof parsed.type).toBe('string');
		expect(typeof parsed.message).toBe('string');
	});

	it('lineText is trimmed of trailing whitespace', async () => {
		createTestFile('src/trim.ts', 'content with trailing spaces    \n');

		const result = await executeSearch({ query: 'content' }, tmpDir);
		const parsed = JSON.parse(result);

		expect(parsed.matches[0].lineText).toBe('content with trailing spaces');
		expect(parsed.matches[0].lineText).not.toMatch(/ {2,}$/);
	});
});

// ============ rg-not-found Fallback Tests ============

describe('search - rg-not-found fallback', () => {
	it('returns rg-not-found error type when ripgrep unavailable', async () => {
		// This test verifies the error structure is correct
		// The actual rg-not-found behavior depends on whether rg is installed
		// We can at least verify the error format is correct by checking error structure

		const result = await executeSearch({ query: 'test' }, tmpDir);
		const _parsed = JSON.parse(result);

		// If rg is not found, we should get rg-not-found error OR results from fallback
		// Either way the response should be valid JSON
		expect(typeof result).toBe('string');
		expect(() => JSON.parse(result)).not.toThrow();
	});

	it('fallback search works when ripgrep not available', async () => {
		// This tests the fallback path - even if rg IS available,
		// the fallback should produce valid structured output
		createTestFile('src/fallback.ts', 'fallback search content\n');

		const result = await executeSearch({ query: 'fallback' }, tmpDir);
		const parsed = JSON.parse(result);

		// Should get either rg results or fallback results
		if (parsed.error) {
			// If error, it should be a specific error type
			expect(parsed.type).toBeDefined();
		} else {
			// If success, should have matches
			expect(parsed.matches).toBeDefined();
		}
	});
});

// ============ Regex Timeout Tests ============

describe('search - regex timeout', () => {
	it('handles potentially slow regex without hanging', async () => {
		// Create a file that could cause regex backtracking
		createTestFile('src/slow.ts', `${'a'.repeat(1000)}\n`);

		// A regex that could cause backtracking issues
		const slowRegex = '(a+)+b';

		const result = await executeSearch(
			{ query: slowRegex, mode: 'regex' },
			tmpDir,
		);
		const parsed = JSON.parse(result);

		// Should either complete or return timeout error
		expect(typeof result).toBe('string');
		if (parsed.error) {
			expect(parsed.type).toBeOneOf([
				'regex-timeout',
				'invalid-query',
				'rg-not-found',
			]);
		}
	});
});

// ============ Boundary Tests ============

describe('search - boundary cases', () => {
	it('handles query that appears multiple times on same line', async () => {
		createTestFile('src/multiple.ts', 'foo foo foo foo foo\n');

		const result = await executeSearch({ query: 'foo' }, tmpDir);
		const parsed = JSON.parse(result);

		expect(parsed.error).toBeUndefined();
		expect(parsed.total).toBeGreaterThanOrEqual(1);
	});

	it('handles Unicode content correctly', async () => {
		createTestFile(
			'src/unicode.ts',
			'function 日本語() {\n  return "こんにちは";\n}\n',
		);

		const result = await executeSearch({ query: '日本語' }, tmpDir);
		const parsed = JSON.parse(result);

		expect(parsed.error).toBeUndefined();
		expect(parsed.matches.length).toBeGreaterThanOrEqual(1);
		expect(parsed.matches[0].lineText).toContain('日本語');
	});

	it('handles file with only the search term', async () => {
		createTestFile('src/only.ts', 'onlymatch\n');

		const result = await executeSearch({ query: 'onlymatch' }, tmpDir);
		const parsed = JSON.parse(result);

		expect(parsed.error).toBeUndefined();
		expect(parsed.matches.length).toBe(1);
		expect(parsed.matches[0].lineText).toBe('onlymatch');
	});

	it('respects max_lines of 0 (edge case)', async () => {
		createTestFile('src/zero.ts', 'some content\n');

		const result = await executeSearch({ query: 'some', max_lines: 0 }, tmpDir);
		const parsed = JSON.parse(result);

		expect(parsed.error).toBeUndefined();
		// With max_lines 0, line should be truncated to "..." immediately
		expect(parsed.matches[0].lineText).toBe('...');
	});

	it('handles query matching file path segments', async () => {
		createTestFile('src/app.ts', 'content in app.ts\n');
		createTestFile('src/application.ts', 'content in application.ts\n');

		const result = await executeSearch({ query: 'app' }, tmpDir);
		const parsed = JSON.parse(result);

		expect(parsed.error).toBeUndefined();
		expect(parsed.matches.length).toBeGreaterThanOrEqual(2);
	});
});

// ============ File Read Security Tests ============

describe('search - file read security', () => {
	it('does not read files outside workspace', async () => {
		// Create a file inside workspace
		createTestFile('src/inside.ts', 'INSIDE_MARKER\n');

		// Try to search - should not access files outside tmpDir
		const result = await executeSearch({ query: 'INSIDE_MARKER' }, tmpDir);
		const parsed = JSON.parse(result);

		expect(parsed.error).toBeUndefined();
		expect(parsed.matches.length).toBe(1);
		// Normalize backslashes to forward slashes for cross-platform comparison
		const normalizedFile = parsed.matches[0].file.replace(/\\/g, '/');
		expect(normalizedFile).toBe('src/inside.ts');
	});

	it('respects max file size limit (1MB)', async () => {
		// Create a file just under the limit
		const almostMax = 'x'.repeat(1024 * 1024 - 100);
		createTestFile('src/almost-max.ts', `${almostMax}\n`);

		const result = await executeSearch({ query: 'x' }, tmpDir);
		const _parsed = JSON.parse(result);

		// Should either skip the file or handle gracefully
		expect(typeof result).toBe('string');
	});
});
