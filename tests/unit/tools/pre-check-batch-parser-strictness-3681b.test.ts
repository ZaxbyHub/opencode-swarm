/**
 * Issue #3681 item 1 (round 2) — parser strictness gaps found by the
 * plan critic's shipped-scope review, both in the fail-open direction the
 * original phantom-key defect travelled.
 *
 * Legs (all fail closed at head; each is mutation-killed):
 *  - Over-delivery AFTER both counters reached zero: the pre-fix parser
 *    returned to header mode and silently IGNORED the extra body line, so a
 *    malformed hunk still produced a non-null map and the SAST discount
 *    survived. A well-formed diff reaches `@@` / `diff --git` / the next
 *    `--- `/`+++ ` pair or EOF once the counts are spent, so any other
 *    body-shaped line in header mode is over-delivery (AC1's count-mismatch
 *    clause). The plan critic's exact fixture pins the new side; the old
 *    side and context side get their own legs.
 *  - Arbitrary backslash-prefixed ARMED lines: `startsWith('\\')` accepted
 *    any `\...` line as inert metadata, so `\garbage` consumed no count and
 *    the remaining body lines still produced a map. Only the documented
 *    `\ No newline at end of file` marker is inert.
 *  - Positive controls so the strictness cannot over-reject: the exact
 *    no-newline marker stays inert, a two-file `--- `/`+++ ` header pair in
 *    header mode still parses, and a REAL git diff of a file with no
 *    trailing newline (which emits the genuine marker) still classifies.
 */

import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import {
	getChangedLineRanges,
	parseDiffLineRanges,
	_internals as preCheckBatchInternals,
} from '../../../src/tools/pre-check-batch.js';
import { canonicalMkdtemp, removeTreeWithRetry } from '../../helpers/tmpdir.js';

function git(cwd: string, ...args: string[]): void {
	execFileSync('git', args, {
		cwd,
		stdio: ['ignore', 'ignore', 'pipe'],
		timeout: 10_000,
		windowsHide: true,
	});
}

function write(root: string, file: string, content: string): void {
	const target = path.join(root, file);
	mkdirSync(path.dirname(target), { recursive: true });
	writeFileSync(target, content);
}

describe('over-delivery after both counters are exhausted (#3681 round 2)', () => {
	test('an extra new-side body line in header mode fails closed', () => {
		// The plan critic's fixture: a 1-line hunk followed by `+extra`.
		// Pre-fix the extra line was silently ignored in header mode.
		const result = parseDiffLineRanges(
			'+++ f.ts\n@@ -1,0 +1,1 @@\n+expected\n+extra\n',
		);
		expect(result.size).toBe(0);
	}, 10_000);

	test('an extra old-side body line in header mode fails closed', () => {
		const result = parseDiffLineRanges(
			'+++ f.ts\n@@ -1,1 +1,0 @@\n-gone\n-extra\n',
		);
		expect(result.size).toBe(0);
	}, 10_000);

	test('an extra context body line in header mode fails closed', () => {
		const result = parseDiffLineRanges(
			'+++ f.ts\n@@ -1,1 +1,1 @@\n-a\n+b\n extra\n',
		);
		expect(result.size).toBe(0);
	}, 10_000);

	test('a lone over-delivered hunk followed by a valid file still fails closed', () => {
		// The malformed hunk must poison the WHOLE diff, not just its file:
		// a partial map would under-report the changed lines.
		const result = parseDiffLineRanges(
			[
				'+++ bad.ts',
				'@@ -1,0 +1,1 @@',
				'+expected',
				'+extra',
				'--- good.ts',
				'+++ good.ts',
				'@@ -1,0 +1,1 @@',
				'+real',
			].join('\n'),
		);
		expect(result.size).toBe(0);
	}, 10_000);
});

