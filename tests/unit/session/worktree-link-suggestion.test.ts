import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	invalidateKnowledgeStoreDirCache,
	type LinkPointer,
	writeLinkPointer,
} from '../../../src/hooks/knowledge-link.js';
import { _internals } from '../../../src/session/worktree-link-suggestion.js';
import { createSafeTestDir } from '../../helpers/safe-test-dir.js';

function git(cwd: string, args: string[]): void {
	let lastError: unknown;
	for (let attempt = 0; attempt < 3; attempt++) {
		try {
			execFileSync('git', args, {
				cwd,
				stdio: 'ignore',
				timeout: 30_000,
			});
			return;
		} catch (error) {
			lastError = error;
			const code =
				typeof error === 'object' && error !== null && 'code' in error
					? String((error as { code?: unknown }).code)
					: '';
			if (!['ETIMEDOUT', 'EBUSY', 'EPERM'].includes(code)) break;
		}
	}
	throw lastError;
}

describe('worktree-link-suggestion', () => {
	beforeEach(() => {
		_internals.resetSuggested();
		invalidateKnowledgeStoreDirCache();
	});
	afterEach(() => {
		_internals.resetSuggested();
		invalidateKnowledgeStoreDirCache();
	});

	test('countWorktrees returns 0 for a non-git directory (fail-open)', async () => {
		const { dir, cleanup } = createSafeTestDir('wt-suggest-nongit-');
		try {
			expect(await _internals.countWorktrees(dir)).toBe(0);
		} finally {
			cleanup();
		}
	});

	test('does not suggest for a single-worktree repo', async () => {
		const { dir, cleanup } = createSafeTestDir('wt-suggest-single-');
		try {
			git(dir, ['init', '-q']);
			fs.writeFileSync(path.join(dir, 'f.txt'), 'x');
			git(dir, ['add', '.']);
			git(dir, [
				'-c',
				'user.email=t@t.t',
				'-c',
				'user.name=t',
				'commit',
				'-q',
				'-m',
				'init',
			]);

			expect(await _internals.countWorktrees(dir)).toBe(1);
			const warn = spyOn(console, 'warn').mockImplementation(() => {});
			await _internals.maybeSuggestWorktreeLink(dir, 'sess-single');
			expect(warn).not.toHaveBeenCalled();
			warn.mockRestore();
		} finally {
			cleanup();
		}
	});

	test('suggests once for a multi-worktree, unlinked repo; dedups per session; silent once linked', async () => {
		const main = createSafeTestDir('wt-suggest-main-');
		const wtHost = createSafeTestDir('wt-suggest-host-');
		try {
			git(main.dir, ['init', '-q']);
			fs.writeFileSync(path.join(main.dir, 'f.txt'), 'x');
			git(main.dir, ['add', '.']);
			git(main.dir, [
				'-c',
				'user.email=t@t.t',
				'-c',
				'user.name=t',
				'commit',
				'-q',
				'-m',
				'init',
			]);

			const wtPath = path.join(wtHost.dir, 'wt2');
			git(main.dir, ['worktree', 'add', '-q', wtPath]);

			expect(await _internals.countWorktrees(main.dir)).toBe(2);

			// Unlinked + 2 worktrees → suggestion fires once.
			const warn = spyOn(console, 'warn').mockImplementation(() => {});
			await _internals.maybeSuggestWorktreeLink(main.dir, 'sess-multi');
			expect(warn).toHaveBeenCalledTimes(1);
			expect(String(warn.mock.calls[0]?.[0])).toContain('/swarm link');

			// Same session again → deduped (no second warning).
			await _internals.maybeSuggestWorktreeLink(main.dir, 'sess-multi');
			expect(warn).toHaveBeenCalledTimes(1);
			warn.mockRestore();

			// Once linked, a fresh session does not suggest.
			_internals.resetSuggested();
			const pointer: LinkPointer = {
				version: 1,
				linkId: 'linked-proj',
				createdAt: new Date().toISOString(),
				source: 'manual',
			};
			await writeLinkPointer(main.dir, pointer);
			const warn2 = spyOn(console, 'warn').mockImplementation(() => {});
			await _internals.maybeSuggestWorktreeLink(main.dir, 'sess-after-link');
			expect(warn2).not.toHaveBeenCalled();
			warn2.mockRestore();

			// Clean up the linked worktree to avoid leaking git worktree registrations.
			try {
				git(main.dir, ['worktree', 'remove', '--force', wtPath]);
			} catch {
				/* best-effort */
			}
		} finally {
			main.cleanup();
			wtHost.cleanup();
		}
	});
});
