/**
 * ADVERSARIAL SECURITY TESTS for lint.ts wiring logic
 *
 * This test file attacks the new wiring logic in getAdditionalLinterCommand and runAdditionalLint.
 * Focus: malformed inputs, edge cases, injection attempts, and boundary violations.
 *
 * NO HAPPY PATHS - ONLY ATTACK VECTORS
 */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import * as realFs from 'node:fs';
import * as path from 'node:path';
import {
	getAdditionalLinterCommand,
	MAX_COMMAND_LENGTH,
	MAX_OUTPUT_BYTES,
	runAdditionalLint,
} from '../../../src/tools/lint';

// Mock node:fs
const mockExistsSync = mock();
mock.module('node:fs', () => ({
	...realFs,
	existsSync: (...args: unknown[]) => mockExistsSync(...args),
	default: {
		...realFs,
		existsSync: (...args: unknown[]) => mockExistsSync(...args),
	},
}));

// Mock isCommandAvailable from build/discovery
const mockIsCommandAvailable = mock();
mock.module('../../../src/build/discovery', () => ({
	isCommandAvailable: (...args: unknown[]) => mockIsCommandAvailable(...args),
}));

// Helper to create a mock ReadableStream that works with Response()
const makeStream = (content: string) =>
	new ReadableStream({
		start(controller) {
			controller.enqueue(new TextEncoder().encode(content));
			controller.close();
		},
	});

// ============ Test Suites ============

describe('getAdditionalLinterCommand — injection and path attacks', () => {
	beforeEach(() => {
		mock.reset();
		mockIsCommandAvailable.mockImplementation(() => false);
		mockExistsSync.mockImplementation(() => false);
	});

	it('should not crash with path traversal attempt in cwd (../../etc/passwd)', () => {
		// This is a data-only function, so it should just build the command
		// path.join will normalize the path, but it won't crash
		const result = getAdditionalLinterCommand(
			'checkstyle',
			'check',
			'../../etc/passwd',
		);
		expect(result).toBeDefined();
		expect(Array.isArray(result)).toBe(true);
		// The gradlew check will happen, but since the path doesn't exist, it falls back to mvn
		expect(result).toEqual(['mvn', 'checkstyle:check']);
	});

	it('should not crash with empty string cwd', () => {
		const result = getAdditionalLinterCommand('ruff', 'check', '');
		expect(result).toBeDefined();
		expect(Array.isArray(result)).toBe(true);
		expect(result).toEqual(['ruff', 'check', '.']);
	});

	it('should handle cwd with spaces safely (returned as array element, not shell string)', () => {
		const cwdWithSpaces = '/path/to/my project';
		const result = getAdditionalLinterCommand(
			'checkstyle',
			'check',
			cwdWithSpaces,
		);
		expect(result).toBeDefined();
		expect(Array.isArray(result)).toBe(true);
		// gradlew is not found, falls back to mvn
		expect(result).toEqual(['mvn', 'checkstyle:check']);
	});

	it('should include gradlew path with spaces as array element (safe)', () => {
		const cwdWithSpaces = '/path/to/my project';
		mockExistsSync.mockImplementation((p: string) => {
			// Simulate gradlew.bat exists on Windows
			return p.endsWith('gradlew') || p.endsWith('gradlew.bat');
		});
		mockIsCommandAvailable.mockImplementation(false);

		const result = getAdditionalLinterCommand(
			'checkstyle',
			'check',
			cwdWithSpaces,
		);
		expect(result).toBeDefined();
		expect(Array.isArray(result)).toBe(true);
		// The gradlew path should be a single array element with the full path including spaces
		const gradlewName =
			process.platform === 'win32' ? 'gradlew.bat' : 'gradlew';
		expect(result[0]).toContain(gradlewName);
		expect(result[0]).toContain('my project');
	});

	it('should throw TypeError when cwd is null (not assignable to string type)', () => {
		expect(() => {
			getAdditionalLinterCommand('ruff', 'check', null as unknown as string);
		}).toThrow();
	});

	it('should throw TypeError when cwd is undefined', () => {
		expect(() => {
			getAdditionalLinterCommand(
				'ruff',
				'check',
				undefined as unknown as string,
			);
		}).toThrow();
	});

	it('should handle extremely long cwd that causes command to exceed MAX_COMMAND_LENGTH', () => {
		// Create a very long path (need ~500+ characters for gradlew path + ' checkstyleMain')
		// Use checkstyle because it incorporates the full cwd path into gradlew
		// Need about 500 - ' checkstyleMain' = 487 chars minimum for the gradlew path
		const longSegment = 'a'.repeat(120);
		const longCwd = `/${longSegment}/${longSegment}/${longSegment}/${longSegment}`;
		mockExistsSync.mockImplementation(true);
		mockIsCommandAvailable.mockImplementation(false);

		const result = getAdditionalLinterCommand('checkstyle', 'check', longCwd);
		expect(result).toBeDefined();
		expect(Array.isArray(result)).toBe(true);
		// getAdditionalLinterCommand returns the command regardless of length
		// runAdditionalLint is responsible for checking command length
		const commandStr = result.join(' ');
		expect(commandStr.length).toBeGreaterThan(MAX_COMMAND_LENGTH);
	});

	it('should handle cwd with null bytes (control characters)', () => {
		const cwdWithNull = '/path\0/to/project';
		const result = getAdditionalLinterCommand('ruff', 'check', cwdWithNull);
		expect(result).toBeDefined();
		expect(Array.isArray(result)).toBe(true);
	});

	it('should handle cwd with newline characters', () => {
		const cwdWithNewline = '/path\nto/project';
		const result = getAdditionalLinterCommand('ruff', 'check', cwdWithNewline);
		expect(result).toBeDefined();
		expect(Array.isArray(result)).toBe(true);
	});

	it('should handle cwd with tab characters', () => {
		const cwdWithTab = '/path\tto/project';
		const result = getAdditionalLinterCommand('ruff', 'check', cwdWithTab);
		expect(result).toBeDefined();
		expect(Array.isArray(result)).toBe(true);
	});
});

