/**
 * Issue #3681 (round 13) — repository git-configuration and .gitattributes
 * shapes that change the TEXTUAL rendering of `git diff` without changing the
 * content. Every leg here is a REAL git fixture, because the defect class is
 * "git emitted something the strict parser did not expect" and a synthetic
 * fixture cannot prove what git actually renders.
 *
 * Two fail-open shapes closed here (both verified PRE-EXISTING at the trace
 * base 785fb51c9 by executed probe — not regressions introduced by this PR):
 *
 *  - A text file marked `-diff` / `binary` in `.gitattributes` renders as
 *    `Binary files X and Y differ` with no `--- `/`+++ `/`@@` at all. The
 *    parser skipped that unrecognized header line, so the file never entered
 *    the map, and `classifySastFindings` treats a MISSING key as PRE-EXISTING —
 *    a newly added dangerous line kept its discount. The fix marks such a file
 *    ALL_LINES_CHANGED (every finding in it is new), matching the existing
 *    untracked/ignored-file convention.
 *
 *  - A `diff.<driver>.textconv` filter rewrites the file before diffing, so
 *    hunk coordinates refer to the CONVERTED text, not the source SAST scans.
 *    `--no-ext-diff` does not disable textconv. The fix pins `--no-textconv`
 *    on the three patch-producing argv sites (attest-task.ts:243-249 already
 *    did so for this exact diff-driver class).
 *
 * Plus the explicit combined-diff (`diff --cc` / `diff --combined`) rejection
 * at the section boundary, which replaces an incidental rejection that the
 * previous leg's comment mis-described.
 */

import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import {
	classifySastFindings,
	getChangedLineRanges,
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

describe('binary-rendered file sections (#3681 round 13)', () => {
	for (const attribute of ['-diff', 'binary'] as const) {
		test(`a .gitattributes ${attribute} text file is marked ALL_LINES_CHANGED, not dropped`, async () => {
			// Executed pre-fix: the map carried only .gitattributes and a HIGH
			// finding on app.js line 2 classified PRE-EXISTING (fail-open).
			// Executed post-fix: app.js is present with the sentinel and the
			// finding classifies NEW.
			const directory = canonicalMkdtemp('git-shapes-3681-bin-');
			try {
				git(directory, 'init', '-q', '-b', 'main');
				git(directory, 'config', 'user.email', 'test@example.com');
				git(directory, 'config', 'user.name', 'Test');
				git(directory, 'config', 'core.autocrlf', 'false');
				write(directory, 'app.js', 'const a = 1;\n');
				git(directory, 'add', 'app.js');
				git(directory, 'commit', '-q', '-m', 'base');
				write(directory, '.gitattributes', `*.js ${attribute}\n`);
				write(directory, 'app.js', 'const a = 1;\neval(userInput);\n');
				git(directory, 'add', '-A');

				const ranges = await getChangedLineRanges(directory, undefined, [
					path.join(directory, 'app.js'),
				]);
				expect(ranges).not.toBeNull();
				const appLines = ranges?.get('app.js');
				expect(appLines).toBeDefined();
				expect([...(appLines ?? [])]).toEqual([ALL_LINES_CHANGED]);

				const classified = classifySastFindings(
					[sastFinding(path.join(directory, 'app.js'), 2)],
					ranges,
					directory,
				);
				expect(classified.newFindings).toHaveLength(1);
				expect(classified.preexistingFindings).toHaveLength(0);
			} finally {
				removeTreeWithRetry(directory);
			}
		}, 30_000);
	}

	test('a deleted binary file consumes its section without inventing a key', () => {
		// `Binary files app.js and /dev/null differ`: the destination is
		// /dev/null, so there are no lines left to gate. The section must be
		// consumed (not silently skipped, and not failed closed either — a
		// deletion is ordinary git output).
		const checked = preCheckBatchInternals.parseDiffLineRangesChecked(
			[
				'diff --git app.js app.js',
				'deleted file mode 100644',
				'index 54b82a0..0000000',
				'Binary files app.js and /dev/null differ',
			].join('\n'),
			true,
		);
		expect(checked).not.toBeNull();
		expect(checked?.has('app.js')).toBe(false);
		expect(checked?.size).toBe(0);
	});

	test('a GIT binary patch section marks the file ALL_LINES_CHANGED', () => {
		const checked = preCheckBatchInternals.parseDiffLineRangesChecked(
			[
				'diff --git img.png img.png',
				'index 54b82a0..85181cf 100644',
				'GIT binary patch',
				'literal 1234',
				'zcmZ?wbh0y{7Nf',
			].join('\n'),
			true,
		);
		expect(checked).not.toBeNull();
		expect([...(checked?.get('img.png') ?? [])]).toEqual([ALL_LINES_CHANGED]);
	});

	test('a Binary files line outside a git section fails closed', () => {
		const checked = preCheckBatchInternals.parseDiffLineRangesChecked(
			'Binary files a.js and b.js differ\n',
			true,
		);
		expect(checked).toBeNull();
	});

	test('a Binary files line with no ` and ` separator fails closed', () => {
		const checked = preCheckBatchInternals.parseDiffLineRangesChecked(
			[
				'diff --git weird.js weird.js',
				'index 54b82a0..85181cf 100644',
				'Binary files weird.js differ',
			].join('\n'),
			true,
		);
		expect(checked).toBeNull();
	});
});

describe('textconv-shifted hunk coordinates (#3681 round 13)', () => {
	test('a textconv filter no longer shifts the changed line off the source line', async () => {
		// Executed pre-fix: the fixture's `sed 1d` textconv made git report
		// `@@ -2 +2 @@` for an edit on SOURCE line 3, so a HIGH finding on
		// line 3 classified PRE-EXISTING. `--no-textconv` restores `@@ -3 +3 @@`.
		const directory = canonicalMkdtemp('git-shapes-3681-tc-');
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
			write(directory, '.gitattributes', 'src/app.ts diff=squeeze\n');
			git(directory, 'config', 'diff.squeeze.textconv', 'sed 1d');
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
			const lines = ranges?.get('src/app.ts');
			expect([...(lines ?? [])].sort((left, right) => left - right)).toEqual([
				3,
			]);

			const onTheEditedLine = classifySastFindings(
				[sastFinding(path.join(directory, 'src', 'app.ts'), 3)],
				ranges,
				directory,
			);
			expect(onTheEditedLine.newFindings).toHaveLength(1);
			expect(onTheEditedLine.preexistingFindings).toHaveLength(0);

			// Control: a finding on an untouched line stays PRE-EXISTING, so
			// the leg cannot pass by marking every line changed.
			const onAnUntouchedLine = classifySastFindings(
				[sastFinding(path.join(directory, 'src', 'app.ts'), 2)],
				ranges,
				directory,
			);
			expect(onAnUntouchedLine.newFindings).toHaveLength(0);
			expect(onAnUntouchedLine.preexistingFindings).toHaveLength(1);
		} finally {
			removeTreeWithRetry(directory);
		}
	}, 30_000);
});

