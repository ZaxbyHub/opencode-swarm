/**
 * Acceptance check C5 (issue #3260 section D / trace 3260-3252-teardown-hardening).
 *
 * A restorer guard must exist on the widened _internals seam: a check that
 * fails when any _internals member differs from its import-time value
 * (RC-D: restoration is convention-only; a leaked `wait` swap silently
 * converts every consumer's budget to ~0 s). NEW-SURFACE: the guard export
 * does not exist at the base tree, so this file fails at module resolution
 * (ERROR at base); it turns GREEN when the fix adds the guard.
 *
 * Frozen contract for the fix: `assertInternalsRestored(): void` exported
 * from tests/helpers/safe-test-dir.ts; it throws when any _internals member
 * differs from its import-time snapshot and returns normally when all
 * members are restored (the fix wires it into an afterAll/preload guard).
 */
import { describe, expect, it } from 'bun:test';
import {
	_internals,
	assertInternalsRestored,
} from '../../helpers/safe-test-dir.js';

describe('_internals restorer guard (3260-D)', () => {
	it('fails when a member was swapped and not restored (ERROR at base, GREEN after the fix)', () => {
		const realWait = _internals.wait;
		try {
			// A deliberately-leaking probe: swap one member (the exact class
			// PRR-015/016 named — a leaked wait collapse).
			_internals.wait = () => {};
			let guardError: unknown = null;
			try {
				assertInternalsRestored();
			} catch (error) {
				guardError = error;
			}
			expect(guardError).toBeInstanceOf(Error);
		} finally {
			_internals.wait = realWait;
		}
	});

	it('passes when every member is restored (ERROR at base, GREEN after the fix)', () => {
		expect(() => assertInternalsRestored()).not.toThrow();
	});
});
