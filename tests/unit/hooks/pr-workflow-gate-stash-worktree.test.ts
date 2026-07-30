import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
	_test_exports,
	activatePrWorkflow,
	enforcePrWorkflowToolBefore,
} from '../../../src/hooks/pr-workflow-gate.js';
import {
	SESSION_ID,
	setupPrWorkflowGateFixtures,
	teardownPrWorkflowGateFixtures,
	tempDir,
} from './pr-workflow-gate.test-fixtures.js';

// FINDING R3: `git stash list` / `git worktree list` were admitted to the
// PR-workflow read-only shell classifier (`isAllowedReadOnlyGitStashListing`
// / `isAllowedReadOnlyGitWorktreeListing`, wired into
// `isAllowedPrWorkflowGitIntake`) with zero test coverage. A future refactor
// that dropped the `tokens[1] === 'list'` check would silently admit
// `git stash pop` / `git worktree add` with a green suite. This file drives
// the real classifier through the same public entry point
// (`enforcePrWorkflowToolBefore` under PR_REVIEW mode) that the sibling
// `pr-workflow-gate-shell-wrappers.test.ts` file uses — no new export was
// needed.
//
// FINDING R11: the `git -C <dir>` directory-override capture used the `/i`
// flag, so lowercase `-c` (git's arbitrary per-invocation config flag) also
// satisfied the capture. `git -c core.pager=touch stash list` was
// classified as ALLOW. Fixed by making the `-C` capture case-sensitive
// (`PR_WORKFLOW_GIT_DIR_OVERRIDE_PATTERN` in pr-workflow-gate.ts). This file
// locks in that `-c` forms are denied while `-C` forms remain admitted.

async function reviewOutcome(command: string): Promise<string> {
	return enforcePrWorkflowToolBefore(tempDir, SESSION_ID, 'shell', {
		command,
	}).then(
		() => 'ALLOWED',
		(error) => (error instanceof Error ? error.message : String(error)),
	);
}

describe('PR_REVIEW read-only shell classifier — git stash/worktree listing (R3)', () => {
	beforeEach(setupPrWorkflowGateFixtures);
	afterEach(teardownPrWorkflowGateFixtures);

	const mustBeDenied = [
		'git stash',
		'git stash push',
		'git stash push -m x',
		'git stash pop',
		'git stash apply',
		'git stash apply --index 0',
		'git stash drop',
		'git stash clear',
		'git stash save x',
		'git stash create',
		'git stash store abc',
		'git stash branch b',
		'git stash show',
		'git stash listx',
		'git stash --help list',
		'git stash list --output=/tmp/x',
		'git stash list --ext-diff',
		'git stash list; git stash pop',
		'git worktree',
		'git worktree add /tmp/x',
		'git worktree remove x',
		'git worktree move a b',
		'git worktree prune',
		'git worktree lock',
		'git worktree unlock',
		'git worktree repair',
		'git worktree list x',
		'git -C /tmp worktree add /tmp/y',
	];

	const mustBeAdmitted = [
		'git stash list',
		'git STASH LIST',
		'git  stash   list',
		'git -C /tmp stash list',
		'cd /tmp && git stash list',
		'git stash list 2>&1',
		'git stash list --pretty=format:%H',
		'git stash list -p',
		'git worktree list',
		'git worktree list --porcelain',
		'git worktree list -z',
		'git WORKTREE LIST',
	];

	test('denies every mutating stash/worktree form', async () => {
		await activatePrWorkflow(tempDir, SESSION_ID, 'PR_REVIEW');
		for (const command of mustBeDenied) {
			const outcome = await reviewOutcome(command);
			expect(outcome, `expected DENY for: ${command}`).not.toBe('ALLOWED');
			expect(outcome, `expected BLOCKED throw for: ${command}`).toContain(
				'BLOCKED',
			);
		}
	});

	test('admits only the bare read-only stash/worktree listing forms', async () => {
		await activatePrWorkflow(tempDir, SESSION_ID, 'PR_REVIEW');
		for (const command of mustBeAdmitted) {
			const outcome = await reviewOutcome(command);
			expect(outcome, `expected ALLOW for: ${command}`).toBe('ALLOWED');
		}
	});
});

describe('PR_REVIEW read-only shell classifier — git -c vs -C case sensitivity (R11)', () => {
	beforeEach(setupPrWorkflowGateFixtures);
	afterEach(teardownPrWorkflowGateFixtures);

	test('denies lowercase -c (arbitrary git config) even on otherwise-allowed verbs', async () => {
		await activatePrWorkflow(tempDir, SESSION_ID, 'PR_REVIEW');
		for (const command of [
			'git -c core.pager=touch stash list',
			'git -c protocol.ext.allow=always log',
			'git -c foo=bar status',
		]) {
			const outcome = await reviewOutcome(command);
			expect(outcome, `expected DENY for: ${command}`).not.toBe('ALLOWED');
			expect(outcome, `expected BLOCKED throw for: ${command}`).toContain(
				'BLOCKED',
			);
		}
	});

	test('keeps uppercase -C (directory override) admitted for allowed verbs', async () => {
		await activatePrWorkflow(tempDir, SESSION_ID, 'PR_REVIEW');
		for (const command of ['git -C /tmp stash list', 'git -C /tmp log']) {
			const outcome = await reviewOutcome(command);
			expect(outcome, `expected ALLOW for: ${command}`).toBe('ALLOWED');
		}
	});

	// The read-intake classifier was hardened for `-c`, but the standalone
	// COMMIT classifier one function away kept the same case-insensitive `-C`
	// pattern. That is the more dangerous half: `core.hooksPath` on a mutating
	// verb executes attacker-chosen hooks at commit time, and the injected
	// config was stripped from what the classifier evaluated, so the command
	// read as a bare `git commit`.
	test('denies -c config injection on the standalone commit classifier', () => {
		for (const command of [
			'git -c core.hooksPath=/tmp/evil commit -m x',
			'git -c protocol.ext.allow=always commit -m x',
			'git -c x=y -C /repo commit -m x',
		]) {
			expect(
				_test_exports.isSafeStandaloneGitCommit(command),
				`expected DENY for: ${command}`,
			).toBe(false);
		}
	});

	test('keeps the legitimate standalone commit forms admitted', () => {
		for (const command of [
			'git commit -m x',
			'git commit -m "message with spaces"',
			'git -C /repo commit -m x',
		]) {
			expect(
				_test_exports.isSafeStandaloneGitCommit(command),
				`expected ALLOW for: ${command}`,
			).toBe(true);
		}
	});
});
