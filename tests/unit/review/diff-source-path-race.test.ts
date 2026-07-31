import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	collectReviewDiff,
	_internals as diffSourceInternals,
} from '../../../src/review/diff-source';

const originalRealpathSync = diffSourceInternals.realpathSync;
const originalLstatBigIntSync = diffSourceInternals.lstatBigIntSync;
const originalFstatBigIntSync = diffSourceInternals.fstatBigIntSync;
const cleanupPaths: string[] = [];

function temporaryDirectory(prefix: string): string {
	const directory = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), prefix)),
	);
	cleanupPaths.push(directory);
	return directory;
}

function git(directory: string, args: string[]): string {
	const result = spawnSync('git', args, {
		cwd: directory,
		encoding: 'utf8',
		timeout: 5_000,
		maxBuffer: 64 * 1024,
		stdio: ['ignore', 'pipe', 'pipe'],
		windowsHide: true,
	});
	if (result.status !== 0) {
		throw new Error(result.stderr || `git ${args.join(' ')} failed`);
	}
	return result.stdout;
}

afterEach(() => {
	diffSourceInternals.realpathSync = originalRealpathSync;
	diffSourceInternals.lstatBigIntSync = originalLstatBigIntSync;
	diffSourceInternals.fstatBigIntSync = originalFstatBigIntSync;
	for (const target of cleanupPaths.splice(0).reverse()) {
		fs.rmSync(target, { recursive: true, force: true });
	}
});

describe('review diff source - regression: parent reparse swap (F6.2)', () => {
	test('never includes outside-project bytes after a parent path swap', async () => {
		const directory = temporaryDirectory('review-diff-race-');
		const outsideDirectory = temporaryDirectory('review-diff-outside-');
		git(directory, ['init', '-b', 'main']);
		git(directory, ['config', 'user.name', 'Review Diff Race']);
		git(directory, ['config', 'user.email', 'race@example.invalid']);
		fs.writeFileSync(path.join(directory, 'tracked.txt'), 'baseline\n');
		git(directory, ['add', 'tracked.txt']);
		git(directory, ['commit', '-m', 'baseline']);

		const victimDirectory = path.join(directory, 'victim');
		const victimPath = path.join(victimDirectory, 'file.txt');
		fs.mkdirSync(victimDirectory);
		fs.writeFileSync(victimPath, 'benign repository content\n');
		fs.writeFileSync(
			path.join(outsideDirectory, 'file.txt'),
			'OUTSIDE_SECRET_SENTINEL\n',
		);

		let swapped = false;
		let linkUnavailableCode: string | undefined;
		diffSourceInternals.realpathSync = ((candidate, ...rest) => {
			const canonical = originalRealpathSync(candidate, ...rest);
			if (
				!swapped &&
				path.resolve(String(candidate)) === path.resolve(victimPath)
			) {
				fs.rmSync(victimDirectory, { recursive: true, force: true });
				try {
					fs.symlinkSync(
						outsideDirectory,
						victimDirectory,
						process.platform === 'win32' ? 'junction' : 'dir',
					);
					swapped = true;
				} catch (error) {
					linkUnavailableCode = (error as NodeJS.ErrnoException).code;
				}
			}
			return canonical;
		}) as typeof originalRealpathSync;

		const result = await collectReviewDiff({
			directory,
			selector: { kind: 'working-tree' },
		});

		if (!swapped) {
			expect(['EACCES', 'ENOSYS', 'EPERM']).toContain(linkUnavailableCode);
			return;
		}
		expect(result.status).toBe('ok');
		if (result.status === 'error') return;
		// Previous code opened the stale pathname after realpath validation,
		// marked the scope complete, and sent OUTSIDE_SECRET_SENTINEL to the model.
		expect(result.canonicalText).not.toContain('OUTSIDE_SECRET_SENTINEL');
		expect(result.completeness.complete).toBe(false);
		expect(result.completeness.skipReasons).toContainEqual(
			expect.objectContaining({
				code: 'CONCURRENT_PATH_MUTATION',
				path: 'victim/file.txt',
			}),
		);
	});
});

