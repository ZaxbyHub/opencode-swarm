/**
 * Tests for the CI process-kill wrapper script (scripts/ci/run-test-with-timeout.ts).
 *
 * These tests verify:
 * - Normal exit code passthrough
 * - Timeout fires and kills process (exit code 124)
 * - JSON Lines timing output format
 * - [TIMEOUT] message on kill
 * - Arg parsing (--kill-timeout, env var, file path extraction)
 *
 * Each test spawns the wrapper as a subprocess with controlled fixtures.
 * Tests use short timeouts and fast fixtures to keep total runtime < 10s.
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..', '..');
const WRAPPER_PATH = join(
	REPO_ROOT,
	'scripts',
	'ci',
	'run-test-with-timeout.ts',
);
const QUICK_PASS_FIXTURE = join(
	REPO_ROOT,
	'tests',
	'unit',
	'scripts',
	'ci',
	'fixtures',
	'quick-pass-fixture.ts',
);
const HANGING_FIXTURE = join(
	REPO_ROOT,
	'tests',
	'unit',
	'scripts',
	'ci',
	'fixtures',
	'hanging-fixture.ts',
);

// ---------------------------------------------------------------------------
// Helper: spawn the wrapper and collect output
// ---------------------------------------------------------------------------

interface WrapperResult {
	stdout: string;
	stderr: string;
	exitCode: number | null;
}

/**
 * Spawn the wrapper as a subprocess and wait for it to complete.
 * Captures stdout and stderr for assertion.
 */
async function spawnWrapper(
	args: string[],
	opts?: { killTimeout?: number; env?: Record<string, string> },
): Promise<WrapperResult> {
	const env: Record<string, string> = {
		...process.env,
		CI_TEST_KILL_TIMEOUT: undefined as unknown as string, // clear it by default
		...opts?.env,
	};

	const wrapperArgs =
		opts?.killTimeout !== undefined
			? [`--kill-timeout`, String(opts.killTimeout), ...args]
			: args;

	const child = Bun.spawn(['bun', WRAPPER_PATH, ...wrapperArgs], {
		stdin: 'ignore',
		stdout: 'pipe',
		stderr: 'pipe',
		cwd: REPO_ROOT,
		env,
	});

	let stdout = '';
	let stderr = '';

	// Read stdout/stderr concurrently
	const stdoutPromise = new Response(child.stdout!).text();
	const stderrPromise = new Response(child.stderr!).text();

	const [stdoutResult, stderrResult] = await Promise.all([
		stdoutPromise,
		stderrPromise,
	]);
	stdout = stdoutResult;
	stderr = stderrResult;

	const exitCode = await child.exited;

	return { stdout, stderr, exitCode };
}

/**
 * Parse the first [TIMING] JSON line from stdout.
 * Returns null if no [TIMING] line found.
 */
interface TimingRecord {
	file: string;
	start: string;
	end: string;
	durationMs: number;
	exitCode: number;
	timedOut: boolean;
}

function parseTimingLine(stdout: string): TimingRecord | null {
	for (const line of stdout.split('\n')) {
		const trimmed = line.trim();
		if (trimmed.startsWith('[TIMING] ')) {
			const jsonStr = trimmed.slice('[TIMING] '.length);
			try {
				return JSON.parse(jsonStr) as TimingRecord;
			} catch {
				return null;
			}
		}
	}
	return null;
}

// ---------------------------------------------------------------------------
// Test cases
// ---------------------------------------------------------------------------

