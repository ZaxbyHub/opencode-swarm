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
});
