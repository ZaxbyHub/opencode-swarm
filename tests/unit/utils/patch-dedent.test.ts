/**
 * Issue #2206: normalizePatchIndentation — strips the minimum common leading
 * whitespace across non-empty lines so uniformly indented diff payloads
 * (fenced markdown / YAML / JSON blocks) regain column-0 anchors, while
 * column-0 payloads are returned unchanged (after \r\n normalization).
 */

import { describe, expect, it } from 'bun:test';
import { normalizePatchIndentation } from '../../../src/utils/patch-dedent';

describe('normalizePatchIndentation (#2206)', () => {
	it('is a byte-identical no-op (post newline normalization) for column-0 patches', () => {
		const patch = '--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n';
		expect(normalizePatchIndentation(patch)).toBe(patch);
	});

	it('strips a uniform 2-space wrapper indent', () => {
		const indented = '  --- a/x\n  +++ b/x\n  @@ -1 +1 @@\n  -old\n  +new\n';
		expect(normalizePatchIndentation(indented)).toBe(
			'--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n',
		);
	});

	it('strips a uniform 4-space wrapper indent, keeping the context-line marker space', () => {
		// context line = 4 wrapper spaces + 1 marker space + content
		const indented =
			'    --- a/x\n    +++ b/x\n    @@ -1,2 +1,2 @@\n     keep\n    -old\n    +new\n';
		expect(normalizePatchIndentation(indented)).toBe(
			'--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n keep\n-old\n+new\n',
		);
	});

	it('normalizes CRLF to LF before computing the indent', () => {
		const indented = '  --- a/x\r\n  +++ b/x\r\n';
		expect(normalizePatchIndentation(indented)).toBe('--- a/x\n+++ b/x\n');
	});

	it('is a no-op when indentation is not uniform (min indent is 0)', () => {
		const mixed = '  --- a/x\n+++ b/x\n';
		// The +++ line is at column 0 → minIndent 0 → unchanged.
		expect(normalizePatchIndentation(mixed)).toBe('  --- a/x\n+++ b/x\n');
	});

	it('skips empty lines when computing the minimum and never slices them', () => {
		const indented = '  --- a/x\n\n  +++ b/x\n';
		expect(normalizePatchIndentation(indented)).toBe('--- a/x\n\n+++ b/x\n');
	});

	it('returns the normalized text unchanged for whitespace-only input', () => {
		expect(normalizePatchIndentation('')).toBe('');
		expect(normalizePatchIndentation('\n\n')).toBe('\n\n');
	});

	it('a column-0 diff whose context line content starts with --- is NOT transformed', () => {
		// Guardrail against the false-positive class the plan critic flagged:
		// a markdown-file hunk whose context line is ` --- rule` (space marker +
		// literal hr content). Column-0 diff → no slicing → the context line
		// keeps its leading space and stays non-header-shaped.
		const patch =
			'--- a/README.md\n+++ b/README.md\n@@ -1,3 +1,3 @@\n # Title\n --- rule\n+body\n';
		expect(normalizePatchIndentation(patch)).toBe(patch);
	});
});

describe('normalizePatchIndentation — 1-space wrapper preserves the context marker (#2206 review)', () => {
	it('a 1-space-indented diff keeps the context line marker space after slicing (no header phantom)', () => {
		// Headers carry exactly 1 wrapper space, so minIndent = 1 — driven by
		// the headers, NOT the context line. The context line is wrapper(1) +
		// marker(1) + '--- rule' content; slicing 1 leaves ' --- rule' with the
		// structural marker space intact, which no column-0 '^---' regex can
		// match. (Pins the review question about marker/wrapper collapse.)
		const indented = [
			' --- a/x',
			' +++ b/x',
			' @@ -1,2 +1,2 @@',
			'  --- rule',
			' +body',
		].join('\n');
		expect(normalizePatchIndentation(indented)).toBe(
			'--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n --- rule\n+body',
		);
	});
});
