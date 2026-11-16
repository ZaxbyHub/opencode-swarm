/**
 * Issue #3315 AC8 — PR_FEEDBACK `git add` admission FLOOR.
 *
 * GREEN at base and head (floor): issue #3315 admits exactly one staging
 * shape — `git add -- <exact path>` where the path is in the working tree's
 * changed set (see pr-feedback-git-add-admission-l2.test.ts). Every wider or
 * wrapped `git add` form below must keep rejecting with the fail-closed shell
 * signature `/shell commands fail closed/` both at the unfixed base (where NO
 * git add is admitted) and after the fix (where only the exact `--` form is).
 *
 * Real Git fixture (no seam stubs): real `git init` repo whose HEAD satisfies
 * the PR_FEEDBACK first-bind tracking discipline, gate bound to the real
 * 40-hex HEAD, tree dirtied after the bind with one modified tracked file
 * (`src/foo.ts`) and one new untracked file (`tests/foo.test.ts`).
 * `src/untouched-file.ts` is a real tracked file with NO working-tree change,
 * so `git add -- src/untouched-file.ts` names a path outside the changed set.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { closeAllProjectDbs } from '../../../src/db/project-db.js';
import {
	activatePrWorkflow,
	enforcePrWorkflowToolBefore,
} from '../../../src/hooks/pr-workflow-gate.js';
import { canonicalMkdtemp, removeTreeWithRetry } from '../../helpers/tmpdir.js';

const SESSION_ID = 'feedback-git-add-floor-l2';

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

/** Real repo + bound PR_FEEDBACK gate, then dirtied (bind needs a clean tree). */
async function createDirtyBoundFeedbackRepo(): Promise<string> {
	const dir = canonicalMkdtemp('pr-feedback-add-floor-');
	mkdirSync(join(dir, 'src'), { recursive: true });
	writeFileSync(join(dir, 'src', 'foo.ts'), 'export const a = 1;\n');
	writeFileSync(join(dir, 'src', 'untouched-file.ts'), 'export const u = 1;\n');
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
	appendFileSync(join(dir, 'src', 'foo.ts'), 'export const b = 2;\n');
	mkdirSync(join(dir, 'tests'), { recursive: true });
	writeFileSync(join(dir, 'tests', 'foo.test.ts'), 'test("x", () => {});\n');
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

describe('issue #3315 AC8 — every non-exact git add form stays fail-closed', () => {
	let dir = '';

	afterEach(async () => {
		closeAllProjectDbs();
		if (dir) removeTreeWithRetry(dir);
		dir = '';
	});

	test.each([
		// force flags
		'git add -f tests/foo.test.ts',
		'git add --force tests/foo.test.ts',
		// whole-tree / implicit-scope forms
		'git add -A',
		'git add --all',
		'git add .',
		// glob / pathspec magic (never an exact path)
		'git add "tests/*.test.ts"',
		'git add ":(glob)tests/**"',
		// directory override outside the bound repo
		'git -C ../elsewhere add -- tests/foo.test.ts',
		// interactive / patch form
		'git add -p tests/foo.test.ts',
		// exact-path form over a path NOT in the changed set (tracked, clean)
		'git add -- src/untouched-file.ts',
		// bare form without the explicit `--` separator stays blocked; only the
		// explicit `--` exact-path form is ever admitted.
		'git add tests/foo.test.ts',
	])('%s rejects with the fail-closed shell signature', async (command) => {
		dir = await createDirtyBoundFeedbackRepo();
		await expect(shellOutcome(dir, command)).resolves.toMatch(
			/shell commands fail closed/,
		);
	});
});
