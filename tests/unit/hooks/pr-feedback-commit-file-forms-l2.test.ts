/**
 * Issue #3315 D8/AC25 companion coverage (NOT a frozen check): the in-repo
 * `-F` refusal must cover every message-file spelling the standalone-commit
 * classifier grammar admits — `--file=<p>`, `--file <p>`, attached `-F<p>` —
 * plus the `git -C <dir>` relocation, and must unquote double-quoted values
 * (the authoring tool's remediation text shows the quoted form). GREEN after
 * the fix (the frozen C25 carries the base RED for the spaced `-F` form).
 */
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
	activatePrWorkflow,
	enforcePrWorkflowToolBefore,
} from '../../../src/hooks/pr-workflow-gate.js';
import { safeRmRecursive } from '../../helpers/safe-test-dir.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

function gitQuiet(dir: string, args: string[]): void {
	execFileSync('git', ['-C', dir, ...args], {
		stdio: 'ignore',
		timeout: 30_000,
	});
}

function gitOut(dir: string, args: string[]): string {
	return execFileSync('git', ['-C', dir, ...args], {
		encoding: 'utf-8',
		maxBuffer: 1024 * 1024,
		timeout: 30_000,
	}).trim();
}

describe('PR_FEEDBACK in-repo commit message files, all spellings (issue #3315 D8)', () => {
	test('--file=<path>, --file <path>, attached -F<path>, quoted -F, and git -C relocation all refuse in-repo message files', async () => {
		const repo = canonicalMkdtemp('commit-ff-forms-');
		// Scratch roots for out-of-repo message files; removed with the repo.
		const scratch: string[] = [];
		try {
			execFileSync('git', ['init', '-q', repo], {
				stdio: 'ignore',
				timeout: 30_000,
			});
			gitQuiet(repo, ['checkout', '-q', '-b', 'pr-head']);
			gitOut(repo, ['config', 'user.email', 't@example.com']);
			gitOut(repo, ['config', 'user.name', 'T']);
			gitOut(repo, ['config', 'core.autocrlf', 'false']);
			writeFileSync(join(repo, '.gitignore'), '.swarm/\n');
			writeFileSync(join(repo, 'file.txt'), 'root\n');
			gitQuiet(repo, ['add', '.']);
			gitQuiet(repo, ['commit', '-q', '-m', 'root']);
			writeFileSync(join(repo, 'msg.txt'), 'message body\n');
			writeFileSync(join(repo, 'sub.txt'), 'sub body\n');
			const head = gitOut(repo, ['rev-parse', 'HEAD']);
			const session = 'commit-ff-forms-3315';
			await activatePrWorkflow(repo, session, 'PR_FEEDBACK', {
				prHeadSha: head,
			});
			const inRepoRefusal =
				/resolves inside the repository|message file .*outside the repository/;
			for (const command of [
				`git commit --file=msg.txt`,
				`git commit --file msg.txt`,
				`git commit -Fmsg.txt`,
				`git commit -F "msg.txt"`,
				`git commit -F ./msg.txt`,
				`git -C ${repo.replaceAll('\\', '/')} commit -F sub.txt`,
			]) {
				await expect(
					enforcePrWorkflowToolBefore(repo, session, 'shell', { command }),
				).rejects.toThrow(inRepoRefusal);
			}
			// Reviewer round-1 regression floor: a plain `-m` message that merely
			// CONTAINS a `-F`/`--file`-looking token is message text, not a
			// message-file argument — the commit keeps reaching the ladder
			// precondition exactly as at base (option-position-aware parsing).
			for (const command of [
				'git commit -m "docs: document the -F flag"',
				'git commit -m "add -fast path"',
				'git commit -m "support --file upload"',
				'git commit -m "fix" -m "reuse -C abc123 shape"',
				'git commit -C 0123456789abcdef0123456789abcdef01234567 -m "fix: thing"',
			]) {
				await expect(
					enforcePrWorkflowToolBefore(repo, session, 'shell', { command }),
				).rejects.toThrow(
					/requires an immutable inventory and verification batches/,
				);
			}
			// Reviewer round-2 adversarial floors: attached-quoted spellings are
			// unambiguous in every shell (quotes glue/stripped), so they must
			// reach the ladder, never the in-repo refusal.
			const advDir = canonicalMkdtemp('commit-ff-adv-');
			scratch.push(advDir);
			const outsideAdv = join(advDir, 'my file.txt');
			writeFileSync(outsideAdv, 'adv\n');
			const outsideAdvPosix = outsideAdv.replaceAll('\\', '/');
			for (const command of [
				'git commit -m"docs: mention -F"',
				`git commit --file="${outsideAdvPosix}"`,
				`git commit -F"${outsideAdvPosix}"`,
			]) {
				await expect(
					enforcePrWorkflowToolBefore(repo, session, 'shell', { command }),
				).rejects.toThrow(
					/requires an immutable inventory and verification batches/,
				);
			}
			// Reviewer round-3 floors: fully-quoted FLAGS are real flags in every
			// shell (quotes strip around flags too), and a NBSP after -F is NOT
			// a separator for cmd.exe/POSIX, so the attached value stays
			// relative (in-repo). All four must keep the in-repo refusal.
			for (const command of [
				'git commit "--file=msg.txt"',
				'git commit "-F" msg.txt',
				'git commit "-Fmsg.txt"',
				'git commit -F' + String.fromCharCode(0xa0) + 'msg.txt',
			]) {
				await expect(
					enforcePrWorkflowToolBefore(repo, session, 'shell', { command }),
				).rejects.toThrow(
					/resolves inside the repository|message file .*outside the repository/,
				);
			}
			// Reviewer round-4 floors: git parse-options consumes option-looking
			// values unconditionally for value-taking options (--author,
			// --cleanup, ...), an unquoted -- terminates option parsing (later
			// tokens are pathspecs), and U+2028/U+2029 are not cmd/POSIX IFS
			// so a glued -F<U+2028> value stays relative (in-repo). The first
			// three must reach the ladder; the line-separator two must refuse.
			const LS = String.fromCharCode(0x2028);
			const PS = String.fromCharCode(0x2029);
			for (const command of [
				'git commit --author "-F" msg.txt',
				'git commit -m x -- "-F" msg.txt',
				'git commit --cleanup "-F" msg.txt',
			]) {
				await expect(
					enforcePrWorkflowToolBefore(repo, session, 'shell', { command }),
				).rejects.toThrow(
					/requires an immutable inventory and verification batches/,
				);
			}
			for (const command of [
				'git commit -F' + LS + 'msg.txt',
				'git commit -F' + PS + 'msg.txt',
			]) {
				await expect(
					enforcePrWorkflowToolBefore(repo, session, 'shell', { command }),
				).rejects.toThrow(
					/resolves inside the repository|message file .*outside the repository/,
				);
			}
			// Outside-repo -F keeps today's classifier admission: it reaches the
			// ladder precondition instead of the in-repo refusal.
			const outsideDir = canonicalMkdtemp('commit-ff-outside-');
			scratch.push(outsideDir);
			const outside = join(outsideDir, 'msg.txt');
			writeFileSync(outside, 'outside message\n');
			await expect(
				enforcePrWorkflowToolBefore(repo, session, 'shell', {
					command: `git commit -F "${outside.replaceAll('\\', '/')}"`,
				}),
			).rejects.toThrow(
				/requires an immutable inventory and verification batches/,
			);
		} finally {
			safeRmRecursive(repo);
			for (const dir of scratch) safeRmRecursive(dir);
		}
	});
});
