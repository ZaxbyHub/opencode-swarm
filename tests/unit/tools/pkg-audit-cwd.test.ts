import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	mock,
	spyOn,
} from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ToolContext } from '@opencode-ai/plugin';

// Mock isCommandAvailable so all ecosystem commands are treated as available
mock.module('../../../src/build/discovery.js', () => ({
	isCommandAvailable: (_cmd: string) => true,
	clearToolchainCache: () => {},
}));

import { pkg_audit } from '../../../src/tools/pkg-audit';

// Mock for Bun.spawn tracking
let spawnCalls: Array<{
	cmd: string[];
	opts: { cwd?: string; stdout?: string; stderr?: string };
}> = [];
let mockExitCode: number = 0;
let mockStdout: string = '';
let mockStderr: string = '';

// Temp directories for tests
let tempDir: string;

function createMockSpawn() {
	return (
		cmd: string[],
		opts: { cwd?: string; stdout?: string; stderr?: string },
	) => {
		spawnCalls.push({
			cmd,
			opts: opts as { cwd?: string; stdout?: string; stderr?: string },
		});

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
	};
}

// Mock existsSync calls tracking
let existsSyncCalls: string[] = [];

function mockExistsSync(filePath: string): boolean {
	existsSyncCalls.push(filePath);
	// Return true for package.json to trigger npm ecosystem detection
	if (filePath.endsWith('package.json')) {
		return true;
	}
	return false;
}

// Helper to create mock context with specific directory
function getMockContext(directory: string): ToolContext {
	return {
		sessionID: 'test-session',
		messageID: 'test-message',
		agent: 'test-agent',
		directory,
		worktree: directory,
		abort: new AbortController().signal,
		metadata: () => ({}),
		ask: async () => undefined,
	};
}

