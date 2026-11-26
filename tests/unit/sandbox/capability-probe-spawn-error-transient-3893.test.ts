/**
 * #3893 AC12 — win32 spawn-error probe results are TRANSIENT, not permanent.
 *
 * At base, probeWindows() labeled a cmd.exe spawn error (EPERM/EACCES/EBUSY)
 * only in the `error` free-text; the result upgraded to a disabled V1
 * capability with no 'probe temp setup failed' marker, so hasProbeSetupFailureReason
 * missed it, the memo took the permanent `_cached` slot, and every later
 * detect() served the disabled answer for the process lifetime.
 *
 * The fix carries `reasons: ['probe spawn failed: <code>']` on the spawn-error
 * return and matches that marker in hasProbeSetupFailureReason, so the result
 * takes the F-001 transient slot: detect() keeps re-probing while the
 * fail-closed disabled display is preserved.
 *
 * Determinism (no platform skip): the REAL probeWindows spawn-error path is
 * exercised on every host by driving `_internals.probePlatform` with 'win32'
 * (the switch dispatches on its argument, not on process.platform), with
 * `_internals.spawnSync` stubbed to the error shape and the runner-client
 * binary resolver forced to a miss. The memo logic under test is
 * platform-neutral behind that win32 probe stub; CI's three-platform matrix
 * runs this suite on every host. NEVER really spawns: the spawn seam is
 * stubbed for every leg. All seams plus the capability cache are restored in
 * finally.
 */

import { describe, expect, test } from 'bun:test';
import {
	_internals,
	_resetCapabilityCache,
	SandboxCapabilityProbe,
} from '../../../src/sandbox/capability-probe';
import { _internals as runnerClientInternals } from '../../../src/sandbox/win32/runner-client';

/** Stub shape: a spawnSync result that failed to spawn (EPERM). */
function epermSpawnResult(): ReturnType<typeof _internals.spawnSync> {
	const err = new Error('spawn EPERM') as NodeJS.ErrnoException;
	err.code = 'EPERM';
	return { error: err } as ReturnType<typeof _internals.spawnSync>;
}

describe('capability probe spawn-error transient classification (#3893 AC12)', () => {
	test('probeWindows spawn-error return keeps the error string and carries the transient marker', async () => {
		_resetCapabilityCache();
		const originalSpawnSync = _internals.spawnSync;
		const originalFindRunnerBinary = runnerClientInternals.findRunnerBinary;
		try {
			_internals.spawnSync = (() =>
				epermSpawnResult()) as typeof originalSpawnSync;
			runnerClientInternals.findRunnerBinary = () => null;

			// Drive the REAL probeWindows through the platform dispatch seam.
			const probed = await _internals.probePlatform('win32');

			expect(probed.status).toBe('disabled');
			expect(probed.platform).toBe('win32');
			// Existing error string preserved (byte-compat with the base shape).
			expect(probed.error).toBe('cmd.exe probe failed: EPERM');
			// The transient marker the classifier matches on.
			expect(probed.reasons).toEqual(['probe spawn failed: EPERM']);
		} finally {
			_internals.spawnSync = originalSpawnSync;
			runnerClientInternals.findRunnerBinary = originalFindRunnerBinary;
			_resetCapabilityCache();
		}
	}, 30_000);

	test('a spawn-error disabled result re-probes on the next detect while the first detect stays disabled (fail-closed display)', async () => {
		_resetCapabilityCache();
		const originalSpawnSync = _internals.spawnSync;
		const originalFindRunnerBinary = runnerClientInternals.findRunnerBinary;
		const originalProbePlatform = _internals.probePlatform;
		let spawnCalls = 0;
		try {
			_internals.spawnSync = (() => {
				spawnCalls += 1;
				return epermSpawnResult();
			}) as typeof originalSpawnSync;
			runnerClientInternals.findRunnerBinary = () => null;
			// Platform-neutral: detect() on any host resolves the REAL win32
			// probe (and thus the real spawn-error arm) through the seam.
			_internals.probePlatform = (async () =>
				originalProbePlatform('win32')) as typeof originalProbePlatform;

			const probe = new SandboxCapabilityProbe();
			const first = await probe.detect();
			// Fail-closed display: the spawn error reports disabled, never enabled.
			expect(first.status).toBe('disabled');
			expect(
				first.reasons.some((reason) => reason.includes('probe spawn failed')),
			).toBe(true);
			const spawnCallsAfterFirst = spawnCalls;

			// The transient slot must NOT memoize: the second detect re-probes.
			const second = await probe.detect();
			expect(spawnCalls).toBeGreaterThan(spawnCallsAfterFirst);
			expect(spawnCalls).toBeGreaterThanOrEqual(2);
			expect(second.status).toBe('disabled');
		} finally {
			_internals.spawnSync = originalSpawnSync;
			runnerClientInternals.findRunnerBinary = originalFindRunnerBinary;
			_internals.probePlatform = originalProbePlatform;
			_resetCapabilityCache();
		}
	}, 30_000);

	test('CONTROL: a HEALTHY enabled memo still memoizes without re-probing (one spawnSync across two detects)', async () => {
		_resetCapabilityCache();
		const originalSpawnSync = _internals.spawnSync;
		const originalFindRunnerBinary = runnerClientInternals.findRunnerBinary;
		const originalProbePlatform = _internals.probePlatform;
		let spawnCalls = 0;
		try {
			_internals.spawnSync = (() => {
				spawnCalls += 1;
				return { status: 0, stdout: 'ok', stderr: '' } as ReturnType<
					typeof originalSpawnSync
				>;
			}) as typeof originalSpawnSync;
			runnerClientInternals.findRunnerBinary = () => null;
			_internals.probePlatform = (async () =>
				originalProbePlatform('win32')) as typeof originalProbePlatform;

			const probe = new SandboxCapabilityProbe();
			const first = await probe.detect();
			expect(first.status).toBe('enabled');
			expect(first.mechanism).toBe('PowerShell wrapper');
			// The fix must not force endless re-probes: a healthy answer
			// memoizes (the win32 degraded-fallback TTL is 60 s by default, far
			// beyond this test's window).
			await probe.detect();
			expect(spawnCalls).toBe(1);
		} finally {
			_internals.spawnSync = originalSpawnSync;
			runnerClientInternals.findRunnerBinary = originalFindRunnerBinary;
			_internals.probePlatform = originalProbePlatform;
			_resetCapabilityCache();
		}
	}, 30_000);
});
