/**
 * #3661 AC2 — a setup-failure probe result must NOT be memoized.
 *
 * The capability cache exists so repeated detect() calls never re-probe
 * (pinned by the existing 'second detect() call returns the cached result'
 * test). A behavioral probe that failed during TEMP SETUP (its reasons carry
 * the `probe temp setup failed` marker) is not a trustworthy capability
 * answer — it describes a transient environment failure, not the host — so
 * caching it pins the failure for the whole session. The next detect() must
 * re-probe.
 *
 * RED at the current code: the cache stores the setup-failure result
 * unchanged (the stub is called once; the second detect() returns the cached
 * weak result).
 *
 * NOTE on the import shape: capability-probe exports the probe through the
 * `SandboxCapabilityProbe` class (its detect() backs the shared session
 * cache); there is no module-level `detect` function export.
 */

import { describe, expect, test } from 'bun:test';
import {
	_resetCapabilityCache,
	_internals as probeInternals,
	SandboxCapabilityProbe,
} from '../../../src/sandbox/capability-probe';

describe('capability probe setup-failure cache — issue #3661 AC2', () => {
	test('a setup-failure behavioral probe is not memoized; the next detect re-probes', async () => {
		_resetCapabilityCache();
		const originalDetectBehavioralEvidence =
			probeInternals.detectBehavioralEvidence;
		let calls = 0;
		probeInternals.detectBehavioralEvidence = (() => {
			calls += 1;
			if (calls === 1) {
				return {
					filesystem: 'none',
					network: 'none',
					process: 'none',
					reasons: ['probe temp setup failed (EPERM)'],
				};
			}
			return {
				filesystem: 'real',
				network: 'none',
				process: 'none',
				reasons: ['healthy probe ran to completion'],
			};
		}) as typeof originalDetectBehavioralEvidence;
		try {
			const first = await new SandboxCapabilityProbe().detect();
			// Sanity: the first result really is the setup-failure shape.
			expect(
				first.reasons.some((reason) =>
					reason.includes('probe temp setup failed'),
				),
			).toBe(true);

			// NO cache reset between the calls: the second detect() must
			// re-probe on its own because the cached result was a setup failure.
			const second = await new SandboxCapabilityProbe().detect();
			expect(calls).toBe(2);
			// And the second result reflects the healthy probe, not the cached
			// weak one (evidence reasons survive the V1 upgrade in every
			// status/platform branch, so the marker is observable on all hosts).
			expect(
				second.reasons.some((reason) =>
					reason.includes('healthy probe ran to completion'),
				),
			).toBe(true);
			expect(second).not.toBe(first);
		} finally {
			probeInternals.detectBehavioralEvidence =
				originalDetectBehavioralEvidence;
			_resetCapabilityCache();
		}
	}, 30_000);
});
