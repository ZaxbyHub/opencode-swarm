/**
 * Issue #3315 acceptance check AC14 — sanctioned commit-message authoring
 * surface for trailer-bearing PR_FEEDBACK commit messages (DEFAULT D8 path:
 * Option B — a NEW controller tool `prepare_pr_feedback_commit_message`
 * exported from `src/tools/prepare-pr-feedback-commit-message.js`).
 * Classification: NEW-SURFACE — ERROR at base (module absent), GREEN after
 * the fix.
 *
 * Base defect (trace 3315-prescribed-tools-reachable, D8): the shell
 * classifier (correctly) rejects `; & < >` backtick and newline anywhere in a
 * `git commit -m` command, so an attribution trailer such as
 * `Co-Authored-By: X <noreply@anthropic.com>` cannot be committed inline.
 * `git commit -F <path>` already passes the classifier, but no sanctioned
 * surface can author the message file OUTSIDE the repository (write
 * containment denies outside-repo paths; shell redirection is rejected), and
 * an in-repo message file is an untracked file that breaks the D3 clean-tree
 * arming check. The module below does not exist at base — that is the
 * expected base signature:
 *
 *   bun: error: Cannot find module '...src/tools/prepare-pr-feedback-commit-message.js'
 *
 * Post-fix contract, frozen per the issue's AC13 default (Option B):
 *  - `executePreparePrFeedbackCommitMessage({ message }, repoDir, { sessionID })`
 *    returns `{ success: true, path }` (or a JSON string carrying the same
 *    shape) where `path` resolves OUTSIDE repoDir;
 *  - the file content equals the message exactly, trailer intact;
 *  - the repository's `git status --porcelain=v1 --untracked-files=all` is
 *    unchanged by the authoring (no message file inside the repository);
 *  - admission: `enforcePrWorkflowToolBefore(repoDir, session, 'shell',
 *    { command: 'git commit -F <that path>' })` passes the shell classifier —
 *    it resolves, or is rejected only by the later ladder precondition
 *    ("requires an immutable inventory and verification batches"), NOT by the
 *    in-repo-path refusal, the fail-closed shell refusal, or the
 *    control-syntax refusal.
 */
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
	activatePrWorkflow,
	enforcePrWorkflowToolBefore,
} from '../../../src/hooks/pr-workflow-gate.js';
import { executePreparePrFeedbackCommitMessage } from '../../../src/tools/prepare-pr-feedback-commit-message.js';
import { safeRmRecursive } from '../../helpers/safe-test-dir.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

/** Array-form git with explicit cwd; output ignored (mutation commands). */
function gitQuiet(dir: string, args: string[]): void {
	execFileSync('git', ['-C', dir, ...args], {
		stdio: 'ignore',
		timeout: 30_000,
	});
}

/** Array-form git capturing bounded stdout (rev-parse / status probes). */
function gitOut(dir: string, args: string[]): string {
	return execFileSync('git', ['-C', dir, ...args], {
		encoding: 'utf-8',
		maxBuffer: 1024 * 1024,
		timeout: 30_000,
	}).trim();
}

const MESSAGE_WITH_TRAILER =
	'fix: thing\n\nCo-Authored-By: X <noreply@anthropic.com>';

describe('prepare_pr_feedback_commit_message authoring surface (issue #3315 AC14)', () => {
	test('authors the trailer-bearing commit message outside the repository and admits `git commit -F` through the classifier', async () => {
		const repo = canonicalMkdtemp('commit-trailer-3315-');
		try {
			gitQuiet(repo, ['init', '-q']);
			gitOut(repo, ['config', 'user.email', 't@example.com']);
			gitOut(repo, ['config', 'user.name', 'T']);
			gitOut(repo, ['config', 'core.autocrlf', 'false']);
			// `.swarm/` is committed to .gitignore so gate-state writes never
			// dirty the porcelain (mirrors the production
			// ensureSwarmGitExcluded behavior).
			writeFileSync(join(repo, '.gitignore'), '.swarm/\n');
			writeFileSync(join(repo, 'file.txt'), 'base\n');
			gitQuiet(repo, ['add', '.']);
			gitQuiet(repo, ['commit', '-q', '-m', 'base']);
			const head = gitOut(repo, ['rev-parse', 'HEAD']);

			const session = 'commit-trailer-3315';
			await activatePrWorkflow(repo, session, 'PR_FEEDBACK', {
				prHeadSha: head,
			});
			const porcelainBefore = gitOut(repo, [
				'status',
				'--porcelain=v1',
				'--untracked-files=all',
			]);

			// POST-FIX: the controller tool authors the message file. The frozen
			// contract accepts either the object shape or a JSON-string encoding
			// of it (createSwarmTool tools conventionally return JSON strings).
			const raw = await executePreparePrFeedbackCommitMessage(
				{ message: MESSAGE_WITH_TRAILER },
				repo,
				{ sessionID: session },
			);
			const parsed =
				typeof raw === 'string'
					? (JSON.parse(raw) as { success?: boolean; path?: string })
					: (raw as { success?: boolean; path?: string });
			expect(parsed.success).toBe(true);
			expect(typeof parsed.path).toBe('string');
			const messagePath = parsed.path as string;

			// The message file lives OUTSIDE the repository — an in-repo file
			// would be an untracked file that breaks the D3 clean-tree arming
			// check (the exact defect this surface exists to close).
			const relativePath = relative(repo, messagePath);
			expect(
				relativePath.startsWith('..'),
				`commit-message path "${messagePath}" resolves inside the repository (relative: "${relativePath}")`,
			).toBe(true);

			// The authored content equals the message exactly, trailer intact —
			// including the `<`/`>` characters the inline `-m` form cannot carry.
			expect(readFileSync(messagePath, 'utf-8')).toBe(MESSAGE_WITH_TRAILER);

			// The authoring left the bound checkout's porcelain unchanged.
			const porcelainAfterAuthoring = gitOut(repo, [
				'status',
				'--porcelain=v1',
				'--untracked-files=all',
			]);
			expect(porcelainAfterAuthoring).toBe(porcelainBefore);

			// Admission: `git commit -F <outside-repo path>` passes the shell
			// classifier. Quoted so a temp path containing spaces still matches
			// the standalone-commit grammar. The gate has no settled ladder in
			// this fixture, so the expected post-fix outcome is either a resolve
			// or the ladder precondition rejection — never the in-repo-path
			// refusal, the fail-closed shell refusal, or the control-syntax
			// refusal.
			const command = `git commit -F "${messagePath}"`;
			let admissionOutcome = 'RESOLVED';
			try {
				await enforcePrWorkflowToolBefore(repo, session, 'shell', { command });
			} catch (error) {
				admissionOutcome =
					error instanceof Error ? error.message : String(error);
			}
			if (admissionOutcome !== 'RESOLVED') {
				expect(admissionOutcome).toMatch(
					/requires an immutable inventory and verification batches/,
				);
			}
			expect(admissionOutcome).not.toMatch(/inside the repository|in-repo/);
			expect(admissionOutcome).not.toMatch(/shell commands fail closed/);
			expect(admissionOutcome).not.toMatch(/read-only and fail-closed/);
			expect(admissionOutcome).not.toMatch(
				/standalone shell commands without control/,
			);
		} finally {
			safeRmRecursive(repo);
		}
	});
});
