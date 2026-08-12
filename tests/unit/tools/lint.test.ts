import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	_detectAvailableLinter,
	_internals,
	detectAvailableLinter,
	getLinterCommand,
	MAX_COMMAND_LENGTH,
	MAX_OUTPUT_BYTES,
	type ResolvedLinterCommand,
	runLint,
	type SupportedLinter,
	validateArgs,
} from '../../../src/tools/lint';
import type { ExternalToolRunResult } from '../../../src/utils/external-tool-runner';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const realResolveLinterCommand = _internals.resolveLinterCommand;
const realRunExternalTool = _internals.runExternalTool;
const realDetectResolvedLinter = _internals.detectResolvedLinter;

function makeResolvedCommand(
	linter: SupportedLinter,
	overrides: Partial<ResolvedLinterCommand> = {},
): ResolvedLinterCommand {
	return {
		linter,
		executable: `/fake/${linter}`,
		argsPrefix: [],
		displayPrefix: [`/fake/${linter}`],
		source: 'legacy-test-probe',
		...overrides,
	};
}

function makeRunResult(
	overrides: Partial<ExternalToolRunResult> = {},
): ExternalToolRunResult {
	return {
		status: 'completed',
		exitCode: 0,
		stdout: '',
		stderr: '',
		stdoutTruncated: false,
		stderrTruncated: false,
		...overrides,
	};
}