describe('combined diffs are rejected at the section boundary (#3681 round 13)', () => {
	// DEFENSE IN DEPTH, not a single-rule pin. A combined diff is rejected by
	// a STACK of independent rules — the explicit `diff --cc` /
	// `diff --combined` boundary rejection below, the git-file-header
	// requirement in production mode, the one-pair-per-git-section guard when
	// the combined section carries its own `--- `/`+++ ` pair, the unified
	// hunk-header regex on the `@@@` line, and the two-column body's
	// over-delivery. Executed probe: removing ANY ONE of them still leaves
	// the map null, so no single rule is individually load-bearing and these
	// legs are recorded as surviving-mutant-by-design rather than as kills.
	// What the legs DO pin is the OUTCOME (null), which is the safety
	// property. The explicit boundary rejection is kept because it names the
	// documented scope decision in the one place a future grammar change
	// would have to look, instead of relying on incidental rejections.

	test('a diff --cc line inside a git section fails closed', () => {
		const checked = preCheckBatchInternals.parseDiffLineRangesChecked(
			[
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
			].join('\n'),
			true,
		);
		expect(checked).toBeNull();
	});

	test('a diff --combined line fails closed too', () => {
		const checked = preCheckBatchInternals.parseDiffLineRangesChecked(
			[
				'diff --git a.ts a.ts',
				'--- a.ts',
				'+++ a.ts',
				'@@ -1,0 +1,1 @@',
				'+ordinary',
				'diff --combined f.ts',
				'@@@ -1,1 -1,1 +1,1 @@@',
				'--one',
			].join('\n'),
			true,
		);
		expect(checked).toBeNull();
	});

	test('a combined diff with no file headers at all fails closed in production mode', () => {
		const checked = preCheckBatchInternals.parseDiffLineRangesChecked(
			['diff --cc f.ts', '@@@ -1,1 -1,1 +1,1 @@@', '--one'].join('\n'),
			true,
		);
		expect(checked).toBeNull();
	});
});
