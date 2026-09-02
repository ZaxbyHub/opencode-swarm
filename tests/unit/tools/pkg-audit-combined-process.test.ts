/**
 * Combined-process regression test for the pkg-audit shard hang (issue #2260,
 * root-fixed under #2477).
 *
 * `tests/unit/tools/pkg-audit-composer.test.ts` (and its `.adversarial`
 * sibling) used to register a file-scope `mock.module` of
 * `src/build/discovery` whose "delegate to the real module" branch was
 * infinite tail recursion: Bun's `mock.module` retroactively patches the
 * original module's export slots, so the captured pre-mock namespace import
 * resolved the overridden export back to the mock itself. Solo, the composer
 * suites never exercised the delegation branch; co-located in one process,
 * the first later test calling `isCommandAvailable` for a non-composer
 * command (the dart/govulncheck/dotnet availability guards in
 * pkg-audit.test.ts) spun forever — the shard hit the wall-clock timeout
 * (rc=124) and presented as an infrastructure flake.
 *
 * This test pins the #2260 acceptance criterion — "both files pass when run
 * in a single process, in either order" — by actually running them in a
 * subprocess pair, with deterministic subprocess cleanup (tree kill on
 * timeout) so a regression can never wedge the parent suite.
 */

import { describe, expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));

// Platform data-dir env vars are captured at module load — before any test in
// the shared parent process could redirect them — and forced back for the
// child, so the child's tripwire preload captures a hermetic baseline even if
// a sibling test in this process mutated the environment.
const PLATFORM_ENV_KEYS = [
	'HOME',
	'USERPROFILE',
	'LOCALAPPDATA',
	'XDG_DATA_HOME',
] as const;
const capturedPlatformEnv: Record<string, string | undefined> = {};
for (const key of PLATFORM_ENV_KEYS) {
	capturedPlatformEnv[key] = process.env[key];
}

// 60s per child: ~30x the healthy ~2s runtime, and two sequential hung
// children (120s) stay under this suite's 180s per-test budget so a
// regression reports the specific assertion, not a generic wrapper kill
// (review PRR-013).
const CHILD_TIMEOUT_MS = 60_000;
const KEEPALIVE_PRELOAD = fileURLToPath(
	new URL('../../ci/bun-32056-keepalive.ts', import.meta.url),
);

function childEnv(): Record<string, string> {
	// Clone the parent env, then pin the platform data-dir variables to their
	// module-load values (deleting keys that were unset at capture time).
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined) env[key] = value;
	}
	for (const key of PLATFORM_ENV_KEYS) {
		const captured = capturedPlatformEnv[key];
		if (captured === undefined) delete env[key];
		else env[key] = captured;
	}
	return env;
}

interface ChildRun {
	exitCode: number;
	timedOut: boolean;
	// bun test writes its results to stderr when stdout is not a TTY, so the
	// assertion surface is the combined output.
	output: string;
}

