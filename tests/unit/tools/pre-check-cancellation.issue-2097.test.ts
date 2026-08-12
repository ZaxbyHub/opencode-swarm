import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { _internals as lintInternals } from '../../../src/tools/lint';
import { _internals as batchInternals } from '../../../src/tools/pre-check-batch';
import { _internals as sastInternals } from '../../../src/tools/sast-scan';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const originals = {
	checkSemgrepAvailable: sastInternals.checkSemgrepAvailable,
	runSemgrep: sastInternals.runSemgrep,
	runExternalTool: batchInternals.runExternalTool,
	lintRunExternalTool: lintInternals.runExternalTool,
};
const tempDirs: string[] = [];

afterEach(() => {
	sastInternals.checkSemgrepAvailable = originals.checkSemgrepAvailable;
	sastInternals.runSemgrep = originals.runSemgrep;
	batchInternals.runExternalTool = originals.runExternalTool;
	lintInternals.runExternalTool = originals.lintRunExternalTool;
	for (const dir of tempDirs.splice(0)) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

describe('pre-check cancellation propagation — issue #2097', () => {
	test('wrapper timeout aborts its underlying operation before returning', async () => {
		let cleanupComplete = false;
		await expect(
			batchInternals.runWithTimeout(
				async (signal) => {
					await new Promise<void>((resolve) => {
						signal.addEventListener(
							'abort',
							() => {
								setTimeout(() => {
									cleanupComplete = true;
									resolve();
								}, 20);
							},
							{ once: true },
						);
					});
					return 'late result';
				},
				1,
				undefined,
				true,
			),
		).rejects.toThrow('Timeout after 1ms');
		expect(cleanupComplete).toBe(true);
	});

	test('a pre-aborted parent prevents operation startup', async () => {
		const controller = new AbortController();
		controller.abort();
		let calls = 0;

		await expect(
			batchInternals.runWithTimeout(
				async () => {
					calls++;
					return 'unexpected';
				},
				100,
				controller.signal,
				true,
			),
		).rejects.toThrow('Tool execution cancelled');
		expect(calls).toBe(0);
	});

	test('a pre-aborted SAST wrapper does not probe Semgrep', async () => {
		const controller = new AbortController();
		controller.abort();
		let probes = 0;
		sastInternals.checkSemgrepAvailable = async () => {
			probes++;
			return true;
		};

		const result = await batchInternals.runSastScanWrapped(
			['safe.ts'],
			path.resolve('.'),
			'high',
			undefined,
			undefined,
			controller.signal,
		);

		expect(result.error).toBe('Tool execution cancelled');
		expect(probes).toBe(0);
	});

	test('host abort stops SAST before a later Semgrep bucket can launch', async () => {
		const root = canonicalMkdtemp('precheck-abort-');
		tempDirs.push(root);
		const files = [path.join(root, 'a.ts'), path.join(root, 'b.py')];
		fs.writeFileSync(files[0], 'export const value = 1;\n');
		fs.writeFileSync(files[1], 'value = 1\n');

		const controller = new AbortController();
		let calls = 0;
		sastInternals.checkSemgrepAvailable = async () => true;
		sastInternals.runSemgrep = async (options) => {
			calls++;
			await new Promise<void>((resolve) => {
				options.abortSignal?.addEventListener('abort', () => resolve(), {
					once: true,
				});
			});
			return {
				available: true,
				findings: [],
				error: 'Semgrep execution cancelled',
				engine: 'tier_a' as const,
			};
		};

		const pending = batchInternals.runSastScanWrapped(
			files,
			root,
			'medium',
			undefined,
			undefined,
			controller.signal,
		);
		while (calls === 0) await new Promise((resolve) => setTimeout(resolve, 1));
		controller.abort();
		const result = await pending;
		await new Promise((resolve) => setTimeout(resolve, 20));

		expect(result.error).toBe('Tool execution cancelled');
		expect(calls).toBe(1);
	});

	test('changed-line Git subprocesses receive the host abort signal', async () => {
		const controller = new AbortController();
		const observedSignals: Array<AbortSignal | undefined> = [];
		batchInternals.runExternalTool = async (options) => {
			observedSignals.push(options.abortSignal);
			return {
				status: 'cancelled',
				exitCode: null,
				stdout: '',
				stderr: '',
				stdoutTruncated: false,
				stderrTruncated: false,
			};
		};

		expect(
			await batchInternals.getChangedLineRanges(
				path.resolve('.'),
				controller.signal,
			),
		).toBeNull();
		expect(observedSignals.length).toBeGreaterThan(0);
		expect(
			observedSignals.every((signal) => signal === controller.signal),
		).toBe(true);
	});

	test('resolved lint execution passes the host abort signal to the runner', async () => {
		const controller = new AbortController();
		let observedSignal: AbortSignal | undefined;
		lintInternals.runExternalTool = async (options) => {
			observedSignal = options.abortSignal;
			return {
				status: 'cancelled',
				exitCode: null,
				stdout: '',
				stderr: '',
				stdoutTruncated: false,
				stderrTruncated: false,
			};
		};

		const result = await lintInternals.runResolvedLint(
			{
				linter: 'biome',
				executable: path.resolve('fake-biome'),
				argsPrefix: [],
				displayPrefix: ['biome'],
				source: 'path-native',
			},
			'check',
			path.resolve('.'),
			controller.signal,
		);

		expect(observedSignal).toBe(controller.signal);
		expect(result.success).toBe(false);
		expect(result.error).toContain('cancelled');
	});
});
