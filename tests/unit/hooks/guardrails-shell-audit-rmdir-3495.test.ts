/**
 * Regression tests for issues #3495 + #3345 (collated).
 *
 * #3495: the shell write-scope gate's scope_violation audit row records the
 * resolved target and the write operator as structured data (never re-parsed
 * message tokens like `SCOPE_VIOLATION:` / `Agent`), the denial names its
 * gate, and the Windows rmdir/rd/del `/s` recursive check matches switch
 * tokens, not `/s` substrings inside path operands.
 * #3345 sibling surface: the slow redirect tests in guardrails-shell-write
 * declare explicit CI-budget timeouts (pinned by the frozen C5 check).
 */

import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { GuardrailsConfig } from '../../../src/config/schema';
import { createGuardrailsHooks } from '../../../src/hooks/guardrails';
import {
	dcExtractWindowsCmdTargets,
	dcIsWindowsSwitchCluster,
} from '../../../src/hooks/guardrails/destructive-command';
import { resetSwarmState, startAgentSession } from '../../../src/state';
import { installActiveScopeBinding } from '../../helpers/active-scope-binding';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const TEST_DIR = canonicalMkdtemp('guardrails-shell-audit-3495-');
const GATE_PREFIX = 'WRITE BLOCKED [shell-write-scope]: SCOPE_VIOLATION:';
const GATE_PREFIX_RE = /^WRITE BLOCKED \[shell-write-scope\]: SCOPE_VIOLATION:/;

/**
 * Normalize a persisted path for exact comparison: redactPath swaps the home
 * root for `~` (and on win32 can leave a doubled separator behind), so
 * compare with forward slashes and collapsed separators on both sides.
 */
function normalizedPath(p: string): string {
	return p.replace(/\\+/g, '/');
}

function config(overrides?: Partial<GuardrailsConfig>): GuardrailsConfig {
	return {
		enabled: true,
		max_tool_calls: 200,
		max_duration_minutes: 30,
		idle_timeout_minutes: 60,
		max_repetitions: 10,
		max_consecutive_errors: 5,
		warning_threshold: 0.75,
		profiles: undefined,
		shell_audit_log: true,
		...overrides,
	};
}

/** Mirror of redactPath's home-profile rule: the home root becomes `~`. */
function tildeized(absolute: string): string {
	const home = os.homedir();
	if (absolute === home) return '~';
	if (absolute.startsWith(home + path.sep)) {
		return '~' + absolute.slice(home.length);
	}
	return absolute;
}

async function runShell(
	sessionID: string,
	command: string,
	role: 'coder' | 'architect',
	scope?: string[],
): Promise<void> {
	resetSwarmState();
	startAgentSession(sessionID, role);
	if (scope) {
		installActiveScopeBinding({
			directory: TEST_DIR,
			childSessionId: sessionID,
			taskId: '1.1',
			files: scope,
			dispatchCallId: 'c1',
		});
	}
	const hooks = createGuardrailsHooks(TEST_DIR, undefined, config());
	await hooks.toolBefore(
		{ tool: 'bash', sessionID, callID: 'c1' },
		{ args: { command } },
	);
}

type AuditRow = Record<string, unknown> | null;

function lastRowOfType(type: string): AuditRow {
	const p = path.join(TEST_DIR, '.swarm', 'session', 'shell-audit.jsonl');
	const lines = readFileSync(p, 'utf-8').trim().split('\n').filter(Boolean);
	for (let i = lines.length - 1; i >= 0; i -= 1) {
		const row = JSON.parse(lines[i]) as Record<string, unknown>;
		if (row.type === type) return row;
	}
	return null;
}

afterAll(() => rmSync(TEST_DIR, { recursive: true, force: true }));

describe('shell write-scope audit rows (issue #3495 items 1/3/4)', () => {
	beforeEach(() => {
		resetSwarmState();
	});

	test('scope denial: row records the exact resolved target, the operator, and the gate-prefixed message', async () => {
		await expect(
			runShell('s-scope', 'echo hi > notes/x.txt', 'coder', ['src/']),
		).rejects.toThrow(GATE_PREFIX_RE);
		const row = lastRowOfType('scope_violation');
		expect(row).not.toBeNull();
		expect(normalizedPath(String(row?.path))).toBe(
			normalizedPath(tildeized(path.resolve(TEST_DIR, 'notes/x.txt'))),
		);
		expect(row?.path).not.toBe('SCOPE_VIOLATION:');
		expect(row?.operator).toBe('>');
	}, 120_000);

	test('authority denial: row records the exact target, not the token `Agent`', async () => {
		await expect(
			runShell('s-auth', 'echo x > .swarm/state/pwn.json', 'coder', ['src/']),
		).rejects.toThrow('is not authorised to write');
		const row = lastRowOfType('scope_violation');
		expect(row).not.toBeNull();
		expect(normalizedPath(String(row?.path))).toBe(
			normalizedPath(
				tildeized(path.resolve(TEST_DIR, '.swarm/state/pwn.json')),
			),
		);
		expect(row?.path).not.toBe('Agent');
		expect(row?.operator).toBe('>');
	}, 120_000);

	test('inline-eval denial: row records the eval operator', async () => {
		await expect(
			runShell('s-eval', "python -c \"open('notes/x.txt','w')\"", 'coder', [
				'src/',
			]),
		).rejects.toThrow('BLOCKED');
		const row = lastRowOfType('scope_violation');
		expect(row).not.toBeNull();
		expect(row?.operator).toBe('python [eval]');
	}, 120_000);

	test('dynamic-path denial: row records the redirect operator', async () => {
		await expect(
			runShell('s-dyn', 'echo hi > $UNSET_VAR/x.txt', 'coder', ['src/']),
		).rejects.toThrow('cannot be statically resolved');
		const row = lastRowOfType('scope_violation');
		expect(row).not.toBeNull();
		expect(row?.operator).toBe('>');
	}, 120_000);

	test('append redirect denial: operator distinguishes >> from >', async () => {
		await expect(
			runShell('s-append', 'echo hi >> notes/a.txt', 'coder', ['src/']),
		).rejects.toThrow(GATE_PREFIX);
		const row = lastRowOfType('scope_violation');
		expect(row?.operator).toBe('>>');
	}, 120_000);

	test('an oversized write target still produces a bounded persisted row', async () => {
		const longName = `${'a'.repeat(400)}.txt`;
		await expect(
			runShell('s-long', `echo hi > notes/${longName}`, 'coder', ['src/']),
		).rejects.toThrow(GATE_PREFIX_RE);
		const row = lastRowOfType('scope_violation');
		// The row must SURVIVE (issue #3495 blocker: an unbounded path made
		// the store reject the line and the append was swallowed) and stay
		// within the 320-char bound plus the truncation marker.
		expect(row).not.toBeNull();
		expect(String(row?.path).length).toBeLessThanOrEqual(340);
	}, 120_000);
});

