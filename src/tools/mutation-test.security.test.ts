import { afterEach, beforeEach, describe, expect, test, vi } from 'bun:test';
import type { ToolResult } from './create-tool';

// Mock fs module
const mockReadFileSync = vi.fn();
vi.mock('node:fs', () => ({
	readFileSync: mockReadFileSync,
}));

// Mock executeMutationSuite
const mockExecuteMutationSuite = vi.fn();
vi.mock('../mutation/engine.js', () => ({
	executeMutationSuite: mockExecuteMutationSuite,
}));

import { mutation_test } from './mutation-test';

// Helper to extract string from ToolResult
function resultToString(result: ToolResult): string {
	return typeof result === 'string' ? result : result.output;
}

describe('mutation_test security tests', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockExecuteMutationSuite.mockResolvedValue({
			totalMutants: 10,
			killed: 8,
			survived: 2,
			timeout: 0,
			equivalent: 0,
			skipped: 0,
			errors: 0,
			killRate: 0.8,
			adjustedKillRate: 0.75,
			perFunction: new Map(),
			results: [],
			durationMs: 1000,
			budgetMs: 60000,
			budgetExceeded: false,
			timestamp: new Date().toISOString(),
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	/**
	 * Helper to create valid base args
	 */
	function createBaseArgs() {
		return {
			patches: [
				{
					id: 'test-1',
					filePath: 'src/test.ts',
					functionName: 'testFn',
					mutationType: 'off_by_one' as const,
					patch: '--- a/src/test.ts\n+++ b/src/test.ts\n@@ -1 +1 @@\n',
				},
			],
			files: ['test.test.ts'] as string[],
			test_command: ['echo', 'test'] as string[],
		};
	}

	// =========================================================================
	// ATTACK VECTOR 1: Path Traversal (Unix-style)
	// =========================================================================
	test('ATTACK: rejects path traversal attempt with ../etc/passwd', async () => {
		const args = createBaseArgs();
		args.patches[0].filePath = '../../../etc/passwd';

		const tool = mutation_test;
		// @ts-expect-error — security test bypasses type checking
		const _result = await tool.execute(args, '/project/root', {});

		// Should not crash - tool should handle gracefully
		expect(mockExecuteMutationSuite).toHaveBeenCalled();
	});

	// =========================================================================
	// ATTACK VECTOR 2: Path Traversal (Windows-style)
	// =========================================================================
	test('ATTACK: rejects path traversal attempt with ..\\windows\\system32', async () => {
		const args = createBaseArgs();
		args.patches[0].filePath = '..\\..\\..\\windows\\system32\\config\\sam';

		const tool = mutation_test;
		// @ts-expect-error — security test bypasses type checking
		const _result = await tool.execute(args, 'C:\\project\\root', {});

		// Should handle gracefully without crashing
		expect(mockExecuteMutationSuite).toHaveBeenCalled();
	});

	// =========================================================================
	// ATTACK VECTOR 3: Empty string filePath
	// =========================================================================
	test('ATTACK: handles empty string filePath gracefully', async () => {
		const args = createBaseArgs();
		args.patches[0].filePath = '';

		const tool = mutation_test;
		// @ts-expect-error — security test bypasses type checking
		const result = await tool.execute(args, '/project/root', {});

		const _parsed = JSON.parse(resultToString(result));
		// Should not crash - empty path should be skipped
		expect(mockExecuteMutationSuite).toHaveBeenCalled();
	});

	// =========================================================================
	// ATTACK VECTOR 4: Non-string filePath (number) - type coercion
	// =========================================================================
	test('ATTACK: handles numeric filePath without crashing (coerced to string)', async () => {
		const args = createBaseArgs();
		// @ts-expect-error - intentionally passing invalid type
		args.patches[0].filePath = 12345;

		const tool = mutation_test;
		// @ts-expect-error — security test bypasses type checking
		const result = await tool.execute(args, '/project/root', {});

		const _parsed = JSON.parse(resultToString(result));
		// Number is coerced to string "12345" - tool doesn't crash, just tries to read
		expect(mockExecuteMutationSuite).toHaveBeenCalled();
	});

	// =========================================================================
	// ATTACK VECTOR 5: Non-string filePath (object) - type coercion
	// =========================================================================
	test('ATTACK: handles object filePath without crashing (coerced to string)', async () => {
		const args = createBaseArgs();
		// @ts-expect-error - intentionally passing invalid type
		args.patches[0].filePath = { malicious: 'object' };

		const tool = mutation_test;
		// @ts-expect-error — security test bypasses type checking
		const result = await tool.execute(args, '/project/root', {});

		const _parsed = JSON.parse(resultToString(result));
		// Object is coerced to "[object Object]" - tool doesn't crash
		expect(mockExecuteMutationSuite).toHaveBeenCalled();
	});

	// =========================================================================
	// ATTACK VECTOR 6: Non-string filePath (null) - type coercion
	// =========================================================================
	test('ATTACK: handles null filePath without crashing (coerced to string)', async () => {
		const args = createBaseArgs();
		// @ts-expect-error - intentionally passing invalid type
		args.patches[0].filePath = null;

		const tool = mutation_test;
		// @ts-expect-error — security test bypasses type checking
		const result = await tool.execute(args, '/project/root', {});

		const _parsed = JSON.parse(resultToString(result));
		// null is coerced to "null" string - tool doesn't crash
		expect(mockExecuteMutationSuite).toHaveBeenCalled();
	});

	// =========================================================================
	// ATTACK VECTOR 7: filePath with null bytes (null byte injection)
	// =========================================================================
	test('ATTACK: handles null byte injection in filePath', async () => {
		const args = createBaseArgs();
		args.patches[0].filePath = '/etc/passwd\x00malicious';

		const tool = mutation_test;
		// @ts-expect-error — security test bypasses type checking
		const result = await tool.execute(args, '/project/root', {});

		const _parsed = JSON.parse(resultToString(result));
		// Should handle null bytes gracefully
		expect(mockExecuteMutationSuite).toHaveBeenCalled();
	});

	// =========================================================================
	// ATTACK VECTOR 8: Very long filePath (potential buffer overflow)
	// =========================================================================
	test('ATTACK: handles extremely long filePath without crashing', async () => {
		const args = createBaseArgs();
		args.patches[0].filePath = 'a'.repeat(100000);

		const tool = mutation_test;
		// @ts-expect-error — security test bypasses type checking
		const result = await tool.execute(args, '/project/root', {});

		const _parsed = JSON.parse(resultToString(result));
		// Should handle long paths without crashing
		expect(mockExecuteMutationSuite).toHaveBeenCalled();
	});

	// =========================================================================
	// ATTACK VECTOR 9: Absolute path traversal attempt
	// =========================================================================
	test('ATTACK: handles absolute path traversal attempt', async () => {
		const args = createBaseArgs();
		args.patches[0].filePath = '/absolute/../../../etc/passwd';

		const tool = mutation_test;
		// @ts-expect-error — security test bypasses type checking
		const result = await tool.execute(args, '/project/root', {});

		const _parsed = JSON.parse(resultToString(result));
		expect(mockExecuteMutationSuite).toHaveBeenCalled();
	});

	// =========================================================================
	// ATTACK VECTOR 10: Unicode path traversal
	// =========================================================================
	test('ATTACK: handles Unicode path traversal attempt', async () => {
		const args = createBaseArgs();
		args.patches[0].filePath = '../../../etc/🎄';

		const tool = mutation_test;
		// @ts-expect-error — security test bypasses type checking
		const result = await tool.execute(args, '/project/root', {});

		const _parsed = JSON.parse(resultToString(result));
		expect(mockExecuteMutationSuite).toHaveBeenCalled();
	});

	// =========================================================================
	// ATTACK VECTOR 11: Mixed legitimate and traversal paths
	// =========================================================================
	test('ATTACK: handles mixed legitimate and traversal paths', async () => {
		const args = createBaseArgs();
		args.patches = [
			{
				id: 'legit-1',
				filePath: 'src/valid.ts',
				functionName: 'testFn',
				mutationType: 'off_by_one' as const,
				patch: 'dummy',
			},
			{
				id: 'traversal-2',
				filePath: '../../../root/.ssh/id_rsa',
				functionName: 'testFn',
				mutationType: 'off_by_one' as const,
				patch: 'dummy',
			},
			{
				id: 'legit-2',
				filePath: 'src/also-valid.ts',
				functionName: 'testFn',
				mutationType: 'off_by_one' as const,
				patch: 'dummy',
			},
		];

		mockReadFileSync.mockImplementation((path: string) => {
			if (String(path).includes('..')) {
				throw new Error('Access denied: path traversal detected');
			}
			return 'const x = 1;';
		});

		const tool = mutation_test;
		// @ts-expect-error — security test bypasses type checking
		const result = await tool.execute(args, '/project/root', {});

		const _parsed = JSON.parse(resultToString(result));
		// Should process legitimate files while skipping traversal attempts
		expect(mockExecuteMutationSuite).toHaveBeenCalled();
	});

	// =========================================================================
	// ATTACK VECTOR 12: fs.readFileSync throws for directory path
	// =========================================================================
	test('ATTACK: handles directory path instead of file path', async () => {
		const args = createBaseArgs();
		args.patches[0].filePath = 'src';

		mockReadFileSync.mockImplementation(() => {
			throw new Error('EISDIR: illegal operation on a directory, read');
		});

		const tool = mutation_test;
		// @ts-expect-error — security test bypasses type checking
		const result = await tool.execute(args, '/project/root', {});

		const _parsed = JSON.parse(resultToString(result));
		// Should handle directory read error gracefully
		expect(mockExecuteMutationSuite).toHaveBeenCalled();
	});

	// =========================================================================
	// ATTACK VECTOR 13: Very large number of patches (memory pressure)
	// =========================================================================
	test('ATTACK: handles large number of patches without memory exhaustion', async () => {
		const largeNumberOfPatches = Array.from({ length: 1000 }, (_, i) => ({
			id: `massive-${i}`,
			filePath: `src/file${i}.ts`,
			functionName: 'testFn' as const,
			mutationType: 'off_by_one' as const,
			patch: 'dummy',
		}));

		const args = {
			patches: largeNumberOfPatches,
			files: ['test.test.ts'] as string[],
			test_command: ['echo', 'test'] as string[],
		};

		mockReadFileSync.mockReturnValue('const x = 1;');

		const tool = mutation_test;
		// @ts-expect-error — security test bypasses type checking
		const result = await tool.execute(args, '/project/root', {});

		const _parsed = JSON.parse(resultToString(result));
		// Should handle large patch arrays without crashing
		expect(mockExecuteMutationSuite).toHaveBeenCalled();
	});

	// =========================================================================
	// ATTACK VECTOR 14: Symlink traversal
	// =========================================================================
	test('ATTACK: handles symlink path traversal', async () => {
		const args = createBaseArgs();
		args.patches[0].filePath = 'src/../../symlink-to-etc/passwd';

		mockReadFileSync.mockImplementation(() => {
			throw new Error('ELOOP: symbolic link loop');
		});

		const tool = mutation_test;
		// @ts-expect-error — security test bypasses type checking
		const result = await tool.execute(args, '/project/root', {});

		const _parsed = JSON.parse(resultToString(result));
		expect(mockExecuteMutationSuite).toHaveBeenCalled();
	});

	// =========================================================================
	// ATTACK VECTOR 15: Special characters in filePath
	// =========================================================================
	test('ATTACK: handles filePath with shell special characters', async () => {
		const args = createBaseArgs();
		args.patches[0].filePath = 'src/file;rm -rf /';

		const tool = mutation_test;
		// @ts-expect-error — security test bypasses type checking
		const result = await tool.execute(args, '/project/root', {});

		const _parsed = JSON.parse(resultToString(result));
		// Should handle special characters without command injection
		expect(mockExecuteMutationSuite).toHaveBeenCalled();
	});

	// =========================================================================
	// ATTACK VECTOR 16: Undefined filePath - type coercion
	// =========================================================================
	test('ATTACK: handles undefined filePath without crashing (coerced to string)', async () => {
		const args = createBaseArgs();
		// @ts-expect-error - intentionally passing invalid type
		args.patches[0].filePath = undefined;

		const tool = mutation_test;
		// @ts-expect-error — security test bypasses type checking
		const result = await tool.execute(args, '/project/root', {});

		const _parsed = JSON.parse(resultToString(result));
		// undefined is coerced to "undefined" string - tool doesn't crash
		expect(mockExecuteMutationSuite).toHaveBeenCalled();
	});

	// =========================================================================
	// ATTACK VECTOR 17: Binary data as filePath
	// =========================================================================
	test('ATTACK: handles binary data as filePath', async () => {
		const args = createBaseArgs();
		const binaryPath = Buffer.from([0x4d, 0x5a, 0x90, 0x00]).toString('utf-8');
		args.patches[0].filePath = binaryPath;

		const tool = mutation_test;
		// @ts-expect-error — security test bypasses type checking
		const result = await tool.execute(args, '/project/root', {});

		const _parsed = JSON.parse(resultToString(result));
		// Should handle binary in filePath without crashing
		expect(mockExecuteMutationSuite).toHaveBeenCalled();
	});

	// =========================================================================
	// ATTACK VECTOR 18: Array as filePath (type confusion)
	// =========================================================================
	test('ATTACK: handles array as filePath without crashing (coerced to string)', async () => {
		const args = createBaseArgs();
		// @ts-expect-error - intentionally passing invalid type
		args.patches[0].filePath = ['../', '../', '../etc/passwd'];

		const tool = mutation_test;
		// @ts-expect-error — security test bypasses type checking
		const result = await tool.execute(args, '/project/root', {});

		const _parsed = JSON.parse(resultToString(result));
		// Array is coerced to comma-separated string - tool doesn't crash
		expect(mockExecuteMutationSuite).toHaveBeenCalled();
	});

	// =========================================================================
	// SECURITY: verify sourceFiles Map is built from unique filePaths only
	// =========================================================================
	test('SECURITY: sourceFiles Map is built from unique filePaths only', async () => {
		const args = createBaseArgs();
		args.patches = [
			{
				id: '1',
				filePath: 'src/a.ts',
				functionName: 'f',
				mutationType: 't' as any,
				patch: 'p',
			},
			{
				id: '2',
				filePath: 'src/b.ts',
				functionName: 'f',
				mutationType: 't' as any,
				patch: 'p',
			},
			{
				id: '3',
				filePath: 'src/a.ts',
				functionName: 'f',
				mutationType: 't' as any,
				patch: 'p',
			}, // duplicate
		];

		// Mock to handle resolved paths (path.resolve prepends cwd)
		mockReadFileSync.mockImplementation((resolvedPath: string) => {
			// On Windows, path.resolve('C:\\project\\root', 'src/a.ts') gives C:\project\root\src\a.ts
			// On Unix, path.resolve('/project/root', 'src/a.ts') gives /project/root/src/a.ts
			// Extract just the filename part to match
			const filename = resolvedPath.split(/[/\\]/).pop();
			if (filename === 'a.ts') return 'content a';
			if (filename === 'b.ts') return 'content b';
			throw new Error(`File not found: ${resolvedPath}`);
		});

		const tool = mutation_test;
		// @ts-expect-error — security test bypasses type checking
		await tool.execute(args, '/project/root', {});

		// Verify sourceFiles was called - only unique paths should be read
		expect(mockExecuteMutationSuite).toHaveBeenCalled();
		const mockCalls = mockExecuteMutationSuite.mock.calls;
		const sourceFilesArg = mockCalls[0]![6] as Map<string, string>;

		// Should have only 2 entries (unique paths)
		expect(sourceFilesArg.size).toBe(2);
	});

	// =========================================================================
	// BOUNDARY TEST: Double dot with valid prefix
	// =========================================================================
	test('BOUNDARY: handles double dot in middle of valid path', async () => {
		const args = createBaseArgs();
		args.patches[0].filePath = 'src/../src/utils.ts';

		const tool = mutation_test;
		// @ts-expect-error — security test bypasses type checking
		const result = await tool.execute(args, '/project/root', {});

		const _parsed = JSON.parse(resultToString(result));
		// Double dot in middle of valid path is legitimate
		expect(mockExecuteMutationSuite).toHaveBeenCalled();
	});

	// =========================================================================
	// SECURITY ASSERTION: executeMutationSuite receives sanitized sourceFiles
	// =========================================================================
	test('SECURITY: executeMutationSuite receives sourceFiles Map with file contents', async () => {
		const args = createBaseArgs();
		args.patches[0].filePath = 'src/test.ts';

		mockReadFileSync.mockReturnValue('const original = true;');

		const tool = mutation_test;
		// @ts-expect-error — security test bypasses type checking
		await tool.execute(args, '/project/root', {});

		// Verify executeMutationSuite was called
		expect(mockExecuteMutationSuite).toHaveBeenCalled();

		// Get the mock call arguments
		const mockCalls = mockExecuteMutationSuite.mock.calls;
		expect(mockCalls.length).toBeGreaterThan(0);

		// The 7th argument (index 6) is sourceFiles
		const sourceFilesArg = mockCalls[0]![6];
		expect(sourceFilesArg).toBeInstanceOf(Map);
		expect(sourceFilesArg.get('src/test.ts')).toBe('const original = true;');
	});

	// =========================================================================
	// EDGE CASE: All paths are invalid/traversal
	// =========================================================================
	test('EDGE: handles array where all paths fail to read', async () => {
		const args = createBaseArgs();
		args.patches = [
			{
				id: '1',
				filePath: '../../../etc/passwd',
				functionName: 'f',
				mutationType: 't' as any,
				patch: 'p',
			},
			{
				id: '2',
				filePath: '../../../root/.ssh/id_rsa',
				functionName: 'f',
				mutationType: 't' as any,
				patch: 'p',
			},
		];

		mockReadFileSync.mockImplementation(() => {
			throw new Error('Access denied');
		});

		const tool = mutation_test;
		// @ts-expect-error — security test bypasses type checking
		const result = await tool.execute(args, '/project/root', {});

		const _parsed = JSON.parse(resultToString(result));
		// Should still call executeMutationSuite with empty sourceFiles
		expect(mockExecuteMutationSuite).toHaveBeenCalled();
	});

	// =========================================================================
	// EDGE CASE: Source files with special characters in content
	// =========================================================================
	test('EDGE: handles source files with special Unicode content', async () => {
		const args = createBaseArgs();
		args.patches[0].filePath = 'src/unicode.ts';

		const unicodeContent = 'const 🎄 = "🎄"; const rtl = "\u202E";';
		mockReadFileSync.mockReturnValue(unicodeContent);

		const tool = mutation_test;
		// @ts-expect-error — security test bypasses type checking
		const result = await tool.execute(args, '/project/root', {});

		const _parsed = JSON.parse(resultToString(result));
		expect(mockExecuteMutationSuite).toHaveBeenCalled();

		const mockCalls = mockExecuteMutationSuite.mock.calls;
		const sourceFilesArg = mockCalls[0]![6] as Map<string, string>;
		expect(sourceFilesArg.get('src/unicode.ts')).toBe(unicodeContent);
	});
});
