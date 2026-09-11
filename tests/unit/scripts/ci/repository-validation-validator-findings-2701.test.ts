import { describe, expect, test } from 'bun:test';
import * as path from 'node:path';

import {
	_internals,
	buildSurfaceItems,
	DEFAULT_MAX_OUTPUT_BYTES,
	DEFAULT_PER_ITEM_TIMEOUT_MS,
	DEFAULT_SUITE_TIMEOUT_MS,
	DEFAULT_TEST_TIMEOUT_MS,
	TERMINAL_STATUSES,
	type ValidationReport,
	validateRepository,
	writeValidationReport,
} from '../../../../scripts/ci/repository-validation';

const ROOT = path.resolve(
	'repository validation validator findings fixture root',
);

describe('repository validation validator findings — issue #2701', () => {
	test('RC-001: discovery consumes the suite budget before any item starts', async () => {
		// Before this guard, the suite clock started after discovery, so a slow
		// discovery could exceed the configured budget and still execute tests.
		const originalNow = _internals.now;
		const originalDiscovery = _internals.discoverTestFiles;
		const originalTopLevelDiscovery = _internals.discoverTopLevelTestFiles;
		let clock = 1_000;
		let spawned = false;
		_internals.now = () => clock;
		_internals.discoverTestFiles = () => {
			clock = 1_201;
			return [path.join(ROOT, 'discovered.test.ts')];
		};
		_internals.discoverTopLevelTestFiles = () => [];
		try {
			const report = await validateRepository({
				root: ROOT,
				mode: 'full',
				surfaces: ['unit'],
				suiteTimeoutMs: 200,
				runProcess: () => {
					spawned = true;
					return {
						status: 'passed',
						exitCode: 0,
						signal: null,
						cleanedUp: true,
					};
				},
			});
			expect(spawned).toBe(false);
			expect(report.status).toBe('incomplete');
			expect(report.summary.timedOut).toBe(report.summary.discovered);
			expect(report.results.length).toBeGreaterThan(0);
			expect(
				report.results.every((result) => result.status === 'timed_out'),
			).toBe(true);
			expect(report.durationMs).toBeGreaterThanOrEqual(201);
		} finally {
			_internals.now = originalNow;
			_internals.discoverTestFiles = originalDiscovery;
			_internals.discoverTopLevelTestFiles = originalTopLevelDiscovery;
		}
	});

	test('RC-002: a type-change-only diff is work, never a successful no-op', async () => {
		// Before the filter included Git's T status, a type-change-only diff was
		// omitted and diff mode returned no_op without validating the changed test.
		expect(_internals.diffCommandArgv(ROOT, 'origin/main')).toContain(
			'--diff-filter=ACDMRT',
		);
		const originalDiff = _internals.gitDiffPaths;
		_internals.gitDiffPaths = async () => ['tests/unit/type-change.test.ts'];
		try {
			const report = await validateRepository({
				root: ROOT,
				mode: 'diff',
				surfaces: ['unit'],
				runProcess: () => ({
					status: 'passed',
					exitCode: 0,
					signal: null,
					cleanedUp: true,
				}),
			});
			expect(report.status).toBe('passed');
			expect(report.status).not.toBe('no_op');
			expect(report.summary.discovered).toBe(1);
		} finally {
			_internals.gitDiffPaths = originalDiff;
		}
	});

	test('TB-2675-DIFF-SURFACE-CLASS: security tests do not enter unit optimization', async () => {
		// Before root-aware classification, every changed *.test.ts outside the
		// integration roots was treated as a unit test, including security/smoke.
		const originalDiff = _internals.gitDiffPaths;
		const originalDiscovery = _internals.discoverTestFiles;
		const originalTopLevelDiscovery = _internals.discoverTopLevelTestFiles;
		_internals.gitDiffPaths = async () => ['tests/security/changed.test.ts'];
		_internals.discoverTestFiles = () => [path.join(ROOT, 'unit.test.ts')];
		_internals.discoverTopLevelTestFiles = () => [];
		try {
			const observed: string[] = [];
			const report = await validateRepository({
				root: ROOT,
				mode: 'diff',
				surfaces: ['unit'],
				runProcess: (item) => {
					observed.push(item.file);
					return {
						status: 'passed',
						exitCode: 0,
						signal: null,
						cleanedUp: true,
					};
				},
			});
			expect(report.status).toBe('passed');
			expect(observed).toEqual([path.join(ROOT, 'unit.test.ts')]);
		} finally {
			_internals.gitDiffPaths = originalDiff;
			_internals.discoverTestFiles = originalDiscovery;
			_internals.discoverTopLevelTestFiles = originalTopLevelDiscovery;
		}
	});

	test('CD-2675-TIMEOUT-OVERRIDE and RC-004: non-unit argv matches CI surfaces and timeout', () => {
		const items = buildSurfaceItems({
			root: ROOT,
			surfaces: ['security', 'smoke', 'php-validation'],
			testTimeoutMs: 321,
			perItemTimeoutMs: 654,
		});
		const security = items.find(
			(item) => item.id === 'security:security-tests',
		);
		const smoke = items.find((item) => item.id === 'smoke:smoke-tests');
		const php = items.find(
			(item) =>
				item.id === 'php-validation:tests/unit/lang/profiles-php.test.ts',
		);
		expect(security?.argv).toEqual([
			'bun',
			'test',
			path.join(ROOT, 'tests', 'security'),
			'--timeout',
			'321',
		]);
		expect(smoke?.argv).toEqual([
			'bun',
			'test',
			path.join(ROOT, 'tests', 'smoke'),
			'--timeout',
			'321',
		]);
		expect(php?.argv).toEqual([
			'bun',
			'--smol',
			'test',
			path.join(ROOT, 'tests/unit/lang/profiles-php.test.ts'),
			'--timeout',
			'321',
		]);
		for (const item of [security, smoke, php]) {
			expect(item?.testTimeoutMs).toBe(321);
			expect(item?.perItemTimeoutMs).toBe(654);
		}
	});

	test('UB-001: report destinations at the validation directory are rejected', async () => {
		// Before this guard, the directory itself passed the relative-path check
		// and mkdir/write could target it as if it were a report file.
		const report: ValidationReport = {
			schemaVersion: 1,
			status: 'passed',
			mode: 'full',
			root: ROOT,
			diffBase: 'origin/main',
			runtime: { bunVersion: 'test', platform: 'test', arch: 'test' },
			inventory: [],
			bounds: {
				testTimeoutMs: DEFAULT_TEST_TIMEOUT_MS,
				perItemTimeoutMs: DEFAULT_PER_ITEM_TIMEOUT_MS,
				suiteTimeoutMs: DEFAULT_SUITE_TIMEOUT_MS,
				maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES,
			},
			terminalStatuses: [...TERMINAL_STATUSES],
			summary: {
				discovered: 0,
				started: 0,
				completed: 0,
				passed: 0,
				failed: 0,
				crashed: 0,
				timedOut: 0,
				missing: 0,
				skipped: 0,
			},
			results: [],
			startedAt: new Date(0).toISOString(),
			endedAt: new Date(0).toISOString(),
			durationMs: 0,
		};
		await expect(
			writeValidationReport(
				report,
				path.join(ROOT, '.swarm', 'repository-validation'),
			),
		).rejects.toThrow(/destination must be a file/);
	});
});
