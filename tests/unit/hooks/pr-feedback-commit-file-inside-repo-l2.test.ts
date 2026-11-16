/**
 * Issue #3315 AC25 — PR_FEEDBACK `git commit -F <in-repo message file>` refusal.
 *
 * RED at base, GREEN after the fix: at the unfixed base every `-F` path form
 * passes the standalone-commit classifier and rejects only at the publication
 * ladder precondition (`/requires an immutable inventory and verification
 * batches/`) — the classifier never looks at WHERE the message file lives.
 * After the #3315 fix, `git commit -F` over a message file INSIDE the
 * repository (bare relative, `./`-relative, and absolute in-repo path) must
 * reject with the targeted refusal `/message file .* (must live )?outside the
 * repository/` — the commit message must come from outside the repo so the
 * approved message cannot be re-authored by in-repo state after verification.
 *
 * Real Git fixture (no seam stubs): real `git init` repo whose HEAD satisfies
 * the PR_FEEDBACK first-bind tracking discipline, gate bound to the real
 * 40-hex HEAD, and a real in-repo `msg.txt` at the repo root (created after
 * the bind so the bind's clean-tree precondition holds). The absolute-path
 * form is built with node:path join on the fixture dir; on Windows the command
 * string contains backslashes, which is fine — the classifier receives the
 * command verbatim.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { closeAllProjectDbs } from '../../../src/db/project-db.js';
import {
	activatePrWorkflow,
	enforcePrWorkflowToolBefore,
} from '../../../src/hooks/pr-workflow-gate.js';
import { canonicalMkdtemp, removeTreeWithRetry } from '../../helpers/tmpdir.js';

const SESSION_ID = 'feedback-commit-file-inside-repo-l2';

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

/** Real repo + bound PR_FEEDBACK gate + real in-repo msg.txt at the root. */
async function createBoundRepoWithMessageFile(): Promise<string> {
	const dir = canonicalMkdtemp('pr-feedback-commit-file-');
	mkdirSync(join(dir, 'src'), { recursive: true });
	writeFileSync(join(dir, 'src', 'foo.ts'), 'export const a = 1;\n');
	gitRun(dir, ['init', '-q', '-b', 'main']);
	gitRun(dir, ['config', 'user.email', 'swarm-test@example.com']);
	gitRun(dir, ['config', 'user.name', 'Swarm Test']);
	gitRun(dir, ['add', '.']);
	gitRun(dir, ['commit', '-q', '-m', 'init']);
	const head = gitHead(dir);
	// Tracking-checkout discipline for the first PR_FEEDBACK bind (validated
	// against the real resolvers in src/background/workspace-snapshot.ts).
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
	await activatePrWorkflow(dir, SESSION_ID, 'PR_FEEDBACK', { prHeadSha: head });
	// Real in-repo message file, created after the bind.
	writeFileSync(join(dir, 'msg.txt'), 'fix: thing\n');
	return dir;
}

async function shellOutcome(dir: string, command: string): Promise<string> {
	return enforcePrWorkflowToolBefore(dir, SESSION_ID, 'shell', {
		command,
	}).then(
		() => 'RESOLVED',
		(error: unknown) =>
			error instanceof Error ? error.message : String(error),
	);
}

describe('issue #3315 AC25 — in-repo commit message files are refused', () => {
	let dir = '';

	afterEach(async () => {
		closeAllProjectDbs();
		if (dir) removeTreeWithRetry(dir);
		dir = '';
	});

	test.each([
		'git commit -F msg.txt',
		'git commit -F ./msg.txt',
	])('%s rejects with the in-repo message-file refusal', async (command) => {
		dir = await createBoundRepoWithMessageFile();
		// At the unfixed base this FAILS: the outcome is instead the ladder
		// precondition "BLOCKED: PR_FEEDBACK requires an immutable inventory and
		// verification batches" because -F passes the classifier today.
		await expect(shellOutcome(dir, command)).resolves.toMatch(
			/message file .* (must live )?outside the repository/,
		);
	});

	test('git commit -F <absolute in-repo path> rejects with the in-repo message-file refusal', async () => {
		dir = await createBoundRepoWithMessageFile();
		// Windows: the joined path contains backslashes; the classifier receives
		// the command string verbatim, which is the point of this form. The path
		// is double-quoted the way a real invocation would be (temp roots may
		// contain spaces), so this leg also exercises the classifier's
		// quote-stripping on the -F argument.
		const command = `git commit -F "${join(dir, 'msg.txt')}"`;
		await expect(shellOutcome(dir, command)).resolves.toMatch(
			/message file .* (must live )?outside the repository/,
		);
	});
});
