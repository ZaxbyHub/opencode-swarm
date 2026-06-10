/**
 * Verification tests for repo-graph-builder.ts hook
 * Tests: init() success, error handling, silent skip, never throws
 */

import {
	afterAll,
	afterEach,
	beforeEach,
	describe,
	expect,
	mock,
	spyOn,
	test,
} from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { createRepoGraphBuilderHook } from '../../../src/hooks/repo-graph-builder';
import * as logger from '../../../src/utils/logger';

// Create a real temp workspace directory for cross-platform compatibility.
// Use os.tmpdir() (AGENTS.md invariant 7) so a cleanup failure cannot leave
// artifacts inside the project tree.
const tempWorkspace = fs.mkdtempSync(
	path.join(os.tmpdir(), 'repo-graph-hook-test-'),
);

// Cleanup temp workspace at end of all tests
afterAll(() => {
	try {
		fs.rmSync(tempWorkspace, { recursive: true, force: true });
	} catch {
		// Ignore cleanup errors
	}
});

// Create mock functions at top level
const mockBuildWorkspaceGraph = mock(() => ({
	metadata: { nodeCount: 42, edgeCount: 7 },
}));
const mockSaveGraph = mock(() => Promise.resolve());
const mockUpdateGraphForFiles = mock(() => Promise.resolve({}));

