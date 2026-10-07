/**
 * Issue #3099 AC3 — a literal `|` inside a quoted regex operand of `git grep`.
 *
 * `classifyPrWorkflowShellSyntax` (src/hooks/pr-workflow-gate.ts) tokenizes
 * quoting generically, but the exception that consumes it is hard-coded to one
 * command: the `gh api` prefix test rejects any other command carrying a
 * single, double-quoted pipe, emitting the reason `gh-api-jq-pipe`. So
 * `git grep -nE "a|b"` — a read the gate's own allowed-verb list names — is
 * rejected, and the diagnostic tells the operator the jq exception is the only
 * door for `|`.
 *
 * Contract after the fix: a double-quoted `-E`/`--extended-regexp` pattern
 * operand of `git grep` is admitted. Nothing else widens: semicolons,
 * redirection, interpolation, command substitution, escaped-quote ambiguity,
 * single-quoted operands, and real outer pipes all stay blocked.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
	activatePrWorkflow,
	enforcePrWorkflowToolBefore,
} from '../../../src/hooks/pr-workflow-gate.js';
import {
	HEAD_SHA,
	SESSION_ID,
	setupPrWorkflowGateFixtures,
	teardownPrWorkflowGateFixtures,
	tempDir,
} from './pr-workflow-gate.test-fixtures.js';

describe('#3099 AC3 — quoted regex operand of git grep', () => {
	beforeEach(() => {
		setupPrWorkflowGateFixtures();
	});
	afterEach(teardownPrWorkflowGateFixtures);

	const gate = async (command: string) => {
		await activatePrWorkflow(tempDir, SESSION_ID, 'PR_REVIEW', {
			prHeadSha: HEAD_SHA,
		});
		return enforcePrWorkflowToolBefore(tempDir, SESSION_ID, 'shell', {
			command,
		});
	};

	// ------------------------------------------------------------------
	// AC3 DISCRIMINATING: the quoted alternation operand is admitted.
	// ------------------------------------------------------------------
	const ADMITTED: string[] = [
		'git grep -nE "a|b"',
		'git grep -nE "foo|bar|baz" src/',
		'git grep --extended-regexp -n "alpha|beta"',
		'git grep -nE "(foo|bar)" src/',
		'git grep -nE "^src/.*\\.(ts|tsx)$"',
	];

	for (const command of ADMITTED) {
		test(`admits quoted regex alternation: ${command}`, async () => {
			await expect(gate(command)).resolves.toBeUndefined();
		});
	}

	// AC4 PRESERVING: the pre-existing gh api --jq exception is unchanged.
	test('keeps admitting the gh api --jq pipe exception', async () => {
		await expect(
			gate('gh api repos/octo-org/octo-repo/pulls/2160 --jq ".[] | .state"'),
		).resolves.toBeUndefined();
	});

	// AC4 PRESERVING: a git grep with no alternation already worked.
	test('keeps admitting a plain git grep with no pipe', async () => {
		await expect(gate('git grep -nE "alpha"')).resolves.toBeUndefined();
	});

	// ------------------------------------------------------------------
	// AC4 PRESERVING: everything else stays blocked. Each of these is a way
	// the new operand class could be abused to smuggle a real pipe.
	// ------------------------------------------------------------------
	const BLOCKED: Array<[string, string]> = [
		['a real outer pipe', 'git status | grep foo'],
		['an outer pipe behind git grep', 'git grep -nE "a|b" | head -5'],
		[
			'an outer pipe after a cd prefix',
			'cd /repo && git grep -nE "a|b" | head -5',
		],
		['a second pipe-bearing operand', 'git grep -nE "a|b" --and "c|d"'],
		['a single-quoted alternation', "git grep -nE 'a|b'"],
		['a second git grep after a real pipe', 'git status | git grep -nE "a|b"'],
		['semicolon composition', 'git grep -nE "a|b" ; rm -rf x'],
		['redirection composition', 'git grep -nE "a|b" > out.txt'],
		['command substitution', 'git grep -nE "$(whoami)|x"'],
		['escaped-quote ambiguity', 'git grep -nE "a\\" | b"'],
		['a pipe outside the pattern operand', 'git grep -nE "ab" | wc -l'],
		['a mutating git verb with alternation', 'git commit -m "a|b"'],
	];

	for (const [label, command] of BLOCKED) {
		test(`keeps blocking ${label}: ${command}`, async () => {
			await expect(gate(command)).rejects.toThrow();
		});
	}
});
