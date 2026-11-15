/**
 * #3700 — both diff-base consumers must key their results in the COORDINATE
 * SYSTEM OF THE PASSED DIRECTORY, not of the repository root, when the
 * directory is a nested independent root (`nested/` carrying its own
 * `.opencode/` marker — the #2127 working-directory policy's notion of an
 * explicit local root).
 *
 * Git emits repo-ROOT-relative paths from every command it runs with cwd
 * inside a subdirectory (executed: `git -C nested diff`, `git -C nested diff
 * --name-only`, and `git -C nested status --porcelain` all spell the file
 * `nested/src/app.ts`), so at the current code:
 *
 *   - `getChangedLineRanges(<nested>)` keys the map `nested/src/app.ts`,
 *   - `getChangedLineAmbiguousFiles(<nested>)` keys the set
 *     `nested/src/app.ts`,
 *
 * while `classifySastFindings`/`classifySecretFindings` with
 * `directory=<nested>` look the finding up as `src/app.ts`
 * (path.relative(nested, nested/src/app.ts)) — the lookup misses and a
 * finding on a genuinely changed line classifies PRE-EXISTING (fail-open).
 *
 * Both surfaces must agree on the classifier's coordinate system after the
 * fix: the ranges map keys AND the ambiguity set entries must be usable
 * directly by the same classifier lookup.
 *
 * Critic amendments C7/C8 add: a staged-only leg, an untracked-record +
 * coordinate-parity leg, a repo-root control (the migration must be a no-op
 * at directory==repo-root), and a cross-prefix rename leg (a file renamed
 * INTO the nested root; its paired outside-prefix source record must drop
 * WITH its pair, not corrupt the -z porcelain record stream).
 *
 * Isolation note: the resolver memo is module-global but keyed by directory,
 * so every test() below builds its OWN fresh fixture directory — no test can
 * inherit another's envelope.
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
import {
	canonicalMkdtemp,
	canonicalTmpDir,
	removeTreeWithRetry,
} from '../../helpers/tmpdir.js';

// FB-014: isolate the host's global git config (see
// pre-check-batch-git-config-shapes-3681b.test.ts for the executed evidence).
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

function git(cwd: string, ...args: string[]): string {
	return execFileSync('git', args, {
		cwd,
		stdio: ['ignore', 'pipe', 'pipe'],
		encoding: 'utf-8',
		timeout: 20_000,
		windowsHide: true,
		env: {
			...process.env,
			GIT_CONFIG_NOSYSTEM: '1',
			GIT_CONFIG_GLOBAL: isolatedGlobalConfig(cwd),
		},
	});
}

const IDENTITY = [
	'-c',
	'user.email=test@example.com',
	'-c',
	'user.name=Test',
] as const;

function write(root: string, file: string, content: string): void {
	const target = path.join(root, file);
	mkdirSync(path.dirname(target), { recursive: true });
	writeFileSync(target, content);
}

function sastFinding(file: string, line: number) {
	return {
		rule_id: 'probe',
		severity: 'low' as const,
		message: 'probe',
		location: { file, line },
	};
}

const APP_BASE =
	'export const a = 1;\nexport const b = 2;\nexport const c = 3;\n';

/**
 * Fresh fixture per leg: repo + bare `zaxbyhub` remote whose main sits at the
 * BASE commit, so the committed hop for every later HEAD is non-empty. The
 * nested independent root carries the `.opencode/` marker (#2127) plus
 * `nested/src/app.ts`; `withOutsideFile` also commits a root-level file for
 * the cross-prefix rename leg.
 */
function buildNestedFixture(
	prefix: string,
	options: { withOutsideFile?: boolean } = {},
): { root: string; repo: string; nested: string } {
	const root = canonicalMkdtemp(prefix);
	const repo = path.join(root, 'repo');
	const nested = path.join(repo, 'nested');
	const bare = path.join(root, 'zaxbyhub.git');
	git(root, 'init', '-q', '-b', 'main', repo);
	git(root, 'init', '-q', '--bare', '-b', 'main', bare);
	git(repo, 'remote', 'add', 'zaxbyhub', bare);
	git(repo, 'config', 'core.autocrlf', 'false');
	write(repo, 'nested/.opencode/marker.txt', '');
	write(repo, 'nested/src/app.ts', APP_BASE);
	if (options.withOutsideFile) {
		write(repo, 'outside.ts', 'export const outside = true;\n');
	}
	git(repo, 'add', '-A');
	git(repo, ...IDENTITY, 'commit', '-q', '-m', 'base');
	git(repo, 'push', '-q', 'zaxbyhub', 'main');
	return { root, repo, nested };
}

