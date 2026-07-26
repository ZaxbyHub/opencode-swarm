import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	buildReviewerTaskScope,
	_internals as receiptScopeInternals,
} from '../../../src/hooks/review-receipt-scope';

let directory: string;
let outsideDirectory: string | undefined;
const originalSpawn = receiptScopeInternals.spawn;
const originalRealpath = receiptScopeInternals.realpath;
const originalLstat = receiptScopeInternals.lstat;
const originalOpen = receiptScopeInternals.open;

function git(args: string[]): string {
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
	return result.stdout.trim();
}

beforeEach(() => {
	directory = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), 'review-receipt-race-')),
	);
	git(['init', '-b', 'main']);
	git(['config', 'user.name', 'Receipt Race']);
	git(['config', 'user.email', 'race@example.invalid']);
	fs.mkdirSync(path.join(directory, 'src'));
	fs.writeFileSync(path.join(directory, 'src', 'actual.ts'), 'baseline\n');
	git(['add', 'src/actual.ts']);
	git(['commit', '-m', 'baseline']);
});

afterEach(() => {
	receiptScopeInternals.spawn = originalSpawn;
	receiptScopeInternals.realpath = originalRealpath;
	receiptScopeInternals.lstat = originalLstat;
	receiptScopeInternals.open = originalOpen;
	fs.rmSync(directory, { recursive: true, force: true });
	if (outsideDirectory) {
		fs.rmSync(outsideDirectory, { recursive: true, force: true });
		outsideDirectory = undefined;
	}
});

describe('reviewer receipt scope - regression: coherent snapshots (F6.3)', () => {
	test('rejects a HEAD advance between the initial SHA and file reads', async () => {
		const initialHead = git(['rev-parse', 'HEAD']);
		let advanced = false;
		receiptScopeInternals.spawn = ((command, args, options) => {
			const child = originalSpawn(command, args, options);
			if (!advanced) {
				advanced = true;
				child.once('close', () => {
					fs.writeFileSync(
						path.join(directory, 'src', 'actual.ts'),
						'advanced checkout\n',
					);
					git(['add', 'src/actual.ts']);
					git(['commit', '-m', 'advance during scope build']);
				});
			}
			return child;
		}) as typeof originalSpawn;

		// Previous code captured HEAD only once and returned a mixed receipt scope
		// containing the old SHA and bytes read after the commit advanced.
		const scope = await buildReviewerTaskScope(directory, ['src/actual.ts']);
		expect(git(['rev-parse', 'HEAD'])).not.toBe(initialHead);
		expect(scope).toBeNull();
	});

	test('rejects a parent junction swap between realpath and open', async () => {
		const sourcePath = path.join(directory, 'src', 'actual.ts');
		const sourceBytes = Buffer.from('A'.repeat(64));
		fs.writeFileSync(sourcePath, sourceBytes);
		const sharedTimestamp = new Date(Math.floor(Date.now() / 1_000) * 1_000);
		fs.utimesSync(sourcePath, sharedTimestamp, sharedTimestamp);
		const sourceStat = fs.statSync(sourcePath);

		outsideDirectory = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), 'review-receipt-outside-')),
		);
		const outsidePath = path.join(outsideDirectory, 'actual.ts');
		const outsideBytes = Buffer.from(
			`OUTSIDE_SECRET_SENTINEL${'Z'.repeat(
				sourceBytes.byteLength - 'OUTSIDE_SECRET_SENTINEL'.length,
			)}`,
		);
		fs.writeFileSync(outsidePath, outsideBytes);
		fs.utimesSync(outsidePath, sharedTimestamp, sharedTimestamp);
		expect(fs.statSync(outsidePath).size).toBe(sourceStat.size);
		expect(fs.statSync(outsidePath).mtimeMs).toBe(sourceStat.mtimeMs);

		const sourceDirectory = path.dirname(sourcePath);
		let swapped = false;
		let linkUnavailableCode: string | undefined;
		receiptScopeInternals.realpath = (async (candidate) => {
			const canonical = await originalRealpath(candidate);
			if (
				!swapped &&
				path.resolve(String(candidate)) === path.resolve(sourcePath)
			) {
				fs.rmSync(sourceDirectory, { recursive: true, force: true });
				try {
					fs.symlinkSync(
						outsideDirectory as string,
						sourceDirectory,
						process.platform === 'win32' ? 'junction' : 'dir',
					);
					swapped = true;
				} catch (error) {
					linkUnavailableCode = (error as NodeJS.ErrnoException).code;
				}
			}
			return canonical;
		}) as typeof originalRealpath;

		const scope = await buildReviewerTaskScope(directory, ['src/actual.ts']);
		if (!swapped) {
			expect(['EACCES', 'ENOSYS', 'EPERM']).toContain(linkUnavailableCode);
			return;
		}
		// Previous pathname-based read accepted the outside file when its size and
		// mtime matched, binding a receipt to bytes outside the project root.
		expect(scope).toBeNull();
	});
});
