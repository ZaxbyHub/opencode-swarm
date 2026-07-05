/**
 * G1 (#1715) regression guard: phase-complete must call updateRetrievalOutcome
 * with the REAL phase outcome (the `success` variable), not a hardcoded `true`.
 *
 * The original bug was `updateRetrievalOutcome(dir, name, true)` at the old
 * call site, which asserted success before the outcome was known. This test
 * reads phase-complete.ts as source and asserts:
 *   1. no call site passes a literal `true` as the third argument
 *   2. the call passes the `success` variable
 *
 * This is a source-level guard rather than a behavioral integration test
 * because phase-complete has a very heavy mock surface (see the locking /
 * curator / evidence mocks in other phase-complete test files), and the bug
 * is specifically about which argument value is wired through — a concern the
 * type system alone cannot enforce (the signature is `boolean` either way).
 * The companion behavioral test for `false` → 'failure' event lives in
 * tests/unit/hooks/knowledge-reader.test.ts (Test 12).
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = readFileSync(
	join(import.meta.dir, '..', '..', '..', 'src', 'tools', 'phase-complete.ts'),
	'utf-8',
);

describe('G1 phase-complete outcome wiring regression (#1715)', () => {
	test('no call site passes a literal `true` to updateRetrievalOutcome', () => {
		// The bug: `updateRetrievalOutcome(dir, name, true)`. Match any call
		// whose third arg is the literal `true` (with optional whitespace).
		const literalTrueCall = /updateRetrievalOutcome\s*\([^)]*,\s*true\s*\)/;
		expect(literalTrueCall.test(SRC)).toBe(false);
	});

	test('the call site passes the `success` variable (the real outcome)', () => {
		// The fix passes `success` — the variable finalized from agentsMissing +
		// policy. Match any call whose third arg is the identifier `success`.
		const successVarCall =
			/updateRetrievalOutcome\s*\([^)]*,\s*success\b[^)]*\)/;
		expect(successVarCall.test(SRC)).toBe(true);
	});

	test('the old comment about "Phase completed successfully at this point" is gone', () => {
		// The old code carried a false-premise comment justifying the hardcoded
		// true. Its presence would indicate a partial revert. The new code has
		// a different explanatory comment instead.
		expect(SRC).not.toContain(
			'Phase completed successfully at this point — lessons applied = positive signal',
		);
	});
});
