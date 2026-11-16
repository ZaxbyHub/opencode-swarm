/**
 * Feedback-round coverage for `prepare_pr_feedback_commit_message` (F-R20,
 * directive 2): the tool's refusal branches and its authoring contract were
 * previously untested — only the classifier's `-F` admission (frozen C25 +
 * forms companion) exercised the concept. This file pins:
 *
 *   1. schema refusals (whitespace-only, over-cap, NUL),
 *   2. missing-sessionID refusal,
 *   3. unbound / wrong-mode refusal (PR_FEEDBACK binding required),
 *   4. the happy path: deterministic path under
 *      the system temp root's swarm-pr-feedback-commit-msg directory, mode
 *      0600, exact trimmed
 *      content, and IDEMPOTENCE (same message → same path, byte-identical),
 *   5. the 24h TTL prune of stale authored files on the next call,
 *   6. the TMPDIR-inside-repo refusal (platform-conditional: Bun on Windows
 *      ignores TMPDIR in the temp-root lookup, so the redirected leg only
 *      asserts on platforms where the redirect actually took effect — POSIX
 *      CI covers it deterministically).
 */

import { afterAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
	mkdirSync,
	realpathSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
} from 'node:fs';
import path, { join } from 'node:path';
import { closeAllProjectDbs } from '../../../src/db/project-db.js';
import { activatePrWorkflow } from '../../../src/hooks/pr-workflow-gate.js';
import { executePreparePrFeedbackCommitMessage } from '../../../src/tools/prepare-pr-feedback-commit-message.js';
import {
	canonicalMkdtemp,
	canonicalTmpDir as canonicalTempRoot,
	removeTreeWithRetry,
} from '../../helpers/tmpdir.js';

const SESSION_ID = 'commit-msg-tool-l2';
const MESSAGE_DIR = join(canonicalTempRoot(), 'swarm-pr-feedback-commit-msg');

function gitRun(dir: string, args: string[]): void {
	execFileSync('git', ['-C', dir, ...args], {
		stdio: 'ignore',
		timeout: 15_000,
	});
}

function gitHead(dir: string): string {
	return execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], {
		encoding: 'utf8',
		timeout: 15_000,
	}).trim();
}

function messagePath(sessionID: string, message: string): string {
	const sanitized = sessionID.replace(/[^A-Za-z0-9._-]/g, '_');
	const digest = createHash('sha256')
		.update(message, 'utf8')
		.digest('hex')
		.slice(0, 16);
	return join(MESSAGE_DIR, `${sanitized}-${digest}.txt`);
}

/** Real repo satisfying the first-bind tracking discipline, like frozen C25. */
async function createBoundFeedbackRepo(
	mode: 'PR_FEEDBACK' | 'PR_REVIEW',
): Promise<string> {
	const dir = canonicalMkdtemp('commit-msg-tool-');
	mkdirSync(join(dir, 'src'), { recursive: true });
	writeFileSync(join(dir, 'src', 'foo.ts'), 'export const a = 1;\n');
	gitRun(dir, ['init', '-q', '-b', 'main']);
	gitRun(dir, ['config', 'user.email', 'swarm-test@example.com']);
	gitRun(dir, ['config', 'user.name', 'Swarm Test']);
	gitRun(dir, ['add', '.']);
	gitRun(dir, ['commit', '-q', '-m', 'init']);
	const head = gitHead(dir);
	gitRun(dir, ['update-ref', 'refs/remotes/origin/pr-head', head]);
	gitRun(dir, [
		'config',
		'remote.origin.url',
		'https://github.com/example/repo.git',
	]);
	gitRun(dir, [
		'config',
		'remote.origin.fetch',
		'+refs/heads/*:refs/remotes/origin/*',
	]);
	gitRun(dir, ['config', 'branch.main.remote', 'origin']);
	gitRun(dir, ['config', 'branch.main.merge', 'refs/heads/pr-head']);
	await activatePrWorkflow(dir, SESSION_ID, mode, { prHeadSha: head });
	return dir;
}

const createdDirs: string[] = [];

