/**
 * Issue #3681 (round 14) — the fail-open shapes the round-13 argv pins and
 * binary-section handling did NOT close, each verified by executed probe on
 * both the trace base 785fb51c9 and the round-13 head, so none is a
 * regression introduced by that round.
 *
 * Four families, all in the same defect class as #3681 item 1 (a real changed
 * file vanishing from the changed-line map, so its SAST findings classify
 * PRE-EXISTING and the discount survives):
 *
 *  - A binary-rendered file whose path is not the simple lowercase-ASCII shape
 *    the round-13 handler assumed: a path containing ` and `, a path with a
 *    leading space, and a mixed-case path on win32/darwin where the classifier
 *    lowercases keys.
 *  - A `filter=<driver>` attribute: `--no-textconv` disables the textconv
 *    driver but not a clean/process filter, so git still diffs the CLEANED
 *    representation while SAST scans the worktree one.
 *  - A copied file under `diff.renames=copies`, which emits only
 *    `copy from`/`copy to` with no hunk.
 *  - Malformed input: a `+++ ` destination the `diff --git` header did not
 *    name, and a non-empty diff containing no git file section at all.
 */

import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import {
	classifySastFindings,
	getChangedLineRanges,
	parseDiffLineRanges,
	_internals as preCheckBatchInternals,
} from '../../../src/tools/pre-check-batch.js';
import { canonicalMkdtemp, removeTreeWithRetry } from '../../helpers/tmpdir.js';

/** The module-private sentinel; a set containing it means "every line". */
const ALL_LINES_CHANGED = -1;

function git(cwd: string, ...args: string[]): void {
	execFileSync('git', args, {
		cwd,
		stdio: ['ignore', 'ignore', 'pipe'],
		timeout: 20_000,
		windowsHide: true,
	});
}

function write(root: string, file: string, content: string): void {
	const target = path.join(root, file);
	mkdirSync(path.dirname(target), { recursive: true });
	writeFileSync(target, content);
}

function sastFinding(file: string, line: number) {
	return {
		rule_id: 'probe',
		severity: 'high' as const,
		message: 'probe',
		location: { file, line },
	};
}

