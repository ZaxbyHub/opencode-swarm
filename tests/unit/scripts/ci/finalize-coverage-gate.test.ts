import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { canonicalMkdtemp } from '../../../helpers/tmpdir.js';

/**
 * Functional fail-closed tests for scripts/ci/finalize-coverage-gate.sh
 * (issue #2341 acceptance: "no path where a missing shard report weakens it").
 *
 * The script is executed FOR REAL with `bash` from a temp cwd (it anchors
 * merge-lcov.mjs to its own repo via BASH_SOURCE, and takes the parts dir via
 * COVERAGE_PARTS_DIR), with fixture lcov parts. Windows is skipped for the
 * same reason as tests/unit/scripts/check-invariants.test.ts: bash.exe on a
 * stock Windows host can be the WSL stub. The script only ever runs on
 * ubuntu-latest in CI; the ubuntu/macos unit shards provide the coverage.
 *
 * TIMING CONTRACT (same file convention as check-invariants.test.ts):
 * SPAWN_TIMEOUT_MS is what spawnSync allows; TEST_TIMEOUT_MS is bun:test's
 * per-test budget and must strictly exceed it. The merge step spawns bun on
 * tiny fixtures (<1s), so 20s/30s is generous headroom.
 */

const isWindows = process.platform === 'win32';
const REPO_ROOT = path.resolve(import.meta.dir, '../../../..');
const SCRIPT_PATH = path.join(
	REPO_ROOT,
	'scripts',
	'ci',
	'finalize-coverage-gate.sh',
);

const SPAWN_TIMEOUT_MS = 20_000;
const TEST_TIMEOUT_MS = 30_000;

/** A small lcov fixture: `covered` of `total` DA lines have hit counts > 0. */
function lcovFixture(file: string, total: number, covered: number): string {
	const lines: string[] = ['TN:', `SF:${file}`];
	for (let i = 1; i <= total; i++) {
		lines.push(`DA:${i},${i <= covered ? 3 : 0}`);
	}
	lines.push('end_of_record', '');
	return lines.join('\n');
}

interface RunResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

function runFinalize(
	partsDir: string,
	cwd: string,
	envOverrides: Record<string, string>,
): RunResult {
	const result = spawnSync('bash', [SCRIPT_PATH], {
		cwd,
		encoding: 'utf-8',
		stdio: ['pipe', 'pipe', 'pipe'],
		timeout: SPAWN_TIMEOUT_MS,
		env: {
			...process.env,
			EXPECTED_SHARDS: '6',
			SHARD_JOB_RESULT: 'success',
			COVERAGE_PARTS_DIR: partsDir,
			...envOverrides,
		},
	});
	return {
		stdout: result.stdout ?? '',
		stderr: result.stderr ?? '',
		exitCode: result.status ?? 1,
	};
}

/** Creates a temp workspace with a parts dir populated by `writer`. */
function setupPartsFixture(
	fixtureName: string,
	writer: (writePart: (index: number, content: string) => void) => void,
): { cwd: string; partsDir: string } {
	const cwd = canonicalMkdtemp(`finalize-coverage-${fixtureName}-`);
	const partsDir = path.join(cwd, 'coverage-parts');
	fs.mkdirSync(partsDir, { recursive: true });
	writer((index, content) => {
		fs.writeFileSync(
			path.join(partsDir, `coverage-part-${index}.info`),
			content,
		);
	});
	return { cwd, partsDir };
}

