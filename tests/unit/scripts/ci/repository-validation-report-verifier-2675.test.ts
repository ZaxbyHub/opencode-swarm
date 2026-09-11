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

const SURFACES = [
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
];

function report(root: string, file: string, id = file) {
	return {
		schemaVersion: 1,
		status: 'passed',
		mode: 'full',
		root,
		diffBase: 'origin/main',
		runtime: {
			bunVersion: '1.3.14',
			platform: 'win32',
			arch: 'x64',
		},
		inventory: SURFACES,
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
				id,
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
			},
		],
	};
}

function writeJson(filePath: string, value: unknown): void {
	writeFileSync(filePath, `${JSON.stringify(value)}\n`, 'utf8');
}

function writeInventory(
	directory: string,
	inventoryFiles: string[],
	shard: number,
	shardFiles = inventoryFiles,
): void {
	writeFileSync(
		path.join(directory, 'unit-inventory.txt'),
		`${inventoryFiles.join('\n')}\n`,
		'utf8',
	);
	writeFileSync(
		path.join(directory, `unit-shard-${shard}-expected-files.txt`),
		`${shardFiles.join('\n')}\n`,
		'utf8',
	);
}

function runnerReport(
	reportRoot: string,
	relativeFile: string,
	platform: string,
): ReturnType<typeof report> {
	const separator = platform === 'win32' ? '\\' : '/';
	const file = `${reportRoot}${separator}${relativeFile.replace(/\//g, separator)}`;
	const value = report(reportRoot, file, `${platform}:${relativeFile}`);
	value.runtime.platform = platform;
	return value;
}

