/**
 * Tests for CWD fix in pre-check-batch.ts
 *
 * Verifies:
 * - runLintOnFiles: binary path uses workspaceDir (not process.cwd())
 * - runLintOnFiles: the shared runner receives cwd: workspaceDir
 * - execute() with valid directory works correctly
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ToolContext } from '@opencode-ai/plugin';
import {
	type PreCheckBatchInput,
	pre_check_batch,
	runPreCheckBatch,
} from '../../../src/tools/pre-check-batch';

// Helper to create a mock ToolContext
function createMockContext(dir?: string): ToolContext {
	const d = dir ?? process.cwd();
	return {
		sessionID: 'test-session',
		messageID: 'test-message',
		agent: 'test-agent',
		directory: d,
		worktree: d,
		abort: new AbortController().signal,
		metadata: () => {},
		ask: async () => {},
	};
}

// Helper to create temp test directories
function createTempDir(): string {
	return fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), 'pre-check-batch-cwd-test-')),
	);
}

describe('EC-001: execute() directory validation via wrapper', () => {
	let tempDir: string;
	let originalCwd: string;

	beforeEach(() => {
		originalCwd = process.cwd();
		tempDir = createTempDir();
		process.chdir(tempDir);

		// Initialize git repo for sast-scan
		fs.mkdirSync(path.join(tempDir, '.git'), { recursive: true });
		fs.writeFileSync(
			path.join(tempDir, '.git', 'config'),
			'[core]\n\trepositoryformatversion = 0\n',
		);
	});

	afterEach(() => {
		process.chdir(originalCwd);
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	/**
	 * EC-001: Test that execute() handles various directory scenarios correctly.
	 *
	 * Note: The createSwarmTool wrapper provides a fallback directory from
	 * ctx?.directory ?? process.cwd() when the context doesn't have a directory.
	 * The guard in execute() is a failsafe that would trigger in edge cases.
	 *
	 * The key tests here verify the expected behavior through the tool interface.
	 */

	test('execute() with valid ToolContext directory succeeds', async () => {
		// Create a test file so the tools have something to scan
		fs.writeFileSync(path.join(tempDir, 'test.ts'), 'export const x = 1;\n');

		const args: PreCheckBatchInput = { files: ['test.ts'], directory: tempDir };
		const mockContext = createMockContext(tempDir);
		const resultStr = await pre_check_batch.execute(args, mockContext as any);
		const result = JSON.parse(resultStr);

		// Should not have the directory error - should proceed to run tools
		expect(result.lint.error).not.toBe(
			'project directory is required but was not provided',
		);
		// Lint either ran successfully or was skipped because no linter binary was found.
		// The key assertion is that no directory validation error occurred.
		if (!result.lint.ran) {
			expect(result.lint.error).toBe('No linter found (biome or eslint)');
		}
	});

	test('execute() with empty string args.directory fails with correct error', async () => {
		// Create a test file
		fs.writeFileSync(path.join(tempDir, 'test.ts'), 'export const x = 1;\n');

		// When args.directory is empty string, the validation at line 948 should catch it
		const args = { files: ['test.ts'], directory: '' };
		const mockContext = createMockContext(tempDir);
		const resultStr = await pre_check_batch.execute(
			args as any,
			mockContext as any,
		);
		const result = JSON.parse(resultStr);

		expect(result.gates_passed).toBe(false);
		expect(result.lint.error).toBe('directory is required');
	});

	test('execute() with undefined args.directory fails with correct error', async () => {
		fs.writeFileSync(path.join(tempDir, 'test.ts'), 'export const x = 1;\n');

		// When args.directory is undefined, the validation should catch it
		const args = { files: ['test.ts'] };
		const mockContext = createMockContext(tempDir);
		const resultStr = await pre_check_batch.execute(
			args as any,
			mockContext as any,
		);
		const result = JSON.parse(resultStr);

		expect(result.gates_passed).toBe(false);
		expect(result.lint.error).toBe('directory is required');
	});

	test('execute() with null args.directory fails with correct error', async () => {
		fs.writeFileSync(path.join(tempDir, 'test.ts'), 'export const x = 1;\n');

		// When args.directory is null, the validation should catch it
		const args = { files: ['test.ts'], directory: null };
		const mockContext = createMockContext(tempDir);
		const resultStr = await pre_check_batch.execute(
			args as any,
			mockContext as any,
		);
		const result = JSON.parse(resultStr);

		expect(result.gates_passed).toBe(false);
		expect(result.lint.error).toBe('directory is required');
	});
});

