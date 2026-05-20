/**
 * Verification tests for repoGraphHook.toolAfter wiring in src/index.ts
 *
 * These tests verify:
 * 1. The wiring exists at line 1055 calling safeHook(repoGraphHook.toolAfter)
 * 2. safeHook wrapping means failures don't crash the chain
 * 3. Hook placement is after compactionServiceHook and before output truncation
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
import { readFileSync } from 'node:fs';
import * as path from 'node:path';

// Mock functions for dependency injection
const mockBuildWorkspaceGraph = mock(() => ({
	metadata: { nodeCount: 42, edgeCount: 7 },
}));
const mockSaveGraph = mock(() => Promise.resolve());
const mockUpdateGraphForFiles = mock(() => Promise.resolve({}));

// Create a real temp workspace directory for cross-platform compatibility
const tempWorkspace = fs.mkdtempSync(
	path.join(process.cwd(), 'repo-graph-wiring-test-'),
);

// Cleanup temp workspace at end of all tests
afterAll(() => {
	try {
		fs.rmSync(tempWorkspace, { recursive: true, force: true });
	} catch {
		// Ignore cleanup errors
	}
});

// Import after mocking
import { createRepoGraphBuilderHook } from '../../../src/hooks/repo-graph-builder';
import { safeHook } from '../../../src/hooks/utils';

describe('repoGraphHook.toolAfter wiring verification', () => {
	const workspaceRoot = tempWorkspace;

	beforeEach(() => {
		mockUpdateGraphForFiles.mockClear();
		mockUpdateGraphForFiles.mockImplementation(() => Promise.resolve({}));
	});

	describe('Wiring existence in src/index.ts', () => {
		test('safeHook(repoGraphHook.toolAfter) call exists at line 1055', () => {
			// Read the source file to verify the wiring exists
			const indexPath = path.resolve(__dirname, '../../../src/index.ts');
			const sourceCode = readFileSync(indexPath, 'utf-8');
			const lines = sourceCode.split('\n');

			// Find the line with the repo graph wiring
			const wiringLine = lines.findIndex(
				(line) =>
					line.includes('safeHook(repoGraphHook.toolAfter)') &&
					line.includes('await'),
			);

			expect(wiringLine).not.toBe(-1);

			// Verify the line number is in a plausible range (allowing for file growth)
			const actualLineNum = wiringLine + 1;
			expect(actualLineNum).toBeGreaterThanOrEqual(1050);
			expect(actualLineNum).toBeLessThanOrEqual(1600);
		});

		test('wiring comment "Repo graph incremental update on write tools" exists', () => {
			const indexPath = path.resolve(__dirname, '../../../src/index.ts');
			const sourceCode = readFileSync(indexPath, 'utf-8');

			expect(sourceCode).toContain(
				'Repo graph incremental update on write tools',
			);
		});
	});

	describe('Hook placement order verification', () => {
		test('compactionServiceHook.toolAfter is called BEFORE repoGraphHook.toolAfter', () => {
			const indexPath = path.resolve(__dirname, '../../../src/index.ts');
			const sourceCode = readFileSync(indexPath, 'utf-8');
			const lines = sourceCode.split('\n');

			const compactionLine = lines.findIndex(
				(line) =>
					line.includes('compactionServiceHook') && line.includes('toolAfter'),
			);
			const repoGraphLine = lines.findIndex(
				(line) =>
					line.includes('safeHook(repoGraphHook.toolAfter)') &&
					line.includes('await'),
			);

			expect(compactionLine).toBeLessThan(repoGraphLine);
		});

		test('repoGraphHook.toolAfter is called BEFORE tool output truncation', () => {
			const indexPath = path.resolve(__dirname, '../../../src/index.ts');
			const sourceCode = readFileSync(indexPath, 'utf-8');
			const lines = sourceCode.split('\n');

			const repoGraphLine = lines.findIndex(
				(line) =>
					line.includes('safeHook(repoGraphHook.toolAfter)') &&
					line.includes('await'),
			);
			const truncationLine = lines.findIndex(
				(line) =>
					line.includes('Tool output truncation') ||
					(line.includes('toolOutputConfig') &&
						line.includes('truncation_enabled')),
			);

			expect(repoGraphLine).toBeLessThan(truncationLine);
			expect(repoGraphLine).not.toBe(-1);
			expect(truncationLine).not.toBe(-1);
		});
	});

	describe('safeHook behavior verification', () => {
		test('safeHook wraps toolAfter and catches errors without throwing', async () => {
			const hook = createRepoGraphBuilderHook(workspaceRoot, {
				buildWorkspaceGraph: mockBuildWorkspaceGraph,
				saveGraph: mockSaveGraph,
				updateGraphForFiles: mockUpdateGraphForFiles,
			});

			// Make updateGraphForFiles throw an error
			mockUpdateGraphForFiles.mockImplementation(() => {
				throw new Error('Simulated graph update failure');
			});

			// safeHook-wrapped call should NOT throw
			const safeToolAfter = safeHook(hook.toolAfter);

			await expect(
				safeToolAfter(
					{ tool: 'edit', sessionID: 'test', args: { file_path: 'foo.ts' } },
					{ output: undefined },
				),
			).resolves.toBeUndefined();
		});

		test('safeHook preserves call to toolAfter and updates the graph on success', async () => {
			const hook = createRepoGraphBuilderHook(workspaceRoot, {
				buildWorkspaceGraph: mockBuildWorkspaceGraph,
				saveGraph: mockSaveGraph,
				updateGraphForFiles: mockUpdateGraphForFiles,
			});

			const safeToolAfter = safeHook(hook.toolAfter);

			await safeToolAfter(
				{ tool: 'edit', sessionID: 'test', args: { file_path: 'bar.ts' } },
				{ output: undefined },
			);

			expect(mockUpdateGraphForFiles).toHaveBeenCalledTimes(1);
		});

		test('safeHook-wrapped toolAfter skips non-write tools', async () => {
			const hook = createRepoGraphBuilderHook(workspaceRoot, {
				buildWorkspaceGraph: mockBuildWorkspaceGraph,
				saveGraph: mockSaveGraph,
				updateGraphForFiles: mockUpdateGraphForFiles,
			});

			const safeToolAfter = safeHook(hook.toolAfter);

			await safeToolAfter(
				{ tool: 'read', sessionID: 'test', args: { file_path: 'foo.ts' } },
				{ output: undefined },
			);

			expect(mockUpdateGraphForFiles).not.toHaveBeenCalled();
		});

		test('safeHook-wrapped toolAfter skips unsupported extensions', async () => {
			const hook = createRepoGraphBuilderHook(workspaceRoot, {
				buildWorkspaceGraph: mockBuildWorkspaceGraph,
				saveGraph: mockSaveGraph,
				updateGraphForFiles: mockUpdateGraphForFiles,
			});

			const safeToolAfter = safeHook(hook.toolAfter);

			await safeToolAfter(
				{ tool: 'edit', sessionID: 'test', args: { file_path: 'style.css' } },
				{ output: undefined },
			);

			expect(mockUpdateGraphForFiles).not.toHaveBeenCalled();
		});
	});

	describe('Integration: write tool triggers graph update via wired call', () => {
		test('edit tool with .ts file triggers updateGraphForFiles through safeHook', async () => {
			const hook = createRepoGraphBuilderHook(workspaceRoot, {
				buildWorkspaceGraph: mockBuildWorkspaceGraph,
				saveGraph: mockSaveGraph,
				updateGraphForFiles: mockUpdateGraphForFiles,
			});
			const safeToolAfter = safeHook(hook.toolAfter);

			await safeToolAfter(
				{
					tool: 'edit',
					sessionID: 'test-session',
					args: { file_path: 'src/components/Button.ts' },
				},
				{ output: undefined },
			);

			expect(mockUpdateGraphForFiles).toHaveBeenCalledTimes(1);
			// Verify the absolute path was computed
			const callArgs = mockUpdateGraphForFiles.mock.calls[0];
			expect(callArgs[1][0]).toContain('Button.ts');
		});

		test('write tool with .js file triggers updateGraphForFiles through safeHook', async () => {
			const hook = createRepoGraphBuilderHook(workspaceRoot, {
				buildWorkspaceGraph: mockBuildWorkspaceGraph,
				saveGraph: mockSaveGraph,
				updateGraphForFiles: mockUpdateGraphForFiles,
			});
			const safeToolAfter = safeHook(hook.toolAfter);

			await safeToolAfter(
				{
					tool: 'write',
					sessionID: 'test-session',
					args: { file_path: 'src/utils/helper.js' },
				},
				{ output: undefined },
			);

			expect(mockUpdateGraphForFiles).toHaveBeenCalledTimes(1);
			const callArgs = mockUpdateGraphForFiles.mock.calls[0];
			expect(callArgs[1][0]).toContain('helper.js');
		});

		test('patch tool with .py file triggers updateGraphForFiles through safeHook', async () => {
			const hook = createRepoGraphBuilderHook(workspaceRoot, {
				buildWorkspaceGraph: mockBuildWorkspaceGraph,
				saveGraph: mockSaveGraph,
				updateGraphForFiles: mockUpdateGraphForFiles,
			});
			const safeToolAfter = safeHook(hook.toolAfter);

			await safeToolAfter(
				{
					tool: 'patch',
					sessionID: 'test-session',
					args: { path: 'scripts/migrate.py' },
				},
				{ output: undefined },
			);

			expect(mockUpdateGraphForFiles).toHaveBeenCalledTimes(1);
		});

		test('create_file tool with .tsx file triggers updateGraphForFiles through safeHook', async () => {
			const hook = createRepoGraphBuilderHook(workspaceRoot, {
				buildWorkspaceGraph: mockBuildWorkspaceGraph,
				saveGraph: mockSaveGraph,
				updateGraphForFiles: mockUpdateGraphForFiles,
			});
			const safeToolAfter = safeHook(hook.toolAfter);

			await safeToolAfter(
				{
					tool: 'create_file',
					sessionID: 'test-session',
					args: { filePath: 'src/components/Modal.tsx' },
				},
				{ output: undefined },
			);

			expect(mockUpdateGraphForFiles).toHaveBeenCalledTimes(1);
		});

		test('insert tool with .mjs file triggers updateGraphForFiles through safeHook', async () => {
			const hook = createRepoGraphBuilderHook(workspaceRoot, {
				buildWorkspaceGraph: mockBuildWorkspaceGraph,
				saveGraph: mockSaveGraph,
				updateGraphForFiles: mockUpdateGraphForFiles,
			});
			const safeToolAfter = safeHook(hook.toolAfter);

			await safeToolAfter(
				{
					tool: 'insert',
					sessionID: 'test-session',
					args: { path: 'src/helpers/utils.mjs' },
				},
				{ output: undefined },
			);

			expect(mockUpdateGraphForFiles).toHaveBeenCalledTimes(1);
		});
	});

	describe('Error isolation: safeHook protects the chain', () => {
		test('failure in toolAfter does not propagate when wrapped in safeHook', async () => {
			const hook = createRepoGraphBuilderHook(workspaceRoot, {
				buildWorkspaceGraph: mockBuildWorkspaceGraph,
				saveGraph: mockSaveGraph,
				updateGraphForFiles: mockUpdateGraphForFiles,
			});

			// Make the underlying function throw
			mockUpdateGraphForFiles.mockImplementation(() => {
				throw new Error('Graph update crashed');
			});

			const safeToolAfter = safeHook(hook.toolAfter);

			// This should NOT throw - safeHook catches it
			await expect(
				safeToolAfter(
					{ tool: 'edit', sessionID: 'test', args: { file_path: 'foo.ts' } },
					{ output: undefined },
				),
			).resolves.toBeUndefined();
		});

		test('failure in toolAfter (rejection) does not propagate when wrapped in safeHook', async () => {
			const hook = createRepoGraphBuilderHook(workspaceRoot, {
				buildWorkspaceGraph: mockBuildWorkspaceGraph,
				saveGraph: mockSaveGraph,
				updateGraphForFiles: mockUpdateGraphForFiles,
			});

			// Make the underlying function reject
			mockUpdateGraphForFiles.mockImplementation(() =>
				Promise.reject(new Error('Graph update rejected')),
			);

			const safeToolAfter = safeHook(hook.toolAfter);

			// This should NOT throw - safeHook catches it
			await expect(
				safeToolAfter(
					{ tool: 'edit', sessionID: 'test', args: { file_path: 'foo.ts' } },
					{ output: undefined },
				),
			).resolves.toBeUndefined();
		});

		test('multiple sequential safeHook calls - one failure does not affect others', async () => {
			const hook = createRepoGraphBuilderHook(workspaceRoot, {
				buildWorkspaceGraph: mockBuildWorkspaceGraph,
				saveGraph: mockSaveGraph,
				updateGraphForFiles: mockUpdateGraphForFiles,
			});
			const safeToolAfter = safeHook(hook.toolAfter);

			// First call succeeds
			await safeToolAfter(
				{ tool: 'edit', sessionID: 'test', args: { file_path: 'good.ts' } },
				{ output: undefined },
			);

			// Second call fails
			mockUpdateGraphForFiles.mockImplementation(() => {
				throw new Error('Simulated failure');
			});

			await expect(
				safeToolAfter(
					{ tool: 'edit', sessionID: 'test', args: { file_path: 'bad.ts' } },
					{ output: undefined },
				),
			).resolves.toBeUndefined();

			// Third call succeeds again - chain is not broken
			mockUpdateGraphForFiles.mockImplementation(() => Promise.resolve({}));

			await safeToolAfter(
				{ tool: 'edit', sessionID: 'test', args: { file_path: 'recovery.ts' } },
				{ output: undefined },
			);

			expect(mockUpdateGraphForFiles).toHaveBeenCalledTimes(3);
		});
	});

	describe('Hook creation and initialization', () => {
		test('createRepoGraphBuilderHook returns object with init and toolAfter methods', () => {
			const hook = createRepoGraphBuilderHook(workspaceRoot, {
				buildWorkspaceGraph: mockBuildWorkspaceGraph,
				saveGraph: mockSaveGraph,
				updateGraphForFiles: mockUpdateGraphForFiles,
			});

			expect(hook).toHaveProperty('init');
			expect(hook).toHaveProperty('toolAfter');
			expect(typeof hook.init).toBe('function');
			expect(typeof hook.toolAfter).toBe('function');
		});

		test('repoGraphHook is created and initialized at lines 162-163 in src/index.ts', () => {
			const indexPath = path.resolve(__dirname, '../../../src/index.ts');
			const sourceCode = readFileSync(indexPath, 'utf-8');
			const lines = sourceCode.split('\n');

			// Find createRepoGraphBuilderHook call (the actual usage, not import)
			// Looking for: const repoGraphHook = createRepoGraphBuilderHook(
			const createLine = lines.findIndex(
				(line) =>
					line.includes('const repoGraphHook') &&
					line.includes('createRepoGraphBuilderHook'),
			);
			expect(createLine).not.toBe(-1);
			// Line number range grows as file grows; allow a wide upper bound
			expect(createLine + 1).toBeGreaterThanOrEqual(160);
			expect(createLine + 1).toBeLessThanOrEqual(500);

			// After creation, init is dispatched via queueMicrotask (not called inline)
			const nextLine = lines[createLine + 1];
			expect(
				nextLine.includes('repoGraphHook.init()') ||
					nextLine.includes('queueMicrotask'),
			).toBe(true);
		});
	});
});
