import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	mock,
	spyOn,
} from 'bun:test';
import * as path from 'node:path';
import type {
	AdditionalLinter,
	LintErrorResult,
	LintSuccessResult,
} from '../../../src/tools/lint';
import {
	_internals,
	getAdditionalLinterCommand,
	MAX_OUTPUT_BYTES,
	runAdditionalLint,
} from '../../../src/tools/lint';

const originalExistsSync = _internals.existsSync;
const originalIsCommandAvailable = _internals.isCommandAvailable;
const originalPlatform = _internals.platform;
const originalRunExternalTool = _internals.runExternalTool;
const mockExistsSync = mock();
const mockIsCommandAvailable = mock(() => true);
const mockRunExternalTool = mock();

// Mock warn from utils
const mockWarn = mock();
mock.module('../../../src/utils', () => ({
	warn: (...args: unknown[]) => mockWarn(...args),
}));

describe('getAdditionalLinterCommand', () => {
	beforeEach(() => {
		mock.restore();
		mock.clearAllMocks();
		_internals.existsSync = mockExistsSync as typeof _internals.existsSync;
		_internals.isCommandAvailable =
			mockIsCommandAvailable as typeof _internals.isCommandAvailable;
		_internals.platform = () => 'linux';
		mockIsCommandAvailable.mockImplementation(() => true);
		mockExistsSync.mockImplementation(() => false);
	});

	afterEach(() => {
		_internals.existsSync = originalExistsSync;
		_internals.isCommandAvailable = originalIsCommandAvailable;
		_internals.platform = originalPlatform;
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
			_internals.platform = () => 'linux';
			const gradlewPath = path.join('/test', 'gradlew');
			mockExistsSync.mockImplementation((p: string) => {
				return p.endsWith('gradlew') || p.endsWith('checkstyle.xml');
			});
			mockIsCommandAvailable.mockImplementation(() => false);
			const result = getAdditionalLinterCommand('checkstyle', 'check', '/test');
			expect(result).toEqual([gradlewPath, 'checkstyleMain']);
		});

		it('check mode with no gradlew but gradle available returns gradle checkstyleMain', () => {
			mockExistsSync.mockImplementation((p: string) =>
				p.endsWith('checkstyle.xml'),
			);
			mockIsCommandAvailable.mockImplementation(
				(cmd: string) => cmd === 'gradle',
			);
			const result = getAdditionalLinterCommand('checkstyle', 'check', '/test');
			expect(result).toEqual(['gradle', 'checkstyleMain']);
		});

		it('check mode with neither gradlew nor gradle returns mvn checkstyle:check', () => {
			mockExistsSync.mockImplementation((p: string) => p.endsWith('pom.xml'));
			mockIsCommandAvailable.mockImplementation((cmd: string) => cmd === 'mvn');
			const result = getAdditionalLinterCommand('checkstyle', 'check', '/test');
			expect(result).toEqual(['mvn', 'checkstyle:check']);
		});

		it('on Windows with gradlew.bat present returns null when no native tool is available', () => {
			_internals.platform = () => 'win32';
			mockExistsSync.mockImplementation((p: string) =>
				p.endsWith('gradlew.bat'),
			);
			mockIsCommandAvailable.mockImplementation(() => false);
			const result = getAdditionalLinterCommand('checkstyle', 'check', '/test');
			expect(result).toBeNull();
		});

		it('fix mode with gradlew present returns gradlew checkstyleMain', () => {
			_internals.platform = () => 'linux';
			const gradlewPath = path.join('/test', 'gradlew');
			mockExistsSync.mockImplementation((p: string) => {
				return p.endsWith('gradlew') || p.endsWith('checkstyle.xml');
			});
			mockIsCommandAvailable.mockImplementation(() => false);
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
			mockIsCommandAvailable.mockImplementation(
				(command: string) => command === 'rubocop',
			);
			const result = getAdditionalLinterCommand('rubocop', 'check', '/test');
			expect(result).toEqual(['rubocop']);
		});

		it('fix mode without bundle returns rubocop -A', () => {
			mockIsCommandAvailable.mockImplementation(
				(command: string) => command === 'rubocop',
			);
			const result = getAdditionalLinterCommand('rubocop', 'fix', '/test');
			expect(result).toEqual(['rubocop', '-A']);
		});
	});
});