describe('binary-rendered file sections with non-trivial paths (#3681 round 14)', () => {
	test('a binary file whose path contains ` and ` keys the REAL path, not a phantom', async () => {
		// Round-14 finding (all three gates): `parseBinaryFilesLine` split on
		// the FIRST ` and `, so `rock and roll.js` produced the phantom key
		// `roll.js and rock and roll.js`, the real file left the map, and its
		// findings classified PRE-EXISTING. The symmetric-form split fixes it.
		const directory = canonicalMkdtemp('git-shapes-3681-and-');
		try {
			git(directory, 'init', '-q', '-b', 'main');
			git(directory, 'config', 'user.email', 'test@example.com');
			git(directory, 'config', 'user.name', 'Test');
			git(directory, 'config', 'core.autocrlf', 'false');
			write(directory, 'app.js', 'const a = 1;\n');
			git(directory, 'add', 'app.js');
			git(directory, 'commit', '-q', '-m', 'base');
			write(directory, '.gitattributes', '*.js -diff\n');
			write(directory, 'rock and roll.js', 'const a = 1;\n');
			git(directory, 'add', '-A');
			git(directory, 'commit', '-q', '-m', 'add');
			write(directory, 'rock and roll.js', 'const a = 1;\neval(userInput);\n');
			git(directory, 'add', '-A');

			const ranges = await getChangedLineRanges(directory, undefined, [
				path.join(directory, 'rock and roll.js'),
			]);
			expect(ranges).not.toBeNull();
			expect([...(ranges?.get('rock and roll.js') ?? [])]).toEqual([
				ALL_LINES_CHANGED,
			]);
			expect(ranges?.has('roll.js and rock and roll.js')).toBe(false);

			const classified = classifySastFindings(
				[sastFinding(path.join(directory, 'rock and roll.js'), 2)],
				ranges,
				directory,
			);
			expect(classified.newFindings).toHaveLength(1);
			expect(classified.preexistingFindings).toHaveLength(0);
		} finally {
			removeTreeWithRetry(directory);
		}
	}, 30_000);

	test('a binary file whose path has a leading space keeps it', async () => {
		// Round-14 finding: `.trim()` on the extracted destination stripped a
		// significant leading space, so ` lead.js` keyed as `lead.js` and the
		// classifier's lookup for ` lead.js` missed.
		const directory = canonicalMkdtemp('git-shapes-3681-lead-');
		try {
			git(directory, 'init', '-q', '-b', 'main');
			git(directory, 'config', 'user.email', 'test@example.com');
			git(directory, 'config', 'user.name', 'Test');
			git(directory, 'config', 'core.autocrlf', 'false');
			write(directory, 'app.js', 'const a = 1;\n');
			git(directory, 'add', 'app.js');
			git(directory, 'commit', '-q', '-m', 'base');
			write(directory, '.gitattributes', '*.js -diff\n');
			write(directory, ' lead.js', 'const a = 1;\n');
			git(directory, 'add', '-A');
			git(directory, 'commit', '-q', '-m', 'add');
			write(directory, ' lead.js', 'const a = 1;\neval(userInput);\n');
			git(directory, 'add', '-A');

			const ranges = await getChangedLineRanges(directory, undefined, [
				path.join(directory, ' lead.js'),
			]);
			expect(ranges).not.toBeNull();
			expect([...(ranges?.get(' lead.js') ?? [])]).toEqual([ALL_LINES_CHANGED]);
			const classified = classifySastFindings(
				[sastFinding(path.join(directory, ' lead.js'), 2)],
				ranges,
				directory,
			);
			expect(classified.newFindings).toHaveLength(1);
			expect(classified.preexistingFindings).toHaveLength(0);
		} finally {
			removeTreeWithRetry(directory);
		}
	}, 30_000);

	test('a binary file with a mixed-case path is keyed the way the classifier looks it up', async () => {
		// Round-14 finding (all three gates): the binary path bypassed
		// `normalizeRepoPathKey`, so on win32/darwin — where the classifier
		// lowercases keys — `Src/App.js` entered the map mixed-case and the
		// lookup missed. Executed on win32: pre-fix `new=0 pre=1`, post-fix
		// `new=1 pre=0`.
		const directory = canonicalMkdtemp('git-shapes-3681-case-');
		try {
			git(directory, 'init', '-q', '-b', 'main');
			git(directory, 'config', 'user.email', 'test@example.com');
			git(directory, 'config', 'user.name', 'Test');
			git(directory, 'config', 'core.autocrlf', 'false');
			write(directory, 'app.js', 'const a = 1;\n');
			git(directory, 'add', 'app.js');
			git(directory, 'commit', '-q', '-m', 'base');
			write(directory, '.gitattributes', '*.js -diff\n');
			write(path.join(directory, 'Src'), 'App.js', 'const a = 1;\n');
			git(directory, 'add', '-A');
			git(directory, 'commit', '-q', '-m', 'add');
			write(
				path.join(directory, 'Src'),
				'App.js',
				'const a = 1;\neval(userInput);\n',
			);
			git(directory, 'add', '-A');

			const ranges = await getChangedLineRanges(directory, undefined, [
				path.join(directory, 'Src', 'App.js'),
			]);
			expect(ranges).not.toBeNull();
			const key = [...(ranges ?? new Map()).keys()].find((k) =>
				k.toLowerCase().endsWith('src/app.js'),
			);
			expect(key).toBeDefined();
			expect([...(ranges?.get(key ?? '') ?? [])]).toEqual([ALL_LINES_CHANGED]);

			const classified = classifySastFindings(
				[sastFinding(path.join(directory, 'Src', 'App.js'), 2)],
				ranges,
				directory,
			);
			expect(classified.newFindings).toHaveLength(1);
			expect(classified.preexistingFindings).toHaveLength(0);
		} finally {
			removeTreeWithRetry(directory);
		}
	}, 30_000);
});

