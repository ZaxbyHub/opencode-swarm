/**
 * #3743 item 2 (J2/AC2): a transiently-degraded win32 capability probe result
 * (the advisory 'PowerShell wrapper' fallback produced while the native runner
 * binary was transiently unreadable, e.g. EBUSY) must not be memoized forever.
 * After the environment recovers, the capability layer SHALL re-derive or
 * invalidate the memoized weak capability within a bounded interval, and the
 * executor assessment layer SHALL serve the recovered capability without a
 * manual cache reset.
 *
 * Seams (established by the #3736/#3716 suites — no mock.module):
 * - capability-probe `_internals.probePlatform` (sequence of synthetic
 *   platform capabilities; win32 shapes are pure data on every host —
 *   detectBehavioralEvidence/upgradeCapability key off the capability's own
 *   platform, never process.platform)
 * - capability-probe `_resetCapabilityCache`
 * - executor `_resetSandboxAssessmentCache` (hygiene only — the recovery legs
 *   below perform NO manual reset between the degraded and recovered phases)
 *
 * Clock: the bounded interval is crossed deterministically by freezing
 * Date.now far in the future (tests/helpers/test-clock.ts freezeClock), which
 * expires any finite TTL recorded under the real clock. No raw Date.now() /
 * new Date() calls in this file (check:test-clock gate).
 *
 * RED at base 6864cd83b (the memo is keyed on probe-source file identity only
 * — no time axis, so the stale weak capability is served forever; this file
 * does not exist there), GREEN after the fix.
 *
 * Round-2 amendments (plan v3 R14, critic-round-2.md "Unwired Functionality"
 * item 1 — the tests R3 promised now exist):
 * - (a) unchanged-degraded-across-TTL: after expiry with an UNCHANGED
 *   degraded environment, the re-probe returns the same capability — the
 *   identity string and the assessment cache key stay STABLE (no epoch in
 *   the identity; no Full-Auto sandbox_unverified churn). RED at base for a
 *   REACHABLE reason: the base memo never expires, so the second detect()
 *   returns the memo WITHOUT consulting the probePlatform seam — the row
 *   asserts the seam WAS consulted again after the TTL advance.
 * - (b) recovered-strong diagnose: /swarm diagnose reports the recovered
 *   mechanism after TTL. Driven through the diagnose-service _internals seam
 *   (the C6 probe's leg-2 technique): getSandboxExecutor is stubbed so no
 *   real executor is built, while detectSandboxCapability stays the REAL
 *   memoized detect — the row discriminates the stale-weak-memo class.
 * - (c)+(d) post-recovery permanent memoization + expiry-slot clearing: the
 *   full sequence (degraded, advance, recovered-strong, advance-again,
 *   third detect) asserts (i) recovery happened — RED at base right there —
 *   and (ii) the third detect serves the SAME memoized object without
 *   consulting the seam again, even after a large later clock advance (a
 *   non-expiring memo write must have cleared the expiry slot, else the
 *   strong result would inherit the expired timestamp and re-probe forever).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import {
	_resetCapabilityCache,
	_internals as probeInternals,
	type SandboxCapability,
	SandboxCapabilityProbe,
	type SandboxCapabilityV1,
} from '../../../src/sandbox/capability-probe';
import {
	_resetSandboxAssessmentCache,
	assessSandboxEnforcement,
} from '../../../src/sandbox/executor';
import {
	_internals as diagnoseInternals,
	getDiagnoseData,
} from '../../../src/services/diagnose-service';
import { freezeClock } from '../../helpers/test-clock';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

/** Any finite bounded interval has expired when the clock reads this. */
const FAR_FUTURE_MS = 4_102_444_800_000; // 2100-01-01T00:00:00Z

/** The degraded win32 fallback: advisory PowerShell wrapper, not kernel. */
const degradedWin32: SandboxCapability = {
	status: 'enabled',
	strength: 'advisory',
	platform: 'win32',
	mechanism: 'PowerShell wrapper',
	error: 'synthetic transient: native runner probe failed (EBUSY)',
};