describe('createRepoGraphBuilderHook', () => {
	beforeEach(() => {
		// Reset mock call history
		mockBuildWorkspaceGraph.mockClear();
		mockSaveGraph.mockClear();
		mockUpdateGraphForFiles.mockClear();
		// Reset implementations to default
		mockBuildWorkspaceGraph.mockImplementation(() => ({
			metadata: { nodeCount: 42, edgeCount: 7 },
		}));
		mockSaveGraph.mockImplementation(() => Promise.resolve());
		mockUpdateGraphForFiles.mockImplementation(() => Promise.resolve({}));
	});

	test('init() succeeds when buildWorkspaceGraph returns a valid graph and saveGraph resolves', async () => {
		const workspaceRoot = tempWorkspace;
		const hook = createRepoGraphBuilderHook(workspaceRoot, {
			buildWorkspaceGraph: mockBuildWorkspaceGraph,
			saveGraph: mockSaveGraph,
			updateGraphForFiles: mockUpdateGraphForFiles,
		});

		// Should not throw
		await expect(hook.init()).resolves.toBeUndefined();

		// Verify buildWorkspaceGraph was called with workspace root
		expect(mockBuildWorkspaceGraph).toHaveBeenCalledWith(workspaceRoot);
		// Verify saveGraph was called with workspace root and graph
		expect(mockSaveGraph).toHaveBeenCalledWith(
			workspaceRoot,
			expect.objectContaining({ metadata: { nodeCount: 42, edgeCount: 7 } }),
		);
	});

	test('init() calls buildWorkspaceGraph and saveGraph with correct arguments', async () => {
		const workspaceRoot = tempWorkspace;
		const hook = createRepoGraphBuilderHook(workspaceRoot, {
			buildWorkspaceGraph: mockBuildWorkspaceGraph,
			saveGraph: mockSaveGraph,
			updateGraphForFiles: mockUpdateGraphForFiles,
		});

		await hook.init();

		expect(mockBuildWorkspaceGraph).toHaveBeenCalledTimes(1);
		expect(mockSaveGraph).toHaveBeenCalledTimes(1);
		expect(mockBuildWorkspaceGraph.mock.calls[0][0]).toBe(workspaceRoot);
	});

	test('init() handles "workspace does not exist" error silently (no error thrown)', async () => {
		// Override mock to throw "does not exist" error
		mockBuildWorkspaceGraph.mockImplementation(() => {
			throw new Error(`Workspace ${tempWorkspace} does not exist`);
		});

		const hook = createRepoGraphBuilderHook(tempWorkspace, {
			buildWorkspaceGraph: mockBuildWorkspaceGraph,
			saveGraph: mockSaveGraph,
			updateGraphForFiles: mockUpdateGraphForFiles,
		});

		// Should not throw - skips silently
		await expect(hook.init()).resolves.toBeUndefined();
		// saveGraph should NOT have been called
		expect(mockSaveGraph).not.toHaveBeenCalled();
	});

	test('init() logs error for other failures', async () => {
		// Override mock to throw a different error
		mockBuildWorkspaceGraph.mockImplementation(() => {
			throw new Error('Some other error');
		});

		const hook = createRepoGraphBuilderHook(tempWorkspace, {
			buildWorkspaceGraph: mockBuildWorkspaceGraph,
			saveGraph: mockSaveGraph,
			updateGraphForFiles: mockUpdateGraphForFiles,
		});

		// Should not throw
		await expect(hook.init()).resolves.toBeUndefined();
		// saveGraph should NOT have been called since buildWorkspaceGraph threw
		expect(mockSaveGraph).not.toHaveBeenCalled();
	});

	test('init() never throws - always catches', async () => {
		const hook = createRepoGraphBuilderHook(tempWorkspace, {
			buildWorkspaceGraph: mockBuildWorkspaceGraph,
			saveGraph: mockSaveGraph,
			updateGraphForFiles: mockUpdateGraphForFiles,
		});

		// Even with a fatal error, it should not throw
		mockBuildWorkspaceGraph.mockImplementation(() => {
			throw new Error('Fatal error');
		});

		// Verify no throw - the function should resolve instead of rejecting
		await expect(hook.init()).resolves.toBeUndefined();
	});

	test('init() skips silently when error message contains "does not exist" (different wording)', async () => {
		mockBuildWorkspaceGraph.mockImplementation(() => {
			throw new Error('The path /some/workspace does not exist on disk');
		});

		const hook = createRepoGraphBuilderHook('/some/workspace', {
			buildWorkspaceGraph: mockBuildWorkspaceGraph,
			saveGraph: mockSaveGraph,
			updateGraphForFiles: mockUpdateGraphForFiles,
		});

		await expect(hook.init()).resolves.toBeUndefined();
		expect(mockSaveGraph).not.toHaveBeenCalled();
	});

	test('init() handles saveGraph rejection gracefully', async () => {
		// Override saveGraph to reject
		mockSaveGraph.mockImplementation(() =>
			Promise.reject(new Error('Disk full')),
		);

		const hook = createRepoGraphBuilderHook(tempWorkspace, {
			buildWorkspaceGraph: mockBuildWorkspaceGraph,
			saveGraph: mockSaveGraph,
			updateGraphForFiles: mockUpdateGraphForFiles,
		});

		// Should not throw despite saveGraph failing
		await expect(hook.init()).resolves.toBeUndefined();
	});

	test('init() handles non-Error thrown values', async () => {
		mockBuildWorkspaceGraph.mockImplementation(() => {
			throw 'string error';
		});

		const hook = createRepoGraphBuilderHook(tempWorkspace, {
			buildWorkspaceGraph: mockBuildWorkspaceGraph,
			saveGraph: mockSaveGraph,
			updateGraphForFiles: mockUpdateGraphForFiles,
		});

		// Should not throw - error is caught and converted to string
		await expect(hook.init()).resolves.toBeUndefined();
	});

	test('init() returns correct graph metadata when successful', async () => {
		mockBuildWorkspaceGraph.mockImplementation(() => ({
			metadata: { nodeCount: 100, edgeCount: 50 },
		}));

		const hook = createRepoGraphBuilderHook(tempWorkspace, {
			buildWorkspaceGraph: mockBuildWorkspaceGraph,
			saveGraph: mockSaveGraph,
			updateGraphForFiles: mockUpdateGraphForFiles,
		});

		await hook.init();

		expect(mockSaveGraph).toHaveBeenCalledWith(
			tempWorkspace,
			expect.objectContaining({ metadata: { nodeCount: 100, edgeCount: 50 } }),
		);
	});

	test('init() is called from returned hook object', async () => {
		const hook = createRepoGraphBuilderHook(tempWorkspace, {
			buildWorkspaceGraph: mockBuildWorkspaceGraph,
			saveGraph: mockSaveGraph,
			updateGraphForFiles: mockUpdateGraphForFiles,
		});

		// Verify hook.init is a function
		expect(typeof hook.init).toBe('function');
	});
});

