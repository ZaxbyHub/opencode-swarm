import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	_internals,
	getAdditionalLinterCommand,
	MAX_COMMAND_LENGTH,
	MAX_OUTPUT_BYTES,
	runAdditionalLint,
} from '../../../src/tools/lint';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const originalExistsSync = _internals.existsSync;
const originalIsCommandAvailable = _internals.isCommandAvailable;
const originalPathEnv = _internals.pathEnv;
const originalPlatform = _internals.platform;
const originalRunExternalTool = _internals.runExternalTool;

const mockExistsSync = mock<(candidate: string) => boolean>(() => false);
const mockIsCommandAvailable = mock<(name: string) => boolean>(() => false);
const mockRunExternalTool = mock();

const tempRoots: string[] = [];

function completedResult(
	overrides: Partial<
		Awaited<ReturnType<typeof _internals.runExternalTool>>
	> = {},
) {
	return {
		status: 'completed' as const,
		exitCode: 0,
		stdout: '',
		stderr: '',
		stdoutTruncated: false,
		stderrTruncated: false,
		...overrides,
	};
}

function createTempDir(prefix: string): string {
	const directory = canonicalMkdtemp(prefix);
	tempRoots.push(directory);
	return directory;
}

beforeEach(() => {
	mock.restore();
	mock.clearAllMocks();
	_internals.existsSync = mockExistsSync as typeof _internals.existsSync;
	_internals.isCommandAvailable =
		mockIsCommandAvailable as typeof _internals.isCommandAvailable;
	_internals.pathEnv = () => '';
	_internals.platform = () => 'linux';
	_internals.runExternalTool =
		mockRunExternalTool as typeof _internals.runExternalTool;
	mockExistsSync.mockImplementation(() => false);
	mockIsCommandAvailable.mockImplementation(() => false);
	mockRunExternalTool.mockReset();
});

afterEach(() => {
	_internals.existsSync = originalExistsSync;
	_internals.isCommandAvailable = originalIsCommandAvailable;
	_internals.pathEnv = originalPathEnv;
	_internals.platform = originalPlatform;
	_internals.runExternalTool = originalRunExternalTool;
	for (const directory of tempRoots.splice(0)) {
		fs.rmSync(directory, { recursive: true, force: true });
	}
	mock.restore();
});

describe('getAdditionalLinterCommand — adversarial resolution', () => {
	it('returns null for checkstyle traversal inputs without a runnable native tool', () => {
		expect(
			getAdditionalLinterCommand('checkstyle', 'check', '../../etc/passwd'),
		).toBeNull();
	});

	it('returns the safe ruff argv on Linux when the executable is available', () => {
		mockIsCommandAvailable.mockImplementation((name) => name === 'ruff');

		expect(getAdditionalLinterCommand('ruff', 'check', '/workspace')).toEqual([
			'ruff',
			'check',
			'.',
		]);
	});

	it('falls back to check-mode args for invalid ruff modes without shell interpolation', () => {
		mockIsCommandAvailable.mockImplementation((name) => name === 'ruff');

		expect(
			getAdditionalLinterCommand('ruff', 'invalid' as never, '/workspace'),
		).toEqual(['ruff', 'check', '.']);
	});

	it('preserves spaces in the non-Windows gradlew path as a single argv element', () => {
		const cwdWithSpaces = '/path/to/my project';
		_internals.platform = () => 'linux';
		mockExistsSync.mockImplementation(
			(candidate) =>
				candidate.endsWith('gradlew') || candidate.endsWith('checkstyle.xml'),
		);

		expect(
			getAdditionalLinterCommand('checkstyle', 'check', cwdWithSpaces),
		).toEqual([path.join(cwdWithSpaces, 'gradlew'), 'checkstyleMain']);
	});

	it('returns null for Windows checkstyle when only gradlew.bat exists', () => {
		_internals.platform = () => 'win32';
		mockExistsSync.mockImplementation(
			(candidate) =>
				candidate.endsWith('gradlew.bat') ||
				candidate.endsWith('checkstyle.xml'),
		);

		expect(
			getAdditionalLinterCommand('checkstyle', 'check', 'C:\\repo'),
		).toBeNull();
	});

	it('returns null for Windows phpstan when only the .bat proxy exists', () => {
		_internals.platform = () => 'win32';
		mockExistsSync.mockImplementation((candidate) =>
			candidate.endsWith(
				`${path.sep}vendor${path.sep}bin${path.sep}phpstan.bat`,
			),
		);

		expect(
			getAdditionalLinterCommand('phpstan', 'check', 'C:\\repo'),
		).toBeNull();
	});

	it('returns php + vendor proxy for Windows phpstan when the extensionless proxy and php.exe exist', () => {
		const cwd = createTempDir('lint-phpstan-');
		const binDir = path.join(cwd, 'bin');
		const proxy = path.join(cwd, 'vendor', 'bin', 'phpstan');
		const phpExe = path.join(binDir, 'php.exe');

		fs.mkdirSync(path.dirname(proxy), { recursive: true });
		fs.mkdirSync(binDir, { recursive: true });
		fs.writeFileSync(proxy, '@php proxy');
		fs.writeFileSync(phpExe, '');

		_internals.existsSync = fs.existsSync;
		_internals.platform = () => 'win32';
		_internals.pathEnv = () => binDir;

		expect(getAdditionalLinterCommand('phpstan', 'check', cwd)).toEqual([
			phpExe,
			path.join('vendor', 'bin', 'phpstan'),
			'analyse',
		]);
	});

	it('can build a checkstyle command that exceeds MAX_COMMAND_LENGTH without shell expansion', () => {
		const longSegment = 'a'.repeat(120);
		const cwd = `/${longSegment}/${longSegment}/${longSegment}/${longSegment}`;
		_internals.platform = () => 'linux';
		mockExistsSync.mockImplementation(
			(candidate) =>
				candidate.endsWith('gradlew') || candidate.endsWith('checkstyle.xml'),
		);

		const command = getAdditionalLinterCommand('checkstyle', 'check', cwd);
		expect(command).not.toBeNull();
		expect(command!.join(' ').length).toBeGreaterThan(MAX_COMMAND_LENGTH);
	});
});

