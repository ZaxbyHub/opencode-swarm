import { beforeEach, describe, expect, it, mock } from 'bun:test';
import * as realFs from 'node:fs';
import type { PluginConfig } from '../../../src/config';
import { syntaxCheck } from '../../../src/tools/syntax-check';

// Mock fs to avoid actual file system access
mock.module('node:fs', () => ({
	...realFs,
	readFileSync: mock(() => 'valid code content'),
}));

// Mock path to keep paths consistent
mock.module('path', () => ({
	isAbsolute: mock((p: string) => p.startsWith('/') || p.match(/^[A-Z]:/)),
	extname: mock((p: string) => {
		const lastDot = p.lastIndexOf('.');
		return lastDot >= 0 ? p.slice(lastDot) : '';
	}),
	join: mock((...parts: string[]) => parts.join('/')),
}));

// Mock detector
const mockGetProfileForFile = mock();
mock.module('../../../src/lang/detector', () => ({
	getProfileForFile: (...args: unknown[]) => mockGetProfileForFile(...args),
}));

// Mock registry
const mockGetLanguageForExtension = mock();
const mockGetParserForFile = mock();
mock.module('../../../src/lang/registry', () => ({
	getLanguageForExtension: (...args: unknown[]) =>
		mockGetLanguageForExtension(...args),
	getParserForFile: (...args: unknown[]) => mockGetParserForFile(...args),
}));

// Mock runtime
const mockLoadGrammar = mock();
mock.module('../../../src/lang/runtime', () => ({
	loadGrammar: (...args: unknown[]) => mockLoadGrammar(...args),
}));

// Mock evidence manager
mock.module('../../../src/evidence/manager', () => ({
	saveEvidence: mock(async () => {}),
}));

// Fake parser helper - creates a parser with no errors
function createFakeParser(language: string = 'test') {
	return {
		parse: () => ({
			rootNode: {
				type: 'program',
				children: [],
				startPosition: { row: 0, column: 0 },
			},
			delete: mock(),
		}),
		language,
	};
}

// Fake parser helper - creates a parser with syntax errors
function createErrorParser() {
	return {
		parse: () => ({
			rootNode: {
				type: 'program',
				children: [
					{
						type: 'ERROR',
						startPosition: { row: 5, column: 10 },
						children: [],
					},
				],
				startPosition: { row: 0, column: 0 },
			},
			delete: mock(),
		}),
	};
}

