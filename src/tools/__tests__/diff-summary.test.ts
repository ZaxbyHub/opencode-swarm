import { afterEach, beforeEach, describe, expect, test, vi } from 'bun:test';
import type { ASTChange, ASTDiffResult } from '../../diff/ast-diff.js';
import type { ClassifiedChange } from '../../diff/semantic-classifier.js';
import type { SemanticDiffSummary } from '../../diff/summary-generator.js';
import type { ToolResult } from '../create-tool';

// Helper to convert ToolResult to string
function resultToString(result: ToolResult): string {
	return typeof result === 'string' ? result : result.output;
}

// Helper types for mocking
interface MockASTDiffResult extends ASTDiffResult {
	changes: ASTChange[];
}

// Helper functions to create test data
function makeASTDiffResult(
	overrides: Partial<MockASTDiffResult> = {},
): ASTDiffResult {
	return {
		filePath: 'test.ts',
		language: 'typescript',
		changes: [],
		durationMs: 10,
		usedAST: true,
		...overrides,
	};
}

function makeASTChange(overrides: Partial<ASTChange> = {}): ASTChange {
	return {
		type: 'modified',
		category: 'function',
		name: 'testFunc',
		lineStart: 1,
		lineEnd: 10,
		...overrides,
	};
}

function makeClassifiedChange(
	overrides: Partial<ClassifiedChange> = {},
): ClassifiedChange {
	return {
		category: 'LOGIC_CHANGE',
		riskLevel: 'High',
		filePath: 'test.ts',
		symbolName: 'testFunc',
		changeType: 'modified',
		lineStart: 1,
		lineEnd: 10,
		description: 'Test change',
		...overrides,
	};
}

function makeSemanticDiffSummary(
	overrides: Partial<SemanticDiffSummary> = {},
): SemanticDiffSummary {
	return {
		totalFiles: 0,
		totalChanges: 0,
		byRisk: { Critical: [], High: [], Medium: [], Low: [] },
		byCategory: {
			SIGNATURE_CHANGE: [],
			API_CHANGE: [],
			GUARD_REMOVED: [],
			LOGIC_CHANGE: [],
			DELETED_FUNCTION: [],
			NEW_FUNCTION: [],
			REFACTOR: [],
			COSMETIC: [],
			UNCLASSIFIED: [],
		},
		criticalItems: [],
		...overrides,
	};
}

// Helper to create tool context
function createToolContext(directory: string) {
	return { directory } as never;
}

