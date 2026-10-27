/**
 * Supplementary bounds tests for issue #3317 (not frozen):
 *  (a) the reader honors a per-call maxBufferBytes — a listing-shaped child
 *      whose output exceeds the 1 MB default but stays under an explicit 32 MB
 *      bound must NOT be rejected as overflowing;
 *  (b) THE WIRING — `runGitBuffered`'s default (driven through
 *      `untrackedPathsInTargetTree`) must deliver maxBufferBytes === 32 MB at
 *      the `readOnce` seam. This is the pin for the plan-critic round-1
 *      Critical 1: wiring the listing reads through the reader with the 1 MB
 *      default would silently shrink the rollback destruction scope on any
 *      repository whose `ls-tree -r` output exceeds 1 MB;
 *  (c) a second transient failure is final — exactly two attempts.
 *
 * GREEN only after the fix (the module does not exist at base).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	type GitStatusReadResult,
	gitStatusReadInternals,
	readGitStatusAsync,
} from '../../../src/commands/git-status-read';
import { untrackedPathsInTargetTree } from '../../../src/commands/rollback-gate';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const tempRoots: string[] = [];

const originalReadOnce = gitStatusReadInternals.readOnce;
const originalResolveExecutable = gitStatusReadInternals.resolveExecutable;

afterEach(() => {
	gitStatusReadInternals.readOnce = originalReadOnce;
	gitStatusReadInternals.resolveExecutable = originalResolveExecutable;
	for (const root of tempRoots.splice(0)) {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

describe('git-status reader output bounds and retry finals (#3317 supplement)', () => {
	test('a 1.5 MB listing read is ok under an explicit 32 MB bound and fails under the 1 MB default', async () => {
		const cwd = canonicalMkdtemp('3317-bounds-');
		tempRoots.push(cwd);
		gitStatusReadInternals.resolveExecutable = async () => process.execPath;
		// ~1.5 MB of output: above the 1 MB default, far under 32 MB.
		// writeSync to fd 1 (not stdout.write): an async write can race the
		// child's exit and deliver a partial stream on bun 1.3.13 runners.
		const args = [
			'-e',
			"const b = Buffer.alloc(64 * 1024, 120); for (let i = 0; i < 24; i++) require('node:fs').writeSync(1, b);",
		];

		const under32 = await readGitStatusAsync(args, cwd, {
			timeoutMs: 20_000,
			maxBufferBytes: 32 * 1024 * 1024,
		});
		expect(under32.ok).toBe(true);
		if (under32.ok) {
			expect(under32.stdout.length).toBe(1536 * 1024);
		}

		const underDefault = await readGitStatusAsync(args, cwd, {
			timeoutMs: 20_000,
		});
		expect(underDefault.ok).toBe(false);
		if (!underDefault.ok) {
			expect(underDefault.stderrTail).toContain('exceeded');
		}
	}, 60_000);

	test('runGitBuffered wiring: untrackedPathsInTargetTree delivers the 32 MB listing bound at the readOnce seam', async () => {
		const root = canonicalMkdtemp('3317-wiring-');
		tempRoots.push(root);
		// Marker repo shape only — the readOnce stub answers the reads.
		fs.mkdirSync(path.join(root, '.git'), { recursive: true });
		fs.writeFileSync(path.join(root, '.git', 'HEAD'), '');

		const seenBounds: Array<number | undefined> = [];
		gitStatusReadInternals.readOnce = (async (
			_args: readonly string[],
			_cwd: string,
			_timeoutMs: number,
			maxBufferBytes?: number,
		): Promise<GitStatusReadResult> => {
			seenBounds.push(maxBufferBytes);
			return { ok: true, stdout: '' };
		}) as typeof gitStatusReadInternals.readOnce;

		await untrackedPathsInTargetTree(root, 'deadbeef');

		// Both listing reads (ls-tree + ls-files) went through the reader with
		// the explicit 32 MB listing bound — NOT the 1 MB default.
		expect(seenBounds.length).toBe(2);
		for (const bound of seenBounds) {
			expect(bound).toBe(32 * 1024 * 1024);
		}
	}, 30_000);

	test('a second transient failure is final: exactly two attempts', async () => {
		const cwd = canonicalMkdtemp('3317-retry-final-');
		tempRoots.push(cwd);
		let calls = 0;
		gitStatusReadInternals.readOnce =
			async (): Promise<GitStatusReadResult> => {
				calls += 1;
				return { ok: false, code: 'ETIMEDOUT', status: null, stderrTail: '' };
			};

		const result = await readGitStatusAsync(['status', '--porcelain'], cwd);

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.code).toBe('ETIMEDOUT');
		}
		expect(calls).toBe(2);
	}, 30_000);
});