async function runTestPairInOneProcess(files: string[]): Promise<ChildRun> {
	// Mirrors scripts/ci/run-test-with-timeout.ts: detached so the whole
	// process tree is killable (taskkill /T /F on Windows, negative-pid
	// SIGKILL to the process group on Unix), stdin ignored, bounded output.
	const child = Bun.spawn(
		[
			process.execPath,
			'--smol',
			'--preload',
			KEEPALIVE_PRELOAD,
			'test',
			...files,
			'--timeout',
			'60000',
		],
		{
			cwd: REPO_ROOT,
			detached: true,
			stdin: 'ignore',
			stdout: 'pipe',
			stderr: 'pipe',
			env: childEnv(),
		},
	);

	const stdoutPromise = child.stdout.text().catch(() => '');
	const stderrPromise = child.stderr.text().catch(() => '');
	// The timeout is derived from the race WINNER, not a mutable flag: an
	// async setTimeout callback can still run after clearTimeout once queued,
	// which previously flipped `timedOut` to true for a cleanly-exited child
	// (review PRR-003 late-fire race).
	let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
	const winner = await Promise.race([
		child.exited.then((code) => ({ kind: 'exit' as const, code })),
		new Promise<{ kind: 'timeout' }>((resolve) => {
			timeoutTimer = setTimeout(
				() => resolve({ kind: 'timeout' }),
				CHILD_TIMEOUT_MS,
			);
		}),
	]);
	if (timeoutTimer) clearTimeout(timeoutTimer);
	if (winner.kind === 'timeout') {
		// Deterministic tree cleanup on the timeout path (review PRR-008):
		// taskkill gets an explicit cwd and a bounded wait so the best-effort
		// fallback below always runs even if taskkill itself hangs.
		try {
			if (process.platform === 'win32') {
				const killer = Bun.spawn(
					['taskkill', '/T', '/F', '/PID', String(child.pid!)],
					{
						cwd: REPO_ROOT,
						stdin: 'ignore',
						stdout: 'ignore',
						stderr: 'ignore',
					},
				);
				await Promise.race([
					killer.exited,
					new Promise((resolve) => {
						const t = setTimeout(resolve, 10_000);
						(t as { unref?: () => void }).unref?.();
					}),
				]);
			} else {
				process.kill(-child.pid!, 'SIGKILL');
			}
		} catch {
			// Child may have exited between the timeout and the kill.
		}
		try {
			child.kill('SIGKILL');
		} catch {
			// Best-effort fallback only.
		}
	}
	const timedOut = winner.kind === 'timeout';
	const rawExitCode = winner.kind === 'exit' ? winner.code : 124;
	return {
		exitCode: timedOut ? 124 : rawExitCode,
		timedOut,
		output: `${await stdoutPromise}\n${await stderrPromise}`,
	};
}

const PKG_AUDIT = 'tests/unit/tools/pkg-audit.test.ts';
const PKG_AUDIT_COMPOSER = 'tests/unit/tools/pkg-audit-composer.test.ts';
const PKG_AUDIT_BATCH = 'tests/unit/tools/batch-tool-migrations.test.ts';

describe('pkg-audit combined-process co-location (issue #2260)', () => {
	// Wall-clock generous enough for cold CI runners; the healthy pair
	// completes in ~2s (bun startup + 87 fast tests).
	test('pkg-audit + pkg-audit-composer pass in one process (composer second)', async () => {
		const run = await runTestPairInOneProcess([PKG_AUDIT, PKG_AUDIT_COMPOSER]);
		expect(run.timedOut).toBe(false);
		expect(run.exitCode).toBe(0);
		expect(run.output).toContain('Ran 87 tests across 2 files');
	}, 180_000);

	test('pkg-audit + pkg-audit-composer pass in one process (composer first)', async () => {
		const run = await runTestPairInOneProcess([PKG_AUDIT_COMPOSER, PKG_AUDIT]);
		expect(run.timedOut).toBe(false);
		expect(run.exitCode).toBe(0);
		expect(run.output).toContain('Ran 87 tests across 2 files');
	}, 180_000);

	// Review F-003/PRR-004 pin: batch-tool-migrations historically held a
	// file-scope `mock.module` of `src/build/discovery` whose unconditional
	// availability override masked the composer suite's DI seam when the two
	// shared a process (main failed BOTH orders with 2 fails + 2 errors; the
	// batch mock now migrated to the seam, so both orders must pass). Exact
	// count is an intentional pin, same as above: 21 batch + 13 composer.
	test('pkg-audit-composer + batch-tool-migrations pass in one process (composer first)', async () => {
		const run = await runTestPairInOneProcess([
			PKG_AUDIT_COMPOSER,
			PKG_AUDIT_BATCH,
		]);
		expect(run.timedOut).toBe(false);
		expect(run.exitCode).toBe(0);
		expect(run.output).toContain('Ran 34 tests across 2 files');
	}, 180_000);

	test('batch-tool-migrations + pkg-audit-composer pass in one process (composer second)', async () => {
		const run = await runTestPairInOneProcess([
			PKG_AUDIT_BATCH,
			PKG_AUDIT_COMPOSER,
		]);
		expect(run.timedOut).toBe(false);
		expect(run.exitCode).toBe(0);
		expect(run.output).toContain('Ran 34 tests across 2 files');
	}, 180_000);
});
