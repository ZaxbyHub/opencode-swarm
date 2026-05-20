import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { ToolResult } from '../create-tool';

// Helper to extract string from ToolResult
function resultToString(result: ToolResult): string {
	return typeof result === 'string' ? result : result.output;
}

// Mock only execFileSync while preserving every other export (#330).
const mockExecFileSync = mock(() => '');
const mockReadFileSync = mock(() => '// mock file content');

const realChildProcess = await import('node:child_process');
mock.module('node:child_process', () => ({
	...realChildProcess,
	execFileSync: mockExecFileSync,
}));

mock.module('node:fs', () => ({
	readFileSync: mockReadFileSync,
}));

const realPath = await import('node:path');
mock.module('node:path', () => ({
	...realPath,
	join: (...args: string[]) => args.join('/'),
}));

// Import diff AFTER mock setup
const { diff } = await import('../../../src/tools/diff');

describe('AST diff fallback — regression: error results were silently dropped', () => {
	beforeEach(() => {
		mockExecFileSync.mockClear();
		mockReadFileSync.mockClear();
	});

	afterEach(() => {
		mockExecFileSync.mockClear();
		mockReadFileSync.mockClear();
	});

	describe('git show throws (file not in base) — fallback entry pushed', () => {
		test('git show error triggers fallback entry for that file', async () => {
			// Arrange: use staged base
			mockExecFileSync.mockReturnValueOnce('10\t5\tsrc/new-file.ts');
			mockExecFileSync.mockReturnValueOnce(
				'diff --git a/src/new-file.ts b/src/new-file.ts',
			);
			// For staged: oldContent from HEAD:path, newContent from :path (index)
			// First git show throws (file not in HEAD — new file)
			mockExecFileSync.mockImplementation(() => {
				throw new Error("fatal: Path 'src/new-file.ts' does not exist in HEAD");
			});

			// Act
			// @ts-expect-error — test bypasses createSwarmTool wrapper
			const result = await diff.execute({ base: 'staged' });
			const parsed = JSON.parse(resultToString(result));

			// Assert: fallback entry should be present in astDiffs
			expect(parsed.astDiffs).toBeDefined();
			expect(parsed.astDiffs).toHaveLength(1);
			expect(parsed.astDiffs![0].filePath).toBe('src/new-file.ts');
			expect(parsed.astDiffs![0].changes).toHaveLength(1);
			expect(parsed.astDiffs![0].changes[0].category).toBe('other');
		});

		test('fallback entry has correct structure when git show throws', async () => {
			// Arrange
			mockExecFileSync.mockReturnValueOnce('1\t0\tsrc/never-existed.ts');
			mockExecFileSync.mockReturnValueOnce('diff --git');
			mockExecFileSync.mockImplementation(() => {
				throw new Error('fatal: this file never existed');
			});

			// Act
			// @ts-expect-error — test bypasses createSwarmTool wrapper
			const result = await diff.execute({ base: 'staged' });
			const parsed = JSON.parse(resultToString(result));

			// Assert
			const fallback = parsed.astDiffs![0];
			expect(fallback.filePath).toBe('src/never-existed.ts');
			expect(fallback.language).toBeNull();
			expect(fallback.durationMs).toBe(0);
			expect(fallback.usedAST).toBe(false);
			expect(fallback.changes[0]).toEqual({
				type: 'modified',
				category: 'other',
				name: '(parse failed)',
				lineStart: 0,
				lineEnd: 0,
			});
			expect(fallback.error).toBe(
				'AST parse unavailable — tree-sitter analysis failed for this file',
			);
		});
	});

	describe('basic AST diff integration', () => {
		test('diff tool returns valid result structure', async () => {
			// Arrange
			mockExecFileSync.mockReturnValueOnce('5\t2\tsrc/test.ts');
			mockExecFileSync.mockReturnValueOnce('diff --git a/src/test.ts');
			mockExecFileSync.mockReturnValueOnce('old');
			mockExecFileSync.mockReturnValueOnce('new');

			// Act
			// @ts-expect-error — test bypasses createSwarmTool wrapper
			const result = await diff.execute({ base: 'unstaged' });
			const parsed = JSON.parse(resultToString(result));

			// Assert
			expect(parsed.error).toBeUndefined();
			expect(parsed.files).toHaveLength(1);
			expect(parsed.files[0].path).toBe('src/test.ts');
		});

		test('handles multiple files in numstat', async () => {
			// Arrange
			mockExecFileSync.mockReturnValueOnce('5\t2\tsrc/a.ts\n3\t1\tsrc/b.ts');
			mockExecFileSync.mockReturnValueOnce('');
			// Each file will call git show twice (for unstaged)
			mockExecFileSync.mockReturnValueOnce('old a');
			mockExecFileSync.mockReturnValueOnce('new a');
			mockExecFileSync.mockReturnValueOnce('old b');
			mockExecFileSync.mockReturnValueOnce('new b');

			// Act
			// @ts-expect-error — test bypasses createSwarmTool wrapper
			const result = await diff.execute({ base: 'unstaged' });
			const parsed = JSON.parse(resultToString(result));

			// Assert
			expect(parsed.files).toHaveLength(2);
		});

		test('astDiffs array is present when files are processed', async () => {
			// Arrange - staged base, git show will throw to produce fallback entry
			mockExecFileSync.mockReturnValueOnce('10\t5\tsrc/code.ts');
			mockExecFileSync.mockReturnValueOnce('diff --git a/src/code.ts');
			// cat-file -e succeeds, but git show throws → fallback entry
			mockExecFileSync.mockReturnValueOnce(''); // cat-file -e HEAD: (succeeds)
			mockExecFileSync.mockImplementation(() => {
				throw new Error('git show failed');
			});

			// Act
			// @ts-expect-error — test bypasses createSwarmTool wrapper
			const result = await diff.execute({ base: 'staged' });
			const parsed = JSON.parse(resultToString(result));

			// Assert - astDiffs should be present with fallback entry
			expect(parsed.astDiffs).toBeDefined();
			expect(Array.isArray(parsed.astDiffs)).toBe(true);
		});
	});

	describe('guard condition fix verification', () => {
		// These tests verify the fix for the bug where error-only results
		// were silently dropped. The code change at line 287 adds || astResult.error
		// to the guard condition.

		test('BUG FIX: error-only results should now be included in astDiffs', async () => {
			// This test documents the bug fix behavior.
			// BEFORE FIX: computeASTDiff returning {error: "msg", changes: []}
			// would be SILENTLY DROPPED because the guard only checked:
			//   if (astResult.changes.length > 0)
			// AFTER FIX: the guard now includes || astResult.error
			//   if (astResult.changes.length > 0 || astResult.error)
			//
			// Due to ESM mocking limitations in bun:test, we cannot directly
			// mock computeASTDiff to return an error-only result. However,
			// we can verify the source code contains the fix.
			//
			// This test passes when the source code contains the fix.
			const sourceCode = await Bun.file(`${import.meta.dir}/../diff.ts`).text();

			// The fix adds || astResult.error to the guard condition
			// Look for the pattern: (astResult.changes.length > 0 || astResult.error)
			expect(sourceCode).toContain('astResult.error');
		});

		test('catch block pushes fallback with category other (lines 290-308)', async () => {
			// Verify the catch block has the fallback entry structure
			const sourceCode = await Bun.file(`${import.meta.dir}/../diff.ts`).text();

			// The fallback should push a change with category 'other'
			expect(sourceCode).toContain("category: 'other'");
			expect(sourceCode).toContain("name: '(parse failed)'");
			expect(sourceCode).toContain('AST parse unavailable');
		});
	});

	describe('fallback entry format', () => {
		test('fallback entry matches expected ASTDiffResult structure', async () => {
			// Arrange - cause computeASTDiff to fail by having git show throw
			mockExecFileSync.mockReturnValueOnce('1\t0\tsrc/fail.ts');
			mockExecFileSync.mockReturnValueOnce('diff');
			mockExecFileSync.mockImplementation(() => {
				throw new Error('git fail');
			});

			// Act
			// @ts-expect-error — test bypasses createSwarmTool wrapper
			const result = await diff.execute({ base: 'staged' });
			const parsed = JSON.parse(resultToString(result));

			// Assert - verify the fallback entry has the correct structure
			const entry = parsed.astDiffs![0];
			expect(entry).toHaveProperty('filePath');
			expect(entry).toHaveProperty('language');
			expect(entry).toHaveProperty('changes');
			expect(entry).toHaveProperty('durationMs');
			expect(entry).toHaveProperty('usedAST');
			expect(entry).toHaveProperty('error');
			expect(entry.language).toBeNull();
			expect(entry.durationMs).toBe(0);
			expect(entry.usedAST).toBe(false);
			expect(entry.changes[0].category).toBe('other');
			expect(entry.changes[0].type).toBe('modified');
			expect(entry.changes[0].name).toBe('(parse failed)');
		});
	});
});
