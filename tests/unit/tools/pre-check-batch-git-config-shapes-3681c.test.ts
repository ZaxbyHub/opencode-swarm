/**
 * Issue #3681 (round 15) — the two fail-open bypasses the round-14
 * `git check-attr filter` leg still admitted, plus the inverted `/dev/null`
 * exemption in the `+++ ` phantom-destination guard. Each was found by an
 * executed real-git probe in the round-15 gate ladder and is pinned here.
 *
 *  - A filter driver literally named `unspecified`, `unset` or `set`: git
 *    permits and EXECUTES such a driver, so the attribute's VALUE cannot be
 *    read as a "no driver" sentinel. The leg now uses
 *    `check-attr --all -z`, which emits a record only for attributes that are
 *    actually set.
 *  - The leg queried the caller's `requestedFiles` instead of the changed-line
 *    map's own keys, so a caller passing a DIRECTORY (`files: ['src']`) — which
 *    `git check-attr` reports as the directory rather than expanding — or
 *    passing nothing at all never had its filters detected.
 *  - `diff --git <file> /dev/null` is a DELETED-file header. Exempting that
 *    shape from the phantom-destination guard let
 *    `diff --git src/real.ts /dev/null` + `+++ src/phantom.ts` through; the
 *    new-file shape puts `/dev/null` on the SOURCE side, where the header
 *    destination already matches the `+++ ` and no exemption is needed.
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

describe('reserved-word filter drivers (#3681 round 15)', () => {
	// Git permits — and EXECUTES — a filter driver literally named
	// `unspecified`, `unset` or `set`, so the attribute's value cannot be
	// interpreted as a "no driver" sentinel. A parametrized real-git probe in
	// the round-15 plan-critic round showed all three reserved names shift hunk
	// coordinates exactly like an ordinary driver.
	for (const driver of ['unspecified', 'unset', 'set', 'squeeze'] as const) {
		test(`a filter driver literally named \`${driver}\` marks the file ALL_LINES_CHANGED`, async () => {
			const directory = canonicalMkdtemp('git-shapes-3681c-drv-');
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
				write(directory, '.gitattributes', `src/app.ts filter=${driver}\n`);
				git(directory, 'config', `filter.${driver}.clean`, 'sed 1d');
				git(directory, 'config', `filter.${driver}.smudge`, 'cat');
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
	}
});

describe('the filter leg queries the map keys, not requestedFiles (#3681 round 15)', () => {
	test('a directory request and an empty request still detect the filter', async () => {
		const directory = canonicalMkdtemp('git-shapes-3681c-req-');
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

			for (const requested of [
				[path.join(directory, 'src')],
				[],
				[path.join(directory, 'src', 'app.ts')],
			]) {
				const ranges = await getChangedLineRanges(
					directory,
					undefined,
					requested,
				);
				expect(ranges).not.toBeNull();
				expect([...(ranges?.get('src/app.ts') ?? [])]).toEqual([
					ALL_LINES_CHANGED,
				]);
			}
		} finally {
			removeTreeWithRetry(directory);
		}
	}, 60_000);
});

describe('the +++ phantom guard has no /dev/null exemption (#3681 round 15)', () => {
	test('a deleted-file header cannot launder a phantom +++ destination', () => {
		const checked = preCheckBatchInternals.parseDiffLineRangesChecked(
			[
				'diff --git src/real.ts /dev/null',
				'--- src/real.ts',
				'+++ src/phantom.ts',
				'@@ -1,0 +1,1 @@',
				'+evil',
			].join('\n'),
			true,
		);
		expect(checked).toBeNull();
	});

	test('a real deleted-file section still consumes without a key', () => {
		const checked = preCheckBatchInternals.parseDiffLineRangesChecked(
			[
				'diff --git src/real.ts /dev/null',
				'deleted file mode 100644',
				'index 54b82a0..0000000',
				'Binary files src/real.ts and /dev/null differ',
			].join('\n'),
			true,
		);
		expect(checked).not.toBeNull();
		expect(checked?.size).toBe(0);
	});

	test('a new file whose header source is /dev/null still parses', () => {
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
});
