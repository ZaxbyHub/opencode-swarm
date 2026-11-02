/**
 * #3120 LEG 3 — patch-application, ref-restore, and rsync write vectors.
 *
 * Covers the new detector surfaces (detectPosixWrites) and their
 * authorization-time resolution (resolveWriteTargets):
 * - `git apply <patch>` / `patch [-pN] <patch>` report a `patch_apply` write
 *   carrying the literal patch-file operands; resolveWriteTargets reads the
 *   patch at the tracked working directory and expands one resolved write
 *   per target named INSIDE it (both diff endpoints, /dev/null excluded).
 * - Closed option sets: unsupported options yield a write with NO
 *   patchSources, which the live gate fails closed on.
 * - `git checkout <ref> <pathspec>` restores the pathspec operands;
 *   branch-creation and bare-ref checkouts stay undetected.
 * - `rsync <src>… <dest>` targets the destination operand.
 */

import { describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import {
	canonicalMkdtemp,
	removeTreeWithRetry,
} from '../../tests/helpers/tmpdir';
import { detectPosixWrites, resolveWriteTargets } from './shell-write-detect';

/** Two-file unified diff — targets src/one.txt and src/two.txt at -p1. */
const TWO_FILE_PATCH = [
	'diff --git a/src/one.txt b/src/one.txt',
	'index 111..222 100644',
	'--- a/src/one.txt',
	'+++ b/src/one.txt',
	'@@ -1 +1 @@',
	'-old',
	'+new',
	'diff --git a/src/two.txt b/src/two.txt',
	'--- a/src/two.txt',
	'+++ b/src/two.txt',
	'@@ -1 +1 @@',
	'-old',
	'+new',
	'',
].join('\n');

describe('detectPosixWrites — git apply (patch_apply, #3120 LEG 3b)', () => {
	test('git apply <patch> is detected with the patch operand as source', () => {
		const result = detectPosixWrites('git apply fix.patch');
		expect(result.hasWrites).toBe(true);
		expect(result.writes).toEqual([
			{
				category: 'patch_apply',
				operator: 'git apply',
				path: null,
				patchSources: ['fix.patch'],
				patchStrip: 1,
			},
		]);
	});

	const unsupportedOptions = [
		'--directory=sub',
		'--cached',
		'--index',
		'--3way',
		'-o',
	];
	for (const option of unsupportedOptions) {
		test(`git apply ${option} is detected with NO patch sources (fail-closed)`, () => {
			const result = detectPosixWrites(`git apply ${option} fix.patch`);
			expect(result.hasWrites).toBe(true);
			expect(result.writes).toHaveLength(1);
			const write = result.writes[0];
			expect(write.category).toBe('patch_apply');
			expect(write.path).toBe(null);
			// The unsupported-option shape carries no sources: the gate cannot
			// know the rewritten target set, so it must never authorize blind.
			expect(write.patchSources).toBeUndefined();
		});
	}
});

describe('detectPosixWrites — GNU patch (patch_apply)', () => {
	test('patch -p1 < fix.diff resolves the stdin redirect as the patch source', () => {
		const result = detectPosixWrites('patch -p1 < fix.diff');
		expect(result.hasWrites).toBe(true);
		expect(result.writes).toEqual([
			{
				category: 'patch_apply',
				operator: 'patch',
				path: null,
				patchSources: ['fix.diff'],
				patchStrip: 1,
			},
		]);
	});

	test('patch fix.patch without -p is detected with NO sources (dynamic basename)', () => {
		const result = detectPosixWrites('patch fix.patch');
		expect(result.hasWrites).toBe(true);
		expect(result.writes).toEqual([
			{
				category: 'patch_apply',
				operator: 'patch (no explicit -p)',
				path: null,
			},
		]);
	});

	test('patch -p1 fix.patch carries the positional source and strip 1', () => {
		const result = detectPosixWrites('patch -p1 fix.patch');
		expect(result.writes).toEqual([
			{
				category: 'patch_apply',
				operator: 'patch',
				path: null,
				patchSources: ['fix.patch'],
				patchStrip: 1,
			},
		]);
	});
});

describe('resolveWriteTargets — patch-content target extraction (#3120)', () => {
	test('git apply expands BOTH file headers into targets under the cwd', () => {
		const root = canonicalMkdtemp('swd3120-apply-two-');
		try {
			writeFileSync(path.join(root, 'fix.patch'), TWO_FILE_PATCH);
			const command = 'git apply fix.patch';
			const analysis = detectPosixWrites(command);
			const result = resolveWriteTargets(command, analysis.writes, root);

			const paths = result.map((r) => r.resolvedPath);
			expect(paths).toContain(path.join(root, 'src', 'one.txt'));
			expect(paths).toContain(path.join(root, 'src', 'two.txt'));
			expect(result.every((r) => r.resolved === true)).toBe(true);
		} finally {
			removeTreeWithRetry(root);
		}
	});

	test('patch -p1 < fix.diff extracts targets from the redirected patch', () => {
		const root = canonicalMkdtemp('swd3120-stdin-');
		try {
			writeFileSync(path.join(root, 'fix.diff'), TWO_FILE_PATCH);
			const command = 'patch -p1 < fix.diff';
			const analysis = detectPosixWrites(command);
			const result = resolveWriteTargets(command, analysis.writes, root);

			const paths = result.map((r) => r.resolvedPath);
			expect(paths).toContain(path.join(root, 'src', 'one.txt'));
			expect(paths).toContain(path.join(root, 'src', 'two.txt'));
		} finally {
			removeTreeWithRetry(root);
		}
	});

	test('a delete patch keeps the PROTECTED PREIMAGE target (.secretscanignore)', () => {
		const root = canonicalMkdtemp('swd3120-preimage-');
		try {
			const deletePatch = [
				'diff --git a/.secretscanignore b/.secretscanignore',
				'deleted file mode 100644',
				'--- a/.secretscanignore',
				'+++ /dev/null',
				'@@ -1 +0,0 @@',
				'-entry',
				'',
			].join('\n');
			writeFileSync(path.join(root, 'del.patch'), deletePatch);
			const command = 'git apply del.patch';
			const analysis = detectPosixWrites(command);
			const result = resolveWriteTargets(command, analysis.writes, root);

			// The postimage is /dev/null (excluded); the preimage delete still
			// mutates .secretscanignore, so it MUST surface as the target.
			expect(result).toHaveLength(1);
			expect(result[0].resolvedPath).toBe(path.join(root, '.secretscanignore'));
			expect(result[0].resolved).toBe(true);
		} finally {
			removeTreeWithRetry(root);
		}
	});

	test('an unreadable (nonexistent) patch resolves to a null fail-closed entry', () => {
		const root = canonicalMkdtemp('swd3120-unreadable-');
		try {
			const command = 'git apply missing.patch';
			const analysis = detectPosixWrites(command);
			const result = resolveWriteTargets(command, analysis.writes, root);

			expect(result).toHaveLength(1);
			expect(result[0].resolvedPath).toBe(null);
			expect(result[0].resolved).toBe(false);
		} finally {
			removeTreeWithRetry(root);
		}
	});

	test('a cd-prefixed git apply resolves the patch at the tracked sub/ directory', () => {
		const root = canonicalMkdtemp('swd3120-cd-apply-');
		try {
			mkdirSync(path.join(root, 'sub'), { recursive: true });
			writeFileSync(path.join(root, 'sub', 'fix.patch'), TWO_FILE_PATCH);
			const command = 'cd sub && git apply fix.patch';
			const analysis = detectPosixWrites(command);
			const result = resolveWriteTargets(command, analysis.writes, root);

			const paths = result.map((r) => r.resolvedPath);
			expect(paths).toContain(path.join(root, 'sub', 'src', 'one.txt'));
			expect(paths).toContain(path.join(root, 'sub', 'src', 'two.txt'));
			for (const resolved of result) {
				expect(resolved.resolvedPath?.startsWith(path.join(root, 'sub'))).toBe(
					true,
				);
			}
		} finally {
			removeTreeWithRetry(root);
		}
	});
});

describe('detectPosixWrites — git checkout <ref> <pathspec> (#3120 LEG 3a)', () => {
	test('git checkout main src/x.ts restores the pathspec operand', () => {
		const result = detectPosixWrites('git checkout main src/x.ts');
		expect(result.hasWrites).toBe(true);
		expect(result.writes).toEqual([
			{
				category: 'git_destructive',
				operator: 'git checkout <ref>',
				path: 'src/x.ts',
			},
		]);
	});

	test('git checkout main (bare ref, no pathspec) is NOT detected', () => {
		expect(detectPosixWrites('git checkout main').hasWrites).toBe(false);
	});

	test('git checkout -b feature (branch creation) is NOT detected', () => {
		expect(detectPosixWrites('git checkout -b feature').hasWrites).toBe(false);
	});

	test('git checkout -B other (branch reset) is NOT detected', () => {
		expect(detectPosixWrites('git checkout -B other').hasWrites).toBe(false);
	});
});

describe('detectPosixWrites — rsync destination writes (#3120 LEG 3c)', () => {
	test('rsync -a src/ dest/ targets the destination operand', () => {
		const result = detectPosixWrites('rsync -a src/ dest/');
		expect(result.hasWrites).toBe(true);
		expect(result.writes).toEqual([
			{ category: 'builtin_write', operator: 'rsync', path: 'dest/' },
		]);
	});

	test('rsync src dest2 (flagless) targets dest2', () => {
		const result = detectPosixWrites('rsync src dest2');
		expect(result.writes).toEqual([
			{ category: 'builtin_write', operator: 'rsync', path: 'dest2' },
		]);
	});
});

describe('#3120 contrast set — pre-existing vectors stay green', () => {
	test('git checkout -- <path> keeps its original detection', () => {
		const result = detectPosixWrites('git checkout -- x');
		expect(result.writes).toEqual([
			{ category: 'git_destructive', operator: 'git checkout --', path: 'x' },
		]);
	});

	test('cp keeps its original detection', () => {
		const result = detectPosixWrites('cp a b');
		expect(result.writes).toEqual([
			{ category: 'builtin_write', operator: 'cp', path: 'b' },
		]);
	});

	test('echo > keeps its original detection', () => {
		const result = detectPosixWrites('echo hi > f.txt');
		expect(result.writes).toEqual([
			{ category: 'redirect', operator: '>', path: 'f.txt' },
		]);
	});
});

describe('resolveWriteTargets — checkout and rsync target resolution', () => {
	test('git checkout main src/x.ts resolves the pathspec under the cwd', () => {
		const root = canonicalMkdtemp('swd3120-co-ref-');
		try {
			const command = 'git checkout main src/x.ts';
			const analysis = detectPosixWrites(command);
			const result = resolveWriteTargets(command, analysis.writes, root);
			expect(result).toHaveLength(1);
			expect(result[0].resolvedPath).toBe(path.join(root, 'src', 'x.ts'));
			expect(result[0].resolved).toBe(true);
		} finally {
			removeTreeWithRetry(root);
		}
	});

	test('rsync -a src/ dest/ resolves the destination under the cwd', () => {
		const root = canonicalMkdtemp('swd3120-rsync-');
		try {
			const command = 'rsync -a src/ dest/';
			const analysis = detectPosixWrites(command);
			const result = resolveWriteTargets(command, analysis.writes, root);
			expect(result).toHaveLength(1);
			expect(result[0].resolvedPath).toBe(path.join(root, 'dest'));
			expect(result[0].resolved).toBe(true);
		} finally {
			removeTreeWithRetry(root);
		}
	});
});

// #3120 4.5 review round 1: git GLOBAL options and execution wrappers must
// not hide the apply subcommand from the patch detector.
describe('patch detection across git global options and wrappers (4.5 round 1)', () => {
	test('git -C . apply is detected with sources', () => {
		const analysis = detectPosixWrites('git -C . apply fix.patch');
		expect(analysis.hasWrites).toBe(true);
		const patch = analysis.writes.find((w) => w.category === 'patch_apply');
		expect(patch?.operator).toBe('git apply');
		expect(patch?.patchSources).toEqual(['fix.patch']);
	});

	test('git --no-pager apply is detected', () => {
		const analysis = detectPosixWrites('git --no-pager apply fix.patch');
		expect(analysis.hasWrites).toBe(true);
	});

	test('git -c core.autocrlf=false apply is detected', () => {
		const analysis = detectPosixWrites(
			'git -c core.autocrlf=false apply fix.patch',
		);
		expect(analysis.hasWrites).toBe(true);
	});

	test('env git apply is detected (execution wrapper)', () => {
		const analysis = detectPosixWrites('env git apply fix.patch');
		expect(analysis.hasWrites).toBe(true);
		const patch = analysis.writes.find((w) => w.category === 'patch_apply');
		expect(patch?.patchSources).toEqual(['fix.patch']);
	});

	test('git -C . checkout main -- src/x.ts still detected by the destructive arm', () => {
		const analysis = detectPosixWrites('git -C . checkout main -- src/x.ts');
		expect(analysis.hasWrites).toBe(true);
	});

	test('plain git -C . status stays undetected', () => {
		const analysis = detectPosixWrites('git -C . status');
		expect(analysis.hasWrites).toBe(false);
	});
});
