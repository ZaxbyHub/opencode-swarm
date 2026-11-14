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
 *    argv is now chunked.
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

describe('filter leg argv chunking (#3681 round 16)', () => {
	test('a changeset larger than one chunk keeps the whole map', async () => {
		// Every map key used to go on the command line; past roughly 550 changed
		// files on Windows this exceeds the 32767-character limit, `runGit`
		// returns null, and the whole map is nulled — an availability regression
		// against main (round-16 finding, executed: 600 keys -> ENAMETOOLONG ->
		// null). 250 files is enough to exercise several chunks without making
		// the leg slow.
		const directory = canonicalMkdtemp('git-shapes-3681d-many-');
		const requested: string[] = [];
		try {
			git(directory, 'init', '-q', '-b', 'main');
			git(directory, 'config', 'user.email', 'test@example.com');
			git(directory, 'config', 'user.name', 'Test');
			git(directory, 'config', 'core.autocrlf', 'false');
			for (let index = 0; index < 250; index++) {
				const file = `src/f${String(index).padStart(4, '0')}.ts`;
				write(directory, file, 'export const a = 1;\n');
				requested.push(path.join(directory, file));
			}
			git(directory, 'add', '-A');
			git(directory, 'commit', '-q', '-m', 'base');
			for (let index = 0; index < 250; index++) {
				write(
					directory,
					`src/f${String(index).padStart(4, '0')}.ts`,
					'export const a = 2;\n',
				);
			}
			git(directory, 'add', '-A');

			const ranges = await getChangedLineRanges(
				directory,
				undefined,
				requested,
			);
			expect(ranges).not.toBeNull();
			expect(ranges?.size).toBe(250);
			// Spot-check one file's precise line numbers, proving the map is not
			// blanket-marked.
			expect([...(ranges?.get('src/f0000.ts') ?? [])]).toEqual([1]);
		} finally {
			removeTreeWithRetry(directory);
		}
	}, 120_000);
});
