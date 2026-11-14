/**
 * Issue #3681 (round 19) — the two residuals the round-18 gate ladder found
 * in the round-16/18 raw-path remediation, each closed with a leg that kills
 * its own mutation.
 *
 *  - `resolveValidatedDiffBase` memoizes its envelope per directory+HEAD and
 *    the memo is cleared only at the top of `runPreCheckBatch`. Threading the
 *    committed-hop collector as a PARAMETER left it empty on every memo hit —
 *    a repeat direct call, an ambiguity-consumer-first ordering, or a second
 *    concurrent batch — so a file changed only in the committed hop lost its
 *    filter mark and its findings classified PRE-EXISTING (executed: first
 *    call `[-1]`, second call `[2]`). The resolver now OWNS the map, stores it
 *    on the resolution, and the consumer merges it.
 *  - `git diff` appends a trailing TAB to a `--- `/`+++ ` header whenever the
 *    filename contains a space, and it does so for a C-QUOTED path too —
 *    after the closing quote (executed: `+++ "a \tb.ts"` + U+0009). Both
 *    `rawHeaderPath` and `normalizeDiffPath` guarded `startsWith('"')` as
 *    mutually exclusive with the trailing TAB, so a quoted space-bearing path
 *    kept it, matched no `.gitattributes` rule, and kept its shifted
 *    coordinates. Splitting on the literal TAB is safe in both shapes because
 *    git C-quoting escapes a real TAB inside the name as the two characters
 *    `\t` — a literal TAB can therefore never appear inside the quotes.
 */

import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import {
	classifySastFindings,
	getChangedLineAmbiguousFiles,
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

describe('filter detection through the resolver memo (#3681 round 19)', () => {
	test('a second call on the same HEAD keeps the committed-hop filter mark', async () => {
		// `resolveValidatedDiffBase` memoizes its envelope per
		// directory+HEAD and the memo is cleared only at the top of
		// runPreCheckBatch. Threading the committed-hop collector as a
		// PARAMETER left it empty on every memo hit — a repeat direct call, an
		// ambiguity-consumer-first ordering, or a second concurrent batch —
		// so the filter mark was lost and the finding classified PRE-EXISTING
		// (round-19 finding, executed: first call [-1], second call [2]). The
		// resolver now OWNS the map and stores it on the resolution, and the
		// consumer merges it, so both orderings hold.
		const directory = canonicalMkdtemp('git-shapes-3681e-memo-');
		const finding = sastFinding(path.join(directory, 'src/app.ts'), 3);
		try {
			git(directory, 'init', '-q', '-b', 'main');
			git(directory, 'config', 'user.email', 'test@example.com');
			git(directory, 'config', 'user.name', 'Test');
			git(directory, 'config', 'core.autocrlf', 'false');
			write(directory, '.gitattributes', '*.ts filter=squeeze\n');
			git(directory, 'config', 'filter.squeeze.clean', 'sed 1d');
			git(directory, 'config', 'filter.squeeze.smudge', 'cat');
			write(directory, 'seed.ts', 'export const z = 0;\n');
			git(directory, 'add', '-A');
			git(directory, 'commit', '-q', '-m', 'base');
			git(directory, 'checkout', '-q', '-b', 'feature');
			// Committed-only change: the file never reaches the staged,
			// unstaged or untracked collectors.
			write(
				directory,
				'src/app.ts',
				'export const a = 1;\nexport const b = 2;\nexport const C = 3;\n',
			);
			git(directory, 'add', '-A');
			git(directory, 'commit', '-q', '-m', 'committed-only');

			// The ambiguity consumer first, so the memo is filled by a caller
			// that supplies no collector at all.
			await getChangedLineAmbiguousFiles(directory);

			const first = await getChangedLineRanges(directory, undefined, []);
			const second = await getChangedLineRanges(directory, undefined, []);
			expect(first).not.toBeNull();
			expect(second).not.toBeNull();
			expect([...(first?.get('src/app.ts') ?? [])]).toEqual([
				ALL_LINES_CHANGED,
			]);
			expect([...(second?.get('src/app.ts') ?? [])]).toEqual([
				ALL_LINES_CHANGED,
			]);
			for (const ranges of [first, second]) {
				const classified = classifySastFindings([finding], ranges, directory);
				expect(classified.newFindings).toHaveLength(1);
				expect(classified.preexistingFindings).toHaveLength(0);
			}
		} finally {
			removeTreeWithRetry(directory);
		}
	}, 30_000);
});

describe('filter detection for C-quoted space-bearing paths (#3681 round 19)', () => {
	test('a quoted path containing a space is queried without the trailing TAB', async () => {
		// `git diff` appends a trailing TAB to an unquoted `+++ ` header when
		// the filename contains a space, AND to a C-QUOTED one — after the
		// closing quote (executed: `+++ "q \"sp ace\".ts"` + U+0009). Both
		// `rawHeaderPath` and `normalizeDiffPath` treated `startsWith('"')` as
		// mutually exclusive with the trailing TAB, so the quoted spelling kept
		// it, `check-attr` was asked about a path matching no rule, and the
		// shifted coordinates survived (round-19 finding, executed). Windows
		// refuses `"` in a filename, so the entry is created through the index
		// with `core.protectNTFS=false` — the same technique as the round-16
		// quote-leading leg.
		const directory = canonicalMkdtemp('git-shapes-3681e-qspace-');
		const NAME = 'q "sp ace".ts';
		try {
			git(directory, 'init', '-q', '-b', 'main');
			git(directory, 'config', 'user.email', 'test@example.com');
			git(directory, 'config', 'user.name', 'Test');
			git(directory, 'config', 'core.autocrlf', 'false');
			git(directory, 'config', 'core.protectNTFS', 'false');
			write(directory, '.gitattributes', '*.ts filter=squeeze\n');
			git(directory, 'config', 'filter.squeeze.clean', 'sed 1d');
			git(directory, 'config', 'filter.squeeze.smudge', 'cat');
			write(directory, 'seed.ts', 'export const z = 0;\n');
			git(directory, 'add', '-A');
			git(directory, 'commit', '-q', '-m', 'base');
			git(directory, 'checkout', '-q', '-b', 'feature');

			const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], {
				cwd: directory,
				input: 'export const a = 1;\nexport const b = 2;\n',
				encoding: 'utf8',
			}).trim();
			git(
				directory,
				'update-index',
				'--add',
				'--cacheinfo',
				`100644,${blob},${NAME}`,
			);
			git(directory, 'commit', '-q', '-m', 'quoted space name');

			const ranges = await getChangedLineRanges(directory, undefined, []);
			expect(ranges).not.toBeNull();
			// The map key is the decoded path with the trailing TAB removed, on
			// BOTH sides of the lookup.
			expect([...(ranges?.get(NAME) ?? [])]).toEqual([ALL_LINES_CHANGED]);

			const classified = classifySastFindings(
				[sastFinding(path.join(directory, NAME), 2)],
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
