/**
 * Issue #3681 (round 16) — the three bypasses the round-15
 * `git check-attr --all -z` filter leg still admitted, each found by an
 * executed real-git probe in the round-16 gate ladder.
 *
 *  - The map keys are lowercased on win32/darwin by `normalizeRepoPathKey`,
 *    but `.gitattributes` matching is case-sensitive whenever
 *    `core.ignoreCase` is false (git's default on a case-sensitive macOS
 *    volume), so a lowercased query can miss a mixed-case file's `filter=`
 *    rule entirely. The leg now queries the RAW repo-relative spellings git
 *    emitted, collected alongside the normalized keys.
 *  - Under `-z`, git writes paths RAW. Running them through the C-quote
 *    decoder made a path starting with `"` decode to null (and be silently
 *    skipped) or lose its literal quotes. The decoder is no longer applied.
 *  - Every map key went on the command line, so a very large changeset
 *    exceeded the Windows 32767-character limit, `runGit` returned null, and
 *    the WHOLE map was nulled — an availability regression against main. The
 *    argv is now chunked (round 16), and the chunk bound is the accumulated
 *    argv LENGTH rather than a fixed per-chunk path count (round 17).
 */

import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import {
	classifySastFindings,
	getChangedLineRanges,
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

describe('filter detection under core.ignoreCase=false (#3681 round 16)', () => {
	test('a mixed-case path with an exact-case .gitattributes rule is still detected', async () => {
		// The map key is lowercased on win32/darwin, and `.gitattributes`
		// matching is case-sensitive when `core.ignoreCase` is false — git's
		// default on a case-sensitive macOS volume. Querying the lowercased key
		// returned nothing, so the clean filter shifted hunk coordinates and
		// the source-line finding classified PRE-EXISTING (round-16 finding,
		// executed).
		const directory = canonicalMkdtemp('git-shapes-3681d-ic-');
		try {
			git(directory, 'init', '-q', '-b', 'main');
			git(directory, 'config', 'user.email', 'test@example.com');
			git(directory, 'config', 'user.name', 'Test');
			git(directory, 'config', 'core.autocrlf', 'false');
			git(directory, 'config', 'core.ignoreCase', 'false');
			write(
				directory,
				'Src/App.ts',
				'export const a = 1;\nexport const b = 2;\nexport const c = 3;\n',
			);
			git(directory, 'add', '-A');
			git(directory, 'commit', '-q', '-m', 'base');
			write(directory, '.gitattributes', 'Src/App.ts filter=squeeze\n');
			git(directory, 'config', 'filter.squeeze.clean', 'sed 1d');
			git(directory, 'config', 'filter.squeeze.smudge', 'cat');
			write(
				directory,
				'Src/App.ts',
				'export const a = 1;\nexport const b = 2;\nexport const C = 3;\n',
			);
			git(directory, 'add', '-A');

			const ranges = await getChangedLineRanges(directory, undefined, [
				path.join(directory, 'Src', 'App.ts'),
			]);
			expect(ranges).not.toBeNull();
			// The map key stays lowercased (that is what the classifier looks
			// up), but it must carry the sentinel.
			expect([...(ranges?.get('src/app.ts') ?? [])]).toEqual([
				ALL_LINES_CHANGED,
			]);

			const classified = classifySastFindings(
				[sastFinding(path.join(directory, 'Src', 'App.ts'), 3)],
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

describe('filter detection for quote-leading paths (#3681 round 16)', () => {
	test('a path beginning with a double quote is still detected', async () => {
		// Under `-z`, git writes paths RAW — `"leading.ts`, not `"\"leading.ts"`.
		// Running the raw record through the C-quote decoder returned null for a
		// path that starts with `"`, so the file was silently skipped and its
		// shifted coordinates survived. Windows refuses `"` in a filename, so
		// the entry is created through the index with `core.protectNTFS=false`
		// (which is also how the round-16 gates proved it).
		const directory = canonicalMkdtemp('git-shapes-3681d-q-');
		try {
			git(directory, 'init', '-q', '-b', 'main');
			git(directory, 'config', 'user.email', 'test@example.com');
			git(directory, 'config', 'user.name', 'Test');
			git(directory, 'config', 'core.autocrlf', 'false');
			git(directory, 'config', 'core.protectNTFS', 'false');
			write(directory, 'plain.ts', 'export const a = 1;\n');
			git(directory, 'add', 'plain.ts');
			git(directory, 'commit', '-q', '-m', 'base');
			write(directory, '.gitattributes', '*.ts filter=squeeze\n');
			git(directory, 'config', 'filter.squeeze.clean', 'sed 1d');
			git(directory, 'config', 'filter.squeeze.smudge', 'cat');
			write(
				directory,
				'payload.ts',
				'export const a = 1;\nexport const B = 2;\n',
			);
			const blob = execFileSync('git', ['hash-object', '-w', 'payload.ts'], {
				cwd: directory,
				encoding: 'utf8',
			}).trim();
			git(
				directory,
				'update-index',
				'--add',
				'--cacheinfo',
				`100644,${blob},"leading.ts`,
			);
			write(
				directory,
				'plain.ts',
				'export const a = 1;\nexport const B = 2;\n',
			);
			git(directory, 'add', 'plain.ts');

			const ranges = await getChangedLineRanges(directory, undefined, [
				path.join(directory, 'plain.ts'),
				path.join(directory, '"leading.ts'),
			]);
			expect(ranges).not.toBeNull();
			expect([...(ranges?.get('"leading.ts') ?? [])]).toEqual([
				ALL_LINES_CHANGED,
			]);
			expect([...(ranges?.get('plain.ts') ?? [])]).toEqual([ALL_LINES_CHANGED]);
		} finally {
			removeTreeWithRetry(directory);
		}
	}, 30_000);
});

describe('filter leg argv chunking (#3681 rounds 16 and 17)', () => {
	test('a changeset whose argv exceeds the Windows command-line limit keeps the whole map', async () => {
		// Round 16 chunked the argv. Round 17 replaced the fixed per-chunk path
		// COUNT with an accumulated-LENGTH bound, because a single path may
		// legally be several kilobytes (Linux allows 4096 bytes per component)
		// and a count cannot bound the command line — the round-16 leg could not
		// tell the two apart, so it pinned neither (self-review finding,
		// executed: 250 short paths total ~3.2 KB of argv and fit one chunk, so
		// removing the chunking entirely left the leg green).
		//
		// This fixture is built so BOTH shapes die: 100 paths of ~405 bytes each
		// is ~40 KB of argv, which exceeds the 32767-character CreateProcess
		// limit whether it goes out in ONE call or in one fixed 100-path chunk.
		// Only the length bound survives (100 / 39-per-chunk = 3 calls).
		//
		// The paths live only in the index — Windows refuses a 405-character path
		// on disk — exactly as the round-16 quote-leading leg does. `git
		// check-attr` is a pure `.gitattributes` lookup, so it answers for a path
		// with no worktree file (executed probe).
		const directory = canonicalMkdtemp('git-shapes-3681d-long-');
		const FILE_COUNT = 100;
		const SEGMENTS = 7;
		const SEGMENT = 'a'.repeat(55);
		const longPath = (index: number): string =>
			[
				...Array.from(
					{ length: SEGMENTS },
					(_, segment) => `${SEGMENT}${segment}`,
				),
				`f${index}.ts`,
			].join('/');
		try {
			git(directory, 'init', '-q', '-b', 'main');
			git(directory, 'config', 'user.email', 'test@example.com');
			git(directory, 'config', 'user.name', 'Test');
			git(directory, 'config', 'core.autocrlf', 'false');
			// Committed in the BASE so the rule itself is not a changed file and
			// the map size stays exactly FILE_COUNT.
			write(directory, '.gitattributes', '*.ts filter=squeeze\n');
			git(directory, 'config', 'filter.squeeze.clean', 'sed 1d');
			git(directory, 'config', 'filter.squeeze.smudge', 'cat');
			git(directory, 'add', '.gitattributes');
			git(directory, 'commit', '-q', '-m', 'attrs');
			// The changed files must sit on a branch AHEAD of `main`, otherwise
			// `merge-base main HEAD` is HEAD itself and the committed hop is
			// empty (the round-18 rawPaths threading would go unpinned too).
			git(directory, 'checkout', '-q', '-b', 'feature');

			// `hash-object -w --stdin` deliberately takes no `--path`, so no
			// clean filter runs and the blob is the literal worktree bytes.
			const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], {
				cwd: directory,
				input: 'export const a = 1;\nexport const b = 2;\n',
				encoding: 'utf8',
			}).trim();
			for (let index = 0; index < FILE_COUNT; index++) {
				git(
					directory,
					'update-index',
					'--add',
					'--cacheinfo',
					`100644,${blob},${longPath(index)}`,
				);
			}
			git(directory, 'commit', '-q', '-m', 'many long paths');

			const ranges = await getChangedLineRanges(directory, undefined, []);
			expect(ranges).not.toBeNull();
			expect(ranges?.size).toBe(FILE_COUNT);
			// Every one of them matches `*.ts filter=squeeze`, so the clean
			// filter shifted every coordinate and every file must carry the
			// sentinel. Spot-check the first, a middle, and the last: a partial
			// chunking bug would leave the tail unmarked.
			for (const index of [0, 49, 99]) {
				expect([...(ranges?.get(longPath(index).toLowerCase()) ?? [])]).toEqual(
					[ALL_LINES_CHANGED],
				);
			}
		} finally {
			removeTreeWithRetry(directory);
		}
	}, 180_000);
});

describe('filter detection for space-bearing paths (#3681 round 18)', () => {
	test('a path containing a space is queried without the trailing TAB git appends', async () => {
		// `git diff` appends a TAB to an UNQUOTED `--- `/`+++ ` header whenever
		// the filename contains a space (executed probe:
		// `+++ my app.ts` + U+0009). `normalizeDiffPath` strips it for the map
		// key, but the raw spelling kept it, so `check-attr` was asked about
		// `my app.ts\t` — a path that matches no `.gitattributes` rule, because
		// the name no longer ends in `.ts`. The clean filter's shifted
		// coordinates survived and the source-line finding classified
		// PRE-EXISTING (round-18 finding, executed).
		const directory = canonicalMkdtemp('git-shapes-3681d-space-');
		try {
			git(directory, 'init', '-q', '-b', 'main');
			git(directory, 'config', 'user.email', 'test@example.com');
			git(directory, 'config', 'user.name', 'Test');
			git(directory, 'config', 'core.autocrlf', 'false');
			write(directory, '.gitattributes', '*.ts filter=squeeze\n');
			git(directory, 'config', 'filter.squeeze.clean', 'sed 1d');
			git(directory, 'config', 'filter.squeeze.smudge', 'cat');
			write(
				directory,
				'my app.ts',
				'export const a = 1;\nexport const b = 2;\n',
			);
			git(directory, 'add', '-A');
			git(directory, 'commit', '-q', '-m', 'base');
			git(directory, 'checkout', '-q', '-b', 'feature');
			write(
				directory,
				'my app.ts',
				'export const a = 1;\nexport const B = 2;\n',
			);
			git(directory, 'add', '-A');

			const ranges = await getChangedLineRanges(directory, undefined, []);
			expect(ranges).not.toBeNull();
			expect([...(ranges?.get('my app.ts') ?? [])]).toEqual([
				ALL_LINES_CHANGED,
			]);

			const classified = classifySastFindings(
				[sastFinding(path.join(directory, 'my app.ts'), 2)],
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

describe('filter detection when two spellings share one map key (#3681 round 18)', () => {
	test('every raw spelling for a key is queried, not just the last one written', async () => {
		// `normalizeRepoPathKey` lowercases on win32/darwin, so the two distinct
		// index entries git emits in the order `FOO.ts` then `Foo.ts` collapse to
		// ONE map key. A `Map<string, string>` kept only the LAST spelling
		// written (`Foo.ts`), so a `.gitattributes` rule on `FOO.ts` was never
		// queried and that file's clean filter kept its shifted coordinates
		// (round-18 finding, executed). A set keeps every spelling, so
		// `check-attr` is asked about both. Windows cannot hold both names on
		// disk, so both entries are created through the index.
		const directory = canonicalMkdtemp('git-shapes-3681d-case-');
		try {
			git(directory, 'init', '-q', '-b', 'main');
			git(directory, 'config', 'user.email', 'test@example.com');
			git(directory, 'config', 'user.name', 'Test');
			git(directory, 'config', 'core.autocrlf', 'false');
			git(directory, 'config', 'core.ignoreCase', 'false');
			// The rule names the FIRST spelling git emits, which is the one a
			// last-write-wins collector would drop.
			write(directory, '.gitattributes', 'FOO.ts filter=squeeze\n');
			git(directory, 'config', 'filter.squeeze.clean', 'sed 1d');
			git(directory, 'config', 'filter.squeeze.smudge', 'cat');
			git(directory, 'add', '.gitattributes');
			git(directory, 'commit', '-q', '-m', 'attrs');
			git(directory, 'checkout', '-q', '-b', 'feature');

			const before = execFileSync('git', ['hash-object', '-w', '--stdin'], {
				cwd: directory,
				input: 'export const a = 1;\nexport const b = 2;\n',
				encoding: 'utf8',
			}).trim();
			const after = execFileSync('git', ['hash-object', '-w', '--stdin'], {
				cwd: directory,
				input: 'export const a = 1;\nexport const B = 2;\n',
				encoding: 'utf8',
			}).trim();
			for (const spelling of ['FOO.ts', 'Foo.ts']) {
				git(
					directory,
					'update-index',
					'--add',
					'--cacheinfo',
					`100644,${before},${spelling}`,
				);
			}
			git(directory, 'commit', '-q', '-m', 'both spellings');
			for (const spelling of ['FOO.ts', 'Foo.ts']) {
				git(
					directory,
					'update-index',
					'--add',
					'--cacheinfo',
					`100644,${after},${spelling}`,
				);
			}
			git(directory, 'commit', '-q', '-m', 'changed');

			const ranges = await getChangedLineRanges(directory, undefined, []);
			expect(ranges).not.toBeNull();
			// Both spellings share this one key, and the rule on `FOO.ts` must
			// reach it.
			expect([...(ranges?.get('foo.ts') ?? [])]).toEqual([ALL_LINES_CHANGED]);

			const classified = classifySastFindings(
				[sastFinding(path.join(directory, 'FOO.ts'), 2)],
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
