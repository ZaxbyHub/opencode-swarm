import { describe, expect, test } from 'bun:test';
import * as path from 'node:path';

import {
	_internals,
	buildSurfaceItems,
	DEFAULT_PER_ITEM_TIMEOUT_MS,
	DEFAULT_TEST_TIMEOUT_MS,
	discoverTestFiles,
	exitCodeForValidationStatus,
	parseValidationArgs,
	validateRepository,
} from '../../../../scripts/ci/repository-validation';

const ROOT = path.resolve('repository validation fixture root');

describe('repository validation hardening — issue #2675', () => {
	test('retains every terminal class and fails closed for incomplete results', async () => {
		const files = ['pass', 'fail', 'crash', 'timeout', 'missing'].map((name) =>
			path.join(ROOT, `${name}.test.ts`),
		);
		const statuses = [
			'passed',
			'failed',
			'crashed',
			'timed_out',
			'missing',
		] as const;
		const report = await validateRepository({
			root: ROOT,
			mode: 'full',
			testFiles: files,
			testTimeoutMs: 120,
			perItemTimeoutMs: 180,
			suiteTimeoutMs: 5_000,
			runProcess: (item) => ({
				status: statuses[files.indexOf(item.file)] ?? 'crashed',
				exitCode: item.file.endsWith('pass.test.ts')
					? 0
					: item.file.endsWith('fail.test.ts')
						? 1
						: null,
				signal: item.file.endsWith('crash.test.ts') ? 'SIGABRT' : null,
				cleanedUp: true,
				stdout: `${item.file} ${'x'.repeat(128)}`,
				stderr: '',
			}),
		});

		expect(report.results.map((result) => result.status)).toEqual([
			...statuses,
		]);
		expect(report.summary).toMatchObject({
			discovered: 5,
			started: 4,
			completed: 2,
			passed: 1,
			failed: 1,
			crashed: 1,
			timedOut: 1,
			missing: 1,
		});
		expect(report.status).toBe('incomplete');
		expect(exitCodeForValidationStatus('passed')).toBe(0);
		expect(exitCodeForValidationStatus('no_op')).toBe(0);
		expect(exitCodeForValidationStatus('failed')).toBe(1);
		expect(exitCodeForValidationStatus('incomplete')).toBe(1);
	});

	test('bounds redacted output using the configured per-report byte limit', async () => {
		const secret = 'g' + 'hp_123456789012345678901234567890123456';
		const report = await validateRepository({
			root: ROOT,
			mode: 'full',
			testFiles: [path.join(ROOT, 'output.test.ts')],
			maxOutputBytes: 32,
			runProcess: () => ({
				status: 'passed',
				exitCode: 0,
				signal: null,
				cleanedUp: true,
				stdout: `prefix ${secret} ${'y'.repeat(200)}`,
				stderr: `${'z'.repeat(200)}${secret}`,
			}),
		});

		for (const result of report.results) {
			expect(
				Buffer.byteLength(result.stdout ?? '', 'utf8'),
			).toBeLessThanOrEqual(32);
			expect(
				Buffer.byteLength(result.stderr ?? '', 'utf8'),
			).toBeLessThanOrEqual(32);
			expect(result.stdout).not.toContain(secret);
			expect(result.stderr).not.toContain(secret);
		}
	});

	test('preserves exact array argv and configured test timeout', async () => {
		const file = path.join(ROOT, 'name with spaces "and quotes".test.ts');
		const observed: string[][] = [];
		await validateRepository({
			root: ROOT,
			mode: 'full',
			testFiles: [file],
			testTimeoutMs: 321,
			perItemTimeoutMs: 654,
			runProcess: (item) => {
				observed.push(item.argv);
				return { status: 'passed', exitCode: 0, signal: null, cleanedUp: true };
			},
		});
		expect(observed).toEqual([
			[
				'bun',
				'--smol',
				'--preload',
				path.join(ROOT, 'scripts', 'ci', 'bun-32056-keepalive.ts'),
				'test',
				file,
				'--timeout',
				'321',
			],
		]);
	});

	test('whole-run deadline emits an explicit timeout row', async () => {
		const started = performance.now();
		const report = await validateRepository({
			root: ROOT,
			mode: 'full',
			testFiles: [path.join(ROOT, 'hung.test.ts')],
			perItemTimeoutMs: 1_000,
			suiteTimeoutMs: 20,
			runProcess: () => new Promise(() => undefined),
		});
		expect(performance.now() - started).toBeLessThan(500);
		expect(report.status).toBe('incomplete');
		expect(report.results[0]).toMatchObject({
			status: 'timed_out',
			exitCode: 124,
			signal: 'SIGKILL',
			reason: 'per-item or whole-run deadline elapsed',
		});
	});

	test('default runner owns timeout cleanup before publishing its terminal row', async () => {
		const fixture = path.resolve(
			'tests/unit/scripts/ci/fixtures/hanging-fixture.ts',
		);
		const report = await validateRepository({
			root: path.resolve('.'),
			mode: 'full',
			testFiles: [fixture],
			perItemTimeoutMs: 250,
			suiteTimeoutMs: 2_000,
		});
		expect(report.results[0]).toMatchObject({
			status: 'timed_out',
			exitCode: 124,
		});
		// Windows taskkill can be denied in restricted runners; the authority
		// must report that uncertainty instead of claiming cleanup succeeded.
		expect(typeof report.results[0]?.cleanedUp).toBe('boolean');
	}, 15_000);

	test('reports failed Windows process-tree termination as incomplete cleanup', async () => {
		const originalPlatform = _internals.platform;
		const originalSpawnTaskkill = _internals.spawnTaskkill;
		let parentKilled = false;
		let killerKilled = false;
		_internals.platform = 'win32';
		_internals.spawnTaskkill = (() => ({
			exited: Promise.resolve(1),
			kill: () => {
				killerKilled = true;
			},
		})) as typeof _internals.spawnTaskkill;
		try {
			const cleaned = await _internals.killProcessTree(
				{
					pid: 12_345,
					kill: () => {
						parentKilled = true;
					},
				},
				ROOT,
			);
			expect(cleaned).toBe(false);
			expect(parentKilled).toBe(true);
			expect(killerKilled).toBe(true);
		} finally {
			_internals.platform = originalPlatform;
			_internals.spawnTaskkill = originalSpawnTaskkill;
		}
	});

	test('timeout does not wait indefinitely for a descendant-inherited output pipe', async () => {
		const fixture = path.resolve(
			'tests/unit/scripts/ci/fixtures/inherited-pipe-fixture.ts',
		);
		const started = performance.now();
		const report = await validateRepository({
			root: path.resolve('.'),
			mode: 'full',
			testFiles: [fixture],
			perItemTimeoutMs: 120,
			suiteTimeoutMs: 500,
		});
		expect(report.results[0]?.status).toBe('timed_out');
		expect(performance.now() - started).toBeLessThan(7_500);
	}, 15_000);

	test('rejects unknown and malformed CLI arguments', () => {
		expect(() => parseValidationArgs(['--unknown'])).toThrow(
			'unknown validation option',
		);
		expect(() => parseValidationArgs(['--mode', 'partial'])).toThrow(
			'--mode must be full or diff',
		);
		expect(() => parseValidationArgs(['--timeout', '0'])).toThrow(
			'positive integer',
		);
		expect(() => parseValidationArgs(['--surface', 'not-a-surface'])).toThrow(
			'unknown validation surface',
		);
		expect(() => parseValidationArgs(['--report'])).toThrow('requires a value');
		expect(() => parseValidationArgs(['--diff-base', '-evil'])).toThrow(
			'diff base',
		);
		expect(() =>
			validateRepository({
				root: ROOT,
				mode: 'diff',
				diffBase: 'bad\0revision',
				testFiles: [],
			}),
		).toThrow('diff base');

		const parsed = parseValidationArgs([
			'--mode=diff',
			'--surface',
			'unit',
			'--surfaces=security,integration',
			'--timeout',
			'321',
			'--kill-timeout',
			'654',
			'--suite-timeout',
			'987',
			'--max-output-bytes',
			'1234',
			'tests/unit/example.test.ts',
		]);
		expect(parsed.mode).toBe('diff');
		expect(parsed.surfaces).toEqual(['unit', 'security', 'integration']);
		expect(parsed.testTimeoutMs).toBe(321);
		expect(parsed.perItemTimeoutMs).toBe(654);
		expect(parsed.suiteTimeoutMs).toBe(987);
		expect(parsed.maxOutputBytes).toBe(1234);
		expect(parsed.testFiles).toEqual(['tests/unit/example.test.ts']);
	});

	test('builds the selected host surfaces as deterministic command/test items', () => {
		const items = buildSurfaceItems({
			root: ROOT,
			surfaces: ['security', 'package-check', 'rust-sandbox-runner'],
			testTimeoutMs: DEFAULT_TEST_TIMEOUT_MS,
			perItemTimeoutMs: DEFAULT_PER_ITEM_TIMEOUT_MS,
		});
		expect(items.map((item) => item.id)).toEqual([
			'security:security-tests',
			'package-check:build',
			'package-check:package-smoke',
			'rust-sandbox-runner:fmt',
			'rust-sandbox-runner:clippy',
			'rust-sandbox-runner:test',
			'rust-sandbox-runner:build',
			'rust-sandbox-runner:probe',
		]);
		expect(items[0]?.kind).toBe('surface');
		expect(items[0]?.argv).toContain('--timeout');
		expect(items[0]?.requiredRuntimes).toEqual(['bun']);
		expect(items.at(-1)?.argv[0]).toBe(
			path.join(
				'target',
				'release',
				`swarm-sandbox-runner${process.platform === 'win32' ? '.exe' : ''}`,
			),
		);
		expect(items.at(-1)?.cwd).toBe(
			path.join(ROOT, 'runners', 'swarm-sandbox-runner'),
		);
	});

	test('validateRepository executes selected non-unit surface items and records runtime skips', async () => {
		const observed: string[][] = [];
		const report = await validateRepository({
			root: ROOT,
			mode: 'full',
			surfaces: ['security'],
			runProcess: (item) => {
				observed.push(item.argv);
				return { status: 'passed', exitCode: 0, signal: null, cleanedUp: true };
			},
		});
		expect(report.inventory).toEqual(['security']);
		expect(observed).toHaveLength(1);
		expect(report.results[0]?.id).toBe('security:security-tests');

		const originalRuntimeAvailable = _internals.runtimeAvailable;
		_internals.runtimeAvailable = () => false;
		try {
			const skipped = await validateRepository({
				root: ROOT,
				mode: 'full',
				surfaces: ['security'],
				runProcess: () => {
					throw new Error('unavailable runtime must not spawn');
				},
			});
			expect(skipped.status).toBe('incomplete');
			expect(skipped.results).toHaveLength(1);
			expect(skipped.results[0]).toMatchObject({
				status: 'skipped',
				reason: 'required runtime unavailable: bun',
				cleanedUp: true,
			});
		} finally {
			_internals.runtimeAvailable = originalRuntimeAvailable;
		}
	});

	test('diff mode is wired to changed-path selection and does not false-no-op on source changes', async () => {
		const originalDiff = _internals.gitDiffPaths;
		try {
			_internals.gitDiffPaths = async () => [];
			const clean = await validateRepository({
				root: ROOT,
				mode: 'diff',
				surfaces: ['unit'],
				runProcess: () => {
					throw new Error('clean diff must not spawn');
				},
			});
			expect(clean.status).toBe('no_op');

			const observed: string[][] = [];
			_internals.gitDiffPaths = async () => ['tests/unit/changed.test.ts'];
			const changedTest = await validateRepository({
				root: ROOT,
				mode: 'diff',
				surfaces: ['unit'],
				runProcess: (item) => {
					observed.push(item.argv);
					return {
						status: 'passed',
						exitCode: 0,
						signal: null,
						cleanedUp: true,
					};
				},
			});
			expect(changedTest.status).toBe('passed');
			expect(observed).toHaveLength(1);

			_internals.gitDiffPaths = async () => ['src/changed.ts'];
			const changedSource = await validateRepository({
				root: ROOT,
				mode: 'diff',
				surfaces: ['security'],
				runProcess: (item) => {
					observed.push(item.argv);
					return {
						status: 'passed',
						exitCode: 0,
						signal: null,
						cleanedUp: true,
					};
				},
			});
			expect(changedSource.status).toBe('passed');
			expect(observed.length).toBe(2);
		} finally {
			_internals.gitDiffPaths = originalDiff;
		}
	});

	test('deletion-only diff remains incomplete instead of a no-op (F3)', async () => {
		// Before the deletion filter included D, a deleted test path disappeared
		// from the diff selection and the run was incorrectly reported as no_op.
		expect(_internals.diffCommandArgv(ROOT, 'origin/main')).toContain(
			'--diff-filter=ACDMR',
		);
		const originalDiff = _internals.gitDiffPaths;
		_internals.gitDiffPaths = async () => ['tests/unit/deleted.test.ts'];
		try {
			const report = await validateRepository({
				root: ROOT,
				mode: 'diff',
				surfaces: ['unit'],
				runProcess: () => ({
					status: 'missing',
					exitCode: null,
					signal: null,
					cleanedUp: true,
				}),
			});
			expect(report.status).toBe('incomplete');
			expect(report.results[0]?.status).toBe('missing');
		} finally {
			_internals.gitDiffPaths = originalDiff;
		}
	});

	test('missing optional test roots are treated as empty surfaces', () => {
		expect(discoverTestFiles(ROOT, ['tests/cli'])).toEqual([]);
	});

	test('missing required test roots fail closed', () => {
		for (const requiredRoot of ['src', 'tests/unit']) {
			expect(() => discoverTestFiles(ROOT, [requiredRoot])).toThrow(
				/filesystem discovery failed for/,
			);
		}
	});

	test('git diff output over the bounded limit fails the diff run closed (F1)', async () => {
		// Before this guard, a truncated git path list could be treated as a
		// complete diff and silently omit changed files from validation.
		const originalDiff = _internals.gitDiffPaths;
		const originalRead = _internals.readBoundedWithStatus;
		_internals.readBoundedWithStatus = async () => ({
			value: 'partial-path-list',
			truncated: true,
			complete: false,
		});
		try {
			const report = await validateRepository({
				root: path.resolve('.'),
				mode: 'diff',
				surfaces: ['unit'],
			});
			expect(report.status).toBe('incomplete');
			expect(report.results[0]).toMatchObject({
				status: 'skipped',
				reason: expect.stringContaining('bounded buffer'),
			});
		} finally {
			_internals.gitDiffPaths = originalDiff;
			_internals.readBoundedWithStatus = originalRead;
		}
	});

	test('filesystem discovery errors produce an incomplete local report (F5)', async () => {
		// Before this guard, readdir failures were caught and converted to an
		// empty discovery result, which could be mistaken for clean validation.
		const originalDiscovery = _internals.discoverTestFiles;
		_internals.discoverTestFiles = () => {
			throw new Error('permission denied');
		};
		try {
			const report = await validateRepository({
				root: ROOT,
				mode: 'full',
				surfaces: ['unit'],
				runProcess: () => {
					throw new Error('discovery failure must not spawn');
				},
			});
			expect(report.status).toBe('incomplete');
			expect(report.results[0]).toMatchObject({
				status: 'skipped',
				reason: expect.stringContaining('permission denied'),
			});
		} finally {
			_internals.discoverTestFiles = originalDiscovery;
		}
	});
});