describe('pkg-audit tool - cwd fix tests', () => {
	let BunSpawnSpy: ReturnType<typeof spyOn>;
	let fsExistsSyncSpy: ReturnType<typeof spyOn>;
	let originalCwd: string;

	beforeEach(() => {
		spawnCalls = [];
		existsSyncCalls = [];
		mockExitCode = 0;
		mockStdout = '';
		mockStderr = '';

		// Save current directory and create temp dir
		originalCwd = process.cwd();
		tempDir = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), 'pkg-audit-cwd-test-')),
		);

		// Spy on Bun.spawn
		BunSpawnSpy = spyOn(Bun, 'spawn').mockImplementation(createMockSpawn());

		// Spy on fs.existsSync
		fsExistsSyncSpy = spyOn(fs, 'existsSync').mockImplementation(
			mockExistsSync,
		);
	});

	afterEach(() => {
		mock.restore();
		BunSpawnSpy.mockRestore();
		fsExistsSyncSpy.mockRestore();
		process.chdir(originalCwd);
		// Clean up temp directory
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	// ============ EC-001: Fail-fast guard in execute() ============
	describe('execute() - directory validation (EC-001)', () => {
		// Note: The wrapper in createSwarmTool provides fallback (process.cwd()) for null/undefined.
		// These tests verify the validation catches invalid directory values when they reach execute().

		it('should return error for empty string directory', async () => {
			const result = await pkg_audit.execute(
				{ ecosystem: 'auto' },
				getMockContext(''),
			);
			const parsed = JSON.parse(result);

			expect(parsed.error).toBe(
				'project directory is required but was not provided',
			);
		});

		it('should return error for whitespace-only directory', async () => {
			const result = await pkg_audit.execute(
				{ ecosystem: 'auto' },
				getMockContext('   '),
			);
			const parsed = JSON.parse(result);

			expect(parsed.error).toBe(
				'project directory is required but was not provided',
			);
		});

		it('should return error for newline-only directory', async () => {
			const result = await pkg_audit.execute(
				{ ecosystem: 'auto' },
				getMockContext('\n'),
			);
			const parsed = JSON.parse(result);

			expect(parsed.error).toBe(
				'project directory is required but was not provided',
			);
		});

		// Null/undefined are handled by wrapper fallback (process.cwd()) - not by execute validation
		// This is the actual behavior of createSwarmTool wrapper
		it('should use process.cwd() fallback when directory is null (wrapper behavior)', async () => {
			const result = await pkg_audit.execute({ ecosystem: 'auto' }, {
				directory: null,
			} as any);
			const parsed = JSON.parse(result);

			// Wrapper provides fallback, so it doesn't return error
			// Instead it runs with process.cwd()
			expect(parsed).toHaveProperty('ecosystems');
		});

		it('should use process.cwd() fallback when directory is undefined (wrapper behavior)', async () => {
			const result = await pkg_audit.execute({ ecosystem: 'auto' }, {
				directory: undefined,
			} as any);
			const parsed = JSON.parse(result);

			// Wrapper provides fallback, so it doesn't return error
			// Instead it runs with process.cwd()
			expect(parsed).toHaveProperty('ecosystems');
		});

		// Non-string types are passed through wrapper to execute validation
		it('should return error for numeric directory (wrong type)', async () => {
			const result = await pkg_audit.execute({ ecosystem: 'auto' }, {
				directory: 0,
			} as any);
			const parsed = JSON.parse(result);

			expect(parsed.error).toBe(
				'project directory is required but was not provided',
			);
		});

		it('should return error for object directory (wrong type)', async () => {
			const result = await pkg_audit.execute({ ecosystem: 'auto' }, {
				directory: { path: '/test' },
			} as any);
			const parsed = JSON.parse(result);

			expect(parsed.error).toBe(
				'project directory is required but was not provided',
			);
		});
	});

	// ============ EC-002: detectEcosystems uses directory parameter (via execute) ============
	describe('execute() with auto ecosystem - uses directory parameter', () => {
		it('should use provided directory for ecosystem detection', async () => {
			// Create package.json in tempDir
			fs.writeFileSync(path.join(tempDir, 'package.json'), '{}');

			const result = await pkg_audit.execute(
				{ ecosystem: 'auto' },
				getMockContext(tempDir),
			);
			const parsed = JSON.parse(result);

			// Verify that npm was detected (because package.json exists in tempDir)
			expect(parsed.ecosystems).toContain('npm');
		});
	});

	// ============ EC-003: Each audit function passes cwd: directory to Bun.spawn ============
	describe('execute() - cwd option in Bun.spawn', () => {
		it('npm ecosystem should pass cwd: directory to Bun.spawn', async () => {
			// Create package.json in tempDir
			fs.writeFileSync(path.join(tempDir, 'package.json'), '{}');
			mockExitCode = 0;
			mockStdout = '{}';

			await pkg_audit.execute({ ecosystem: 'npm' }, getMockContext(tempDir));

			expect(spawnCalls.length).toBe(1);
			expect(spawnCalls[0].opts.cwd).toBe(tempDir);
		});

		it('pip ecosystem should pass cwd: directory to Bun.spawn', async () => {
			// Create pyproject.toml in tempDir
			fs.writeFileSync(path.join(tempDir, 'pyproject.toml'), '[project]');
			mockExitCode = 0;
			mockStdout = '[]';

			await pkg_audit.execute({ ecosystem: 'pip' }, getMockContext(tempDir));

			expect(spawnCalls.length).toBe(1);
			expect(spawnCalls[0].opts.cwd).toBe(tempDir);
		});

		it('cargo ecosystem should pass cwd: directory to Bun.spawn', async () => {
			// Create Cargo.toml in tempDir
			fs.writeFileSync(path.join(tempDir, 'Cargo.toml'), '[package]');
			mockExitCode = 0;
			mockStdout = '';

			await pkg_audit.execute({ ecosystem: 'cargo' }, getMockContext(tempDir));

			expect(spawnCalls.length).toBe(1);
			expect(spawnCalls[0].opts.cwd).toBe(tempDir);
		});

		it('dotnet ecosystem should pass cwd: directory to Bun.spawn', async () => {
			// Create .csproj in tempDir
			fs.writeFileSync(
				path.join(tempDir, 'test.csproj'),
				'<Project></Project>',
			);
			mockExitCode = 0;
			mockStdout = '';

			await pkg_audit.execute({ ecosystem: 'dotnet' }, getMockContext(tempDir));

			expect(spawnCalls.length).toBe(1);
			expect(spawnCalls[0].opts.cwd).toBe(tempDir);
		});

		it('auto ecosystem should pass cwd: directory to Bun.spawn', async () => {
			// Create package.json in tempDir to trigger npm detection
			fs.writeFileSync(path.join(tempDir, 'package.json'), '{}');
			mockExitCode = 0;
			mockStdout = '{}';

			await pkg_audit.execute({ ecosystem: 'auto' }, getMockContext(tempDir));

			// At least one audit should be run (npm in this case)
			expect(spawnCalls.length).toBeGreaterThanOrEqual(1);
			expect(spawnCalls[0].opts.cwd).toBe(tempDir);
		});
	});

	// ============ Different directories use different cwd values ============
	describe('execute() - different directories get different cwd', () => {
		it('should use different cwd for different directories', async () => {
			fs.writeFileSync(path.join(tempDir, 'package.json'), '{}');
			mockExitCode = 0;
			mockStdout = '{}';

			// Create two different temp directories
			const tempDir1 = fs.realpathSync(
				fs.mkdtempSync(path.join(os.tmpdir(), 'pkg-audit-test1-')),
			);
			const tempDir2 = fs.realpathSync(
				fs.mkdtempSync(path.join(os.tmpdir(), 'pkg-audit-test2-')),
			);

			fs.writeFileSync(path.join(tempDir1, 'package.json'), '{}');
			fs.writeFileSync(path.join(tempDir2, 'package.json'), '{}');

			await pkg_audit.execute({ ecosystem: 'npm' }, getMockContext(tempDir1));
			await pkg_audit.execute({ ecosystem: 'npm' }, getMockContext(tempDir2));

			expect(spawnCalls[0].opts.cwd).toBe(tempDir1);
			expect(spawnCalls[1].opts.cwd).toBe(tempDir2);

			// Cleanup
			fs.rmSync(tempDir1, { recursive: true, force: true });
			fs.rmSync(tempDir2, { recursive: true, force: true });
		});
	});
});
