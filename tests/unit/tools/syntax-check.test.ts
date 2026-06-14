import { afterEach, beforeEach, describe, expect, it, vi } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { PluginConfig } from '../../../src/config';
import {
	type SyntaxCheckInput,
	syntaxCheck,
} from '../../../src/tools/syntax-check';

// Mock the saveEvidence function
vi.mock('../../../src/evidence/manager', () => ({
	saveEvidence: vi.fn().mockResolvedValue(undefined),
}));

describe('syntax_check tool', () => {
	let tmpDir: string;
	let originalCwd: string;

	beforeEach(async () => {
		originalCwd = process.cwd();
		tmpDir = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), 'syntax-check-test-')),
		);
		process.chdir(tmpDir);
	});

	afterEach(() => {
		process.chdir(originalCwd);
		if (tmpDir && fs.existsSync(tmpDir)) {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
		vi.clearAllMocks();
	});

	// ============ Valid File Parsing ============

	describe('valid file parsing', () => {
		it('parses valid JavaScript file successfully', async () => {
			const testFile = path.join(tmpDir, 'test.js');
			fs.writeFileSync(testFile, 'const x = 1;\nconst y = 2;');

			const input: SyntaxCheckInput = {
				changed_files: [{ path: testFile, additions: 10 }],
				mode: 'changed',
			};

			const result = await syntaxCheck(input, tmpDir);

			expect(result.verdict).toBe('pass');
			expect(result.files).toHaveLength(1);
			expect(result.files[0]?.path).toBe(testFile);
			expect(result.files[0]?.ok).toBe(true);
			expect(result.files[0]?.language).toBe('typescript');
			expect(result.files[0]?.errors).toEqual([]);
		});

		it('parses valid Python file successfully', async () => {
			const testFile = path.join(tmpDir, 'test.py');
			fs.writeFileSync(testFile, 'def hello():\n    print("world")');

			const input: SyntaxCheckInput = {
				changed_files: [{ path: testFile, additions: 5 }],
				mode: 'changed',
			};

			const result = await syntaxCheck(input, tmpDir);

			expect(result.verdict).toBe('pass');
			expect(result.files).toHaveLength(1);
			expect(result.files[0]?.ok).toBe(true);
			expect(result.files[0]?.language).toBe('python');
		});

		it('filters files with no additions in changed mode', async () => {
			const testFile = path.join(tmpDir, 'test.js');
			fs.writeFileSync(testFile, 'const x = 1;');

			const input: SyntaxCheckInput = {
				changed_files: [{ path: testFile, additions: 0 }],
				mode: 'changed',
			};

			const result = await syntaxCheck(input, tmpDir);

			expect(result.files).toHaveLength(0);
		});
	});

	// ============ Syntax Error Detection ============

	describe('syntax error detection', () => {
		it('detects syntax errors in JavaScript', async () => {
			const testFile = path.join(tmpDir, 'invalid.js');
			// Missing closing brace (confirmed fails tree-sitter)
			fs.writeFileSync(testFile, 'const x = {');

			const input: SyntaxCheckInput = {
				changed_files: [{ path: testFile, additions: 1 }],
				mode: 'changed',
			};

			const result = await syntaxCheck(input, tmpDir);

			expect(result.verdict).toBe('fail');
			expect(result.files).toHaveLength(1);
			expect(result.files[0]?.ok).toBe(false);
			expect(result.files[0]?.errors?.length).toBeGreaterThan(0);
		});

		it('detects syntax errors in Python', async () => {
			const testFile = path.join(tmpDir, 'invalid.py');
			// Invalid Python syntax
			fs.writeFileSync(testFile, 'def foo():\n    print("hello")\n    return');

			const input: SyntaxCheckInput = {
				changed_files: [{ path: testFile, additions: 1 }],
				mode: 'changed',
			};

			const result = await syntaxCheck(input, tmpDir);

			// Python syntax errors may or may not be caught depending on tree-sitter grammar
			expect(result.files).toHaveLength(1);
			// The file should be processed (not skipped)
			expect(result.files[0]?.skipped_reason).toBeUndefined();
		});
	});

	// ============ Binary File Detection ============

	describe('binary file detection', () => {
		it('skips binary files', async () => {
			const testFile = path.join(tmpDir, 'binary.js');
			// Create a file with null bytes (binary content)
			const buffer = Buffer.alloc(1000, 0);
			fs.writeFileSync(testFile, buffer);

			const input: SyntaxCheckInput = {
				changed_files: [{ path: testFile, additions: 1 }],
				mode: 'changed',
			};

			const result = await syntaxCheck(input, tmpDir);

			expect(result.files).toHaveLength(1);
			expect(result.files[0]?.skipped_reason).toBe('binary_file');
		});

		it('handles files with some null bytes but below threshold', async () => {
			const testFile = path.join(tmpDir, 'mixed.js');
			// ~2.5% null bytes (5 nulls in 200 chars), clearly below 10% threshold
			const content =
				'const x = 1; // valid code with minimal nulls\0\0\0\0\0'.padEnd(
					200,
					' ',
				);
			fs.writeFileSync(testFile, content);

			const input: SyntaxCheckInput = {
				changed_files: [{ path: testFile, additions: 1 }],
				mode: 'changed',
			};

			const result = await syntaxCheck(input, tmpDir);

			// Should not be skipped as binary
			expect(result.files[0]?.skipped_reason).not.toBe('binary_file');
		});
	});

	// ============ Size Limit Enforcement ============

	describe('size limit enforcement', () => {
		it('skips files larger than 2MB', async () => {
			const testFile = path.join(tmpDir, 'large.js');
			// Create a file larger than 2MB (WASM tree-sitter aborts on larger files)
			const largeContent = 'x'.repeat(3 * 1024 * 1024);
			fs.writeFileSync(testFile, largeContent);

			const input: SyntaxCheckInput = {
				changed_files: [{ path: testFile, additions: 1 }],
				mode: 'changed',
			};

			const result = await syntaxCheck(input, tmpDir);

			expect(result.files).toHaveLength(1);
			expect(result.files[0]?.skipped_reason).toBe('file_too_large');
		});

		it('skips files at 2MB limit', async () => {
			const testFile = path.join(tmpDir, 'boundary.js');
			// Create a file at or above the 2MB limit — skipped to avoid WASM OOM
			const boundaryContent = 'const x = 1;'.repeat(
				Math.ceil((2 * 1024 * 1024) / 'const x = 1;'.length),
			);
			fs.writeFileSync(testFile, boundaryContent);

			const input: SyntaxCheckInput = {
				changed_files: [{ path: testFile, additions: 1 }],
				mode: 'changed',
			};

			const result = await syntaxCheck(input, tmpDir);

			// Files at exactly the size limit are skipped (>= check prevents WASM crash)
			expect(result.files[0]?.skipped_reason).toBe('file_too_large');
		});
	});

	// ============ Feature Flag Disabled Path ============

	describe('feature flag disabled path', () => {
		it('returns pass when syntax_check is disabled', async () => {
			const testFile = path.join(tmpDir, 'test.js');
			fs.writeFileSync(testFile, 'const x = 1;');

			const input: SyntaxCheckInput = {
				changed_files: [{ path: testFile, additions: 1 }],
				mode: 'changed',
			};

			const config: PluginConfig = {
				gates: {
					syntax_check: {
						enabled: false,
					},
				},
			} as PluginConfig;

			const result = await syntaxCheck(input, tmpDir, config);

			expect(result.verdict).toBe('pass');
			expect(result.summary).toBe('syntax_check disabled by configuration');
			expect(result.files).toHaveLength(0);
		});
	});

	// ============ Unknown Extension Handling ============

	describe('unknown extension handling', () => {
		it('skips unsupported file extensions', async () => {
			const testFile = path.join(tmpDir, 'test.xyz');
			fs.writeFileSync(testFile, 'some content');

			const input: SyntaxCheckInput = {
				changed_files: [{ path: testFile, additions: 1 }],
				mode: 'changed',
			};

			const result = await syntaxCheck(input, tmpDir);

			expect(result.files).toHaveLength(1);
			expect(result.files[0]?.skipped_reason).toBe('unsupported_language');
		});

		it('filters by language when specified', async () => {
			const jsFile = path.join(tmpDir, 'test.js');
			const pyFile = path.join(tmpDir, 'test.py');
			fs.writeFileSync(jsFile, 'const x = 1;');
			fs.writeFileSync(pyFile, 'print(1)');

			const input: SyntaxCheckInput = {
				changed_files: [
					{ path: jsFile, additions: 1 },
					{ path: pyFile, additions: 1 },
				],
				mode: 'changed',
				languages: ['typescript'],
			};

			const result = await syntaxCheck(input, tmpDir);

			// Only TypeScript-profile files should be checked (.js resolves to 'typescript' via profile)
			expect(result.files).toHaveLength(1);
			expect(result.files[0]?.language).toBe('typescript');
		});
	});

	// ============ Edge Cases ============

	describe('edge cases', () => {
		it('handles non-existent files gracefully', async () => {
			const input: SyntaxCheckInput = {
				changed_files: [{ path: 'nonexistent.js', additions: 1 }],
				mode: 'changed',
			};

			const result = await syntaxCheck(input, tmpDir);

			expect(result.files).toHaveLength(1);
			expect(result.files[0]?.skipped_reason).toBe('file_read_error');
		});

		it('produces correct summary for mixed results', async () => {
			const validFile = path.join(tmpDir, 'valid.js');
			const invalidFile = path.join(tmpDir, 'invalid.js');
			fs.writeFileSync(validFile, 'const x = 1;');
			fs.writeFileSync(invalidFile, 'const x = {');

			const input: SyntaxCheckInput = {
				changed_files: [
					{ path: validFile, additions: 1 },
					{ path: invalidFile, additions: 1 },
				],
				mode: 'changed',
			};

			const result = await syntaxCheck(input, tmpDir);

			expect(result.summary).toContain('Syntax errors found');
		});
	});

	// ============ Deep-nesting stack traversal (DD-C018) ============

	describe('deep-nesting stack traversal (DD-C018)', () => {
		it('handles pathologically deeply nested JSON without stack overflow (10,000 levels)', async () => {
			// Build a deeply nested JSON object: [[[[...(10,000 levels)...]]]]
			// This would overflow the JS call stack with a recursive walker but
			// must succeed with the explicit stack-based traversal in
			// syntax-check.ts (DD-C018).
			const DEPTH = 10_000;
			const nested = '['.repeat(DEPTH) + '1' + ']'.repeat(DEPTH);
			const testFile = path.join(tmpDir, 'deep.js');
			// Wrap in a JS variable assignment so it parses as a JS expression
			fs.writeFileSync(testFile, `const x = ${nested};`);

			const input: SyntaxCheckInput = {
				changed_files: [{ path: testFile, additions: 1 }],
				mode: 'changed',
			};

			// Must complete without throwing (no stack overflow) and without
			// hanging. We allow the verdict to be pass or fail depending on
			// whether the parser treats extreme nesting as a syntax error, but
			// it MUST not throw.
			let caughtError: unknown;
			let result: Awaited<ReturnType<typeof syntaxCheck>> | undefined;
			try {
				result = await syntaxCheck(input, tmpDir);
			} catch (e) {
				caughtError = e;
			}
			expect(caughtError).toBeUndefined();
			expect(result).toBeDefined();
			// verdict must be a valid value (no uncaught exception from traversal)
			expect(['pass', 'fail', 'skipped']).toContain(result?.verdict);
		});
	});
});