describe('run-test-with-timeout', () => {
	// --- 1. Normal completion ------------------------------------------------
	test('normal completion: exits with test exit code, timedOut=false', async () => {
		const result = await spawnWrapper([QUICK_PASS_FIXTURE]);

		expect(result.exitCode).toBe(0);

		const timing = parseTimingLine(result.stdout);
		expect(timing).not.toBeNull();
		expect(timing!.timedOut).toBe(false);
		expect(timing!.exitCode).toBe(0);
		expect(typeof timing!.durationMs).toBe('number');
		expect(timing!.durationMs).toBeGreaterThanOrEqual(0);
	}, 15_000);

	// --- 2. Timeout kill ----------------------------------------------------
	test('timeout kill: exits 124, emits [TIMEOUT] line, timedOut=true', async () => {
		// Use a very short timeout (2s) with the hanging fixture
		const result = await spawnWrapper([HANGING_FIXTURE], { killTimeout: 2 });

		// Exit code must be 124 (GNU timeout convention)
		expect(result.exitCode).toBe(124);

		// [TIMEOUT] message must appear on stderr
		const timeoutLine = result.stderr
			.split('\n')
			.find((l) => l.includes('[TIMEOUT]') && l.includes(HANGING_FIXTURE));
		expect(timeoutLine).toBeDefined();

		// [TIMING] timedOut must be true
		const timing = parseTimingLine(result.stdout);
		expect(timing).not.toBeNull();
		expect(timing!.timedOut).toBe(true);
		expect(timing!.exitCode).toBe(124);
	}, 15_000);

	// --- 3. JSON Lines format -----------------------------------------------
	test('JSON Lines timing output contains required fields', async () => {
		const result = await spawnWrapper([QUICK_PASS_FIXTURE]);

		const timing = parseTimingLine(result.stdout);
		expect(timing).not.toBeNull();

		// Verify all required fields are present and have correct types
		expect(typeof timing!.file).toBe('string');
		expect(timing!.file.length).toBeGreaterThan(0);

		expect(typeof timing!.start).toBe('string');
		// ISO timestamp format check
		expect(new Date(timing!.start).getTime()).not.toBeNaN();

		expect(typeof timing!.end).toBe('string');
		expect(new Date(timing!.end).getTime()).not.toBeNaN();

		expect(typeof timing!.durationMs).toBe('number');
		expect(timing!.durationMs).toBeGreaterThanOrEqual(0);

		expect(typeof timing!.exitCode).toBe('number');

		expect(typeof timing!.timedOut).toBe('boolean');

		// durationMs should be consistent with start/end timestamps
		const computed =
			new Date(timing!.end).getTime() - new Date(timing!.start).getTime();
		expect(timing!.durationMs).toBe(computed);
	}, 15_000);

	// --- 4. Arg parsing -----------------------------------------------------
	describe('arg parsing', () => {
		test('--kill-timeout overrides CI_TEST_KILL_TIMEOUT env var', async () => {
			// Env var says 999s, but --kill-timeout says 2s → should actually kill fast
			const result = await spawnWrapper([HANGING_FIXTURE], {
				killTimeout: 2,
				env: { CI_TEST_KILL_TIMEOUT: '999' },
			});

			// If --kill-timeout correctly overrides, we get a 124 timeout (fast)
			// rather than hanging for 999s
			expect(result.exitCode).toBe(124);
			const timeoutLine = result.stderr
				.split('\n')
				.find((l) => l.includes('[TIMEOUT]'));
			expect(timeoutLine).toBeDefined();
		});

		test('CI_TEST_KILL_TIMEOUT env var is used when --kill-timeout absent', async () => {
			// Use CI_TEST_KILL_TIMEOUT = 2 (seconds), no --kill-timeout arg
			const result = await spawnWrapper([HANGING_FIXTURE], {
				env: { CI_TEST_KILL_TIMEOUT: '2' },
			});

			expect(result.exitCode).toBe(124);
			const timeoutLine = result.stderr
				.split('\n')
				.find((l) => l.includes('[TIMEOUT]'));
			expect(timeoutLine).toBeDefined();
		});

		test('file path extracted as first non-dash arg', async () => {
			// Create a temp fixture
			const tmpDir = mkdtempSync(join(tmpdir(), 'wrapper-test-'));
			const tmpFixture = join(tmpDir, 'tmp-fixture.test.ts');
			writeFileSync(
				tmpFixture,
				`
import { test, expect } from 'bun:test';
test('temp', () => { expect(1).toBe(1); });
`,
			);
			try {
				const result = await spawnWrapper([tmpFixture]);

				expect(result.exitCode).toBe(0);

				const timing = parseTimingLine(result.stdout);
				expect(timing).not.toBeNull();
				// The file path in the record should match the fixture
				expect(timing!.file).toBe(tmpFixture);
			} finally {
				rmSync(tmpDir, { recursive: true, force: true });
			}
		});
	}, 15_000);

	// --- 5. Exit code passthrough -------------------------------------------
	test('exit code passthrough: failing test exits with non-zero code', async () => {
		// Create a temp fixture that fails (non-zero exit)
		const tmpDir = mkdtempSync(join(tmpdir(), 'wrapper-test-'));
		const tmpFailingFixture = join(tmpDir, 'failing.test.ts');
		writeFileSync(
			tmpFailingFixture,
			`
import { test, expect } from 'bun:test';
test('fail', () => { expect(1).toBe(2); });
`,
		);

		// Also need to ensure no CI_TEST_KILL_TIMEOUT env var interferes
		const result = await spawnWrapper(
			[tmpFailingFixture],
			{ env: { CI_TEST_KILL_TIMEOUT: '30' } }, // long timeout so we don't timeout first
		);

		try {
			// bun test exits 1 when a test fails
			expect(result.exitCode).toBe(1);

			const timing = parseTimingLine(result.stdout);
			expect(timing).not.toBeNull();
			expect(timing!.exitCode).toBe(1);
			expect(timing!.timedOut).toBe(false);
		} finally {
			rmSync(tmpDir, { recursive: true, force: true });
		}
	}, 15_000);

	// --- 6. Prominent [TIMEOUT] log line ------------------------------------
	test('[TIMEOUT] log line identifies the hanging file', async () => {
		const result = await spawnWrapper([HANGING_FIXTURE], { killTimeout: 2 });

		expect(result.exitCode).toBe(124);

		// The [TIMEOUT] line must contain the file path
		const timeoutLines = result.stderr
			.split('\n')
			.filter((l) => l.includes('[TIMEOUT]'));
		expect(timeoutLines.length).toBeGreaterThan(0);

		// File path should appear in the timeout message
		const timeoutLine = timeoutLines[0];
		expect(timeoutLine).toContain(HANGING_FIXTURE);
		expect(timeoutLine).toContain('exceeded');
		expect(timeoutLine).toContain('ms'); // contains the duration
	}, 15_000);
});