describe('runAdditionalLint — shared runner DI', () => {
	it('returns unavailable and never calls the runner when no safe ruff executable exists', async () => {
		const result = await runAdditionalLint('ruff', 'check', '/repo');

		expect(result).toEqual({
			success: false,
			mode: 'check',
			linter: 'ruff',
			error: 'No safely executable ruff command found',
		});
		expect(mockRunExternalTool).not.toHaveBeenCalled();
	});

	it('returns unavailable and never calls the runner for Windows gradlew.bat-only checkstyle', async () => {
		_internals.platform = () => 'win32';
		mockExistsSync.mockImplementation(
			(candidate) =>
				candidate.endsWith('gradlew.bat') ||
				candidate.endsWith('checkstyle.xml'),
		);

		const result = await runAdditionalLint('checkstyle', 'check', 'C:\\repo');

		expect(result).toEqual({
			success: false,
			mode: 'check',
			linter: 'checkstyle',
			error: 'No safely executable checkstyle command found',
		});
		expect(mockRunExternalTool).not.toHaveBeenCalled();
	});

	it('routes a safe Windows phpstan proxy invocation through the shared runner', async () => {
		const cwd = createTempDir('lint-run-phpstan-');
		const binDir = path.join(cwd, 'bin');
		const proxy = path.join(cwd, 'vendor', 'bin', 'phpstan');
		const phpExe = path.join(binDir, 'php.exe');

		fs.mkdirSync(path.dirname(proxy), { recursive: true });
		fs.mkdirSync(binDir, { recursive: true });
		fs.writeFileSync(proxy, '@php proxy');
		fs.writeFileSync(phpExe, '');

		_internals.existsSync = fs.existsSync;
		_internals.platform = () => 'win32';
		_internals.pathEnv = () => binDir;
		mockRunExternalTool.mockResolvedValue(
			completedResult({ stdout: 'analysis complete' }),
		);

		const result = await runAdditionalLint('phpstan', 'check', cwd);

		expect(mockRunExternalTool).toHaveBeenCalledWith({
			executable: phpExe,
			args: [path.join('vendor', 'bin', 'phpstan'), 'analyse'],
			cwd,
			timeoutMs: 30_000,
			maxStdoutBytes: MAX_OUTPUT_BYTES,
			maxStderrBytes: MAX_OUTPUT_BYTES,
		});
		expect(result.success).toBe(true);
		expect(result.command).toEqual([
			phpExe,
			path.join('vendor', 'bin', 'phpstan'),
			'analyse',
		]);
	});

	it('maps shared-runner spawn errors into lint errors', async () => {
		mockIsCommandAvailable.mockImplementation((name) => name === 'ruff');
		mockRunExternalTool.mockResolvedValue(
			completedResult({
				status: 'spawn-error',
				exitCode: null,
				message: 'spawn failed: ENOENT',
			}),
		);

		const result = await runAdditionalLint('ruff', 'check', '/repo');

		expect(result).toEqual({
			success: false,
			mode: 'check',
			linter: 'ruff',
			command: ['ruff', 'check', '.'],
			exitCode: undefined,
			output: '',
			error: 'Execution failed: spawn failed: ENOENT',
		});
	});

	it('maps shared-runner timeouts into lint errors', async () => {
		mockIsCommandAvailable.mockImplementation((name) => name === 'ruff');
		mockRunExternalTool.mockResolvedValue(
			completedResult({
				status: 'timeout',
				exitCode: null,
			}),
		);

		const result = await runAdditionalLint('ruff', 'check', '/repo');

		expect(result.success).toBe(false);
		expect(result.error).toBe('Execution failed: command timed out');
	});

	it('truncates oversized stdout from the shared runner', async () => {
		mockIsCommandAvailable.mockImplementation((name) => name === 'ruff');
		mockRunExternalTool.mockResolvedValue(
			completedResult({
				stdout: 'x'.repeat(MAX_OUTPUT_BYTES + 1),
			}),
		);

		const result = await runAdditionalLint('ruff', 'check', '/repo');

		expect(result.success).toBe(true);
		expect(result.output).toContain('... (output truncated)');
		expect(result.output.length).toBeLessThanOrEqual(MAX_OUTPUT_BYTES + 30);
	});

	it('preserves large completed exit codes from the shared runner', async () => {
		mockIsCommandAvailable.mockImplementation((name) => name === 'ruff');
		mockRunExternalTool.mockResolvedValue(
			completedResult({
				exitCode: 999999,
			}),
		);

		const result = await runAdditionalLint('ruff', 'check', '/repo');

		expect(result.success).toBe(true);
		expect(result.exitCode).toBe(999999);
		expect(result.message).toContain('exit code 999999');
	});
});
