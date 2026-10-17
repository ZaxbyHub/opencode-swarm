import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { execSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { checkFileAuthority } from '../../../src/hooks/guardrails/file-authority.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

describe('guardrails-worktree-authority - Git Worktree Containment Awareness', () => {
	let sandboxDir: string;
	let mainRepoDir: string;
	let worktreeDir: string;

	beforeEach(async () => {
		sandboxDir = canonicalMkdtemp('swarm-wt-test-');
		mainRepoDir = path.join(sandboxDir, 'main-repo');
		worktreeDir = path.join(sandboxDir, 'main-repo-worktree');

		await fs.mkdir(mainRepoDir, { recursive: true });

		// Initialise git repo and commit
		execSync('git init -b main', { cwd: mainRepoDir, stdio: 'pipe' });
		execSync('git config user.name "Test"', {
			cwd: mainRepoDir,
			stdio: 'pipe',
		});
		execSync('git config user.email "test@example.com"', {
			cwd: mainRepoDir,
			stdio: 'pipe',
		});
		execSync('git commit --allow-empty -m "initial commit"', {
			cwd: mainRepoDir,
			stdio: 'pipe',
		});

		// Create a linked worktree
		execSync(`git worktree add "${worktreeDir}" -b feat/worktree`, {
			cwd: mainRepoDir,
			stdio: 'pipe',
		});

		// Create source directories in both
		await fs.mkdir(path.join(mainRepoDir, 'src'), { recursive: true });
		await fs.mkdir(path.join(worktreeDir, 'src'), { recursive: true });
	});

	afterEach(async () => {
		try {
			await fs.rm(sandboxDir, { recursive: true, force: true });
		} catch {
			// ignore cleanup errors
		}
	});

	it('allows architect to write to a file inside a linked worktree using absolute path', () => {
		const targetFile = path.join(worktreeDir, 'src', 'index.ts');
		const result = checkFileAuthority('architect', targetFile, mainRepoDir);
		expect(result.allowed).toBe(true);
	});

	it('allows architect to write to a file inside a linked worktree using relative traversal path', () => {
		const relativePath = path.relative(
			mainRepoDir,
			path.join(worktreeDir, 'src', 'index.ts'),
		);
		// e.g. ../main-repo-worktree/src/index.ts
		expect(relativePath.startsWith('..')).toBe(true);

		const result = checkFileAuthority('architect', relativePath, mainRepoDir);
		expect(result.allowed).toBe(true);
	});

	it('allows coder to write to package.json inside a linked worktree when in declared scope', () => {
		const targetFile = path.join(worktreeDir, 'package.json');
		const result = checkFileAuthority(
			'coder',
			targetFile,
			mainRepoDir,
			undefined,
			{
				declaredScope: ['package.json'],
			},
		);
		expect(result.allowed).toBe(true);
		if (result.allowed) {
			expect(result.layer).toBe('declared-scope');
		}
	});

	it('denies coder from writing to package.json inside a linked worktree when not in declared scope', () => {
		const targetFile = path.join(worktreeDir, 'package.json');
		const result = checkFileAuthority('coder', targetFile, mainRepoDir);
		expect(result.allowed).toBe(false);
		if (!result.allowed) {
			expect(result.code).toBe('AUTHORITY_POLICY_DENY');
		}
	});

	it('still denies paths outside both cwd and any linked worktree with AUTHORITY_ROOT_ESCAPE', () => {
		const outsideFile = path.join(sandboxDir, 'unrelated-dir', 'secret.txt');
		const result = checkFileAuthority('architect', outsideFile, mainRepoDir);
		expect(result.allowed).toBe(false);
		if (!result.allowed) {
			expect(result.code).toBe('AUTHORITY_ROOT_ESCAPE');
		}
	});
});
