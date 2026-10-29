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
import * as path from 'node:path';
import type { GuardrailsConfig } from '../../../src/config/schema';
import { deriveGateDenialCode } from '../../../src/hooks/gate-denial-tracker';
import { createGuardrailsHooks } from '../../../src/hooks/guardrails';
import { redactPath } from '../../../src/hooks/guardrails/audit-log';
import {
	dcIsSwitchClusterText,
	dcIsWindowsSwitchCluster,
	dcParseWindowsRecursiveDelete,
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

/**
 * Expected persisted path: the SHIPPED redactPath, not a hand mirror of it
 * (the mirror diverged from redactPath on non-standard HOME roots and
 * Windows 8.3 short names — PR #3499 review PRR-010).
 */
function expectedPath(absolute: string): string {
	return normalizedPath(redactPath(absolute));
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

function auditLineCount(): number {
	const p = path.join(TEST_DIR, '.swarm', 'session', 'shell-audit.jsonl');
	try {
		return readFileSync(p, 'utf-8').trim().split('\n').filter(Boolean).length;
	} catch {
		return 0;
	}
}

/**
 * Last row of `type` among lines APPENDED after `minLine` — a whole-file
 * scan could return a PREVIOUS test's row and satisfy a bound assertion
 * that its own command never produced (PR #3499 review PRR-006).
 */
function lastRowOfType(type: string, minLine = 0): AuditRow {
	const p = path.join(TEST_DIR, '.swarm', 'session', 'shell-audit.jsonl');
	const lines = readFileSync(p, 'utf-8').trim().split('\n').filter(Boolean);
	for (let i = lines.length - 1; i >= minLine; i -= 1) {
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
		const before = auditLineCount();
		await expect(
			runShell('s-scope', 'echo hi > notes/x.txt', 'coder', ['src/']),
		).rejects.toThrow(GATE_PREFIX_RE);
		const row = lastRowOfType('scope_violation', before);
		expect(row).not.toBeNull();
		expect(normalizedPath(String(row?.path))).toBe(
			expectedPath(path.resolve(TEST_DIR, 'notes/x.txt')),
		);
		expect(row?.path).not.toBe('SCOPE_VIOLATION:');
		expect(row?.operator).toBe('>');
	}, 120_000);

	test('authority denial: row records the exact target, not the token `Agent`', async () => {
		const before = auditLineCount();
		await expect(
			runShell('s-auth', 'echo x > .swarm/state/pwn.json', 'coder', ['src/']),
		).rejects.toThrow('is not authorised to write');
		const row = lastRowOfType('scope_violation', before);
		expect(row).not.toBeNull();
		expect(expectedPath(String(row?.path))).toBe(
			expectedPath(path.resolve(TEST_DIR, '.swarm/state/pwn.json')),
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
		const beforeLong = auditLineCount();
		await expect(
			runShell('s-long', `echo hi > notes/${longName}`, 'coder', ['src/']),
		).rejects.toThrow(GATE_PREFIX_RE);
		const row = lastRowOfType('scope_violation', beforeLong);
		// The row must SURVIVE THIS COMMAND (a whole-file scan could return
		// the previous test's short row and satisfy the bound even if this
		// row was dropped — PR #3499 review PRR-006) (issue #3495 blocker: an unbounded path made
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

	describe('dcParseWindowsRecursiveDelete (cmd.exe grammar)', () => {
		test.each([
			['/s /q x', true, ['x']],
			['x /s', true, ['x']],
			['zzz/s', true, ['zzz']],
			['../s', true, ['..']],
			['./s', true, ['.']],
			["'zzz/s'", true, ['zzz']],
			['^/^s zzz', false, ['zzz']],
			['/s/q x', true, ['x']],
			['/sq x', true, ['x']],
			['/s/q/f b', true, ['b']],
			['/s"file.txt"', true, ['file.txt']],
			['a/share/b', false, []],
			['/s2 x', false, ['x']],
			['"/s" dir', false, ['/s', 'dir']],
			['notes/x.txt', false, []], // invalid switch text: cmd errors, nothing deletable
			['dist/s ../q', true, ['dist', '..']], // review round 2: non-s cluster prefix harvested when /s fired
			['"a b"/s', true, ['a b']], // review round 2: partially quoted glue is scanned
			['/s,/q,C:/x', true, ['C:']], // review round 3: cmd splits unquoted , ; = as boundaries
			['p1,/s,/q', true, ['p1']],
		])('%s => fires=%j targets=%j', (args, fires, targets) => {
			expect(dcParseWindowsRecursiveDelete(args)).toEqual({ fires, targets });
		});
	});

	describe('dcIsSwitchClusterText', () => {
		test.each([
			['s', true],
			['s/q', true],
			['sq', true],
			['share', false],
			['s2', false],
			['', false],
		])('cluster text %s => %j', (text, expected) => {
			expect(dcIsSwitchClusterText(text)).toBe(expected);
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

	describe('cmd.exe grammar round 2 (PR #3499 review PRR-001..005)', () => {
		beforeEach(() => {
			resetSwarmState();
		});

		test('attached recursion switches block: rd zzz/s, rd ../s, rd ./s', async () => {
			await expect(runShell('g1', 'rd zzz/s', 'architect')).rejects.toThrow(
				'Recursive delete',
			);
			await expect(runShell('g2', 'rd ../s', 'architect')).rejects.toThrow(
				'Recursive delete',
			);
			await expect(runShell('g3', 'rd ./s', 'architect')).rejects.toThrow(
				'Recursive delete',
			);
		}, 120_000);

		test('caret-escaped and single-quoted switch forms block', async () => {
			await expect(
				runShell('g4', 'rmdir ^/^s zzz', 'architect'),
			).rejects.toThrow('Recursive delete');
			await expect(
				runShell('g5', "rmdir 'zzz/s'", 'architect'),
			).rejects.toThrow('Recursive delete');
		}, 120_000);

		test('switch glued to a quoted operand blocks: del /s"file.txt"', async () => {
			await expect(
				runShell('g6', 'del /s"file.txt"', 'architect'),
			).rejects.toThrow('Recursive delete');
			await expect(
				runShell('g7', 'rd /s"vault-notes"', 'architect'),
			).rejects.toThrow('Recursive delete');
		}, 120_000);

		test('a recursion switch with no operand fails closed on both arms', async () => {
			await expect(runShell('g8', 'rmdir /s', 'architect')).rejects.toThrow(
				'recursive directory delete',
			);
			await expect(runShell('g9', 'del /s', 'architect')).rejects.toThrow(
				'recursive file delete',
			);
		}, 120_000);

		test('a quoted "/s" is a path: the remaining operand reaches the scope gate', async () => {
			mkdirSync(path.join(TEST_DIR, 'quoted-target'), { recursive: true });
			await expect(
				runShell('g10', 'rmdir "/s" quoted-target', 'coder', ['src/']),
			).rejects.toThrow(/SCOPE_VIOLATION|not authorised/);
		}, 120_000);

		test(
			'review round 3: comma/equals-delimited switch spellings block',
			async () => {
				await expect(
					runShell('g13', 'rd /s,/q,plugins/oxlint-plugin-effect', 'architect'),
				).rejects.toThrow(/Recursive delete|recursive directory delete/);
				await expect(
					runShell('g14', 'rd plugins/oxlint-plugin-effect,/s,/q', 'architect'),
				).rejects.toThrow(/Recursive delete|recursive directory delete/);
			},
			120_000,
		);

		test(
			'review round 2: non-s cluster prefix harvested; partial-quote glue scanned',
			async () => {
				await expect(
					runShell('g11', 'rd dist/s ../q', 'architect'),
				).rejects.toThrow('Recursive delete');
				await expect(
					runShell('g12', 'rd "a b"/s', 'architect'),
				).rejects.toThrow('Recursive delete');
			},
			120_000,
		);

		test('gate-denial classification pins the new prefix (PRR-007)', () => {
			expect(
				deriveGateDenialCode(
					'WRITE BLOCKED [shell-write-scope]: SCOPE_VIOLATION: shell write target "x"',
				),
			).toBe('WRITE BLOCKED [shell-write-scope]');
			expect(
				deriveGateDenialCode(
					'WRITE BLOCKED: Agent "coder" is not authorised to write "x"',
				),
			).toBe('UNCLASSIFIED');
		});
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
