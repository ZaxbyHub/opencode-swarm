import { describe, expect, it } from 'bun:test';
import { execSync } from 'node:child_process';
import * as fsSync from 'node:fs';
import * as path from 'node:path';
import {
	canonicalizeWindowsPathPublic as canonicalize,
	canonicalizeWindowsPathTailTolerantPublic as canonicalizeTailTolerant,
	checkFileAuthority,
	clearGuardrailsCaches,
	getLinkedGitWorktrees,
} from '../../../src/hooks/guardrails/file-authority.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const shortFormOf = (longDir: string): string | null => {
	try {
		const out = execSync(`cmd /c for %A in ("${longDir}") do @echo %~sA`, {
			encoding: 'utf8',
		}).trim();
		return out && out !== longDir && out.includes('~') ? out : null;
	} catch {
		return null;
	}
};

/**
 * Windows-CI regression pins for the worktree-containment fix (issue #3368
 * feedback round 2): on GitHub windows-latest runners the temp root is
 * reported in 8.3 short-name form (C:\Users\RUNNER~1\...) while git's
 * porcelain reports long-form (runneradmin) roots — the plain JS realpath
 * does not expand short names, so lexical containment matching rejected
 * every real linked worktree. These tests pin the native canonicalization
 * that re-unifies the two forms.
 */
describe('guardrails worktree short-name canonicalization (win32)', () => {
	it('expands 8.3 short-name segments via native realpath', () => {
		if (process.platform !== 'win32') return;
		const longDir = canonicalMkdtemp('w3368-short-pin-');
		// Ask NTFS for the 8.3 form; skip when short-name creation is disabled
		// on the volume (some runners/disks disable it).
		let shortDir: string | null = null;
		try {
			shortDir = execSync(`cmd /c for %A in ("${longDir}") do @echo %~sA`, {
				encoding: 'utf8',
			}).trim();
		} catch {
			shortDir = null;
		}
		if (!shortDir || shortDir === longDir || !shortDir.includes('~')) return;

		expect(shortDir).not.toBe(longDir);
		const canonical = canonicalize(shortDir);
		// The canonical form must not retain any 8.3 segment and must name the
		// same directory as the long form. Both sides go through the NATIVE
		// realpath: the plain JS realpath leaves a short-form fixture
		// unexpanded (the OS temp root arrives 8.3 short-form on GitHub
		// windows runners), which would compare long vs short and fail
		// spuriously.
		expect(canonical.includes('~')).toBe(false);
		expect(fsSync.realpathSync.native(canonical)).toBe(
			fsSync.realpathSync.native(longDir),
		);
		fsSync.rmSync(longDir, { recursive: true, force: true });
	});

	it('returns long-form (no 8.3 tilde segments) worktree roots on win32', () => {
		if (process.platform !== 'win32') return;
		const sandboxDir = canonicalMkdtemp('w3368-roots-');
		const mainRepoDir = path.join(sandboxDir, 'main-repo');
		fsSync.mkdirSync(mainRepoDir, { recursive: true });
		const g = (a: string) =>
			execSync(`git ${a}`, { cwd: mainRepoDir, stdio: 'pipe' });
		g('init -b main');
		g('config user.name "Test"');
		g('config user.email "test@example.com"');
		g('commit --allow-empty -m "initial commit"');
		const linkedDir = path.join(sandboxDir, 'linked');
		g(`worktree add "${linkedDir}" -b feat/linked`);
		clearGuardrailsCaches();
		const roots = getLinkedGitWorktrees(mainRepoDir);
		// Whatever form the caller's cwd used, the discovered roots must not
		// carry 8.3 segments (the porcelain is canonicalized through
		// realpathSync.native), so later lexical matching against long-form
		// caller paths is coherent.
		for (const root of roots) {
			expect(
				root.split(path.sep).some((segment) => segment.includes('~')),
			).toBe(false);
		}
		fsSync.rmSync(sandboxDir, { recursive: true, force: true });
	});

	it('canonicalizes a NOT-YET-EXISTING target via its existing ancestor', () => {
		if (process.platform !== 'win32') return;
		const longDir = canonicalMkdtemp('w3368-tail-pin-');
		const shortDir = shortFormOf(longDir);
		if (!shortDir) {
			fsSync.rmSync(longDir, { recursive: true, force: true });
			return;
		}
		// The write-target does not exist yet (the common case for a write
		// authority check), so plain native realpath fails and previously left
		// the 8.3 form in place while existing worktree roots were expanded —
		// the two sides could never lexically match (windows CI).
		const missingTarget = path.join(shortDir, 'missing', 'file.txt');
		const result = canonicalizeTailTolerant(missingTarget);
		const expectedAncestor = fsSync.realpathSync.native(longDir);
		expect(result).toBe(path.join(expectedAncestor, 'missing', 'file.txt'));
		fsSync.rmSync(longDir, { recursive: true, force: true });
	});

	it('allows a new-file write inside a linked worktree when cwd is short-form', () => {
		if (process.platform !== 'win32') return;
		const sandboxDir = canonicalMkdtemp('w3368-e2e-');
		const mainRepoDir = path.join(sandboxDir, 'main-repo');
		fsSync.mkdirSync(mainRepoDir, { recursive: true });
		const g = (a: string) =>
			execSync(`git ${a}`, { cwd: mainRepoDir, stdio: 'pipe' });
		g('init -b main');
		g('config user.name "Test"');
		g('config user.email "test@example.com"');
		g('commit --allow-empty -m "initial commit"');
		const linkedDir = path.join(sandboxDir, 'linked');
		g(`worktree add "${linkedDir}" -b feat/linked`);
		clearGuardrailsCaches();
		const shortMain = shortFormOf(mainRepoDir);
		const shortSandbox = shortFormOf(sandboxDir);
		if (!shortMain || !shortSandbox) {
			fsSync.rmSync(sandboxDir, { recursive: true, force: true });
			return;
		}
		// Exact windows-CI failure shape: git porcelain reports the worktree
		// root long-form while the caller cwd AND target are 8.3 short-form
		// and the target file does not exist yet — the target must still
		// re-root into the worktree instead of being denied as ROOT_ESCAPE.
		const result = checkFileAuthority(
			'architect',
			path.join(shortSandbox, 'linked', 'src', 'index.ts'),
			shortMain,
		);
		expect(result.allowed).toBe(true);
		fsSync.rmSync(sandboxDir, { recursive: true, force: true });
	});
});