describe('finalize-coverage-gate.sh — fail-closed behavior (issue #2341)', () => {
	test(
		'happy path: 6 valid parts merge and pass the threshold',
		async () => {
			if (isWindows) return;
			const { cwd, partsDir } = setupPartsFixture('happy', (writePart) => {
				for (let i = 1; i <= 6; i++) {
					// Every DA line covered -> 100.00% >= 65.00 default.
					writePart(i, lcovFixture(`src/shard${i}.ts`, 5, 5));
				}
			});
			const result = runFinalize(partsDir, cwd, {});
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain(
				'Coverage gate passed: 100.00% >= 65.00%',
			);
			expect(fs.existsSync(path.join(cwd, 'coverage-value.txt'))).toBe(true);
			const merged = fs.readFileSync(
				path.join(cwd, 'coverage/lcov.info'),
				'utf-8',
			);
			expect(merged).toContain('SF:src/shard1.ts');
			expect(merged).toContain('SF:src/shard6.ts');
		},
		TEST_TIMEOUT_MS,
	);

	test(
		'missing shard part fails closed with the found-vs-expected count',
		async () => {
			if (isWindows) return;
			const { cwd, partsDir } = setupPartsFixture('missing', (writePart) => {
				for (let i = 1; i <= 5; i++) {
					writePart(i, lcovFixture(`src/shard${i}.ts`, 5, 5));
				}
			});
			const result = runFinalize(partsDir, cwd, {});
			expect(result.exitCode).not.toBe(0);
			expect(result.stdout).toContain('Expected 6 coverage shard parts');
			expect(result.stdout).toContain('found 5');
			// The gate must not have reached the threshold message.
			expect(result.stdout).not.toContain('Coverage gate');
		},
		TEST_TIMEOUT_MS,
	);

	test(
		'empty shard part fails closed',
		async () => {
			if (isWindows) return;
			const { cwd, partsDir } = setupPartsFixture('empty', (writePart) => {
				for (let i = 1; i <= 6; i++) {
					writePart(i, i === 3 ? '' : lcovFixture(`src/shard${i}.ts`, 5, 5));
				}
			});
			const result = runFinalize(partsDir, cwd, {});
			expect(result.exitCode).not.toBe(0);
			expect(result.stdout).toContain('is empty');
		},
		TEST_TIMEOUT_MS,
	);

	test(
		'header-only shard part (no DA: records) fails closed',
		async () => {
			if (isWindows) return;
			const { cwd, partsDir } = setupPartsFixture('headers', (writePart) => {
				for (let i = 1; i <= 6; i++) {
					writePart(
						i,
						i === 3
							? 'TN:\nSF:src/shard3.ts\nend_of_record\n'
							: lcovFixture(`src/shard${i}.ts`, 5, 5),
					);
				}
			});
			const result = runFinalize(partsDir, cwd, {});
			expect(result.exitCode).not.toBe(0);
			expect(result.stdout).toContain('contains no DA: records');
		},
		TEST_TIMEOUT_MS,
	);

	test(
		'failed shard job result fails closed BEFORE the part checks (partial uploads cannot pass)',
		async () => {
			if (isWindows) return;
			const { cwd, partsDir } = setupPartsFixture(
				'failed-result',
				(writePart) => {
					for (let i = 1; i <= 6; i++) {
						writePart(i, lcovFixture(`src/shard${i}.ts`, 5, 5));
					}
				},
			);
			const result = runFinalize(partsDir, cwd, {
				SHARD_JOB_RESULT: 'failure',
			});
			expect(result.exitCode).not.toBe(0);
			expect(result.stdout).toContain("not 'success'");
			// Ordering: the failure must be decided before any merge output.
			expect(result.stdout).not.toContain('Coverage:');
		},
		TEST_TIMEOUT_MS,
	);

	test(
		'unset shard job result also fails closed',
		async () => {
			if (isWindows) return;
			const { cwd, partsDir } = setupPartsFixture(
				'unset-result',
				(writePart) => {
					for (let i = 1; i <= 6; i++) {
						writePart(i, lcovFixture(`src/shard${i}.ts`, 5, 5));
					}
				},
			);
			const result = runFinalize(partsDir, cwd, { SHARD_JOB_RESULT: '' });
			expect(result.exitCode).not.toBe(0);
			expect(result.stdout).toContain("was ''");
		},
		TEST_TIMEOUT_MS,
	);

	test(
		'threshold breach fails closed with the measured value',
		async () => {
			if (isWindows) return;
			const { cwd, partsDir } = setupPartsFixture('breach', (writePart) => {
				for (let i = 1; i <= 6; i++) {
					// 1 of 2 lines covered -> 50.00% < 65.00 default.
					writePart(i, lcovFixture(`src/shard${i}.ts`, 2, 1));
				}
			});
			const result = runFinalize(partsDir, cwd, {});
			expect(result.exitCode).not.toBe(0);
			expect(result.stdout).toContain('Coverage gate failed: 50.00% < 65.00%');
		},
		TEST_TIMEOUT_MS,
	);

	test(
		'COVERAGE_THRESHOLD override is honored (same env contract as the pre-#2341 gate)',
		async () => {
			if (isWindows) return;
			const { cwd, partsDir } = setupPartsFixture('override', (writePart) => {
				for (let i = 1; i <= 6; i++) {
					writePart(i, lcovFixture(`src/shard${i}.ts`, 2, 1));
				}
			});
			const result = runFinalize(partsDir, cwd, {
				COVERAGE_THRESHOLD: '40.00',
			});
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain('Coverage gate passed: 50.00% >= 40.00%');
		},
		TEST_TIMEOUT_MS,
	);

	test(
		'non-numeric EXPECTED_SHARDS fails closed instead of mis-parsing',
		async () => {
			if (isWindows) return;
			const { cwd, partsDir } = setupPartsFixture(
				'bad-expected',
				(writePart) => {
					for (let i = 1; i <= 6; i++) {
						writePart(i, lcovFixture(`src/shard${i}.ts`, 5, 5));
					}
				},
			);
			const result = runFinalize(partsDir, cwd, { EXPECTED_SHARDS: 'six' });
			expect(result.exitCode).not.toBe(0);
			expect(result.stdout).toContain(
				'EXPECTED_SHARDS must be a positive integer',
			);
		},
		TEST_TIMEOUT_MS,
	);
});
