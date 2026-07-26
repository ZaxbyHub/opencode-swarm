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
