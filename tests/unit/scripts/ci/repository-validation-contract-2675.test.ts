import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';

type ValidationModule =
	typeof import('../../../../scripts/ci/repository-validation');

async function loadValidationModule(): Promise<ValidationModule> {
	return import('../../../../scripts/ci/repository-validation');
}

describe('issue #2675 repository validation contract', () => {
	test('AC1 accounts for every discovered item and never promotes failure terminals to pass', async () => {
		const { validateRepository } = await loadValidationModule();
		const root = path.resolve('fixture root with spaces');
		const testFiles = [
			'pass.test.ts',
			'fail.test.ts',
			'crash.test.ts',
			'timeout.test.ts',
			'missing.test.ts',
		].map((file) => path.join(root, file));
		const terminalByFile = new Map([
			[testFiles[0], { status: 'passed' as const, exitCode: 0, signal: null }],
			[testFiles[1], { status: 'failed' as const, exitCode: 1, signal: null }],
			[
				testFiles[2],
				{ status: 'crashed' as const, exitCode: null, signal: 'SIGABRT' },
			],
			[
				testFiles[3],
				{ status: 'timed_out' as const, exitCode: 124, signal: 'SIGKILL' },
			],
			[
				testFiles[4],
				{ status: 'missing' as const, exitCode: null, signal: null },
			],
		]);

		const report = await validateRepository({
			root,
			mode: 'full',
			testFiles,
			runtime: { bunVersion: '1.3.13', platform: 'test', arch: 'test' },
			perItemTimeoutMs: 1_000,
			suiteTimeoutMs: 10_000,
			runProcess: async (item) => ({
				...terminalByFile.get(item.file)!,
				stdout: item.file.endsWith('pass.test.ts') ? 'known test output' : '',
				stderr: '',
				durationMs: 1,
				cleanedUp: true,
			}),
		});

		expect(report.summary).toEqual({
			discovered: 5,
			started: 4,
			completed: 2,
			passed: 1,
			failed: 1,
			crashed: 1,
			timedOut: 1,
			missing: 1,
			skipped: 0,
		});
		expect(report.results.map((result) => result.status)).toEqual([
			'passed',
			'failed',
			'crashed',
			'timed_out',
			'missing',
		]);
		expect(report.status).toBe('incomplete');
		expect(report.results.every((result) => result.cleanedUp)).toBe(true);
		expect(report.results[0]?.stdout).toContain('known test output');
	});

	test('AC2 pins complete matrix order, bounds, environment, argv, and no-op identity', async () => {
		const { validateRepository } = await loadValidationModule();
		const root = path.resolve('fixture root with spaces');
		const observedArgv: string[][] = [];
		const fullReport = await validateRepository({
			root,
			mode: 'full',
			diffBase: 'origin/main',
			testFiles: [path.join(root, 'quoted "name".test.ts')],
			runtime: { bunVersion: '1.3.13', platform: 'win32', arch: 'x64' },
			testTimeoutMs: 120_000,
			perItemTimeoutMs: 180_000,
			suiteTimeoutMs: 900_000,
			maxOutputBytes: 65_536,
			runProcess: async (item) => {
				observedArgv.push(item.argv);
				return {
					status: 'passed',
					exitCode: 0,
					signal: null,
					stdout: 'known test output',
					stderr: '',
					durationMs: 1,
					cleanedUp: true,
				};
			},
		});

		expect(fullReport.mode).toBe('full');
		expect(fullReport.inventory).toEqual([
			'quality',
			'unit',
			'integration',
			'security',
			'coverage',
			'memory-recall-regression',
			'package-check',
			'smoke',
			'php-validation',
			'rust-sandbox-runner',
		]);
		expect(fullReport.runtime).toEqual({
			bunVersion: '1.3.13',
			platform: 'win32',
			arch: 'x64',
		});
		expect(fullReport.diffBase).toBe('origin/main');
		expect(fullReport.bounds).toEqual({
			testTimeoutMs: 120_000,
			perItemTimeoutMs: 180_000,
			suiteTimeoutMs: 900_000,
			maxOutputBytes: 65_536,
		});
		expect(fullReport.terminalStatuses).toEqual([
			'passed',
			'failed',
			'crashed',
			'timed_out',
			'missing',
			'skipped',
		]);
		expect(observedArgv).toEqual([
			[
				'bun',
				'--smol',
				'--preload',
				path.join(root, 'scripts', 'ci', 'bun-32056-keepalive.ts'),
				'test',
				path.join(root, 'quoted "name".test.ts'),
				'--timeout',
				'120000',
			],
		]);

		const noOpReport = await validateRepository({
			root,
			mode: 'diff',
			diffBase: 'origin/main',
			testFiles: [],
			runtime: { bunVersion: '1.3.13', platform: 'test', arch: 'test' },
			testTimeoutMs: 500,
			perItemTimeoutMs: 1_000,
			suiteTimeoutMs: 10_000,
			maxOutputBytes: 65_536,
			runProcess: async () => {
				throw new Error('no-op must not spawn');
			},
		});
		expect(noOpReport.status).toBe('no_op');
		expect(noOpReport.mode).toBe('diff');
		expect(noOpReport.summary.discovered).toBe(0);
		expect(noOpReport.status).not.toBe(fullReport.status);
	});

	test('AC3 labels historical counts unconfirmed without retained raw provenance', async () => {
		const { describeHistoricalCount } = await loadValidationModule();
		const withoutProvenance = describeHistoricalCount({
			completed: 659,
			discovered: 3_389,
			provenance: null,
		});
		expect(withoutProvenance).toContain('659/3,389');
		expect(withoutProvenance.toLowerCase()).toContain('unconfirmed');
		expect(withoutProvenance.toLowerCase()).not.toContain('confirmed result');

		for (const docPath of ['TESTING.md', 'contributing.md']) {
			const documentation = await readFile(path.resolve(docPath), 'utf8');
			expect(documentation).toContain('validate:repo');
			expect(documentation).toContain('659/3,389');
			expect(documentation.toLowerCase()).toContain('unconfirmed');
			expect(documentation).toContain('120000');
			expect(documentation).toContain('180000');
			expect(documentation).toContain('65536');
			expect(documentation).toContain('incomplete');
			expect(documentation).toContain('no_op');
		}
	});
});
