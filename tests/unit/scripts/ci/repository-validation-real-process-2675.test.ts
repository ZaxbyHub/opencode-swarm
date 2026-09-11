import { describe, expect, test } from 'bun:test';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import * as fsp from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import {
	discoverTestFiles,
	validateRepository,
} from '../../../../scripts/ci/repository-validation';

const REPO_ROOT = path.resolve(import.meta.dir, '../../../..');
const FIXTURE_ROOT = path.join(
	REPO_ROOT,
	'tests',
	'unit',
	'scripts',
	'ci',
	'fixtures',
);
const PASS_FIXTURE = path.join(
	FIXTURE_ROOT,
	'repository validation',
	'pass-fixture.ts',
);
const FAIL_FIXTURE = path.join(
	FIXTURE_ROOT,
	'repository-validation-fail-fixture.ts',
);
const TIMEOUT_FIXTURE = path.join(
	FIXTURE_ROOT,
	'repository-validation-timeout-fixture.ts',
);
const CRASH_FIXTURE = path.join(
	FIXTURE_ROOT,
	'repository-validation-crash-fixture.ts',
);

describe('repository-validation authority real-process fixtures — issue #2675', () => {
	test('runs a passing child, retains known output, and preserves a spaced argv token', async () => {
		const report = await validateRepository({
			root: REPO_ROOT,
			mode: 'full',
			testFiles: [PASS_FIXTURE],
			perItemTimeoutMs: 10_000,
			suiteTimeoutMs: 20_000,
		});
		const result = report.results[0];

		expect(report.status).toBe('passed');
		expect(result?.status).toBe('passed');
		expect(result?.cleanedUp).toBe(true);
		expect(result?.stdout).toContain('repository-validation-known-output');
		expect(result?.argv).toContain(PASS_FIXTURE);
		expect(result?.argv).toEqual([
			'bun',
			'--smol',
			'--preload',
			path.join(REPO_ROOT, 'scripts', 'ci', 'bun-32056-keepalive.ts'),
			'test',
			PASS_FIXTURE,
			'--timeout',
			'120000',
		]);
	}, 30_000);

	test('records a real assertion failure as failed, not passed or incomplete', async () => {
		const report = await validateRepository({
			root: REPO_ROOT,
			mode: 'full',
			testFiles: [FAIL_FIXTURE],
			perItemTimeoutMs: 10_000,
			suiteTimeoutMs: 20_000,
		});
		const result = report.results[0];

		expect(result?.status).toBe('failed');
		expect(result?.exitCode).not.toBe(0);
		expect(result?.cleanedUp).toBe(true);
		expect(report.status).toBe('failed');
	});

	test('records a real timeout with bounded cleanup and returns promptly', async () => {
		const started = performance.now();
		const report = await validateRepository({
			root: REPO_ROOT,
			mode: 'full',
			testFiles: [TIMEOUT_FIXTURE],
			perItemTimeoutMs: 200,
			suiteTimeoutMs: 2_000,
		});
		const result = report.results[0];

		expect(result?.status).toBe('timed_out');
		expect(result?.cleanedUp).toBe(true);
		expect(result?.signal).toBe('SIGKILL');
		expect(report.status).toBe('incomplete');
		expect(performance.now() - started).toBeLessThan(5_000);
	});

	test.skipIf(process.platform === 'win32')(
		'records a POSIX signal as crashed, distinct from timeout',
		async () => {
			const report = await validateRepository({
				root: REPO_ROOT,
				mode: 'full',
				testFiles: [CRASH_FIXTURE],
				perItemTimeoutMs: 10_000,
				suiteTimeoutMs: 20_000,
			});
			const result = report.results[0];

			expect(result?.status).toBe('crashed');
			expect(result?.status).not.toBe('timed_out');
			expect(result?.signal).toBeTruthy();
			expect(result?.cleanedUp).toBe(true);
			expect(report.status).toBe('incomplete');
		},
		30_000,
	);

	test('retains a missing terminal when a discovered file vanishes before execution', async () => {
		const fixtureRoot = mkdtempSync(
			path.join(tmpdir(), 'repository-validation-missing-'),
		);
		const testsRoot = path.join(fixtureRoot, 'tests', 'unit');
		const missingFixture = path.join(
			testsRoot,
			'missing-after-discovery.test.ts',
		);
		mkdirSync(testsRoot, { recursive: true });
		copyFileSync(PASS_FIXTURE, missingFixture);
		try {
			const discovered = discoverTestFiles(fixtureRoot, ['tests/unit']);
			expect(discovered).toEqual([path.normalize(missingFixture)]);
			await fsp.unlink(missingFixture);

			const report = await validateRepository({
				root: fixtureRoot,
				mode: 'full',
				testFiles: discovered,
				perItemTimeoutMs: 200,
				suiteTimeoutMs: 2_000,
			});
			const result = report.results[0];

			expect(result?.status).toBe('missing');
			expect(result?.cleanedUp).toBe(true);
			expect(report.summary).toEqual({
				discovered: 1,
				started: 0,
				completed: 0,
				passed: 0,
				failed: 0,
				crashed: 0,
				timedOut: 0,
				missing: 1,
				skipped: 0,
			});
			expect(report.status).toBe('incomplete');
		} finally {
			rmSync(fixtureRoot, { recursive: true, force: true });
		}
	});
});