describe('Windows switch tokenization (issue #3495 item 2)', () => {
	describe('dcIsWindowsSwitchCluster', () => {
		test.each([
			['/s', true],
			['/S', true],
			['/q', true],
			['/s/q', true],
			['/sq', true],
			['/qs', true],
			// Path-like tokens are never switch clusters.
			['/share', false],
			['/src/old', false],
			['/s/old', false],
			['a/share/b', false],
			['src', false],
			// Quoted tokens are operands (cmd.exe treats a quoted "/s" as a path).
			['"/s"', false],
		])('%s => %s', (token, expected) => {
			expect(dcIsWindowsSwitchCluster(token)).toBe(expected);
		});
	});

	describe('dcExtractWindowsCmdTargets', () => {
		test.each([
			['rmdir /s /q x', ['x']],
			['rd x /s', ['x']],
			['rmdir /s/q x', ['x']],
			['rmdir.exe /s /q C:\\target', ['C:\\target']],
			['del /s/q/f b', ['b']],
			['rmdir "a dir" /s', ['a dir']],
			['rmdir "/s" dir', ['/s', 'dir']],
			['rmdir /s a b', ['a', 'b']],
			['del notes/x.txt', ['notes/x.txt']],
		])('%s => %j', (segment, expected) => {
			expect(dcExtractWindowsCmdTargets(segment)).toEqual(expected);
		});
	});

	describe('destructive gate verdicts through the real hook', () => {
		beforeEach(() => {
			resetSwarmState();
		});

		test('path operands with /s-looking segments are plain deletes, not recursive ones', async () => {
			mkdirSync(path.join(TEST_DIR, 'a/share/b'), { recursive: true });
			await expect(
				runShell('v1', 'rmdir a/share/b', 'architect'),
			).resolves.toBeUndefined();
			await expect(
				runShell('v2', 'rmdir keg/share/opencode2', 'architect'),
			).resolves.toBeUndefined();
			await expect(
				runShell('v3', 'del a/share/b', 'architect'),
			).resolves.toBeUndefined();
			await expect(
				runShell('v4', 'rmdir "a/share/b"', 'architect'),
			).resolves.toBeUndefined();
		}, 120_000);

		test('standalone and clustered switches still block, wherever they appear', async () => {
			await expect(runShell('v5', 'rmdir /s x', 'architect')).rejects.toThrow(
				'Recursive delete',
			);
			await expect(runShell('v6', 'rd /S q', 'architect')).rejects.toThrow(
				'Recursive delete',
			);
			await expect(runShell('v7', 'rmdir /s/q x', 'architect')).rejects.toThrow(
				'Recursive delete',
			);
			await expect(runShell('v8', 'rmdir /sq x', 'architect')).rejects.toThrow(
				'Recursive delete',
			);
			// Switch AFTER the path is a documented recursive form.
			await expect(runShell('v9', 'rd d /s', 'architect')).rejects.toThrow(
				'Recursive delete',
			);
		}, 120_000);
	});

	describe('PowerShell -r/-Recurse arms (same token-vs-substring class)', () => {
		beforeEach(() => {
			resetSwarmState();
		});

		test('a -r substring inside a path operand is a plain delete, not a recursive one', async () => {
			await expect(
				runShell('p1', 'rm some-r/x', 'architect'),
			).resolves.toBeUndefined();
			await expect(
				runShell('p2', 'rm x-Recurse/y', 'architect'),
			).resolves.toBeUndefined();
		}, 120_000);

		test('whitespace-delimited -r/-Recurse switches still block', async () => {
			await expect(runShell('p3', 'rm -r dir', 'architect')).rejects.toThrow(
				'Recursive delete',
			);
			await expect(runShell('p4', 'rm -R dir', 'architect')).rejects.toThrow(
				'Recursive delete',
			);
			await expect(
				runShell('p5', 'Remove-Item x -Recurse', 'architect'),
			).rejects.toThrow('Recursive delete');
		}, 120_000);
	});
});