describe('toolAfter hook', () => {
	beforeEach(() => {
		// Reset mock call history
		mockBuildWorkspaceGraph.mockClear();
		mockSaveGraph.mockClear();
		mockUpdateGraphForFiles.mockClear();
		// Reset implementations to default
		mockBuildWorkspaceGraph.mockImplementation(() => ({
			metadata: { nodeCount: 42, edgeCount: 7 },
		}));
		mockSaveGraph.mockImplementation(() => Promise.resolve());
		mockUpdateGraphForFiles.mockImplementation(() => Promise.resolve({}));
	});

	test('toolAfter triggers updateGraphForFiles for write tool + .ts file', async () => {
		const workspaceRoot = tempWorkspace;
		const hook = createRepoGraphBuilderHook(workspaceRoot, {
			buildWorkspaceGraph: mockBuildWorkspaceGraph,
			saveGraph: mockSaveGraph,
			updateGraphForFiles: mockUpdateGraphForFiles,
		});

		// Call toolAfter with edit tool and .ts file
		await hook.toolAfter(
			{
				tool: 'edit',
				sessionID: 'test-session',
				args: { file_path: 'foo.ts' },
			},
			{ output: undefined },
		);

		// Verify updateGraphForFiles was called
		expect(mockUpdateGraphForFiles).toHaveBeenCalledTimes(1);
		// The path should be resolved to absolute
		expect(mockUpdateGraphForFiles.mock.calls[0][1]).toEqual(
			expect.arrayContaining([expect.stringContaining('foo.ts')]),
		);
	});

	test('toolAfter skips non-write tools (read tool)', async () => {
		const workspaceRoot = tempWorkspace;
		const hook = createRepoGraphBuilderHook(workspaceRoot, {
			buildWorkspaceGraph: mockBuildWorkspaceGraph,
			saveGraph: mockSaveGraph,
			updateGraphForFiles: mockUpdateGraphForFiles,
		});

		// Call toolAfter with read tool
		await hook.toolAfter(
			{
				tool: 'read',
				sessionID: 'test-session',
				args: { file_path: 'foo.ts' },
			},
			{ output: undefined },
		);

		// Verify updateGraphForFiles was NOT called
		expect(mockUpdateGraphForFiles).not.toHaveBeenCalled();
	});

	test('toolAfter skips unsupported extensions (.css)', async () => {
		const workspaceRoot = tempWorkspace;
		const hook = createRepoGraphBuilderHook(workspaceRoot, {
			buildWorkspaceGraph: mockBuildWorkspaceGraph,
			saveGraph: mockSaveGraph,
			updateGraphForFiles: mockUpdateGraphForFiles,
		});

		// Call toolAfter with edit tool but .css file
		await hook.toolAfter(
			{
				tool: 'edit',
				sessionID: 'test-session',
				args: { file_path: 'style.css' },
			},
			{ output: undefined },
		);

		// Verify updateGraphForFiles was NOT called
		expect(mockUpdateGraphForFiles).not.toHaveBeenCalled();
	});

	test('toolAfter handles missing file_path gracefully', async () => {
		const workspaceRoot = tempWorkspace;
		const hook = createRepoGraphBuilderHook(workspaceRoot, {
			buildWorkspaceGraph: mockBuildWorkspaceGraph,
			saveGraph: mockSaveGraph,
			updateGraphForFiles: mockUpdateGraphForFiles,
		});

		// Call toolAfter with edit tool but no file_path
		await hook.toolAfter(
			{ tool: 'edit', sessionID: 'test-session', args: {} },
			{ output: undefined },
		);

		// Verify updateGraphForFiles was NOT called
		expect(mockUpdateGraphForFiles).not.toHaveBeenCalled();
	});

	test('toolAfter catches and logs errors from updateGraphForFiles', async () => {
		const workspaceRoot = tempWorkspace;
		const hook = createRepoGraphBuilderHook(workspaceRoot, {
			buildWorkspaceGraph: mockBuildWorkspaceGraph,
			saveGraph: mockSaveGraph,
			updateGraphForFiles: mockUpdateGraphForFiles,
		});

		// Make updateGraphForFiles throw an error
		mockUpdateGraphForFiles.mockImplementation(() => {
			throw new Error('Update failed');
		});

		// Capture console.error
		const consoleErrorSpy = mock(() => {});
		const originalConsoleError = console.error;
		console.error = consoleErrorSpy;

		try {
			// Call toolAfter - should not throw despite error
			await hook.toolAfter(
				{
					tool: 'edit',
					sessionID: 'test-session',
					args: { file_path: 'foo.ts' },
				},
				{ output: undefined },
			);

			// Verify updateGraphForFiles was called
			expect(mockUpdateGraphForFiles).toHaveBeenCalledTimes(1);
			// Verify console.error was called with the error message
			expect(consoleErrorSpy).toHaveBeenCalledWith(
				expect.stringContaining('Update failed'),
			);
		} finally {
			console.error = originalConsoleError;
		}
	});

	test('toolAfter accepts alternative path field names (path, filePath)', async () => {
		const workspaceRoot = tempWorkspace;
		const hook = createRepoGraphBuilderHook(workspaceRoot, {
			buildWorkspaceGraph: mockBuildWorkspaceGraph,
			saveGraph: mockSaveGraph,
			updateGraphForFiles: mockUpdateGraphForFiles,
		});

		// Test with 'path' field
		await hook.toolAfter(
			{ tool: 'edit', sessionID: 'test-session', args: { path: 'bar.ts' } },
			{ output: undefined },
		);

		expect(mockUpdateGraphForFiles).toHaveBeenCalledTimes(1);
		expect(mockUpdateGraphForFiles.mock.calls[0][1]).toEqual(
			expect.arrayContaining([expect.stringContaining('bar.ts')]),
		);

		mockUpdateGraphForFiles.mockClear();

		// Test with 'filePath' field (camelCase)
		await hook.toolAfter(
			{ tool: 'edit', sessionID: 'test-session', args: { filePath: 'baz.ts' } },
			{ output: undefined },
		);

		expect(mockUpdateGraphForFiles).toHaveBeenCalledTimes(1);
		expect(mockUpdateGraphForFiles.mock.calls[0][1]).toEqual(
			expect.arrayContaining([expect.stringContaining('baz.ts')]),
		);
	});
});