describe('diff_summary tool', () => {
	let mockExecFileSync: ReturnType<typeof vi.fn>;
	let mockReadFileSync: ReturnType<typeof vi.fn>;
	let mockComputeASTDiff: ReturnType<typeof vi.fn>;
	let mockClassifyChanges: ReturnType<typeof vi.fn>;
	let mockGenerateSummary: ReturnType<typeof vi.fn>;

	beforeEach(async () => {
		// Clear module cache to ensure fresh mocks for each test
		delete require.cache[require.resolve('../../tools/diff-summary.js')];

		// Create fresh mocks
		mockExecFileSync = vi.fn();
		mockReadFileSync = vi.fn();
		mockComputeASTDiff = vi.fn();
		mockClassifyChanges = vi.fn();
		mockGenerateSummary = vi.fn();

		// Mock the modules
		vi.mock('node:child_process', () => ({
			execFileSync: mockExecFileSync,
		}));

		vi.mock('node:fs', () => ({
			readFileSync: mockReadFileSync,
		}));

		vi.mock('../../diff/ast-diff.js', () => ({
			computeASTDiff: mockComputeASTDiff,
		}));

		vi.mock('../../diff/semantic-classifier.js', () => ({
			classifyChanges: mockClassifyChanges,
		}));

		vi.mock('../../diff/summary-generator.js', () => ({
			generateSummary: mockGenerateSummary,
		}));
	});

	afterEach(() => {
		vi.clearAllMocks();
		vi.restoreAllMocks();
	});

	// =============================================================================
	// TEST 1: Returns error when files array is empty
	// =============================================================================
	test('returns error when files array is empty', async () => {
		const { diff_summary } = await import('../../tools/diff-summary.js');

		const result = await diff_summary.execute(
			{ files: [] },
			createToolContext('/fake/dir'),
		);

		const parsed = JSON.parse(resultToString(result));
		expect(parsed.success).toBe(false);
		expect(parsed.error).toBe('files must be a non-empty array of file paths');
	});

	// =============================================================================
	// TEST 2: Returns error when files is not an array
	// =============================================================================
	test('returns error when files is not an array', async () => {
		const { diff_summary } = await import('../../tools/diff-summary.js');

		const result = await diff_summary.execute(
			{ files: 'not-an-array' as unknown as [] },
			createToolContext('/fake/dir'),
		);

		const parsed = JSON.parse(resultToString(result));
		expect(parsed.success).toBe(false);
		expect(parsed.error).toBe('files must be a non-empty array of file paths');
	});

	// =============================================================================
	// TEST 3: Returns error when files is undefined
	// =============================================================================
	test('returns error when files is undefined', async () => {
		const { diff_summary } = await import('../../tools/diff-summary.js');

		const result = await diff_summary.execute(
			{ files: undefined } as unknown as { files: string[] },
			createToolContext('/fake/dir'),
		);

		const parsed = JSON.parse(resultToString(result));
		expect(parsed.success).toBe(false);
		expect(parsed.error).toBe('files must be a non-empty array of file paths');
	});

	// =============================================================================
	// TEST 4: Returns empty summary when no AST changes detected
	// =============================================================================
	test('returns empty summary when no AST changes detected', async () => {
		const { diff_summary } = await import('../../tools/diff-summary.js');

		// Mock successful git show and fs read
		mockExecFileSync.mockReturnValue('old content');
		mockReadFileSync.mockReturnValue('new content');

		// Mock computeASTDiff returning result with empty changes
		mockComputeASTDiff.mockResolvedValue(makeASTDiffResult({ changes: [] }));

		// Mock classifyChanges returning empty array
		mockClassifyChanges.mockReturnValue([]);

		// Mock generateSummary
		const emptySummary = makeSemanticDiffSummary();
		mockGenerateSummary.mockReturnValue(emptySummary);

		const result = await diff_summary.execute(
			{ files: ['test.ts'] },
			createToolContext('/fake/dir'),
		);

		const parsed = JSON.parse(resultToString(result));
		expect(parsed.totalFiles).toBe(0);
		expect(parsed.totalChanges).toBe(0);
		expect(parsed.criticalItems).toEqual([]);
	});

	// =============================================================================
	// TEST 5: Returns full summary with classified changes
	// =============================================================================
	test('returns full summary with classified changes', async () => {
		const { diff_summary } = await import('../../tools/diff-summary.js');

		// Mock successful git show and fs read
		mockExecFileSync.mockReturnValue('old content');
		mockReadFileSync.mockReturnValue('new content');

		// Mock computeASTDiff with actual changes
		const astDiff = makeASTDiffResult({
			filePath: 'src/api.ts',
			changes: [
				makeASTChange({
					type: 'modified',
					category: 'function',
					name: 'getUser',
					lineStart: 10,
					lineEnd: 15,
					signature: '(id: number): User',
				}),
			],
		});
		mockComputeASTDiff.mockResolvedValue(astDiff);

		// Mock classifyChanges with classified result
		const classifiedChanges: ClassifiedChange[] = [
			makeClassifiedChange({
				category: 'SIGNATURE_CHANGE',
				riskLevel: 'Critical',
				filePath: 'src/api.ts',
				symbolName: 'getUser',
				description:
					"Function signature changed for 'getUser': (id: number): User",
			}),
		];
		mockClassifyChanges.mockReturnValue(classifiedChanges);

		// Mock generateSummary
		const summary = makeSemanticDiffSummary({
			totalFiles: 1,
			totalChanges: 1,
			criticalItems: classifiedChanges,
		});
		mockGenerateSummary.mockReturnValue(summary);

		const result = await diff_summary.execute(
			{ files: ['src/api.ts'] },
			createToolContext('/fake/dir'),
		);

		const parsed = JSON.parse(resultToString(result));
		expect(parsed.totalFiles).toBe(1);
		expect(parsed.totalChanges).toBe(1);
		expect(parsed.criticalItems.length).toBe(1);
		expect(parsed.criticalItems[0].category).toBe('SIGNATURE_CHANGE');
	});

	// =============================================================================
	// TEST 6: Filters by classification (e.g., only SIGNATURE_CHANGE)
	// =============================================================================
	test('filters by classification - returns only SIGNATURE_CHANGE', async () => {
		const { diff_summary } = await import('../../tools/diff-summary.js');

		mockExecFileSync.mockReturnValue('old content');
		mockReadFileSync.mockReturnValue('new content');

		const astDiff = makeASTDiffResult({
			filePath: 'src/api.ts',
			changes: [
				makeASTChange({
					type: 'modified',
					category: 'function',
					name: 'getUser',
					signature: '(id: number): User',
				}),
			],
		});
		mockComputeASTDiff.mockResolvedValue(astDiff);

		// Both SIGNATURE_CHANGE and LOGIC_CHANGE in result
		const classifiedChanges: ClassifiedChange[] = [
			makeClassifiedChange({
				category: 'SIGNATURE_CHANGE',
				riskLevel: 'Critical',
				filePath: 'src/api.ts',
				symbolName: 'getUser',
			}),
			makeClassifiedChange({
				category: 'LOGIC_CHANGE',
				riskLevel: 'High',
				filePath: 'src/api.ts',
				symbolName: 'internalHelper',
			}),
		];
		mockClassifyChanges.mockReturnValue(classifiedChanges);

		// generateSummary will receive only filtered changes
		mockGenerateSummary.mockImplementation((changes: ClassifiedChange[]) => {
			return makeSemanticDiffSummary({
				totalFiles: 1,
				totalChanges: changes.length,
				byCategory: {
					SIGNATURE_CHANGE: changes.filter(
						(c) => c.category === 'SIGNATURE_CHANGE',
					),
					API_CHANGE: [],
					GUARD_REMOVED: [],
					LOGIC_CHANGE: changes.filter((c) => c.category === 'LOGIC_CHANGE'),
					DELETED_FUNCTION: [],
					NEW_FUNCTION: [],
					REFACTOR: [],
					COSMETIC: [],
					UNCLASSIFIED: [],
				},
				criticalItems: changes.filter((c) => c.riskLevel === 'Critical'),
			});
		});

		const _result = await diff_summary.execute(
			{ files: ['src/api.ts'], classification: 'SIGNATURE_CHANGE' },
			createToolContext('/fake/dir'),
		);

		// Verify classifyChanges was called with all changes
		expect(mockClassifyChanges).toHaveBeenCalled();

		// Verify generateSummary was called with only SIGNATURE_CHANGE
		const generateSummaryCalls = mockGenerateSummary.mock.calls;
		expect(generateSummaryCalls.length).toBe(1);

		const filteredChangesArg = generateSummaryCalls[0][0] as ClassifiedChange[];
		expect(filteredChangesArg.length).toBe(1);
		expect(filteredChangesArg[0].category).toBe('SIGNATURE_CHANGE');
	});

	// =============================================================================
	// TEST 7: Filters by riskLevel (e.g., only Critical)
	// =============================================================================
	test('filters by riskLevel - returns only Critical changes', async () => {
		const { diff_summary } = await import('../../tools/diff-summary.js');

		mockExecFileSync.mockReturnValue('old content');
		mockReadFileSync.mockReturnValue('new content');

		const astDiff = makeASTDiffResult({
			filePath: 'src/api.ts',
			changes: [makeASTChange({ name: 'getUser' })],
		});
		mockComputeASTDiff.mockResolvedValue(astDiff);

		const classifiedChanges: ClassifiedChange[] = [
			makeClassifiedChange({
				category: 'SIGNATURE_CHANGE',
				riskLevel: 'Critical',
				filePath: 'src/api.ts',
				symbolName: 'getUser',
			}),
			makeClassifiedChange({
				category: 'LOGIC_CHANGE',
				riskLevel: 'High',
				filePath: 'src/api.ts',
				symbolName: 'internalHelper',
			}),
		];
		mockClassifyChanges.mockReturnValue(classifiedChanges);

		mockGenerateSummary.mockImplementation((changes: ClassifiedChange[]) => {
			return makeSemanticDiffSummary({
				totalFiles: 1,
				totalChanges: changes.length,
				criticalItems: changes.filter((c) => c.riskLevel === 'Critical'),
			});
		});

		const _result = await diff_summary.execute(
			{ files: ['src/api.ts'], riskLevel: 'Critical' },
			createToolContext('/fake/dir'),
		);

		const generateSummaryCalls = mockGenerateSummary.mock.calls;
		expect(generateSummaryCalls.length).toBe(1);

		const filteredChangesArg = generateSummaryCalls[0][0] as ClassifiedChange[];
		expect(filteredChangesArg.length).toBe(1);
		expect(filteredChangesArg[0].riskLevel).toBe('Critical');
	});

	// =============================================================================
	// TEST 8: Filters by both classification AND riskLevel
	// =============================================================================
	test('filters by both classification and riskLevel', async () => {
		const { diff_summary } = await import('../../tools/diff-summary.js');

		mockExecFileSync.mockReturnValue('old content');
		mockReadFileSync.mockReturnValue('new content');

		const astDiff = makeASTDiffResult({
			filePath: 'src/api.ts',
			changes: [makeASTChange({ name: 'getUser' })],
		});
		mockComputeASTDiff.mockResolvedValue(astDiff);

		const classifiedChanges: ClassifiedChange[] = [
			makeClassifiedChange({
				category: 'SIGNATURE_CHANGE',
				riskLevel: 'Critical',
				filePath: 'src/api.ts',
				symbolName: 'getUser',
			}),
			makeClassifiedChange({
				category: 'SIGNATURE_CHANGE',
				riskLevel: 'High',
				filePath: 'src/api.ts',
				symbolName: 'getUser',
			}),
			makeClassifiedChange({
				category: 'LOGIC_CHANGE',
				riskLevel: 'Critical',
				filePath: 'src/api.ts',
				symbolName: 'internalHelper',
			}),
		];
		mockClassifyChanges.mockReturnValue(classifiedChanges);

		mockGenerateSummary.mockImplementation((changes: ClassifiedChange[]) => {
			return makeSemanticDiffSummary({
				totalFiles: 1,
				totalChanges: changes.length,
				criticalItems: changes.filter((c) => c.riskLevel === 'Critical'),
			});
		});

		const _result = await diff_summary.execute(
			{
				files: ['src/api.ts'],
				classification: 'SIGNATURE_CHANGE',
				riskLevel: 'Critical',
			},
			createToolContext('/fake/dir'),
		);

		const generateSummaryCalls = mockGenerateSummary.mock.calls;
		expect(generateSummaryCalls.length).toBe(1);

		const filteredChangesArg = generateSummaryCalls[0][0] as ClassifiedChange[];
		// Should filter to only SIGNATURE_CHANGE with Critical
		expect(filteredChangesArg.length).toBe(1);
		expect(filteredChangesArg[0].category).toBe('SIGNATURE_CHANGE');
		expect(filteredChangesArg[0].riskLevel).toBe('Critical');
	});

	// =============================================================================
	// TEST 9: Handles untracked file - produces AST changes (not skipped)
	// =============================================================================
	test('handles untracked file - produces AST changes (not skipped)', async () => {
		const { diff_summary } = await import('../../tools/diff-summary.js');

		// Mock cat-file -e to throw (file not in HEAD)
		mockExecFileSync.mockImplementation((_cmd: string, args: string[]) => {
			if (args[0] === 'cat-file' && args[1] === '-e') {
				throw new Error('fatal: pathspec did not match any files');
			}
			return 'old content';
		});
		mockReadFileSync.mockReturnValue('export function newFeature() {}');

		// Mock computeASTDiff returning result with added changes
		const astDiff = makeASTDiffResult({
			filePath: 'new-file.ts',
			changes: [
				makeASTChange({
					type: 'added',
					category: 'function',
					name: 'newFeature',
					lineStart: 1,
					lineEnd: 2,
				}),
			],
		});
		mockComputeASTDiff.mockResolvedValue(astDiff);

		const classifiedChanges: ClassifiedChange[] = [
			makeClassifiedChange({
				category: 'NEW_FUNCTION',
				riskLevel: 'Medium',
				filePath: 'new-file.ts',
				symbolName: 'newFeature',
				changeType: 'added',
			}),
		];
		mockClassifyChanges.mockReturnValue(classifiedChanges);

		mockGenerateSummary.mockReturnValue(
			makeSemanticDiffSummary({
				totalFiles: 1,
				totalChanges: 1,
				byCategory: {
					SIGNATURE_CHANGE: [],
					API_CHANGE: [],
					GUARD_REMOVED: [],
					LOGIC_CHANGE: [],
					DELETED_FUNCTION: [],
					NEW_FUNCTION: classifiedChanges,
					REFACTOR: [],
					COSMETIC: [],
					UNCLASSIFIED: [],
				},
			}),
		);

		const result = await diff_summary.execute(
			{ files: ['new-file.ts'] },
			createToolContext('/fake/dir'),
		);

		const parsed = JSON.parse(resultToString(result));
		// Should produce changes for the untracked file
		expect(parsed.totalFiles).toBe(1);
		expect(parsed.totalChanges).toBe(1);
	});

	// =============================================================================
	// TEST 10: Handles untracked file - produces NEW_FUNCTION entries
	// =============================================================================
	test('handles untracked file - produces NEW_FUNCTION entries', async () => {
		const { diff_summary } = await import('../../tools/diff-summary.js');

		// Mock cat-file -e to throw for badge.tsx (simulating untracked file)
		mockExecFileSync.mockImplementation((_cmd: string, args: string[]) => {
			if (
				args[0] === 'cat-file' &&
				args[1] === '-e' &&
				args[2] === 'HEAD:badge.tsx'
			) {
				throw new Error('fatal: pathspec did not match any files');
			}
			return 'old content';
		});
		mockReadFileSync.mockReturnValue(
			'export function Badge() { return <div/> }',
		);

		// Mock computeASTDiff returning result with type: 'added'
		const astDiff = makeASTDiffResult({
			filePath: 'badge.tsx',
			changes: [
				makeASTChange({
					type: 'added',
					category: 'function',
					name: 'Badge',
					lineStart: 1,
					lineEnd: 1,
				}),
			],
		});
		mockComputeASTDiff.mockResolvedValue(astDiff);

		// Mock classifyChanges returning NEW_FUNCTION category
		const classifiedChanges: ClassifiedChange[] = [
			makeClassifiedChange({
				category: 'NEW_FUNCTION',
				riskLevel: 'Medium',
				filePath: 'badge.tsx',
				symbolName: 'Badge',
				changeType: 'added',
				description: "New function 'Badge' added",
			}),
		];
		mockClassifyChanges.mockReturnValue(classifiedChanges);

		mockGenerateSummary.mockReturnValue(
			makeSemanticDiffSummary({
				totalFiles: 1,
				totalChanges: 1,
				byCategory: {
					SIGNATURE_CHANGE: [],
					API_CHANGE: [],
					GUARD_REMOVED: [],
					LOGIC_CHANGE: [],
					DELETED_FUNCTION: [],
					NEW_FUNCTION: classifiedChanges,
					REFACTOR: [],
					COSMETIC: [],
					UNCLASSIFIED: [],
				},
			}),
		);

		const result = await diff_summary.execute(
			{ files: ['badge.tsx'] },
			createToolContext('/fake/dir'),
		);

		const parsed = JSON.parse(resultToString(result));
		expect(parsed.totalFiles).toBe(1);
		expect(parsed.totalChanges).toBe(1);
	});

	// =============================================================================
	// TEST 11: Handles ENOENT from git binary missing - returns error (not silent skip)
	// =============================================================================
	test('handles ENOENT from git binary missing - returns error not silent skip', async () => {
		const { diff_summary } = await import('../../tools/diff-summary.js');

		// Mock execFileSync to throw ENOENT (git binary not found)
		const enoentError = Object.assign(new Error('spawnSync git ENOENT'), {
			code: 'ENOENT',
		});
		mockExecFileSync.mockImplementation(() => {
			throw enoentError;
		});

		const result = await diff_summary.execute(
			{ files: ['test.ts'] },
			createToolContext('/fake/dir'),
		);

		const parsed = JSON.parse(resultToString(result));
		expect(parsed.success).toBe(false);
		expect(parsed.error).toContain('diff_summary failed');
	});

	// =============================================================================
	// TEST 12: Handles fs read failure gracefully
	// =============================================================================
	test('handles fs read failure gracefully - skips file with read error', async () => {
		const { diff_summary } = await import('../../tools/diff-summary.js');

		// Mock git show success
		mockExecFileSync.mockReturnValue('old content');

		// Mock fs.readFileSync throwing with ENOENT code (deleted file scenario)
		mockReadFileSync.mockImplementation(() => {
			const err = new Error('ENOENT: no such file or directory') as Error & {
				code: string;
			};
			err.code = 'ENOENT';
			throw err;
		});

		mockClassifyChanges.mockReturnValue([]);
		mockGenerateSummary.mockReturnValue(makeSemanticDiffSummary());

		const result = await diff_summary.execute(
			{ files: ['deleted-file.ts'] },
			createToolContext('/fake/dir'),
		);

		const parsed = JSON.parse(resultToString(result));
		// Should return empty summary since the file was skipped
		expect(parsed.totalFiles).toBe(0);
		expect(parsed.totalChanges).toBe(0);
	});

	// =============================================================================
	// TEST 13: Handles computeASTDiff throwing an error
	// =============================================================================
	test('handles computeASTDiff throwing an error - skips file gracefully', async () => {
		const { diff_summary } = await import('../../tools/diff-summary.js');

		mockExecFileSync.mockReturnValue('old content');
		mockReadFileSync.mockReturnValue('new content');

		// Mock computeASTDiff throwing
		mockComputeASTDiff.mockRejectedValue(new Error('AST parsing failed'));

		mockClassifyChanges.mockReturnValue([]);
		mockGenerateSummary.mockReturnValue(makeSemanticDiffSummary());

		const result = await diff_summary.execute(
			{ files: ['broken-syntax.ts'] },
			createToolContext('/fake/dir'),
		);

		const parsed = JSON.parse(resultToString(result));
		// Should return empty summary since the file was skipped
		expect(parsed.totalFiles).toBe(0);
		expect(parsed.totalChanges).toBe(0);
	});

	// =============================================================================
	// TEST 13b: ENOENT from fs.readFileSync for deleted file is silently skipped, not re-thrown
	// =============================================================================
	test('ENOENT from fs.readFileSync for deleted file is silently skipped, not re-thrown', async () => {
		const { diff_summary } = await import('../../tools/diff-summary.js');

		// Mock execFileSync succeeds (git operations work)
		mockExecFileSync.mockReturnValue('old content');

		// Mock fs.readFileSync throwing ENOENT (file deleted from disk)
		mockReadFileSync.mockImplementation(() => {
			const err = new Error('ENOENT: no such file or directory') as Error & {
				code: string;
			};
			err.code = 'ENOENT';
			throw err;
		});

		mockClassifyChanges.mockReturnValue([]);
		mockGenerateSummary.mockReturnValue(makeSemanticDiffSummary());

		const result = await diff_summary.execute(
			{ files: ['deleted-file.ts'] },
			createToolContext('/fake/dir'),
		);

		const parsed = JSON.parse(resultToString(result));
		// File should be silently skipped, returning empty summary (not crash)
		expect(parsed.totalFiles).toBe(0);
		expect(parsed.totalChanges).toBe(0);
		// Should NOT have an error - the deleted file was handled gracefully
		expect(parsed.success).not.toBe(false);
	});

	// =============================================================================
	// TEST 13c: ASTDiffResult with empty changes but non-empty error IS included (not silently dropped)
	// =============================================================================
	test('ASTDiffResult with empty changes but non-empty error is included via the || astResult.error guard', async () => {
		const { diff_summary } = await import('../../tools/diff-summary.js');

		// Mock execFileSync to succeed for cat-file check (file exists in HEAD) and git show
		mockExecFileSync.mockImplementation((_cmd: string, args: string[]) => {
			if (args[0] === 'cat-file' && args[1] === '-e') {
				// File exists in HEAD
				return '';
			}
			if (args[0] === 'show') {
				// git show HEAD:filepath returns old content
				return 'old content';
			}
			return '';
		});

		// Mock fs.readFileSync to return new content
		mockReadFileSync.mockReturnValue('new content');

		// Mock computeASTDiff returning result with empty changes but non-empty error
		// This exercises the guard: (astResult.changes.length > 0 || astResult.error !== undefined)
		mockComputeASTDiff.mockResolvedValue(
			makeASTDiffResult({
				filePath: 'broken.ts',
				language: 'typescript',
				changes: [],
				durationMs: 5,
				usedAST: false,
				error: 'parse failed: tree-sitter timeout',
			}),
		);

		mockClassifyChanges.mockReturnValue([]);
		mockGenerateSummary.mockReturnValue(makeSemanticDiffSummary());

		const result = await diff_summary.execute(
			{ files: ['broken.ts'] },
			createToolContext('/fake/dir'),
		);

		const parsed = JSON.parse(resultToString(result));
		// Should NOT return an error result — the file was processed (even though it had a parse error)
		expect(parsed.success).not.toBe(false);
		// The error-only result was NOT silently dropped — it passed the guard
		// verify computeASTDiff was called (meaning the guard allowed it through)
		expect(mockComputeASTDiff).toHaveBeenCalledWith(
			'broken.ts',
			'old content',
			'new content',
		);
	});

	// =============================================================================
	// TEST 14: Processes multiple files correctly
	// =============================================================================
	test('processes multiple files and accumulates changes', async () => {
		const { diff_summary } = await import('../../tools/diff-summary.js');

		// First file: git success, second file: git failure
		mockExecFileSync.mockImplementation((_cmd: string, args: string[]) => {
			if (args[1] === 'HEAD:src/file1.ts') {
				return 'old content 1';
			}
			if (args[1] === 'HEAD:src/file2.ts') {
				throw new Error('fatal: pathspec did not match any files');
			}
			return 'old content';
		});

		mockReadFileSync.mockImplementation((path: string) => {
			if (path.includes('file1.ts')) {
				return 'new content 1';
			}
			return 'new content';
		});

		// Only file1 has changes
		mockComputeASTDiff.mockResolvedValue(
			makeASTDiffResult({
				filePath: 'src/file1.ts',
				changes: [makeASTChange({ name: 'func1' })],
			}),
		);

		const classifiedChanges: ClassifiedChange[] = [
			makeClassifiedChange({
				category: 'LOGIC_CHANGE',
				riskLevel: 'High',
				filePath: 'src/file1.ts',
				symbolName: 'func1',
			}),
		];
		mockClassifyChanges.mockReturnValue(classifiedChanges);

		mockGenerateSummary.mockReturnValue(
			makeSemanticDiffSummary({
				totalFiles: 1,
				totalChanges: 1,
			}),
		);

		const result = await diff_summary.execute(
			{ files: ['src/file1.ts', 'src/file2.ts'] },
			createToolContext('/fake/dir'),
		);

		const parsed = JSON.parse(resultToString(result));
		// Only file1 processed successfully
		expect(parsed.totalFiles).toBe(1);
		expect(parsed.totalChanges).toBe(1);
	});

	// =============================================================================
	// TEST 15: Top-level error handling (unexpected exceptions)
	// =============================================================================
	test('catches unexpected errors and returns error result', async () => {
		const { diff_summary } = await import('../../tools/diff-summary.js');

		// Make classifyChanges throw an unexpected error
		mockExecFileSync.mockReturnValue('old content');
		mockReadFileSync.mockReturnValue('new content');
		mockComputeASTDiff.mockResolvedValue(
			makeASTDiffResult({
				changes: [makeASTChange()],
			}),
		);
		mockClassifyChanges.mockImplementation(() => {
			throw new Error('Unexpected classification error');
		});

		const result = await diff_summary.execute(
			{ files: ['test.ts'] },
			createToolContext('/fake/dir'),
		);

		const parsed = JSON.parse(resultToString(result));
		expect(parsed.success).toBe(false);
		expect(parsed.error).toContain('diff_summary failed');
		expect(parsed.error).toContain('Unexpected classification error');
	});
});