describe('unknown backslash-prefixed armed lines (#3681 round 2)', () => {
	test('`\\garbage` while armed fails closed', () => {
		const result = parseDiffLineRanges(
			'+++ f.ts\n@@ -1,1 +1,1 @@\n-a\n\\garbage\n+b\n',
		);
		expect(result.size).toBe(0);
	}, 10_000);

	test('a bare backslash while armed fails closed', () => {
		const result = parseDiffLineRanges(
			'+++ f.ts\n@@ -1,1 +1,1 @@\n-a\n\\\n+b\n',
		);
		expect(result.size).toBe(0);
	}, 10_000);

	test('unknown backslash metadata AFTER the hunk completes fails closed', () => {
		// The header-mode guard covers `+`/`-`/` `-shaped over-delivery; the
		// same rule must cover hunk metadata once the counts are spent, or a
		// post-hunk `\garbage` rides through inert and the malformed diff
		// keeps its map (plan-critic round 7, finding 1).
		const result = parseDiffLineRanges(
			[
				'diff --git f.ts f.ts',
				'--- f.ts',
				'+++ f.ts',
				'@@ -1,0 +1,1 @@',
				'+expected',
				'\\garbage',
			].join('\n'),
		);
		expect(result.size).toBe(0);
	}, 10_000);

	test('the exact no-newline marker after a completed hunk stays inert (positive control)', () => {
		// git emits the marker after the FINAL body line, which is header
		// mode when the counts were exactly spent — the legitimate case the
		// strictness must not reject.
		const result = parseDiffLineRanges(
			[
				'diff --git f.ts f.ts',
				'--- f.ts',
				'+++ f.ts',
				'@@ -1,0 +1,1 @@',
				'+expected',
				'\\ No newline at end of file',
			].join('\n'),
		);
		const lines = result.get('f.ts');
		expect(lines).toBeDefined();
		expect([...(lines ?? [])]).toEqual([1]);
	}, 10_000);

	test('a second file-header pair inside one git section fails closed (production mode)', () => {
		// The production consumer parses with requireGitFileHeaders=true, and
		// a git file section carries exactly ONE `--- `/`+++ ` pair — the next
		// file starts at a fresh `diff --git`. Accepting a second pair inside
		// the same section lets a malformed diff reattribute the following
		// hunks to a PHANTOM key, so the real file loses its later changed
		// lines and they classify PRE-EXISTING (plan-critic round 8). The
		// public wrapper cannot reach this shape (it parses with the flag
		// false), so this leg drives the checked parser through the _internals
		// seam with the production flag.
		const malformed = [
			'diff --git f.ts f.ts',
			'--- f.ts',
			'+++ f.ts',
			'@@ -1,0 +1,1 @@',
			'+one',
			'--- phantom.ts',
			'+++ phantom.ts',
			'@@ -2,0 +2,1 @@',
			'+two',
		].join('\n');
		const checked = preCheckBatchInternals.parseDiffLineRangesChecked(
			malformed,
			true,
		);
		expect(checked).toBeNull();
	}, 10_000);

	test('a fresh diff --git boundary still starts a new file (production mode)', () => {
		// The control for the leg above: the same two-file diff WITH the
		// boundary git actually emits must parse both files.
		const wellFormed = [
			'diff --git f.ts f.ts',
			'--- f.ts',
			'+++ f.ts',
			'@@ -1,0 +1,1 @@',
			'+one',
			'diff --git phantom.ts phantom.ts',
			'--- phantom.ts',
			'+++ phantom.ts',
			'@@ -2,0 +2,1 @@',
			'+two',
		].join('\n');
		const checked = preCheckBatchInternals.parseDiffLineRangesChecked(
			wellFormed,
			true,
		);
		expect(checked).not.toBeNull();
		expect([...(checked?.keys() ?? [])].sort()).toEqual(['f.ts', 'phantom.ts']);
		expect([...(checked?.get('phantom.ts') ?? [])]).toEqual([2]);
	}, 10_000);

	test('a combined (merge) diff fails closed rather than misparsing', () => {
		// Combined output (`diff --cc`, the default rendering of an unresolved
		// merge) is deliberately out of grammar: the `@@@` header and the
		// two-column body must not be half-parsed into a partial map. Failing
		// closed means every finding is treated as new — the safe direction.
		// Pinned so the limitation is deliberate, not accidental.
		//
		// WHERE this rejects, precisely: the ordinary `diff --git` section
		// first sets `destinationSeen`, and `diff --cc` does not reset it, so
		// the combined section's own `--- f.ts` trips the
		// one-pair-per-git-section guard BEFORE the `@@@` header is ever
		// examined. Executed proof: replacing the `@@@` header with a valid
		// `@@` header still returns null, and truncating the fixture at
		// `--- f.ts` still returns null. An earlier version of this comment
		// claimed the rejection happened on the `@@@` header — false, and
		// corrected in round 13 (implementation-review round 12 and
		// plan-critic round 11 both overturned it by execution). The
		// combined shape is in fact rejected by a STACK of independent rules;
		// see pre-check-batch-git-config-shapes-3681.test.ts for the explicit
		// `diff --cc` section-boundary rejection and the surviving-mutant
		// disclosure.
		const combined = [
			'diff --git a.ts a.ts',
			'--- a.ts',
			'+++ a.ts',
			'@@ -1,0 +1,1 @@',
			'+ordinary',
			'diff --cc f.ts',
			'index 0000000,0000000..0000000',
			'--- f.ts',
			'+++ f.ts',
			'@@@ -1,1 -1,1 +1,1 @@@',
			'--one',
			'- two',
			'++three',
		].join('\n');
		const checked = preCheckBatchInternals.parseDiffLineRangesChecked(
			combined,
			true,
		);
		expect(checked).toBeNull();
	}, 10_000);

	test('the exact no-newline marker stays inert (positive control)', () => {
		const result = parseDiffLineRanges(
			[
				'+++ f.ts',
				'@@ -1,1 +1,1 @@',
				'-a',
				'\\ No newline at end of file',
				'+b',
			].join('\n'),
		);
		const lines = result.get('f.ts');
		expect(lines).toBeDefined();
		expect([...(lines ?? [])].sort((left, right) => left - right)).toEqual([1]);
	}, 10_000);
});

