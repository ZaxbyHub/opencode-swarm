import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	_internals,
	getLinterCommand,
	type LintResult,
	lint,
	runLint,
	type SupportedLinter,
} from '../../../src/tools/lint';

// Mock for Bun.spawn
let originalSpawn: typeof Bun.spawn;
let spawnCalls: Array<{
	cmd: string[];
	opts: { cwd?: string; stdout?: string; stderr?: string };
}> = [];
let mockExitCode: number = 0;
let mockStdout: string = '';
let mockStderr: string = '';
let mockSpawnError: Error | null = null;
const originalResolveLinterCommand = _internals.resolveLinterCommand;

function mockSpawn(
	cmd: string[],
	opts: { cwd?: string; stdout?: string; stderr?: string },
) {
	spawnCalls.push({
		cmd,
		opts: opts as { cwd?: string; stdout?: string; stderr?: string },
	});

	if (mockSpawnError) {
		throw mockSpawnError;
	}

	const encoder = new TextEncoder();
	const stdoutReadable = new ReadableStream({
		start(controller) {
			controller.enqueue(encoder.encode(mockStdout));
			controller.close();
		},
	});
	const stderrReadable = new ReadableStream({
		start(controller) {
			controller.enqueue(encoder.encode(mockStderr));
			controller.close();
		},
	});

	return {
		stdout: stdoutReadable,
		stderr: stderrReadable,
		exited: Promise.resolve(mockExitCode),
		exitCode: mockExitCode,
	} as unknown as ReturnType<typeof Bun.spawn>;
}

