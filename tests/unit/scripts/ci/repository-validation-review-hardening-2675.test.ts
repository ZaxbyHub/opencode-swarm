import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverTestFiles } from '../../../../scripts/ci/repository-validation';

const SOURCE = readFileSync(
	new URL('../../../../scripts/ci/repository-validation.ts', import.meta.url),
	'utf8',
);

describe('repository-validation review hardening — issue #2675', () => {
	test('discovery accepts an explicit suite deadline and fails closed before traversal', () => {
		expect(() =>
			discoverTestFiles(
				join(tmpdir(), 'unreachable-fixture'),
				['tests/unit'],
				[],
				{
					deadlineMs: 0,
				},
			),
		).toThrow('filesystem discovery exceeded the suite deadline');
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
		expect(SOURCE).toContain('const canonicalParent = await fsp.realpath');
		expect(SOURCE).toContain(
			'const safeDestination = path.join(canonicalParent, path.basename(destination))',
		);
	});

	test('stale-lock recovery is serialized per lock path and re-confirmed', () => {
		expect(SOURCE).toContain('withReportLockAcquireGuard');
		expect(SOURCE).toContain(
			'const confirmation = await readReportLockOwner(lockPath)',
		);
	});
});
