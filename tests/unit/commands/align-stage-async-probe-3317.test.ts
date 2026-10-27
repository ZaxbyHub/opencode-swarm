/**
 * #3427 (trace 3427-3434-rollback-gate-hardening, check C2): the finalize
 * align stage reads repository status through the ASYNC, reader-backed close
 * seam, never the old sync gitExec chain.
 *
 * Discrimination design (the await pin):
 * - a SOURCE pin requires the exact awaited statement
 *   `await _internals.getGitRepositoryStatus(` in align-stage.ts — the old
 *   unawaited statement cannot satisfy it;
 * - a TRUE-repo behavioral leg resolves the seam to `{isRepo: true}` and
 *   requires the reset seam to fire — an unawaited Promise leaves
 *   `isRepo` undefined, skips the reset, and fails the leg;
 * - the non-repo leg requires the verbatim skip note.
 *
 * Also hosts the detailed reader classifier's direct tests
 * (readGitRepositoryStatusDetailedAsync): the #2236 three-way ENOENT split
 * (cwd fault is git_error naming the cwd, never git_unavailable), the
 * stderr-vocabulary not_git_repo classification, and the code-carrying
 * git_error messages on timeout/empty-stderr shapes.
 */
import { afterEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { runAlignStage } from '../../../src/commands/close/align-stage';
import type { CloseStageContext } from '../../../src/commands/close/context';
import { _internals as closeInternals } from '../../../src/commands/close/internals';
import {
	type GitStatusReadResult,
	gitStatusReadInternals,
	readGitRepositoryStatusDetailedAsync,
} from '../../../src/commands/git-status-read';
import { readSource } from '../../helpers/no-sync-spawn-detector';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const originalReadOnce = gitStatusReadInternals.readOnce;
const originalSeam = closeInternals.getGitRepositoryStatus;
const originalReset = closeInternals.resetToMainAfterMerge;
const originalResetRemote = closeInternals.resetToRemoteBranch;

afterEach(() => {
	gitStatusReadInternals.readOnce = originalReadOnce;
	closeInternals.getGitRepositoryStatus = originalSeam;
	closeInternals.resetToMainAfterMerge = originalReset;
	closeInternals.resetToRemoteBranch = originalResetRemote;
	mock.restore();
});

function stubReadOnce(result: GitStatusReadResult): void {
	gitStatusReadInternals.readOnce = (async () =>
		result) as typeof gitStatusReadInternals.readOnce;
}

function makeCtx(directory: string): CloseStageContext {
	return {
		directory,
		args: [],
		warnings: [],
	} as unknown as CloseStageContext;
}

describe('align stage reads through the async reader seam (#3427 C2)', () => {
	test('feedback PRR-013: wireCloseInternals installs the async reader as the seam value', async () => {
		// The call-site pins below would stay green if wiring.ts reverted to
		// the sync branch.getGitRepositoryStatus (the suites overwrite the
		// seam themselves) — this pin binds the INSTALL: after the real
		// wireCloseInternals() runs, the seam slot IS the detailed reader.
		const { wireCloseInternals } = await import(
			'../../../src/commands/close/wiring'
		);
		const { readGitRepositoryStatusDetailedAsync: reader } = await import(
			'../../../src/commands/git-status-read'
		);
		wireCloseInternals();
		expect(closeInternals.getGitRepositoryStatus).toBe(reader);
	});

	test('source pin: the repository probe is the exact awaited seam call', () => {
		const src = readSource('src/commands/close/align-stage.ts');
		// The awaited form is the discrimination target: the pre-#3427
		// statement assigned the seam result WITHOUT await.
		expect(src.includes('await _internals.getGitRepositoryStatus(')).toBe(true);
	});

	test('non-repo: seam resolves not_git_repo and the skip note is verbatim', async () => {
		const tempDir = canonicalMkdtemp('c2-nonrepo-');
		try {
			let seamCalls = 0;
			closeInternals.getGitRepositoryStatus = (async () => {
				seamCalls += 1;
				return {
					isRepo: false,
					reason: 'not_git_repo',
					message: 'rev-parse failed',
				};
			}) as unknown as typeof closeInternals.getGitRepositoryStatus;

			const result = await runAlignStage(makeCtx(tempDir));

			expect(seamCalls).toBe(1);
			expect(result.gitAlignResult).toBe(
				'Not a git repository — skipped git alignment',
			);
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	test('true-repo: the resolved value drives the reset seam (a missing await skips it and fails)', async () => {
		const tempDir = canonicalMkdtemp('c2-repo-');
		try {
			let resetCalls = 0;
			closeInternals.getGitRepositoryStatus = (async () => {
				return { isRepo: true };
			}) as unknown as typeof closeInternals.getGitRepositoryStatus;
			closeInternals.resetToMainAfterMerge = (async () => {
				resetCalls += 1;
				return {
					success: true,
					targetBranch: 'origin/main',
					previousBranch: 'main',
					message: 'Already on main',
					branchDeleted: false,
					changesDiscarded: false,
					warnings: [],
				};
			}) as unknown as typeof closeInternals.resetToMainAfterMerge;

			await runAlignStage(makeCtx(tempDir));

			// With the await present, {isRepo:true} reaches the branch and the
			// reset seam fires. Without the await, gitStatus would be a Promise
			// whose .isRepo is undefined — the else chain would skip the reset
			// and this assertion would fail.
			expect(resetCalls).toBe(1);
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});
});

describe('readGitRepositoryStatusDetailedAsync classifier (branch.getGitRepositoryStatus parity)', () => {
	test('ok read in a live cwd: isRepo true', async () => {
		stubReadOnce({ ok: true, stdout: '.git\n' });
		const live = canonicalMkdtemp('c2-live-');
		try {
			const status = await readGitRepositoryStatusDetailedAsync(live);
			expect(status.isRepo).toBe(true);
		} finally {
			fs.rmSync(live, { recursive: true, force: true });
		}
	});

	test('ENOENT with a LIVE cwd: binary missing → git_unavailable', async () => {
		stubReadOnce({
			ok: false,
			code: 'ENOENT',
			status: null,
			stderrTail: '',
		});
		const live = canonicalMkdtemp('c2-enoent-live-');
		try {
			const status = await readGitRepositoryStatusDetailedAsync(live);
			expect(status.isRepo).toBe(false);
			if (!status.isRepo) {
				expect(status.reason).toBe('git_unavailable');
				expect(status.message).toContain('git executable is not available');
			}
		} finally {
			fs.rmSync(live, { recursive: true, force: true });
		}
	});

	test('ENOENT with a MISSING cwd: #2236 parity → git_error naming the cwd, never git_unavailable', async () => {
		stubReadOnce({
			ok: false,
			code: 'ENOENT',
			status: null,
			stderrTail: '',
		});
		const missing = path.join(canonicalMkdtemp('c2-enoent-root-'), 'gone');
		const status = await readGitRepositoryStatusDetailedAsync(missing);
		expect(status.isRepo).toBe(false);
		if (!status.isRepo) {
			expect(status.reason).toBe('git_error');
			expect(status.message).toContain(missing);
			expect(status.reason).not.toBe('git_unavailable');
		}
	});

	test('nonzero exit whose stderr matches the repo vocabulary → not_git_repo', async () => {
		stubReadOnce({
			ok: false,
			code: null,
			status: 128,
			stderrTail:
				'fatal: not a git repository (or any of the parent directories)',
		});
		const live = canonicalMkdtemp('c2-notrepo-');
		try {
			const status = await readGitRepositoryStatusDetailedAsync(live);
			expect(status.isRepo).toBe(false);
			if (!status.isRepo) {
				expect(status.reason).toBe('not_git_repo');
				expect(status.message).toContain('not a git repository');
			}
		} finally {
			fs.rmSync(live, { recursive: true, force: true });
		}
	});

	test('other nonzero exit → git_error carrying the exit status', async () => {
		stubReadOnce({
			ok: false,
			code: null,
			status: 129,
			stderrTail: 'fatal: usage',
		});
		const live = canonicalMkdtemp('c2-giterror-');
		try {
			const status = await readGitRepositoryStatusDetailedAsync(live);
			expect(status.isRepo).toBe(false);
			if (!status.isRepo) {
				expect(status.reason).toBe('git_error');
				expect(status.message).toContain('129');
			}
		} finally {
			fs.rmSync(live, { recursive: true, force: true });
		}
	});

	test('timeout with empty stderr → git_error whose message still carries the code', async () => {
		stubReadOnce({
			ok: false,
			code: 'ETIMEDOUT',
			status: null,
			stderrTail: '',
		});
		const live = canonicalMkdtemp('c2-timeout-');
		try {
			const status = await readGitRepositoryStatusDetailedAsync(live);
			expect(status.isRepo).toBe(false);
			if (!status.isRepo) {
				// Empty stderr must never discard the failure class.
				expect(status.reason).toBe('git_error');
				expect(status.message).toContain('ETIMEDOUT');
			}
		} finally {
			fs.rmSync(live, { recursive: true, force: true });
		}
	});
});
