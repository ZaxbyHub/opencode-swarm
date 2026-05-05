/**
 * Verification tests for repo-graph-builder.ts workspace boundary validation
 * Tests: files inside/outside workspace, path traversal, edge cases
 *
 * Uses the DI pattern (deps parameter of createRepoGraphBuilderHook) instead
 * of mock.module for consistent mock isolation per project testing standards.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { createRepoGraphBuilderHook } from '../../../src/hooks/repo-graph-builder';

// Create DI mock functions at top level
const mockUpdateGraphForFiles = mock(() => Promise.resolve({} as any));
const mockBuildWorkspaceGraph = mock(() =>
	Promise.resolve({
		metadata: { nodeCount: 0, edgeCount: 0 },
	} as any),
);
const mockSaveGraph = mock(() => Promise.resolve());

describe('repo-graph-builder workspace boundary validation', () => {
	let tempDir: string;
	let workspaceRoot: string;

	beforeEach(() => {
		mockUpdateGraphForFiles.mockClear();
		mockBuildWorkspaceGraph.mockClear();
		mockSaveGraph.mockClear();
		// Create a real temp workspace directory
		tempDir = fs.mkdtempSync(
			path.join(os.tmpdir(), 'repo-graph-boundary-test-'),
		);
		workspaceRoot = tempDir;
	});

	afterEach(() => {
		// Clean up temp directory
		try {
			fs.rmSync(tempDir, { recursive: true, force: true });
		} catch {
			// Ignore cleanup errors
		}
	});

	function makeHook() {
		return createRepoGraphBuilderHook(workspaceRoot, {
			updateGraphForFiles: mockUpdateGraphForFiles,
			buildWorkspaceGraph: mockBuildWorkspaceGraph,
			saveGraph: mockSaveGraph,
		});
	}

	function makeToolInput(filePath: string) {
		return {
			tool: 'write',
			sessionID: 'test',
			args: { file_path: filePath },
		};
	}

	// ─────────────────────────────────────────────────────────────────
	// HAPPY PATH: Files inside workspace should trigger updateGraphForFiles
	// ─────────────────────────────────────────────────────────────────

	test('file inside workspace triggers updateGraphForFiles', async () => {
		const hook = makeHook();

		// Create a file inside workspace
		const filePath = path.join(workspaceRoot, 'src', 'index.ts');
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		fs.writeFileSync(filePath, 'export const x = 1;');

		await hook.toolAfter(makeToolInput(filePath), { output: undefined });

		expect(mockUpdateGraphForFiles).toHaveBeenCalledTimes(1);
		expect(mockUpdateGraphForFiles).toHaveBeenCalledWith(workspaceRoot, [
			filePath,
		]);
	});

	test('relative file path inside workspace triggers updateGraphForFiles', async () => {
		const hook = makeHook();

		// Create a file inside workspace
		const filePath = path.join(workspaceRoot, 'src', 'index.ts');
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		fs.writeFileSync(filePath, 'export const x = 1;');

		// Pass relative path
		await hook.toolAfter(makeToolInput('src/index.ts'), { output: undefined });

		expect(mockUpdateGraphForFiles).toHaveBeenCalledTimes(1);
		expect(mockUpdateGraphForFiles).toHaveBeenCalledWith(workspaceRoot, [
			filePath,
		]);
	});

	// ─────────────────────────────────────────────────────────────────
	// ERROR PATH: Files outside workspace are rejected
	// ─────────────────────────────────────────────────────────────────

	test('absolute file outside workspace is rejected', async () => {
		const hook = makeHook();

		// Create a file OUTSIDE workspace
		const outsideFile = path.join(os.tmpdir(), 'outside-workspace.txt');
		fs.writeFileSync(outsideFile, 'secret');

		await hook.toolAfter(makeToolInput(outsideFile), { output: undefined });

		expect(mockUpdateGraphForFiles).not.toHaveBeenCalled();
	});

	test('relative path resolving outside workspace is rejected', async () => {
		const hook = makeHook();

		// Create a sibling directory
		const siblingDir = path.join(workspaceRoot, '..', 'sibling-workspace');
		fs.mkdirSync(siblingDir, { recursive: true });

		// Pass a relative path that resolves outside workspace
		await hook.toolAfter(makeToolInput('../sibling-workspace/file.txt'), {
			output: undefined,
		});

		expect(mockUpdateGraphForFiles).not.toHaveBeenCalled();
	});

	// ─────────────────────────────────────────────────────────────────
	// BOUNDARY: Path traversal attempts
	// ─────────────────────────────────────────────────────────────────

	test('path traversal attempt ../../../etc/passwd is rejected after resolution', async () => {
		const hook = makeHook();

		// Attempt path traversal to escape workspace
		await hook.toolAfter(makeToolInput('../../../etc/passwd'), {
			output: undefined,
		});

		expect(mockUpdateGraphForFiles).not.toHaveBeenCalled();
	});

	test('absolute path traversal attempt is rejected', async () => {
		const hook = makeHook();

		// Create a sibling directory for the traversal target
		const siblingDir = path.join(workspaceRoot, '..', 'target');
		fs.mkdirSync(siblingDir, { recursive: true });

		// Path that resolves to workspace root's parent or beyond
		const traversalPath = path.join(
			workspaceRoot,
			'..',
			'..',
			'..',
			'target',
			'file.ts',
		);
		await hook.toolAfter(makeToolInput(traversalPath), { output: undefined });

		expect(mockUpdateGraphForFiles).not.toHaveBeenCalled();
	});

	// ─────────────────────────────────────────────────────────────────
	// EDGE CASES: Workspace root and similar names
	// ─────────────────────────────────────────────────────────────────

	test('file at workspace root level is allowed', async () => {
		const hook = makeHook();

		// The boundary check allows: startsWith(workspaceRoot + path.sep) OR equals workspaceRoot
		// A file at workspace root level (not inside a subdirectory) should be allowed
		const rootLevelFile = path.join(workspaceRoot, 'index.ts');
		fs.writeFileSync(rootLevelFile, '// root level file');

		await hook.toolAfter(makeToolInput('index.ts'), { output: undefined });

		expect(mockUpdateGraphForFiles).toHaveBeenCalledTimes(1);
	});

	test('similar-name directory outside workspace is rejected', async () => {
		const hook = makeHook();

		// Create a "similar" directory name that shares prefix but is NOT the workspace
		const similarRoot = path.join(
			os.tmpdir(),
			'repo-graph-boundary-test-similar',
		);
		fs.mkdirSync(similarRoot, { recursive: true });
		const similarFile = path.join(similarRoot, 'file.ts');
		fs.writeFileSync(similarFile, 'similar');

		await hook.toolAfter(makeToolInput(similarFile), { output: undefined });

		expect(mockUpdateGraphForFiles).not.toHaveBeenCalled();
	});

	test('file in parent directory of workspace is rejected', async () => {
		const hook = makeHook();

		// Create a file in the parent of workspace
		const parentFile = path.join(workspaceRoot, '..', 'parent-file.ts');
		fs.writeFileSync(parentFile, 'parent');

		await hook.toolAfter(makeToolInput(parentFile), { output: undefined });

		expect(mockUpdateGraphForFiles).not.toHaveBeenCalled();
	});

	// ─────────────────────────────────────────────────────────────────
	// EDGE CASE: Unsupported extensions filtered before boundary check
	// ─────────────────────────────────────────────────────────────────

	test('unsupported extension is filtered before boundary check', async () => {
		const hook = makeHook();

		// Even a file inside workspace with unsupported extension should not trigger update
		const filePath = path.join(workspaceRoot, 'data.json');
		fs.writeFileSync(filePath, '{}');

		await hook.toolAfter(makeToolInput(filePath), { output: undefined });

		// Should be filtered by isSupportedSourceFile before boundary check
		expect(mockUpdateGraphForFiles).not.toHaveBeenCalled();
	});

	// ─────────────────────────────────────────────────────────────────
	// EDGE CASE: Non-write tools filtered before boundary check
	// ─────────────────────────────────────────────────────────────────

	test('non-write tool is filtered before boundary check', async () => {
		const hook = makeHook();

		const filePath = path.join(workspaceRoot, 'file.ts');
		fs.writeFileSync(filePath, 'content');

		// Send a read tool
		await hook.toolAfter(
			{ tool: 'Read', sessionID: 'test', args: { file_path: filePath } },
			{ output: undefined },
		);

		expect(mockUpdateGraphForFiles).not.toHaveBeenCalled();
	});

	// ─────────────────────────────────────────────────────────────────
	// EDGE CASE: Missing file_path arg filtered before boundary check
	// ─────────────────────────────────────────────────────────────────

	test('missing file_path arg is filtered before boundary check', async () => {
		const hook = makeHook();

		await hook.toolAfter(
			{ tool: 'Write', sessionID: 'test', args: {} },
			{ output: undefined },
		);

		expect(mockUpdateGraphForFiles).not.toHaveBeenCalled();
	});
});
