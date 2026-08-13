import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as path from 'node:path';
import {
	_internals,
	MAX_OUTPUT_BYTES,
	runLint,
	type SupportedLinter,
} from '../../../src/tools/lint';
import type { ExternalToolRunOptions } from '../../../src/utils/external-tool-runner';

const originalResolveLinterCommand = _internals.resolveLinterCommand;
const originalRunExternalTool = _internals.runExternalTool;
const resolverCalls: Array<[SupportedLinter, string]> = [];
const runnerCalls: ExternalToolRunOptions[] = [];

beforeEach(() => {
	resolverCalls.length = 0;
	runnerCalls.length = 0;
	_internals.resolveLinterCommand = async (linter, directory) => {
		resolverCalls.push([linter, directory]);
		const eslintEntry = path.join(directory, 'safe-bin', 'eslint.js');
		return {
			linter,
			executable:
				linter === 'eslint'
					? process.execPath
					: path.join(directory, 'safe-bin', 'biome'),
			argsPrefix: linter === 'eslint' ? [eslintEntry] : [],
			displayPrefix:
				linter === 'eslint'
					? [process.execPath, eslintEntry]
					: [path.join(directory, 'safe-bin', 'biome')],
			source: 'safe-package-bin',
		};
	};
	_internals.runExternalTool = async (options) => {
		runnerCalls.push(options);
		return {
			status: 'completed',
			exitCode: 0,
			stdout: '',
			stderr: '',
			stdoutTruncated: false,
			stderrTruncated: false,
			durationMs: 1,
		};
	};
});

afterEach(() => {
	_internals.resolveLinterCommand = originalResolveLinterCommand;
	_internals.runExternalTool = originalRunExternalTool;
});

describe('runLint type-safety boundaries', () => {
	it('SEC-036: handles every valid linter type through safe resolution', async () => {
		const validLinters: SupportedLinter[] = ['biome', 'eslint'];
		const directory = path.resolve('lint-type-safety-project');

		for (const linter of validLinters) {
			const result = await runLint(linter, 'check', directory);
			expect(result.success).toBe(true);
			expect(result.linter).toBe(linter);
		}

		expect(resolverCalls).toEqual(
			validLinters.map((linter) => [linter, directory]),
		);
		expect(runnerCalls).toHaveLength(2);
		expect(runnerCalls[0]).toEqual({
			executable: path.join(directory, 'safe-bin', 'biome'),
			args: ['check', '.'],
			cwd: directory,
			timeoutMs: 30_000,
			maxStdoutBytes: MAX_OUTPUT_BYTES,
			maxStderrBytes: MAX_OUTPUT_BYTES,
			abortSignal: undefined,
		});
		expect(runnerCalls[1]).toEqual({
			executable: process.execPath,
			args: [path.join(directory, 'safe-bin', 'eslint.js'), '.'],
			cwd: directory,
			timeoutMs: 30_000,
			maxStdoutBytes: MAX_OUTPUT_BYTES,
			maxStderrBytes: MAX_OUTPUT_BYTES,
			abortSignal: undefined,
		});
		for (const call of runnerCalls) {
			expect(path.isAbsolute(call.cwd)).toBe(true);
			expect(call.executable).not.toMatch(/\.(?:cmd|bat|ps1)$/i);
		}
	});
});
