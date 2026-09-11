import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import { rmSync, writeFileSync } from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { withFrozenClock } from '../../../helpers/test-clock.js';
import { canonicalMkdtemp } from '../../../helpers/tmpdir';

const REPO_ROOT = path.resolve(import.meta.dir, '../../../..');
const LOCAL_UNIT_ENTRY = path.join(
	REPO_ROOT,
	'scripts',
	'ci',
	'run-unit-tests-local.ts',
);
const VALIDATION_ENTRY = path.join(
	REPO_ROOT,
	'scripts',
	'ci',
	'repository-validation.ts',
);
const PACKAGE_JSON = path.join(REPO_ROOT, 'package.json');

const FIXED_ISO_NOW = '2026-01-01T00:00:00.000Z';

function isoNow(): string {
	return withFrozenClock(() => new Date().toISOString(), {
		fixedNow: 1_767_225_600_000,
		isoNow: FIXED_ISO_NOW,
	});
}

interface ChildResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

async function runBun(
	args: string[],
	options?: { env?: Record<string, string | undefined> },
): Promise<ChildResult> {
	const child = Bun.spawn(['bun', ...args], {
		cwd: REPO_ROOT,
		stdin: 'ignore',
		stdout: 'pipe',
		stderr: 'pipe',
		timeout: 10_000,
		env: { ...process.env, ...options?.env },
	});
	try {
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		return { stdout, stderr, exitCode };
	} finally {
		try {
			child.kill('SIGKILL');
		} catch {
			// The bounded child may already have exited.
		}
	}
}

function createFixture(
	directory: string,
	name: string,
	source: string,
): string {
	const filePath = path.join(directory, name);
	writeFileSync(filePath, source, 'utf8');
	return filePath;
}

