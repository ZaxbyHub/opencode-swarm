/**
 * The `shell` tool's Windows write-grammar inheritance must key on the shell
 * the host actually runs, reported per invocation (issue #3346), not on
 * process.platform alone.
 *
 * Contract:
 * - `resolveWindowsWriteAuthority` gains a sixth optional `hostShell` param
 *   (a shell path). The explicit-wrapper steps (cmd wrapper -> 'cmd';
 *   powershell wrapper or shaped body -> 'powershell') run FIRST, unchanged.
 * - For tool 'shell' with a non-empty `hostShell`, the host report is
 *   AUTHORITATIVE regardless of platform: basename (lowercase, '.exe'
 *   stripped) 'powershell' | 'pwsh' | 'cmd' inherits the detected Windows
 *   grammar; any other basename (bash, zsh, sh, …) means a POSIX executor
 *   and returns null. Tool 'bash' NEVER inherits. Empty/undefined hostShell
 *   keeps today's platform fallback.
 * - The observed shell is stored on `src/hooks/shell-executor-context.ts`:
 *   `recordObservedHostShell` / `getObservedHostShell` /
 *   `resetObservedHostShell` (module-level, latest-wins).
 *
 * RED at base, GREEN after the fix (#3346).
 */

import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
import { rmSync } from 'node:fs';
import type { GuardrailsConfig } from '../../../src/config/schema';
import { createGuardrailsHooks } from '../../../src/hooks/guardrails';
import { resolveWindowsWriteAuthority } from '../../../src/hooks/guardrails/tool-before';
import {
	getObservedHostShell,
	recordObservedHostShell,
	resetObservedHostShell,
} from '../../../src/hooks/shell-executor-context';
import { resetSwarmState, startAgentSession } from '../../../src/state';
import { installActiveScopeBinding } from '../../helpers/active-scope-binding';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const TEST_DIR = canonicalMkdtemp('shell-tool-grammar-host-shell-');
const GIT_BASH = 'C:\\Program Files\\Git\\bin\\bash.exe';
const CMD_EXE = 'C:\\Windows\\system32\\cmd.exe';
const PWSH = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe';

// The observed-host-shell store is module-level state; the final gate test
// leaves a recorded shell behind, so reset after the whole file so later
// test files in a shared bun process never inherit it (plan-critic r1 f5).
afterAll(() => {
	resetObservedHostShell();
});

function defaultConfig(
	overrides?: Partial<GuardrailsConfig>,
): GuardrailsConfig {
	return {
		enabled: true,
		max_tool_calls: 200,
		max_duration_minutes: 30,
		idle_timeout_minutes: 60,
		max_repetitions: 10,
		max_consecutive_errors: 5,
		warning_threshold: 0.75,
		profiles: undefined,
		...overrides,
	};
}

function makeShellInput(sessionID = 'test-session', callID = 'call-1') {
	return { tool: 'shell' as const, sessionID, callID };
}

describe('observed host shell module surface', () => {
	beforeEach(() => {
		resetObservedHostShell();
	});

	it('records the latest shell and reset clears it', () => {
		expect(getObservedHostShell()).toBeUndefined();
		recordObservedHostShell(GIT_BASH);
		expect(getObservedHostShell()).toBe(GIT_BASH);
		recordObservedHostShell(CMD_EXE);
		expect(getObservedHostShell()).toBe(CMD_EXE);
		resetObservedHostShell();
		expect(getObservedHostShell()).toBeUndefined();
	});
});

describe('shell tool grammar by host shell', () => {
	it('returns null for a git-bash host shell on win32 (POSIX executor overrides inheritance)', () => {
		expect(
			resolveWindowsWriteAuthority(
				'shell',
				'copy a.txt ..\\outside.txt',
				'cmd',
				false,
				'win32',
				GIT_BASH,
			),
		).toBeNull();
	});

	it('returns null for a bash-shaped redirect command under a git-bash host shell on win32', () => {
		expect(
			resolveWindowsWriteAuthority(
				'shell',
				'echo foo 2>/dev/null',
				'cmd',
				false,
				'win32',
				GIT_BASH,
			),
		).toBeNull();
	});

	it('returns cmd for a cmd.exe host shell reported on linux (host report overrides platform)', () => {
		expect(
			resolveWindowsWriteAuthority(
				'shell',
				'copy a.txt b.txt',
				'cmd',
				false,
				'linux',
				CMD_EXE,
			),
		).toBe('cmd');
	});

	it('returns powershell for a pwsh.exe host shell on win32 with a powershell-shaped body', () => {
		expect(
			resolveWindowsWriteAuthority(
				'shell',
				'Get-Content a | Set-Content b',
				'powershell',
				false,
				'win32',
				PWSH,
			),
		).toBe('powershell');
	});

	it('keeps the win32 fallback inheritance when hostShell is undefined', () => {
		expect(
			resolveWindowsWriteAuthority(
				'shell',
				'copy a.txt ..\\outside.txt',
				'cmd',
				false,
				'win32',
				undefined,
			),
		).toBe('cmd');
	});

	it('keeps the off-windows POSIX behavior when hostShell is undefined', () => {
		expect(
			resolveWindowsWriteAuthority(
				'shell',
				'copy a.txt ..\\outside.txt',
				'cmd',
				false,
				'linux',
				undefined,
			),
		).toBeNull();
	});

	it('never inherits for the bash tool, even with a cmd.exe host shell reported', () => {
		expect(
			resolveWindowsWriteAuthority(
				'bash',
				'copy a.txt ..\\outside.txt',
				'cmd',
				false,
				'win32',
				CMD_EXE,
			),
		).toBeNull();
	});

	it('keeps the explicit cmd wrapper step ahead of the host-shell report', () => {
		expect(
			resolveWindowsWriteAuthority(
				'shell',
				'cmd /c copy a.txt b.txt',
				'posix',
				false,
				'linux',
				'/bin/bash',
			),
		).toBe('cmd');
	});
});

describe('shell tool cmd grammar out of scope', () => {
	afterAll(() => rmSync(TEST_DIR, { recursive: true, force: true }));

	beforeEach(() => {
		resetObservedHostShell();
		resetSwarmState();
	});

	it('blocks a cmd `copy` escape under a reported cmd.exe host shell regardless of platform', async () => {
		const hooks = createGuardrailsHooks(TEST_DIR, undefined, defaultConfig());
		startAgentSession('b46-cmd-host', 'coder');
		installActiveScopeBinding({
			directory: TEST_DIR,
			childSessionId: 'b46-cmd-host',
			taskId: '1.1',
			files: ['src/'],
			dispatchCallId: 'call-1',
		});
		recordObservedHostShell(CMD_EXE);

		await expect(
			hooks.toolBefore(makeShellInput('b46-cmd-host'), {
				args: { command: 'copy a.txt ..\\outside.txt' },
			}),
		).rejects.toThrow(
			/outside the declared scope|SCOPE_VIOLATION|not authorised/,
		);
	});

	it('admits the same command under a reported git-bash host shell (no POSIX write)', async () => {
		const hooks = createGuardrailsHooks(TEST_DIR, undefined, defaultConfig());
		startAgentSession('b46-bash-host', 'coder');
		installActiveScopeBinding({
			directory: TEST_DIR,
			childSessionId: 'b46-bash-host',
			taskId: '1.1',
			files: ['src/'],
			dispatchCallId: 'call-1',
		});
		recordObservedHostShell(GIT_BASH);

		await expect(
			hooks.toolBefore(makeShellInput('b46-bash-host'), {
				args: { command: 'copy a.txt ..\\outside.txt' },
			}),
		).resolves.toBeUndefined();
	});
});