describe('nested-root coordinate system for both diff-base consumers (#3700)', () => {
	test('ranges and ambiguity surfaces key files relative to the passed nested root, so the classifier finds them', async () => {
		const { root, repo, nested } = buildNestedFixture(
			'pre-check-nested-root-3700-',
		);
		try {
			// Committed edit: nested/src/app.ts line 3 (zaxbyhub/main stays at
			// base, so the committed hop contains this edit).
			write(
				repo,
				'nested/src/app.ts',
				'export const a = 1;\nexport const b = 2;\nexport const C = 3;\n',
			);
			git(repo, 'add', '-A');
			git(repo, ...IDENTITY, 'commit', '-q', '-m', 'edit');

			// Worktree edit on the SAME file (line 1) so the file is genuinely
			// multi-hop: committed hop + unstaged hop => ambiguous.
			write(
				repo,
				'nested/src/app.ts',
				'export const A = 1;\nexport const b = 2;\nexport const C = 3;\n',
			);

			// (c) C7 repo-root control on the SAME fixture, run FIRST so it
			// executes even while the nested legs below are RED: at
			// directory==repo-root the answer must stay root-relative — keys
			// like `nested/src/app.ts`, and a finding at nested/src/app.ts:3
			// classifies NEW via the root map. GREEN at the current code (the
			// root map is already in root coordinates); the nested migration
			// must be a NO-OP here. (The resolver memo is keyed by directory,
			// so the root call and the nested call below resolve
			// independently.)
			const rootRanges = await getChangedLineRanges(repo);
			expect(rootRanges).not.toBeNull();
			expect([...(rootRanges?.get('nested/src/app.ts') ?? [])]).toContain(3);
			const rootClassified = classifySastFindings(
				[sastFinding('nested/src/app.ts', 3)],
				rootRanges,
				repo,
			);
			expect(rootClassified.newFindings).toHaveLength(1);
			expect(rootClassified.preexistingFindings).toHaveLength(0);

			// (a) The ranges consumer: the map keys must be in the classifier's
			// coordinate system for directory=<nested>, so a finding at
			// src/app.ts:3 classifies NEW. RED at the current code: the map is
			// keyed `nested/src/app.ts` (git's repo-root spelling), the
			// classifier looks up `src/app.ts`, the lookup misses, and the
			// finding classifies PRE-EXISTING.
			const ranges = await getChangedLineRanges(nested);
			expect(ranges).not.toBeNull();
			const classified = classifySastFindings(
				[sastFinding('src/app.ts', 3)],
				ranges,
				nested,
			);
			expect(classified.newFindings).toHaveLength(1);
			expect(classified.preexistingFindings).toHaveLength(0);

			// (b) status.relativePaths parity: the ambiguity consumer must key
			// the SAME file the SAME way — the entry the classifier's ambiguous
			// lookup (`classifySecretFindings` normalizes the finding path
			// against directory=<nested> to `src/app.ts`) needs is `src/app.ts`.
			// RED at the current code: the set carries git's repo-root spelling
			// `nested/src/app.ts`.
			const ambiguous = await getChangedLineAmbiguousFiles(nested);
			expect(ambiguous).not.toBeNull();
			expect(ambiguous?.has('src/app.ts')).toBe(true);
		} finally {
			removeTreeWithRetry(root);
		}
	}, 60_000);

	// C7: the staged leg (`git diff --cached HEAD` run with cwd=<nested>) must
	// equally land in nested coordinates.
	test('C7: a staged-only nested edit classifies its finding NEW through the staged leg', async () => {
		const { root, repo, nested } = buildNestedFixture(
			'pre-check-nested-staged-3700-',
		);
		try {
			// Stage a line-2 edit WITHOUT committing: the committed hop is
			// HEAD-equal (empty) and the staged leg is the only changed line
			// source.
			write(
				repo,
				'nested/src/app.ts',
				'export const a = 1;\nexport const B = 2;\nexport const c = 3;\n',
			);
			git(repo, 'add', '-A');

			const ranges = await getChangedLineRanges(nested);
			expect(ranges).not.toBeNull();
			// RED at the current code: the staged leg keys the file
			// `nested/src/app.ts`, the classifier looks up `src/app.ts`, and the
			// line-2 finding classifies PRE-EXISTING.
			const classified = classifySastFindings(
				[sastFinding('src/app.ts', 2)],
				ranges,
				nested,
			);
			expect(classified.newFindings).toHaveLength(1);
			expect(classified.preexistingFindings).toHaveLength(0);
		} finally {
			removeTreeWithRetry(root);
		}
	}, 60_000);

	// C7: untracked files never join the ambiguity set (status '??' records
	// are not staged/unstaged dirtiness), and the set's coordinate system is
	// the classifier's — no repo-root-prefixed key may leak into it.
	test('C7: an untracked nested record drops cleanly and the ambiguity set stays in classifier coordinates', async () => {
		const { root, repo, nested } = buildNestedFixture(
			'pre-check-nested-untracked-3700-',
		);
		try {
			write(
				repo,
				'nested/src/app.ts',
				'export const a = 1;\nexport const b = 2;\nexport const C = 3;\n',
			);
			git(repo, 'add', '-A');
			git(repo, ...IDENTITY, 'commit', '-q', '-m', 'edit');
			write(
				repo,
				'nested/src/app.ts',
				'export const A = 1;\nexport const b = 2;\nexport const C = 3;\n',
			);
			// The untracked record the ambiguity surface must DROP ('??' never
			// joins staged/unstaged) and the RANGES surface must key
			// ALL_LINES_CHANGED under the classifier's coordinate key.
			write(repo, 'nested/src/new-file.ts', 'export const fresh = 1;\n');

			// Round-2 strengthening — ranges side: the porcelain untracked leg
			// (`git status --porcelain=v1 -z --untracked-files=all` run with
			// cwd=<nested>, then parseUntrackedStatus →
			// `result.set(key, new Set([ALL_LINES_CHANGED]))`) enters the map
			// under the RAW porcelain path key. At the CURRENT code that key is
			// git's repo-root spelling `nested/src/new-file.ts` (recorded base
			// value); post-fix it must be the classifier's coordinate key
			// `src/new-file.ts` with the ALL_LINES_CHANGED sentinel (-1).
			const ranges = await getChangedLineRanges(nested);
			expect(ranges).not.toBeNull();
			expect([...(ranges?.get('src/new-file.ts') ?? [])]).toEqual([-1]);
			// And the repo-root-prefixed spelling must NOT appear post-fix.
			expect(ranges?.has('nested/src/new-file.ts')).toBe(false);

			const ambiguous = await getChangedLineAmbiguousFiles(nested);
			expect(ambiguous).not.toBeNull();
			// RED at the current code: the set carries `nested/src/app.ts`.
			expect(ambiguous?.has('src/app.ts')).toBe(true);
			// Coordinate pin: no repo-root-prefixed spelling may leak into the
			// set (RED at the current code).
			expect(
				[...(ambiguous ?? new Set<string>())].filter((key) =>
					key.startsWith('nested/'),
				),
			).toEqual([]);
			// Drop semantics pin: the untracked file itself is not ambiguous.
			expect(ambiguous?.has('src/new-file.ts')).toBe(false);
		} finally {
			removeTreeWithRetry(root);
		}
	}, 60_000);

	// C8: a staged rename whose SOURCE lives outside the nested prefix. The
	// porcelain -z stream carries the destination record plus the paired
	// source record; the outside-prefix source must drop WITH its pair (a
	// naive prefix filter that drops the source record alone would leave the
	// stream misaligned and fail the record parse).
	test('C8: a cross-prefix rename into the nested root keeps the record stream intact and the destination classifiable', async () => {
		const { root, repo, nested } = buildNestedFixture(
			'pre-check-nested-rename-3700-',
			{ withOutsideFile: true },
		);
		try {
			// Keep the committed hop non-empty (app.ts line 3).
			write(
				repo,
				'nested/src/app.ts',
				'export const a = 1;\nexport const b = 2;\nexport const C = 3;\n',
			);
			git(repo, 'add', '-A');
			git(repo, ...IDENTITY, 'commit', '-q', '-m', 'edit');
			// STAGED rename INTO the nested root (source outside the prefix).
			git(repo, 'mv', 'outside.ts', 'nested/moved-outside.ts');
			// Round-2 strengthening — make destination preservation OBSERVABLE:
			// an UNSTAGED edit on the renamed destination makes it genuinely
			// multi-hop (staged rename + unstaged edit), so the ambiguity set
			// must contain the destination. An implementation that drops the
			// whole rename pair (destination record AND its paired outside-
			// prefix source record) fails this leg.
			write(
				repo,
				'nested/moved-outside.ts',
				'export const outside = EDITED;\n',
			);

			// The rename destination is a changed path in the nested root: a
			// finding in it must never read PRE-EXISTING (RED at the current
			// code — the staged rename leg keys `nested/moved-outside.ts`, the
			// classifier looks up `moved-outside.ts`). A fail-closed null map
			// also classifies NEW, which is the acceptable safe direction.
			const ranges = await getChangedLineRanges(nested);
			const classified = classifySastFindings(
				[sastFinding('moved-outside.ts', 1)],
				ranges,
				nested,
			);
			expect(classified.newFindings).toHaveLength(1);
			expect(classified.preexistingFindings).toHaveLength(0);

			// The ambiguity surface consumes the destination record and its
			// paired source record together: the destination is now staged+unstaged
			// (multi-hop) so it MUST appear in the set under the classifier's
			// coordinate key `moved-outside.ts` (RED at the current code, which
			// keys `nested/moved-outside.ts`). A misaligned stream (the paired
			// source record left dangling) would instead fail the record parse
			// and return null.
			const ambiguous = await getChangedLineAmbiguousFiles(nested);
			expect(ambiguous).not.toBeNull();
			expect(ambiguous?.has('moved-outside.ts')).toBe(true);
			// Coordinate pin: the repo-root-prefixed spelling must not appear.
			expect(ambiguous?.has('nested/moved-outside.ts')).toBe(false);
			expect(ambiguous?.size).toBe(1);
		} finally {
			removeTreeWithRetry(root);
		}
	}, 60_000);
});