describe('header-mode positives (#3681 round 2)', () => {
	test('a two-file diff still parses both files', () => {
		// Guards the header-mode exclusion: `--- `/`+++ ` are the legitimate
		// `-`/`+`-prefixed shapes once the counts are spent.
		const result = parseDiffLineRanges(
			[
				'+++ a.ts',
				'@@ -1,1 +1,1 @@',
				'-x',
				'+y',
				'--- b.ts',
				'+++ b.ts',
				'@@ -1,1 +1,1 @@',
				'-p',
				'+q',
			].join('\n'),
		);
		expect([...result.keys()].sort()).toEqual(['a.ts', 'b.ts']);
		expect([...(result.get('a.ts') ?? [])]).toEqual([1]);
		expect([...(result.get('b.ts') ?? [])]).toEqual([1]);
	}, 10_000);

	test('a real git diff of a file with no trailing newline still classifies', async () => {
		// Production geometry: git emits the genuine `\ No newline at end of
		// file` marker, so the exact-match allowance must keep real diffs
		// parsing through the production consumer.
		const directory = canonicalMkdtemp('parser-strictness-3681b-');
		try {
			git(directory, 'init', '-q', '-b', 'main');
			git(directory, 'config', 'user.email', 'test@example.com');
			git(directory, 'config', 'user.name', 'Test');
			git(directory, 'config', 'core.autocrlf', 'false');
			write(directory, 'src/app.ts', 'export const a = 1;');
			git(directory, 'add', 'src/app.ts');
			git(directory, 'commit', '-q', '-m', 'base');
			write(directory, 'src/app.ts', 'export const a = 2;');
			git(directory, 'add', 'src/app.ts');
			// requestedFiles entries are ABSOLUTE paths (the production
			// callers hand the SAST finding locations straight through).
			const ranges = await getChangedLineRanges(directory, undefined, [
				path.join(directory, 'src', 'app.ts'),
			]);
			expect(ranges).not.toBeNull();
			const lines = ranges?.get('src/app.ts');
			expect(lines).toBeDefined();
			expect([...(lines ?? [])].length).toBeGreaterThan(0);
		} finally {
			removeTreeWithRetry(directory);
		}
	}, 30_000);

	test('a submodule pointer change under diff.submodule=log keeps the map non-null', async () => {
		// A repo-configured `diff.submodule=log` renders a changed pointer of
		// a REGISTERED submodule as `Submodule sm a..b:` followed by
		// `  > <msg>` — a leading-space line the header-mode over-delivery
		// guard fails closed on, nulling the whole changed-line map for any
		// repo with submodules (final-critic round 11). The three diff argv
		// sites pin `--submodule=short`, which renders the pointer as an
		// ordinary `-Subproject commit`/`+Subproject commit` pair. Removing
		// the pin nulls the map, so this leg is the 20th killed probe.
		const directory = canonicalMkdtemp('parser-strictness-3681b-sm-');
		const smSrc = path.join(directory, 'sm-src');
		const smClone = path.join(directory, 'sm');
		try {
			git(directory, 'init', '-q', '-b', 'main');
			git(directory, 'config', 'user.email', 'test@example.com');
			git(directory, 'config', 'user.name', 'Test');
			git(directory, 'config', 'core.autocrlf', 'false');
			write(directory, 'src/app.ts', 'export const a = 1;\n');
			// A real registered submodule: only a submodule listed in
			// .gitmodules gets the `Submodule …` rendering.
			mkdirSync(smSrc, { recursive: true });
			write(smSrc, 'keep.txt', 'one\n');
			git(smSrc, 'init', '-q', '-b', 'main');
			git(smSrc, 'config', 'user.email', 'test@example.com');
			git(smSrc, 'config', 'user.name', 'Test');
			git(smSrc, 'add', 'keep.txt');
			git(smSrc, 'commit', '-q', '-m', 'sm base');
			git(
				directory,
				'-c',
				'protocol.file.allow=always',
				'submodule',
				'add',
				'-q',
				'./sm-src',
				'sm',
			);
			git(directory, 'add', 'src/app.ts');
			git(directory, 'commit', '-q', '-m', 'base');
			// Advance the pointer by committing inside the clone, which is
			// what the parent index records.
			write(smClone, 'keep.txt', 'two\n');
			git(smClone, 'commit', '-q', '-am', 'sm change');
			git(directory, 'add', 'sm');
			git(directory, 'config', 'diff.submodule', 'log');
			write(directory, 'src/app.ts', 'export const a = 2;\n');
			git(directory, 'add', 'src/app.ts');
			const ranges = await getChangedLineRanges(directory, undefined, [
				path.join(directory, 'src', 'app.ts'),
			]);
			expect(ranges).not.toBeNull();
			const lines = ranges?.get('src/app.ts');
			expect(lines).toBeDefined();
			expect([...(lines ?? [])].length).toBeGreaterThan(0);
		} finally {
			removeTreeWithRetry(directory);
		}
	}, 30_000);

	test('a fused blank context line under interHunkContext+suppressBlankEmpty keeps the map non-null', async () => {
		// A repo-configured `diff.interHunkContext` fuses the -U0 hunks and
		// `diff.suppressBlankEmpty` renders the fused blank context line with
		// NO leading space — an empty line the armed branch would fail closed
		// on, nulling the whole map (final-critic round 12; executed: base
		// returned a map, the unpinned head returned null). The three diff
		// argv sites pin `--inter-hunk-context=0`, keeping the hunks separate.
		const directory = canonicalMkdtemp('parser-strictness-3681b-ihc-');
		try {
			git(directory, 'init', '-q', '-b', 'main');
			git(directory, 'config', 'user.email', 'test@example.com');
			git(directory, 'config', 'user.name', 'Test');
			git(directory, 'config', 'core.autocrlf', 'false');
			// Two edits separated by exactly one BLANK line: the config fuses
			// them into one hunk whose blank context line renders spaceless.
			write(
				directory,
				'src/f.ts',
				['alpha', 'one', '', 'two', 'omega'].join('\n'),
			);
			git(directory, 'add', 'src/f.ts');
			git(directory, 'commit', '-q', '-m', 'base');
			write(
				directory,
				'src/f.ts',
				['alpha', 'ONE', '', 'TWO', 'omega'].join('\n'),
			);
			git(directory, 'add', 'src/f.ts');
			git(directory, 'config', 'diff.interHunkContext', '3');
			git(directory, 'config', 'diff.suppressBlankEmpty', 'true');
			const ranges = await getChangedLineRanges(directory, undefined, [
				path.join(directory, 'src', 'f.ts'),
			]);
			expect(ranges).not.toBeNull();
			const lines = ranges?.get('src/f.ts');
			expect(lines).toBeDefined();
			expect([...(lines ?? [])].sort((left, right) => left - right)).toEqual([
				2, 4,
			]);
		} finally {
			removeTreeWithRetry(directory);
		}
	}, 30_000);
});
