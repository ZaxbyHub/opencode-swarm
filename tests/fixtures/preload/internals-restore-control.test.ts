/**
 * RESTORING control fixture for the #3260-D restorer-guard subprocess probe.
 * Identical to internals-leak-fixture.test.ts EXCEPT the swapped member is
 * restored — the probe asserts this run exits ZERO, so a fixture-load or
 * module-resolution failure can never masquerade as a guard kill.
 *
 * Not in any CI test glob (tests/fixtures/); spawned only by
 * tests/unit/helpers/safe-test-dir-guard-subprocess-3260.test.ts.
 */
import { describe, expect, test } from 'bun:test';
import { _internals } from '../../helpers/safe-test-dir.js';

describe('internals restoration control fixture (3260-D probe)', () => {
	test('passes and restores the swapped member (the run must stay green)', () => {
		const realWait = _internals.wait;
		try {
			_internals.wait = () => {};
			expect(true).toBe(true);
		} finally {
			_internals.wait = realWait;
		}
	});
});