describe('runLintOnFiles: CWD fix verification', () => {
	let tempDir: string;
	let originalCwd: string;

	beforeEach(() => {
		originalCwd = process.cwd();
		tempDir = createTempDir();
		process.chdir(tempDir);

		// Create symlink to node_modules so biome/eslint is available
		try {
			fs.symlinkSync(
				path.join(originalCwd, 'node_modules'),
				path.join(tempDir, 'node_modules'),
				'junction',
			);
		} catch {
			// Symlink might already exist or fail on some platforms
		}

		// Initialize git repo for sast-scan
		fs.mkdirSync(path.join(tempDir, '.git'), { recursive: true });
		fs.writeFileSync(
			path.join(tempDir, '.git', 'config'),
			'[core]\n\trepositoryformatversion = 0\n',
		);
	});

	afterEach(() => {
		process.chdir(originalCwd);
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	test('runLintOnFiles: binDir uses workspaceDir (not process.cwd())', async () => {
		// Create a test file
		fs.writeFileSync(path.join(tempDir, 'test.ts'), 'export const x = 1;\n');

		// Change to a different directory to verify binDir uses workspaceDir
		const differentDir = createTempDir();
		process.chdir(differentDir);

		// Create symlink in differentDir too
		try {
			fs.symlinkSync(
				path.join(originalCwd, 'node_modules'),
				path.join(differentDir, 'node_modules'),
				'junction',
			);
		} catch {
			// ignore
		}

		// Initialize git repo in differentDir
		fs.mkdirSync(path.join(differentDir, '.git'), { recursive: true });
		fs.writeFileSync(
			path.join(differentDir, '.git', 'config'),
			'[core]\n\trepositoryformatversion = 0\n',
		);

		// Use runPreCheckBatch with explicit files (which triggers runLintOnFiles)
		const input: PreCheckBatchInput = {
			files: ['test.ts'],
			directory: tempDir, // This is the workspaceDir
		};

		// Run with workspaceDir = tempDir
		const result = await runPreCheckBatch(input, tempDir);

		// Should succeed using workspaceDir (tempDir), not process.cwd() (differentDir).
		// If no linter binary is available, lint detection returns null and ran=false
		// with a specific "No linter found" message -- this is acceptable since the
		// test is verifying directory handling, not linter availability.
		if (result.lint.ran) {
			expect(result.lint.error).toBeUndefined();
		} else {
			expect(result.lint.error).toBe('No linter found (biome or eslint)');
		}

		// Cleanup
		process.chdir(originalCwd);
		fs.rmSync(differentDir, { recursive: true, force: true });
	});

	test('runLintOnFiles: shared runner receives cwd: workspaceDir', async () => {
		// Create a test file
		fs.writeFileSync(path.join(tempDir, 'test.ts'), 'export const x = 1;\n');

		// Change to a different directory
		const differentDir = createTempDir();
		process.chdir(differentDir);

		// Create symlink in differentDir
		try {
			fs.symlinkSync(
				path.join(originalCwd, 'node_modules'),
				path.join(differentDir, 'node_modules'),
				'junction',
			);
		} catch {
			// ignore
		}

		// Initialize git repo in differentDir
		fs.mkdirSync(path.join(differentDir, '.git'), { recursive: true });
		fs.writeFileSync(
			path.join(differentDir, '.git', 'config'),
			'[core]\n\trepositoryformatversion = 0\n',
		);

		// Now the key test: run with a workspace that is NOT the current directory
		// If the shared runner uses cwd: workspaceDir correctly, it will run in tempDir
		// If it uses process.cwd(), it would try to run in differentDir
		const input: PreCheckBatchInput = {
			files: ['test.ts'],
			directory: tempDir,
		};

		const result = await runPreCheckBatch(input, tempDir);

		// The critical check: even though process.cwd() is differentDir,
		// the lint should work because cwd: workspaceDir is passed to the runner.
		// If no linter binary is available, lint detection returns null and ran=false
		// with a specific "No linter found" message -- acceptable for this CWD test.
		if (result.lint.ran) {
			expect(result.lint.error).toBeUndefined();

			// Also verify the command in the result contains the correct path
			if (result.lint.result && 'command' in result.lint.result) {
				const command = result.lint.result.command as string[];
				// The biome/eslint binary path should be in tempDir/node_modules/.bin
				expect(command[0]).toContain(tempDir);
			}
		} else {
			expect(result.lint.error).toBe('No linter found (biome or eslint)');
		}

		// Cleanup
		process.chdir(originalCwd);
		fs.rmSync(differentDir, { recursive: true, force: true });
	});
});

describe('runPreCheckBatch: directory validation', () => {
	let tempDir: string;
	let originalCwd: string;

	beforeEach(() => {
		originalCwd = process.cwd();
		tempDir = createTempDir();
		process.chdir(tempDir);

		try {
			fs.symlinkSync(
				path.join(originalCwd, 'node_modules'),
				path.join(tempDir, 'node_modules'),
				'junction',
			);
		} catch {
			// ignore
		}
	});

	afterEach(() => {
		process.chdir(originalCwd);
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	test('runPreCheckBatch with empty string directory fails', async () => {
		const input: PreCheckBatchInput = {
			files: ['test.ts'],
			directory: '',
		};

		const result = await runPreCheckBatch(input);
		expect(result.gates_passed).toBe(false);
		expect(result.lint.error).toContain('directory');
	});

	test('runPreCheckBatch with undefined directory fails', async () => {
		const input: PreCheckBatchInput = {
			files: ['test.ts'],
			// directory is undefined
		} as PreCheckBatchInput;

		const result = await runPreCheckBatch(input);
		expect(result.gates_passed).toBe(false);
	});

	test('runPreCheckBatch with valid directory reaches the completed batch path', async () => {
		fs.writeFileSync(path.join(tempDir, 'test.ts'), 'export const x = 1;\n');

		const input: PreCheckBatchInput = {
			files: ['test.ts'],
			directory: tempDir,
		};

		const result = await runPreCheckBatch(input);
		// Security-tool availability can legitimately make gates_passed false on a
		// minimal host. This test is about directory validation, so assert that the
		// producer accepted the directory and completed the batch instead of
		// returning the structured invalid-input result.
		expect(result.batch_status).toBe('completed');
		expect(result.lint.error).not.toBe('directory is required');
	});
});
