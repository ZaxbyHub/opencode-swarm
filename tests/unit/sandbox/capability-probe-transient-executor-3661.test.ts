/**
 * PR #3718 feedback round — F-001 (swarm-pr-review, critic-upheld HIGH).
 *
 * The #3661 item-5 fix stopped memoizing setup-failure probe results — but
 * the synchronous accessors read ONLY the memoized slot, so an ENABLED
 * binary-stage capability whose behavioral probe hit a transient temp-setup
 * failure became invisible: executor.ts's `_create*Executor` saw
 * "unavailable", `getExecutor()` resolved and then MEMOIZED a null executor
 * for the process lifetime, advisory-mode shell commands ran UNSANDBOXED,
 * and required mode hard-blocked every bash call. The base behavior kept
 * them sandboxed-with-weak-evidence.
 *
 * The fix parks the transient observation in a second, accessor-visible
 * slot that the memo check never serves — re-probing stays live (#3661
 * item 5) while an enabled capability stays visible. Accessor precedence is
 * IDENTITY-GATED: a slot is consulted only when it was recorded for the
 * CURRENT probe-source identity, memoized result first, transient second
 * (the probe-source identity is driven through the
 * `_internals.currentProbeSourceIdentity` seam by legs L4/L5). Leg 2 pins
 * memoized-outranks-transient at the same identity; L4 pins the
 * reviewer-counterexample case (stale-identity disabled memo must NOT mask
 * a fresh enabled transient re-probe after a binary change — a plain
 * `_cached ?? _cachedTransient` preference fails exactly there); L5 pins
 * the transient slot's own identity gate (an accessor read without an
 * intervening re-probe after an identity change is fail-closed, and the
 * next detect() restores visibility at the fresh identity).
 *
 * Determinism: the binary-stage probe is driven through the
 * `_internals.probePlatform` seam with a capability tagged to the HOST
 * platform (the accessors discriminate on the capability's own
 * status/platform pair, and the executor creators dispatch on the real
 * process.platform, so the host tag makes every leg exercise the host's
 * own path), and the setup-failure marker is injected through
 * `_internals.detectBehavioralEvidence` exactly as the #3661 memoization
 * battery does. Every host therefore runs its own real accessor +
 * executor-creation path — no platform-skipped legs.
 */

import { describe, expect, test } from 'bun:test';
import {
	_internals,
	_resetCapabilityCache,
	isBubblewrapAvailable,
	isSandboxExecAvailable,
	isWindowsSandboxAvailable,
	type SandboxCapability,
	SandboxCapabilityProbe,
} from '../../../src/sandbox/capability-probe';
import {
	_resetExecutorCache,
	getExecutor,
	setMacOSSandboxPolicy,
} from '../../../src/sandbox/executor';

type HostPlatform = 'linux' | 'darwin' | 'win32';
const HOST = process.platform as HostPlatform;

function hostCapability(disabled = false): SandboxCapability {
	if (disabled) {
		return {
			status: 'disabled',
			mechanism: 'unavailable',
			platform: HOST,
			error: 'binary stage reports the mechanism unavailable',
		};
	}
	if (HOST === 'linux') {
		return {
			status: 'enabled',
			strength: 'strong',
			mechanism: 'bubblewrap',
			platform: 'linux',
		};
	}
	if (HOST === 'darwin') {
		return {
			status: 'enabled',
			strength: 'strong',
			mechanism: 'sandbox-exec',
			platform: 'darwin',
		};
	}
	return {
		status: 'enabled',
		strength: 'strong',
		mechanism: 'native-appcontainer-runner',
		platform: 'win32',
	};
}

/** The sync availability accessor for the host platform. */
function hostAvailable(): boolean {
	if (HOST === 'linux') return isBubblewrapAvailable();
	if (HOST === 'darwin') return isSandboxExecAvailable();
	return isWindowsSandboxAvailable();
}

const SETUP_FAILURE_REASON = `${HOST === 'darwin' ? 'sandbox-exec' : HOST === 'linux' ? 'bubblewrap' : 'windows'} probe temp setup failed (EPERM)`;

