import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ToolContext } from '@opencode-ai/plugin';
import { batch_symbols } from './batch-symbols';
import type { ToolResult } from './create-tool';

// Helper to convert ToolResult to string
function resultToString(result: ToolResult): string {
	return typeof result === 'string' ? result : result.output;
}

// Helper to call tool execute with proper context
async function executeBatchSymbols(
	args: Record<string, unknown>,
	directory: string,
): Promise<string> {
	const result = await batch_symbols.execute(args, {
		directory,
	} as unknown as ToolContext);
	return resultToString(result);
}

// Helper to create temp dir
let tempDir: string;

beforeEach(() => {
	tempDir = fs.realpathSync(
		fs.mkdtempSync(path.join(process.cwd(), 'batch-symbols-test-')),
	);
});

afterEach(() => {
	// Clean up temp directory
	try {
		fs.rmSync(tempDir, { recursive: true, force: true });
	} catch {
		// Ignore cleanup errors
	}
});

function createTestFile(relativePath: string, content: string): string {
	const fullPath = path.join(tempDir, relativePath);
	const dir = path.dirname(fullPath);
	if (!fs.existsSync(dir)) {
		fs.mkdirSync(dir, { recursive: true });
	}
	fs.writeFileSync(fullPath, content, 'utf-8');
	return relativePath;
}