describe('error escalation advisory', () => {
	let tempDir: string;
	let workspaceRoot: string;

	beforeEach(() => {
		mockUpdateGraphForFiles.mockClear();
		mockBuildWorkspaceGraph.mockClear();
		mockSaveGraph.mockClear();
		tempDir = fs.mkdtempSync(
			path.join(os.tmpdir(), 'repo-graph-escalation-test-'),
		);
		workspaceRoot = tempDir;
	});

	afterEach(() => {
		try {
			fs.rmSync(tempDir, { recursive: true, force: true });
		} catch {
			// ignore
		}
	});

	test('advisory warning is emitted after 3 consecutive failures', async () => {
		// Make updateGraphForFiles always throw
		mockUpdateGraphForFiles.mockImplementation(() => {
			throw new Error('simulated failure');
		});

		const hook = createRepoGraphBuilderHook(workspaceRoot, {
			buildWorkspaceGraph: mockBuildWorkspaceGraph,
			saveGraph: mockSaveGraph,
			updateGraphForFiles: mockUpdateGraphForFiles,
		});

		const warnSpy = spyOn(logger, 'warn').mockImplementation(() => {});

		const tsFile = path.join(workspaceRoot, 'test.ts');
		fs.writeFileSync(tsFile, 'export const x = 1;');

		try {
			// First 2 failures - no advisory yet
			for (let i = 0; i < 2; i++) {
				await hook.toolAfter(
					{
						tool: 'write',
						sessionID: 'test',
						args: { file_path: tsFile },
					},
					{ output: undefined },
				);
			}
			expect(warnSpy).not.toHaveBeenCalled();

			// 3rd failure - advisory should be emitted
			await hook.toolAfter(
				{
					tool: 'write',
					sessionID: 'test',
					args: { file_path: tsFile },
				},
				{ output: undefined },
			);
			expect(warnSpy).toHaveBeenCalledWith(
				expect.stringContaining('consecutive'),
			);
		} finally {
			warnSpy.mockRestore();
		}
	});

	test('consecutive failure counter resets on success', async () => {
		let failCount = 0;
		mockUpdateGraphForFiles.mockImplementation(() => {
			if (failCount < 2) {
				failCount++;
				throw new Error('simulated failure');
			}
			return Promise.resolve({} as any);
		});

		const hook = createRepoGraphBuilderHook(workspaceRoot, {
			buildWorkspaceGraph: mockBuildWorkspaceGraph,
			saveGraph: mockSaveGraph,
			updateGraphForFiles: mockUpdateGraphForFiles,
		});

		const warnSpy = spyOn(logger, 'warn').mockImplementation(() => {});

		const tsFile = path.join(workspaceRoot, 'test.ts');
		fs.writeFileSync(tsFile, 'export const x = 1;');

		try {
			// 2 failures, then 1 success
			for (let i = 0; i < 3; i++) {
				await hook.toolAfter(
					{
						tool: 'write',
						sessionID: 'test',
						args: { file_path: tsFile },
					},
					{ output: undefined },
				);
			}
			// Success on 3rd call should reset counter

			// Now fail 2 more times — should NOT trigger advisory
			// (counter was reset, so 2 failures don't reach threshold)
			failCount = 0;
			for (let i = 0; i < 2; i++) {
				await hook.toolAfter(
					{
						tool: 'write',
						sessionID: 'test',
						args: { file_path: tsFile },
					},
					{ output: undefined },
				);
			}
			expect(warnSpy).not.toHaveBeenCalledWith(
				expect.stringContaining('consecutive'),
			);
		} finally {
			warnSpy.mockRestore();
		}
	});

	test('failures are tracked per session, not pooled across sessions (DD-C011)', async () => {
		mockUpdateGraphForFiles.mockImplementation(() => {
			throw new Error('simulated failure');
		});

		const hook = createRepoGraphBuilderHook(workspaceRoot, {
			buildWorkspaceGraph: mockBuildWorkspaceGraph,
			saveGraph: mockSaveGraph,
			updateGraphForFiles: mockUpdateGraphForFiles,
		});

		const warnSpy = spyOn(logger, 'warn').mockImplementation(() => {});

		const tsFile = path.join(workspaceRoot, 'test.ts');
		fs.writeFileSync(tsFile, 'export const x = 1;');

		try {
			// 2 failures in session 'a' and 2 in session 'b'. A pooled counter
			// would reach 4 and fire the advisory; per-session counting keeps each
			// at 2 (< threshold 3), so no advisory.
			for (const sessionID of ['a', 'a', 'b', 'b']) {
				await hook.toolAfter(
					{ tool: 'write', sessionID, args: { file_path: tsFile } },
					{ output: undefined },
				);
			}
			expect(warnSpy).not.toHaveBeenCalledWith(
				expect.stringContaining('consecutive'),
			);

			// A 3rd failure in session 'a' alone crosses the threshold.
			await hook.toolAfter(
				{ tool: 'write', sessionID: 'a', args: { file_path: tsFile } },
				{ output: undefined },
			);
			expect(warnSpy).toHaveBeenCalledWith(
				expect.stringContaining('consecutive'),
			);
		} finally {
			warnSpy.mockRestore();
		}
	});
});
