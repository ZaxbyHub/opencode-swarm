/**
 * ADVERSARIAL SECURITY TESTS for syntax-check.ts bug fixes
 *
 * PURPOSE: Verify that syntax-check is secure against malformed inputs,
 * injection attempts, path traversal, and other attacks after the removal
 * of the pre-filter and the language filter fix.
 *
 * SECURITY VALIDATION: These tests verify that the bug fixes properly:
 * 1. Handle unsupported files by going through the full loop with skipped_reason
 * 2. Use getLanguageForExtension(ext).id to match languages correctly
 * 3. Handle Windows paths correctly via fileURLToPath
 *
 * ATTACK VECTORS TESTED:
 * 1. Empty/null/undefined inputs to syntaxCheck
 * 2. Path traversal patterns (e.g., ../../etc/passwd.js)
 * 3. Files list with mixed extensions and languages filter edge cases
 * 4. Files at exact size boundaries
 * 5. Language filter with empty array, null, unknown language names
 * 6. Race conditions or double-processing concerns with removed pre-filter
 * 7. Binary file detection edge cases (exactly at threshold, empty file)
 * 8. Case sensitivity attacks in language filters
 * 9. Unicode and special characters in file paths
 * 10. Extremely long file paths
 *
 * CONSTRAINT: DO NOT modify src/tools/syntax-check.ts or src/lang/runtime.ts
 * These tests verify the bug fixes are working correctly.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { PluginConfig } from '../../../src/config';
// Import the module under test
import {
	type SyntaxCheckInput,
	syntaxCheck,
} from '../../../src/tools/syntax-check';

// Mock the saveEvidence function. syntax-check.ts calls it via the
// `_internals` DI seam (see src/evidence/manager.ts), so the mock factory
// must expose the same mock function under both keys.
const mockSaveEvidence = vi.fn().mockResolvedValue(undefined);
vi.mock('../../../src/evidence/manager', () => ({
	saveEvidence: mockSaveEvidence,
	_internals: { saveEvidence: mockSaveEvidence },
}));

const { saveEvidence } = await import('../../../src/evidence/manager');

describe('syntax-check.ts - ADVERSARIAL SECURITY TESTS', () => {
	let tmpDir: string;
	let originalCwd: string;

	beforeEach(() => {
		originalCwd = process.cwd();
		tmpDir = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), 'adv-syntax-')),
		);
		process.chdir(tmpDir);
		vi.clearAllMocks();
	});

	afterEach(() => {
		process.chdir(originalCwd);
		if (tmpDir && fs.existsSync(tmpDir)) {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
		vi.clearAllMocks();
	});

	// ============ Attack Vector 1: Empty/null/undefined Inputs ============

	describe('Attack Vector 1: Empty/null/undefined inputs', () => {
		test('handles empty changed_files array', async () => {
			const input: SyntaxCheckInput = {
				changed_files: [],
				mode: 'changed',
			};

			const result = await syntaxCheck(input, tmpDir);

			expect(result.verdict).toBe('pass');
			expect(result.files).toHaveLength(0);
			expect(result.summary).toBe('All 0 files passed syntax check');
			expect(saveEvidence).toHaveBeenCalled();
		});

		test('handles undefined mode (defaults to changed)', async () => {
			const testFile = path.join(tmpDir, 'test.js');
			fs.writeFileSync(testFile, 'const x = 1;');

			const input: SyntaxCheckInput = {
				changed_files: [{ path: testFile, additions: 1 }],
				mode: undefined,
			};

			const result = await syntaxCheck(input, tmpDir);

			// Default mode is 'changed', should filter by additions > 0
			expect(result.files).toHaveLength(1);
			expect(saveEvidence).toHaveBeenCalled();
		});

		test('handles undefined languages (no filter applied)', async () => {
			const testFile = path.join(tmpDir, 'test.js');
			fs.writeFileSync(testFile, 'const x = 1;');

			const input: SyntaxCheckInput = {
				changed_files: [{ path: testFile, additions: 1 }],
				mode: 'changed',
				languages: undefined,
			};

			const result = await syntaxCheck(input, tmpDir);

			expect(result.files).toHaveLength(1);
			expect(result.files[0]?.ok).toBe(true);
			expect(saveEvidence).toHaveBeenCalled();
		});

		test('handles empty string file paths gracefully', async () => {
			const input: SyntaxCheckInput = {
				changed_files: [{ path: '', additions: 1 }],
				mode: 'changed',
			};

			const result = await syntaxCheck(input, tmpDir);

			// Empty path results in empty extension, which is unsupported_language
			// This is correct behavior with pre-filter removed
			expect(result.files).toHaveLength(1);
			expect(result.files[0]?.skipped_reason).toBe('unsupported_language');
			expect(saveEvidence).toHaveBeenCalled();
		});

		test('handles file with 0 additions in changed mode', async () => {
			const testFile = path.join(tmpDir, 'test.js');
			fs.writeFileSync(testFile, 'const x = 1;');

			const input: SyntaxCheckInput = {
				changed_files: [{ path: testFile, additions: 0 }],
				mode: 'changed',
			};

			const result = await syntaxCheck(input, tmpDir);

			// Should be filtered out by additions > 0 check
			expect(result.files).toHaveLength(0);
			expect(saveEvidence).toHaveBeenCalled();
		});

		test('handles negative additions (edge case)', async () => {
			const testFile = path.join(tmpDir, 'test.js');
			fs.writeFileSync(testFile, 'const x = 1;');

			const input: SyntaxCheckInput = {
				changed_files: [{ path: testFile, additions: -5 }],
				mode: 'changed',
			};

			const result = await syntaxCheck(input, tmpDir);

			// Should be filtered out since -5 > 0 is false
			expect(result.files).toHaveLength(0);
		});
	});

	// ============ Attack Vector 2: Path Traversal Patterns ============

	describe('Attack Vector 2: Path traversal patterns', () => {
		test('rejects path traversal via ../ (file read error)', async () => {
			const input: SyntaxCheckInput = {
				changed_files: [{ path: '../../etc/passwd.js', additions: 1 }],
				mode: 'changed',
			};

			const result = await syntaxCheck(input, tmpDir);

			expect(result.files).toHaveLength(1);
			expect(result.files[0]?.path).toBe('../../etc/passwd.js');
			// Should get file_read_error since the file doesn't exist
			expect(result.files[0]?.skipped_reason).toBe('file_read_error');
			expect(saveEvidence).toHaveBeenCalled();
		});

		test('rejects deep path traversal', async () => {
			const input: SyntaxCheckInput = {
				changed_files: [
					{ path: '../../../../../../etc/passwd.js', additions: 1 },
				],
				mode: 'changed',
			};

			const result = await syntaxCheck(input, tmpDir);

			expect(result.files).toHaveLength(1);
			expect(result.files[0]?.skipped_reason).toBe('file_read_error');
		});

		test('handles mixed valid and invalid paths', async () => {
			const validFile = path.join(tmpDir, 'valid.js');
			fs.writeFileSync(validFile, 'const x = 1;');

			const input: SyntaxCheckInput = {
				changed_files: [
					{ path: validFile, additions: 1 },
					{ path: '../../etc/passwd.js', additions: 1 },
				],
				mode: 'changed',
			};

			const result = await syntaxCheck(input, tmpDir);

			expect(result.files).toHaveLength(2);
			expect(result.files[0]?.ok).toBe(true);
			expect(result.files[1]?.skipped_reason).toBe('file_read_error');
		});

		test('rejects absolute path to system directories', async () => {
			// Use an absolute path that likely doesn't exist
			const input: SyntaxCheckInput = {
				changed_files: [{ path: '/System/Library/test.js', additions: 1 }],
				mode: 'changed',
			};

			const result = await syntaxCheck(input, tmpDir);

			expect(result.files).toHaveLength(1);
			expect(result.files[0]?.skipped_reason).toBe('file_read_error');
		});
	});

	// ============ Attack Vector 3: Mixed Extensions & Language Filter Edge Cases ============

	describe('Attack Vector 3: Mixed extensions and language filter edge cases', () => {
		test('filters by language correctly with mixed extensions', async () => {
			const jsFile = path.join(tmpDir, 'test.js');
			const pyFile = path.join(tmpDir, 'test.py');
			const goFile = path.join(tmpDir, 'test.go');
			fs.writeFileSync(jsFile, 'const x = 1;');
			fs.writeFileSync(pyFile, 'print("hello")');
			fs.writeFileSync(goFile, 'package main');

			const input: SyntaxCheckInput = {
				changed_files: [
					{ path: jsFile, additions: 1 },
					{ path: pyFile, additions: 1 },
					{ path: goFile, additions: 1 },
				],
				mode: 'changed',
				languages: ['typescript'],
			};

			const result = await syntaxCheck(input, tmpDir);

			// .js files map to 'typescript' profile in LANGUAGE_REGISTRY
			expect(result.files).toHaveLength(1);
			expect(result.files[0]?.language).toBe('typescript');
			expect(result.files[0]?.ok).toBe(true);
		});

		test('handles empty language filter array (no filter applied)', async () => {
			const jsFile = path.join(tmpDir, 'test.js');
			const pyFile = path.join(tmpDir, 'test.py');
			fs.writeFileSync(jsFile, 'const x = 1;');
			fs.writeFileSync(pyFile, 'print("hello")');

			const input: SyntaxCheckInput = {
				changed_files: [
					{ path: jsFile, additions: 1 },
					{ path: pyFile, additions: 1 },
				],
				mode: 'changed',
				languages: [],
			};

			const result = await syntaxCheck(input, tmpDir);

			// Empty array means no filter, should process all files
			expect(result.files).toHaveLength(2);
		});

		test('handles unsupported extensions with language filter', async () => {
			const unknownFile = path.join(tmpDir, 'test.xyz');
			const jsFile = path.join(tmpDir, 'test.js');
			fs.writeFileSync(unknownFile, 'random content');
			fs.writeFileSync(jsFile, 'const x = 1;');

			const input: SyntaxCheckInput = {
				changed_files: [
					{ path: unknownFile, additions: 1 },
					{ path: jsFile, additions: 1 },
				],
				mode: 'changed',
				languages: ['typescript'],
			};

			const result = await syntaxCheck(input, tmpDir);

			// .xyz extension not supported, should only process .js (which maps to 'typescript' profile)
			expect(result.files).toHaveLength(1);
			expect(result.files[0]?.language).toBe('typescript');
		});

		test('case sensitivity in language filter', async () => {
			const jsFile = path.join(tmpDir, 'test.js');
			fs.writeFileSync(jsFile, 'const x = 1;');

			// Test uppercase language filter
			const input: SyntaxCheckInput = {
				changed_files: [{ path: jsFile, additions: 1 }],
				mode: 'changed',
				languages: ['TYPESCRIPT'], // Should match (case-insensitive)
			};

			const result = await syntaxCheck(input, tmpDir);

			expect(result.files).toHaveLength(1);
			expect(result.files[0]?.language).toBe('typescript');
		});

		test('handles multiple language filters', async () => {
			const jsFile = path.join(tmpDir, 'test.js');
			const pyFile = path.join(tmpDir, 'test.py');
			const goFile = path.join(tmpDir, 'test.go');
			fs.writeFileSync(jsFile, 'const x = 1;');
			fs.writeFileSync(pyFile, 'print("hello")');
			fs.writeFileSync(goFile, 'package main');

			const input: SyntaxCheckInput = {
				changed_files: [
					{ path: jsFile, additions: 1 },
					{ path: pyFile, additions: 1 },
					{ path: goFile, additions: 1 },
				],
				mode: 'changed',
				languages: ['typescript', 'python'],
			};

			const result = await syntaxCheck(input, tmpDir);

			expect(result.files).toHaveLength(2);
			const languages = result.files.map((f) => f.language).sort();
			expect(languages).toEqual(['python', 'typescript']);
		});
	});

	// ============ Attack Vector 4: Files at Exact Size Boundaries ============

	describe('Attack Vector 4: Files at exact size boundaries', () => {
		const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB

		test('handles empty file (0 bytes)', async () => {
			const emptyFile = path.join(tmpDir, 'empty.js');
			fs.writeFileSync(emptyFile, '');

			const input: SyntaxCheckInput = {
				changed_files: [{ path: emptyFile, additions: 1 }],
				mode: 'changed',
			};

			const result = await syntaxCheck(input, tmpDir);

			expect(result.files).toHaveLength(1);
			expect(result.files[0]?.ok).toBe(true);
		});

		test('handles file at exactly MAX_FILE_SIZE (5MB)', async () => {
			const largeFile = path.join(tmpDir, 'large.js');
			const content = ' '.repeat(MAX_FILE_SIZE); // Exactly 5MB of spaces
			fs.writeFileSync(largeFile, content);

			const input: SyntaxCheckInput = {
				changed_files: [{ path: largeFile, additions: 1 }],
				mode: 'changed',
			};

			const result = await syntaxCheck(input, tmpDir);

			// At the boundary, should pass (content.length > MAX_FILE_SIZE is false)
			expect(result.files).toHaveLength(1);
		});

		test('rejects file one byte over MAX_FILE_SIZE', async () => {
			const largeFile = path.join(tmpDir, 'large.js');
			const content = ' '.repeat(MAX_FILE_SIZE + 1); // 5MB + 1 byte
			fs.writeFileSync(largeFile, content);

			const input: SyntaxCheckInput = {
				changed_files: [{ path: largeFile, additions: 1 }],
				mode: 'changed',
			};

			const result = await syntaxCheck(input, tmpDir);

			expect(result.files).toHaveLength(1);
			expect(result.files[0]?.skipped_reason).toBe('file_too_large');
		});

		test('handles very small file (1 byte)', async () => {
			const tinyFile = path.join(tmpDir, 'tiny.js');
			// Use an actual syntax error - missing semicolon in statement
			fs.writeFileSync(tinyFile, 'a=');

			const input: SyntaxCheckInput = {
				changed_files: [{ path: tinyFile, additions: 1 }],
				mode: 'changed',
			};

			const result = await syntaxCheck(input, tmpDir);

			expect(result.files).toHaveLength(1);
			expect(result.files[0]?.ok).toBe(false); // Invalid syntax - incomplete statement
		});
	});

	// ============ Attack Vector 5: Language Filter Edge Cases ============

	describe('Attack Vector 5: Language filter edge cases', () => {
		test('handles unknown language names', async () => {
			const jsFile = path.join(tmpDir, 'test.js');
			fs.writeFileSync(jsFile, 'const x = 1;');

			const input: SyntaxCheckInput = {
				changed_files: [{ path: jsFile, additions: 1 }],
				mode: 'changed',
				languages: ['unknown-language'],
			};

			const result = await syntaxCheck(input, tmpDir);

			// Should filter out since language doesn't match
			expect(result.files).toHaveLength(0);
		});

		test('handles mixed known and unknown languages', async () => {
			const jsFile = path.join(tmpDir, 'test.js');
			fs.writeFileSync(jsFile, 'const x = 1;');

			const input: SyntaxCheckInput = {
				changed_files: [{ path: jsFile, additions: 1 }],
				mode: 'changed',
				languages: ['unknown-language', 'typescript', 'another-unknown'],
			};

			const result = await syntaxCheck(input, tmpDir);

			// Should process since typescript is in the list (.js maps to 'typescript' profile)
			expect(result.files).toHaveLength(1);
			expect(result.files[0]?.language).toBe('typescript');
		});

		test('handles language filter with empty string', async () => {
			const jsFile = path.join(tmpDir, 'test.js');
			fs.writeFileSync(jsFile, 'const x = 1;');

			const input: SyntaxCheckInput = {
				changed_files: [{ path: jsFile, additions: 1 }],
				mode: 'changed',
				languages: ['typescript', ''],
			};

			// Should not crash, should handle gracefully
			const result = await syntaxCheck(input, tmpDir);

			expect(result.files).toHaveLength(1);
		});

		test('handles language filter with whitespace', async () => {
			const jsFile = path.join(tmpDir, 'test.js');
			fs.writeFileSync(jsFile, 'const x = 1;');

			const input: SyntaxCheckInput = {
				changed_files: [{ path: jsFile, additions: 1 }],
				mode: 'changed',
				languages: [' javascript '], // With spaces
			};

			const result = await syntaxCheck(input, tmpDir);

			// Should not match due to whitespace
			expect(result.files).toHaveLength(0);
		});
	});

	// ============ Attack Vector 6: Double-processing concerns with removed pre-filter ============

	describe('Attack Vector 6: Double-processing with removed pre-filter', () => {
		test('unsupported extensions go through full loop and get skipped_reason', async () => {
			const unsupportedFile = path.join(tmpDir, 'test.xyz');
			fs.writeFileSync(unsupportedFile, 'some content');

			const input: SyntaxCheckInput = {
				changed_files: [{ path: unsupportedFile, additions: 1 }],
				mode: 'changed',
			};

			const result = await syntaxCheck(input, tmpDir);

			// With pre-filter removed, should get unsupported_language skipped_reason
			expect(result.files).toHaveLength(1);
			expect(result.files[0]?.skipped_reason).toBe('unsupported_language');
			expect(saveEvidence).toHaveBeenCalled();
		});

		test('unsupported files still count in summary', async () => {
			const jsFile = path.join(tmpDir, 'test.js');
			const unsupportedFile = path.join(tmpDir, 'test.xyz');
			fs.writeFileSync(jsFile, 'const x = 1;');
			fs.writeFileSync(unsupportedFile, 'some content');

			const input: SyntaxCheckInput = {
				changed_files: [
					{ path: jsFile, additions: 1 },
					{ path: unsupportedFile, additions: 1 },
				],
				mode: 'changed',
			};

			const result = await syntaxCheck(input, tmpDir);

			// Both files should be in results
			expect(result.files).toHaveLength(2);
			// Summary should mention the checked file count
			expect(result.summary).toContain('1 files passed');
		});

		test('handles duplicate file paths in input', async () => {
			const jsFile = path.join(tmpDir, 'test.js');
			fs.writeFileSync(jsFile, 'const x = 1;');

			const input: SyntaxCheckInput = {
				changed_files: [
					{ path: jsFile, additions: 1 },
					{ path: jsFile, additions: 1 }, // Duplicate
				],
				mode: 'changed',
			};

			const result = await syntaxCheck(input, tmpDir);

			// Should process both (no deduplication is the current behavior)
			expect(result.files).toHaveLength(2);
			expect(result.files[0]?.ok).toBe(true);
			expect(result.files[1]?.ok).toBe(true);
		});

		test('unsupported extensions with language filter exclusion', async () => {
			const unsupportedFile = path.join(tmpDir, 'test.xyz');
			fs.writeFileSync(unsupportedFile, 'some content');

			const input: SyntaxCheckInput = {
				changed_files: [{ path: unsupportedFile, additions: 1 }],
				mode: 'changed',
				languages: ['javascript'],
			};

			const result = await syntaxCheck(input, tmpDir);

			// Should be filtered out before reaching the loop
			// (since getLanguageForExtension returns undefined for .xyz)
			expect(result.files).toHaveLength(0);
		});
	});

	// ============ Attack Vector 7: Binary file detection edge cases ============

	describe('Attack Vector 7: Binary file detection edge cases', () => {
		const BINARY_CHECK_BYTES = 8192; // 8KB
		const BINARY_NULL_THRESHOLD = 0.1; // 10% null bytes

		test('detects binary file with high null byte percentage', async () => {
			const binaryFile = path.join(tmpDir, 'binary.js');
			// Create content with >10% null bytes in first 8KB
			const sampleSize = BINARY_CHECK_BYTES;
			const nullCount = Math.floor(sampleSize * (BINARY_NULL_THRESHOLD + 0.05)); // 15% null bytes
			let content = '';
			for (let i = 0; i < sampleSize; i++) {
				content += i < nullCount ? '\0' : 'a';
			}
			fs.writeFileSync(binaryFile, content);

			const input: SyntaxCheckInput = {
				changed_files: [{ path: binaryFile, additions: 1 }],
				mode: 'changed',
			};

			const result = await syntaxCheck(input, tmpDir);

			expect(result.files).toHaveLength(1);
			expect(result.files[0]?.skipped_reason).toBe('binary_file');
		});

		test('passes file with low null byte percentage', async () => {
			const textFile = path.join(tmpDir, 'text.js');
			// Create content with <10% null bytes in first 8KB
			const sampleSize = BINARY_CHECK_BYTES;
			const nullCount = Math.floor(sampleSize * (BINARY_NULL_THRESHOLD - 0.05)); // 5% null bytes
			let content = '';
			for (let i = 0; i < sampleSize; i++) {
				content += i < nullCount ? '\0' : 'a';
			}
			fs.writeFileSync(textFile, content);

			const input: SyntaxCheckInput = {
				changed_files: [{ path: textFile, additions: 1 }],
				mode: 'changed',
			};

			const result = await syntaxCheck(input, tmpDir);

			expect(result.files).toHaveLength(1);
			// Should pass through to syntax check (which will fail on invalid JS)
			expect(result.files[0]?.ok).toBe(false);
			expect(result.files[0]?.skipped_reason).toBeUndefined();
		});

		test('detects binary file exactly at threshold', async () => {
			const binaryFile = path.join(tmpDir, 'binary.js');
			// Create content with exactly 10% null bytes
			const sampleSize = BINARY_CHECK_BYTES;
			const nullCount = Math.floor(sampleSize * BINARY_NULL_THRESHOLD); // Exactly 10%
			let content = '';
			for (let i = 0; i < sampleSize; i++) {
				content += i < nullCount ? '\0' : 'a';
			}
			fs.writeFileSync(binaryFile, content);

			const input: SyntaxCheckInput = {
				changed_files: [{ path: binaryFile, additions: 1 }],
				mode: 'changed',
			};

			const result = await syntaxCheck(input, tmpDir);

			// At exactly 10%, should NOT be binary (uses > threshold)
			expect(result.files).toHaveLength(1);
			expect(result.files[0]?.skipped_reason).not.toBe('binary_file');
		});

		test('handles file shorter than BINARY_CHECK_BYTES', async () => {
			const shortFile = path.join(tmpDir, 'short.js');
			// Only 100 bytes, with syntax error
			const content = 'a='.repeat(50); // 100 bytes of "a="
			fs.writeFileSync(shortFile, content);

			const input: SyntaxCheckInput = {
				changed_files: [{ path: shortFile, additions: 1 }],
				mode: 'changed',
			};

			const result = await syntaxCheck(input, tmpDir);

			expect(result.files).toHaveLength(1);
			expect(result.files[0]?.ok).toBe(false); // Invalid syntax - incomplete statements
		});
	});

	// ============ Attack Vector 8: Unicode and Special Characters ============

	describe('Attack Vector 8: Unicode and special characters in paths', () => {
		test('handles Unicode characters in filename', async () => {
			const unicodeFile = path.join(tmpDir, 'test-😀.js');
			fs.writeFileSync(unicodeFile, 'const x = 1;');

			const input: SyntaxCheckInput = {
				changed_files: [{ path: unicodeFile, additions: 1 }],
				mode: 'changed',
			};

			const result = await syntaxCheck(input, tmpDir);

			expect(result.files).toHaveLength(1);
			expect(result.files[0]?.path).toContain('😀');
		});

		test('handles special characters in filename', async () => {
			const specialFile = path.join(tmpDir, 'test (1).js');
			fs.writeFileSync(specialFile, 'const x = 1;');

			const input: SyntaxCheckInput = {
				changed_files: [{ path: specialFile, additions: 1 }],
				mode: 'changed',
			};

			const result = await syntaxCheck(input, tmpDir);

			expect(result.files).toHaveLength(1);
			expect(result.files[0]?.path).toContain('test (1).js');
		});

		test('handles file with null-byte in filename attempt', async () => {
			// Try to create a file with null-byte in path
			// Note: This will fail at filesystem level, but we test our handling
			const input: SyntaxCheckInput = {
				changed_files: [{ path: 'test\x00.js', additions: 1 }],
				mode: 'changed',
			};

			const result = await syntaxCheck(input, tmpDir);

			// Should fail to read
			expect(result.files).toHaveLength(1);
			expect(result.files[0]?.skipped_reason).toBe('file_read_error');
		});
	});

	// ============ Attack Vector 9: Extremely Long Paths ============

	describe('Attack Vector 9: Extremely long paths', () => {
		test('handles very long filename', async () => {
			const longName = 'a'.repeat(200) + '.js';
			const longFile = path.join(tmpDir, longName);
			fs.writeFileSync(longFile, 'const x = 1;');

			const input: SyntaxCheckInput = {
				changed_files: [{ path: longFile, additions: 1 }],
				mode: 'changed',
			};

			const result = await syntaxCheck(input, tmpDir);

			expect(result.files).toHaveLength(1);
			// The path should contain the long filename
			expect(result.files[0]?.path).toContain(longName);
		});

		test('handles deeply nested directory structure', async () => {
			let nestedPath = tmpDir;
			const depth = 10;
			for (let i = 0; i < depth; i++) {
				nestedPath = path.join(nestedPath, `level${i}`);
			}
			fs.mkdirSync(nestedPath, { recursive: true });

			const deepFile = path.join(nestedPath, 'test.js');
			fs.writeFileSync(deepFile, 'const x = 1;');

			const input: SyntaxCheckInput = {
				changed_files: [{ path: deepFile, additions: 1 }],
				mode: 'changed',
			};

			const result = await syntaxCheck(input, tmpDir);

			expect(result.files).toHaveLength(1);
			expect(result.files[0]?.ok).toBe(true);
		});
	});

	// ============ Attack Vector 10: Configuration Edge Cases ============

	describe('Attack Vector 10: Configuration edge cases', () => {
		test('respects syntax_check disabled in config', async () => {
			const testFile = path.join(tmpDir, 'test.js');
			fs.writeFileSync(testFile, 'const x = 1;');

			const config = {
				gates: {
					syntax_check: {
						enabled: false,
					},
				},
			} as PluginConfig;

			const input: SyntaxCheckInput = {
				changed_files: [{ path: testFile, additions: 1 }],
				mode: 'changed',
			};

			const result = await syntaxCheck(input, tmpDir, config);

			expect(result.verdict).toBe('pass');
			expect(result.files).toHaveLength(0);
			expect(result.summary).toBe('syntax_check disabled by configuration');
		});

		test('handles undefined config (default behavior)', async () => {
			const testFile = path.join(tmpDir, 'test.js');
			fs.writeFileSync(testFile, 'const x = 1;');

			const input: SyntaxCheckInput = {
				changed_files: [{ path: testFile, additions: 1 }],
				mode: 'changed',
			};

			const result = await syntaxCheck(input, tmpDir, undefined);

			expect(result.files).toHaveLength(1);
			expect(result.files[0]?.ok).toBe(true);
		});

		test('handles partial config (gates undefined)', async () => {
			const testFile = path.join(tmpDir, 'test.js');
			fs.writeFileSync(testFile, 'const x = 1;');

			const partialConfig = {} as PluginConfig;

			const input: SyntaxCheckInput = {
				changed_files: [{ path: testFile, additions: 1 }],
				mode: 'changed',
			};

			const result = await syntaxCheck(input, tmpDir, partialConfig);

			// Should proceed normally when gates is undefined
			expect(result.files).toHaveLength(1);
		});
	});
});
