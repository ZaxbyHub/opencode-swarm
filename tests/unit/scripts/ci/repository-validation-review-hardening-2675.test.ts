import { describe, expect, test } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import * as fsp from 'node:fs/promises';
import { join } from 'node:path';
import {
	_internals,
	buildSurfaceItems,
	discoverTestFiles,
	validateRepository,
} from '../../../../scripts/ci/repository-validation';
import { DEFAULT_BOUNDS as WRITER_BOUNDS } from '../../../../scripts/ci/repository-validation-constants';
import {
	MAX_REPORT_FILES,
	DEFAULT_BOUNDS as VERIFIER_BOUNDS,
	verifyReports,
} from '../../../../scripts/ci/verify-repository-validation-reports';
import { withSafeTestDir } from '../../../helpers/safe-test-dir';
import { canonicalTmpDir } from '../../../helpers/tmpdir';

const SOURCE = readFileSync(
	new URL('../../../../scripts/ci/repository-validation.ts', import.meta.url),
	'utf8',
);

describe('repository-validation review hardening — issue #2675', () => {
	test('discovery accepts an explicit suite deadline and fails closed before traversal', () => {
		expect(() =>
			discoverTestFiles(
				join(canonicalTmpDir(), 'unreachable-fixture'),
				['tests/unit'],
				[],
				{
					deadlineMs: 0,
				},
			),
		).toThrow('filesystem discovery exceeded the suite deadline');
	});

	test('top-level discovery honors the suite deadline and build wiring', () => {
		expect(() =>
			_internals.discoverTopLevelTestFiles(
				join(canonicalTmpDir(), 'unreachable-fixture'),
				{ deadlineMs: 0 },
			),
		).toThrow('filesystem discovery exceeded the suite deadline');

		const originalDiscovery = _internals.discoverTestFiles;
		const originalTopLevelDiscovery = _internals.discoverTopLevelTestFiles;
		let observedDeadline: number | undefined;
		_internals.discoverTestFiles = () => [];
		_internals.discoverTopLevelTestFiles = (_root, options) => {
			observedDeadline = options?.deadlineMs;
			return [];
		};
		try {
			buildSurfaceItems({
				root: join(canonicalTmpDir(), 'fixture'),
				surfaces: ['unit'],
				discoveryDeadlineMs: 123,
			});
			expect(observedDeadline).toBe(123);
		} finally {
			_internals.discoverTestFiles = originalDiscovery;
			_internals.discoverTopLevelTestFiles = originalTopLevelDiscovery;
		}
	});

	test('discovery has depth, entry, and test-file bounds', () => {
		expect(SOURCE).toContain('filesystem discovery exceeded maximum depth');
		expect(SOURCE).toContain(
			'filesystem discovery exceeded maximum entry count',
		);
		expect(SOURCE).toContain(
			'filesystem discovery exceeded maximum test-file count',
		);
		expect(SOURCE).toContain(
			'discoveryDeadlineMs: startedClock + suiteTimeoutMs',
		);
	});

	test('normal completion owns detached descendant cleanup', () => {
		expect(SOURCE).toContain('const ensureTreeCleanup = (): Promise<boolean>');
		expect(SOURCE).toContain(
			'const cleanupSucceeded = await ensureTreeCleanup()',
		);
		expect(SOURCE).toContain('outputStop.abort();');
	});

	test('report publication and containment are bounded and canonicalized', () => {
		expect(SOURCE).toContain('REPORT_IO_TIMEOUT_MS = 5_000');
		expect(SOURCE).toContain('return Promise.race([operation, deadline])');
		expect(SOURCE).toContain('assertPublicationActive(state)');
		expect(SOURCE).toContain('lock ownership changed before commit');
		expect(SOURCE).toContain('state.cancelled = true');
		expect(SOURCE).toContain('captureReportPublicationIdentity');
		expect(SOURCE).toContain('reportPublicationRealpath');
		expect(SOURCE).toContain(
			'const safeDestination = path.join(publicationIdentity.canonicalParent, path.basename(destination))',
		);
	});

	test('artifact verification leaves headroom for the three-OS matrix', () => {
		expect(MAX_REPORT_FILES).toBeGreaterThanOrEqual(30_000);
	});

	test('writer and verifier use one shared bounds contract (F6)', () => {
		expect(VERIFIER_BOUNDS).toEqual(WRITER_BOUNDS);
	});

	test('retry reports retain bounded prior terminal evidence without duplicate identities (F5)', async () => {
		await withSafeTestDir(async (root) => {
			const file = join(root, 'retry.test.ts');
			const reportPath = join('.swarm', 'repository-validation', 'retry.json');
			const expected = join(root, 'expected.txt');
			writeFileSync(expected, `${file}\n`, 'utf8');
			await validateRepository({
				root,
				mode: 'full',
				testFiles: [file],
				reportPath,
				runProcess: () => ({
					status: 'failed',
					exitCode: 1,
					signal: null,
					cleanedUp: true,
					stdout: 'first-attempt failure',
				}),
			});
			await validateRepository({
				root,
				mode: 'full',
				testFiles: [file],
				reportPath,
				runProcess: () => ({
					status: 'passed',
					exitCode: 0,
					signal: null,
					cleanedUp: true,
				}),
			});

			const reportFile = join(root, reportPath);
			const saved = JSON.parse(await fsp.readFile(reportFile, 'utf8')) as {
				results: Array<{
					status: string;
					attempts?: Array<{ status: string; exitCode: number | null }>;
				}>;
			};
			expect(saved.results).toHaveLength(1);
			expect(saved.results[0]?.status).toBe('passed');
			expect(saved.results[0]?.attempts).toEqual([
				expect.objectContaining({ status: 'failed', exitCode: 1 }),
			]);
			expect(
				verifyReports({
					directory: join(root, '.swarm', 'repository-validation'),
					root,
					surface: 'unit',
					filePrefix: 'retry',
					expectedFilesPath: expected,
				}),
			).toEqual({ reports: 1, results: 1 });
		});
	});

	test('stale-lock recovery is serialized per lock path and re-confirmed', () => {
		expect(SOURCE).toContain('withReportLockAcquireGuard');
		expect(SOURCE).toContain(
			'const confirmation = await readReportLockOwner(quarantinePath)',
		);
		expect(SOURCE).toContain('await fsp.rename(lockPath, quarantinePath)');
	});
});