describe('content-transforming git configuration (#3681 round 14)', () => {
	test('a content-altering clean filter marks the file ALL_LINES_CHANGED', async () => {
		// Round-14 finding (plan critic): `--no-textconv` disables the textconv
		// driver but NOT a `filter=<driver>` attribute, so git still diffs the
		// CLEANED representation while SAST scans the worktree one. Executed
		// pre-fix with `filter.squeeze.clean=sed 1d`: git reported
		// `@@ -2 +2 @@` for a SOURCE-line-3 edit and the line-3 finding
		// classified PRE-EXISTING. The `git check-attr filter` leg marks such a
		// file ALL_LINES_CHANGED, so the finding classifies NEW.
		const directory = canonicalMkdtemp('git-shapes-3681-clean-');
		try {
			git(directory, 'init', '-q', '-b', 'main');
			git(directory, 'config', 'user.email', 'test@example.com');
			git(directory, 'config', 'user.name', 'Test');
			git(directory, 'config', 'core.autocrlf', 'false');
			write(
				directory,
				'src/app.ts',
				'export const a = 1;\nexport const b = 2;\nexport const c = 3;\n',
			);
			git(directory, 'add', 'src/app.ts');
			git(directory, 'commit', '-q', '-m', 'base');
			write(directory, '.gitattributes', 'src/app.ts filter=squeeze\n');
			git(directory, 'config', 'filter.squeeze.clean', 'sed 1d');
			git(directory, 'config', 'filter.squeeze.smudge', 'cat');
			write(
				directory,
				'src/app.ts',
				'export const a = 1;\nexport const b = 2;\nexport const C = 3;\n',
			);
			git(directory, 'add', '-A');

			const ranges = await getChangedLineRanges(directory, undefined, [
				path.join(directory, 'src', 'app.ts'),
			]);
			expect(ranges).not.toBeNull();
			expect([...(ranges?.get('src/app.ts') ?? [])]).toEqual([
				ALL_LINES_CHANGED,
			]);

			const classified = classifySastFindings(
				[sastFinding(path.join(directory, 'src', 'app.ts'), 3)],
				ranges,
				directory,
			);
			expect(classified.newFindings).toHaveLength(1);
			expect(classified.preexistingFindings).toHaveLength(0);
		} finally {
			removeTreeWithRetry(directory);
		}
	}, 30_000);

	test('a copied file under diff.renames=copies is gated, not omitted', async () => {
		// Round-14 finding (plan critic): a copy emits ONLY
		// `copy from`/`copy to` with no hunk, so the destination left the map
		// and its findings classified PRE-EXISTING. Executed pre-fix:
		// `ranges [["src/original.ts",[2]]]`, classify `new=0 pre=1`.
		const directory = canonicalMkdtemp('git-shapes-3681-copy-');
		try {
			git(directory, 'init', '-q', '-b', 'main');
			git(directory, 'config', 'user.email', 'test@example.com');
			git(directory, 'config', 'user.name', 'Test');
			git(directory, 'config', 'core.autocrlf', 'false');
			git(directory, 'config', 'diff.renames', 'copies');
			write(
				directory,
				'src/original.ts',
				'export const a = 1;\nexport const b = 2;\nexport const c = 3;\n',
			);
			git(directory, 'add', 'src/original.ts');
			git(directory, 'commit', '-q', '-m', 'base');
			write(
				directory,
				'src/copied.ts',
				'export const a = 1;\nexport const b = 2;\nexport const c = 3;\n',
			);
			write(
				directory,
				'src/original.ts',
				'export const a = 1;\nexport const B = 2;\nexport const c = 3;\n',
			);
			git(directory, 'add', '-A');

			const ranges = await getChangedLineRanges(directory, undefined, [
				path.join(directory, 'src', 'copied.ts'),
			]);
			expect(ranges).not.toBeNull();
			expect([...(ranges?.get('src/copied.ts') ?? [])]).toEqual([
				ALL_LINES_CHANGED,
			]);

			const classified = classifySastFindings(
				[sastFinding(path.join(directory, 'src', 'copied.ts'), 2)],
				ranges,
				directory,
			);
			expect(classified.newFindings).toHaveLength(1);
			expect(classified.preexistingFindings).toHaveLength(0);
		} finally {
			removeTreeWithRetry(directory);
		}
	}, 30_000);
});

