/**
 * Issue #3315 AC7 — PR_FEEDBACK `git add -- <exact changed path>` admission.
 *
 * RED at base, GREEN after the fix: at the unfixed base the PR_FEEDBACK shell
 * classifier has no admission for ANY `git add` form, so staging the new test
 * file rejects with the fail-closed signature
 * `/shell commands fail closed unless they are explicit read-only intake or the
 * one standalone approved git commit/`. After the #3315 fix the explicit
 * `git add -- <path>` form over a path that IS in the working tree's changed
 * set must pass the classifier and reach the publication ladder precondition —
 * i.e. it either resolves to undefined OR rejects with
 * `/requires an immutable inventory and verification batches/`.
 *
 * Real Git fixture (no seam stubs): the repo is a real `git init` repository
 * whose HEAD satisfies the PR_FEEDBACK first-bind tracking discipline (branch
 * upstream plus a remote-tracking ref whose tip is the exact intake head, with
 * a configured remote fetch refspec), the gate is bound to the real 40-hex
 * HEAD via activatePrWorkflow, and the tree is dirtied only AFTER the bind
 * (bind requires a clean tree). Dirt: one modified tracked file
 * (`src/foo.ts`) and one new untracked file (`tests/foo.test.ts`) — both are
 * in the changed set the post-fix classifier must consult.
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

const SESSION_ID = 'feedback-git-add-admission-l2';

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

/** Real repo + bound PR_FEEDBACK gate (state lands under `.swarm/`). */
async function createBoundFeedbackRepo(): Promise<string> {
	const dir = canonicalMkdtemp('pr-feedback-add-admission-');
	mkdirSync(join(dir, 'src'), { recursive: true });
	writeFileSync(join(dir, 'src', 'foo.ts'), 'export const a = 1;\n');
	gitRun(dir, ['init', '-q', '-b', 'main']);
	gitRun(dir, ['config', 'user.email', 'swarm-test@example.com']);
	gitRun(dir, ['config', 'user.name', 'Swarm Test']);
	gitRun(dir, ['add', '.']);
	gitRun(dir, ['commit', '-q', '-m', 'init']);
	const head = gitHead(dir);
	// The PR_FEEDBACK first bind asserts a tracking-checkout discipline: the
	// current branch upstream must resolve and a remote-tracking ref whose tip
	// is the exact intake head must exist. A configured remote fetch refspec
	// plus a hand-placed refs/remotes/origin/pr-head satisfies both without a
	// real remote (validated against the real resolvers in
	// src/background/workspace-snapshot.ts).
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

describe('issue #3315 AC7 — git add exact-path admission over a changed-set path', () => {
	let dir = '';

	afterEach(async () => {
		closeAllProjectDbs();
		if (dir) removeTreeWithRetry(dir);
		dir = '';
	});

	test('git add -- <changed-set path> passes the classifier and reaches the ladder precondition', async () => {
		dir = await createBoundFeedbackRepo();
		// Dirty the tree only after the bind: one modified tracked file plus the
		// new untracked test file — both in the working tree's changed set.
		appendFileSync(join(dir, 'src', 'foo.ts'), 'export const b = 2;\n');
		mkdirSync(join(dir, 'tests'), { recursive: true });
		writeFileSync(join(dir, 'tests', 'foo.test.ts'), 'test("x", () => {});\n');

		const outcome = await shellOutcome(dir, 'git add -- tests/foo.test.ts');

		// Post-fix contract (AC7): the command must NOT be refused by the
		// fail-closed shell classifier. At the unfixed base this assertion FAILS
		// with exactly the documented base signature: "BLOCKED: PR_FEEDBACK
		// shell commands fail closed unless they are explicit read-only intake
		// or the one standalone approved git commit; ...".
		expect(outcome).not.toMatch(
			/shell commands fail closed unless they are explicit read-only intake or the one standalone approved git commit/,
		);
		// If the admitted command still rejects, it must be the publication
		// ladder precondition (an unarmed gate has no immutable inventory and
		// verification batches yet) — proving the classifier admitted it.
		if (outcome !== 'RESOLVED') {
			expect(outcome).toMatch(
				/requires an immutable inventory and verification batches/,
			);
		}
	});
});