describe('lint tool', () => {
	beforeEach(() => {
		_internals.resolveLinterCommand = realResolveLinterCommand;
		_internals.runExternalTool = realRunExternalTool;
		_internals.detectResolvedLinter = realDetectResolvedLinter;
	});

	afterEach(() => {
		_internals.resolveLinterCommand = realResolveLinterCommand;
		_internals.runExternalTool = realRunExternalTool;
		_internals.detectResolvedLinter = realDetectResolvedLinter;
	});

	describe('validateArgs', () => {
		it('accepts valid modes', () => {
			expect(validateArgs({ mode: 'check' })).toBe(true);
			expect(validateArgs({ mode: 'fix' })).toBe(true);
		});

		it('rejects malformed values', () => {
			expect(validateArgs(null)).toBe(false);
			expect(validateArgs(undefined)).toBe(false);
			expect(validateArgs('check')).toBe(false);
			expect(validateArgs({})).toBe(false);
			expect(validateArgs({ mode: 'CHECK' })).toBe(false);
			expect(validateArgs({ mode: 'invalid' })).toBe(false);
		});
	});

	describe('getLinterCommand', () => {
		it('builds biome commands for check and fix', () => {
			const biomeBin = process.platform === 'win32' ? 'biome.EXE' : 'biome';

			expect(getLinterCommand('biome', 'check', '/repo')).toEqual([
				path.join('/repo', 'node_modules', '.bin', biomeBin),
				'check',
				'.',
			]);
			expect(getLinterCommand('biome', 'fix', '/repo')).toEqual([
				path.join('/repo', 'node_modules', '.bin', biomeBin),
				'check',
				'--write',
				'.',
			]);
		});

		it('builds eslint commands for check and fix', () => {
			expect(getLinterCommand('eslint', 'check', '/repo')).toEqual([
				path.join('/repo', 'node_modules', '.bin', 'eslint'),
				'.',
			]);
			expect(getLinterCommand('eslint', 'fix', '/repo')).toEqual([
				path.join('/repo', 'node_modules', '.bin', 'eslint'),
				'.',
				'--fix',
			]);
		});
	});

	describe('detectAvailableLinter', () => {
		it('projects the resolved linter name from detectResolvedLinter', async () => {
			const tempRoot = canonicalMkdtemp('lint-detect-available-');
			const packageRoot = path.join(
				tempRoot,
				'node_modules',
				'@biomejs',
				'biome',
			);
			fs.mkdirSync(path.join(packageRoot, 'bin'), { recursive: true });
			fs.writeFileSync(
				path.join(packageRoot, 'package.json'),
				JSON.stringify({ bin: { biome: 'bin/biome' } }),
			);
			fs.writeFileSync(path.join(packageRoot, 'bin', 'biome'), '');
			_internals.runExternalTool = async () =>
				makeRunResult({ stdout: 'biome 1.0.0' });

			try {
				expect(await detectAvailableLinter(tempRoot)).toBe('biome');
			} finally {
				fs.rmSync(tempRoot, { recursive: true, force: true });
			}
		});

		it('returns null when no resolved linter is available', async () => {
			const tempRoot = canonicalMkdtemp('lint-missing-root-');
			const missingDirectory = path.join(tempRoot, 'missing');

			try {
				expect(await detectAvailableLinter(missingDirectory)).toBeNull();
			} finally {
				fs.rmSync(tempRoot, { recursive: true, force: true });
			}
		});
	});

	describe('_detectAvailableLinter', () => {
		it('returns biome when the first shared-runner probe succeeds', async () => {
			const calls: Array<Parameters<typeof _internals.runExternalTool>[0]> = [];
			_internals.runExternalTool = async (options) => {
				calls.push(options);
				return makeRunResult({ stdout: 'biome 1.0.0' });
			};

			const linter = await _detectAvailableLinter(
				process.cwd(),
				'/tooling/biome',
				'/tooling/eslint',
			);

			expect(linter).toBe('biome');
			expect(calls).toHaveLength(1);
			expect(calls[0]).toMatchObject({
				executable: '/tooling/biome',
				args: ['--version'],
				timeoutMs: 2000,
				maxStdoutBytes: 4096,
				maxStderrBytes: 4096,
			});
		});

		it('falls back to eslint when biome probe fails', async () => {
			let callIndex = 0;
			_internals.runExternalTool = async () => {
				callIndex += 1;
				return callIndex === 1
					? makeRunResult({ exitCode: 1 })
					: makeRunResult({ stdout: 'eslint 9.0.0' });
			};

			const linter = await _detectAvailableLinter(
				process.cwd(),
				'/tooling/biome',
				'/tooling/eslint',
			);

			expect(linter).toBe('eslint');
			expect(callIndex).toBe(2);
		});

		it('returns null when both probes fail or error', async () => {
			let callIndex = 0;
			_internals.runExternalTool = async () => {
				callIndex += 1;
				return callIndex === 1
					? makeRunResult({ status: 'spawn-error', message: 'boom' })
					: makeRunResult({ exitCode: 1 });
			};

			expect(
				await _detectAvailableLinter(
					process.cwd(),
					'/tooling/biome',
					'/tooling/eslint',
				),
			).toBeNull();
		});
	});

	describe('runLint', () => {
		it('returns an explicit error when no safely resolved executable exists', async () => {
			_internals.resolveLinterCommand = async () => null;

			expect(await runLint('biome', 'check', '/repo')).toEqual({
				success: false,
				mode: 'check',
				linter: 'biome',
				error: 'No safely resolved biome executable found',
			});
		});

		it('returns success:true with exit code 0 and a success message', async () => {
			_internals.resolveLinterCommand = async () =>
				makeResolvedCommand('biome');
			_internals.runExternalTool = async () =>
				makeRunResult({ stdout: 'All files are formatted correctly.' });

			const result = await runLint('biome', 'check', '/repo');

			expect(result).toMatchObject({
				success: true,
				mode: 'check',
				linter: 'biome',
				exitCode: 0,
				output: 'All files are formatted correctly.',
			});
			expect(result.command).toEqual(['/fake/biome', 'check', '.']);
			expect(result.message).toContain('completed successfully');
		});

		it('keeps nonzero completed exits as success results with issue messaging', async () => {
			_internals.resolveLinterCommand = async () =>
				makeResolvedCommand('biome');
			_internals.runExternalTool = async () =>
				makeRunResult({
					exitCode: 1,
					stderr: 'error: Some files have lint issues',
				});

			const checkResult = await runLint('biome', 'check', '/repo');
			const fixResult = await runLint('biome', 'fix', '/repo');

			expect(checkResult.success).toBe(true);
			expect(checkResult.exitCode).toBe(1);
			expect(checkResult.message).toContain('found issues');
			expect(fixResult.success).toBe(true);
			expect(fixResult.message).toContain('fix completed');
		});

		it('combines stdout and stderr into a single output payload', async () => {
			_internals.resolveLinterCommand = async () =>
				makeResolvedCommand('eslint');
			_internals.runExternalTool = async () =>
				makeRunResult({
					stdout: 'Checking...',
					stderr: 'Warning: deprecated API',
				});

			const result = await runLint('eslint', 'check', '/repo');

			expect(result.output).toBe('Checking...\nWarning: deprecated API');
		});

		it('truncates oversized output and runner-truncated streams', async () => {
			_internals.resolveLinterCommand = async () =>
				makeResolvedCommand('biome');
			_internals.runExternalTool = async () =>
				makeRunResult({
					stdout: 'x'.repeat(MAX_OUTPUT_BYTES + 50),
					stdoutTruncated: true,
				});

			const result = await runLint('biome', 'check', '/repo');

			expect(result.success).toBe(true);
			expect(result.output?.length).toBeLessThanOrEqual(MAX_OUTPUT_BYTES + 30);
			expect(result.output).toContain('... (output truncated)');
		});

		it('returns a bounded error result for timeout failures', async () => {
			_internals.resolveLinterCommand = async () =>
				makeResolvedCommand('biome');
			_internals.runExternalTool = async () => ({
				status: 'timeout',
				exitCode: 124,
				stdout: 'partial output',
				stderr: '',
				stdoutTruncated: false,
				stderrTruncated: false,
			});

			const result = await runLint('biome', 'check', '/repo');

			expect(result).toMatchObject({
				success: false,
				mode: 'check',
				linter: 'biome',
				exitCode: 124,
				output: 'partial output',
			});
			expect(result.error).toContain('command timed out');
		});

		it('returns a bounded error result for spawn failures', async () => {
			_internals.resolveLinterCommand = async () =>
				makeResolvedCommand('eslint');
			_internals.runExternalTool = async () => ({
				status: 'spawn-error',
				exitCode: null,
				stdout: '',
				stderr: '',
				stdoutTruncated: false,
				stderrTruncated: false,
				message: 'Command not found',
			});

			const result = await runLint('eslint', 'fix', '/repo');

			expect(result.success).toBe(false);
			expect(result.error).toContain('Execution failed: Command not found');
			expect(result.command).toEqual(['/fake/eslint', '.', '--fix']);
		});

		it('fails closed when the rendered command exceeds MAX_COMMAND_LENGTH', async () => {
			_internals.resolveLinterCommand = async () =>
				makeResolvedCommand('biome', {
					displayPrefix: ['x'.repeat(MAX_COMMAND_LENGTH + 10)],
				});

			const result = await runLint('biome', 'check', '/repo');

			expect(result).toEqual({
				success: false,
				mode: 'check',
				linter: 'biome',
				command: ['x'.repeat(MAX_COMMAND_LENGTH + 10), 'check', '.'],
				error: 'Command exceeds maximum allowed length',
			});
		});
	});
});
