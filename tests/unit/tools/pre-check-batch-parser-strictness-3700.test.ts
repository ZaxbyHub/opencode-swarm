/**
 * #3700 — production-mode parser strictness legs the round-19 phantom guard
 * did not close, all pinned through `_internals.parseDiffLineRangesChecked`
 * with requireGitFileHeaders=true (the shape the committed-hop resolver
 * feeds it):
 *
 *  (a) a `diff --git` header naming two DIFFERENT unquoted paths cannot be
 *      split into an unambiguous pair, so the section's `+++ ` destination
 *      is unvalidated today — `+++ src/phantom.ts` still yields
 *      `{src/phantom.ts: [1]}`. A destination the header did not name must
 *      fail closed (null), same rule as the symmetric-header phantom.
 *  (b) junk (unrecognized non-empty content) BEFORE a valid git file section
 *      is silently skipped today; it must fail closed.
 *  (c) junk AFTER a valid section is silently skipped today; it must fail
 *      closed.
 *  (d) controls that already hold and must keep holding: the
 *      symmetric-header phantom returns null; empty input is the legitimate
 *      no-change shorthand (a map, not null); a clean valid section parses
 *      to its changed line.
 *
 * (a), (b), (c) are RED at the current code (each currently returns a
 * non-null authoritative map); every (d) leg is green at the current code.
 */

import { describe, expect, test } from 'bun:test';
import { _internals as preCheckBatchInternals } from '../../../src/tools/pre-check-batch.js';

const VALID_SECTION = [
	'diff --git a.ts a.ts',
	'--- a.ts',
	'+++ a.ts',
	'@@ -1,1 +1,1 @@',
	'-old',
	'+new',
].join('\n');

describe('parseDiffLineRangesChecked production-mode strictness (#3700)', () => {
	test('(a) a phantom +++ destination under a two-different-unquoted-paths header fails closed', () => {
		// The header `diff --git src/real.ts src/other.ts` cannot be split into
		// an unambiguous pair (two different unquoted paths), so the round-19
		// phantom-destination guard is skipped (it requires a parsed pair) and
		// `+++ src/phantom.ts` — a path the header did not name — is accepted.
		// Executed pre-fix expectation: `{src/phantom.ts: [1]}`.
		const checked = preCheckBatchInternals.parseDiffLineRangesChecked(
			[
				'diff --git src/real.ts src/other.ts',
				'--- src/real.ts',
				'+++ src/phantom.ts',
				'@@ -0,0 +1,1 @@',
				'+hello',
			].join('\n'),
			true,
		);
		expect(checked).toBeNull();
	}, 10_000);

	test('(b) junk before a valid git file section fails closed', () => {
		// Unrecognized non-empty content ahead of the first `diff --git` is
		// skipped today, so the junk rides through inert and the section's map
		// is authoritative. Executed pre-fix expectation: `{a.ts: [1]}`.
		const checked = preCheckBatchInternals.parseDiffLineRangesChecked(
			`this is not diff output\n${VALID_SECTION}`,
			true,
		);
		expect(checked).toBeNull();
	}, 10_000);

	test('(c) junk after a valid git file section fails closed', () => {
		// Same rule past the section: the hunk counters are spent and the junk
		// line matches no grammar production, yet it is ignored today.
		// Executed pre-fix expectation: `{a.ts: [1]}`.
		const checked = preCheckBatchInternals.parseDiffLineRangesChecked(
			`${VALID_SECTION}\nthis is not diff output`,
			true,
		);
		expect(checked).toBeNull();
	}, 10_000);

	test('(d1) control: the symmetric-header phantom already fails closed', () => {
		const checked = preCheckBatchInternals.parseDiffLineRangesChecked(
			[
				'diff --git src/real.ts src/real.ts',
				'--- src/real.ts',
				'+++ src/phantom.ts',
				'@@ -1,0 +1,1 @@',
				'+evil',
			].join('\n'),
			true,
		);
		expect(checked).toBeNull();
	}, 10_000);

	test('(d2) control: empty input stays the legitimate no-change shorthand', () => {
		const checked = preCheckBatchInternals.parseDiffLineRangesChecked('', true);
		expect(checked).not.toBeNull();
		expect(checked?.size).toBe(0);
	}, 10_000);

	test('(d3) control: a clean valid section parses to its changed line', () => {
		const checked = preCheckBatchInternals.parseDiffLineRangesChecked(
			VALID_SECTION,
			true,
		);
		expect(checked).not.toBeNull();
		expect([...(checked?.get('a.ts') ?? [])]).toEqual([1]);
	}, 10_000);
});

