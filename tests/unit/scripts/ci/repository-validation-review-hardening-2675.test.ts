import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
	_internals,
	buildSurfaceItems,
	discoverTestFiles,
} from '../../../../scripts/ci/repository-validation';
import { MAX_REPORT_FILES } from '../../../../scripts/ci/verify-repository-validation-reports';
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
		expect(SOURCE).toContain('const canonicalParent = await fsp.realpath');
		expect(SOURCE).toContain(
			'const safeDestination = path.join(canonicalParent, path.basename(destination))',
		);
	});

	test('artifact verification leaves headroom for the three-OS matrix', () => {
		expect(MAX_REPORT_FILES).toBeGreaterThanOrEqual(30_000);
	});

	test('stale-lock recovery is serialized per lock path and re-confirmed', () => {
		expect(SOURCE).toContain('withReportLockAcquireGuard');
		expect(SOURCE).toContain(
			'const confirmation = await readReportLockOwner(quarantinePath)',
		);
		expect(SOURCE).toContain('await fsp.rename(lockPath, quarantinePath)');
	});
});
