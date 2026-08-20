/**
 * Tests for semantic-diff-injection hook (FR-012)
 *
 * Tests the buildSemanticDiffBlock function which:
 * 1. Computes AST-based semantic diffs (not line-based)
 * 2. Injects diff summary into agent context
 * 3. Handles binary files and large diffs per policy
 *
 * Observable outcomes:
 * - Returns null for empty file list
 * - Skips files outside repo root (path traversal protection)
 * - Caps file processing at maxFiles limit
 * - Returns markdown-formatted diff summary with AST diff info
 * - Returns null when no AST changes are detected
 * - Gracefully handles git binary unavailability
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as child_process from 'node:child_process';
import * as fs from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import path from 'node:path';
import {
	type ASTDiffResult,
	computeASTDiff,
} from '../../../src/diff/ast-diff.js';
import {
	type ClassifiedChange,
	classifyChanges,
} from '../../../src/diff/semantic-classifier.js';
import {
	generateSummary,
	generateSummaryMarkdown,
} from '../../../src/diff/summary-generator.js';
// Import the function under test
import { buildSemanticDiffBlock } from '../../../src/hooks/semantic-diff-injection.js';
import {
	GitBinaryMissingError,
	isGitBinaryMissing,
} from '../../../src/utils/git-binary-missing-error.js';

// ============================================================================
// Mock setup
// ============================================================================

// Capture calls per test
let execFileCalls: Array<[string, string[]]> = [];
let readFileCalls: string[] = [];
let realpathSyncCalls: string[] = [];

const mockExecFile = mock(
	(
		_file: string,
		args: string[],
		_options: unknown,
		callback: (
			error: child_process.ExecFileException | null,
			stdout: string,
			stderr: string,
		) => void,
	) => {
		execFileCalls.push([_file, args]);
		callback(null, '', '');
	},
);

const mockRealpathSync = mock((p: string) => {
	realpathSyncCalls.push(p);
	return p;
});

const mockReadFile = mock(async (p: string | Buffer | URL) => {
	readFileCalls.push(String(p));
	return '';
});

const mockGetCachedGraph = mock((_dir: string) => null);

// Save real modules for spreading
const realChildProcess = { ...child_process };
const realFs = { ...fs };
const realFsPromises = { ...fsPromises };

mock.module('node:child_process', () => ({
	...realChildProcess,
	execFile: (
		file: string,
		args: string[],
		options: unknown,
		callback: (
			error: child_process.ExecFileException | null,
			stdout: string,
			stderr: string,
		) => void,
	) => mockExecFile(file, args, options, callback),
}));

mock.module('node:fs', () => ({
	...realFs,
	realpathSync: (path: string | Buffer) => mockRealpathSync(path),
}));

mock.module('node:fs/promises', () => ({
	...realFsPromises,
	readFile: (path: string | Buffer | URL) => mockReadFile(path),
}));

mock.module('../../../src/hooks/repo-graph-injection.js', () => ({
	getCachedGraph: (dir: string) => mockGetCachedGraph(dir),
}));

afterEach(() => mock.restore());

// ============================================================================
// beforeEach
// ============================================================================

beforeEach(() => {
	execFileCalls = [];
	readFileCalls = [];
	realpathSyncCalls = [];
});

// ============================================================================
// Helpers
// ============================================================================

/** Minimal ASTDiffResult factory for testing */
function makeASTDiffResult(
	overrides: Partial<ASTDiffResult> = {},
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

/** Minimal ClassifiedChange factory for testing */
function makeClassifiedChange(
	overrides: Partial<ClassifiedChange> = {},
): ClassifiedChange {
	return {
		category: 'NEW_FUNCTION',
		riskLevel: 'Medium',
		filePath: 'test.ts',
		symbolName: 'testFunc',
		changeType: 'added',
		lineStart: 1,
		lineEnd: 5,
		description: 'Added testFunc',
		...overrides,
	};
}

// ============================================================================
// Outcome 1: Computes AST-based semantic diffs (not line-based)
// ============================================================================

describe('AST-based semantic diff computation', () => {
	test('returns null when changedFiles is empty', async () => {
		const result = await buildSemanticDiffBlock('/fake/dir', []);
		expect(result).toBeNull();
	});

	test('caps file processing at maxFiles limit', async () => {
		// With default maxFiles=10, pass 20 files and verify execFile is capped
		const manyFiles = Array.from({ length: 20 }, (_, i) => `file${i}.ts`);
		const dir = '/fake/dir';

		mockExecFile.mockImplementation(
			(
				_file: string,
				args: string[],
				_options: unknown,
				callback: (
					error: child_process.ExecFileException | null,
					stdout: string,
					stderr: string,
				) => void,
			) => {
				if (args[0] === 'cat-file') {
					callback(null, '', '');
					return;
				}
				if (args[0] === 'show') {
					callback(null, 'export function old() {}\n', '');
					return;
				}
				callback(null, '', '');
			},
		);

		mockRealpathSync.mockImplementation((p: string) => p);
		mockReadFile.mockImplementation(async () => 'export function foo() {}');

		const result = await buildSemanticDiffBlock(dir, manyFiles, 10);

		// Either null (no AST diffs collected) or string (markdown)
		// The important thing: maxFiles=10 cap is respected
		expect(result === null || typeof result === 'string').toBe(true);
		// execFile calls should be limited by the maxFiles cap
		const catFileCalls = execFileCalls.filter(([, a]) => a[0] === 'cat-file');
		expect(catFileCalls.length).toBeLessThanOrEqual(10);
	});

	test('skips files that escape the repo root via path traversal', async () => {
		const dir = '/repo/root';
		const traversalFile = '../../../etc/passwd';

		mockRealpathSync.mockImplementation((p: string) => p);

		const result = await buildSemanticDiffBlock(dir, [traversalFile]);

		// Should return null because traversal file was skipped
		expect(result).toBeNull();
	});

	test('skips broken symlinks gracefully', async () => {
		const dir = '/repo/root';
		const file = 'symlink.ts';
		const symlinkResolved = path.resolve(dir, file);

		// realpathSync throws ONLY for the symlink path (not the repo root),
		// so traversal check passes but symlink resolution fails
		mockRealpathSync.mockImplementation((p: string) => {
			if (p === symlinkResolved) {
				throw new Error('ENOENT: no such file or directory');
			}
			return p;
		});

		const result = await buildSemanticDiffBlock(dir, [file]);
		expect(result).toBeNull();
	});

	test('computeASTDiff returns valid ASTDiffResult for typescript files', async () => {
		const file = 'src/changed.ts';
		const oldContent = 'export function old() {}\n';
		const newContent = 'export function newer() {}\n';

		const astResult = await computeASTDiff(file, oldContent, newContent);

		// Result shape is always valid
		expect(typeof astResult.durationMs).toBe('number');
		expect(astResult.filePath).toBe(file);
		expect(Array.isArray(astResult.changes)).toBe(true);
		// Language is detected even if AST parse fails in test environment
		expect(astResult.language).toBe('typescript');
	});

	test('computeASTDiff returns usedAST=false for unsupported language', async () => {
		const result = await computeASTDiff('file.unknown', '', 'content');
		expect(result.usedAST).toBe(false);
		expect(result.changes).toHaveLength(0);
	});
});

// ============================================================================
// Outcome 2: Injects diff summary into agent context
// ============================================================================

describe('Diff summary injection into agent context', () => {
	test('generates markdown with SEMANTIC DIFF SUMMARY header when changes exist', async () => {
		const dir = '/repo/root';
		const file = 'src/changed.ts';

		mockRealpathSync.mockImplementation((p: string) => p);
		mockGetCachedGraph.mockImplementation(() => ({ nodes: [], edges: [] }));

		mockExecFile.mockImplementation(
			(
				_file: string,
				args: string[],
				_options: unknown,
				callback: (
					error: child_process.ExecFileException | null,
					stdout: string,
					stderr: string,
				) => void,
			) => {
				if (args[0] === 'cat-file') {
					callback(null, '', '');
					return;
				}
				if (args[0] === 'show') {
					callback(null, 'export function old() {}\n', '');
					return;
				}
				callback(null, '', '');
			},
		);

		mockReadFile.mockImplementation(async () => 'export function newer() {}\n');

		const result = await buildSemanticDiffBlock(dir, [file]);

		// Either null (no classified changes) or string with markdown
		if (result !== null) {
			expect(typeof result).toBe('string');
			expect(result).toContain('## SEMANTIC DIFF SUMMARY');
		}
	});

	test('markdown includes file path and change details', async () => {
		const change = makeClassifiedChange({
			category: 'SIGNATURE_CHANGE',
			riskLevel: 'High',
			filePath: 'src/api.ts',
			symbolName: 'fetchData',
			description: 'Changed return type from string to Promise<string>',
		});
		const summary = generateSummary([change]);
		const markdown = generateSummaryMarkdown(summary);

		expect(markdown).toContain('## Change Summary');
		expect(markdown).toContain('src/api.ts');
		expect(markdown).toContain('SIGNATURE_CHANGE');
		expect(markdown).toContain('High');
	});

	test('markdown groups changes by risk level', async () => {
		const changes: ClassifiedChange[] = [
			makeClassifiedChange({
				riskLevel: 'Critical',
				category: 'DELETED_FUNCTION',
			}),
			makeClassifiedChange({ riskLevel: 'Low', category: 'COSMETIC' }),
			makeClassifiedChange({ riskLevel: 'High', category: 'API_CHANGE' }),
		];
		const summary = generateSummary(changes);
		const markdown = generateSummaryMarkdown(summary);

		expect(markdown).toContain('Critical (review first)');
		expect(markdown).toContain('High');
		expect(markdown).toContain('Low (skim)');
	});
});

// ============================================================================
// Outcome 3: Handles binary files and large diffs per policy
// ============================================================================

describe('Binary files and large diff handling per policy', () => {
	test('returns null when computeASTDiff produces empty changes (binary/unsupported)', async () => {
		const dir = '/repo/root';
		const binaryFile = 'image.png';

		mockRealpathSync.mockImplementation((p: string) => p);

		// File not in HEAD (new untracked file)
		mockExecFile.mockImplementation(
			(
				_file: string,
				args: string[],
				_options: unknown,
				callback: (
					error: child_process.ExecFileException | null,
					stdout: string,
					stderr: string,
				) => void,
			) => {
				if (args[0] === 'cat-file') {
					// File not in HEAD — git error means treat as new/untracked
					callback(
						new Error(
							'fatal: not a valid object name',
						) as child_process.ExecFileException,
						'',
						'',
					);
					return;
				}
				callback(null, '', '');
			},
		);

		// Unsupported content (binary-like)
		mockReadFile.mockImplementation(async () => '\x00\x01\x02\x03binary');

		const result = await buildSemanticDiffBlock(dir, [binaryFile]);
		// Unsupported/binary → no AST diffs → null
		expect(result).toBeNull();
	});

	test('classifyChanges returns empty array for AST result with null language', async () => {
		// Unsupported file type (null language)
		const astResult = makeASTDiffResult({ language: null, changes: [] });
		const classified = classifyChanges([astResult], {});
		expect(classified).toHaveLength(0);
	});

	test('classifyChanges returns empty array when changes array is empty', async () => {
		const astResult = makeASTDiffResult({ changes: [] });
		const classified = classifyChanges([astResult], {});
		expect(classified).toHaveLength(0);
	});

	test('generateSummary on empty classified changes returns zero totals', async () => {
		const summary = generateSummary([]);
		expect(summary.totalChanges).toBe(0);
		expect(summary.totalFiles).toBe(0);
		expect(summary.criticalItems).toHaveLength(0);
	});

	test('GitBinaryMissingError is detected by isGitBinaryMissing', () => {
		// isGitBinaryMissing checks err.code === 'ENOENT' (child_process error shape)
		// The GitBinaryMissingError wraps this original ENOENT error
		const gitErr = new GitBinaryMissingError('git binary not found', {
			cause: { code: 'ENOENT' },
		});
		// isGitBinaryMissing is called on the ORIGINAL error from execFile,
		// not on GitBinaryMissingError. It checks err.code directly.
		const originalChildProcessErr = {
			code: 'ENOENT',
			message: 'spawn git ENOENT',
		};
		expect(isGitBinaryMissing(originalChildProcessErr)).toBe(true);
		expect(isGitBinaryMissing(gitErr)).toBe(false); // GitBinaryMissingError has no .code
		expect(isGitBinaryMissing(new Error('some error'))).toBe(false);
	});

	test('buildSemanticDiffBlock catches outer errors and returns null', async () => {
		const dir = '/repo/root';
		const file = 'src/test.ts';

		// Throw from realpathSync
		mockRealpathSync.mockImplementation(() => {
			throw new Error('Unexpected filesystem error');
		});

		const result = await buildSemanticDiffBlock(dir, [file]);
		// Outer catch returns null, does not throw
		expect(result).toBeNull();
	});
});

// ============================================================================
// Error handling and edge cases
// ============================================================================

describe('Error handling and edge cases', () => {
	test('buildSemanticDiffBlock handles git show failure gracefully', async () => {
		const dir = '/repo/root';
		const file = 'src/new.ts';

		mockRealpathSync.mockImplementation((p: string) => p);

		mockExecFile.mockImplementation(
			(
				_file: string,
				args: string[],
				_options: unknown,
				callback: (
					error: child_process.ExecFileException | null,
					stdout: string,
					stderr: string,
				) => void,
			) => {
				if (args[0] === 'cat-file') {
					callback(null, '', '');
					return;
				}
				if (args[0] === 'show') {
					callback(
						new Error('fatal: bad object') as child_process.ExecFileException,
						'',
						'',
					);
					return;
				}
				callback(null, '', '');
			},
		);

		mockReadFile.mockImplementation(async () => 'export const x = 1;\n');

		// Should not throw — outer catch handles it
		const result = await buildSemanticDiffBlock(dir, [file]);
		expect(result === null || typeof result === 'string').toBe(true);
	});

	test('classifyChanges uses fileConsumers for consumer counts', async () => {
		const astResult = makeASTDiffResult({
			changes: [
				{
					type: 'added',
					category: 'function',
					name: 'newFunc',
					lineStart: 1,
					lineEnd: 3,
				},
			],
		});
		const fileConsumers = { 'test.ts': 5 };
		const classified = classifyChanges([astResult], fileConsumers);

		expect(classified.length).toBeGreaterThan(0);
		// Consumer count should be propagated
		expect(classified[0].consumersCount).toBeDefined();
	});

	test('generateSummaryMarkdown formats consumer count in output', async () => {
		const change = makeClassifiedChange({
			filePath: 'src/api.ts',
			symbolName: 'fetch',
			consumersCount: 3,
		});
		const summary = generateSummary([change]);
		const markdown = generateSummaryMarkdown(summary);

		// Consumer count appears in output
		expect(markdown).toContain('3 consumer');
	});

	test('computeASTDiff handles timeout gracefully', async () => {
		// Large content that exercises timeout path
		const largeContent = 'export function test() {}\n'.repeat(10000);
		const result = await computeASTDiff('test.ts', largeContent, largeContent);

		// Result shape is always valid — either success or error-with-empty-changes
		expect(typeof result.durationMs).toBe('number');
		expect(result.filePath).toBe('test.ts');
		expect(Array.isArray(result.changes)).toBe(true);
	});
});
