/**
 * Acceptance check C4 for issue #3317 (class: NEW-SURFACE).
 *
 * Retry semantics of readGitStatusAsync over the gitStatusReadInternals.readOnce
 * seam:
 *  - ETIMEDOUT / EBUSY / EPERM are transient: exactly one retry, so a
 *    first-call failure + second-call success resolves ok with readOnce called
 *    exactly 2 times;
 *  - ENOENT (binary missing) and a nonzero exit (status 128) are permanent:
 *    readOnce called exactly 1 time, result stays { ok:false }.
 *
 * RED at base (module src/commands/git-status-read does not exist), GREEN
 * after the fix.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import {
	type GitStatusReadResult,
	gitStatusReadInternals,
	readGitStatusAsync,
} from '../../../src/commands/git-status-read';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const tempRoots: string[] = [];

const originalReadOnce = gitStatusReadInternals.readOnce;

afterEach(() => {
	gitStatusReadInternals.readOnce = originalReadOnce;
	for (const root of tempRoots.splice(0)) {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

function transientFailure(code: string): GitStatusReadResult {
	return { ok: false, code, status: null, stderrTail: '' };
}

describe('readGitStatusAsync retry classification (#3317 C4)', () => {
	test.each([
		'ETIMEDOUT',
		'EBUSY',
		'EPERM',
	] as const)('transient spawn code %s is retried exactly once and then succeeds', async (code) => {
		const cwd = canonicalMkdtemp('3317-retry-');
		tempRoots.push(cwd);
		let calls = 0;
		gitStatusReadInternals.readOnce =
			async (): Promise<GitStatusReadResult> => {
				calls += 1;
				return calls === 1 ? transientFailure(code) : { ok: true, stdout: '' };
			};

		const result = await readGitStatusAsync(['status', '--porcelain'], cwd);

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.stdout).toBe('');
		}
		expect(calls).toBe(2);
	}, 30_000);

	test.each([
		{
			label: 'ENOENT',
			failure: { ok: false, code: 'ENOENT', status: null, stderrTail: '' },
		},
		{
			label: 'exit-128',
			failure: {
				ok: false,
				code: null,
				status: 128,
				stderrTail: 'fatal: index file smaller than expected',
			},
		},
	] as const)('permanent failure $label is not retried', async ({
		failure,
	}) => {
		const cwd = canonicalMkdtemp('3317-noretry-');
		tempRoots.push(cwd);
		let calls = 0;
		gitStatusReadInternals.readOnce =
			async (): Promise<GitStatusReadResult> => {
				calls += 1;
				return failure;
			};

		const result = await readGitStatusAsync(['status', '--porcelain'], cwd);

		expect(result.ok).toBe(false);
		expect(calls).toBe(1);
	}, 30_000);
});