describe('review diff source - regression: canonical root aliases', () => {
	test('accepts distinct path spellings that identify the same real directory', async () => {
		const directory = temporaryDirectory('review-diff-root-alias-');
		git(directory, ['init', '-b', 'main']);
		git(directory, ['config', 'user.name', 'Review Root Alias']);
		git(directory, ['config', 'user.email', 'alias@example.invalid']);
		fs.writeFileSync(path.join(directory, 'tracked.txt'), 'baseline\n');
		git(directory, ['add', 'tracked.txt']);
		git(directory, ['commit', '-m', 'baseline']);

		const alias = `${directory}-textual-alias`;
		let realpathCalls = 0;
		let aliasIdentityReads = 0;
		diffSourceInternals.realpathSync = ((candidate, ...rest) => {
			const canonical = originalRealpathSync(candidate, ...rest);
			realpathCalls++;
			return realpathCalls === 2 ? alias : canonical;
		}) as typeof originalRealpathSync;
		diffSourceInternals.lstatBigIntSync = ((candidate) => {
			if (path.resolve(String(candidate)) === path.resolve(alias)) {
				aliasIdentityReads++;
				return originalLstatBigIntSync(directory);
			}
			return originalLstatBigIntSync(candidate);
		}) as typeof originalLstatBigIntSync;

		// Previous code compared only path text, so Windows runner aliases for the
		// same directory failed before any review diff could be collected.
		const result = await collectReviewDiff({
			directory,
			selector: { kind: 'working-tree' },
		});

		expect(realpathCalls).toBe(2);
		expect(aliasIdentityReads).toBe(1);
		expect(result.status).toBe('clean');
	});

	test('rejects distinct directories whose numeric inode values collide', async () => {
		const directory = temporaryDirectory('review-diff-root-collision-');
		git(directory, ['init', '-b', 'main']);
		git(directory, ['config', 'user.name', 'Review Root Collision']);
		git(directory, ['config', 'user.email', 'collision@example.invalid']);
		fs.writeFileSync(path.join(directory, 'tracked.txt'), 'baseline\n');
		git(directory, ['add', 'tracked.txt']);
		git(directory, ['commit', '-m', 'baseline']);

		const alias = `${directory}-colliding-root`;
		const leftInode = 9_007_199_254_740_992n;
		const rightInode = leftInode + 1n;
		expect(Number(leftInode)).toBe(Number(rightInode));

		let realpathCalls = 0;
		diffSourceInternals.realpathSync = ((candidate, ...rest) => {
			const canonical = originalRealpathSync(candidate, ...rest);
			realpathCalls++;
			return realpathCalls === 2 ? alias : canonical;
		}) as typeof originalRealpathSync;

		const baseStats = originalLstatBigIntSync(directory);
		const statsWithInode = (ino: bigint): fs.BigIntStats =>
			({
				...baseStats,
				dev: 1n,
				ino,
				isDirectory: () => true,
				isSymbolicLink: () => false,
			}) as fs.BigIntStats;
		diffSourceInternals.lstatBigIntSync = ((candidate) =>
			path.resolve(String(candidate)) === path.resolve(alias)
				? statsWithInode(rightInode)
				: statsWithInode(leftInode)) as typeof originalLstatBigIntSync;

		const result = await collectReviewDiff({
			directory,
			selector: { kind: 'working-tree' },
		});

		expect(realpathCalls).toBe(2);
		expect(result.status).toBe('error');
		if (result.status === 'error') {
			expect(result.code).toBe('NOT_REPOSITORY_ROOT');
		}
	});

	test('rejects an untracked path and descriptor whose numeric inodes collide', async () => {
		const directory = temporaryDirectory('review-diff-file-collision-');
		git(directory, ['init', '-b', 'main']);
		git(directory, ['config', 'user.name', 'Review File Collision']);
		git(directory, ['config', 'user.email', 'file-collision@example.invalid']);
		fs.writeFileSync(path.join(directory, 'tracked.txt'), 'baseline\n');
		git(directory, ['add', 'tracked.txt']);
		git(directory, ['commit', '-m', 'baseline']);

		const untrackedPath = path.join(directory, 'untracked.txt');
		fs.writeFileSync(untrackedPath, 'COLLIDING_FILE_SENTINEL\n');
		const leftInode = 9_007_199_254_740_992n;
		const rightInode = leftInode + 1n;
		expect(Number(leftInode)).toBe(Number(rightInode));

		const baseStats = originalLstatBigIntSync(untrackedPath);
		const statsWithInode = (ino: bigint): fs.BigIntStats =>
			({
				...baseStats,
				dev: 1n,
				ino,
				isFile: () => true,
				isSymbolicLink: () => false,
			}) as fs.BigIntStats;
		diffSourceInternals.lstatBigIntSync = ((candidate) =>
			path.resolve(String(candidate)) === path.resolve(untrackedPath)
				? statsWithInode(leftInode)
				: originalLstatBigIntSync(candidate)) as typeof originalLstatBigIntSync;
		diffSourceInternals.fstatBigIntSync = (() =>
			statsWithInode(rightInode)) as typeof originalFstatBigIntSync;

		const result = await collectReviewDiff({
			directory,
			selector: { kind: 'working-tree' },
		});

		expect(result.status).toBe('ok');
		if (result.status === 'error') return;
		expect(result.canonicalText).not.toContain('COLLIDING_FILE_SENTINEL');
		expect(result.completeness.skipReasons).toContainEqual(
			expect.objectContaining({
				code: 'CONCURRENT_PATH_MUTATION',
				path: 'untracked.txt',
			}),
		);
	});
});