describe('issue #2675 compatibility entry point', () => {
	test('test:unit:ci remains a public identity and delegates execution to the shared authority', () => {
		const packageJson = JSON.parse(fs.readFileSync(PACKAGE_JSON, 'utf8')) as {
			scripts?: Record<string, string>;
		};
		const localEntry = fs.readFileSync(LOCAL_UNIT_ENTRY, 'utf8');

		expect(packageJson.scripts?.['test:unit:ci']).toBe(
			'bun scripts/ci/run-unit-tests-local.ts',
		);
		expect(localEntry).toMatch(/repository-validation(?:\.ts)?/);
		expect(localEntry).toMatch(
			/validateRepository|repositoryValidationMain|main/,
		);
		expect(localEntry).toContain('buildSurfaceItems');
		expect(localEntry).not.toMatch(/walkTestFiles|find tests\//);
		expect(localEntry).not.toContain('Bun.spawn');
		expect(localEntry).not.toContain('run-test-with-timeout.ts');
	});

	test('positional file arguments preserve ordering, retry budget, and exit-code semantics', async () => {
		const fixtureDirectory = canonicalMkdtemp('repository-validation-compat-');
		const orderLog = path.join(fixtureDirectory, 'order.log');
		const retryMarker = path.join(fixtureDirectory, 'retry.marker');
		const passing = createFixture(
			fixtureDirectory,
			'z-pass.test.ts',
			"import { test } from 'bun:test';\nimport { appendFileSync } from 'node:fs';\ntest('ordered pass', () => appendFileSync(process.env.VALIDATION_ORDER_LOG!, 'z\\n'));\n",
		);
		const retrying = createFixture(
			fixtureDirectory,
			'a-retry.test.ts',
			"import { test, expect } from 'bun:test';\nimport { appendFileSync, existsSync, writeFileSync } from 'node:fs';\nconst marker = process.env.VALIDATION_RETRY_MARKER!;\ntest('retry then pass', () => { appendFileSync(process.env.VALIDATION_ORDER_LOG!, 'a\\n'); if (!existsSync(marker)) { writeFileSync(marker, 'first'); expect(false).toBe(true); } });\n",
		);

		try {
			const result = await runBun(
				['scripts/ci/run-unit-tests-local.ts', passing, retrying],
				{
					env: {
						VALIDATION_ORDER_LOG: orderLog,
						VALIDATION_RETRY_MARKER: retryMarker,
					},
				},
			);
			expect(result.exitCode).toBe(0);
			const order = fs.readFileSync(orderLog, 'utf8').trim().split(/\r?\n/);
			expect(order).toEqual(['a', 'a', 'z']);
			expect(fs.readFileSync(retryMarker, 'utf8')).toBe('first');
			expect(`${result.stdout}\n${result.stderr}`).toMatch(
				/(?:TIMING|status|passed|retry)/i,
			);

			const failing = createFixture(
				fixtureDirectory,
				'fail.test.ts',
				"import { test, expect } from 'bun:test';\ntest('known failure', () => expect(1).toBe(2));\n",
			);
			const failedResult = await runBun([
				'scripts/ci/run-unit-tests-local.ts',
				failing,
			]);
			expect(failedResult.exitCode).not.toBe(0);
			expect(`${failedResult.stdout}\n${failedResult.stderr}`).toMatch(
				/(?:FAILED|failed|status)/i,
			);
		} finally {
			rmSync(fixtureDirectory, { recursive: true, force: true });
		}
	}, 30_000);
});

describe('issue #2675 package and CLI wiring', () => {
	test('package exposes validate:repo as the supported shared-authority command', () => {
		const packageJson = JSON.parse(fs.readFileSync(PACKAGE_JSON, 'utf8')) as {
			scripts?: Record<string, string>;
		};
		const command = packageJson.scripts?.['validate:repo'] ?? '';
		expect(command).toContain('repository-validation.ts');
		expect(command).toMatch(/^bun(?: run)?\s/);
	});

	test.each([
		['--unknown-option'],
		['--mode', 'not-a-mode'],
		['--root'],
		['--timeout', 'not-a-number'],
	])('CLI rejects malformed argument vector %j before discovery', async (...args: string[]) => {
		const result = await runBun([VALIDATION_ENTRY, ...args]);
		expect(result.exitCode).not.toBe(0);
		expect(`${result.stdout}\n${result.stderr}`).toMatch(
			/(?:unknown|invalid|usage|argument|option|malformed|must|required|requires)/i,
		);
	}, 15_000);
});

describe('issue #2675 report writer safety', () => {
	test('writes a complete JSON report atomically under .swarm and rejects escape paths', async () => {
		const root = canonicalMkdtemp('repository-validation-report-');
		try {
			const { writeValidationReport } = await import(
				'../../../../scripts/ci/repository-validation'
			);
			const report = {
				schemaVersion: 1 as const,
				status: 'passed' as const,
				mode: 'full' as const,
				root,
				diffBase: 'origin/main',
				runtime: { bunVersion: 'test', platform: 'test', arch: 'test' },
				inventory: ['unit'] as ['unit'],
				bounds: {
					testTimeoutMs: 120_000,
					perItemTimeoutMs: 180_000,
					suiteTimeoutMs: 900_000,
					maxOutputBytes: 65_536,
				},
				terminalStatuses: ['passed'] as ['passed'],
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
				startedAt: isoNow(),
				endedAt: isoNow(),
				durationMs: 0,
			};
			const requested = path.join(root, '.swarm', 'report.json');
			const written = await writeValidationReport(report, requested);
			// The writer deliberately publishes through the realpath-resolved parent
			// to close Windows 8.3 and macOS symlink aliases before doing I/O.
			const canonicalRequested = path.join(
				await fsp.realpath(path.dirname(requested)),
				path.basename(requested),
			);
			expect(path.resolve(written)).toBe(path.resolve(canonicalRequested));
			const parsed = JSON.parse(
				await fsp.readFile(written, 'utf8'),
			) as typeof report & { reportPath: string };
			expect(parsed.schemaVersion).toBe(1);
			expect(parsed.reportPath).toBe(path.resolve(canonicalRequested));
			expect(await fsp.readdir(path.dirname(written))).toEqual(['report.json']);

			const outside = path.join(
				root,
				'..',
				'escaped-repository-validation.json',
			);
			await expect(writeValidationReport(report, outside)).rejects.toThrow(
				/must remain under/,
			);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
