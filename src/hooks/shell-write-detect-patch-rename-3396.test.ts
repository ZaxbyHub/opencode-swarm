/**
 * #3396 feedback (PRR-002/003) — rename-only patch sections are judged.
 *
 * A `diff --git` section whose change is a pure rename has NO `---/+++`
 * header lines: pre-fix, `extractPatchTargets` keyed on the `---` line so the
 * rename endpoints never became judged write targets (executed bypass: a
 * mixed patch with one headered hunk and one rename-only section rewrote the
 * headered file while silently renaming the protected file). The fix parses
 * `rename from/to` as an additional endpoint pair. Each landing is judged
 * under the DUAL-landing contract (git apply is root-relative; GNU patch is
 * cwd-relative), so this file pins BOTH landings for the cd-prefixed form.
 */

import { describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import {
	canonicalMkdtemp,
	removeTreeWithRetry,
} from '../../tests/helpers/tmpdir';
import { detectPosixWrites, resolveWriteTargets } from './shell-write-detect';

/**
 * Mixed patch: one normal headered hunk (src/kept.txt) and one rename-only
 * section (`.secretscanignore` → `oxlintrc` — the protected verifier-config
 * file moving under a new name, exactly the executed PRR-002 bypass shape).
 */
const MIXED_RENAME_PATCH = [
	'diff --git a/src/kept.txt b/src/kept.txt',
	'index 111..222 100644',
	'--- a/src/kept.txt',
	'+++ b/src/kept.txt',
	'@@ -1 +1 @@',
	'-old',
	'+new',
	'diff --git a/.secretscanignore b/oxlintrc',
	'similarity index 100%',
	'rename from .secretscanignore',
	'rename to oxlintrc',
	'',
].join('\n');

describe('resolveWriteTargets — rename-only patch sections (#3396 PRR-002)', () => {
	test('a rename-only section contributes BOTH endpoints as judged targets', () => {
		const root = canonicalMkdtemp('swd3396-rename-');
		try {
			writeFileSync(path.join(root, 'fix.patch'), MIXED_RENAME_PATCH);
			const command = 'git apply fix.patch';
			const analysis = detectPosixWrites(command);
			const result = resolveWriteTargets(command, analysis.writes, root);

			const paths = result.map((r) => r.resolvedPath);
			// The headered section still lands.
			expect(paths).toContain(path.join(root, 'src', 'kept.txt'));
			// The rename's PREIMAGE (the protected file being moved away)...
			expect(paths).toContain(path.join(root, '.secretscanignore'));
			// ...and its POSTIMAGE (the new name it arrives under).
			expect(paths).toContain(path.join(root, 'oxlintrc'));
			expect(result.every((r) => r.resolved === true)).toBe(true);
		} finally {
			removeTreeWithRetry(root);
		}
	});

	test('the rename targets stay judged under a cd-prefixed git apply', () => {
		const root = canonicalMkdtemp('swd3396-rename-cd-');
		try {
			mkdirSync(path.join(root, 'sub'), { recursive: true });
			writeFileSync(path.join(root, 'sub', 'fix.patch'), MIXED_RENAME_PATCH);
			const command = 'cd sub && git apply fix.patch';
			const analysis = detectPosixWrites(command);
			const result = resolveWriteTargets(command, analysis.writes, root);

			const paths = result.map((r) => r.resolvedPath);
			// Dual landing: git apply resolves the patch operand against the
			// tracked cwd (sub/fix.patch) and judges targets at BOTH the
			// tracked-context landing and the rootDir landing.
			for (const endpoint of ['.secretscanignore', 'oxlintrc']) {
				expect(paths).toContain(path.join(root, endpoint));
				expect(paths).toContain(path.join(root, 'sub', endpoint));
			}
		} finally {
			removeTreeWithRetry(root);
		}
	});
});

describe('patch/rsync extraction hardening (#3396 feedback PRR-011/012, review F7)', () => {
	test('quoted octal header paths decode as UTF-8 bytes, not Latin-1 (F7)', () => {
		const root = canonicalMkdtemp('swd3396-octal-');
		try {
			// `caf\303\251.txt` is the UTF-8 byte encoding of `café.txt`.
			const octalPatch = [
				'diff --git "a/caf\\303\\251.txt" "b/caf\\303\\251.txt"',
				'--- "a/caf\\303\\251.txt"',
				'+++ "b/caf\\303\\251.txt"',
				'@@ -1 +1 @@',
				'-old',
				'+new',
				'',
			].join('\n');
			writeFileSync(path.join(root, 'fix.patch'), octalPatch);
			const command = 'git apply fix.patch';
			const analysis = detectPosixWrites(command);
			const result = resolveWriteTargets(command, analysis.writes, root);
			const paths = result.map((r) => r.resolvedPath);
			expect(paths).toContain(path.join(root, 'café.txt'));
			expect(result.every((r) => r.resolved === true)).toBe(true);
		} finally {
			removeTreeWithRetry(root);
		}
	});

	test('real git space-path headers stay judged (PRR-012, round-2 R2-1)', () => {
		const root = canonicalMkdtemp('swd3396-space-');
		try {
			// git quotes ONLY non-ASCII/special paths — a space path stays
			// UNQUOTED on the diff --git line (executed real-git probe), so
			// this is the production form the parser must keep judging.
			const spacePatch = [
				'diff --git a/my file.txt b/my file.txt',
				'--- a/my file.txt',
				'+++ b/my file.txt',
				'@@ -1 +1 @@',
				'-old',
				'+new',
				'',
			].join('\n');
			writeFileSync(path.join(root, 'fix.patch'), spacePatch);
			const command = 'git apply fix.patch';
			const analysis = detectPosixWrites(command);
			const result = resolveWriteTargets(command, analysis.writes, root);
			const paths = result.map((r) => r.resolvedPath);
			expect(paths).toContain(path.join(root, 'my file.txt'));
			expect(result.every((r) => r.resolved === true)).toBe(true);
		} finally {
			removeTreeWithRetry(root);
		}
	});

	test('an over-deep -p strip fails closed with unresolved targets (PRR-012)', () => {
		const root = canonicalMkdtemp('swd3396-deep-');
		try {
			writeFileSync(path.join(root, 'fix.patch'), MIXED_RENAME_PATCH);
			// -p5 strips 5 components from 2-component paths: git apply would
			// write nothing (or error) — there is no real target, so the
			// resolver must NOT hand back a resolved path.
			const command = 'patch -p5 < fix.patch';
			const analysis = detectPosixWrites(command);
			const result = resolveWriteTargets(command, analysis.writes, root);
			expect(
				result.some((r) => r.resolved === true && r.resolvedPath !== null),
			).toBe(false);
		} finally {
			removeTreeWithRetry(root);
		}
	});

	test('rsync filter values do not hijack operand positions (PRR-011)', () => {
		// One real operand + a space-form filter: rsync with a single path
		// argument only LISTS (no copy) — pre-fix the filter value became a
		// positional and the source was judged as a destination.
		const listing = detectPosixWrites('rsync --exclude x src/');
		expect(listing.writes).toHaveLength(0);

		// Normal two-operand form: the destination is still the judged
		// target and the filter pattern is not.
		const copy = detectPosixWrites('rsync -a --filter "- .git/" src/ dest/');
		const paths = copy.writes.map((w) => w.path);
		expect(paths).toContain('dest/');
		expect(paths).not.toContain('.git/');
	});
});
