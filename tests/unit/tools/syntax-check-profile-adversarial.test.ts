import { beforeEach, describe, expect, it, mock } from 'bun:test';
import * as realFs from 'node:fs';

import {
	type SyntaxCheckInput,
	syntaxCheck,
} from '../../../src/tools/syntax-check';

// Declare local mock variables
const mockGetProfileForFile = mock();
const mockGetLanguageForExtension = mock();
const mockGetParserForFile = mock();
const mockLoadGrammar = mock();
const mockSaveEvidence = mock();
const mockReadFileSync = mock();

// Mock modules using factory functions
mock.module('../../../src/lang/detector', () => ({
	getProfileForFile: (...args: unknown[]) => mockGetProfileForFile(...args),
}));

mock.module('../../../src/lang/registry', () => ({
	getLanguageForExtension: (...args: unknown[]) =>
		mockGetLanguageForExtension(...args),
	getParserForFile: (...args: unknown[]) => mockGetParserForFile(...args),
}));

mock.module('../../../src/lang/runtime', () => ({
	loadGrammar: (...args: unknown[]) => mockLoadGrammar(...args),
}));

mock.module('../../../src/evidence/manager', () => ({
	saveEvidence: (...args: unknown[]) => mockSaveEvidence(...args),
}));

mock.module('node:fs', () => ({
	...realFs,
	readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
}));

mock.module('node:path', () => ({
	isAbsolute: (p: string) => p.startsWith('/') || /^[A-Z]:/.test(p),
	extname: (p: string) => {
		const i = p.lastIndexOf('.');
		return i >= 0 ? p.slice(i) : '';
	},
	join: (...parts: string[]) => parts.filter(Boolean).join('/'),
}));

// Mock parser
const mockParser = {
	parse: mock(() => ({
		rootNode: {
			type: 'source_file',
			children: [],
		},
		delete: mock(),
	})),
};