describe('capability probe transient visibility — PR #3718 F-001', () => {
	test('an enabled capability with a transient setup-failure probe stays visible to the sync accessors while detect() re-probes', async () => {
		_resetCapabilityCache();
		const originalProbePlatform = _internals.probePlatform;
		const originalEvidence = _internals.detectBehavioralEvidence;
		let platformProbeCalls = 0;
		let transientMode = true;
		_internals.probePlatform = (async () => {
			platformProbeCalls += 1;
			return hostCapability();
		}) as typeof originalProbePlatform;
		_internals.detectBehavioralEvidence = (() => ({
			filesystem: 'none' as const,
			network: 'none' as const,
			process: 'none' as const,
			reasons: transientMode
				? [SETUP_FAILURE_REASON]
				: ['healthy probe ran to completion'],
		})) as typeof originalEvidence;
		try {
			const first = await new SandboxCapabilityProbe().detect();
			expect(first.status).toBe('enabled');
			expect(
				first.reasons.some((reason) =>
					reason.includes('probe temp setup failed'),
				),
			).toBe(true);
			// F-001 regression pin: RED at the intake head — the accessors
			// read only the never-memoized primary slot and reported the
			// enabled capability unavailable.
			expect(hostAvailable()).toBe(true);
			// Platform-tagged, not a blanket override: the two foreign
			// accessors must stay false.
			const all = [
				isBubblewrapAvailable(),
				isSandboxExecAvailable(),
				isWindowsSandboxAvailable(),
			];
			expect(all.filter((value) => value).length).toBe(1);

			// #3661 item 5 preserved: the transient result is NOT memoized —
			// the next detect() re-probes.
			await new SandboxCapabilityProbe().detect();
			expect(platformProbeCalls).toBe(2);

			// A healthy result memoizes, the cache short-circuits, and the
			// accessor stays true off the authoritative slot.
			transientMode = false;
			await new SandboxCapabilityProbe().detect();
			expect(platformProbeCalls).toBe(3);
			await new SandboxCapabilityProbe().detect();
			expect(platformProbeCalls).toBe(3);
			expect(hostAvailable()).toBe(true);
		} finally {
			_internals.probePlatform = originalProbePlatform;
			_internals.detectBehavioralEvidence = originalEvidence;
			_resetCapabilityCache();
		}
	}, 30_000);

	test('a memoized healthy result supersedes an earlier enabled transient observation', async () => {
		_resetCapabilityCache();
		const originalProbePlatform = _internals.probePlatform;
		const originalEvidence = _internals.detectBehavioralEvidence;
		let platformProbeCalls = 0;
		let disabledMode = false;
		_internals.probePlatform = (async () => {
			platformProbeCalls += 1;
			return hostCapability(disabledMode);
		}) as typeof originalProbePlatform;
		_internals.detectBehavioralEvidence = (() => ({
			filesystem: 'none' as const,
			network: 'none' as const,
			process: 'none' as const,
			reasons: disabledMode
				? ['healthy probe ran to completion']
				: [SETUP_FAILURE_REASON],
		})) as typeof originalEvidence;
		try {
			// Phase 1: enabled + transient — visible to the accessor.
			await new SandboxCapabilityProbe().detect();
			expect(hostAvailable()).toBe(true);
			// Phase 2: a healthy DISABLED result memoizes and must clear the
			// stale enabled transient — a real answer always outranks a
			// transient observation, so the accessor must not report the
			// long-gone availability.
			disabledMode = true;
			await new SandboxCapabilityProbe().detect();
			expect(hostAvailable()).toBe(false);
			// And the disabled answer IS memoized (no further re-probe).
			const callsAfterMemo = platformProbeCalls;
			await new SandboxCapabilityProbe().detect();
			expect(platformProbeCalls).toBe(callsAfterMemo);
		} finally {
			_internals.probePlatform = originalProbePlatform;
			_internals.detectBehavioralEvidence = originalEvidence;
			_resetCapabilityCache();
		}
	}, 30_000);

	test('getExecutor() resolves a NON-NULL executor from an enabled capability whose behavioral probe hit temp-setup failure', async () => {
		_resetCapabilityCache();
		_resetExecutorCache();
		const originalProbePlatform = _internals.probePlatform;
		const originalEvidence = _internals.detectBehavioralEvidence;
		_internals.probePlatform = (async () =>
			hostCapability()) as typeof originalProbePlatform;
		_internals.detectBehavioralEvidence = (() => ({
			filesystem: 'none' as const,
			network: 'none' as const,
			process: 'none' as const,
			reasons: [SETUP_FAILURE_REASON],
		})) as typeof originalEvidence;
		try {
			// The macOS creator is config-gated (F6a item 3); open the gate
			// for this leg only. Restored to the default false in finally.
			if (HOST === 'darwin') setMacOSSandboxPolicy(true);
			_resetExecutorCache();
			const executor = await getExecutor();
			// F-001 end-to-end pin: RED at the intake head — accessor
			// blindness made `_create*Executor` resolve null, and the null
			// was then memoized for the process lifetime (advisory-mode
			// commands ran unsandboxed). With the transient slot visible,
			// the executor is created sandboxed-with-weak-evidence — the
			// base behavior.
			expect(executor).not.toBeNull();
			expect(executor).toHaveProperty('mechanism');
		} finally {
			if (HOST === 'darwin') setMacOSSandboxPolicy(false);
			_internals.probePlatform = originalProbePlatform;
			_internals.detectBehavioralEvidence = originalEvidence;
			_resetCapabilityCache();
			_resetExecutorCache();
		}
	}, 60_000);

	// L4 (Stage-B reviewer counterexample, PR #3718 feedback round): a
	// healthy DISABLED memo recorded at a PREVIOUS probe-source identity
	// must NOT mask a fresh ENABLED transient re-probe after a binary change
	// (install/upgrade of the sandbox binary changes the probe source; the
	// first post-change probe can hit temp-setup failure). A plain
	// `_cached ?? _cachedTransient` preference without the identity gates
	// returns the stale disabled memo here — re-introducing the
	// null-executor class this battery exists to prevent — so this leg is
	// the kill mutant's witness.
	test('L4: a stale-identity disabled memo does not mask a fresh enabled transient re-probe', async () => {
		_resetCapabilityCache();
		const originalProbePlatform = _internals.probePlatform;
		const originalEvidence = _internals.detectBehavioralEvidence;
		const originalIdentity = _internals.currentProbeSourceIdentity;
		let platformProbeCalls = 0;
		let identity = 'probe-source-A';
		_internals.currentProbeSourceIdentity = (() =>
			identity) as typeof originalIdentity;
		_internals.probePlatform = (async () => {
			platformProbeCalls += 1;
			// First probe (identity A): binary missing — clean DISABLED.
			// Second probe (identity B): binary installed, temp setup fails.
			return hostCapability(platformProbeCalls === 1);
		}) as typeof originalProbePlatform;
		_internals.detectBehavioralEvidence = (() => ({
			filesystem: 'none' as const,
			network: 'none' as const,
			process: 'none' as const,
			reasons:
				platformProbeCalls === 1
					? ['healthy probe ran to completion']
					: [SETUP_FAILURE_REASON],
		})) as typeof originalEvidence;
		try {
			await new SandboxCapabilityProbe().detect();
			expect(platformProbeCalls).toBe(1);
			expect(hostAvailable()).toBe(false);
			// The sandbox binary changes underneath the memo.
			identity = 'probe-source-B';
			const second = await new SandboxCapabilityProbe().detect();
			// Stale-identity memo must not short-circuit detect().
			expect(platformProbeCalls).toBe(2);
			expect(second.status).toBe('enabled');
			// Security pin: the CURRENT probe's enabled transient outranks
			// the stale-identity disabled memo (kills the identity-less
			// `??` preference mutant).
			expect(hostAvailable()).toBe(true);
		} finally {
			_internals.currentProbeSourceIdentity = originalIdentity;
			_internals.probePlatform = originalProbePlatform;
			_internals.detectBehavioralEvidence = originalEvidence;
			_resetCapabilityCache();
		}
	}, 30_000);

	// L5: the transient slot carries its own identity gate. An accessor read
	// outside the documented post-detect() pattern — here, after the probe
	// source changed without a re-probe — is fail-closed for a sandbox
	// availability gate, and the next detect() re-tags visibility at the
	// fresh identity. This pins the transient-side identity check (an
	// untagged `_cachedTransient` fallback survives L4 but dies here).
	test('L5: an accessor read after an identity change without re-probe is fail-closed; the next detect() restores visibility', async () => {
		_resetCapabilityCache();
		const originalProbePlatform = _internals.probePlatform;
		const originalEvidence = _internals.detectBehavioralEvidence;
		const originalIdentity = _internals.currentProbeSourceIdentity;
		let platformProbeCalls = 0;
		let identity = 'probe-source-A';
		_internals.currentProbeSourceIdentity = (() =>
			identity) as typeof originalIdentity;
		_internals.probePlatform = (async () => {
			platformProbeCalls += 1;
			return hostCapability();
		}) as typeof originalProbePlatform;
		_internals.detectBehavioralEvidence = (() => ({
			filesystem: 'none' as const,
			network: 'none' as const,
			process: 'none' as const,
			reasons: [SETUP_FAILURE_REASON],
		})) as typeof originalEvidence;
		try {
			await new SandboxCapabilityProbe().detect();
			expect(hostAvailable()).toBe(true);
			// Binary swapped externally with NO detect() in between: the
			// transient belongs to a stale identity — fail closed.
			identity = 'probe-source-B';
			expect(hostAvailable()).toBe(false);
			// The documented pattern (accessor read after detect() resolves)
			// re-probes — _cached is absent so the memo guard never
			// short-circuits — and re-tags the transient at the fresh
			// identity.
			await new SandboxCapabilityProbe().detect();
			expect(platformProbeCalls).toBe(2);
			expect(hostAvailable()).toBe(true);
		} finally {
			_internals.currentProbeSourceIdentity = originalIdentity;
			_internals.probePlatform = originalProbePlatform;
			_internals.detectBehavioralEvidence = originalEvidence;
			_resetCapabilityCache();
		}
	}, 30_000);
});
