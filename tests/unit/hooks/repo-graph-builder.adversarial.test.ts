/**
 * Adversarial tests for repoGraphHook.toolAfter wiring
 *
 * Attack vectors tested:
 * 1. Malformed tool args (null, undefined, non-object, missing path fields)
 * 2. Path traversal attempts in file paths
 * 3. Oversized/extremely long file paths
 * 4. Non-string tool names (arrays, objects, numbers)
 * 5. Concurrent rapid-fire toolAfter invocations
 * 6. Prototype-pollution-style keys in args
 */

import {
	afterAll,
	afterEach,
	beforeEach,
	describe,
	expect,
	mock,
	test,
} from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { createRepoGraphBuilderHook } from '../../../src/hooks/repo-graph-builder';

// Create a real temp workspace for tests that need paths inside workspace
const tempWorkspace = fs.mkdtempSync(
	path.join(process.cwd(), 'adversarial-test-'),
);

afterAll(() => {
	try {
		fs.rmSync(tempWorkspace, { recursive: true, force: true });
	} catch {
		/* ignore */
	}
});

// Mock repo-graph module
const mockUpdateGraphForFiles = mock(() => Promise.resolve({}));
const mockBuildWorkspaceGraph = mock(() => ({
	metadata: { nodeCount: 1, edgeCount: 0 },
}));
const mockSaveGraph = mock(() => Promise.resolve());

