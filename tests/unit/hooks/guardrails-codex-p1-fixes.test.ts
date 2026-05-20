/**
 * Adversarial tests for the two P1 findings raised by Codex on PR #501:
 *
 *  1. `declaredCoderScope` bypass was applied to ALL agents, allowing
 *     role-restricted agents (docs / designer / reviewer / test_engineer /
 *     critic) to escape their hardcoded `allowedPrefix` whenever the
 *     architect had declared scope for the coder. The bypass is now gated
 *     to canonical or prefixed `coder` agents only.
 *
 *  2. The cwd-containment check at `checkFileAuthorityWithRules` only
 *     rejected `..`-style relative paths. On Windows,
 *     `path.relative('C:\\repo', 'D:\\secret.txt')` returns the absolute
 *     drive path `'D:\\secret.txt'` (not a `../` traversal), which would
 *     slip past containment. The fix now also compares filesystem roots:
 *     if `path.parse(target).root !== path.parse(cwd).root`, the write is
 *     rejected.
 *
 * Both findings are P1 because they degrade the guarantees we just took on
 * by removing coder's hardcoded `allowedPrefix` whitelist.
 */

import { describe, expect, test } from 'bun:test';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	checkFileAuthority,
	isOnDifferentFilesystemRoot,
} from '../../../src/hooks/guardrails';

const TEST_CWD = path.join(os.tmpdir(), 'test-project');

describe('Codex P1 fix: declaredScope gated to coder agents only', () => {
	const declaredScope = ['src/foo.ts'];

	test('coder: in-scope path bypasses allowedPrefix (regression coverage)', () => {
		// Coder has no `allowedPrefix` after #496 (df4ac3b), so the bypass
		// path is mostly relevant once a future operator restores one. We
		// model that here by leaning on `test_engineer` in the negative
		// tests below; for coder we simply confirm the in-scope write is
		// allowed (no other DENY rule fires).
		const result = checkFileAuthority(
			'coder',
			'src/foo.ts',
			TEST_CWD,
			undefined,
			{
				declaredScope,
			},
		);
		expect(result.allowed).toBe(true);
	});

	test('local_coder (prefixed coder variant): in-scope path is allowed', () => {
		const result = checkFileAuthority(
			'local_coder',
			'src/foo.ts',
			TEST_CWD,
			undefined,
			{ declaredScope },
		);
		expect(result.allowed).toBe(true);
	});

	test('docs: cannot bypass allowedPrefix even when path is in declaredScope', () => {
		// docs default rules: allowedPrefix=['docs/', '.swarm/outputs/'].
		// `src/foo.ts` is NOT in docs' allowlist. Pre-fix, declaredScope
		// containing `src/foo.ts` would allow the write; post-fix it must
		// stay blocked because docs is not a coder.
		const result = checkFileAuthority(
			'docs',
			'src/foo.ts',
			TEST_CWD,
			undefined,
			{
				declaredScope,
			},
		);
		expect(result.allowed).toBe(false);
		if (!result.allowed) {
			expect(result.reason).toContain('not in allowed list for docs');
		}
	});

	test('designer: cannot bypass allowedPrefix even when path is in declaredScope', () => {
		const result = checkFileAuthority(
			'designer',
			'src/foo.ts',
			TEST_CWD,
			undefined,
			{ declaredScope },
		);
		expect(result.allowed).toBe(false);
		if (!result.allowed) {
			expect(result.reason).toContain('not in allowed list for designer');
		}
	});

	test('critic: cannot bypass allowedPrefix even when path is in declaredScope', () => {
		// critic allowedPrefix=['.swarm/evidence/'] only.
		const result = checkFileAuthority(
			'critic',
			'src/foo.ts',
			TEST_CWD,
			undefined,
			{ declaredScope },
		);
		expect(result.allowed).toBe(false);
		if (!result.allowed) {
			expect(result.reason).toContain('not in allowed list for critic');
		}
	});

	test('test_engineer: declaredScope cannot relax blockedPrefix either', () => {
		// test_engineer has `blockedPrefix: ['src/']` AND
		// `allowedPrefix: ['tests/', '.swarm/evidence/']`. Even though the
		// test_engineer→coder bypass would have unlocked allowedPrefix, the
		// blockedPrefix takes priority at Step 6 — but the agent is also
		// not a coder, so the bypass never fires. Two layers of defence.
		const result = checkFileAuthority(
			'test_engineer',
			'src/foo.ts',
			TEST_CWD,
			undefined,
			{ declaredScope },
		);
		expect(result.allowed).toBe(false);
	});

	test('reviewer: declaredScope does not unlock src/ writes', () => {
		// reviewer rules: blockedPrefix=['src/'] takes priority anyway, but
		// belt-and-braces — confirm a non-coder reviewer is not granted any
		// special bypass for declared paths.
		const result = checkFileAuthority(
			'reviewer',
			'src/foo.ts',
			TEST_CWD,
			undefined,
			{ declaredScope },
		);
		expect(result.allowed).toBe(false);
	});

	test('docs: paths inside docs/ remain allowed (no regression)', () => {
		// Sanity: gating declaredScope by role must not break legitimate
		// in-allowlist writes for non-coder agents.
		const result = checkFileAuthority(
			'docs',
			'docs/architecture.md',
			TEST_CWD,
			undefined,
			{ declaredScope: ['docs/architecture.md'] },
		);
		expect(result.allowed).toBe(true);
	});

	test('docs: writes outside its allowlist still fail with original reason (no regression)', () => {
		// Without any declaredScope, docs writing to src/ must remain
		// blocked with the same allowlist message.
		const result = checkFileAuthority('docs', 'src/foo.ts', TEST_CWD);
		expect(result.allowed).toBe(false);
		if (!result.allowed) {
			expect(result.reason).toContain('not in allowed list for docs');
		}
	});
});