describe('getAdditionalLinterCommand — Gradlew path edge cases', () => {
	beforeEach(() => {
		mock.reset();
		mockIsCommandAvailable.mockImplementation(false);
	});

	it('should return null gradlew and fall back to gradle when gradlew exists but gradlew.bat does not (on Windows)', () => {
		// Temporarily override platform to Windows
		const originalPlatform = process.platform;
		Object.defineProperty(process, 'platform', {
			value: 'win32',
			writable: true,
		});

		mockExistsSync.mockImplementation((p: string) => {
			// gradlew exists, gradlew.bat does not
			return p.endsWith('gradlew') && !p.endsWith('.bat');
		});
		mockIsCommandAvailable.mockImplementation(
			(cmd: string) => cmd === 'gradle',
		);

		const result = getAdditionalLinterCommand(
			'checkstyle',
			'check',
			'/some/cwd',
		);
		expect(result).toBeDefined();
		expect(Array.isArray(result)).toBe(true);
		// Should fall back to gradle since gradlew.bat is expected on Windows
		expect(result).toEqual(['gradle', 'checkstyleMain']);

		// Restore original platform
		Object.defineProperty(process, 'platform', {
			value: originalPlatform,
			writable: true,
		});
	});

	it('should pick gradlew.bat on Windows when both gradlew and gradlew.bat exist', () => {
		const originalPlatform = process.platform;
		Object.defineProperty(process, 'platform', {
			value: 'win32',
			writable: true,
		});

		mockExistsSync.mockImplementation((p: string) => {
			// Both exist
			return p.endsWith('gradlew.bat') || p.endsWith('gradlew');
		});

		const result = getAdditionalLinterCommand(
			'checkstyle',
			'check',
			'/some/cwd',
		);
		expect(result).toBeDefined();
		expect(Array.isArray(result)).toBe(true);
		// Should use gradlew.bat on Windows
		expect(result[0]).toContain('gradlew.bat');

		Object.defineProperty(process, 'platform', {
			value: originalPlatform,
			writable: true,
		});
	});

	it('should pick gradlew on non-Windows when only gradlew exists', () => {
		const originalPlatform = process.platform;
		Object.defineProperty(process, 'platform', {
			value: 'linux',
			writable: true,
		});

		mockExistsSync.mockImplementation((p: string) => {
			// Only gradlew exists
			return p.endsWith('gradlew') && !p.endsWith('.bat');
		});

		const result = getAdditionalLinterCommand(
			'checkstyle',
			'check',
			'/some/cwd',
		);
		expect(result).toBeDefined();
		expect(Array.isArray(result)).toBe(true);
		// Should use gradlew on Linux
		expect(result[0]).toContain('gradlew');
		expect(result[0]).not.toContain('gradlew.bat');

		Object.defineProperty(process, 'platform', {
			value: originalPlatform,
			writable: true,
		});
	});

	it('should detect gradlew.bat correctly when gradlew does not exist (Windows)', () => {
		const originalPlatform = process.platform;
		Object.defineProperty(process, 'platform', {
			value: 'win32',
			writable: true,
		});

		mockExistsSync.mockImplementation((p: string) => {
			// Only gradlew.bat exists
			return p.endsWith('gradlew.bat');
		});

		const result = getAdditionalLinterCommand(
			'checkstyle',
			'check',
			'/some/cwd',
		);
		expect(result).toBeDefined();
		expect(Array.isArray(result)).toBe(true);
		// Should use gradlew.bat
		expect(result[0]).toContain('gradlew.bat');

		Object.defineProperty(process, 'platform', {
			value: originalPlatform,
			writable: true,
		});
	});
});

