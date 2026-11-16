import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { execSync } from 'node:child_process';
import * as fsSync from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
	canonicalizeWindowsPathPublic as canonicalize,
	checkFileAuthority,
	clearGuardrailsCaches,
	getLinkedGitWorktrees,
} from '../../../src/hooks/guardrails/file-authority.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

/**
 * Containment-hardening suite for the linked-worktree authority path
 * (issue #3368 review): forged-registration rejection, bare-record skipping,
 * longest-match re-rooting, planted-link denial inside matched worktrees,
 * and GIT_* env scrubbing. Complements guardrails-worktree-authority.test.ts,
 * which pins the sibling-layout happy paths.
 */
describe('guardrails worktree containment hardening (issue #3368 review)', () => {
	let sandboxDir: string;
	let mainRepoDir: string;

	const git = (args: string, cwd: string): void => {
		execSync(`git ${args}`, { cwd, stdio: 'pipe' });
	};

	beforeEach(async () => {
		sandboxDir = canonicalMkdtemp('swarm-wt-harden-');
		mainRepoDir = path.join(sandboxDir, 'main-repo');
		await fs.mkdir(mainRepoDir, { recursive: true });
		git('init -b main', mainRepoDir);
		git('config user.name "Test"', mainRepoDir);
		git('config user.email "test@example.com"', mainRepoDir);
		git('commit --allow-empty -m "initial commit"', mainRepoDir);
	});

	afterEach(async () => {
		clearGuardrailsCaches();
		try {
			await fs.rm(sandboxDir, { recursive: true, force: true });
		} catch {
			// ignore cleanup errors
		}
	});

	it('rejects a forged .git/worktrees registration as a trusted root', () => {
		const outsideDir = path.join(sandboxDir, 'outside');
		fsSync.mkdirSync(outsideDir, { recursive: true });
		const forgedId = 'forged';
		const registrationDir = path.join(
			mainRepoDir,
			'.git',
			'worktrees',
			forgedId,
		);
		fsSync.mkdirSync(registrationDir, { recursive: true });
		// Three plain files — exactly what an agent-writable .git tree can
		// plant. git worktree list then reports `outsideDir` as a worktree.
		fsSync.writeFileSync(
			path.join(registrationDir, 'gitdir'),
			`${path.join(outsideDir, '.git')}\n`,
		);
		fsSync.writeFileSync(path.join(registrationDir, 'HEAD'), 'ref: main\n');
		fsSync.writeFileSync(path.join(registrationDir, 'commondir'), '..\n');
		clearGuardrailsCaches();
		const worktrees = getLinkedGitWorktrees(mainRepoDir);
		expect(worktrees.some((wt) => wt === outsideDir)).toBe(false);
		const result = checkFileAuthority(
			'architect',
			path.join(outsideDir, 'hosts.txt'),
			mainRepoDir,
		);
		expect(result.allowed).toBe(false);
		if (!result.allowed) {
			expect(result.code).toBe('AUTHORITY_ROOT_ESCAPE');
		}
	});

	it('still trusts a real linked worktree and allows writes inside it', () => {
		const linkedDir = path.join(sandboxDir, 'linked');
		git(`worktree add "${linkedDir}" -b feat/linked`, mainRepoDir);
		clearGuardrailsCaches();
		const worktrees = getLinkedGitWorktrees(mainRepoDir);
		expect(worktrees.some((wt) => wt === canonicalize(linkedDir))).toBe(true);
		const result = checkFileAuthority(
			'architect',
			path.join(linkedDir, 'src', 'index.ts'),
			mainRepoDir,
		);
		expect(result.allowed).toBe(true);
	});

	it('rejects a self-referential fake worktree whose gitdir lives outside .git/worktrees', () => {
		// Both sides of this forgery are attacker-writable repo content: a fake
		// worktree directory whose .git file and gitdir file point at each
		// other, registered from .git/worktrees/evil-x. The round-trip leg
		// alone accepts the pair; the repo-anchor leg (the registration gitdir
		// must live under .git/worktrees/) is what rejects it.
		const fakeDir = path.join(mainRepoDir, 'evil-dir');
		fsSync.mkdirSync(fakeDir, { recursive: true });
		fsSync.writeFileSync(path.join(fakeDir, '.git'), `gitdir: ${fakeDir}\n`);
		fsSync.writeFileSync(
			path.join(fakeDir, 'gitdir'),
			`${path.join(fakeDir, '.git')}\n`,
		);
		const evilReg = path.join(mainRepoDir, '.git', 'worktrees', 'evil-x');
		fsSync.mkdirSync(evilReg, { recursive: true });
		fsSync.writeFileSync(
			path.join(evilReg, 'gitdir'),
			`${path.join(fakeDir, '.git')}\n`,
		);
		fsSync.writeFileSync(path.join(evilReg, 'HEAD'), 'ref: main\n');
		clearGuardrailsCaches();
		const worktrees = getLinkedGitWorktrees(mainRepoDir);
		expect(worktrees.some((wt) => wt === canonicalize(fakeDir))).toBe(false);
	});

	it('skips a bare repository record so its git dir is not a trusted root', () => {
		const bareDir = path.join(sandboxDir, 'bare-repo.git');
		const seedDir = path.join(sandboxDir, 'seed');
		fsSync.mkdirSync(seedDir, { recursive: true });
		git('init -b main', seedDir);
		git('config user.name "Test"', seedDir);
		git('config user.email "test@example.com"', seedDir);
		fsSync.writeFileSync(path.join(seedDir, 'seed.txt'), 'seed\n');
		git('add -A', seedDir);
		git('commit -m seed', seedDir);
		git(`clone --bare "${seedDir}" "${bareDir}"`, sandboxDir);
		const linkedFromBare = path.join(sandboxDir, 'bare-linked');
		git(`worktree add "${linkedFromBare}" -b bare-linked`, bareDir);
		clearGuardrailsCaches();
		const worktrees = getLinkedGitWorktrees(linkedFromBare);
		expect(worktrees.some((wt) => wt === canonicalize(bareDir))).toBe(false);
		const result = checkFileAuthority(
			'architect',
			path.join(bareDir, 'hooks', 'pre-commit'),
			linkedFromBare,
		);
		expect(result.allowed).toBe(false);
		if (!result.allowed) {
			expect(result.code).toBe('AUTHORITY_ROOT_ESCAPE');
		}
	});

	it('re-roots to the longest matching worktree so deny rules resolve against the right root', () => {
		const nestedDir = path.join(sandboxDir, 'nested-linked');
		git(`worktree add "${nestedDir}" -b feat/nested`, mainRepoDir);
		clearGuardrailsCaches();
		// cwd is a SIBLING worktree; the target lives inside the OTHER linked
		// worktree's .git tree. Both the main repo and nestedDir contain the
		// target, so first-match would re-root to the main repo and resolve
		// the '.git' deny prefix against mainRepoDir (no match); longest-match
		// re-roots to nestedDir where the prefix resolves and denies.
		// Target the .git entry itself (a file in a linked worktree on every
		// platform) so resolution never depends on a nonexistent path's
		// platform-specific fallback.
		const target = path.join(nestedDir, '.git');
		const cwdWorktree = path.join(sandboxDir, 'linked');
		git(`worktree add "${cwdWorktree}" -b feat/cwd`, mainRepoDir);
		clearGuardrailsCaches();
		const result = checkFileAuthority(
			'architect',
			target,
			cwdWorktree,
			undefined,
			{
				universalDenyPrefixes: ['.git'],
			},
		);
		expect(result.allowed).toBe(false);
		if (!result.allowed) {
			expect(result.code).toBe('AUTHORITY_UNIVERSAL_DENY');
		}
		// Control: a plain source file inside the same worktree is still
		// allowed (relative path resolves against the matched root).
		const control = checkFileAuthority(
			'architect',
			path.join(nestedDir, 'src', 'index.ts'),
			cwdWorktree,
		);
		expect(control.allowed).toBe(true);
	});

	it('denies a new-file write through a planted symlink inside the matched worktree', () => {
		const linkedDir = path.join(sandboxDir, 'linked');
		git(`worktree add "${linkedDir}" -b feat/linked`, mainRepoDir);
		const outsideDir = path.join(sandboxDir, 'outside');
		fsSync.mkdirSync(outsideDir, { recursive: true });
		const linkPath = path.join(linkedDir, 'jlink');
		fsSync.symlinkSync(outsideDir, linkPath, 'junction');
		clearGuardrailsCaches();
		const result = checkFileAuthority(
			'architect',
			path.join(linkPath, 'new-file.txt'),
			mainRepoDir,
		);
		expect(result.allowed).toBe(false);
		if (!result.allowed) {
			expect(result.code).toBe('AUTHORITY_ROOT_ESCAPE');
		}
	});

	it('is unaffected by inherited GIT_DIR/GIT_WORK_TREE/GIT_INDEX_FILE', () => {
		const foreignDir = path.join(sandboxDir, 'foreign');
		fsSync.mkdirSync(foreignDir, { recursive: true });
		git('init -b main', foreignDir);
		const linkedDir = path.join(sandboxDir, 'linked');
		git(`worktree add "${linkedDir}" -b feat/linked`, mainRepoDir);
		clearGuardrailsCaches();
		const previous = {
			GIT_DIR: process.env.GIT_DIR,
			GIT_WORK_TREE: process.env.GIT_WORK_TREE,
			GIT_INDEX_FILE: process.env.GIT_INDEX_FILE,
		};
		process.env.GIT_DIR = foreignDir;
		process.env.GIT_WORK_TREE = foreignDir;
		process.env.GIT_INDEX_FILE = path.join(foreignDir, 'index');
		try {
			const worktrees = getLinkedGitWorktrees(mainRepoDir);
			expect(worktrees.some((wt) => wt === canonicalize(linkedDir))).toBe(true);
		} finally {
			for (const [key, value] of Object.entries(previous)) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
		}
	});
});