describe('issue #2675 report verifier', () => {
	test('validates flat per-file reports against the discovered expected set', () => {
		const root = canonicalMkdtemp('validation-verifier-');
		try {
			const first = path.join(root, 'first.test.ts');
			const second = path.join(root, 'second.test.ts');
			const reports = path.join(root, 'reports');
			const expected = path.join(root, 'expected.txt');
			mkdirSync(reports);
			writeJson(path.join(reports, 'unit-shard-1-0.json'), report(root, first));
			writeJson(
				path.join(reports, 'unit-shard-1-1.json'),
				report(root, second),
			);
			writeFileSync(expected, `${first}\n${second}\n`, 'utf8');
			expect(
				verifyReports({
					directory: reports,
					root,
					surface: 'unit',
					filePrefix: 'unit-shard-1-',
					expectedFilesPath: expected,
				}),
			).toEqual({ reports: 2, results: 2 });
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test('rejects a report whose summary or result identities are inconsistent', () => {
		const root = canonicalMkdtemp('validation-verifier-');
		try {
			const reports = path.join(root, 'reports');
			mkdirSync(reports);
			const invalid = report(root, path.join(root, 'broken.test.ts'));
			invalid.summary.passed = 0;
			writeJson(path.join(reports, 'unit-shard-1-0.json'), invalid);
			expect(() =>
				verifyReports({
					directory: reports,
					root,
					surface: 'unit',
					filePrefix: 'unit-shard-1-',
				}),
			).toThrow(/summary\.passed mismatch/);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test('rejects missing expected files and duplicate result identities', () => {
		const root = canonicalMkdtemp('validation-verifier-');
		try {
			const reports = path.join(root, 'reports');
			mkdirSync(reports);
			const first = path.join(root, 'first.test.ts');
			const second = path.join(root, 'second.test.ts');
			writeJson(
				path.join(reports, 'unit-shard-1-0.json'),
				report(root, first, 'duplicate-id'),
			);
			writeJson(
				path.join(reports, 'unit-shard-1-1.json'),
				report(root, second, 'duplicate-id'),
			);
			const expected = path.join(root, 'expected.txt');
			writeFileSync(
				expected,
				`${first}\n${second}\n${path.join(root, 'missing.test.ts')}\n`,
				'utf8',
			);
			expect(() =>
				verifyReports({
					directory: reports,
					root,
					surface: 'unit',
					filePrefix: 'unit-shard-1-',
					expectedFilesPath: expected,
				}),
			).toThrow(/duplicate or missing result id/);

			writeJson(
				path.join(reports, 'unit-shard-1-1.json'),
				report(root, second, 'different-id'),
			);
			expect(() =>
				verifyReports({
					directory: reports,
					root,
					surface: 'unit',
					filePrefix: 'unit-shard-1-',
					expectedFilesPath: expected,
				}),
			).toThrow(/report identities size mismatch: expected 3/);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test.each([
		[
			'schema',
			(value: ReturnType<typeof report>) => {
				value.schemaVersion = 2;
			},
		],
		[
			'bounds',
			(value: ReturnType<typeof report>) => {
				value.bounds.maxOutputBytes = 1;
			},
		],
		[
			'terminal',
			(value: ReturnType<typeof report>) => {
				value.status = 'incomplete';
				value.results[0].status = 'timed_out';
				value.results[0].exitCode = 124;
				value.summary = {
					discovered: 1,
					started: 1,
					completed: 0,
					passed: 0,
					failed: 0,
					crashed: 0,
					timedOut: 1,
					missing: 0,
					skipped: 0,
				};
			},
		],
		[
			'root',
			(value: ReturnType<typeof report>) => {
				value.root = undefined;
			},
		],
		[
			'runtime metadata',
			(value: ReturnType<typeof report>) => {
				value.runtime.platform = undefined;
			},
		],
		[
			'terminal status schema',
			(value: ReturnType<typeof report>) => {
				value.terminalStatuses = ['passed', 'bogus'];
			},
		],
		[
			'report timing schema',
			(value: ReturnType<typeof report>) => {
				value.durationMs = Number.NaN;
			},
		],
		[
			'result timing schema',
			(value: ReturnType<typeof report>) => {
				value.results[0].endedAt = 123;
			},
		],
		[
			'cleanup schema',
			(value: ReturnType<typeof report>) => {
				value.results[0].cleanedUp = false;
			},
		],
	])('rejects invalid %s or non-passing reports', (_label, mutate) => {
		const root = canonicalMkdtemp('validation-verifier-');
		try {
			const reports = path.join(root, 'reports');
			mkdirSync(reports);
			const value = report(root, path.join(root, 'invalid.test.ts'));
			mutate(value);
			writeJson(path.join(reports, 'unit-shard-1-0.json'), value);
			expect(() =>
				verifyReports({
					directory: reports,
					root,
					surface: 'unit',
					filePrefix: 'unit-shard-1-',
				}),
			).toThrow();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test('rejects a missing matrix artifact', () => {
		const root = canonicalMkdtemp('validation-verifier-');
		try {
			const reports = path.join(root, 'reports');
			mkdirSync(reports);
			const artifact = path.join(
				reports,
				'repository-validation-unit-ubuntu-latest-1',
			);
			mkdirSync(artifact);
			const shardFile = path.join(root, 'shard-1.test.ts');
			writeInventory(reports, [shardFile], 1);
			writeJson(
				path.join(artifact, 'unit-shard-1-0.json'),
				report(root, shardFile),
			);
			expect(() =>
				verifyReports({
					directory: reports,
					root,
					surface: 'unit',
					artifactPrefix: 'repository-validation-unit-',
					expectedOs: ['ubuntu-latest'],
					shards: 2,
				}),
			).toThrow(/missing validation artifact/);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test('reconstructs the expected OS-by-shard artifact set', () => {
		const root = canonicalMkdtemp('validation-verifier-');
		try {
			const reports = path.join(root, 'reports');
			mkdirSync(reports);
			for (const shard of [1, 2]) {
				const artifact = path.join(
					reports,
					`repository-validation-unit-ubuntu-latest-${shard}`,
				);
				mkdirSync(artifact);
				writeInventory(
					artifact,
					[
						path.join(root, 'shard-1.test.ts'),
						path.join(root, 'shard-2.test.ts'),
					],
					shard,
					[path.join(root, `shard-${shard}.test.ts`)],
				);
				writeJson(
					path.join(artifact, `unit-shard-${shard}-0.json`),
					report(root, path.join(root, `shard-${shard}.test.ts`)),
				);
			}
			expect(
				verifyReports({
					directory: reports,
					root,
					surface: 'unit',
					artifactPrefix: 'repository-validation-unit-',
					expectedOs: ['ubuntu-latest'],
					shards: 2,
				}),
			).toEqual({ reports: 2, results: 2 });
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test('allows repeated files across OSes while honoring a Windows-specific exclusion', () => {
		const root = canonicalMkdtemp('validation-verifier-');
		try {
			const reports = path.join(root, 'reports');
			mkdirSync(reports);
			const inventories: Record<string, string[]> = {
				'ubuntu-latest': [
					'tests/common-a.test.ts',
					'tests/common-b.test.ts',
					'tests/windows-only.test.ts',
				],
				'macos-latest': [
					'tests/common-a.test.ts',
					'tests/common-b.test.ts',
					'tests/windows-only.test.ts',
				],
				'windows-latest': ['tests/common-a.test.ts', 'tests/common-b.test.ts'],
			};
			for (const [os, inventory] of Object.entries(inventories)) {
				for (const shard of [1, 2]) {
					const artifact = path.join(
						reports,
						`repository-validation-unit-${os}-${shard}`,
					);
					mkdirSync(artifact);
					const shardFiles = inventory.filter(
						(_file, index) => index % 2 === shard - 1,
					);
					writeInventory(artifact, inventory, shard, shardFiles);
					const reportRoot =
						os === 'windows-latest'
							? 'C:\\runner\\repo'
							: os === 'macos-latest'
								? '/Users/runner/repo'
								: root;
					for (const [index, file] of shardFiles.entries()) {
						writeJson(
							path.join(artifact, `unit-shard-${shard}-${index}.json`),
							runnerReport(
								reportRoot,
								file,
								os === 'windows-latest'
									? 'win32'
									: os === 'macos-latest'
										? 'darwin'
										: 'linux',
							),
						);
					}
				}
			}
			expect(
				verifyReports({
					directory: reports,
					root,
					surface: 'unit',
					artifactPrefix: 'repository-validation-unit-',
					expectedOs: ['ubuntu-latest', 'macos-latest', 'windows-latest'],
					shards: 2,
				}),
			).toEqual({ reports: 8, results: 8 });
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test('rejects a shard manifest that omits an item from the canonical inventory', () => {
		const root = canonicalMkdtemp('validation-verifier-');
		try {
			const reports = path.join(root, 'reports');
			mkdirSync(reports);
			const inventory = [
				path.join(root, 'shard-1.test.ts'),
				path.join(root, 'shard-2.test.ts'),
			];
			for (const shard of [1, 2]) {
				const artifact = path.join(
					reports,
					`repository-validation-unit-ubuntu-latest-${shard}`,
				);
				mkdirSync(artifact);
				writeInventory(
					artifact,
					inventory,
					shard,
					shard === 1 ? [inventory[0]!] : [],
				);
				writeJson(
					path.join(artifact, `unit-shard-${shard}-0.json`),
					report(root, inventory[shard - 1]!),
				);
			}
			expect(() =>
				verifyReports({
					directory: reports,
					root,
					surface: 'unit',
					artifactPrefix: 'repository-validation-unit-',
					expectedOs: ['ubuntu-latest'],
					shards: 2,
				}),
			).toThrow(/shard manifest size mismatch/);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