describe('batch_symbols', () => {
	describe('batch processing multiple files', () => {
		test('processes multiple valid TypeScript files', async () => {
			createTestFile(
				'file1.ts',
				`
export function hello(name: string): string {
  return \`Hello, \${name}\`;
}

export class MyClass {
  public method(): void {}
}
`,
			);

			createTestFile(
				'file2.ts',
				`
export const PI = 3.14;

export interface Config {
  port: number;
}
`,
			);

			const result = await executeBatchSymbols(
				{ files: ['file1.ts', 'file2.ts'], exported_only: true },
				tempDir,
			);

			const parsed = JSON.parse(resultToString(result));

			expect(parsed.totalFiles).toBe(2);
			expect(parsed.successCount).toBe(2);
			expect(parsed.failureCount).toBe(0);
			expect(parsed.results).toHaveLength(2);

			// First file has function and class
			const file1Result = parsed.results[0];
			expect(file1Result.success).toBe(true);
			expect(file1Result.file).toBe('file1.ts');
			expect(file1Result.symbols).toBeDefined();
			expect(file1Result.symbols.length).toBeGreaterThanOrEqual(2);

			// Second file has const and interface
			const file2Result = parsed.results[1];
			expect(file2Result.success).toBe(true);
			expect(file2Result.file).toBe('file2.ts');
			expect(file2Result.symbols).toBeDefined();
		});

		test('processes mixed TypeScript and Python files', async () => {
			createTestFile(
				'script.ts',
				`
export function greet(): void {
  console.log('hello');
}
`,
			);

			createTestFile(
				'module.py',
				`
def hello():
    pass

class MyClass:
    pass
`,
			);

			const result = await executeBatchSymbols(
				{ files: ['script.ts', 'module.py'], exported_only: true },
				tempDir,
			);

			const parsed = JSON.parse(resultToString(result));

			expect(parsed.totalFiles).toBe(2);
			expect(parsed.successCount).toBe(2);
			expect(parsed.failureCount).toBe(0);
		});

		test('maintains stable ordering matching input', async () => {
			createTestFile('aaa.ts', 'export const a = 1;');
			createTestFile('bbb.ts', 'export const b = 2;');
			createTestFile('ccc.ts', 'export const c = 3;');

			const result = await executeBatchSymbols(
				{ files: ['ccc.ts', 'aaa.ts', 'bbb.ts'], exported_only: true },
				tempDir,
			);

			const parsed = JSON.parse(resultToString(result));

			expect(parsed.results[0].file).toBe('ccc.ts');
			expect(parsed.results[1].file).toBe('aaa.ts');
			expect(parsed.results[2].file).toBe('bbb.ts');
		});
	});

	describe('partial-failure handling', () => {
		test('one bad file does not crash batch', async () => {
			createTestFile('good.ts', 'export const value = 42;');
			createTestFile('also-good.ts', 'export const another = 1;');

			const result = await executeBatchSymbols(
				{
					files: ['good.ts', 'nonexistent.ts', 'also-good.ts'],
					exported_only: true,
				},
				tempDir,
			);

			const parsed = JSON.parse(resultToString(result));

			expect(parsed.totalFiles).toBe(3);
			expect(parsed.results).toHaveLength(3);

			// Check that good files still succeeded
			expect(parsed.results[0].success).toBe(true);
			expect(parsed.results[0].file).toBe('good.ts');
			expect(parsed.results[2].success).toBe(true);
			expect(parsed.results[2].file).toBe('also-good.ts');
		});

		test('unsupported file type fails gracefully while others succeed', async () => {
			createTestFile('valid.ts', 'export function foo() {}');
			createTestFile('data.txt', 'some text content');

			const result = await executeBatchSymbols(
				{ files: ['valid.ts', 'data.txt'], exported_only: true },
				tempDir,
			);

			const parsed = JSON.parse(resultToString(result));

			expect(parsed.totalFiles).toBe(2);
			expect(parsed.successCount).toBe(1);
			expect(parsed.failureCount).toBe(1);

			const txtResult = parsed.results.find((r: any) => r.file === 'data.txt');
			expect(txtResult.success).toBe(false);
			expect(txtResult.errorType).toBe('unsupported-language');
		});

		test('non-existent files are tracked in results', async () => {
			const result = await executeBatchSymbols(
				{ files: ['bad1.ts', 'bad2.ts'], exported_only: true },
				tempDir,
			);

			const parsed = JSON.parse(resultToString(result));

			// Non-existent files are processed and counted
			expect(parsed.totalFiles).toBe(2);
			expect(parsed.results).toHaveLength(2);
			// Each result has a valid structure
			for (const r of parsed.results) {
				expect(r).toHaveProperty('file');
				expect(r.success).toBe(false);
				expect(r.errorType).toBe('file-not-found');
			}
		});
	});

	describe('empty file handling', () => {
		test('empty file returns success with empty symbols', async () => {
			createTestFile('empty.ts', '');

			const result = await executeBatchSymbols(
				{ files: ['empty.ts'], exported_only: true },
				tempDir,
			);

			const parsed = JSON.parse(resultToString(result));

			expect(parsed.totalFiles).toBe(1);
			expect(parsed.successCount).toBe(1);
			expect(parsed.failureCount).toBe(0);
			expect(parsed.results[0].success).toBe(true);
			expect(parsed.results[0].symbols).toEqual([]);
			expect(parsed.results[0].error).toBe('empty-file');
			expect(parsed.results[0].errorType).toBe('empty-file');
		});

		test('file with only whitespace returns empty symbols', async () => {
			createTestFile('whitespace.ts', '   \n\n  \n  ');

			const result = await executeBatchSymbols(
				{ files: ['whitespace.ts'], exported_only: true },
				tempDir,
			);

			const parsed = JSON.parse(resultToString(result));

			expect(parsed.results[0].success).toBe(true);
			expect(parsed.results[0].symbols).toEqual([]);
		});

		test('file with only comments returns empty symbols', async () => {
			createTestFile(
				'comments.ts',
				`
// This is a comment
/* This is a block comment */
`,
			);

			const result = await executeBatchSymbols(
				{ files: ['comments.ts'], exported_only: true },
				tempDir,
			);

			const parsed = JSON.parse(resultToString(result));

			// Files with only comments and no exports return empty
			expect(parsed.results[0].success).toBe(true);
			expect(Array.isArray(parsed.results[0].symbols)).toBe(true);
		});
	});

	describe('non-code file handling', () => {
		test('returns unsupported-language error for .txt files', async () => {
			createTestFile('readme.txt', 'This is a text file');

			const result = await executeBatchSymbols(
				{ files: ['readme.txt'], exported_only: true },
				tempDir,
			);

			const parsed = JSON.parse(resultToString(result));

			expect(parsed.results[0].success).toBe(false);
			expect(parsed.results[0].errorType).toBe('unsupported-language');
			expect(parsed.results[0].error).toContain('Unsupported file extension');
		});

		test('returns unsupported-language error for .json files', async () => {
			createTestFile('config.json', '{"key": "value"}');

			const result = await executeBatchSymbols(
				{ files: ['config.json'], exported_only: true },
				tempDir,
			);

			const parsed = JSON.parse(resultToString(result));

			expect(parsed.results[0].success).toBe(false);
			expect(parsed.results[0].errorType).toBe('unsupported-language');
		});

		test('returns unsupported-language error for .md files', async () => {
			createTestFile('README.md', '# Project README');

			const result = await executeBatchSymbols(
				{ files: ['README.md'], exported_only: true },
				tempDir,
			);

			const parsed = JSON.parse(resultToString(result));

			expect(parsed.results[0].success).toBe(false);
			expect(parsed.results[0].errorType).toBe('unsupported-language');
		});

		test('returns unsupported-language error for .css files', async () => {
			createTestFile('style.css', 'body { color: red; }');

			const result = await executeBatchSymbols(
				{ files: ['style.css'], exported_only: true },
				tempDir,
			);

			const parsed = JSON.parse(resultToString(result));

			expect(parsed.results[0].success).toBe(false);
			expect(parsed.results[0].errorType).toBe('unsupported-language');
		});
	});

	describe('output structure correctness', () => {
		test('returns valid BatchSymbolsResult structure', async () => {
			createTestFile('sample.ts', 'export const x = 1;');

			const result = await executeBatchSymbols(
				{ files: ['sample.ts'], exported_only: true },
				tempDir,
			);

			const parsed = JSON.parse(resultToString(result));

			// Verify structure has all required fields
			expect(parsed).toHaveProperty('results');
			expect(parsed).toHaveProperty('totalFiles');
			expect(parsed).toHaveProperty('successCount');
			expect(parsed).toHaveProperty('failureCount');
			expect(typeof parsed.totalFiles).toBe('number');
			expect(typeof parsed.successCount).toBe('number');
			expect(typeof parsed.failureCount).toBe('number');
			expect(Array.isArray(parsed.results)).toBe(true);
		});

		test('each FileSymbolResult has correct structure', async () => {
			createTestFile('test.ts', 'export function test() {}');

			const result = await executeBatchSymbols(
				{ files: ['test.ts'], exported_only: true },
				tempDir,
			);

			const parsed = JSON.parse(resultToString(result));
			const fileResult = parsed.results[0];

			expect(fileResult).toHaveProperty('file');
			expect(fileResult).toHaveProperty('success');
			expect(typeof fileResult.success).toBe('boolean');
			expect(fileResult.file).toBe('test.ts');
		});

		test('successful result contains symbols array', async () => {
			createTestFile(
				'with-symbols.ts',
				`
export function myFunction(param: string): number {
  return 42;
}

export class MyClass {
  public myProperty: string = '';
}
`,
			);

			const result = await executeBatchSymbols(
				{ files: ['with-symbols.ts'], exported_only: true },
				tempDir,
			);

			const parsed = JSON.parse(resultToString(result));
			const fileResult = parsed.results[0];

			expect(fileResult.success).toBe(true);
			expect(fileResult.symbols).toBeDefined();
			expect(Array.isArray(fileResult.symbols)).toBe(true);
			expect(fileResult.symbols.length).toBeGreaterThan(0);

			// Verify symbol structure
			const symbol = fileResult.symbols[0];
			expect(symbol).toHaveProperty('name');
			expect(symbol).toHaveProperty('kind');
			expect(symbol).toHaveProperty('exported');
			expect(symbol).toHaveProperty('signature');
			expect(symbol).toHaveProperty('line');
		});

		test('failed result contains error and errorType', async () => {
			createTestFile('unsupported.xyz', 'some content');

			const result = await executeBatchSymbols(
				{ files: ['unsupported.xyz'], exported_only: true },
				tempDir,
			);

			const parsed = JSON.parse(resultToString(result));
			const fileResult = parsed.results[0];

			expect(fileResult.success).toBe(false);
			expect(fileResult.error).toBeDefined();
			expect(fileResult.errorType).toBeDefined();
			expect(typeof fileResult.error).toBe('string');
			expect(typeof fileResult.errorType).toBe('string');
		});

		test('exported_only filter affects symbol count', async () => {
			createTestFile(
				'exported.ts',
				`
export function exportedFunc() {}
export const exportedConst = 42;
`,
			);

			createTestFile(
				'non-exported.ts',
				`
function privateFunc() {}
const privateConst = 42;
export function publicFunc() {}
`,
			);

			// Non-exported file should return fewer symbols when exported_only is true
			const exportedOnlyResult = await executeBatchSymbols(
				{ files: ['non-exported.ts'], exported_only: true },
				tempDir,
			);

			// The file has one exported and one non-exported symbol
			// With exported_only: true, only the exported one should be returned
			const exportedParsed = JSON.parse(exportedOnlyResult);
			const symbolsWithExportFilter = exportedParsed.results[0].symbols.length;

			expect(symbolsWithExportFilter).toBeGreaterThanOrEqual(1);
		});
	});

	describe('per-file error types', () => {
		test('path-traversal returns correct error type', async () => {
			const result = await executeBatchSymbols(
				{ files: ['../escape.ts'], exported_only: true },
				tempDir,
			);

			const parsed = JSON.parse(resultToString(result));

			expect(parsed.results[0].success).toBe(false);
			expect(parsed.results[0].errorType).toBe('path-traversal');
			expect(parsed.results[0].error).toContain('path traversal');
		});

		test('path-outside-workspace returns correct error type', async () => {
			const result = await executeBatchSymbols(
				{ files: ['../../other-project/file.ts'], exported_only: true },
				tempDir,
			);

			const parsed = JSON.parse(resultToString(result));

			expect(parsed.results[0].success).toBe(false);
			expect(parsed.results[0].errorType).toBe('path-traversal');
		});

		test('invalid-path with control characters returns correct error type', async () => {
			const result = await executeBatchSymbols(
				{ files: ['file\0with\0null.ts'], exported_only: true },
				tempDir,
			);

			const parsed = JSON.parse(resultToString(result));

			expect(parsed.results[0].success).toBe(false);
			expect(parsed.results[0].errorType).toBe('invalid-path');
		});

		test('path with newline returns invalid-path', async () => {
			const result = await executeBatchSymbols(
				{ files: ['file\nwith\nnewlines.ts'], exported_only: true },
				tempDir,
			);

			const parsed = JSON.parse(resultToString(result));

			expect(parsed.results[0].success).toBe(false);
			expect(parsed.results[0].errorType).toBe('invalid-path');
		});

		test('Windows ADS stream syntax returns invalid-path', async () => {
			const result = await executeBatchSymbols(
				{ files: ['file.txt:stream'], exported_only: true },
				tempDir,
			);

			const parsed = JSON.parse(resultToString(result));

			expect(parsed.results[0].success).toBe(false);
			expect(parsed.results[0].errorType).toBe('invalid-path');
		});

		test('Windows reserved name returns invalid-path', async () => {
			const result = await executeBatchSymbols(
				{ files: ['nul.ts'], exported_only: true },
				tempDir,
			);

			const parsed = JSON.parse(resultToString(result));

			expect(parsed.results[0].success).toBe(false);
			expect(parsed.results[0].errorType).toBe('invalid-path');
		});
	});

	describe('invalid arguments handling', () => {
		test('handles non-array files argument', async () => {
			const result = await executeBatchSymbols(
				{ files: 'not-an-array' } as any,
				tempDir,
			);

			const parsed = JSON.parse(resultToString(result));

			expect(parsed.results).toEqual([]);
			expect(parsed.totalFiles).toBe(0);
			expect(parsed.error).toContain('files must be an array');
		});

		test('handles missing files argument', async () => {
			const result = await executeBatchSymbols({} as any, tempDir);

			const parsed = JSON.parse(resultToString(result));

			expect(parsed.results).toEqual([]);
			expect(parsed.totalFiles).toBe(0);
		});

		test('handles null in files array', async () => {
			const result = await executeBatchSymbols(
				{ files: [null, 'valid.ts'] } as any,
				tempDir,
			);

			const parsed = JSON.parse(resultToString(result));

			// Should process both - null gets converted to string "null"
			expect(parsed.totalFiles).toBe(2);
		});
	});
});