afterAll(() => {
	closeAllProjectDbs();
	rmSync(MESSAGE_DIR, { recursive: true, force: true });
	for (const dir of createdDirs) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe('prepare_pr_feedback_commit_message refusal branches and authoring contract (F-R20)', () => {
	test('refuses whitespace-only, over-cap, and NUL messages with the schema refusal', async () => {
		const dir = await createBoundFeedbackRepo('PR_FEEDBACK');
		try {
			for (const message of ['   ', '\t\n', 'x'.repeat(8193), 'bad\0message']) {
				const outcome = await executePreparePrFeedbackCommitMessage(
					{ message },
					dir,
					{ sessionID: SESSION_ID },
				);
				const parsed = JSON.parse(outcome) as {
					success: boolean;
					message: string;
				};
				expect(parsed.success).toBe(false);
				expect(parsed.message).toMatch(/Invalid commit-message request/);
			}
		} finally {
			removeTreeWithRetry(dir);
		}
	});

	test('refuses without an active sessionID', async () => {
		const outcome = await executePreparePrFeedbackCommitMessage(
			{ message: 'fix: thing' },
			'.',
			{},
		);
		const parsed = JSON.parse(outcome) as { success: boolean; message: string };
		expect(parsed.success).toBe(false);
		expect(parsed.message).toMatch(/requires an active sessionID/);
	});

	test('refuses when no PR_FEEDBACK workflow is bound (unbound and wrong-mode)', async () => {
		const unbound = canonicalMkdtemp('commit-msg-tool-unbound-');
		createdDirs.push(unbound);
		const wrongMode = await createBoundFeedbackRepo('PR_REVIEW');
		try {
			for (const dir of [unbound, wrongMode]) {
				const outcome = await executePreparePrFeedbackCommitMessage(
					{ message: 'fix: thing' },
					dir,
					{ sessionID: SESSION_ID },
				);
				const parsed = JSON.parse(outcome) as {
					success: boolean;
					message: string;
				};
				expect(parsed.success).toBe(false);
				expect(parsed.message).toMatch(
					/requires an active bound PR_FEEDBACK workflow/,
				);
			}
		} finally {
			removeTreeWithRetry(wrongMode);
		}
	});

	test('authors the exact trimmed content outside the repository, idempotently, mode 0600', async () => {
		const dir = await createBoundFeedbackRepo('PR_FEEDBACK');
		try {
			const first = JSON.parse(
				await executePreparePrFeedbackCommitMessage(
					{
						message:
							'  fix: trailer <noreply@example.com>\n\nCo-Authored-By: X <y@z.dev>  ',
					},
					dir,
					{ sessionID: SESSION_ID },
				),
			) as { success: boolean; path: string; message: string };
			expect(first.success).toBe(true);
			const expected = messagePath(
				SESSION_ID,
				'fix: trailer <noreply@example.com>\n\nCo-Authored-By: X <y@z.dev>',
			);
			// The tool reports the raw temp-root spelling while MESSAGE_DIR is the
			// canonical one (/var vs /private/var on macOS): compare the basename
			// exactly and the directory through realpath.
			expect(path.basename(first.path)).toBe(path.basename(expected));
			expect(realpathSync(path.dirname(first.path))).toBe(
				realpathSync(path.dirname(expected)),
			);
			const written = await Bun.file(expected).text();
			expect(written).toBe(
				'fix: trailer <noreply@example.com>\n\nCo-Authored-By: X <y@z.dev>',
			);
			// Mode 0600 (owner read/write only) — asserted on POSIX where the bit
			// is enforced; Windows statSync emulates 0666 for a writable file, so
			// only the writer's successful creation is asserted there.
			const mode = statSync(expected).mode & 0o777;
			if (process.platform !== 'win32') {
				expect(mode).toBe(0o600);
			}
			// Idempotence: the same message resolves to the same path and the
			// rewrite converges to identical bytes.
			const second = JSON.parse(
				await executePreparePrFeedbackCommitMessage(
					{
						message:
							'fix: trailer <noreply@example.com>\n\nCo-Authored-By: X <y@z.dev>',
					},
					dir,
					{ sessionID: SESSION_ID },
				),
			) as { success: boolean; path: string };
			expect(second.success).toBe(true);
			expect(path.basename(second.path)).toBe(path.basename(expected));
			expect(await Bun.file(expected).text()).toBe(written);
		} finally {
			removeTreeWithRetry(dir);
		}
	});

	test('prunes authored files older than the 24h TTL on the next authoring call', async () => {
		const dir = await createBoundFeedbackRepo('PR_FEEDBACK');
		try {
			mkdirSync(MESSAGE_DIR, { recursive: true });
			// A fixed epoch ~26 years in the past: the tool's real-clock TTL read
			// (now - mtime > 24h) is deterministic with a margin of decades. (A
			// frozen-clock pin without options lands at epoch 0, and a negative
			// mtime cannot be represented in Windows FILETIME — it wraps to 2106
			// and looks fresh — hence the fixed historical epoch instead.)
			const staleTime = new Date('2000-01-01T00:00:00.000Z');
			const stale = join(MESSAGE_DIR, `${SESSION_ID}-stale.txt`);
			writeFileSync(stale, 'stale\n');
			utimesSync(stale, staleTime, staleTime);
			const fresh = join(MESSAGE_DIR, `${SESSION_ID}-fresh.txt`);
			writeFileSync(fresh, 'fresh\n');
			const outcome = await executePreparePrFeedbackCommitMessage(
				{ message: 'fix: prune probe' },
				dir,
				{ sessionID: SESSION_ID },
			);
			expect(JSON.parse(outcome).success).toBe(true);
			expect(() => statSync(stale)).toThrow();
			expect(() => statSync(fresh)).not.toThrow();
			rmSync(fresh, { force: true });
		} finally {
			removeTreeWithRetry(dir);
		}
	});

	test('refuses when the temp directory resolves inside the repository (platform-conditional)', async () => {
		const dir = await createBoundFeedbackRepo('PR_FEEDBACK');
		const originalTmpdir = process.env.TMPDIR;
		try {
			const inside = join(dir, 'tmp-inside');
			mkdirSync(inside, { recursive: true });
			process.env.TMPDIR = inside;
			// Bun on Windows ignores TMPDIR; only assert when the redirect took.
			if (
				canonicalTempRoot().replaceAll('\\', '/') ===
				inside.replaceAll('\\', '/')
			) {
				const outcome = await executePreparePrFeedbackCommitMessage(
					{ message: 'fix: thing' },
					dir,
					{ sessionID: SESSION_ID },
				);
				const parsed = JSON.parse(outcome) as {
					success: boolean;
					message: string;
				};
				expect(parsed.success).toBe(false);
				expect(parsed.message).toMatch(/outside the repository/);
			} else {
				// Redirect ineffective on this platform; POSIX CI covers the branch.
				// vacuous-ok: explicit no-op leg for platforms whose temp-root lookup ignores TMPDIR (Windows Bun); the POSIX leg asserts.
				expect(true).toBe(true);
			}
		} finally {
			if (originalTmpdir === undefined) {
				delete process.env.TMPDIR;
			} else {
				process.env.TMPDIR = originalTmpdir;
			}
			removeTreeWithRetry(dir);
		}
	});
});
