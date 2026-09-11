import { describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';

import { verifyReports } from '../../../../scripts/ci/verify-repository-validation-reports';
import { createSafeTestDir } from '../../../helpers/safe-test-dir';

const PREFIX = 'repository-validation-unit-';
const OS_NAMES = ['ubuntu-latest', 'windows-latest'];
const SHARDS = 2;
const FILES = [
	'tests/a.test.ts',
	'tests/b.test.ts',
	'tests/c.test.ts',
	'tests/d.test.ts',
];

function passingReport(
	root: string,
	file: string,
	id: string,
	platform: string,
) {
	const now = '2026-01-01T00:00:00.000Z';
	return {
		schemaVersion: 1,
		status: 'passed',
		mode: 'full',
		root,
		diffBase: 'origin/main',
		runtime: { bunVersion: '1.3.14', platform, arch: 'x64' },
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
		startedAt: now,
		endedAt: now,
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
				id,
				surface: 'unit',
				file: path.join(root, file),
				status: 'passed',
				exitCode: 0,
				signal: null,
				argv: ['bun', 'test', path.join(root, file)],
				cwd: root,
				startedAt: now,
				endedAt: now,
				durationMs: 1,
				cleanedUp: true,
				stdout: '',
				stderr: '',
			},
		],
	};
}

function writeJson(filePath: string, value: unknown): void {
	writeFileSync(filePath, `${JSON.stringify(value)}\n`, 'utf8');
}

function writeArtifact(
	directory: string,
	root: string,
	osName: string,
	shard: number,
	files = FILES,
	platform = 'linux',
): string {
	const artifact = `${PREFIX}${osName}-${shard}`;
	const artifactDirectory = path.join(directory, artifact);
	const reportDirectory = path.join(artifactDirectory, 'reports');
	mkdirSync(reportDirectory, { recursive: true });
	writeFileSync(
		path.join(artifactDirectory, 'unit-inventory.txt'),
		`${files.join('\n')}\n`,
		'utf8',
	);
	const shardFiles = files.filter(
		(_file, index) => index % SHARDS === shard - 1,
	);
	writeFileSync(
		path.join(artifactDirectory, `unit-shard-${shard}-expected-files.txt`),
		`${shardFiles.join('\n')}\n`,
		'utf8',
	);
	for (const [index, file] of shardFiles.entries()) {
		writeJson(
			path.join(reportDirectory, `report-${index}.json`),
			passingReport(root, file, `${osName}:${file}`, platform),
		);
	}
	return artifactDirectory;
}

function writeMatrix(
	directory: string,
	root: string,
	files = FILES,
	omittedArtifact?: string,
): void {
	for (const osName of OS_NAMES) {
		for (let shard = 1; shard <= SHARDS; shard += 1) {
			const artifact = `${PREFIX}${osName}-${shard}`;
			if (artifact === omittedArtifact) continue;
			writeArtifact(
				directory,
				root,
				osName,
				shard,
				files,
				osName === 'windows-latest' ? 'win32' : 'linux',
			);
		}
	}
}

async function withFixture<T>(
	fn: (directory: string) => T | Promise<T>,
): Promise<T> {
	const { dir, cleanup } = createSafeTestDir('validation-verifier-artifact-');
	try {
		return await fn(dir);
	} finally {
		cleanup();
	}
}

describe('issue #2675 artifact-prefix report verifier', () => {
	test('validates every OS and shard, including recursively stored JSON reports', async () => {
		await withFixture((directory) => {
			writeMatrix(directory, directory);
			expect(
				verifyReports({
					directory,
					root: directory,
					surface: 'unit',
					artifactPrefix: PREFIX,
					expectedOs: OS_NAMES,
					shards: SHARDS,
					inventoryFileName: 'unit-inventory.txt',
				}),
			).toEqual({ reports: 8, results: 8 });
		});
	});

	test('rejects a missing expected artifact', async () => {
		await withFixture((directory) => {
			writeMatrix(directory, directory, FILES, `${PREFIX}windows-latest-2`);
			// Before artifact completeness verification, a missing OS/shard cell could
			// silently reduce the aggregate evidence set while remaining green.
			expect(() =>
				verifyReports({
					directory,
					root: directory,
					surface: 'unit',
					artifactPrefix: PREFIX,
					expectedOs: OS_NAMES,
					shards: SHARDS,
				}),
			).toThrow(
				'missing validation artifact: repository-validation-unit-windows-latest-2',
			);
		});
	});

	test('rejects an unexpected artifact', async () => {
		await withFixture((directory) => {
			writeMatrix(directory, directory);
			const unexpected = path.join(directory, `${PREFIX}linux-latest-1`);
			mkdirSync(unexpected);
			expect(() =>
				verifyReports({
					directory,
					root: directory,
					surface: 'unit',
					artifactPrefix: PREFIX,
					expectedOs: OS_NAMES,
					shards: SHARDS,
				}),
			).toThrow(
				'unexpected validation artifact: repository-validation-unit-linux-latest-1',
			);
		});
	});

	test('rejects a mismatched canonical inventory across OS artifacts', async () => {
		await withFixture((directory) => {
			writeMatrix(directory, directory);
			writeFileSync(
				path.join(directory, `${PREFIX}windows-latest-2`, 'unit-inventory.txt'),
				'tests/a.test.ts\ntests/b.test.ts\ntests/c.test.ts\ntests/e.test.ts\n',
				'utf8',
			);
			expect(() =>
				verifyReports({
					directory,
					root: directory,
					surface: 'unit',
					artifactPrefix: PREFIX,
					expectedOs: OS_NAMES,
					shards: SHARDS,
				}),
			).toThrow(
				'canonical inventory differs across windows-latest validation artifacts',
			);
		});
	});

	test('rejects a shard manifest whose identity set disagrees with its canonical inventory', async () => {
		await withFixture((directory) => {
			writeMatrix(directory, directory);
			writeFileSync(
				path.join(
					directory,
					`${PREFIX}ubuntu-latest-1`,
					'unit-shard-1-expected-files.txt',
				),
				'tests/b.test.ts\ntests/d.test.ts\n',
				'utf8',
			);
			expect(() =>
				verifyReports({
					directory,
					root: directory,
					surface: 'unit',
					artifactPrefix: PREFIX,
					expectedOs: OS_NAMES,
					shards: SHARDS,
				}),
			).toThrow('repository-validation-unit-ubuntu-latest-1 shard manifest');
		});
	});
});
