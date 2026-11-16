/**
 * Issue #3315 AC15 — PR_FEEDBACK commit-message control-syntax FLOOR.
 *
 * GREEN at base and head (floor): the one sanctioned commit shape is a
 * standalone `git commit -m "<single plain message>"`. Any control,
 * redirection, command-substitution, escaped-quote, or newline payload inside
 * the `-m` operand must keep rejecting with the publication-syntax signature
 * `/publication commands must be standalone shell commands without control,
 * redirection, or command-substitution syntax/` (the escaped-quote form may
 * alternatively name the ambiguous-escaped-quote reason). The sanctioned plain
 * form must keep PASSING the classifier — it rejects only at the publication
 * ladder precondition (`/requires an immutable inventory and verification
 * batches/`) or resolves — never with control-syntax or fail-closed text.
 *
 * Newline form used here: a REAL U+000A newline is embedded in the shell
 * command string (TS source "...fix:\nline2..."), so the classifier's global
 * `/[\r\n;&<>`]/` control-character pre-check rejects it before the
 * standalone-commit shape is even considered. (A literal backslash-n variant —
 * backslash char + "n" — instead passes the base syntax classifier and reaches
 * the ladder precondition; it is deliberately NOT asserted here because its
 * post-fix classification belongs to the fix, while a raw control newline must
 * stay blocked at both ends.)
 *
 * Shared-fixture bound PR_FEEDBACK gate (pr-workflow-gate.test-fixtures.js
 * stubs the git resolvers through the _test_exports seam; no mock.module).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
	activatePrWorkflow,
	enforcePrWorkflowToolBefore,
} from '../../../src/hooks/pr-workflow-gate.js';
import {
	SESSION_ID as FIXTURE_SESSION_ID,
	HEAD_SHA,
	setupPrWorkflowGateFixtures,
	teardownPrWorkflowGateFixtures,
	tempDir,
} from './pr-workflow-gate.test-fixtures.js';

const SESSION_ID = `${FIXTURE_SESSION_ID}-commit-floor-l2`;

async function shellOutcome(command: string): Promise<string> {
	return enforcePrWorkflowToolBefore(tempDir, SESSION_ID, 'shell', {
		command,
	}).then(
		() => 'RESOLVED',
		(error: unknown) =>
			error instanceof Error ? error.message : String(error),
	);
}

describe('issue #3315 AC15 — commit-message control syntax stays blocked', () => {
	beforeEach(async () => {
		setupPrWorkflowGateFixtures();
		await activatePrWorkflow(tempDir, SESSION_ID, 'PR_FEEDBACK', {
			prHeadSha: HEAD_SHA,
		});
	});
	afterEach(teardownPrWorkflowGateFixtures);

	test.each([
		// semicolon inside the -m operand
		'git commit -m "fix: a; b"',
		// ampersand inside the -m operand
		'git commit -m "fix & more"',
		// inline attribution trailer: < > around the email are redirection chars
		'git commit -m "fix: thing" -m "Co-Authored-By: X <noreply@anthropic.com>"',
		// backtick command substitution inside the -m operand
		'git commit -m "fix `cmd` thing"',
		// $(...) command substitution inside the -m operand
		'git commit -m "fix $(cmd) thing"',
		// REAL U+000A newline inside the -m operand (see file docstring)
		'git commit -m "fix:\nline2"',
	])('%s rejects as unsafe publication syntax', async (command) => {
		await expect(shellOutcome(command)).resolves.toMatch(
			/publication commands must be standalone shell commands without control, redirection, or command-substitution syntax/,
		);
	});

	test('escaped-double-quote form rejects as unsafe (control-syntax or ambiguous-escaped-quote)', async () => {
		// The string contains backslash-escaped double quotes inside the -m
		// operand: `\"` is a literal quote under POSIX but re-opens quoting under
		// cmd.exe, so the classifier fails closed on it.
		const outcome = await shellOutcome(
			'git commit -m "fix \\"quoted\\" thing"',
		);
		expect(outcome).toMatch(
			/standalone shell commands without control|ambiguous-escaped-quote/,
		);
	});

	test('sanctioned plain commit still passes the classifier (ladder precondition only)', async () => {
		const outcome = await shellOutcome('git commit -m "fix: thing"');
		expect(outcome).not.toMatch(
			/publication commands must be standalone shell commands without control/,
		);
		expect(outcome).not.toMatch(/shell commands fail closed/);
		if (outcome !== 'RESOLVED') {
			expect(outcome).toMatch(
				/requires an immutable inventory and verification batches/,
			);
		}
	});
});
