/**
 * #3700 (C4 critic amendment) — quoted two-path rename-header parity.
 *
 * A `diff --git "src/real one.ts" "src/other two.ts"` header IS unambiguously
 * splittable (two quoted tokens), unlike its unquoted distinct-two-token
 * sibling pinned in pre-check-batch-parser-strictness-3700.test.ts leg (a).
 * The strictness fix that rejects phantom `+++ ` destinations under
 * unparseable headers must therefore keep ACCEPTING the quoted rename shape:
 * a `+++ ` destination that names the header's own quoted destination parses
 * to that destination, while a `+++ ` naming a DIFFERENT quoted path fails
 * closed (the round-19 phantom guard, which already covers quoted pairs
 * because the quoted split yields a usable pair).
 *
 * Both legs are PRESERVING controls, executed at the trace base via the
 * parser probe:
 *   - matching quoted destination  => Map { 'src/other two.ts': [1] }
 *   - differing quoted destination => null
 */

import { describe, expect, test } from 'bun:test';
import { _internals as preCheckBatchInternals } from '../../../src/tools/pre-check-batch.js';

const QUOTED_RENAME_WITH_HUNK = [
	'diff --git "src/real one.ts" "src/other two.ts"',
	'--- "src/real one.ts"',
	'+++ "src/other two.ts"',
	'@@ -1,1 +1,1 @@',
	'-old',
	'+new',
].join('\n');

// Executed note for the implementer: adding literal `rename from`/`rename to`
// lines to this shape changes the executed verdict to the ALL_LINES_CHANGED
// sentinel only ({'src/other two.ts': [-1]} — the eager rename-to commit plus
// its EOF safety net); that is a different (over-gating) grammar path, not
// the parity this file pins. The legs below pin the minimal quoted rename
// header the C4 amendment specifies.

describe('quoted two-path rename header parity (#3700 C4)', () => {
	test('a quoted rename header with its own quoted +++ destination parses to that destination (control)', () => {
		// PRESERVING control — executed at the base: the map keys the
		// destination the header named ('src/other two.ts', C-quote decoded),
		// with the hunk's changed line. The strictness fix must keep this
		// acceptance: the quoted split is unambiguous, so this is NOT the
		// phantom shape.
		const checked = preCheckBatchInternals.parseDiffLineRangesChecked(
			QUOTED_RENAME_WITH_HUNK,
			true,
		);
		expect(checked).not.toBeNull();
		expect([...(checked?.get('src/other two.ts') ?? [])]).toEqual([1]);
		expect([...(checked?.keys() ?? [])]).toEqual(['src/other two.ts']);
	}, 10_000);

	test('a quoted rename header with a DIFFERENT quoted +++ destination fails closed (control)', () => {
		// PRESERVING control — executed at the base: null. The quoted pair is
		// parseable, so the round-19 phantom-destination guard compares the
		// decoded `+++ ` path against the header's destination and rejects the
		// mismatch. Pinned so the strictness fix neither weakens this nor
		// starts treating the quoted header itself as unparseable.
		const checked = preCheckBatchInternals.parseDiffLineRangesChecked(
			QUOTED_RENAME_WITH_HUNK.replace(
				'+++ "src/other two.ts"',
				'+++ "src/somewhere else.ts"',
			),
			true,
		);
		expect(checked).toBeNull();
	}, 10_000);
});