describe('syntaxCheck - Profile-Driven Grammar Resolution Adversarial Tests', () => {
	beforeEach(() => {
		mock.reset();

		// Default mock behaviors
		mockGetProfileForFile.mockImplementation(() => null);
		mockGetLanguageForExtension.mockImplementation(() => null);
		mockGetParserForFile.mockImplementation(async () => null);
		mockLoadGrammar.mockImplementation(async () => null);
		mockSaveEvidence.mockImplementation(async () => undefined);
		mockReadFileSync.mockImplementation(() => 'valid code');
	});

	describe('ADVERSARIAL 1: Control character injection in filePath', () => {
		it('should handle filePath with embedded null byte gracefully', async () => {
			const input: SyntaxCheckInput = {
				changed_files: [{ path: 'foo\x00.kt', additions: 10 }],
				mode: 'changed',
			};

			// Mock returns null (no profile) → falls back to getParserForFile → null → skipped
			mockGetParserForFile.mockImplementation(async () => null);

			const result = await syntaxCheck(input, '/test/dir');

			expect(result.files).toHaveLength(1);
			expect(result.files[0].skipped_reason).toBe('unsupported_language');
			expect(result.files[0].path).toBe('foo\x00.kt');
			expect(result.verdict).toBe('pass');
		});

		it('should handle filePath with newline character', async () => {
			const input: SyntaxCheckInput = {
				changed_files: [{ path: 'foo\n.kt', additions: 10 }],
				mode: 'changed',
			};

			mockGetParserForFile.mockImplementation(async () => null);

			const result = await syntaxCheck(input, '/test/dir');

			expect(result.files).toHaveLength(1);
			expect(result.files[0].skipped_reason).toBe('unsupported_language');
			expect(result.files[0].path).toBe('foo\n.kt');
			expect(result.verdict).toBe('pass');
		});

		it('should handle filePath with multiple control characters', async () => {
			const input: SyntaxCheckInput = {
				changed_files: [{ path: 'foo\r\n\t\x00.kt', additions: 10 }],
				mode: 'changed',
			};

			mockGetParserForFile.mockImplementation(async () => null);

			const result = await syntaxCheck(input, '/test/dir');

			expect(result.files).toHaveLength(1);
			expect(result.files[0].skipped_reason).toBe('unsupported_language');
			expect(result.files[0].path).toBe('foo\r\n\t\x00.kt');
			expect(result.verdict).toBe('pass');
		});
	});

	describe('ADVERSARIAL 2: Malicious grammarId from profile (path traversal)', () => {
		it('should handle path traversal attempt in grammarId safely', async () => {
			const input: SyntaxCheckInput = {
				changed_files: [{ path: 'test.kt', additions: 10 }],
				mode: 'changed',
			};

			// Mock profile with malicious grammarId
			mockGetProfileForFile.mockImplementation({
				id: 'kotlin',
				treeSitter: {
					grammarId: '../../../etc/passwd',
				},
			});

			// Mock loadGrammar to throw for path traversal attempt
			mockLoadGrammar.mockRejectedValue(new Error('WASM not found'));

			// Should fall back to getParserForFile
			mockGetParserForFile.mockImplementation(async () => null);

			const result = await syntaxCheck(input, '/test/dir');

			expect(mockLoadGrammar).toHaveBeenCalledWith('../../../etc/passwd');
			expect(mockGetParserForFile).toHaveBeenCalled();
			expect(result.files[0].skipped_reason).toBe('unsupported_language');
			expect(result.files[0].path).toBe('test.kt');
		});

		it('should handle absolute path in grammarId safely', async () => {
			const input: SyntaxCheckInput = {
				changed_files: [{ path: 'test.ts', additions: 10 }],
				mode: 'changed',
			};

			mockGetProfileForFile.mockImplementation({
				id: 'typescript',
				treeSitter: {
					grammarId: '/etc/passwd',
				},
			});

			mockLoadGrammar.mockRejectedValue(new Error('WASM not found'));
			mockGetParserForFile.mockImplementation(async () => null);

			const result = await syntaxCheck(input, '/test/dir');

			expect(mockLoadGrammar).toHaveBeenCalledWith('/etc/passwd');
			expect(mockGetParserForFile).toHaveBeenCalled();
			expect(result.files[0].skipped_reason).toBe('unsupported_language');
		});
	});

	describe('ADVERSARIAL 3: Profile returns empty string grammarId', () => {
		it('should skip loadGrammar when grammarId is empty string', async () => {
			const input: SyntaxCheckInput = {
				changed_files: [{ path: 'test.kt', additions: 10 }],
				mode: 'changed',
			};

			// Mock profile with empty grammarId
			mockGetProfileForFile.mockImplementation({
				id: 'kotlin',
				treeSitter: {
					grammarId: '',
				},
			});

			// Should NOT call loadGrammar (falsy check)
			mockLoadGrammar.mockImplementation(async () => mockParser);
			// Should call getParserForFile as fallback
			mockGetParserForFile.mockImplementation(async () => mockParser);

			const result = await syntaxCheck(input, '/test/dir');

			// loadGrammar should NOT be called because grammarId is empty string
			expect(mockLoadGrammar).not.toHaveBeenCalled();
			// getParserForFile should be called as fallback
			expect(mockGetParserForFile).toHaveBeenCalled();
			expect(result.files[0].ok).toBe(true);
		});
	});

	describe('ADVERSARIAL 4: Profile id is empty string', () => {
		it('should fall through to langDef when profile.id is empty string', async () => {
			const input: SyntaxCheckInput = {
				changed_files: [{ path: 'test.kt', additions: 10 }],
				mode: 'changed',
			};

			mockGetProfileForFile.mockImplementation({
				id: '',
				treeSitter: {
					grammarId: 'kotlin',
				},
			});

			mockLoadGrammar.mockImplementation(async () => mockParser);
			mockGetLanguageForExtension.mockImplementation({ id: 'kotlin' });

			const result = await syntaxCheck(input, '/test/dir');

			// language should NOT be empty string - should fall through to langDef
			expect(result.files[0].language).toBe('kotlin');
			expect(result.files[0].language).not.toBe('');
			expect(result.files[0].language).not.toBe('unknown');
		});

		it('should fall through to unknown when both profile.id and langDef.id are empty', async () => {
			const input: SyntaxCheckInput = {
				changed_files: [{ path: 'test.xxx', additions: 10 }],
				mode: 'changed',
			};

			mockGetProfileForFile.mockImplementation({
				id: '',
				treeSitter: {
					grammarId: 'something',
				},
			});

			mockLoadGrammar.mockImplementation(async () => mockParser);
			mockGetLanguageForExtension.mockImplementation(null); // No langDef

			const result = await syntaxCheck(input, '/test/dir');

			// Should fall through to 'unknown'
			expect(result.files[0].language).toBe('unknown');
		});
	});

	describe('ADVERSARIAL 5: loadGrammar returns null (not throws)', () => {
		it('should trigger fallback to getParserForFile when loadGrammar returns null', async () => {
			const input: SyntaxCheckInput = {
				changed_files: [{ path: 'test.ts', additions: 10 }],
				mode: 'changed',
			};

			mockGetProfileForFile.mockImplementation({
				id: 'typescript',
				treeSitter: {
					grammarId: 'typescript',
				},
			});

			// loadGrammar returns null (not throws)
			mockLoadGrammar.mockImplementation(async () => null);

			// Should fall back to getParserForFile
			mockGetParserForFile.mockImplementation(async () => mockParser);

			const result = await syntaxCheck(input, '/test/dir');

			expect(mockLoadGrammar).toHaveBeenCalledWith('typescript');
			expect(mockGetParserForFile).toHaveBeenCalled();
			expect(result.files[0].ok).toBe(true);
		});
	});

	describe('ADVERSARIAL 6: Oversized languages array (DoS attempt)', () => {
		it('should handle large languages array without crashing', async () => {
			const input: SyntaxCheckInput = {
				changed_files: [
					{ path: 'test.kt', additions: 10 },
					{ path: 'test.ts', additions: 5 },
				],
				mode: 'changed',
				languages: Array(10000).fill('kotlin'), // 10,000 entries
			};

			mockGetProfileForFile.mockImplementation((filePath: string) => {
				if (filePath.endsWith('.kt')) {
					return { id: 'kotlin', treeSitter: { grammarId: 'kotlin' } };
				}
				return { id: 'typescript', treeSitter: { grammarId: 'typescript' } };
			});

			mockLoadGrammar.mockImplementation(async () => mockParser);

			const result = await syntaxCheck(input, '/test/dir');

			// Should complete without error - only kotlin files pass the filter
			expect(result.files).toHaveLength(1);
			// Only kotlin file should pass (typescript filtered out by language)
			expect(result.files[0].path).toBe('test.kt');
			expect(result.files[0].language).toBe('kotlin');
		});
	});

	describe('ADVERSARIAL 7: Languages array with injection strings', () => {
		it('should handle XSS/injection strings in languages array', async () => {
			const input: SyntaxCheckInput = {
				changed_files: [{ path: 'test.kt', additions: 10 }],
				mode: 'changed',
				languages: ['<script>alert(1)</script>', 'kotlin\x00', '; DROP TABLE'],
			};

			mockGetProfileForFile.mockImplementation({
				id: 'kotlin',
				treeSitter: { grammarId: 'kotlin' },
			});

			mockLoadGrammar.mockImplementation(async () => mockParser);

			const result = await syntaxCheck(input, '/test/dir');

			// Should complete without crash - but file is filtered out (kotlin not in injection strings)
			expect(result.files).toHaveLength(0);
			expect(result.summary).toBe('All 0 files passed syntax check');
		});

		it('should filter out files when no language matches injection strings', async () => {
			const input: SyntaxCheckInput = {
				changed_files: [
					{ path: 'test.kt', additions: 10 },
					{ path: 'test.ts', additions: 10 },
				],
				mode: 'changed',
				languages: ['<script>', 'kotlin\x00'],
			};

			mockGetProfileForFile.mockImplementation((filePath: string) => {
				if (filePath.endsWith('.kt')) {
					return { id: 'kotlin', treeSitter: { grammarId: 'kotlin' } };
				}
				return { id: 'typescript', treeSitter: { grammarId: 'typescript' } };
			});

			mockLoadGrammar.mockImplementation(async () => mockParser);

			const result = await syntaxCheck(input, '/test/dir');

			// No files should match the injection strings
			expect(result.files).toHaveLength(0);
			expect(result.summary).toBe('All 0 files passed syntax check');
		});
	});

	describe('ADVERSARIAL 8: Empty changed_files array', () => {
		it('should handle empty changed_files array gracefully', async () => {
			const input: SyntaxCheckInput = {
				changed_files: [],
				mode: 'changed',
			};

			const result = await syntaxCheck(input, '/test/dir');

			expect(result.files).toHaveLength(0);
			expect(result.summary).toBe('All 0 files passed syntax check');
			expect(result.verdict).toBe('pass');

			// saveEvidence should still be called
			expect(mockSaveEvidence).toHaveBeenCalledWith(
				'/test/dir',
				'syntax_check',
				expect.objectContaining({
					files_checked: 0,
					files_failed: 0,
				}),
			);
		});
	});

	describe('ADVERSARIAL 9: filePath is just an extension with no basename', () => {
		it('should handle .kt (just extension) gracefully', async () => {
			const input: SyntaxCheckInput = {
				changed_files: [{ path: '.kt', additions: 10 }],
				mode: 'changed',
			};

			// getProfileForFile should handle this
			mockGetProfileForFile.mockImplementation(null);
			mockGetParserForFile.mockImplementation(async () => null);

			const result = await syntaxCheck(input, '/test/dir');

			expect(result.files).toHaveLength(1);
			expect(result.files[0].path).toBe('.kt');
			expect(result.files[0].skipped_reason).toBe('unsupported_language');
		});

		it('should resolve correctly when profile supports just-extension paths', async () => {
			const input: SyntaxCheckInput = {
				changed_files: [{ path: '.kt', additions: 10 }],
				mode: 'changed',
			};

			// Simulate a profile that handles .kt extension
			mockGetProfileForFile.mockImplementation({
				id: 'kotlin',
				treeSitter: { grammarId: 'kotlin' },
			});

			mockLoadGrammar.mockImplementation(async () => mockParser);

			const result = await syntaxCheck(input, '/test/dir');

			expect(result.files).toHaveLength(1);
			expect(result.files[0].path).toBe('.kt');
			expect(result.files[0].language).toBe('kotlin');
			expect(result.files[0].ok).toBe(true);
		});
	});

	describe('ADVERSARIAL 10: getProfileForFile throws unexpectedly', () => {
		it('should catch and handle getProfileForFile errors gracefully', async () => {
			const input: SyntaxCheckInput = {
				changed_files: [{ path: 'test.kt', additions: 10 }],
				mode: 'changed',
			};

			// Mock getProfileForFile to throw
			mockGetProfileForFile.mockImplementation(() => {
				throw new Error('unexpected crash');
			});

			mockGetParserForFile.mockImplementation(async () => null);

			const result = await syntaxCheck(input, '/test/dir');

			// Should catch the error and set skipped_reason
			expect(result.files).toHaveLength(1);
			expect(result.files[0].skipped_reason).toBe('unexpected crash');
			expect(result.files[0].ok).toBe(false);
			expect(result.verdict).toBe('pass'); // No actual syntax errors, just skipped
		});

		it('should handle error object without message property', async () => {
			const input: SyntaxCheckInput = {
				changed_files: [{ path: 'test.ts', additions: 10 }],
				mode: 'changed',
			};

			// Mock getProfileForFile to throw non-Error
			mockGetProfileForFile.mockImplementation(() => {
				throw 'string error';
			});

			mockGetParserForFile.mockImplementation(async () => null);

			const result = await syntaxCheck(input, '/test/dir');

			expect(result.files).toHaveLength(1);
			expect(result.files[0].skipped_reason).toBe('unknown_error');
			expect(result.files[0].ok).toBe(false);
		});
	});

	describe('ADVERSARIAL: Edge case - Grammar resolution with multiple fallbacks', () => {
		it('should cascade through fallbacks: profile → loadGrammar → getParserForFile', async () => {
			const input: SyntaxCheckInput = {
				changed_files: [{ path: 'test.lang', additions: 10 }],
				mode: 'changed',
			};

			// Profile exists with grammarId
			mockGetProfileForFile.mockImplementation({
				id: 'custom',
				treeSitter: { grammarId: 'custom' },
			});

			// loadGrammar throws
			mockLoadGrammar.mockRejectedValue(new Error('not found'));

			// getParserForFile returns parser
			mockGetParserForFile.mockImplementation(async () => mockParser);

			const result = await syntaxCheck(input, '/test/dir');

			// Verify full cascade
			expect(mockGetProfileForFile).toHaveBeenCalledWith('test.lang');
			expect(mockLoadGrammar).toHaveBeenCalledWith('custom');
			expect(mockGetParserForFile).toHaveBeenCalledWith('test.lang');
			expect(result.files[0].ok).toBe(true);
			expect(result.files[0].language).toBe('custom');
		});

		it('should handle when profile.id is falsy but langDef exists', async () => {
			const input: SyntaxCheckInput = {
				changed_files: [{ path: 'test.rs', additions: 10 }],
			};

			mockGetProfileForFile.mockImplementation({
				id: null as unknown as string,
				treeSitter: { grammarId: 'rust' },
			});

			mockLoadGrammar.mockImplementation(async () => mockParser);
			mockGetLanguageForExtension.mockImplementation({ id: 'rust' });

			const result = await syntaxCheck(input, '/test/dir');

			expect(result.files[0].language).toBe('rust');
		});
	});

	describe('ADVERSARIAL: Language filter edge cases', () => {
		it('should handle language filter with case variations', async () => {
			const input: SyntaxCheckInput = {
				changed_files: [
					{ path: 'test.kt', additions: 10 },
					{ path: 'test.KT', additions: 10 },
					{ path: 'test.Kt', additions: 10 },
				],
				mode: 'changed',
				languages: ['KOTLIN', 'kotlin', 'Kotlin'],
			};

			mockGetProfileForFile.mockImplementation((_filePath: string) => ({
				id: 'kotlin',
				treeSitter: { grammarId: 'kotlin' },
			}));

			mockLoadGrammar.mockImplementation(async () => mockParser);

			const result = await syntaxCheck(input, '/test/dir');

			// All should match (case-insensitive comparison)
			expect(result.files).toHaveLength(3);
			result.files.forEach((file) => {
				expect(file.ok).toBe(true);
			});
		});

		it('should handle language filter when langId is null/undefined', async () => {
			const input: SyntaxCheckInput = {
				changed_files: [{ path: 'test.unknown', additions: 10 }],
				mode: 'changed',
				languages: ['unknown'],
			};

			mockGetProfileForFile.mockImplementation(null);
			mockGetLanguageForExtension.mockImplementation(null);

			const result = await syntaxCheck(input, '/test/dir');

			// Should be filtered out (langId is null, returns false)
			expect(result.files).toHaveLength(0);
		});
	});
});
