import { describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';

import { verifyReports } from '../../../../scripts/ci/verify-repository-validation-reports';
import { withFrozenClock } from '../../../helpers/test-clock.js';
import { canonicalMkdtemp } from '../../../helpers/tmpdir';

const FIXED_ISO_NOW = '2026-01-01T00:00:00.000Z';

function isoNow(): string {
	return withFrozenClock(() => new Date().toISOString(), {
		fixedNow: 1_767_225_600_000,
		isoNow: FIXED_ISO_NOW,
	});
}

function passingReport(
	root: string,
	resultOverrides: Record<string, unknown> = {},
) {
	const file = path.join(root, 'result.test.ts');
	return {
		schemaVersion: 1,
		status: 'passed',
		mode: 'full',
		root,
		diffBase: 'origin/main',
		runtime: {
			bunVersion: 'test',
			platform: process.platform,
			arch: process.arch,
		},
		inventory: ['unit'],
		bounds: {
			testTimeoutMs: 120_000,
			perItemTimeoutMs: 180_000,
			suiteTimeoutMs: 900_000,
			maxOutputBytes: 65_536,
		},
		terminalStatuses: [
			'passed',
			'failed',
			'crashed',
			'timed_out',
			'missing',
			'skipped',
		],
		startedAt: isoNow(),
		endedAt: isoNow(),
		durationMs: 1,
		summary: {
			discovered: 1,
			started: 1,
			completed: 1,
			passed: 1,
			failed: 0,
			crashed: 0,
			timedOut: 0,
			missing: 0,
			skipped: 0,
		},
		results: [
			{
				id: 'unit:result',
				surface: 'unit',
				file,
				status: 'passed',
				exitCode: 0,
				signal: null,
				argv: ['bun', 'test', file],
				cwd: root,
				startedAt: isoNow(),
				endedAt: isoNow(),
				durationMs: 1,
				cleanedUp: true,
				stdout: '',
				stderr: '',
				...resultOverrides,
			},
		],
	};
}

describe('repository validation report verifier — regression F4', () => {
	test.each([
		['nonzero exit code', { exitCode: 1, signal: null }],
		['termination signal', { exitCode: 0, signal: 'SIGTERM' }],
	])('rejects a passed row with abnormal process termination: %s', (_label, overrides) => {
		// Before this guard, durable reports could claim passed while retaining a
		// nonzero exit code or signal, and the verifier trusted that contradictory row.
		const root = canonicalMkdtemp('validation-verifier-f4-');
		try {
			const reports = path.join(root, 'reports');
			mkdirSync(reports);
			writeFileSync(
				path.join(reports, 'unit-shard-1-0.json'),
				`${JSON.stringify(passingReport(root, overrides))}\n`,
				'utf8',
			);
			expect(() =>
				verifyReports({
					directory: reports,
					root,
					surface: 'unit',
					filePrefix: 'unit-shard-1-',
				}),
			).toThrow(/abnormal process termination/);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