describe('malformed and unrecognized diff input (#3681 round 14)', () => {
	// Round-14 findings: the parser never validated the `diff --git` paths
	// against the section's `+++ ` destination, and it silently ignored
	// unrecognized non-empty header content — so a phantom destination and
	// pure junk both produced authoritative maps in the fail-open direction.

	test('a +++ destination that the diff --git header did not name fails closed', () => {
		// Executed pre-fix: `{src/phantom.ts: [1]}`, so src/real.ts lost its
		// changed line and its findings classified PRE-EXISTING.
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
	});

	test('a new file whose diff --git destination is /dev/null still parses', () => {
		// The control for the leg above: git names the a-side /dev/null for a
		// new file, so the b-side legitimately differs from the a-side.
		const checked = preCheckBatchInternals.parseDiffLineRangesChecked(
			[
				'diff --git /dev/null src/new.ts',
				'--- /dev/null',
				'+++ src/new.ts',
				'@@ -0,0 +1 @@',
				'+created',
			].join('\n'),
			true,
		);
		expect(checked).not.toBeNull();
		expect([...(checked?.get('src/new.ts') ?? [])]).toEqual([1]);
	});

	test('a path containing a space still validates against its own header', () => {
		// The symmetric `diff --git <p> <p>` form is what makes a space-bearing
		// path unambiguous; the `+++ ` must match it.
		const symmetric = [
			'diff --git my file.ts my file.ts',
			'--- my file.ts',
			'+++ my file.ts',
			'@@ -0,0 +1 @@',
			'+ok',
		].join('\n');
		expect(
			preCheckBatchInternals.parseDiffLineRangesChecked(symmetric, true),
		).not.toBeNull();
		const mismatched = [
			'diff --git my file.ts my file.ts',
			'--- my file.ts',
			'+++ other.ts',
			'@@ -0,0 +1 @@',
			'+ok',
		].join('\n');
		expect(
			preCheckBatchInternals.parseDiffLineRangesChecked(mismatched, true),
		).toBeNull();
	});

	test('a non-empty diff with no git file section fails closed in production mode', () => {
		// Executed pre-fix: `"not a diff\n"` returned a non-null EMPTY map,
		// which is indistinguishable from a legitimate no-change diff and
		// silently disabled the discount for the whole batch.
		expect(
			preCheckBatchInternals.parseDiffLineRangesChecked('not a diff\n', true),
		).toBeNull();
		expect(
			preCheckBatchInternals.parseDiffLineRangesChecked(
				'diff --git a.ts a.ts\nindex 0000000..1111111 100644\n',
				true,
			),
		).not.toBeNull();
	});

	test('empty output stays the legitimate no-change shorthand', () => {
		const checked = preCheckBatchInternals.parseDiffLineRangesChecked('', true);
		expect(checked).not.toBeNull();
		expect(checked?.size).toBe(0);
	});

	test('the header-less public wrapper still accepts unrecognized header content', () => {
		// The production-mode no-section rule must not reach the public
		// `parseDiffLineRanges` surface, which parses with
		// requireGitFileHeaders=false and has its own callers.
		const result = parseDiffLineRanges('+++ f.ts\n@@ -1,1 +1,1 @@\n-a\n+b\n');
		expect([...(result.get('f.ts') ?? [])]).toEqual([1]);
	});
});