describe('runAdditionalLint — resource and error attacks', () => {
	let originalSpawn: typeof Bun.spawn;

	beforeEach(() => {
		mock.reset();
		mockIsCommandAvailable.mockImplementation(false);
		mockExistsSync.mockImplementation(false);
		originalSpawn = Bun.spawn;
	});

	afterEach(() => {
		Bun.spawn = originalSpawn;
	});

	it('should catch Bun.spawn synchronous throw and return error result', async () => {
		Bun.spawn = (() => {
			throw new Error('spawn failed: ENOENT');
		}) as typeof Bun.spawn;

		const result = await runAdditionalLint('ruff', 'check', '/some/cwd');
		expect(result).toEqual({
			success: false,
			mode: 'check',
			linter: 'ruff',
			command: expect.any(Array),
			error: 'Execution failed: spawn failed: ENOENT',
		});
	});

	it('should handle Bun.spawn returning a proc where .exited rejects', async () => {
		const mockProc = {
			stdout: makeStream('stdout'),
			stderr: makeStream(''),
			exited: Promise.reject(new Error('process killed')),
		};
		Bun.spawn = () => mockProc as typeof Bun.spawn;

		const result = await runAdditionalLint('ruff', 'check', '/some/cwd');
		expect(result).toBeDefined();
		// The function should handle this gracefully via the catch block
		// or the Promise.all rejection should propagate
	});

	it('should handle proc.stdout throwing when consumed via Response', async () => {
		// Create a stream that errors when read
		const errorStream = new ReadableStream({
			start(controller) {
				controller.error(new Error('Stream error'));
			},
		});

		const mockProc = {
			stdout: errorStream,
			stderr: makeStream(''),
			exited: Promise.resolve(0),
		};
		Bun.spawn = () => mockProc as typeof Bun.spawn;

		const result = await runAdditionalLint('ruff', 'check', '/some/cwd');
		expect(result).toBeDefined();
	});

	it('should reject command exceeding MAX_COMMAND_LENGTH', async () => {
		// Use checkstyle because it incorporates the cwd path
		// Need about 500 - ' checkstyleMain' = 487 chars minimum for the gradlew path
		const longSegment = 'a'.repeat(120);
		const longCwd = `/${longSegment}/${longSegment}/${longSegment}/${longSegment}`;
		mockExistsSync.mockImplementation(true);
		mockIsCommandAvailable.mockImplementation(false);

		const command = getAdditionalLinterCommand('checkstyle', 'check', longCwd);
		const commandStr = command.join(' ');

		expect(commandStr.length).toBeGreaterThan(MAX_COMMAND_LENGTH);

		// runAdditionalLint should reject this early
		const result = await runAdditionalLint('checkstyle', 'check', longCwd);
		expect(result).toEqual({
			success: false,
			mode: 'check',
			linter: 'checkstyle',
			command,
			error: 'Command exceeds maximum allowed length',
		});
	});

	it('should NOT truncate output exactly at MAX_OUTPUT_BYTES boundary', async () => {
		// Create output exactly at the boundary
		const exactOutput = 'x'.repeat(MAX_OUTPUT_BYTES);

		const mockProc = {
			stdout: makeStream(exactOutput),
			stderr: makeStream(''),
			exited: Promise.resolve(0),
		};
		Bun.spawn = () => mockProc as typeof Bun.spawn;

		const result = await runAdditionalLint('ruff', 'check', '/some/cwd');
		expect(result.success).toBe(true);
		expect(result.output).not.toContain('truncated');
		expect(result.output.length).toBe(MAX_OUTPUT_BYTES);
	});

	it('should truncate output at MAX_OUTPUT_BYTES + 1', async () => {
		// Create output just over the boundary
		const overLimitOutput = 'x'.repeat(MAX_OUTPUT_BYTES + 1);

		const mockProc = {
			stdout: makeStream(overLimitOutput),
			stderr: makeStream(''),
			exited: Promise.resolve(0),
		};
		Bun.spawn = () => mockProc as typeof Bun.spawn;

		const result = await runAdditionalLint('ruff', 'check', '/some/cwd');
		expect(result.success).toBe(true);
		expect(result.output).toContain('... (output truncated)');
		expect(result.output.length).toBeLessThanOrEqual(
			MAX_OUTPUT_BYTES + '... (output truncated)'.length + 1,
		);
	});

	it('should handle extremely large stderr with no stdout', async () => {
		const largeStderr = 'y'.repeat(MAX_OUTPUT_BYTES + 1000);

		const mockProc = {
			stdout: makeStream(''),
			stderr: makeStream(largeStderr),
			exited: Promise.resolve(1),
		};
		Bun.spawn = () => mockProc as typeof Bun.spawn;

		const result = await runAdditionalLint('ruff', 'check', '/some/cwd');
		expect(result.success).toBe(true);
		// stderr should appear in output
		expect(result.output).toBeTruthy();
		expect(result.output).toContain('... (output truncated)');
	});

	it('should handle both stdout and stderr being large (combined exceeding MAX_OUTPUT_BYTES)', async () => {
		const halfLimit = Math.floor(MAX_OUTPUT_BYTES / 2);
		const largeStdout = 'x'.repeat(halfLimit + 1000);
		const largeStderr = 'y'.repeat(halfLimit + 1000);

		const mockProc = {
			stdout: makeStream(largeStdout),
			stderr: makeStream(largeStderr),
			exited: Promise.resolve(0),
		};
		Bun.spawn = () => mockProc as typeof Bun.spawn;

		const result = await runAdditionalLint('ruff', 'check', '/some/cwd');
		expect(result.success).toBe(true);
		// Combined output should be truncated
		expect(result.output).toContain('... (output truncated)');
		// Should contain both stdout and stderr content (up to limit)
		expect(result.output).toContain('x');
		expect(result.output).toContain('y');
	});

	it('should handle Bun.spawn throwing non-Error objects', async () => {
		Bun.spawn = (() => {
			throw 'string error';
		}) as typeof Bun.spawn;

		const result = await runAdditionalLint('ruff', 'check', '/some/cwd');
		expect(result).toEqual({
			success: false,
			mode: 'check',
			linter: 'ruff',
			command: expect.any(Array),
			error: 'Execution failed: unknown error',
		});
	});

	it('should handle Bun.spawn throwing null', async () => {
		Bun.spawn = (() => {
			throw null;
		}) as typeof Bun.spawn;

		const result = await runAdditionalLint('ruff', 'check', '/some/cwd');
		expect(result).toEqual({
			success: false,
			mode: 'check',
			linter: 'ruff',
			command: expect.any(Array),
			error: 'Execution failed: unknown error',
		});
	});

	it('should handle Bun.spawn throwing undefined', async () => {
		Bun.spawn = (() => {
			throw undefined;
		}) as typeof Bun.spawn;

		const result = await runAdditionalLint('ruff', 'check', '/some/cwd');
		expect(result).toEqual({
			success: false,
			mode: 'check',
			linter: 'ruff',
			command: expect.any(Array),
			error: 'Execution failed: unknown error',
		});
	});

	it('should handle process with extremely large exit code', async () => {
		const mockProc = {
			stdout: makeStream(''),
			stderr: makeStream(''),
			exited: Promise.resolve(999999),
		};
		Bun.spawn = () => mockProc as typeof Bun.spawn;

		const result = await runAdditionalLint('ruff', 'check', '/some/cwd');
		expect(result.success).toBe(true);
		expect(result.exitCode).toBe(999999);
		expect(result.message).toContain('exit code 999999');
	});

	it('should handle negative exit code (if system allows it)', async () => {
		const mockProc = {
			stdout: makeStream(''),
			stderr: makeStream(''),
			exited: Promise.resolve(-1),
		};
		Bun.spawn = () => mockProc as typeof Bun.spawn;

		const result = await runAdditionalLint('ruff', 'check', '/some/cwd');
		expect(result.success).toBe(true);
		expect(result.exitCode).toBe(-1);
	});
});

