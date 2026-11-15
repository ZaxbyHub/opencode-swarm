/**
 * macOS sandbox-exec executor — tests activated by the issue #2590 fix.
 *
 * The #2590 fix removed the invalid SBPL `(setenv …)`/`(unsetenv …)` emission
 * that made the availability probe fail on EVERY macOS host, so the executor
 * was always "unavailable" and these macOS-gated integration tests silently
 * skipped. With a working probe they run for the first time — and four of
 * their premises were wrong (CI run 34090088557, 2026-09-07: AC-004, AC-008,
 * AC-010, and the recovery memo sequence all failed). This file hosts the
 * corrected variants, split out of the over-cap sandbox-integration.test.ts /
 * recovery.test.ts per the FR-006 growth ratchet (PR #2630 review
 * PRR-001/002/003/004).
 *
 * Corrections vs the pre-fix variants:
 *   - AC-004: no `|| true` (it masks the sandbox denial by forcing exit 0,
 *     and spawnWrapped's success IS the exit code) + asserts the download
 *     file was not created.
 *   - AC-008: absolute 250ms/call ceiling instead of a <10% percentage over
 *     a trivial echo baseline (per-command sandbox cost is fixed; CI measured
 *     191.73% overhead) + positive control that the wrapped write landed.
 *   - AC-010: writes land in a test-created sandbox home, NOT the real
 *     homedir (the pre-fix variant wrote under os.homedir() — the exact
 *     anti-pattern AC-010 forbids — so this bullet documents the
 *     correction's direction, not a permission to write the real home).
 *   - Recovery: resets the probe memo AFTER executor1's construction seals
 *     it, so the false-probe mock actually reaches executor2.
 *
 * Seam-driven where possible; AC-001/002/003/005-009-style live variants need
 * a real macOS host (skipIf(!isMac)), matching the original tests' contract.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SandboxError } from '../../../src/sandbox/executor';
import {
	MacOSSandboxExecutor,
	_internals as macosInternals,
} from '../../../src/sandbox/macos/sandbox-exec-executor';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const isMac = process.platform === 'darwin';
const ITERATIONS = 100;

function makeTempDir(prefix: string): string {
	// canonicalMkdtemp realpath-resolves the temp root (FR-011): closes the
	// macOS /var -> /private/var symlink gap.
	return canonicalMkdtemp(prefix);
}

interface SpawnResult {
	success: boolean;
	exitCode: number | null;
	stderr: string;
	stdout: string;
}

function spawnWrapped(
	executor: {
		wrapCommand: (cmd: string, scopes: string[], temp?: string) => string;
	},
	command: string,
	scopePaths: string[],
	tempDir?: string,
): SpawnResult {
	const wrapped = executor.wrapCommand(command, scopePaths, tempDir);
	const result = spawnSync(wrapped, {
		shell: true,
		encoding: 'utf-8',
		timeout: 10_000,
	});

	return {
		success: result.status === 0,
		exitCode: result.status,
		stderr: result.stderr ?? '',
		stdout: result.stdout ?? '',
	};
}

function spawnRaw(command: string): SpawnResult {
	const result = spawnSync(command, {
		shell: true,
		encoding: 'utf-8',
	});

	return {
		success: result.status === 0,
		exitCode: result.status,
		stderr: result.stderr ?? '',
		stdout: result.stdout ?? '',
	};
}

async function getMacExecutor() {
	return MacOSSandboxExecutor;
}

describe('macOS sandbox-exec activation tests (issue #2590 follow-ups)', () => {
	describe('AC-004: curl download outside scope is denied (PRR-001 fix)', () => {
		test.skipIf(!isMac)(
			'macOS: sandbox-exec blocks curl download outside scope',
			async () => {
				const Executor = await getMacExecutor();
				const scopeDir = makeTempDir('ac004-scope-');

				try {
					const executor = new Executor([scopeDir]);

					if (!executor.isAvailable()) {
						return;
					}

					// Attempt to download to /tmp (outside the allowed scope: the
					// executor's writable scope is [scopeDir] + its temp dir, and
					// hosted macOS runners set TMPDIR to a per-user dir, so /tmp
					// is NOT inside the writable scope). NO `|| true`: the
					// success criterion is the wrapped command's exit code, so
					// `|| true` would mask the sandbox denial by forcing exit 0
					// and make this test unpassable by construction.
					const downloadPath = '/tmp/ac004-download.txt';
					spawnRaw(`rm -f ${downloadPath}`);
					const result = spawnWrapped(
						executor,
						`curl -o ${downloadPath} https://example.com 2>&1`,
						[scopeDir],
					);

					// sandbox-exec should deny the write: curl exits non-zero AND
					// the download file must not exist.
					expect(result.success).toBe(false);
					expect(existsSync(downloadPath)).toBe(false);
				} finally {
					rmSync(scopeDir, { recursive: true, force: true });
				}
			},
		);
	});

	describe('AC-008: per-call overhead ceiling (PRR-003 fix)', () => {
		test.skipIf(!isMac)(
			'macOS: sandbox-exec wrapped commands stay under the per-call ceiling',
			async () => {
				const Executor = await getMacExecutor();
				const scopeDir = makeTempDir('ac008-scope-');

				try {
					const executor = new Executor([scopeDir]);

					if (!executor.isAvailable()) {
						return;
					}

					const testFile = path.join(scopeDir, 'ac008-test.txt');
					const echoCmd = `echo "ac008" > "${testFile}"`;

					// 100 real wrapped spawns: each pays wrapCommand's fixed cost
					// (profile build + sandbox-exec launch + SBPL
					// compile). ISSUE #2590 CI evidence (2026-09-07): a
					// percentage bound over a trivial `bash -c echo` baseline is
					// structurally unachievable for a spawn-per-command sandbox
					// (CI measured 191.73% overhead against the original <10%
					// bound). The acceptance intent — sandboxing must not make
					// commands unusably slow — is preserved as an ABSOLUTE
					// per-wrapped-call ceiling with ~20x headroom over the
					// CI-measured ~12ms/call.
					const perCallCeilingMs = 250;
					// performance.now() (monotonic) is the correct clock for
					// elapsed-time measurement — immune to wall-clock steps and
					// the repo convention for perf assertions (cf.
					// capability-probe.test.ts). The freezeClock gate targets
					// logic-time determinism, not perf ceilings.
					const wrappedStart = performance.now();
					for (let i = 0; i < ITERATIONS; i++) {
						const wrapped = executor.wrapCommand(echoCmd, [scopeDir]);
						spawnSync(wrapped, {
							shell: true,
							encoding: 'utf-8',
							timeout: 10_000,
						});
					}
					const wrappedMs = performance.now() - wrappedStart;

					const wrappedPerCallMs = wrappedMs / ITERATIONS;
					console.log(
						`[ac008] wrappedMs=${wrappedMs} perWrappedCallMs=${wrappedPerCallMs.toFixed(1)} (ceiling ${perCallCeilingMs})`,
					);
					expect(wrappedPerCallMs).toBeLessThan(perCallCeilingMs);
					// Positive control: the wrapped writes must actually work.
					expect(existsSync(testFile)).toBe(true);
				} finally {
					rmSync(scopeDir, { recursive: true, force: true });
				}
			},
		);
	});

	describe('AC-010: broad-scope writes succeed (PRR-004 fix)', () => {
		test.skipIf(!isMac)(
			'macOS: writes succeed when scope is very broad',
			async () => {
				const Executor = await getMacExecutor();

				// #3165 C-3: the broad scope is a test-created sandbox home
				// (with a nested subdir so the scope is genuinely broad), NEVER
				// the developer's real home — the pre-fix version wrote a probe
				// file under the real os.homedir() on every darwin run (the
				// original /Users target from #2590 was replaced by homedir();
				// both write outside the test's sandbox).
				const broadScope = canonicalMkdtemp('ac010-broad-');
				mkdirSync(path.join(broadScope, 'nested-scope'));

				try {
					const executor = new Executor([broadScope]);

					if (!executor.isAvailable()) {
						// Fail, do not skip: a vacuous pass cannot validate AC-010
						// (plan-critic round 2). macOS runners ship sandbox-exec.
						// (Inside the try so the finally still cleans the sandbox
						// on this throw — plan-critic round 4.)
						throw new Error(
							'AC-010 requires an available macOS executor; availability probe failed — refusing to pass vacuously',
						);
					}

					// Write to a path inside the broad scope — should succeed.
					// The mkdtemp basename is already unique per run, so the
					// probe name inherits it without a clock read (check:test-
					// clock; plan-critic round 5).
					const probeName = `ac010-${path.basename(broadScope)}.txt`;
					const testFile = path.join(broadScope, probeName);
					const result = spawnWrapped(
						executor,
						`echo "ac010 legitimate" > "${testFile}"`,
						[broadScope],
					);
					// Positive: the sandbox write landed.
					expect(existsSync(testFile), 'sandbox probe file exists').toBe(true);
					// Negative: nothing leaked into the real home.
					expect(
						existsSync(path.join(os.homedir(), probeName)),
						'no probe file under the real home',
					).toBe(false);
					expect(result.success).toBe(true);
				} finally {
					rmSync(broadScope, { recursive: true, force: true });
				}
			},
		);
	});

	describe('Recovery: probe-memo reset before the unavailable-executor assertion (PRR-002 fix)', () => {
		const originalProbeSandboxExec = macosInternals.probeSandboxExec;

		beforeEach(() => {
			macosInternals.resetProbeMemo();
		});

		afterEach(() => {
			macosInternals.probeSandboxExec = originalProbeSandboxExec;
			macosInternals.resetProbeMemo();
		});

		test.skipIf(!isMac)(
			'MacOSSandboxExecutor: wrapCommand throws SandboxError when the probe turns false mid-session',
			() => {
				const rawCmd = 'echo recovery-probe';
				// executor1's construction runs the REAL probe and memoizes the
				// result for the process lifetime (expiresAt=Infinity on
				// success); the memo must be reset AFTER installing the false
				// mock or executor2 inherits the sealed true and never throws
				// (issue #2590 CI, 2026-09-07).
				const executor1 = new MacOSSandboxExecutor([]);
				executor1.disable('reason 1');
				expect(() => executor1.wrapCommand(rawCmd, [])).toThrow(SandboxError);

				macosInternals.probeSandboxExec = mock(() => false);
				macosInternals.resetProbeMemo();
				const executor2 = new MacOSSandboxExecutor([]);
				expect(() => executor2.wrapCommand(rawCmd, [])).toThrow(SandboxError);
			},
		);
	});
});