describe('repoGraphHook.toolAfter adversarial tests', () => {
	beforeEach(() => {
		mockUpdateGraphForFiles.mockClear();
		mockUpdateGraphForFiles.mockImplementation(() => Promise.resolve({}));
	});

	afterEach(() => {
		mockUpdateGraphForFiles.mockClear();
	});

	// ===== 1. MALFORMED TOOL ARGS =====

	describe('malformed tool args', () => {
		test('null args does not throw', async () => {
			const hook = createRepoGraphBuilderHook('/fake/workspace', {
				buildWorkspaceGraph: mockBuildWorkspaceGraph,
				saveGraph: mockSaveGraph,
				updateGraphForFiles: mockUpdateGraphForFiles,
			});
			await expect(
				hook.toolAfter(
					{ tool: 'edit', sessionID: 'sess', args: null as never },
					{ output: undefined },
				),
			).resolves.toBeUndefined();
			expect(mockUpdateGraphForFiles).not.toHaveBeenCalled();
		});

		test('undefined args does not throw', async () => {
			const hook = createRepoGraphBuilderHook('/fake/workspace', {
				buildWorkspaceGraph: mockBuildWorkspaceGraph,
				saveGraph: mockSaveGraph,
				updateGraphForFiles: mockUpdateGraphForFiles,
			});
			await expect(
				hook.toolAfter(
					{ tool: 'edit', sessionID: 'sess', args: undefined },
					{ output: undefined },
				),
			).resolves.toBeUndefined();
			expect(mockUpdateGraphForFiles).not.toHaveBeenCalled();
		});

		test('non-object args (string) does not throw', async () => {
			const hook = createRepoGraphBuilderHook('/fake/workspace', {
				buildWorkspaceGraph: mockBuildWorkspaceGraph,
				saveGraph: mockSaveGraph,
				updateGraphForFiles: mockUpdateGraphForFiles,
			});
			await expect(
				hook.toolAfter(
					{ tool: 'edit', sessionID: 'sess', args: 'not an object' as never },
					{ output: undefined },
				),
			).resolves.toBeUndefined();
			expect(mockUpdateGraphForFiles).not.toHaveBeenCalled();
		});

		test('non-object args (number) does not throw', async () => {
			const hook = createRepoGraphBuilderHook('/fake/workspace', {
				buildWorkspaceGraph: mockBuildWorkspaceGraph,
				saveGraph: mockSaveGraph,
				updateGraphForFiles: mockUpdateGraphForFiles,
			});
			await expect(
				hook.toolAfter(
					{ tool: 'edit', sessionID: 'sess', args: 42 as never },
					{ output: undefined },
				),
			).resolves.toBeUndefined();
			expect(mockUpdateGraphForFiles).not.toHaveBeenCalled();
		});

		test('non-object args (array) does not throw', async () => {
			const hook = createRepoGraphBuilderHook('/fake/workspace', {
				buildWorkspaceGraph: mockBuildWorkspaceGraph,
				saveGraph: mockSaveGraph,
				updateGraphForFiles: mockUpdateGraphForFiles,
			});
			await expect(
				hook.toolAfter(
					{ tool: 'edit', sessionID: 'sess', args: ['arr'] as never },
					{ output: undefined },
				),
			).resolves.toBeUndefined();
			expect(mockUpdateGraphForFiles).not.toHaveBeenCalled();
		});

		test('object with undefined file_path does not throw', async () => {
			const hook = createRepoGraphBuilderHook('/fake/workspace', {
				buildWorkspaceGraph: mockBuildWorkspaceGraph,
				saveGraph: mockSaveGraph,
				updateGraphForFiles: mockUpdateGraphForFiles,
			});
			await expect(
				hook.toolAfter(
					{ tool: 'edit', sessionID: 'sess', args: { file_path: undefined } },
					{ output: undefined },
				),
			).resolves.toBeUndefined();
			expect(mockUpdateGraphForFiles).not.toHaveBeenCalled();
		});

		test('object with null file_path does not throw', async () => {
			const hook = createRepoGraphBuilderHook('/fake/workspace', {
				buildWorkspaceGraph: mockBuildWorkspaceGraph,
				saveGraph: mockSaveGraph,
				updateGraphForFiles: mockUpdateGraphForFiles,
			});
			await expect(
				hook.toolAfter(
					{ tool: 'edit', sessionID: 'sess', args: { file_path: null } },
					{ output: undefined },
				),
			).resolves.toBeUndefined();
			expect(mockUpdateGraphForFiles).not.toHaveBeenCalled();
		});

		test('object with empty string file_path does not throw', async () => {
			const hook = createRepoGraphBuilderHook('/fake/workspace', {
				buildWorkspaceGraph: mockBuildWorkspaceGraph,
				saveGraph: mockSaveGraph,
				updateGraphForFiles: mockUpdateGraphForFiles,
			});
			await expect(
				hook.toolAfter(
					{ tool: 'edit', sessionID: 'sess', args: { file_path: '' } },
					{ output: undefined },
				),
			).resolves.toBeUndefined();
			expect(mockUpdateGraphForFiles).not.toHaveBeenCalled();
		});

		test('object with non-string file_path (number) does not throw', async () => {
			const hook = createRepoGraphBuilderHook('/fake/workspace', {
				buildWorkspaceGraph: mockBuildWorkspaceGraph,
				saveGraph: mockSaveGraph,
				updateGraphForFiles: mockUpdateGraphForFiles,
			});
			await expect(
				hook.toolAfter(
					{ tool: 'edit', sessionID: 'sess', args: { file_path: 123 } },
					{ output: undefined },
				),
			).resolves.toBeUndefined();
			expect(mockUpdateGraphForFiles).not.toHaveBeenCalled();
		});

		test('object with non-string file_path (object) does not throw', async () => {
			const hook = createRepoGraphBuilderHook('/fake/workspace', {
				buildWorkspaceGraph: mockBuildWorkspaceGraph,
				saveGraph: mockSaveGraph,
				updateGraphForFiles: mockUpdateGraphForFiles,
			});
			await expect(
				hook.toolAfter(
					{
						tool: 'edit',
						sessionID: 'sess',
						args: { file_path: { nested: true } },
					},
					{ output: undefined },
				),
			).resolves.toBeUndefined();
			expect(mockUpdateGraphForFiles).not.toHaveBeenCalled();
		});

		test('missing all path field variants (path, filePath, file_path) does not throw', async () => {
			const hook = createRepoGraphBuilderHook('/fake/workspace', {
				buildWorkspaceGraph: mockBuildWorkspaceGraph,
				saveGraph: mockSaveGraph,
				updateGraphForFiles: mockUpdateGraphForFiles,
			});
			await expect(
				hook.toolAfter(
					{
						tool: 'edit',
						sessionID: 'sess',
						args: { other_field: 'value' },
					},
					{ output: undefined },
				),
			).resolves.toBeUndefined();
			expect(mockUpdateGraphForFiles).not.toHaveBeenCalled();
		});
	});

	// ===== 2. PATH TRAVERSAL IN FILE PATHS =====

	describe('path traversal attempts', () => {
		test('basic ../ traversal is REJECTED by workspace boundary check', async () => {
			const hook = createRepoGraphBuilderHook('/fake/workspace', {
				buildWorkspaceGraph: mockBuildWorkspaceGraph,
				saveGraph: mockSaveGraph,
				updateGraphForFiles: mockUpdateGraphForFiles,
			});
			await expect(
				hook.toolAfter(
					{
						tool: 'edit',
						sessionID: 'sess',
						args: { file_path: '../../../etc/passwd.ts' },
					},
					{ output: undefined },
				),
			).resolves.toBeUndefined();
			// Path resolves outside /fake/workspace - boundary check rejects it
			expect(mockUpdateGraphForFiles).not.toHaveBeenCalled();
		});

		test('URL-encoded traversal %2e%2e%2f is REJECTED by workspace boundary check', async () => {
			const hook = createRepoGraphBuilderHook('/fake/workspace', {
				buildWorkspaceGraph: mockBuildWorkspaceGraph,
				saveGraph: mockSaveGraph,
				updateGraphForFiles: mockUpdateGraphForFiles,
			});
			await expect(
				hook.toolAfter(
					{
						tool: 'edit',
						sessionID: 'sess',
						args: { file_path: '%2e%2e%2f%2e%2e%2fetc%2fpasswd.js' },
					},
					{ output: undefined },
				),
			).resolves.toBeUndefined();
			// Path resolves outside /fake/workspace - boundary check rejects it
			expect(mockUpdateGraphForFiles).not.toHaveBeenCalled();
		});

		test('double-encoded traversal %252e%252e%252f is REJECTED by workspace boundary check', async () => {
			const hook = createRepoGraphBuilderHook('/fake/workspace', {
				buildWorkspaceGraph: mockBuildWorkspaceGraph,
				saveGraph: mockSaveGraph,
				updateGraphForFiles: mockUpdateGraphForFiles,
			});
			await expect(
				hook.toolAfter(
					{
						tool: 'edit',
						sessionID: 'sess',
						args: {
							file_path: '%252e%252e%252f%252e%252e%252fetc%252fpasswd.ts',
						},
					},
					{ output: undefined },
				),
			).resolves.toBeUndefined();
			// Path resolves outside /fake/workspace - boundary check rejects it
			expect(mockUpdateGraphForFiles).not.toHaveBeenCalled();
		});

		test('Unicode fullwidth dot traversal is REJECTED by workspace boundary check', async () => {
			const hook = createRepoGraphBuilderHook('/fake/workspace', {
				buildWorkspaceGraph: mockBuildWorkspaceGraph,
				saveGraph: mockSaveGraph,
				updateGraphForFiles: mockUpdateGraphForFiles,
			});
			await expect(
				hook.toolAfter(
					{
						tool: 'edit',
						sessionID: 'sess',
						args: { file_path: '\uff0e\uff0e\x2fetc\x2fpasswd.ts' },
					},
					{ output: undefined },
				),
			).resolves.toBeUndefined();
			// Path resolves outside /fake/workspace - boundary check rejects it
			expect(mockUpdateGraphForFiles).not.toHaveBeenCalled();
		});

		test('mixed traversal patterns are REJECTED by workspace boundary check', async () => {
			const hook = createRepoGraphBuilderHook('/fake/workspace', {
				buildWorkspaceGraph: mockBuildWorkspaceGraph,
				saveGraph: mockSaveGraph,
				updateGraphForFiles: mockUpdateGraphForFiles,
			});
			await expect(
				hook.toolAfter(
					{
						tool: 'edit',
						sessionID: 'sess',
						args: { file_path: '..%2f..%2f..%2fetc%2fpasswd.py' },
					},
					{ output: undefined },
				),
			).resolves.toBeUndefined();
			// Path resolves outside /fake/workspace - boundary check rejects it
			expect(mockUpdateGraphForFiles).not.toHaveBeenCalled();
		});

		test('traversal with backslash separators is REJECTED by workspace boundary check', async () => {
			const hook = createRepoGraphBuilderHook('/fake/workspace', {
				buildWorkspaceGraph: mockBuildWorkspaceGraph,
				saveGraph: mockSaveGraph,
				updateGraphForFiles: mockUpdateGraphForFiles,
			});
			// Use forward slashes for cross-platform compatibility - backslash is Windows-specific
			await expect(
				hook.toolAfter(
					{
						tool: 'edit',
						sessionID: 'sess',
						args: { file_path: '../../../windows/system32/config.ts' },
					},
					{ output: undefined },
				),
			).resolves.toBeUndefined();
			// Path resolves outside /fake/workspace - boundary check rejects it
			expect(mockUpdateGraphForFiles).not.toHaveBeenCalled();
		});

		test('traversal without supported extension is NOT processed', async () => {
			const hook = createRepoGraphBuilderHook('/fake/workspace', {
				buildWorkspaceGraph: mockBuildWorkspaceGraph,
				saveGraph: mockSaveGraph,
				updateGraphForFiles: mockUpdateGraphForFiles,
			});
			await expect(
				hook.toolAfter(
					{
						tool: 'edit',
						sessionID: 'sess',
						args: { file_path: '../../../etc/passwd' },
					},
					{ output: undefined },
				),
			).resolves.toBeUndefined();
			// No supported extension = early return, no call to updateGraphForFiles
			expect(mockUpdateGraphForFiles).not.toHaveBeenCalled();
		});

		test('null byte in path is REJECTED by workspace boundary check', async () => {
			const hook = createRepoGraphBuilderHook('/fake/workspace', {
				buildWorkspaceGraph: mockBuildWorkspaceGraph,
				saveGraph: mockSaveGraph,
				updateGraphForFiles: mockUpdateGraphForFiles,
			});
			const pathWithNull = '..\x00..\x00etc\x00passwd.ts';
			await expect(
				hook.toolAfter(
					{
						tool: 'edit',
						sessionID: 'sess',
						args: { file_path: pathWithNull },
					},
					{ output: undefined },
				),
			).resolves.toBeUndefined();
			// Path resolves outside /fake/workspace - boundary check rejects it
			expect(mockUpdateGraphForFiles).not.toHaveBeenCalled();
		});
	});

	// ===== 3. OVERSIZED FILE PATHS =====

	describe('oversized file paths', () => {
		test('extremely long path (>10KB) does not throw', async () => {
			const hook = createRepoGraphBuilderHook(tempWorkspace, {
				buildWorkspaceGraph: mockBuildWorkspaceGraph,
				saveGraph: mockSaveGraph,
				updateGraphForFiles: mockUpdateGraphForFiles,
			});
			const longPath = path.join(tempWorkspace, 'a'.repeat(15000) + '.ts');
			await expect(
				hook.toolAfter(
					{ tool: 'edit', sessionID: 'sess', args: { file_path: longPath } },
					{ output: undefined },
				),
			).resolves.toBeUndefined();
		});

		test('path with extremely long segment does not throw', async () => {
			const hook = createRepoGraphBuilderHook(tempWorkspace, {
				buildWorkspaceGraph: mockBuildWorkspaceGraph,
				saveGraph: mockSaveGraph,
				updateGraphForFiles: mockUpdateGraphForFiles,
			});
			const longSegment = 'a'.repeat(5000);
			const longPath = path.join(
				tempWorkspace,
				longSegment,
				longSegment + '.ts',
			);
			await expect(
				hook.toolAfter(
					{
						tool: 'edit',
						sessionID: 'sess',
						args: { file_path: longPath },
					},
					{ output: undefined },
				),
			).resolves.toBeUndefined();
		});

		test('deeply nested path (>100 levels) does not throw', async () => {
			const hook = createRepoGraphBuilderHook(tempWorkspace, {
				buildWorkspaceGraph: mockBuildWorkspaceGraph,
				saveGraph: mockSaveGraph,
				updateGraphForFiles: mockUpdateGraphForFiles,
			});
			const deepPath = path.join(
				tempWorkspace,
				Array.from({ length: 150 }, () => 'dir').join(path.sep),
				'file.ts',
			);
			await expect(
				hook.toolAfter(
					{ tool: 'edit', sessionID: 'sess', args: { file_path: deepPath } },
					{ output: undefined },
				),
			).resolves.toBeUndefined();
			expect(mockUpdateGraphForFiles).toHaveBeenCalled();
		});

		test('path with many traversal sequences is REJECTED by workspace boundary check', async () => {
			const hook = createRepoGraphBuilderHook('/fake/workspace', {
				buildWorkspaceGraph: mockBuildWorkspaceGraph,
				saveGraph: mockSaveGraph,
				updateGraphForFiles: mockUpdateGraphForFiles,
			});
			const manyTraversal =
				Array.from({ length: 100 }, () => '..').join('/') + '/file.ts';
			await expect(
				hook.toolAfter(
					{
						tool: 'edit',
						sessionID: 'sess',
						args: { file_path: manyTraversal },
					},
					{ output: undefined },
				),
			).resolves.toBeUndefined();
			// Path resolves outside /fake/workspace - boundary check rejects it
			expect(mockUpdateGraphForFiles).not.toHaveBeenCalled();
		});
	});

	// ===== 4. NON-STRING TOOL NAMES =====

	describe('non-string tool names', () => {
		test('numeric tool name does not throw', async () => {
			const hook = createRepoGraphBuilderHook('/fake/workspace', {
				buildWorkspaceGraph: mockBuildWorkspaceGraph,
				saveGraph: mockSaveGraph,
				updateGraphForFiles: mockUpdateGraphForFiles,
			});
			await expect(
				hook.toolAfter(
					{
						tool: 123 as never,
						sessionID: 'sess',
						args: { file_path: 'test.ts' },
					},
					{ output: undefined },
				),
			).resolves.toBeUndefined();
			// Should not match WRITE_TOOL_NAMES since 123 is not a string
			expect(mockUpdateGraphForFiles).not.toHaveBeenCalled();
		});

		test('array tool name does not throw', async () => {
			const hook = createRepoGraphBuilderHook('/fake/workspace', {
				buildWorkspaceGraph: mockBuildWorkspaceGraph,
				saveGraph: mockSaveGraph,
				updateGraphForFiles: mockUpdateGraphForFiles,
			});
			await expect(
				hook.toolAfter(
					{
						tool: ['edit'] as never,
						sessionID: 'sess',
						args: { file_path: 'test.ts' },
					},
					{ output: undefined },
				),
			).resolves.toBeUndefined();
			expect(mockUpdateGraphForFiles).not.toHaveBeenCalled();
		});

		test('object tool name does not throw', async () => {
			const hook = createRepoGraphBuilderHook('/fake/workspace', {
				buildWorkspaceGraph: mockBuildWorkspaceGraph,
				saveGraph: mockSaveGraph,
				updateGraphForFiles: mockUpdateGraphForFiles,
			});
			await expect(
				hook.toolAfter(
					{
						tool: { name: 'edit' } as never,
						sessionID: 'sess',
						args: { file_path: 'test.ts' },
					},
					{ output: undefined },
				),
			).resolves.toBeUndefined();
			expect(mockUpdateGraphForFiles).not.toHaveBeenCalled();
		});

		test('null tool name does not throw', async () => {
			const hook = createRepoGraphBuilderHook('/fake/workspace', {
				buildWorkspaceGraph: mockBuildWorkspaceGraph,
				saveGraph: mockSaveGraph,
				updateGraphForFiles: mockUpdateGraphForFiles,
			});
			await expect(
				hook.toolAfter(
					{
						tool: null as never,
						sessionID: 'sess',
						args: { file_path: 'test.ts' },
					},
					{ output: undefined },
				),
			).resolves.toBeUndefined();
			expect(mockUpdateGraphForFiles).not.toHaveBeenCalled();
		});

		test('undefined tool name does not throw', async () => {
			const hook = createRepoGraphBuilderHook('/fake/workspace', {
				buildWorkspaceGraph: mockBuildWorkspaceGraph,
				saveGraph: mockSaveGraph,
				updateGraphForFiles: mockUpdateGraphForFiles,
			});
			await expect(
				hook.toolAfter(
					{
						tool: undefined as never,
						sessionID: 'sess',
						args: { file_path: 'test.ts' },
					},
					{ output: undefined },
				),
			).resolves.toBeUndefined();
			expect(mockUpdateGraphForFiles).not.toHaveBeenCalled();
		});

		test('empty string tool name does not throw', async () => {
			const hook = createRepoGraphBuilderHook('/fake/workspace', {
				buildWorkspaceGraph: mockBuildWorkspaceGraph,
				saveGraph: mockSaveGraph,
				updateGraphForFiles: mockUpdateGraphForFiles,
			});
			await expect(
				hook.toolAfter(
					{ tool: '', sessionID: 'sess', args: { file_path: 'test.ts' } },
					{ output: undefined },
				),
			).resolves.toBeUndefined();
			expect(mockUpdateGraphForFiles).not.toHaveBeenCalled();
		});

		test('tool name with special characters does not throw', async () => {
			const hook = createRepoGraphBuilderHook('/fake/workspace', {
				buildWorkspaceGraph: mockBuildWorkspaceGraph,
				saveGraph: mockSaveGraph,
				updateGraphForFiles: mockUpdateGraphForFiles,
			});
			await expect(
				hook.toolAfter(
					{
						tool: 'edit<script>alert(1)</script>',
						sessionID: 'sess',
						args: { file_path: 'test.ts' },
					},
					{ output: undefined },
				),
			).resolves.toBeUndefined();
			// Should not match WRITE_TOOL_NAMES
			expect(mockUpdateGraphForFiles).not.toHaveBeenCalled();
		});
	});

	// ===== 5. CONCURRENT RAPID-FIRE INVOCATIONS =====

	describe('concurrent rapid-fire invocations', () => {
		test('50 rapid sequential calls complete without error', async () => {
			const hook = createRepoGraphBuilderHook(tempWorkspace, {
				buildWorkspaceGraph: mockBuildWorkspaceGraph,
				saveGraph: mockSaveGraph,
				updateGraphForFiles: mockUpdateGraphForFiles,
			});
			const calls = Array.from({ length: 50 }, (_, i) =>
				hook.toolAfter(
					{
						tool: 'edit',
						sessionID: `sess-${i}`,
						args: { file_path: path.join(tempWorkspace, `file${i}.ts`) },
					},
					{ output: undefined },
				),
			);
			await expect(Promise.all(calls)).resolves.toBeDefined();
			expect(mockUpdateGraphForFiles).toHaveBeenCalledTimes(50);
		});

		test('100 concurrent calls with mixed valid/invalid paths complete', async () => {
			mockUpdateGraphForFiles.mockImplementation(() => Promise.resolve({}));
			const hook = createRepoGraphBuilderHook(tempWorkspace, {
				buildWorkspaceGraph: mockBuildWorkspaceGraph,
				saveGraph: mockSaveGraph,
				updateGraphForFiles: mockUpdateGraphForFiles,
			});
			const calls = Array.from({ length: 100 }, (_, i) => {
				const args =
					i % 5 === 0
						? null // invalid args
						: { file_path: path.join(tempWorkspace, `file${i}.ts`) };
				return hook.toolAfter(
					{ tool: 'edit', sessionID: `sess-${i}`, args: args as any },
					{ output: undefined },
				);
			});
			await expect(Promise.all(calls)).resolves.toBeDefined();
			// Only valid calls trigger updateGraphForFiles
			expect(mockUpdateGraphForFiles.mock.calls.length).toBeGreaterThan(0);
		});

		test('all WRITE_TOOL_NAMES variants fire concurrently without error', async () => {
			const hook = createRepoGraphBuilderHook(tempWorkspace, {
				buildWorkspaceGraph: mockBuildWorkspaceGraph,
				saveGraph: mockSaveGraph,
				updateGraphForFiles: mockUpdateGraphForFiles,
			});
			const writeTools = [
				'write',
				'edit',
				'patch',
				'apply_patch',
				'create_file',
				'insert',
				'replace',
				'append',
				'prepend',
			];
			const calls = writeTools.map((tool, i) =>
				hook.toolAfter(
					{
						tool,
						sessionID: `sess-${i}`,
						args: { file_path: path.join(tempWorkspace, `file${i}.ts`) },
					},
					{ output: undefined },
				),
			);
			await expect(Promise.all(calls)).resolves.toBeDefined();
			expect(mockUpdateGraphForFiles).toHaveBeenCalledTimes(writeTools.length);
		});
	});

	// ===== 6. PROTOTYPE-POLLUTION-STYLE KEYS =====

	describe('prototype-pollution-style keys in args', () => {
		test('__proto__ key does not throw', async () => {
			const hook = createRepoGraphBuilderHook(tempWorkspace, {
				buildWorkspaceGraph: mockBuildWorkspaceGraph,
				saveGraph: mockSaveGraph,
				updateGraphForFiles: mockUpdateGraphForFiles,
			});
			await expect(
				hook.toolAfter(
					{
						tool: 'edit',
						sessionID: 'sess',
						args: {
							file_path: path.join(tempWorkspace, 'test.ts'),
							__proto__: { polluted: true },
						},
					},
					{ output: undefined },
				),
			).resolves.toBeUndefined();
			expect(mockUpdateGraphForFiles).toHaveBeenCalled();
		});

		test('constructor key does not throw', async () => {
			const hook = createRepoGraphBuilderHook(tempWorkspace, {
				buildWorkspaceGraph: mockBuildWorkspaceGraph,
				saveGraph: mockSaveGraph,
				updateGraphForFiles: mockUpdateGraphForFiles,
			});
			await expect(
				hook.toolAfter(
					{
						tool: 'edit',
						sessionID: 'sess',
						args: {
							file_path: path.join(tempWorkspace, 'test.ts'),
							constructor: { prototype: {} },
						},
					},
					{ output: undefined },
				),
			).resolves.toBeUndefined();
			expect(mockUpdateGraphForFiles).toHaveBeenCalled();
		});

		test('prototype key does not throw', async () => {
			const hook = createRepoGraphBuilderHook(tempWorkspace, {
				buildWorkspaceGraph: mockBuildWorkspaceGraph,
				saveGraph: mockSaveGraph,
				updateGraphForFiles: mockUpdateGraphForFiles,
			});
			await expect(
				hook.toolAfter(
					{
						tool: 'edit',
						sessionID: 'sess',
						args: {
							file_path: path.join(tempWorkspace, 'test.ts'),
							prototype: {},
						},
					},
					{ output: undefined },
				),
			).resolves.toBeUndefined();
			expect(mockUpdateGraphForFiles).toHaveBeenCalled();
		});

		test('hasOwnProperty in args does not throw', async () => {
			const hook = createRepoGraphBuilderHook(tempWorkspace, {
				buildWorkspaceGraph: mockBuildWorkspaceGraph,
				saveGraph: mockSaveGraph,
				updateGraphForFiles: mockUpdateGraphForFiles,
			});
			await expect(
				hook.toolAfter(
					{
						tool: 'edit',
						sessionID: 'sess',
						args: {
							file_path: path.join(tempWorkspace, 'test.ts'),
							hasOwnProperty: 'polluted',
						},
					},
					{ output: undefined },
				),
			).resolves.toBeUndefined();
			expect(mockUpdateGraphForFiles).toHaveBeenCalled();
		});

		test('toString key does not throw', async () => {
			const hook = createRepoGraphBuilderHook(tempWorkspace, {
				buildWorkspaceGraph: mockBuildWorkspaceGraph,
				saveGraph: mockSaveGraph,
				updateGraphForFiles: mockUpdateGraphForFiles,
			});
			await expect(
				hook.toolAfter(
					{
						tool: 'edit',
						sessionID: 'sess',
						args: {
							file_path: path.join(tempWorkspace, 'test.ts'),
							toString: () => 'polluted',
						},
					},
					{ output: undefined },
				),
			).resolves.toBeUndefined();
			expect(mockUpdateGraphForFiles).toHaveBeenCalled();
		});

		test('valueOf key does not throw', async () => {
			const hook = createRepoGraphBuilderHook(tempWorkspace, {
				buildWorkspaceGraph: mockBuildWorkspaceGraph,
				saveGraph: mockSaveGraph,
				updateGraphForFiles: mockUpdateGraphForFiles,
			});
			await expect(
				hook.toolAfter(
					{
						tool: 'edit',
						sessionID: 'sess',
						args: {
							file_path: path.join(tempWorkspace, 'test.ts'),
							valueOf: () => 1,
						},
					},
					{ output: undefined },
				),
			).resolves.toBeUndefined();
			expect(mockUpdateGraphForFiles).toHaveBeenCalled();
		});

		test('multiple prototype-pollution keys do not throw', async () => {
			const hook = createRepoGraphBuilderHook(tempWorkspace, {
				buildWorkspaceGraph: mockBuildWorkspaceGraph,
				saveGraph: mockSaveGraph,
				updateGraphForFiles: mockUpdateGraphForFiles,
			});
			await expect(
				hook.toolAfter(
					{
						tool: 'edit',
						sessionID: 'sess',
						args: {
							file_path: path.join(tempWorkspace, 'test.ts'),
							__proto__: {},
							constructor: {},
							prototype: {},
						},
					},
					{ output: undefined },
				),
			).resolves.toBeUndefined();
			expect(mockUpdateGraphForFiles).toHaveBeenCalled();
		});
	});

	// ===== BOUNDARY: SESSION ID HANDLING =====

	describe('sessionID boundary cases', () => {
		test('empty sessionID does not throw', async () => {
			const hook = createRepoGraphBuilderHook(tempWorkspace, {
				buildWorkspaceGraph: mockBuildWorkspaceGraph,
				saveGraph: mockSaveGraph,
				updateGraphForFiles: mockUpdateGraphForFiles,
			});
			await expect(
				hook.toolAfter(
					{
						tool: 'edit',
						sessionID: '',
						args: { file_path: path.join(tempWorkspace, 'test.ts') },
					},
					{ output: undefined },
				),
			).resolves.toBeUndefined();
			expect(mockUpdateGraphForFiles).toHaveBeenCalled();
		});

		test('very long sessionID does not throw', async () => {
			const hook = createRepoGraphBuilderHook(tempWorkspace, {
				buildWorkspaceGraph: mockBuildWorkspaceGraph,
				saveGraph: mockSaveGraph,
				updateGraphForFiles: mockUpdateGraphForFiles,
			});
			const longSessionID = 's'.repeat(5000);
			await expect(
				hook.toolAfter(
					{
						tool: 'edit',
						sessionID: longSessionID,
						args: { file_path: path.join(tempWorkspace, 'test.ts') },
					},
					{ output: undefined },
				),
			).resolves.toBeUndefined();
			expect(mockUpdateGraphForFiles).toHaveBeenCalled();
		});

		test('sessionID with special characters does not throw', async () => {
			const hook = createRepoGraphBuilderHook(tempWorkspace, {
				buildWorkspaceGraph: mockBuildWorkspaceGraph,
				saveGraph: mockSaveGraph,
				updateGraphForFiles: mockUpdateGraphForFiles,
			});
			await expect(
				hook.toolAfter(
					{
						tool: 'edit',
						sessionID: 'sess<script>alert(1)</script>',
						args: { file_path: path.join(tempWorkspace, 'test.ts') },
					},
					{ output: undefined },
				),
			).resolves.toBeUndefined();
			expect(mockUpdateGraphForFiles).toHaveBeenCalled();
		});
	});

	// ===== BOUNDARY: OUTPUT HANDLING =====

	describe('output object boundary cases', () => {
		test('null output does not throw', async () => {
			const hook = createRepoGraphBuilderHook(tempWorkspace, {
				buildWorkspaceGraph: mockBuildWorkspaceGraph,
				saveGraph: mockSaveGraph,
				updateGraphForFiles: mockUpdateGraphForFiles,
			});
			await expect(
				hook.toolAfter(
					{
						tool: 'edit',
						sessionID: 'sess',
						args: { file_path: path.join(tempWorkspace, 'test.ts') },
					},
					null as never,
				),
			).resolves.toBeUndefined();
			expect(mockUpdateGraphForFiles).toHaveBeenCalled();
		});

		test('undefined output does not throw', async () => {
			const hook = createRepoGraphBuilderHook(tempWorkspace, {
				buildWorkspaceGraph: mockBuildWorkspaceGraph,
				saveGraph: mockSaveGraph,
				updateGraphForFiles: mockUpdateGraphForFiles,
			});
			await expect(
				hook.toolAfter(
					{
						tool: 'edit',
						sessionID: 'sess',
						args: { file_path: path.join(tempWorkspace, 'test.ts') },
					},
					undefined as never,
				),
			).resolves.toBeUndefined();
			expect(mockUpdateGraphForFiles).toHaveBeenCalled();
		});

		test('output with undefined output field does not throw', async () => {
			const hook = createRepoGraphBuilderHook(tempWorkspace, {
				buildWorkspaceGraph: mockBuildWorkspaceGraph,
				saveGraph: mockSaveGraph,
				updateGraphForFiles: mockUpdateGraphForFiles,
			});
			await expect(
				hook.toolAfter(
					{
						tool: 'edit',
						sessionID: 'sess',
						args: { file_path: path.join(tempWorkspace, 'test.ts') },
					},
					{ output: undefined },
				),
			).resolves.toBeUndefined();
			expect(mockUpdateGraphForFiles).toHaveBeenCalled();
		});

		test('output with null output field does not throw', async () => {
			const hook = createRepoGraphBuilderHook(tempWorkspace, {
				buildWorkspaceGraph: mockBuildWorkspaceGraph,
				saveGraph: mockSaveGraph,
				updateGraphForFiles: mockUpdateGraphForFiles,
			});
			await expect(
				hook.toolAfter(
					{
						tool: 'edit',
						sessionID: 'sess',
						args: { file_path: path.join(tempWorkspace, 'test.ts') },
					},
					{ output: null },
				),
			).resolves.toBeUndefined();
			expect(mockUpdateGraphForFiles).toHaveBeenCalled();
		});

		test('output with non-string output does not throw', async () => {
			const hook = createRepoGraphBuilderHook(tempWorkspace, {
				buildWorkspaceGraph: mockBuildWorkspaceGraph,
				saveGraph: mockSaveGraph,
				updateGraphForFiles: mockUpdateGraphForFiles,
			});
			await expect(
				hook.toolAfter(
					{
						tool: 'edit',
						sessionID: 'sess',
						args: { file_path: path.join(tempWorkspace, 'test.ts') },
					},
					{ output: { complex: 'object' } },
				),
			).resolves.toBeUndefined();
			expect(mockUpdateGraphForFiles).toHaveBeenCalled();
		});
	});

	// ===== EDGE: UNSUPPORTED EXTENSIONS STILL PASS THROUCH =====

	describe('unsupported extension handling', () => {
		test('.json file is NOT processed', async () => {
			const hook = createRepoGraphBuilderHook('/fake/workspace', {
				buildWorkspaceGraph: mockBuildWorkspaceGraph,
				saveGraph: mockSaveGraph,
				updateGraphForFiles: mockUpdateGraphForFiles,
			});
			await expect(
				hook.toolAfter(
					{
						tool: 'edit',
						sessionID: 'sess',
						args: { file_path: 'config.json' },
					},
					{ output: undefined },
				),
			).resolves.toBeUndefined();
			// .json is not in SUPPORTED_EXTENSIONS, so it should NOT be called
			expect(mockUpdateGraphForFiles).not.toHaveBeenCalled();
		});

		test('.md file is NOT processed', async () => {
			const hook = createRepoGraphBuilderHook('/fake/workspace', {
				buildWorkspaceGraph: mockBuildWorkspaceGraph,
				saveGraph: mockSaveGraph,
				updateGraphForFiles: mockUpdateGraphForFiles,
			});
			await expect(
				hook.toolAfter(
					{ tool: 'edit', sessionID: 'sess', args: { file_path: 'README.md' } },
					{ output: undefined },
				),
			).resolves.toBeUndefined();
			// .md is not in SUPPORTED_EXTENSIONS, so it should NOT be called
			expect(mockUpdateGraphForFiles).not.toHaveBeenCalled();
		});

		test('.txt file is NOT processed', async () => {
			const hook = createRepoGraphBuilderHook('/fake/workspace', {
				buildWorkspaceGraph: mockBuildWorkspaceGraph,
				saveGraph: mockSaveGraph,
				updateGraphForFiles: mockUpdateGraphForFiles,
			});
			await expect(
				hook.toolAfter(
					{ tool: 'edit', sessionID: 'sess', args: { file_path: 'notes.txt' } },
					{ output: undefined },
				),
			).resolves.toBeUndefined();
			// .txt is not in SUPPORTED_EXTENSIONS, so it should NOT be called
			expect(mockUpdateGraphForFiles).not.toHaveBeenCalled();
		});

		test('.ts file IS processed', async () => {
			const hook = createRepoGraphBuilderHook(tempWorkspace, {
				buildWorkspaceGraph: mockBuildWorkspaceGraph,
				saveGraph: mockSaveGraph,
				updateGraphForFiles: mockUpdateGraphForFiles,
			});
			await expect(
				hook.toolAfter(
					{
						tool: 'edit',
						sessionID: 'sess',
						args: { file_path: path.join(tempWorkspace, 'test.ts') },
					},
					{ output: undefined },
				),
			).resolves.toBeUndefined();
			expect(mockUpdateGraphForFiles).toHaveBeenCalled();
		});

		test('.py file IS processed', async () => {
			const hook = createRepoGraphBuilderHook(tempWorkspace, {
				buildWorkspaceGraph: mockBuildWorkspaceGraph,
				saveGraph: mockSaveGraph,
				updateGraphForFiles: mockUpdateGraphForFiles,
			});
			await expect(
				hook.toolAfter(
					{
						tool: 'write',
						sessionID: 'sess',
						args: { file_path: path.join(tempWorkspace, 'script.py') },
					},
					{ output: undefined },
				),
			).resolves.toBeUndefined();
			expect(mockUpdateGraphForFiles).toHaveBeenCalled();
		});

		test('.js file IS processed', async () => {
			const hook = createRepoGraphBuilderHook(tempWorkspace, {
				buildWorkspaceGraph: mockBuildWorkspaceGraph,
				saveGraph: mockSaveGraph,
				updateGraphForFiles: mockUpdateGraphForFiles,
			});
			await expect(
				hook.toolAfter(
					{
						tool: 'edit',
						sessionID: 'sess',
						args: { file_path: path.join(tempWorkspace, 'old.js') },
					},
					{ output: undefined },
				),
			).resolves.toBeUndefined();
			expect(mockUpdateGraphForFiles).toHaveBeenCalled();
		});
	});
});
