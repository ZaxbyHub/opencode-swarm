import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	mock,
	spyOn,
} from 'bun:test';
import * as realFs from 'node:fs';
import * as path from 'node:path';
import type {
	AdditionalLinter,
	LintErrorResult,
	LintSuccessResult,
} from '../../../src/tools/lint';
import {
	getAdditionalLinterCommand,
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
const mockIsCommandAvailable = mock(() => true);
mock.module('../../../src/build/discovery', () => ({
	isCommandAvailable: (...args: unknown[]) => mockIsCommandAvailable(...args),
}));

// Mock warn from utils
const mockWarn = mock();
mock.module('../../../src/utils', () => ({
	warn: (...args: unknown[]) => mockWarn(...args),
}));

// Helper to create a mock ReadableStream that works with Response()
const makeStream = (content: string) =>
	new ReadableStream({
		start(controller) {
			controller.enqueue(new TextEncoder().encode(content));
			controller.close();
		},
	});

describe('getAdditionalLinterCommand', () => {
	beforeEach(() => {
		mock.restore();
		mock.clearAllMocks();
		mockIsCommandAvailable.mockImplementation(() => true);
		mockExistsSync.mockImplementation(() => false);
	});

	describe('ruff', () => {
		it('check mode returns ruff check .', () => {
			const result = getAdditionalLinterCommand('ruff', 'check', '/test');
			expect(result).toEqual(['ruff', 'check', '.']);
		});

		it('fix mode returns ruff check --fix .', () => {
			const result = getAdditionalLinterCommand('ruff', 'fix', '/test');
			expect(result).toEqual(['ruff', 'check', '--fix', '.']);
		});
	});

	describe('clippy', () => {
		it('check mode returns cargo clippy', () => {
			const result = getAdditionalLinterCommand('clippy', 'check', '/test');
			expect(result).toEqual(['cargo', 'clippy']);
		});

		it('fix mode returns cargo clippy --fix --allow-dirty', () => {
			const result = getAdditionalLinterCommand('clippy', 'fix', '/test');
			expect(result).toEqual(['cargo', 'clippy', '--fix', '--allow-dirty']);
		});
	});

	describe('golangci-lint', () => {
		it('check mode returns golangci-lint run', () => {
			const result = getAdditionalLinterCommand(
				'golangci-lint',
				'check',
				'/test',
			);
			expect(result).toEqual(['golangci-lint', 'run']);
		});

		it('fix mode returns golangci-lint run --fix', () => {
			const result = getAdditionalLinterCommand(
				'golangci-lint',
				'fix',
				'/test',
			);
			expect(result).toEqual(['golangci-lint', 'run', '--fix']);
		});
	});

	describe('checkstyle', () => {
		it('check mode with gradlew present returns gradlew checkstyleMain', () => {
			// On Windows, the code checks for gradlew.bat, on Unix it checks for gradlew
			// Since we're testing on Windows, we need to mock gradlew.bat, not gradlew
			const isWindows = process.platform === 'win32';
			const gradlewName = isWindows ? 'gradlew.bat' : 'gradlew';
			const gradlewPath = path.join('/test', gradlewName);
			mockExistsSync.mockImplementation((p: string) => {
				// Match both gradlew (Unix) and gradlew.bat (Windows)
				return p.endsWith('gradlew') || p.endsWith('gradlew.bat');
			});
			mockIsCommandAvailable.mockImplementation(false);
			const result = getAdditionalLinterCommand('checkstyle', 'check', '/test');
			expect(result).toEqual([gradlewPath, 'checkstyleMain']);
		});

		it('check mode with no gradlew but gradle available returns gradle checkstyleMain', () => {
			mockExistsSync.mockImplementation(false);
			mockIsCommandAvailable.mockImplementation(
				(cmd: string) => cmd === 'gradle',
			);
			const result = getAdditionalLinterCommand('checkstyle', 'check', '/test');
			expect(result).toEqual(['gradle', 'checkstyleMain']);
		});

		it('check mode with neither gradlew nor gradle returns mvn checkstyle:check', () => {
			mockExistsSync.mockImplementation(false);
			mockIsCommandAvailable.mockImplementation(false);
			const result = getAdditionalLinterCommand('checkstyle', 'check', '/test');
			expect(result).toEqual(['mvn', 'checkstyle:check']);
		});

		it('on Windows with gradlew.bat present returns gradlew.bat checkstyleMain', () => {
			// Mock Windows platform
			const originalPlatform = process.platform;
			Object.defineProperty(process, 'platform', {
				value: 'win32',
				writable: true,
			});

			const gradlewBatPath = path.join('/test', 'gradlew.bat');
			mockExistsSync.mockImplementation((p: string) =>
				p.endsWith('gradlew.bat'),
			);
			mockIsCommandAvailable.mockImplementation(false);
			const result = getAdditionalLinterCommand('checkstyle', 'check', '/test');
			expect(result).toEqual([gradlewBatPath, 'checkstyleMain']);

			// Restore platform
			Object.defineProperty(process, 'platform', {
				value: originalPlatform,
				writable: true,
			});
		});

		it('fix mode with gradlew present returns gradlew checkstyleMain', () => {
			const isWindows = process.platform === 'win32';
			const gradlewName = isWindows ? 'gradlew.bat' : 'gradlew';
			const gradlewPath = path.join('/test', gradlewName);
			mockExistsSync.mockImplementation((p: string) => {
				return p.endsWith('gradlew') || p.endsWith('gradlew.bat');
			});
			mockIsCommandAvailable.mockImplementation(false);
			const result = getAdditionalLinterCommand('checkstyle', 'fix', '/test');
			expect(result).toEqual([gradlewPath, 'checkstyleMain']);
		});
	});

	describe('ktlint', () => {
		it('check mode returns ktlint', () => {
			const result = getAdditionalLinterCommand('ktlint', 'check', '/test');
			expect(result).toEqual(['ktlint']);
		});

		it('fix mode returns ktlint --format', () => {
			const result = getAdditionalLinterCommand('ktlint', 'fix', '/test');
			expect(result).toEqual(['ktlint', '--format']);
		});
	});

	describe('dotnet-format', () => {
		it('check mode returns dotnet format --verify-no-changes', () => {
			const result = getAdditionalLinterCommand(
				'dotnet-format',
				'check',
				'/test',
			);
			expect(result).toEqual(['dotnet', 'format', '--verify-no-changes']);
		});

		it('fix mode returns dotnet format', () => {
			const result = getAdditionalLinterCommand(
				'dotnet-format',
				'fix',
				'/test',
			);
			expect(result).toEqual(['dotnet', 'format']);
		});
	});

	describe('cppcheck', () => {
		it('check mode returns cppcheck --enable=all .', () => {
			const result = getAdditionalLinterCommand('cppcheck', 'check', '/test');
			expect(result).toEqual(['cppcheck', '--enable=all', '.']);
		});

		it('fix mode returns same as check (no fix mode)', () => {
			const result = getAdditionalLinterCommand('cppcheck', 'fix', '/test');
			expect(result).toEqual(['cppcheck', '--enable=all', '.']);
		});
	});

	describe('swiftlint', () => {
		it('check mode returns swiftlint', () => {
			const result = getAdditionalLinterCommand('swiftlint', 'check', '/test');
			expect(result).toEqual(['swiftlint']);
		});

		it('fix mode returns swiftlint --fix', () => {
			const result = getAdditionalLinterCommand('swiftlint', 'fix', '/test');
			expect(result).toEqual(['swiftlint', '--fix']);
		});
	});

	describe('dart-analyze', () => {
		it('check mode returns dart analyze', () => {
			const result = getAdditionalLinterCommand(
				'dart-analyze',
				'check',
				'/test',
			);
			expect(result).toEqual(['dart', 'analyze']);
		});

		it('fix mode returns dart fix', () => {
			const result = getAdditionalLinterCommand('dart-analyze', 'fix', '/test');
			expect(result).toEqual(['dart', 'fix']);
		});
	});

	describe('rubocop', () => {
		it('check mode with bundle available returns bundle exec rubocop', () => {
			mockIsCommandAvailable.mockImplementation(
				(cmd: string) => cmd === 'bundle',
			);
			const result = getAdditionalLinterCommand('rubocop', 'check', '/test');
			expect(result).toEqual(['bundle', 'exec', 'rubocop']);
		});

		it('fix mode with bundle available returns bundle exec rubocop -A', () => {
			mockIsCommandAvailable.mockImplementation(
				(cmd: string) => cmd === 'bundle',
			);
			const result = getAdditionalLinterCommand('rubocop', 'fix', '/test');
			expect(result).toEqual(['bundle', 'exec', 'rubocop', '-A']);
		});

		it('check mode without bundle returns rubocop', () => {
			mockIsCommandAvailable.mockImplementation(false);
			const result = getAdditionalLinterCommand('rubocop', 'check', '/test');
			expect(result).toEqual(['rubocop']);
		});

		it('fix mode without bundle returns rubocop -A', () => {
			mockIsCommandAvailable.mockImplementation(false);
			const result = getAdditionalLinterCommand('rubocop', 'fix', '/test');
			expect(result).toEqual(['rubocop', '-A']);
		});
	});
});

describe('runAdditionalLint', () => {
	let originalSpawn: typeof Bun.spawn;

	beforeEach(() => {
		mock.restore();
		mockIsCommandAvailable.mockImplementation(true);
		mockExistsSync.mockImplementation(false);
		originalSpawn = Bun.spawn;
	});

	afterEach(() => {
		mock.restore();
		Bun.spawn = originalSpawn;
	});

	it('successful ruff check (exit 0) returns LintSuccessResult with success:true and success message', async () => {
		const mockProc = {
			stdout: makeStream('No issues found'),
			stderr: makeStream(''),
			exited: Promise.resolve(0),
		};
		Bun.spawn = mock(() => mockProc) as typeof Bun.spawn;

		const result = await runAdditionalLint('ruff', 'check', '/test');

		expect(result.success).toBe(true);
		expect((result as LintSuccessResult).linter).toBe('ruff');
		expect((result as LintSuccessResult).message).toContain(
			'completed successfully',
		);
		expect((result as LintSuccessResult).exitCode).toBe(0);
	});

	it('ruff check with issues (exit 1) returns LintSuccessResult with success:true and check found issues message', async () => {
		const mockProc = {
			stdout: makeStream('Found 2 issues'),
			stderr: makeStream(''),
			exited: Promise.resolve(1),
		};
		Bun.spawn = mock(() => mockProc) as typeof Bun.spawn;

		const result = await runAdditionalLint('ruff', 'check', '/test');

		expect(result.success).toBe(true);
		expect((result as LintSuccessResult).linter).toBe('ruff');
		expect((result as LintSuccessResult).message).toContain(
			'check found issues',
		);
		expect((result as LintSuccessResult).exitCode).toBe(1);
	});

	it('ruff fix (exit 0) returns LintSuccessResult with success message', async () => {
		const mockProc = {
			stdout: makeStream('Fixed 3 issues'),
			stderr: makeStream(''),
			exited: Promise.resolve(0),
		};
		Bun.spawn = mock(() => mockProc) as typeof Bun.spawn;

		const result = await runAdditionalLint('ruff', 'fix', '/test');

		expect(result.success).toBe(true);
		expect((result as LintSuccessResult).linter).toBe('ruff');
		expect((result as LintSuccessResult).message).toContain(
			'completed successfully',
		);
		expect((result as LintSuccessResult).exitCode).toBe(0);
	});

	it('command execution throws error returns LintErrorResult with success:false and Execution failed error', async () => {
		Bun.spawn = mock(() => () => {
			throw new Error('Command not found');
		}) as typeof Bun.spawn;

		const result = await runAdditionalLint('ruff', 'check', '/test');

		expect(result.success).toBe(false);
		expect((result as LintErrorResult).error).toContain('Execution failed');
	});

	it('output truncation: stdout > MAX_OUTPUT_BYTES results in output ending with truncation message', async () => {
		// Create output that exceeds MAX_OUTPUT_BYTES
		const largeOutput = 'x'.repeat(MAX_OUTPUT_BYTES + 1000);
		const mockProc = {
			stdout: makeStream(largeOutput),
			stderr: makeStream(''),
			exited: Promise.resolve(0),
		};
		Bun.spawn = mock(() => mockProc) as typeof Bun.spawn;

		const result = await runAdditionalLint('ruff', 'check', '/test');

		expect(result.success).toBe(true);
		expect((result as LintSuccessResult).output).toContain(
			'... (output truncated)',
		);
		expect((result as LintSuccessResult).output).toHaveLength(
			MAX_OUTPUT_BYTES + '\n... (output truncated)'.length,
		);
	});

	it('stderr is appended to stdout in output', async () => {
		const mockProc = {
			stdout: makeStream('stdout output'),
			stderr: makeStream('stderr message'),
			exited: Promise.resolve(0),
		};
		Bun.spawn = mock(() => mockProc) as typeof Bun.spawn;

		const result = await runAdditionalLint('ruff', 'check', '/test');

		expect(result.success).toBe(true);
		expect((result as LintSuccessResult).output).toBe(
			'stdout output\nstderr message',
		);
	});

	it('passes cwd to Bun.spawn', async () => {
		const mockProc = {
			stdout: makeStream(''),
			stderr: makeStream(''),
			exited: Promise.resolve(0),
		};
		const mockSpawn = mock(() => mockProc);
		Bun.spawn = mockSpawn as typeof Bun.spawn;

		await runAdditionalLint('ruff', 'check', '/custom/cwd');

		expect(mockSpawn).toHaveBeenCalledWith(
			['ruff', 'check', '.'],
			expect.objectContaining({
				stdout: 'pipe',
				stderr: 'pipe',
				cwd: '/custom/cwd',
			}),
		);
	});
});

describe('Type compatibility', () => {
	it('LintSuccessResult.linter can hold AdditionalLinter values', () => {
		const linters: AdditionalLinter[] = [
			'ruff',
			'clippy',
			'golangci-lint',
			'checkstyle',
			'ktlint',
			'dotnet-format',
			'cppcheck',
			'swiftlint',
			'dart-analyze',
			'rubocop',
		];

		linters.forEach((linter) => {
			const result: LintSuccessResult = {
				success: true,
				mode: 'check',
				linter,
				command: ['mock'],
				exitCode: 0,
				output: 'test',
			};
			expect(result.linter).toBe(linter);
		});
	});

	it('LintErrorResult.linter can hold AdditionalLinter values', () => {
		const linter: AdditionalLinter = 'ruff';
		const result: LintErrorResult = {
			success: false,
			mode: 'check',
			linter,
			command: ['mock'],
			exitCode: 1,
			output: 'test',
			error: 'test error',
		};
		expect(result.linter).toBe('ruff');
	});
});