describe('syntaxCheck - Profile-Driven Grammar Resolution (Task 2.5)', () => {
	beforeEach(() => {
		mock.reset();
		mockGetProfileForFile.mockReset();
		mockGetLanguageForExtension.mockReset();
		mockGetParserForFile.mockReset();
		mockLoadGrammar.mockReset();
	});

	it('1. Profile grammar resolution used when profile has treeSitter.grammarId', async () => {
		// Arrange
		const fakeParser = createFakeParser('kotlin');
		mockGetProfileForFile.mockImplementation((filePath: string) => ({
			id: 'kotlin',
			treeSitter: { grammarId: 'kotlin' },
		}));
		mockLoadGrammar.mockResolvedValue(fakeParser);

		const input = {
			changed_files: [{ path: 'test.kt', additions: 10 }],
		};

		// Act
		const result = await syntaxCheck(input, '/mock/dir');

		// Assert
		expect(mockLoadGrammar).toHaveBeenCalledWith('kotlin');
		expect(mockGetParserForFile).not.toHaveBeenCalled();
		expect(result.files[0].language).toBe('kotlin');
		expect(result.files[0].ok).toBe(true);
		expect(result.files[0].skipped_reason).toBeUndefined();
	});

	it('2. Fallback to registry when profile has no treeSitter field', async () => {
		// Arrange
		const fakeParser = createFakeParser('ruby');
		mockGetProfileForFile.mockReturnValue({
			id: 'ruby',
			treeSitter: undefined,
		});
		mockGetParserForFile.mockResolvedValue(fakeParser);

		const input = {
			changed_files: [{ path: 'test.rb', additions: 10 }],
		};

		// Act
		const result = await syntaxCheck(input, '/mock/dir');

		// Assert
		expect(mockLoadGrammar).not.toHaveBeenCalled();
		expect(mockGetParserForFile).toHaveBeenCalledWith('test.rb');
		expect(result.files[0].language).toBe('ruby');
		expect(result.files[0].ok).toBe(true);
	});

	it('3. Fallback to registry when loadGrammar throws', async () => {
		// Arrange
		const fakeParser = createFakeParser('swift');
		mockGetProfileForFile.mockReturnValue({
			id: 'swift',
			treeSitter: { grammarId: 'swift' },
		});
		mockLoadGrammar.mockRejectedValue(new Error('WASM not found'));
		mockGetParserForFile.mockResolvedValue(fakeParser);

		const input = {
			changed_files: [{ path: 'test.swift', additions: 10 }],
		};

		// Act
		const result = await syntaxCheck(input, '/mock/dir');

		// Assert
		expect(mockLoadGrammar).toHaveBeenCalledWith('swift');
		expect(mockGetParserForFile).toHaveBeenCalledWith('test.swift');
		expect(result.files[0].ok).toBe(true);
		expect(result.files[0].skipped_reason).toBeUndefined();
	});

	it('4. Fallback to registry when getProfileForFile returns undefined', async () => {
		// Arrange
		const fakeParser = createFakeParser('legacy-lang');
		mockGetProfileForFile.mockReturnValue(undefined);
		mockGetLanguageForExtension.mockReturnValue({ id: 'legacy-lang' });
		mockGetParserForFile.mockResolvedValue(fakeParser);

		const input = {
			changed_files: [{ path: 'test.legacy', additions: 10 }],
		};

		// Act
		const result = await syntaxCheck(input, '/mock/dir');

		// Assert
		expect(mockLoadGrammar).not.toHaveBeenCalled();
		expect(mockGetParserForFile).toHaveBeenCalledWith('test.legacy');
		expect(result.files[0].language).toBe('legacy-lang');
		expect(result.files[0].ok).toBe(true);
	});

	it('5. File skipped when both profile and registry return null', async () => {
		// Arrange
		mockGetProfileForFile.mockReturnValue(undefined);
		mockGetLanguageForExtension.mockReturnValue(undefined);
		mockGetParserForFile.mockResolvedValue(null);

		const input = {
			changed_files: [{ path: 'test.unknown', additions: 10 }],
		};

		// Act
		const result = await syntaxCheck(input, '/mock/dir');

		// Assert
		expect(mockLoadGrammar).not.toHaveBeenCalled();
		expect(mockGetParserForFile).toHaveBeenCalledWith('test.unknown');
		expect(result.files[0].skipped_reason).toBe('unsupported_language');
	});

	it('6. Language filter: profile-based language ID matched correctly', async () => {
		// Arrange
		const fakeParser = createFakeParser('kotlin');
		mockGetProfileForFile.mockImplementation((filePath: string) => {
			if (filePath.endsWith('.kt')) {
				return { id: 'kotlin', treeSitter: { grammarId: 'kotlin' } };
			}
			return undefined;
		});
		mockGetLanguageForExtension.mockReturnValue(undefined); // No registry entry for .kt
		mockLoadGrammar.mockResolvedValue(fakeParser);

		const input = {
			changed_files: [
				{ path: 'test.kt', additions: 10 },
				{ path: 'test.js', additions: 5 },
			],
			languages: ['kotlin'],
		};

		// Act
		const result = await syntaxCheck(input, '/mock/dir');

		// Assert
		// Only .kt file should be checked (matches kotlin language filter)
		expect(result.files).toHaveLength(1);
		expect(result.files[0].path).toBe('test.kt');
		expect(result.files[0].language).toBe('kotlin');
	});

	it('7. Language filter: profile id preferred over registry id when both exist', async () => {
		// Arrange
		const fakeParser = createFakeParser('typescript');
		mockGetProfileForFile.mockReturnValue({
			id: 'typescript',
			treeSitter: { grammarId: 'typescript' },
		});
		mockGetLanguageForExtension.mockReturnValue({ id: 'ts' }); // Legacy 'ts' id
		mockLoadGrammar.mockResolvedValue(fakeParser);

		const input = {
			changed_files: [{ path: 'test.ts', additions: 10 }],
			languages: ['typescript'],
		};

		// Act
		const result = await syntaxCheck(input, '/mock/dir');

		// Assert
		// File should be included because profile.id='typescript' matches filter
		expect(result.files).toHaveLength(1);
		expect(result.files[0].language).toBe('typescript'); // profile.id used, not legacy 'ts'
	});

	it('Language filter: excludes files when profile.id does not match', async () => {
		// Arrange
		const fakeParser = createFakeParser('python');
		mockGetProfileForFile.mockImplementation((filePath: string) => {
			if (filePath.endsWith('.kt')) {
				return { id: 'kotlin', treeSitter: { grammarId: 'kotlin' } };
			}
			if (filePath.endsWith('.py')) {
				return { id: 'python', treeSitter: { grammarId: 'python' } };
			}
			return undefined;
		});
		mockLoadGrammar.mockResolvedValue(fakeParser);

		const input = {
			changed_files: [
				{ path: 'test.kt', additions: 10 },
				{ path: 'test.py', additions: 5 },
			],
			languages: ['python'],
		};

		// Act
		const result = await syntaxCheck(input, '/mock/dir');

		// Assert
		expect(result.files).toHaveLength(1);
		expect(result.files[0].path).toBe('test.py');
		expect(result.files[0].language).toBe('python');
	});

	it('result.language prefers profile.id over langDef.id when both exist', async () => {
		// Arrange
		const fakeParser = createFakeParser('typescript');
		mockGetProfileForFile.mockReturnValue({
			id: 'typescript',
			treeSitter: { grammarId: 'typescript' },
		});
		mockGetLanguageForExtension.mockReturnValue({ id: 'ts' });
		mockLoadGrammar.mockResolvedValue(fakeParser);

		const input = {
			changed_files: [{ path: 'test.ts', additions: 10 }],
		};

		// Act
		const result = await syntaxCheck(input, '/mock/dir');

		// Assert
		expect(result.files[0].language).toBe('typescript'); // profile.id preferred
		expect(result.files[0].language).not.toBe('ts'); // not legacy langDef.id
	});

	it('Syntax errors are correctly extracted when parser finds errors', async () => {
		// Arrange
		const errorParser = createErrorParser();
		mockGetProfileForFile.mockReturnValue({
			id: 'javascript',
			treeSitter: { grammarId: 'javascript' },
		});
		mockLoadGrammar.mockResolvedValue(errorParser);

		const input = {
			changed_files: [{ path: 'test.js', additions: 10 }],
		};

		// Act
		const result = await syntaxCheck(input, '/mock/dir');

		// Assert
		expect(result.files[0].ok).toBe(false);
		expect(result.files[0].errors).toHaveLength(1);
		expect(result.files[0].errors[0].line).toBe(6); // 1-indexed (row 5 + 1)
		expect(result.files[0].errors[0].column).toBe(10);
		expect(result.files[0].errors[0].message).toBe('Syntax error');
	});

	it('Feature flag: returns pass with summary when syntax_check is disabled', async () => {
		// Arrange
		const config: PluginConfig = {
			max_iterations: 5,
			qa_retry_limit: 3,
			inject_phase_reminders: true,
			gates: {
				syntax_check: { enabled: false },
				placeholder_scan: {
					enabled: true,
					deny_patterns: [],
					allow_globs: [],
					max_allowed_findings: 0,
				},
				sast_scan: { enabled: true },
				sbom_generate: { enabled: true },
				build_check: { enabled: true },
				quality_budget: {
					enabled: true,
					max_complexity_delta: 5,
					max_public_api_delta: 10,
					max_duplication_ratio: 0.05,
					min_test_to_code_ratio: 0.3,
					enforce_on_globs: ['src/**'],
					exclude_globs: ['docs/**', 'tests/**'],
				},
			},
		};

		const input = {
			changed_files: [{ path: 'test.ts', additions: 10 }],
		};

		// Act
		const result = await syntaxCheck(input, '/mock/dir', config);

		// Assert
		expect(result.verdict).toBe('pass');
		expect(result.files).toHaveLength(0);
		expect(result.summary).toBe('syntax_check disabled by configuration');
		expect(mockGetProfileForFile).not.toHaveBeenCalled();
	});

	it('Mode "changed" filters out files with 0 additions', async () => {
		// Arrange
		const fakeParser = createFakeParser('typescript');
		mockGetProfileForFile.mockReturnValue({
			id: 'typescript',
			treeSitter: { grammarId: 'typescript' },
		});
		mockLoadGrammar.mockResolvedValue(fakeParser);

		const input = {
			changed_files: [
				{ path: 'changed.ts', additions: 10 },
				{ path: 'unchanged.ts', additions: 0 },
			],
			mode: 'changed' as const,
		};

		// Act
		const result = await syntaxCheck(input, '/mock/dir');

		// Assert
		expect(result.files).toHaveLength(1);
		expect(result.files[0].path).toBe('changed.ts');
	});

	it('Mode "all" includes files regardless of additions', async () => {
		// Arrange
		const fakeParser = createFakeParser('typescript');
		mockGetProfileForFile.mockReturnValue({
			id: 'typescript',
			treeSitter: { grammarId: 'typescript' },
		});
		mockLoadGrammar.mockResolvedValue(fakeParser);

		const input = {
			changed_files: [
				{ path: 'changed.ts', additions: 10 },
				{ path: 'unchanged.ts', additions: 0 },
			],
			mode: 'all' as const,
		};

		// Act
		const result = await syntaxCheck(input, '/mock/dir');

		// Assert
		expect(result.files).toHaveLength(2);
	});
});
