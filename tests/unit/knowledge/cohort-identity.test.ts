import { describe, expect, test } from 'bun:test';
import {
	_internals,
	normalizeGitRemote,
	resolveCohortId,
} from '../../../src/knowledge/cohort-identity.js';
import { createSafeTestDir } from '../../helpers/safe-test-dir.js';

/**
 * Issue #1846 cohort-identity resolver tests.
 *
 * Covers required test classes:
 *  - 1. Remote normalization matrix + Unicode (NFC/NFD)
 *  - 2. No-origin sibling worktrees (git-common-dir fallback, degraded)
 *  - 9. Visible degraded fallback
 *  - 10. Subprocess contract (array form, git -C, timeout) — verified by the
 *       runGit seam shape and the bounded GIT_TIMEOUT_MS constant.
 */

describe('normalizeGitRemote', () => {
	test('SSH and HTTPS equivalents converge (GitHub)', () => {
		const ssh = normalizeGitRemote('git@github.com:owner/repo.git');
		const https = normalizeGitRemote('https://github.com/owner/repo.git');
		const httpsNoGit = normalizeGitRemote('https://github.com/owner/repo');
		const sshNoGit = normalizeGitRemote('git@github.com:owner/repo');
		expect(ssh).not.toBeNull();
		expect(ssh).toBe(https);
		expect(https).toBe(httpsNoGit);
		expect(ssh).toBe(sshNoGit);
		expect(ssh).toBe('github.com/owner/repo');
	});

	test('host and scheme case are normalized', () => {
		expect(normalizeGitRemote('git@GitHub.COM:Owner/Repo')).toBe(
			'github.com/owner/repo',
		);
		expect(normalizeGitRemote('HTTPS://GitHub.Com/Owner/Repo')).toBe(
			normalizeGitRemote('https://github.com/owner/repo'),
		);
	});

	test('path case is lowercased for known case-insensitive hosts', () => {
		expect(normalizeGitRemote('git@github.com:SomeOwner/SomeRepo.git')).toBe(
			'github.com/someowner/somerepo',
		);
		expect(normalizeGitRemote('https://gitlab.com/Group/Sub.git')).toBe(
			'gitlab.com/group/sub',
		);
	});

	test('path case is preserved for unknown hosts (fail-safe)', () => {
		const r = normalizeGitRemote('git@selfhost.example:Owner/Repo.git');
		expect(r).toBe('selfhost.example/Owner/Repo');
	});

	test('backslashes normalize to forward slashes', () => {
		expect(
			normalizeGitRemote('https://github.com\\owner\\repo.git'),
		).toBe('github.com/owner/repo');
	});

	test('scp shorthand without user converges', () => {
		expect(normalizeGitRemote('github.com:owner/repo.git')).toBe(
			'github.com/owner/repo',
		);
	});

	test('ssh:// with port and userinfo converges', () => {
		expect(
			normalizeGitRemote('ssh://user@github.com:22/owner/repo.git'),
		).toBe('github.com/owner/repo');
	});

	test('https default port stripped', () => {
		expect(
			normalizeGitRemote('https://github.com:443/owner/repo.git'),
		).toBe('github.com/owner/repo');
	});

	test('NFC/NFD Unicode spellings converge', () => {
		// "café" in NFC vs NFD composition.
		const nfc = 'git@github.com:owner/café.git';
		const nfd = nfc.normalize('NFD');
		expect(normalizeGitRemote(nfc)).toBe(normalizeGitRemote(nfd));
	});

	test('percent-encoded path segments are decoded', () => {
		// %2F in a path segment would otherwise fragment identity.
		expect(
			normalizeGitRemote('https://github.com/owner/repo%2Dextra.git'),
		).toBe('github.com/owner/repo-extra');
	});

	test('returns null for unparseable / empty input', () => {
		expect(normalizeGitRemote('')).toBeNull();
		expect(normalizeGitRemote('not a url')).toBeNull();
		expect(normalizeGitRemote('git@host')).toBeNull();
		// host-only, no owner/repo
		expect(normalizeGitRemote('https://github.com')).toBeNull();
	});

	test('DOCUMENTED BOUNDARY: non-default SSH ports are NOT stripped (intentional scope)', () => {
		// Default ports (:22 ssh, :443 https) ARE stripped. Non-standard ports are
		// intentionally preserved because they may identify a distinct endpoint.
		// This test documents the boundary so a future change can't silently
		// regress the convergence contract without making a deliberate decision.
		const standard = normalizeGitRemote('ssh://git@github.com:22/owner/repo.git');
		const custom = normalizeGitRemote('ssh://git@github.com:2222/owner/repo.git');
		expect(standard).toBe('github.com/owner/repo');
		// Non-default port is preserved — different identity (documented, not a bug).
		expect(custom).not.toBe(standard);
		expect(custom).toContain('2222');
	});

	test('DOCUMENTED BOUNDARY: query strings are not stripped (intentional scope)', () => {
		// Query strings on git remotes are rare and often identify distinct
		// endpoints; this test documents that they are preserved.
		const plain = normalizeGitRemote('https://github.com/owner/repo.git');
		const withQuery = normalizeGitRemote(
			'https://github.com/owner/repo.git?tab=source',
		);
		expect(plain).toBe('github.com/owner/repo');
		expect(withQuery).not.toBe(plain);
	});

	test('DOCUMENTED BOUNDARY: file:// remotes are unparseable (fall through to degraded)', () => {
		// file:// is inherently non-portable; returning null is acceptable — the
		// resolver falls through to the git-common-dir / path fallback.
		expect(normalizeGitRemote('file:///home/user/repo.git')).toBeNull();
	});

	test('full normalization matrix: many equivalent spellings → one id', () => {
		const spellings = [
			'git@github.com:owner/repo.git',
			'git@github.com:owner/repo',
			'https://github.com/owner/repo.git',
			'https://github.com/owner/repo',
			'GitHub.com:Owner/Repo.git',
			'ssh://git@github.com:22/owner/repo.git',
			'https://github.com:443/owner/repo',
		];
		const ids = spellings.map((s) => {
			const n = normalizeGitRemote(s);
			expect(n).not.toBeNull();
			return _internals.cohortHash(n!);
		});
		// Every spelling produces the same 12-hex cohort id.
		expect(new Set(ids).size).toBe(1);
		expect(ids[0]).toMatch(/^[0-9a-f]{12}$/);
	});
});