describe('lint tool - cwd fix tests', () => {
	beforeEach(() => {
		originalSpawn = Bun.spawn;
		spawnCalls = [];
		mockExitCode = 0;
		mockStdout = '';
		mockStderr = '';
		mockSpawnError = null;
		_internals.resolveLinterCommand = async (linter, directory) => {
			const [executable] = getLinterCommand(linter, 'check', directory);
			return {
				linter,
				executable,
				argsPrefix: [],
				displayPrefix: [executable],
				source: 'legacy-test-probe',
			};
		};
	});

	afterEach(() => {
		Bun.spawn = originalSpawn;
		_internals.resolveLinterCommand = originalResolveLinterCommand;
	});

	// ============ EC-001: Fail-fast guard in execute() ============
	// Note: The wrapper in createSwarmTool provides fallback (process.cwd()) for null/undefined.
	// These tests verify the validation catches invalid directory values when they reach execute().
	describe('execute() - directory validation (EC-001)', () => {
		// Empty string - passes through wrapper, caught by execute validation
		it('should return error for empty string directory', async () => {
			const result = await lint.execute({ mode: 'check' }, {
				directory: '',
			} as any);
			const parsed = JSON.parse(result) as LintResult;

			expect(parsed.success).toBe(false);
			expect(parsed.mode).toBe('check');
			expect(parsed.error).toBe(
				'project directory is required but was not provided',
			);
		});

		// Whitespace - passes through wrapper, caught by execute validation
		it('should return error for whitespace-only directory', async () => {
			const result = await lint.execute({ mode: 'check' }, {
				directory: '   ',
			} as any);
			const parsed = JSON.parse(result) as LintResult;

			expect(parsed.success).toBe(false);
			expect(parsed.mode).toBe('check');
			expect(parsed.error).toBe(
				'project directory is required but was not provided',
			);
		});

		// Non-string - passes through wrapper, caught by execute validation
		it('should return error for non-string directory', async () => {
			const result = await lint.execute({ mode: 'check' }, {
				directory: 123,
			} as any);
			const parsed = JSON.parse(result) as LintResult;

			expect(parsed.success).toBe(false);
			expect(parsed.mode).toBe('check');
			expect(parsed.error).toBe(
				'project directory is required but was not provided',
			);
		});

		// Object - passes through wrapper, caught by execute validation
		it('should return error for object directory', async () => {
			const result = await lint.execute({ mode: 'check' }, {
				directory: { path: '/test' },
			} as any);
			const parsed = JSON.parse(result) as LintResult;

			expect(parsed.success).toBe(false);
			expect(parsed.mode).toBe('check');
			expect(parsed.error).toBe(
				'project directory is required but was not provided',
			);
		});

		// Null/undefined are handled by wrapper fallback (process.cwd()) - not by execute validation
		// This is the actual behavior of createSwarmTool wrapper
		it('should use process.cwd() fallback when directory is null (wrapper behavior)', async () => {
			const result = await lint.execute({ mode: 'check' }, {
				directory: null,
			} as any);
			const parsed = JSON.parse(result) as LintResult;

			// Wrapper provides process.cwd() fallback, so it doesn't return the
			// "project directory is required" error. It proceeds to linter detection.
			// success value depends on whether a linter is available in the environment.
			expect(parsed).toHaveProperty('success');
			if (!parsed.success) {
				expect(parsed.error).not.toContain('project directory is required');
			}
		});

		it('should use process.cwd() fallback when directory is undefined (wrapper behavior)', async () => {
			const result = await lint.execute({ mode: 'check' }, {
				directory: undefined,
			} as any);
			const parsed = JSON.parse(result) as LintResult;

			// Wrapper provides process.cwd() fallback, so it doesn't return the
			// "project directory is required" error. It proceeds to linter detection.
			// success value depends on whether a linter is available in the environment.
			expect(parsed).toHaveProperty('success');
			if (!parsed.success) {
				expect(parsed.error).not.toContain('project directory is required');
			}
		});
	});

	// ============ getLinterCommand - projectDir parameter ============
	describe('getLinterCommand - projectDir parameter', () => {
		it('should build biome binary path from projectDir', () => {
			const projectDir = '/my/project';
			const cmd = getLinterCommand('biome', 'check', projectDir);

			// Should use projectDir, not process.cwd()
			const expectedBiomePath = path.join(
				projectDir,
				'node_modules',
				'.bin',
				process.platform === 'win32' ? 'biome.EXE' : 'biome',
			);
			expect(cmd[0]).toBe(expectedBiomePath);
		});

		it('should build eslint binary path from projectDir', () => {
			const projectDir = '/my/project';
			const cmd = getLinterCommand('eslint', 'check', projectDir);

			// Should use projectDir, not process.cwd()
			const expectedEslintPath = path.join(
				projectDir,
				'node_modules',
				'.bin',
				'eslint',
			);
			expect(cmd[0]).toBe(expectedEslintPath);
		});

		it('should use different paths for different projectDirs', () => {
			const cmd1 = getLinterCommand('biome', 'check', '/project/one');
			const cmd2 = getLinterCommand('biome', 'check', '/project/two');

			// Normalize paths for cross-platform comparison
			const normalized1 = path.normalize(cmd1[0]);
			const normalized2 = path.normalize(cmd2[0]);

			expect(normalized1).not.toBe(normalized2);
			expect(normalized1).toContain(path.normalize('/project/one'));
			expect(normalized2).toContain(path.normalize('/project/two'));
		});

		it('should pass check mode correctly with projectDir', () => {
			const projectDir = '/test/project';
			const cmd = getLinterCommand('biome', 'check', projectDir);

			expect(cmd).toContain('check');
			expect(cmd).toContain('.');
			expect(cmd).not.toContain('--write');
		});

		it('should pass fix mode correctly with projectDir', () => {
			const projectDir = '/test/project';
			const cmd = getLinterCommand('biome', 'fix', projectDir);

			expect(cmd).toContain('check');
			expect(cmd).toContain('--write');
			expect(cmd).toContain('.');
		});
	});

	// ============ runLint - cwd option in Bun.spawn ============
	describe('runLint - cwd option in Bun.spawn', () => {
		it('should pass cwd: directory to Bun.spawn', async () => {
			Bun.spawn = mockSpawn;
			const testDir = '/my/test/project';

			await runLint('biome', 'check', testDir);

			expect(spawnCalls.length).toBe(1);
			expect(spawnCalls[0].opts.cwd).toBe(testDir);
		});

		it('should pass different cwd for different directories', async () => {
			Bun.spawn = mockSpawn;

			await runLint('biome', 'check', '/first/project');
			await runLint('biome', 'check', '/second/project');

			expect(spawnCalls[0].opts.cwd).toBe('/first/project');
			expect(spawnCalls[1].opts.cwd).toBe('/second/project');
		});

		it('should pass directory to getLinterCommand', async () => {
			Bun.spawn = mockSpawn;
			const testDir = '/my/test/project';

			await runLint('biome', 'check', testDir);

			// The command should include the binary path from testDir - normalize for cross-platform
			const normalizedCmd = path.normalize(spawnCalls[0].cmd[0]);
			expect(normalizedCmd).toContain(path.normalize(testDir));
			expect(normalizedCmd).toContain('node_modules');
			expect(normalizedCmd).toContain('.bin');
		});
	});

	// ============ Normal path: valid args and directory ============
	describe('runLint - normal path with valid directory', () => {
		it('should return LintResult shaped object on success', async () => {
			Bun.spawn = mockSpawn;
			mockStdout = 'All files are formatted correctly.';
			mockExitCode = 0;

			const result = await runLint('biome', 'check', '/valid/project');

			// Verify LintResult shape
			expect(result).toHaveProperty('success');
			expect(result).toHaveProperty('mode', 'check');
			expect(result).toHaveProperty('linter', 'biome');
			expect(result).toHaveProperty('command');
			expect(result).toHaveProperty('exitCode');
			expect(result).toHaveProperty('output');
			expect(result).toHaveProperty('message');
		});

		it('should return success:true with valid directory', async () => {
			Bun.spawn = mockSpawn;
			mockStdout = 'Done';
			mockExitCode = 0;

			const result = await runLint('biome', 'check', '/valid/project');

			expect(result.success).toBe(true);
		});

		it('should work with eslint linter', async () => {
			Bun.spawn = mockSpawn;
			mockStdout = 'ESLint ran successfully';
			mockExitCode = 0;

			const result = await runLint('eslint', 'check', '/valid/project');

			expect(result.success).toBe(true);
			expect(result.linter).toBe('eslint');
			expect(spawnCalls[0].opts.cwd).toBe('/valid/project');
		});

		it('should work with fix mode', async () => {
			Bun.spawn = mockSpawn;
			mockStdout = 'Fixed';
			mockExitCode = 0;

			const result = await runLint('biome', 'fix', '/valid/project');

			expect(result.success).toBe(true);
			expect(result.mode).toBe('fix');
			expect(spawnCalls[0].cmd).toContain('--write');
		});

		it('should include directory in command path', async () => {
			Bun.spawn = mockSpawn;
			mockStdout = 'OK';
			mockExitCode = 0;

			const specificDir = '/specific/project/path';
			const result = await runLint('biome', 'check', specificDir);

			// Verify that the binary path uses the specific directory - normalize for cross-platform
			const expectedPath = path.normalize(
				path.join(
					specificDir,
					'node_modules',
					'.bin',
					process.platform === 'win32' ? 'biome.EXE' : 'biome',
				),
			);
			const actualPath = path.normalize(spawnCalls[0].cmd[0]);
			expect(actualPath).toBe(expectedPath);
		});
	});
});
