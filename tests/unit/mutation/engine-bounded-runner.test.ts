import { afterEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	_internals,
	executeMutation,
	executeMutationSuite,
	type MutationCommandRunner,
	type MutationPatch,
	runMutationCommand,
} from '../../../src/mutation/engine.js';

const roots: string[] = [];
const realLegacySpawn = _internals.spawnSync;
const realRunExternalTool = _internals.runExternalTool;
const realResolveExecutable = _internals.resolveExecutableFromPath;

function root(): string {
	const value = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), 'mutation-runner-')),
	);
	roots.push(value);
	return value;
}

function patch(): MutationPatch {
	return {
		id: 'bounded',
		filePath: 'source.ts',
		functionName: 'value',
		mutationType: 'operator-swap',
		patch: 'diff --git a/source.ts b/source.ts\n',
	};
}

afterEach(() => {
	_internals.spawnSync = realLegacySpawn;
	_internals.runExternalTool = realRunExternalTool;
	_internals.resolveExecutableFromPath = realResolveExecutable;
	for (const directory of roots.splice(0)) {
		fs.rmSync(directory, { recursive: true, force: true });
	}
});

describe('bounded mutation command runner', () => {
	test('routes apply, test, and revert through the injected async argv runner', async () => {
		const calls: Parameters<MutationCommandRunner>[0][] = [];
		const runner: MutationCommandRunner = mock(async (args) => {
			calls.push(args);
			return {
				status: 'completed',
				exitCode: 0,
				stdout: '',
				stderr: '',
			};
		});
		_internals.spawnSync = () => {
			throw new Error('legacy spawnSync must not run');
		};

		const result = await executeMutation(
			patch(),
			['bun', 'test'],
			['source.test.ts'],
			root(),
			{ runner },
		);

		expect(result.outcome).toBe('survived');
		expect(calls.map((call) => call.executable)).toEqual(['git', 'bun', 'git']);
		expect(calls[0].args[0]).toBe('apply');
		expect(calls[2].args).toContain('-R');
		expect(path.isAbsolute(calls[0].cwd)).toBe(true);
	});

	test('keeps cancellation distinct and performs bounded revert without the aborted signal', async () => {
		const controller = new AbortController();
		let call = 0;
		const runner: MutationCommandRunner = mock(async (args) => {
			call++;
			if (call === 2) {
				controller.abort();
				return {
					status: 'cancelled',
					exitCode: null,
					stdout: '',
					stderr: '',
				};
			}
			if (call === 3) expect(args.abortSignal).toBeUndefined();
			return {
				status: 'completed',
				exitCode: 0,
				stdout: '',
				stderr: '',
			};
		});

		const result = await executeMutation(patch(), ['bun', 'test'], [], root(), {
			runner,
			abortSignal: controller.signal,
		});

		expect(result.outcome).toBe('cancelled');
		expect(result.error).toContain('cancelled');
		expect(call).toBe(3);
	});

	test('keeps apply cancellation distinct and still attempts cleanup', async () => {
		let call = 0;
		const runner: MutationCommandRunner = mock(async () => {
			call++;
			return call === 1
				? {
						status: 'cancelled',
						exitCode: null,
						stdout: '',
						stderr: '',
					}
				: { status: 'completed', exitCode: 0, stdout: '', stderr: '' };
		});
		const result = await executeMutation(patch(), ['bun', 'test'], [], root(), {
			runner,
		});
		expect(result.outcome).toBe('cancelled');
		expect(call).toBe(2);
	});

	test('reports revert cancellation as an error instead of a killed mutant', async () => {
		let call = 0;
		const runner: MutationCommandRunner = mock(async () => {
			call++;
			if (call === 2) {
				return { status: 'completed', exitCode: 1, stdout: '', stderr: '' };
			}
			if (call === 3) {
				return { status: 'cancelled', exitCode: null, stdout: '', stderr: '' };
			}
			return { status: 'completed', exitCode: 0, stdout: '', stderr: '' };
		});
		const result = await executeMutation(patch(), ['bun', 'test'], [], root(), {
			runner,
		});
		expect(result.outcome).toBe('error');
		expect(result.error).toContain('git revert failed');
	});

	test('production runner cannot reach the legacy spawn seam', async () => {
		let legacyCalled = false;
		_internals.spawnSync = () => {
			legacyCalled = true;
			throw new Error('must not run');
		};
		_internals.resolveExecutableFromPath = () => 'C:\\tools\\git.exe';
		_internals.runExternalTool = mock(async () => ({
			status: 'completed',
			exitCode: 0,
			stdout: '',
			stderr: '',
			stdoutTruncated: false,
			stderrTruncated: false,
		}));

		const result = await runMutationCommand({
			executable: 'git',
			args: ['--version'],
			cwd: root(),
			timeoutMs: 1000,
		});

		expect(result.status).toBe('completed');
		expect(legacyCalled).toBe(false);
	});

	test('untouched compatibility seam keeps executeMutation on the bounded async runner', async () => {
		const calls: string[][] = [];
		expect(_internals.spawnSync).toBe(realLegacySpawn);
		_internals.resolveExecutableFromPath = ([executable]) =>
			`C:\\tools\\${executable}.exe`;
		_internals.runExternalTool = mock(async (args) => {
			calls.push(args.args);
			return {
				status: 'completed',
				exitCode: 0,
				stdout: '',
				stderr: '',
				stdoutTruncated: false,
				stderrTruncated: false,
			};
		});

		const result = await executeMutation(patch(), ['bun', 'test'], [], root());

		expect(result.outcome).toBe('survived');
		expect(calls).toHaveLength(3);
		expect(calls[0][0]).toBe('apply');
		expect(calls[2]).toContain('-R');
	});

	test('normalizes a missing production git executable', async () => {
		_internals.resolveExecutableFromPath = () => null;
		_internals.runExternalTool = mock(async () => ({
			status: 'spawn-error',
			exitCode: null,
			stdout: '',
			stderr: '',
			message: 'Executable not found in $PATH',
			stdoutTruncated: false,
			stderrTruncated: false,
		}));

		const result = await runMutationCommand({
			executable: 'git',
			args: ['--version'],
			cwd: root(),
			timeoutMs: 1000,
		});

		expect(result.status).toBe('spawn-error');
		expect(result.message).toBe('git is not installed or not found in PATH');
	});

	test('preserves unrelated production git spawn errors', async () => {
		_internals.resolveExecutableFromPath = () => null;
		_internals.runExternalTool = mock(async () => ({
			status: 'spawn-error',
			exitCode: null,
			stdout: '',
			stderr: '',
			message: 'external tool cwd must be absolute',
			stdoutTruncated: false,
			stderrTruncated: false,
		}));

		const result = await runMutationCommand({
			executable: 'git',
			args: ['--version'],
			cwd: root(),
			timeoutMs: 1000,
		});

		expect(result.status).toBe('spawn-error');
		expect(result.message).toBe('external tool cwd must be absolute');
	});

	test('stops scheduling remaining mutants after cancellation', async () => {
		const controller = new AbortController();
		controller.abort();
		const runner: MutationCommandRunner = mock(async () => {
			throw new Error('cancelled suite must not schedule a subprocess');
		});
		const report = await executeMutationSuite(
			[patch(), { ...patch(), id: 'second' }],
			['bun', 'test'],
			[],
			root(),
			undefined,
			undefined,
			undefined,
			{ runner, abortSignal: controller.signal },
		);
		expect(report.cancelled).toBe(2);
		expect(runner).not.toHaveBeenCalled();
	});
});
