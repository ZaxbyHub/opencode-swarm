/**
 * DELIBERATELY-LEAKING fixture for the #3260-D restorer-guard subprocess probe
 * (tests/unit/helpers/safe-test-dir-guard-subprocess-3260.test.ts).
 *
 * NOT part of any CI test glob: it lives under tests/fixtures/ (unit discovery
 * globs tests/unit, tests/adversarial, tests/architect, tests/cli, tests/tools,
 * tests/helpers, and top-level tests/*.test.ts — never tests/fixtures). It is
 * executed ONLY when explicitly spawned by the probe:
 *
 *   bun test tests/fixtures/preload/internals-leak-fixture.test.ts
 *
 * The test below swaps `_internals.wait` and never restores it. The aggregated
 * preload afterAll (tests/preload/prod-store-tripwire.ts) must catch the leak
 * via assertInternalsRestored and fail the run (nonzero exit naming `wait`).
 */
import { describe, expect, test } from 'bun:test';
import { _internals } from '../../helpers/safe-test-dir.js';

describe('deliberate internals leak fixture (3260-D probe)', () => {
	test('passes while leaking the wait member (the guard must fail the run)', () => {
		// Deliberate leak: NO try/finally restore. The preload guard is the
		// thing under test in the spawning process.
		_internals.wait = () => {};
		expect(true).toBe(true);
	});
});
