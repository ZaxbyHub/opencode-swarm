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
import { describe, test } from 'bun:test';
import { _internals } from '../../helpers/safe-test-dir.js';

describe('deliberate internals leak fixture (3260-D probe)', () => {
	test('swaps the wait member and never restores it (the guard must fail the run)', () => {
		// Deliberate leak: NO try/finally restore, and deliberately NO
		// assertion — the fixture's pass is not the point; the aggregated
		// preload afterAll failing THIS RUN is (probed by the spawning test).
		// (Also keeps the vacuous-assertion ratchet clean: expect(true) here
		// would be a textbook vacuous assertion.)
		_internals.wait = () => {};
	});
});
