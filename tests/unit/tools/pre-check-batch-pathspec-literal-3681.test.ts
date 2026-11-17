/**
 * Issue #3681 item 2 — the ranges consumer must apply the same
 * `:(literal)` pathspec guard as the ambiguity consumer (#3092 PRR-005).
 *
 * Prior buggy behavior (frozen acceptance probe C3, R2 over-match):
 * getChangedLineRanges built PLAIN pathspecs for requested files, so Git
 * glob-expanded metacharacter filenames — requesting `app/a[b].ts` also
 * admitted the untracked sibling `app/ab.ts`, whose findings then read as
 * NEW without the caller ever requesting that file.
 *
 * RED at base: the changed-line map contains app/ab.ts.
 * GREEN after the fix: the map has only app/a[b].ts -> {2}.
 */

import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { getChangedLineRanges } from '../../../src/tools/pre-check-batch.js';
import {
	canonicalMkdtemp,
	canonicalTmpDir,
	removeTreeWithRetry,
} from '../../helpers/tmpdir.js';

// FB-014: the fixture must never inherit the host's global git config. A
// `commit.gpgsign=true` with no reachable `gpg.program` fails every `git
// commit` here (executed: 5/5 legs in pre-check-batch-git-config-shapes-3681d
// and 1/1 in pre-check-batch-pathspec-literal-3681), and GitHub runners carry
// no identity of their own by design. Pointing GIT_CONFIG_GLOBAL at an EMPTY
// file isolates every global key — gpgsign, signing format, hooks, templates
// — rather than patching the one key that was observed, and the local config
// these fixtures set themselves still applies. The file lives in the OS temp
// dir, NOT inside the repository: a stray file in the repo would change the
// very `git status` / diff output these fixtures assert on, and `.git` is a
// FILE rather than a directory in a submodule or linked worktree.
const isolatedGlobalConfigPaths = new Map<string, string>();
let isolatedGlobalConfigCounter = 0;
function isolatedGlobalConfig(cwd: string): string {
	const existing = isolatedGlobalConfigPaths.get(cwd);
	if (existing !== undefined) return existing;
	isolatedGlobalConfigCounter += 1;
	const target = path.join(
		canonicalTmpDir(),
		`swarm-fixture-global-config-${process.pid}-${isolatedGlobalConfigCounter}`,
	);
	writeFileSync(target, '');
	isolatedGlobalConfigPaths.set(cwd, target);
	return target;
}

function git(cwd: string, ...args: string[]): void {
	execFileSync('git', args, {
		cwd,
		stdio: ['ignore', 'ignore', 'pipe'],
		timeout: 10_000,
		windowsHide: true,
		env: {
			...process.env,
			GIT_CONFIG_NOSYSTEM: '1',
			GIT_CONFIG_GLOBAL: isolatedGlobalConfig(cwd),
		},
	});
}

function write(root: string, file: string, content: string): void {
	const target = path.join(root, file);
	mkdirSync(path.dirname(target), { recursive: true });
	writeFileSync(target, content);
}

describe('getChangedLineRanges — :(literal) pathspec parity for metacharacter filenames (#3681, C3)', () => {
	test('requesting app/a[b].ts does not glob-admit the untracked sibling app/ab.ts', async () => {
		const repo = canonicalMkdtemp('pcb-pathspec-3681-');
		try {
			git(repo, 'init', '-q', '-b', 'main');
			git(repo, 'config', 'user.email', 'test@example.com');
			git(repo, 'config', 'user.name', 'Test');
			git(repo, 'config', 'core.autocrlf', 'false');
			write(repo, 'app/a[b].ts', 'l1\nl2\nl3\nl4\nl5\n');
			git(repo, 'add', 'app/a[b].ts');
			git(repo, 'commit', '-q', '-m', 'base');
			// Unstaged edit on line 2 of the requested file (the diff leg
			// carries no pathspec — it contributes the real change).
			write(repo, 'app/a[b].ts', 'l1\nl2 edited\nl3\nl4\nl5\n');
			// Untracked glob sibling — a plain `app/a[b].ts` status
			// pathspec glob-matches this name (bracket expression `[b]`
			// matches the literal `b`); the literal decoration must not.
			write(repo, 'app/ab.ts', 'sibling\n');

			const requested = path.join(repo, 'app', 'a[b].ts');
			const map = await getChangedLineRanges(repo, undefined, [requested]);
			expect(map).not.toBeNull();
			// The over-match is the regression: the unrequested sibling
			// entered the map as ALL_LINES_CHANGED.
			expect(map?.has('app/ab.ts')).toBe(false);
			const lines = [...(map?.get('app/a[b].ts') ?? [])].sort(
				(left, right) => left - right,
			);
			expect(lines.join(',')).toBe('2');
		} finally {
			try {
				removeTreeWithRetry(repo);
			} catch {
				// Windows EBUSY-class teardown noise must not fail the leg.
			}
		}
	}, 120_000);
});