describe('getAdditionalLinterCommand — type safety edge cases', () => {
	beforeEach(() => {
		mock.reset();
	});

	it('should return undefined for null linter (bypasses TypeScript type check)', () => {
		// TypeScript prevents this at compile time, but runtime behavior should be documented
		// Invalid linter falls through to default case in switch, returning undefined
		const result = getAdditionalLinterCommand(null as any, 'check', '/cwd');
		expect(result).toBeUndefined();
	});

	it('should return undefined for undefined linter (bypasses TypeScript type check)', () => {
		// TypeScript prevents this at compile time, but runtime behavior should be documented
		const result = getAdditionalLinterCommand(
			undefined as any,
			'check',
			'/cwd',
		);
		expect(result).toBeUndefined();
	});

	it('should return check mode for non-fix mode strings (runtime behavior)', () => {
		// TypeScript prevents this at compile time (mode must be 'fix' | 'check')
		// At runtime, any non-'fix' value falls through to check mode
		const result = getAdditionalLinterCommand('ruff', 'invalid' as any, '/cwd');
		// The function checks `if (mode === 'fix')` so invalid values get check mode
		expect(result).toEqual(['ruff', 'check', '.']);
	});

	it('should return check mode for numeric mode (runtime behavior)', () => {
		// TypeScript prevents this at compile time
		// At runtime, 123 is not 'fix', so it falls through to check mode
		const result = getAdditionalLinterCommand('ruff', 123 as any, '/cwd');
		expect(result).toEqual(['ruff', 'check', '.']);
	});
});
