import { afterEach, beforeEach, describe, expect, test, vi } from 'bun:test';
import * as realChildProcess from 'node:child_process';
import * as realFs from 'node:fs';
import * as path from 'node:path';
import type { ASTDiffResult } from '../../diff/ast-diff.js';
import type { ClassifiedChange } from '../../diff/semantic-classifier.js';
import type { SemanticDiffSummary } from '../../diff/summary-generator.js';
import * as realRepoGraph from '../../tools/repo-graph.js';

// Top-level mock function references (same pattern as diff-summary.test.ts)
let mockExecFileSync: ReturnType<typeof vi.fn>;
let mockReadFileSync: ReturnType<typeof vi.fn>;
let mockRealpathSync: ReturnType<typeof vi.fn>;
let mockComputeASTDiff: ReturnType<typeof vi.fn>;
let mockClassifyChanges: ReturnType<typeof vi.fn>;
let mockGenerateSummary: ReturnType<typeof vi.fn>;
let mockGenerateSummaryMarkdown: ReturnType<typeof vi.fn>;
let mockGetCachedGraph: ReturnType<typeof vi.fn>;
let mockGetImporters: ReturnType<typeof vi.fn>;

describe('buildSemanticDiffBlock', () => {
	beforeEach(async () => {
		// Clear module cache so fresh mocks are used
		delete require.cache[require.resolve('../semantic-diff-injection.js')];

		// Create fresh mock functions
		mockExecFileSync = vi.fn();
		mockReadFileSync = vi.fn();
		mockRealpathSync = vi.fn((p: string) => p);
		mockComputeASTDiff = vi.fn();
		mockClassifyChanges = vi.fn();
		mockGenerateSummary = vi.fn();
		mockGenerateSummaryMarkdown = vi.fn();
		mockGetCachedGraph = vi.fn();
		mockGetImporters = vi.fn();

		// Mock the modules
		vi.mock('node:child_process', () => ({
			...realChildProcess,
			execFileSync: mockExecFileSync,
			execFile: (
				command: string,
				args: string[],
				options: unknown,
				callback: (error: Error | null, stdout: string, stderr: string) => void,
			) => {
				try {
					const stdout = mockExecFileSync(command, args, options);
					callback(null, stdout ?? '', '');
				} catch (error) {
					callback(error as Error, '', '');
				}
			},
		}));

		vi.mock('node:fs', () => ({
			...realFs,
			readFileSync: mockReadFileSync,
			realpathSync: mockRealpathSync,
			promises: {
				readFile: (filePath: string, encoding: BufferEncoding) => {
					try {
						return Promise.resolve(mockReadFileSync(filePath, encoding));
					} catch (error) {
						return Promise.reject(error);
					}
				},
			},
		}));

		vi.mock('../../diff/ast-diff.js', () => ({
			computeASTDiff: mockComputeASTDiff,
		}));

		vi.mock('../../diff/semantic-classifier.js', () => ({
			classifyChanges: mockClassifyChanges,
		}));

		vi.mock('../../diff/summary-generator.js', () => ({
			generateSummary: mockGenerateSummary,
			generateSummaryMarkdown: mockGenerateSummaryMarkdown,
		}));

		vi.mock('../repo-graph-injection.js', () => ({
			getCachedGraph: mockGetCachedGraph,
		}));

		vi.mock('../../tools/repo-graph.js', () => ({
			...realRepoGraph,
			getImporters: mockGetImporters,
		}));
	});

	afterEach(() => {
		vi.clearAllMocks();
		vi.restoreAllMocks();
	});

	test('returns null when changedFiles is empty', async () => {
		const { buildSemanticDiffBlock } = await import(
			'../semantic-diff-injection.js'
		);
		const result = await buildSemanticDiffBlock('/test/dir', []);
		expect(result).toBeNull();
	});

	test('returns null when all files fail to diff', async () => {
		const { buildSemanticDiffBlock } = await import(
			'../semantic-diff-injection.js'
		);

		// Simulate parse failure (non-ENOENT error) — git cat-file succeeds
		// but computeASTDiff fails with a non-ENOENT error
		mockExecFileSync.mockReturnValue('old content');
		mockReadFileSync.mockReturnValue('new content');
		mockGetCachedGraph.mockReturnValue(null);
		// computeASTDiff throws a non-ENOENT error
		mockComputeASTDiff.mockRejectedValue(new Error('parse error'));

		const result = await buildSemanticDiffBlock('/test/dir', ['src/foo.ts']);
		expect(result).toBeNull();
	});

	test('returns markdown block when files have changes', async () => {
		const { buildSemanticDiffBlock } = await import(
			'../semantic-diff-injection.js'
		);

		// Mock file exists in HEAD
		mockExecFileSync.mockImplementation(
			(_command: string, args: string[], _options: unknown) => {
				if (args[0] === 'cat-file') return ''; // file exists
				if (args[0] === 'show') return 'old content';
				throw new Error('unexpected git command');
			},
		);

		mockReadFileSync.mockReturnValue('new content');

		mockGetCachedGraph.mockReturnValue(null);

		const mockAstDiffResult: ASTDiffResult = {
			filePath: 'src/foo.ts',
			language: 'typescript',
			changes: [
				{
					type: 'modified',
					category: 'function',
					name: 'foo',
					lineStart: 1,
					lineEnd: 5,
					signature: 'foo(): void',
				},
			],
			durationMs: 10,
			usedAST: true,
		};
		mockComputeASTDiff.mockResolvedValue(mockAstDiffResult);

		const mockClassifiedChanges: ClassifiedChange[] = [
			{
				category: 'LOGIC_CHANGE',
				riskLevel: 'High',
				filePath: 'src/foo.ts',
				symbolName: 'foo',
				changeType: 'modified',
				lineStart: 1,
				lineEnd: 5,
				description: 'Function body logic changed for foo',
			},
		];
		mockClassifyChanges.mockReturnValue(mockClassifiedChanges);

		const mockSummary: SemanticDiffSummary = {
			totalFiles: 1,
			totalChanges: 1,
			byRisk: {
				Critical: [],
				High: mockClassifiedChanges,
				Medium: [],
				Low: [],
			},
			byCategory: {
				SIGNATURE_CHANGE: [],
				API_CHANGE: [],
				GUARD_REMOVED: [],
				LOGIC_CHANGE: mockClassifiedChanges,
				DELETED_FUNCTION: [],
				NEW_FUNCTION: [],
				REFACTOR: [],
				COSMETIC: [],
				UNCLASSIFIED: [],
			},
			criticalItems: [],
		};
		mockGenerateSummary.mockReturnValue(mockSummary);
		mockGenerateSummaryMarkdown.mockReturnValue(
			'## Change Summary (1 files, 1 changes)\n### High\n- src/foo.ts: LOGIC_CHANGE — Function body logic changed for foo',
		);

		const result = await buildSemanticDiffBlock('/test/dir', ['src/foo.ts']);

		expect(result).not.toBeNull();
		expect(result).toContain('## SEMANTIC DIFF SUMMARY');
		expect(result).toContain('src/foo.ts: LOGIC_CHANGE');
	});

	test('skips files not in HEAD (new files) — uses empty oldContent', async () => {
		const { buildSemanticDiffBlock } = await import(
			'../semantic-diff-injection.js'
		);

		// File does NOT exist in HEAD: git cat-file returns exit code 1 (not ENOENT).
		// execFileSync throws with status=1 and code='1' for non-zero exit codes by default.
		// The inner catch sees err.code !== 'ENOENT' so treats it as "new file".
		mockExecFileSync.mockImplementation(
			(_command: string, _args: string[], _options: unknown) => {
				const error = new Error('git exited with code 1') as Error & {
					code?: string;
					status?: number;
				};
				error.status = 1;
				error.code = '1';
				throw error;
			},
		);

		mockReadFileSync.mockReturnValue('new file content');

		mockGetCachedGraph.mockReturnValue(null);

		const mockAstDiffResult: ASTDiffResult = {
			filePath: 'src/new-file.ts',
			language: 'typescript',
			changes: [
				{
					type: 'added',
					category: 'function',
					name: 'newFunc',
					lineStart: 1,
					lineEnd: 3,
				},
			],
			durationMs: 5,
			usedAST: true,
		};
		mockComputeASTDiff.mockResolvedValue(mockAstDiffResult);

		mockClassifyChanges.mockReturnValue([
			{
				category: 'NEW_FUNCTION',
				riskLevel: 'Medium',
				filePath: 'src/new-file.ts',
				symbolName: 'newFunc',
				changeType: 'added',
				lineStart: 1,
				lineEnd: 3,
				description: "New function 'newFunc' added",
			},
		]);

		const mockSummary: SemanticDiffSummary = {
			totalFiles: 1,
			totalChanges: 1,
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
		};
		mockGenerateSummary.mockReturnValue(mockSummary);
		mockGenerateSummaryMarkdown.mockReturnValue(
			'## Change Summary (1 files, 1 changes)\n### Medium\n- src/new-file.ts: NEW_FUNCTION — New function newFunc added',
		);

		const result = await buildSemanticDiffBlock('/test/dir', [
			'src/new-file.ts',
		]);

		expect(result).not.toBeNull();
		// Verify computeASTDiff was called with empty oldContent for new file
		expect(mockComputeASTDiff).toHaveBeenCalledWith(
			'src/new-file.ts',
			'',
			'new file content',
		);
	});

	test('returns null when git binary is missing (ENOENT)', async () => {
		const { buildSemanticDiffBlock } = await import(
			'../semantic-diff-injection.js'
		);

		// Simulate git binary missing: ENOENT on cat-file
		mockExecFileSync.mockImplementation(
			(_command: string, _args: string[], _options: unknown) => {
				const error = new Error('git not found') as Error & { code?: string };
				error.code = 'ENOENT';
				throw error;
			},
		);

		// Function should return null, not throw
		const result = await buildSemanticDiffBlock('/test/dir', ['src/foo.ts']);
		expect(result).toBeNull();
	});

	test('skips deleted files and returns summary for valid files', async () => {
		const { buildSemanticDiffBlock } = await import(
			'../semantic-diff-injection.js'
		);

		// First file: exists in HEAD but missing from disk (deleted)
		// Second file: exists in both HEAD and disk
		mockExecFileSync.mockImplementation(
			(_command: string, args: string[], _options: unknown) => {
				if (args[0] === 'cat-file') return ''; // both files exist in HEAD
				if (args[0] === 'show') return 'old content';
				return '';
			},
		);

		// First readFileSync call throws ENOENT (deleted file), second succeeds
		const enoentError = new Error('ENOENT') as Error & { code: string };
		enoentError.code = 'ENOENT';
		let readCallCount = 0;
		mockReadFileSync.mockImplementation(() => {
			readCallCount++;
			if (readCallCount === 1) throw enoentError;
			return 'new content';
		});

		mockGetCachedGraph.mockReturnValue(null);

		const mockAstDiffResult: ASTDiffResult = {
			filePath: 'valid.ts',
			language: 'typescript',
			changes: [
				{
					type: 'modified',
					category: 'function',
					name: 'foo',
					lineStart: 1,
					lineEnd: 5,
					signature: 'foo(): void',
				},
			],
			durationMs: 10,
			usedAST: true,
		};
		mockComputeASTDiff.mockResolvedValue(mockAstDiffResult);

		const mockClassifiedChanges: ClassifiedChange[] = [
			{
				category: 'LOGIC_CHANGE',
				riskLevel: 'High',
				filePath: 'valid.ts',
				symbolName: 'foo',
				changeType: 'modified',
				lineStart: 1,
				lineEnd: 5,
				description: 'Function body logic changed for foo',
			},
		];
		mockClassifyChanges.mockReturnValue(mockClassifiedChanges);

		const mockSummary: SemanticDiffSummary = {
			totalFiles: 1,
			totalChanges: 1,
			byRisk: {
				Critical: [],
				High: mockClassifiedChanges,
				Medium: [],
				Low: [],
			},
			byCategory: {
				SIGNATURE_CHANGE: [],
				API_CHANGE: [],
				GUARD_REMOVED: [],
				LOGIC_CHANGE: mockClassifiedChanges,
				DELETED_FUNCTION: [],
				NEW_FUNCTION: [],
				REFACTOR: [],
				COSMETIC: [],
				UNCLASSIFIED: [],
			},
			criticalItems: [],
		};
		mockGenerateSummary.mockReturnValue(mockSummary);
		mockGenerateSummaryMarkdown.mockReturnValue(
			'## Change Summary (1 files, 1 changes)\n### High\n- valid.ts: LOGIC_CHANGE — Function body logic changed for foo',
		);

		// Deleted file is skipped, valid file produces a diff result
		const result = await buildSemanticDiffBlock('/test/dir', [
			'deleted.ts',
			'valid.ts',
		]);

		expect(result).not.toBeNull();
		expect(result).toContain('## SEMANTIC DIFF SUMMARY');
		expect(result).toContain('valid.ts');
	});

	test('populates consumersCount from graph importers', async () => {
		const { buildSemanticDiffBlock } = await import(
			'../semantic-diff-injection.js'
		);

		mockExecFileSync.mockImplementation(
			(_command: string, args: string[], _options: unknown) => {
				if (args[0] === 'cat-file') return '';
				if (args[0] === 'show') return 'old';
				throw new Error('unexpected');
			},
		);

		mockReadFileSync.mockReturnValue('new');

		const mockGraph = {
			files: {},
			metadata: { generatedAt: '', fileCount: 0 },
		};
		mockGetCachedGraph.mockReturnValue(mockGraph as any);

		// Simulate 3 importers
		mockGetImporters.mockReturnValue([
			{ file: 'a.ts', line: 1, importType: 'named' },
			{ file: 'b.ts', line: 2, importType: 'named' },
			{ file: 'c.ts', line: 3, importType: 'named' },
		]);

		const mockAstDiffResult: ASTDiffResult = {
			filePath: 'src/foo.ts',
			language: 'typescript',
			changes: [
				{
					type: 'modified',
					category: 'function',
					name: 'foo',
					lineStart: 1,
					lineEnd: 5,
				},
			],
			durationMs: 10,
			usedAST: true,
		};
		mockComputeASTDiff.mockResolvedValue(mockAstDiffResult);

		let passedFileConsumers: Record<string, number> | undefined;
		mockClassifyChanges.mockImplementation(
			(_astDiffs: ASTDiffResult[], fileConsumers?: Record<string, number>) => {
				passedFileConsumers = fileConsumers;
				return [
					{
						category: 'LOGIC_CHANGE',
						riskLevel: 'High',
						filePath: 'src/foo.ts',
						symbolName: 'foo',
						changeType: 'modified',
						lineStart: 1,
						lineEnd: 5,
						description: 'Function body logic changed for foo',
						consumersCount: 3,
					},
				];
			},
		);

		const mockSummary: SemanticDiffSummary = {
			totalFiles: 1,
			totalChanges: 1,
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
		};
		mockGenerateSummary.mockReturnValue(mockSummary);
		mockGenerateSummaryMarkdown.mockReturnValue('mock markdown');

		await buildSemanticDiffBlock('/test/dir', ['src/foo.ts']);

		// Verify classifyChanges was called with fileConsumers populated from graph
		expect(passedFileConsumers).toBeDefined();
		expect(passedFileConsumers!['src/foo.ts']).toBe(3);
	});

	test('works when no graph exists (consumersCount not set)', async () => {
		const { buildSemanticDiffBlock } = await import(
			'../semantic-diff-injection.js'
		);

		mockExecFileSync.mockImplementation(
			(_command: string, args: string[], _options: unknown) => {
				if (args[0] === 'cat-file') return '';
				if (args[0] === 'show') return 'old';
				throw new Error('unexpected');
			},
		);

		mockReadFileSync.mockReturnValue('new');

		// No graph available
		mockGetCachedGraph.mockReturnValue(null);

		const mockAstDiffResult: ASTDiffResult = {
			filePath: 'src/foo.ts',
			language: 'typescript',
			changes: [
				{
					type: 'modified',
					category: 'function',
					name: 'foo',
					lineStart: 1,
					lineEnd: 5,
				},
			],
			durationMs: 10,
			usedAST: true,
		};
		mockComputeASTDiff.mockResolvedValue(mockAstDiffResult);

		let passedFileConsumers: Record<string, number> | undefined;
		mockClassifyChanges.mockImplementation(
			(_astDiffs: ASTDiffResult[], fileConsumers?: Record<string, number>) => {
				passedFileConsumers = fileConsumers;
				return [
					{
						category: 'LOGIC_CHANGE',
						riskLevel: 'High',
						filePath: 'src/foo.ts',
						symbolName: 'foo',
						changeType: 'modified',
						lineStart: 1,
						lineEnd: 5,
						description: 'Function body logic changed for foo',
					},
				];
			},
		);

		const mockSummary: SemanticDiffSummary = {
			totalFiles: 1,
			totalChanges: 1,
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
		};
		mockGenerateSummary.mockReturnValue(mockSummary);
		mockGenerateSummaryMarkdown.mockReturnValue('mock markdown');

		const result = await buildSemanticDiffBlock('/test/dir', ['src/foo.ts']);

		expect(result).not.toBeNull();
		// fileConsumers should be empty when no graph
		expect(passedFileConsumers).toEqual({});
	});

	test('git binary ENOENT aborts all remaining files in multi-file batch', async () => {
		const { buildSemanticDiffBlock } = await import(
			'../semantic-diff-injection.js'
		);

		let _callCount = 0;
		mockExecFileSync.mockImplementation((_cmd: string, _args: string[]) => {
			_callCount++;
			// All calls throw ENOENT (git binary missing)
			const error = new Error('spawnSync git ENOENT');
			(error as NodeJS.ErrnoException).code = 'ENOENT';
			throw error;
		});

		mockComputeASTDiff.mockResolvedValue({
			filePath: 'src/foo.ts',
			language: 'typescript',
			changes: [],
			durationMs: 5,
			usedAST: true,
		});

		const result = await buildSemanticDiffBlock('/fake/dir', [
			'file1.ts',
			'file2.ts',
			'file3.ts',
		]);

		expect(result).toBeNull();
		// computeASTDiff should never be called — git ENOENT aborts before AST diff
		expect(mockComputeASTDiff).not.toHaveBeenCalled();
	});

	test('error-only AST result is pushed to astDiffs and passed to classifyChanges', async () => {
		const { buildSemanticDiffBlock } = await import(
			'../semantic-diff-injection.js'
		);

		mockExecFileSync.mockImplementation((_cmd: string, args: string[]) => {
			if (args[0] === 'cat-file') return '';
			if (args[0] === 'show') return 'old';
			return '';
		});

		mockReadFileSync.mockReturnValue('new');

		// Return error-only result — changes empty but error present
		mockComputeASTDiff.mockResolvedValue({
			filePath: 'broken.ts',
			language: 'typescript',
			changes: [],
			durationMs: 5,
			usedAST: false,
			error: 'parse failed: unsupported language',
		});

		mockGetCachedGraph.mockReturnValue(null);
		mockClassifyChanges.mockReturnValue([]);

		const mockSummary: SemanticDiffSummary = {
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
		};
		mockGenerateSummary.mockReturnValue(mockSummary);
		mockGenerateSummaryMarkdown.mockReturnValue('');

		const _result = await buildSemanticDiffBlock('/fake/dir', ['broken.ts']);

		// classifyChanges should have been called with astDiffs that include the error-only result
		expect(mockClassifyChanges).toHaveBeenCalled();
		const calledWithDiffs = mockClassifyChanges.mock.calls[0][0];
		expect(calledWithDiffs.length).toBe(1);
		expect(calledWithDiffs[0].error).toBe('parse failed: unsupported language');
		expect(calledWithDiffs[0].changes.length).toBe(0);
	});

	test('path traversal attempts are silently skipped', async () => {
		const { buildSemanticDiffBlock } = await import(
			'../semantic-diff-injection.js'
		);

		mockExecFileSync.mockImplementation((_cmd: string, _args: string[]) => '');
		mockReadFileSync.mockReturnValue('content');
		mockComputeASTDiff.mockResolvedValue({
			filePath: 'valid.ts',
			language: 'typescript',
			changes: [],
			durationMs: 5,
			usedAST: true,
		});
		mockGetCachedGraph.mockReturnValue(null);
		mockClassifyChanges.mockReturnValue([]);
		mockGenerateSummary.mockReturnValue({
			totalFiles: 0,
			totalChanges: 0,
			byRisk: {},
			byCategory: {},
			metadata: { generatedAt: '', fileCount: 0 },
		});
		mockGenerateSummaryMarkdown.mockReturnValue('');

		// Pass traversal paths mixed with a valid path
		const _result = await buildSemanticDiffBlock('/safe/dir', [
			'../../../etc/passwd',
			'/absolute/path/secret',
			'valid.ts',
		]);

		// Only 'valid.ts' should be processed — traversal paths skipped
		// computeASTDiff should only be called once (for valid.ts)
		expect(mockComputeASTDiff).toHaveBeenCalledTimes(1);
		expect(mockComputeASTDiff).toHaveBeenCalledWith(
			'valid.ts',
			expect.any(String),
			expect.any(String),
		);
	});

	test('symlink escapes are silently skipped after realpath resolution', async () => {
		const { buildSemanticDiffBlock } = await import(
			'../semantic-diff-injection.js'
		);

		const mockDir = path.resolve('/safe/dir');
		const linkedResolved = path.resolve(mockDir, 'linked.ts');
		const outsideResolved = path.resolve('/outside/linked.ts');

		mockRealpathSync.mockImplementation((inputPath: string) => {
			if (inputPath === mockDir) return mockDir;
			if (inputPath === linkedResolved) return outsideResolved;
			return inputPath;
		});
		mockExecFileSync.mockImplementation((_cmd: string, args: string[]) => {
			if (args[0] === 'cat-file') return '';
			if (args[0] === 'show') return 'old';
			return '';
		});
		mockReadFileSync.mockReturnValue('new');
		mockComputeASTDiff.mockResolvedValue({
			filePath: 'valid.ts',
			language: 'typescript',
			changes: [],
			durationMs: 5,
			usedAST: true,
		});
		mockGetCachedGraph.mockReturnValue(null);
		mockClassifyChanges.mockReturnValue([]);
		mockGenerateSummary.mockReturnValue({
			totalFiles: 0,
			totalChanges: 0,
			byRisk: {},
			byCategory: {},
			metadata: { generatedAt: '', fileCount: 0 },
		});
		mockGenerateSummaryMarkdown.mockReturnValue('');

		await buildSemanticDiffBlock('/safe/dir', ['linked.ts', 'valid.ts']);

		expect(mockComputeASTDiff).toHaveBeenCalledTimes(1);
		expect(mockComputeASTDiff).toHaveBeenCalledWith(
			'valid.ts',
			expect.any(String),
			expect.any(String),
		);
	});

	test('broken symlinks are skipped gracefully', async () => {
		const { buildSemanticDiffBlock } = await import(
			'../semantic-diff-injection.js'
		);

		const mockDir = path.resolve('/safe/dir');
		const brokenResolved = path.resolve(mockDir, 'broken.ts');

		mockRealpathSync.mockImplementation((inputPath: string) => {
			if (inputPath === mockDir) return mockDir;
			if (inputPath === brokenResolved) {
				const err = new Error('ENOENT') as Error & { code: string };
				err.code = 'ENOENT';
				throw err;
			}
			return inputPath;
		});
		mockGetCachedGraph.mockReturnValue(null);

		const result = await buildSemanticDiffBlock('/safe/dir', ['broken.ts']);
		expect(result).toBeNull();
		expect(mockComputeASTDiff).not.toHaveBeenCalled();
	});

	describe('integration and edge cases', () => {
		test('full end-to-end flow with consumersCount populates fileConsumers', async () => {
			const { buildSemanticDiffBlock } = await import(
				'../semantic-diff-injection.js'
			);

			// Mock git cat-file to return '' (file exists), git show to return 'old content'
			mockExecFileSync.mockImplementation(
				(_command: string, args: string[], _options: unknown) => {
					if (args[0] === 'cat-file') return '';
					if (args[0] === 'show') return 'old content';
					throw new Error('unexpected git command');
				},
			);

			// Mock readFileSync to return 'new content'
			mockReadFileSync.mockReturnValue('new content');

			// Mock computeASTDiff to return a valid ASTDiffResult with one change
			const mockAstDiffResult: ASTDiffResult = {
				filePath: 'src/foo.ts',
				language: 'typescript',
				changes: [
					{
						type: 'modified',
						category: 'function',
						name: 'foo',
						lineStart: 1,
						lineEnd: 5,
						signature: 'foo(): void',
					},
				],
				durationMs: 10,
				usedAST: true,
			};
			mockComputeASTDiff.mockResolvedValue(mockAstDiffResult);

			// Mock getCachedGraph to return a graph object
			const mockGraph = {
				files: {},
				metadata: { generatedAt: '', fileCount: 0 },
			};
			mockGetCachedGraph.mockReturnValue(mockGraph as any);

			// Mock getImporters to return 3 importers
			mockGetImporters.mockReturnValue([
				{ file: 'a.ts', line: 1, importType: 'named' },
				{ file: 'b.ts', line: 2, importType: 'named' },
				{ file: 'c.ts', line: 3, importType: 'named' },
			]);

			// Mock classifyChanges to capture fileConsumers parameter and return ClassifiedChange with consumersCount=3
			let passedFileConsumers: Record<string, number> | undefined;
			mockClassifyChanges.mockImplementation(
				(
					_astDiffs: ASTDiffResult[],
					fileConsumers?: Record<string, number>,
				) => {
					passedFileConsumers = fileConsumers;
					return [
						{
							category: 'LOGIC_CHANGE',
							riskLevel: 'High',
							filePath: 'src/foo.ts',
							symbolName: 'foo',
							changeType: 'modified',
							lineStart: 1,
							lineEnd: 5,
							description: 'Function body logic changed for foo',
							consumersCount: 3,
						},
					];
				},
			);

			// Mock generateSummary and generateSummaryMarkdown
			const mockSummary: SemanticDiffSummary = {
				totalFiles: 1,
				totalChanges: 1,
				byRisk: {
					Critical: [],
					High: [],
					Medium: [],
					Low: [],
				},
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
			};
			mockGenerateSummary.mockReturnValue(mockSummary);
			mockGenerateSummaryMarkdown.mockReturnValue(
				'## Change Summary (1 files, 1 changes)\n### High\n- src/foo.ts: LOGIC_CHANGE — Function body logic changed for foo',
			);

			// Call buildSemanticDiffBlock with single file
			const result = await buildSemanticDiffBlock('/test/dir', ['src/foo.ts']);

			// Verify: result is non-null and contains markdown header
			expect(result).not.toBeNull();
			expect(result).toContain('## SEMANTIC DIFF SUMMARY');

			// Verify classifyChanges was called with fileConsumers containing {'src/foo.ts': 3}
			expect(passedFileConsumers).toBeDefined();
			expect(passedFileConsumers!['src/foo.ts']).toBe(3);
		});

		test('maxFiles cap limits processing to 10 files when 15 are passed', async () => {
			const { buildSemanticDiffBlock } = await import(
				'../semantic-diff-injection.js'
			);

			// Create array of 15 file paths
			const fifteenFiles = [
				'file01.ts',
				'file02.ts',
				'file03.ts',
				'file04.ts',
				'file05.ts',
				'file06.ts',
				'file07.ts',
				'file08.ts',
				'file09.ts',
				'file10.ts',
				'file11.ts',
				'file12.ts',
				'file13.ts',
				'file14.ts',
				'file15.ts',
			];

			// Mock git cat-file to always return '' (all files exist)
			mockExecFileSync.mockImplementation(
				(_command: string, args: string[], _options: unknown) => {
					if (args[0] === 'cat-file') return '';
					if (args[0] === 'show') return 'old content';
					return '';
				},
			);

			// Mock readFileSync to return 'new content' for all files
			mockReadFileSync.mockReturnValue('new content');

			// Mock computeASTDiff to return a valid ASTDiffResult for any file
			mockComputeASTDiff.mockResolvedValue({
				filePath: 'file.ts',
				language: 'typescript',
				changes: [
					{
						type: 'modified',
						category: 'function',
						name: 'foo',
						lineStart: 1,
						lineEnd: 5,
					},
				],
				durationMs: 10,
				usedAST: true,
			});

			// Mock getCachedGraph to return null
			mockGetCachedGraph.mockReturnValue(null);

			// Mock classifyChanges to return a ClassifiedChange
			mockClassifyChanges.mockReturnValue([
				{
					category: 'LOGIC_CHANGE',
					riskLevel: 'High',
					filePath: 'file01.ts',
					symbolName: 'foo',
					changeType: 'modified',
					lineStart: 1,
					lineEnd: 5,
					description: 'Function body logic changed for foo',
				},
			]);

			// Mock generateSummary and generateSummaryMarkdown
			mockGenerateSummary.mockReturnValue({
				totalFiles: 1,
				totalChanges: 1,
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
			});
			mockGenerateSummaryMarkdown.mockReturnValue('mock markdown');

			// Call buildSemanticDiffBlock with 15 files
			await buildSemanticDiffBlock('/test/dir', fifteenFiles);

			// Verify computeASTDiff was called exactly 10 times (not 15)
			expect(mockComputeASTDiff).toHaveBeenCalledTimes(10);
		});

		test('computeASTDiff throws on one file, remaining files still processed', async () => {
			const { buildSemanticDiffBlock } = await import(
				'../semantic-diff-injection.js'
			);

			// Mock git cat-file to return '' for all files (all exist in HEAD)
			mockExecFileSync.mockImplementation(
				(_command: string, args: string[], _options: unknown) => {
					if (args[0] === 'cat-file') return '';
					if (args[0] === 'show') return 'old content';
					return '';
				},
			);

			// Mock readFileSync to return 'new content' for all files
			mockReadFileSync.mockReturnValue('new content');

			// Mock computeASTDiff:
			// - For 'broken.ts': mockRejectedValue(new Error('parse error'))
			// - For 'good1.ts' and 'good2.ts': mockResolvedValue with valid ASTDiffResult each
			mockComputeASTDiff.mockImplementation(async (filePath: string) => {
				if (filePath === 'broken.ts') {
					throw new Error('parse error');
				}
				return {
					filePath,
					language: 'typescript',
					changes: [
						{
							type: 'modified' as const,
							category: 'function' as const,
							name: 'foo',
							lineStart: 1,
							lineEnd: 5,
						},
					],
					durationMs: 10,
					usedAST: true,
				};
			});

			// Mock getCachedGraph to return null
			mockGetCachedGraph.mockReturnValue(null);

			// Mock classifyChanges to capture astDiffs and return classified changes
			let passedAstDiffs: ASTDiffResult[] = [];
			mockClassifyChanges.mockImplementation(
				(
					astDiffs: ASTDiffResult[],
					_fileConsumers?: Record<string, number>,
				) => {
					passedAstDiffs = astDiffs;
					return astDiffs.map((diff) => ({
						category: 'LOGIC_CHANGE',
						riskLevel: 'High',
						filePath: diff.filePath,
						symbolName: 'foo',
						changeType: 'modified' as const,
						lineStart: 1,
						lineEnd: 5,
						description: `Function body logic changed for ${diff.filePath}`,
					}));
				},
			);

			// Mock generateSummary and generateSummaryMarkdown
			mockGenerateSummary.mockReturnValue({
				totalFiles: 2,
				totalChanges: 2,
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
			});
			mockGenerateSummaryMarkdown.mockReturnValue('mock markdown');

			// Call buildSemanticDiffBlock with 3 files: broken.ts, good1.ts, good2.ts
			const result = await buildSemanticDiffBlock('/test/dir', [
				'broken.ts',
				'good1.ts',
				'good2.ts',
			]);

			// Verify: result is NOT null (because 2 of 3 files succeeded)
			expect(result).not.toBeNull();

			// Verify computeASTDiff was called 3 times (for all files attempted)
			expect(mockComputeASTDiff).toHaveBeenCalledTimes(3);

			// Verify classifyChanges was called with astDiffs containing results for good1.ts and good2.ts only
			expect(passedAstDiffs.length).toBe(2);
			expect(passedAstDiffs.map((d) => d.filePath)).toContain('good1.ts');
			expect(passedAstDiffs.map((d) => d.filePath)).toContain('good2.ts');
			expect(passedAstDiffs.map((d) => d.filePath)).not.toContain('broken.ts');
		});
	});
});