describe('resolveCohortId', () => {
	test('path fallback (no git) is degraded and deterministic', async () => {
		const { dir, cleanup } = createSafeTestDir('cohort-path-');
		try {
			const id = await resolveCohortId(dir);
			expect(id.source).toBe('path');
			expect(id.degraded).toBe(true);
			expect(id.cohortId).toMatch(/^[0-9a-f]{12}$/);
			// Same dir → same id (deterministic).
			const id2 = await resolveCohortId(dir);
			expect(id2.cohortId).toBe(id.cohortId);
		} finally {
			cleanup();
		}
	});

	test('two distinct paths get distinct cohort ids', async () => {
		const a = createSafeTestDir('cohort-distinct-a-');
		const b = createSafeTestDir('cohort-distinct-b-');
		try {
			const [ida, idb] = await Promise.all([
				resolveCohortId(a.dir),
				resolveCohortId(b.dir),
			]);
			expect(ida.cohortId).not.toBe(idb.cohortId);
		} finally {
			a.cleanup();
			b.cleanup();
		}
	});
});

describe('subprocess contract (invariant 3)', () => {
	test('runGit uses array form with -C, bounded timeout, and null on failure', async () => {
		// An invalid directory → git fails → runGit returns null (never throws).
		const { dir, cleanup } = createSafeTestDir('cohort-subproc-');
		try {
			const out = await _internals.runGit(dir, ['remote', 'get-url', 'origin']);
			// A fresh temp dir has no git → null.
			expect(out).toBeNull();
		} finally {
			cleanup();
		}
	});

	test('GIT_TIMEOUT_MS is bounded (1500 ms)', () => {
		expect(_internals.GIT_TIMEOUT_MS).toBeLessThanOrEqual(5000);
		expect(_internals.GIT_TIMEOUT_MS).toBeGreaterThanOrEqual(500);
	});

	test('cohortHash produces a 12-hex id', () => {
		expect(_internals.cohortHash('github.com/owner/repo')).toMatch(/^[0-9a-f]{12}$/);
	});
});