describe('Codex P1 fix: cross-drive / cross-root containment', () => {
	// These tests exercise the actual `isOnDifferentFilesystemRoot` helper
	// that backs the cross-drive guard at `checkFileAuthorityWithRules`. They
	// inject `path.win32` / `path.posix` to make the Windows-only branch
	// falsifiable on Linux CI: deleting the inline call site or returning a
	// constant from the helper would now break this suite. Previously the
	// suite only validated Node.js's own `path.parse` invariant, which made
	// the production code path untestable outside Windows runners.

	test('helper: returns true for different Windows drives (D:/ vs C:/)', () => {
		// Direct invariant: deleting the body and returning `false` from the
		// helper would break this case. This is the symptom Codex reported.
		expect(
			isOnDifferentFilesystemRoot('D:\\secret.txt', 'C:\\repo', path.win32),
		).toBe(true);
	});

	test('helper: returns false for same Windows drive (C:\\repo\\foo vs C:\\repo)', () => {
		expect(
			isOnDifferentFilesystemRoot('C:\\repo\\foo.ts', 'C:\\repo', path.win32),
		).toBe(false);
	});

	test('helper: returns false on POSIX (single root `/`)', () => {
		// Even an "escape" target shares root `/` with cwd on POSIX, so this
		// branch must be a no-op there — the existing `startsWith('../')`
		// check below handles traversal. Returning `true` here would break
		// every legitimate write on Linux/macOS.
		expect(
			isOnDifferentFilesystemRoot('/etc/passwd', '/test/project', path.posix),
		).toBe(false);
		expect(
			isOnDifferentFilesystemRoot(
				'/test/project/src/index.ts',
				'/test/project',
				path.posix,
			),
		).toBe(false);
	});

	test('helper: defaults to host `path` lib when none injected', () => {
		// Host platform decides; we only assert the call shape works. On
		// POSIX, both roots are `/`, so the result is `false`. On Windows,
		// running these absolute-style POSIX strings through `path.win32` is
		// not what happens at runtime — the helper just delegates to the
		// host `path` module. This guarantees the default-arg path is
		// covered without locking the test to one platform.
		const result = isOnDifferentFilesystemRoot(
			'/test/project/src/index.ts',
			'/test/project',
		);
		expect(typeof result).toBe('boolean');
	});

	test('checkFileAuthority blocks /etc/passwd-style escape (POSIX)', () => {
		// Already covered upstream, but kept here so this file is the
		// single touch-point for Codex P1 regressions. /etc/passwd from
		// /test/project resolves to a `../../etc/passwd` relative path,
		// caught by the existing `startsWith('../')` clause.
		const result = checkFileAuthority('architect', '/etc/passwd', TEST_CWD);
		expect(result.allowed).toBe(false);
		if (!result.allowed) {
			expect(result.reason).toMatch(
				/different drive\/root|outside the working directory/,
			);
		}
	});

	test('paths inside cwd are unaffected by the new root check (POSIX)', () => {
		// The new root comparison uses path.parse(...).root, which is `/`
		// for every POSIX path. So the new check must never falsely block
		// in-cwd writes on Linux/macOS.
		const result = checkFileAuthority('architect', 'src/index.ts', TEST_CWD);
		expect(result.allowed).toBe(true);
	});

	// Windows-only end-to-end coverage: when running on a real Windows CI
	// runner, exercise `checkFileAuthority` against a literal cross-drive
	// path. On POSIX this is skipped (the helper tests above cover the logic
	// deterministically; running the full path here would just trip the
	// `startsWith('../')` clause and not the cross-drive branch).
	const winTest = process.platform === 'win32' ? test : test.skip;
	winTest(
		'checkFileAuthority blocks D:\\secret.txt from C:\\repo (Windows only)',
		() => {
			const result = checkFileAuthority(
				'architect',
				'D:\\secret.txt',
				'C:\\repo',
			);
			expect(result.allowed).toBe(false);
			if (!result.allowed) {
				expect(result.reason).toContain('different drive/root');
			}
		},
	);
});