// C3/C5 (critic amendment): grammar legs around the strictness rule. Each
// control records the CURRENT behavior (executed at the trace base via the
// parser probe) so the junk-rejection fix cannot regress legitimate git
// grammar into null, and cannot let a binary phantom slip into a map key.
describe('parseDiffLineRangesChecked grammar controls (#3700 C3/C5)', () => {
	test('(e) binary phantom: a distinct-two-token header with a Binary-files phantom destination stays null', () => {
		// PRESERVING control — executed at the base: null. The Binary branch
		// splits its body with the same unambiguity rules as the text header,
		// and `src/real.ts and src/phantom.ts` is a distinct two-token body,
		// so no phantom map key can arise from the binary leg today. Pinned so
		// the strictness fix keeps this closed rather than only closing the
		// `+++ ` text path.
		const checked = preCheckBatchInternals.parseDiffLineRangesChecked(
			[
				'diff --git src/real.ts src/other.ts',
				'Binary files src/real.ts and src/phantom.ts differ',
			].join('\n'),
			true,
		);
		expect(checked).toBeNull();
	}, 10_000);

	test('(f) control: a legit deleted-binary section stays an empty map', () => {
		// Executed at the base: an EMPTY map (not null). The `deleted file
		// mode`/`index` header lines are legitimate git grammar and must stay
		// accepted; the `… and /dev/null differ` destination is consumed with
		// no key. Pin exactly this shape — the strictness fix must not turn
		// legitimate mode/index lines into junk.
		const checked = preCheckBatchInternals.parseDiffLineRangesChecked(
			[
				'diff --git a/deleted.bin b/deleted.bin',
				'deleted file mode 100644',
				'index abc..def',
				'Binary files a/deleted.bin and /dev/null differ',
			].join('\n'),
			true,
		);
		expect(checked).not.toBeNull();
		expect(checked?.size).toBe(0);
	}, 10_000);

	test('(g) control: a legit new-file section keeps its map (with the literal b/ prefix key)', () => {
		// Executed at the base: {b/new.ts: [1]}. normalizeDiffPath never
		// strips a leading a/ or b/ — the parser's producers pin --no-prefix,
		// so a prefixed path IS the repository path (policy pinned by the
		// 3681b suite). The `new file mode`/`index` lines are legitimate
		// grammar and must stay accepted.
		const checked = preCheckBatchInternals.parseDiffLineRangesChecked(
			[
				'diff --git a/new.ts b/new.ts',
				'new file mode 100644',
				'index 0000000..abc',
				'--- /dev/null',
				'+++ b/new.ts',
				'@@ -0,0 +1,1 @@',
				'+x',
			].join('\n'),
			true,
		);
		expect(checked).not.toBeNull();
		expect([...(checked?.get('b/new.ts') ?? [])]).toEqual([1]);
	}, 10_000);

	// Round-2 amendment: the former single (h) null-control was internally
	// inconsistent with the planned fix — once the two-token header fallback
	// lands, `diff --git a/blob.bin b/blob.bin` parses as a pair and the
	// GIT-binary branch maps the destination. Replaced by (h1)/(h2) below.
	//
	// Round-3 amendment: the payload below is REAL captured `git diff --binary`
	// output (verbatim, git 2.54.0, throwaway repo: 16 non-text bytes committed
	// as blob.bin at base, then replaced with 19 different bytes). git emitted
	// TWO `literal` fragments for this edit — the postimage (literal 19) and
	// the reverse preimage (literal 17); no `delta` fragment for this change,
	// so the full real shape here is both literal blocks. The payload lines are
	// git's base85 framing (length letter + groups; note the backticks are part
	// of the alphabet), each fragment terminated by a blank line; the final ''
	// entries reproduce the byte-for-byte trailing newlines of the capture.
	const GIT_BINARY_PATCH_SECTION = [
		'diff --git a/blob.bin b/blob.bin',
		'index 6de7f010d7324b53c3d28b46a86ba38b609436c3..828c338acb5de0cc677807c81e750525b758fd4c 100644',
		'GIT binary patch',
		'literal 19',
		'bcmZQzWMURjFmMb^ENq;(aO1&?4?h9`D@6yB',
		'',
		'literal 17',
		'YcmZQzWMURjFmMP+C}^0lV8ek6036u`w*UYD',
		'',
		'',
	];

	test('(h1) a legitimate GIT binary patch section maps its destination ALL_LINES_CHANGED', () => {
		// Executed at the BASE: null (the prefixed two-token header yields no
		// usable pair, so the GIT-binary destination fails closed). This is the
		// correct RED direction: base null vs post-fix map. After the header
		// fallback lands, the destination is `b/blob.bin` (the literal a//b
		// prefix convention leg (g) documents) marked with the
		// ALL_LINES_CHANGED sentinel, and the real `index`/`literal`/base85
		// payload/blank-terminator lines (both fragments) must not be treated
		// as junk.
		const checked = preCheckBatchInternals.parseDiffLineRangesChecked(
			GIT_BINARY_PATCH_SECTION.join('\n'),
			true,
		);
		expect(checked).not.toBeNull();
		expect([...(checked?.get('b/blob.bin') ?? [])]).toEqual([-1]);
	}, 10_000);

	test('(h2) junk inside a binary patch section fails closed', () => {
		// Same REAL envelope as (h1) with one junk line inserted INSIDE the
		// payload region — between the first `literal` payload line and its
		// blank terminator. Null at the base (the header pair is unparseable
		// there) AND null post-fix: a real base85 payload line never contains
		// spaces, so a space-bearing sentence inside the payload region is
		// non-payload junk the stateful binary grammar must fail closed on — an
		// implementation that blanket-accepts binary-section content as payload
		// returns a map here and fails this leg.
		const checked = preCheckBatchInternals.parseDiffLineRangesChecked(
			[
				...GIT_BINARY_PATCH_SECTION.slice(0, 5),
				'this is not diff output',
				...GIT_BINARY_PATCH_SECTION.slice(5),
			].join('\n'),
			true,
		);
		expect(checked).toBeNull();
	}, 10_000);

	test('(i) control: a trailing no-newline marker after the hunk body leaves the map unchanged', () => {
		// Executed at the base: identical map to the clean section. The
		// marker is the one legitimate backslash line outside a hunk body and
		// must not be junked by the strictness fix.
		const checked = preCheckBatchInternals.parseDiffLineRangesChecked(
			`${VALID_SECTION}\n\\ No newline at end of file`,
			true,
		);
		expect(checked).not.toBeNull();
		expect([...(checked?.get('a.ts') ?? [])]).toEqual([1]);
	}, 10_000);

	// F-008 (PR #3718 review test-quality cluster): rename-with-edit control.
	// A rename section that ALSO carries a `--- `/`+++ ` pair and a hunk
	// exercises the most stateful composition in the grammar — the eager
	// `rename to` commit (ALL_LINES_CHANGED, sentinel -1 at pre-check-batch
	// .ts:58) interacting with hunk accumulation under the phantom guards —
	// previously unpinned. Written in the PRODUCER form (--no-prefix: every
	// diff this parser consumes is generated without a//b/ prefixes, and a
	// literal a//b/ is deliberately treated as part of the repo path — a
	// prefixed section here is a malformed diff and fails closed; that arm
	// is pinned by this leg's twin at the copyRenameDestination guard).
	// Executed green at the head: the destination keys ALL_LINES_CHANGED
	// (the eager `rename to` commit dominates — consumers short-circuit on
	// the sentinel, so the hunk's line numbers are immaterial and the set
	// holds exactly [-1]; over-gating, never fail-open), both correlation
	// guards pass for the consistent section, and the rename source is
	// never keyed.
	test('(j) control: rename-with-edit keys the destination ALL_LINES_CHANGED and never the source', () => {
		const checked = preCheckBatchInternals.parseDiffLineRangesChecked(
			[
				'diff --git old.ts new.ts',
				'index 1234567..89abcde 92%',
				'rename from old.ts',
				'rename to new.ts',
				'--- old.ts',
				'+++ new.ts',
				'@@ -1,2 +1,3 @@',
				' context one',
				'+inserted line',
				' context two',
			].join('\n'),
			true,
		);
		expect(checked).not.toBeNull();
		const destination = checked?.get('new.ts');
		expect(destination).toBeDefined();
		expect([...(destination ?? [])]).toEqual([-1]);
		// The rename source is never keyed — a finding attributed to old.ts
		// takes the missing-key arm like any untouched file.
		expect(checked?.has('old.ts')).toBe(false);
	}, 10_000);
});