describe('runAdditionalLint', () => {
	beforeEach(() => {
		mock.restore();
		mock.clearAllMocks();
		mockIsCommandAvailable.mockImplementation(() => true);
		mockExistsSync.mockImplementation(() => false);
		_internals.existsSync = mockExistsSync as typeof _internals.existsSync;
		_internals.isCommandAvailable =
			mockIsCommandAvailable as typeof _internals.isCommandAvailable;
		_internals.platform = () => 'linux';
		_internals.runExternalTool =
			mockRunExternalTool as typeof _internals.runExternalTool;
	});

	afterEach(() => {
		mock.restore();
		_internals.existsSync = originalExistsSync;
		_internals.isCommandAvailable = originalIsCommandAvailable;
		_internals.platform = originalPlatform;
		_internals.runExternalTool = originalRunExternalTool;
	});

	it('successful ruff check (exit 0) returns LintSuccessResult with success:true and success message', async () => {
		mockRunExternalTool.mockResolvedValue({
			status: 'completed',
			exitCode: 0,
			stdout: 'No issues found',
			stderr: '',
			stdoutTruncated: false,
			stderrTruncated: false,
		});

		const result = await runAdditionalLint('ruff', 'check', '/test');

		expect(result.success).toBe(true);
		expect((result as LintSuccessResult).linter).toBe('ruff');
		expect((result as LintSuccessResult).message).toContain(
			'completed successfully',
		);
		expect((result as LintSuccessResult).exitCode).toBe(0);
	});

	it('ruff check with issues (exit 1) returns LintSuccessResult with success:true and check found issues message', async () => {
		mockRunExternalTool.mockResolvedValue({
			status: 'completed',
			exitCode: 1,
			stdout: 'Found 2 issues',
			stderr: '',
			stdoutTruncated: false,
			stderrTruncated: false,
		});

		const result = await runAdditionalLint('ruff', 'check', '/test');

		expect(result.success).toBe(true);
		expect((result as LintSuccessResult).linter).toBe('ruff');
		expect((result as LintSuccessResult).message).toContain(
			'check found issues',
		);
		expect((result as LintSuccessResult).exitCode).toBe(1);
	});

	it('ruff fix (exit 0) returns LintSuccessResult with success message', async () => {
		mockRunExternalTool.mockResolvedValue({
			status: 'completed',
			exitCode: 0,
			stdout: 'Fixed 3 issues',
			stderr: '',
			stdoutTruncated: false,
			stderrTruncated: false,
		});

		const result = await runAdditionalLint('ruff', 'fix', '/test');

		expect(result.success).toBe(true);
		expect((result as LintSuccessResult).linter).toBe('ruff');
		expect((result as LintSuccessResult).message).toContain(
			'completed successfully',
		);
		expect((result as LintSuccessResult).exitCode).toBe(0);
	});

	it('typed spawn error returns LintErrorResult with success:false and Execution failed error', async () => {
		mockRunExternalTool.mockResolvedValue({
			status: 'spawn-error',
			stdout: '',
			stderr: '',
			stdoutTruncated: false,
			stderrTruncated: false,
			message: 'Command not found',
		});

		const result = await runAdditionalLint('ruff', 'check', '/test');

		expect(result.success).toBe(false);
		expect((result as LintErrorResult).error).toContain('Execution failed');
	});

	it('output truncation: stdout > MAX_OUTPUT_BYTES results in output ending with truncation message', async () => {
		// Create output that exceeds MAX_OUTPUT_BYTES
		const largeOutput = 'x'.repeat(MAX_OUTPUT_BYTES + 1000);
		mockRunExternalTool.mockResolvedValue({
			status: 'completed',
			exitCode: 0,
			stdout: largeOutput,
			stderr: '',
			stdoutTruncated: true,
			stderrTruncated: false,
		});

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
		mockRunExternalTool.mockResolvedValue({
			status: 'completed',
			exitCode: 0,
			stdout: 'stdout output',
			stderr: 'stderr message',
			stdoutTruncated: false,
			stderrTruncated: false,
		});

		const result = await runAdditionalLint('ruff', 'check', '/test');

		expect(result.success).toBe(true);
		expect((result as LintSuccessResult).output).toBe(
			'stdout output\nstderr message',
		);
	});

	it('passes explicit cwd and bounded execution options to the shared runner', async () => {
		mockRunExternalTool.mockResolvedValue({
			status: 'completed',
			exitCode: 0,
			stdout: '',
			stderr: '',
			stdoutTruncated: false,
			stderrTruncated: false,
		});

		await runAdditionalLint('ruff', 'check', '/custom/cwd');

		expect(mockRunExternalTool).toHaveBeenCalledWith(
			expect.objectContaining({
				executable: 'ruff',
				args: ['check', '.'],
				cwd: '/custom/cwd',
				maxStdoutBytes: MAX_OUTPUT_BYTES,
				maxStderrBytes: MAX_OUTPUT_BYTES,
			}),
		);
	});

	it('does not send gradlew.bat to the shared runner on Windows when no native tool is available', async () => {
		_internals.platform = () => 'win32';
		_internals.runExternalTool =
			mockRunExternalTool as typeof _internals.runExternalTool;
		mockExistsSync.mockImplementation((p: string) => p.endsWith('gradlew.bat'));
		mockIsCommandAvailable.mockImplementation(() => false);
		mockRunExternalTool.mockResolvedValue({
			status: 'completed',
			exitCode: 0,
			stdout: '',
			stderr: '',
			stdoutTruncated: false,
			stderrTruncated: false,
		});

		const result = await runAdditionalLint('checkstyle', 'check', '/test');

		expect(result).toEqual({
			success: false,
			mode: 'check',
			linter: 'checkstyle',
			error: 'No safely executable checkstyle command found',
		});
		expect(mockRunExternalTool).not.toHaveBeenCalled();
		_internals.runExternalTool = originalRunExternalTool;
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