/** The recovered win32 native runner capability. */
const recoveredWin32: SandboxCapability = {
	status: 'enabled',
	strength: 'strong',
	platform: 'win32',
	mechanism: 'native-runner/app-container',
};

const originalProbePlatform = probeInternals.probePlatform;
let probeCalls = 0;
let nextCapability: SandboxCapability = recoveredWin32;

beforeEach(() => {
	_resetCapabilityCache();
	_resetSandboxAssessmentCache();
	probeCalls = 0;
	nextCapability = recoveredWin32;
	probeInternals.probePlatform = async () => {
		probeCalls += 1;
		return nextCapability;
	};
});

afterEach(() => {
	probeInternals.probePlatform = originalProbePlatform;
	_resetCapabilityCache();
	_resetSandboxAssessmentCache();
});

describe('capability memo recovery after a transient win32 probe failure (#3743 AC2)', () => {
	test('a memoized degraded capability is re-derived once the environment recovers', async () => {
		nextCapability = degradedWin32;
		const probe = new SandboxCapabilityProbe();
		const degraded = await probe.detect();
		expect(degraded.mechanism).toBe('PowerShell wrapper');

		// The environment recovers: the next platform probe answers strong.
		nextCapability = recoveredWin32;
		// Cross any bounded interval deterministically (far-future clock).
		const restore = freezeClock({ fixedNow: FAR_FUTURE_MS });
		try {
			const recovered = await probe.detect();
			expect(recovered.mechanism).toBe('native-runner/app-container');
			expect(recovered.strength).not.toBe('advisory');
		} finally {
			restore();
		}
	}, 30_000);

	test('assessment serves the recovered capability with no manual cache reset', async () => {
		nextCapability = degradedWin32;
		const degradedAssessment = await assessSandboxEnforcement(undefined);
		expect(degradedAssessment.capability.mechanism).toBe('PowerShell wrapper');

		nextCapability = recoveredWin32;
		const restore = freezeClock({ fixedNow: FAR_FUTURE_MS });
		try {
			const recoveredAssessment = await assessSandboxEnforcement(undefined);
			expect(recoveredAssessment.capability.mechanism).toBe(
				'native-runner/app-container',
			);
			expect(recoveredAssessment.capability).not.toBe(
				degradedAssessment.capability,
			);
		} finally {
			restore();
		}
	}, 30_000);

	test('control: a healthy strong capability is still memoized (no re-probe storm)', async () => {
		nextCapability = recoveredWin32;
		const probe = new SandboxCapabilityProbe();
		const first = await probe.detect();
		const second = await probe.detect();
		expect(probeCalls).toBe(1);
		expect(second).toBe(first);
	}, 30_000);

	// [R14a] Unchanged degraded environment, only the clock crosses the
	// bounded interval: the re-probe must consult the seam again (RED at base
	// for exactly this reason — the base memo has no time axis, so the second
	// detect() serves the memo and the seam is NOT consulted) and must
	// reconstruct an EQUIVALENT capability: the identity string is unchanged
	// (R3: no expiry epoch in the identity) and the assessment cache key —
	// derived from capability.identity (buildSandboxAssessmentCacheKey) —
	// stays the same value, so strict Full-Auto sandbox_unverified comparisons
	// see no churn across TTL boundaries.
	test('unchanged degraded capability: TTL expiry re-probes yet keeps identity and assessment cache key stable', async () => {
		nextCapability = degradedWin32;
		const probe = new SandboxCapabilityProbe();
		const before = await probe.detect();
		expect(before.mechanism).toBe('PowerShell wrapper');
		const beforeKey = (await assessSandboxEnforcement(undefined)).cacheKey;
		const callsBeforeExpiry = probeCalls;

		// Environment UNCHANGED (still degraded) — only the clock advances.
		const restore = freezeClock({ fixedNow: FAR_FUTURE_MS });
		try {
			const after = await probe.detect();
			expect(probeCalls).toBe(callsBeforeExpiry + 1);
			expect(after.identity).toBe(before.identity);
			const afterKey = (await assessSandboxEnforcement(undefined)).cacheKey;
			expect(afterKey).toBe(beforeKey);
		} finally {
			restore();
		}
	}, 30_000);

	// [R14b] Recovered-strong diagnose: the /swarm diagnose Sandbox check must
	// report the RECOVERED mechanism once the TTL has crossed. The
	// diagnose-service _internals seam mirrors the C6 probe's leg-2 technique:
	// getSandboxExecutor is stubbed (no real executor is constructed) while
	// detectSandboxCapability stays the REAL memoized detect, so the row
	// exercises exactly the stale-weak-memo class. RED at base: the stale
	// weak memo is served and the detail names the degraded PowerShell
	// mechanism instead of the recovered native runner.
	test('recovered-strong capability: /swarm diagnose reports the recovered mechanism after TTL', async () => {
		nextCapability = degradedWin32;
		const probe = new SandboxCapabilityProbe();
		const degraded = await probe.detect();
		expect(degraded.mechanism).toBe('PowerShell wrapper');

		const realGetSandboxExecutor = diagnoseInternals.getSandboxExecutor;
		diagnoseInternals.getSandboxExecutor = async () =>
			({
				strength: 'strong',
				isAvailable: () => true,
				wrapCommand: (command: string) => command,
			}) as never;
		const dir = canonicalMkdtemp('c2-diagnose-');
		const restore = freezeClock({ fixedNow: FAR_FUTURE_MS });
		try {
			nextCapability = recoveredWin32;
			const data = await getDiagnoseData(dir);
			const sandbox = data.checks.find((check) => check.name === 'Sandbox');
			expect(sandbox).toBeDefined();
			expect(sandbox?.detail).toContain('native-runner/app-container');
			expect(sandbox?.detail).not.toContain('powershell wrapper');
		} finally {
			restore();
			diagnoseInternals.getSandboxExecutor = realGetSandboxExecutor;
			rmSync(dir, { recursive: true, force: true });
		}
	}, 30_000);

	// [R14c+R14d] Post-recovery permanent memoization + expiry-slot clearing.
	// The row runs the full sequence — degraded, advance, recovered-strong,
	// advance-again, third detect — and asserts (i) recovery happened (RED at
	// base right there: the base memo never expires, so the second detect()
	// still answers degraded) and (ii) the third detect returns the SAME
	// memoized object WITHOUT consulting the seam again, even under a large
	// LATER clock advance. (ii) pins R14d: a non-expiring memo write must
	// clear the expiry slot — a strong result inheriting the expired
	// timestamp would be evicted by the frozen clock and re-probe forever
	// (probeCalls would grow past the post-recovery count).
	test('post-recovery permanent memoization: the strong memo never re-probes and survives any later window', async () => {
		nextCapability = degradedWin32;
		const probe = new SandboxCapabilityProbe();
		const degraded = await probe.detect();
		expect(degraded.mechanism).toBe('PowerShell wrapper');

		nextCapability = recoveredWin32;
		const restoreRecovery = freezeClock({ fixedNow: FAR_FUTURE_MS });
		let recovered: SandboxCapabilityV1 | undefined;
		try {
			recovered = await probe.detect();
			expect(recovered.mechanism).toBe('native-runner/app-container');
			expect(recovered.strength).toBe('strong');
		} finally {
			restoreRecovery();
		}
		const callsAfterRecovery = probeCalls;

		// A large LATER advance (one year past the first far-future freeze):
		// the strong memo must still be served with NO seam consult.
		const restoreLater = freezeClock({
			fixedNow: FAR_FUTURE_MS + 315_576_000_000,
		});
		try {
			const third = await probe.detect();
			expect(third).toBe(recovered);
			expect(probeCalls).toBe(callsAfterRecovery);
		} finally {
			restoreLater();
		}
	}, 30_000);
});
