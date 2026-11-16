/**
 * #3346 — v2 shell-executor observer registration and its gate/explain
 * consumption.
 *
 * `registerV2ShellHooks(ctx, registrations)` (src/host/v2/hooks.ts) installs a
 * `ctx.shell` "create.before" hook on OpenCode 2 hosts and records the
 * host-reported `shell` path into the observed-host-shell store
 * (src/hooks/shell-executor-context.ts). The write gate's
 * `resolveWindowsWriteAuthority` call site and `/swarm guardrail explain` read
 * that store so cmd/powershell grammar inheritance keys on the shell the host
 * actually executes instead of process.platform — closing the
 * Git-Bash-on-Windows false-positive class from #3323/#3346.
 *
 * Contract pinned here:
 *  1. A successful registration captures the handler; invoking it with a
 *     `{ command, cwd, timeout, shell, env }` payload records `shell`.
 *  2. A host without the shell domain (or with a non-function `hook`) is a
 *     SKIP: resolve, record nothing, push nothing (pre-2.0.29 hosts).
 *  3. A rejecting registration is non-fatal for the OBSERVER path (warn +
 *     resolve) — see the sync-throw note inside the test for the one shape
 *     that escapes to the caller and is isolated by setup's
 *     `runRegistration('shell-observer', …)` wrapper.
 *  4. A successful registration lands in the disposal sink (any non-null
 *     disposal shape).
 *  5. REGRESSION (plan-critic r3): with NOTHING observed, `$SHELL` is ignored
 *     entirely — no environment seed exists; win32 `shell` keeps the
 *     conservative platform-keyed interim from #3326.
 *  6. After observation the host report is authoritative ACROSS platforms
 *     (Windows-family report keeps cmd grammar on 'linux'; POSIX-family
 *     report disables it), and `hostShellGrammarFamily` classifies paths
 *     separator-independently.
 *  7. Non-string / empty `shell` payloads leave the store untouched.
 *  8. Disposal does NOT clear the store — the store is an observational,
 *     latest-wins host probe with no per-registration teardown (documented
 *     honestly rather than inventing teardown the implementation lacks).
 *
 * Plain-object fakes only (no mock.module); the module-level store is reset
 * around every test (invariant-8 discipline: no cross-test pollution).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { resolveWindowsWriteAuthority } from '../../../../src/hooks/guardrails/tool-before';
import {
	getObservedHostShell,
	hostShellGrammarFamily,
	recordObservedHostShell,
	resetObservedHostShell,
} from '../../../../src/hooks/shell-executor-context';
import { registerV2ShellHooks } from '../../../../src/host/v2/hooks';
import type {
	V2PluginContext,
	V2Registration,
} from '../../../../src/host/v2/types';
import {
	clearDeferredWarnings,
	getDeferredWarnings,
} from '../../../../src/services/warning-buffer';

/** cmd-shaped out-of-scope write the gate tests use (backslash target). */
const COPY_OUTSIDE = 'copy a.txt ..\\outside.txt';
const GIT_BASH = 'C:\\Program Files\\Git\\bin\\bash.exe';
const CMD_EXE = 'C:\\Windows\\system32\\cmd.exe';

/** A captured `create.before` handler; invoked with loose payloads on purpose. */
type CapturedHandler = (payload: unknown) => void;

beforeEach(() => {
	resetObservedHostShell();
	clearDeferredWarnings();
});

afterEach(() => {
	resetObservedHostShell();
	clearDeferredWarnings();
});

describe('registerV2ShellHooks (#3346)', () => {
	test('successful registration captures the create.before handler; invoking it records the reported shell', async () => {
		const events: string[] = [];
		const captured: CapturedHandler[] = [];
		const registration = { dispose: async () => {} };
		const regs: V2Registration[] = [];
		const ctx = {
			shell: {
				hook: (event: string, handler: CapturedHandler) => {
					events.push(event);
					captured.push(handler);
					return registration;
				},
			},
		} as never;

		await registerV2ShellHooks(ctx as V2PluginContext, regs);

		expect(events).toEqual(['create.before']);
		expect(regs).toEqual([registration]);
		expect(captured.length).toBe(1);

		captured[0]?.({
			command: 'echo hi',
			cwd: '/x',
			timeout: 1000,
			shell: GIT_BASH,
			env: {},
		});
		expect(getObservedHostShell()).toBe(GIT_BASH);
	});

	test('absent shell domain (no ctx.shell) resolves, records nothing, pushes nothing', async () => {
		const regs: V2Registration[] = [];
		await registerV2ShellHooks({} as V2PluginContext, regs);
		expect(getObservedHostShell()).toBeUndefined();
		expect(regs).toEqual([]);
	});

	test('shell domain present but hook is not a function resolves, records nothing, pushes nothing', async () => {
		const regs: V2Registration[] = [];
		const ctx = { shell: { hook: 'not-a-function' } } as never;
		await registerV2ShellHooks(ctx as V2PluginContext, regs);
		expect(getObservedHostShell()).toBeUndefined();
		expect(regs).toEqual([]);
	});

	test('registration returning a rejected Promise: resolves, warns through the deferred-warning channel, records nothing', async () => {
		const regs: V2Registration[] = [];
		const ctx = {
			shell: {
				hook: async () => {
					throw new Error('shell.create.before rejected by host');
				},
			},
		} as never;

		// The warn path must keep the observer non-fatal: no rejection here.
		await registerV2ShellHooks(ctx as V2PluginContext, regs);

		expect(getObservedHostShell()).toBeUndefined();
		expect(regs).toEqual([]);
		const warning = getDeferredWarnings().find((w) =>
			w.includes('shell.create.before'),
		);
		expect(warning).toBeDefined();
	});

	test('synchronously-throwing shell.hook: the host error escapes to the caller (setup runRegistration isolates it); nothing recorded', async () => {
		const regs: V2Registration[] = [];
		const ctx = {
			shell: {
				hook: () => {
					throw new Error('host shell domain refused registration');
				},
			},
		} as never;

		// DEVIATION from this issue's provisional "never rejects" wording,
		// pinned deliberately (verified against the implementation): the sync
		// throw fires while evaluating the `shellDomain.hook(...)` ARGUMENT to
		// withTimeout — before withTimeout is entered and before `.catch` can
		// attach — so the async function rejects with the host error itself.
		// setup.ts wraps this call in runRegistration('shell-observer', …)
		// whose own `.catch` isolates the rejection with a deferred warning,
		// the same "resolves-vs-rejects shape at the register* level is not
		// pinned" contract #3352 established for the sibling register*
		// functions. What IS pinned here: nothing is recorded and nothing
		// lands in the disposal sink.
		await expect(
			registerV2ShellHooks(ctx as V2PluginContext, regs),
		).rejects.toThrow('host shell domain refused registration');

		expect(getObservedHostShell()).toBeUndefined();
		expect(regs).toEqual([]);
	});

	test('successful registration lands in the disposal sink (object disposal form)', async () => {
		const registration = { dispose: async () => {} };
		const regs: V2Registration[] = [];
		const ctx = {
			shell: {
				hook: () => registration,
			},
		} as never;

		await registerV2ShellHooks(ctx as V2PluginContext, regs);
		expect(regs).toEqual([registration]);
	});

	test('successful registration lands in the disposal sink (function disposal form)', async () => {
		const disposal = async () => {};
		const regs: V2Registration[] = [];
		const ctx = {
			shell: {
				hook: () => disposal,
			},
		} as never;

		await registerV2ShellHooks(ctx as V2PluginContext, regs);
		expect(regs).toEqual([disposal]);
	});

	test('non-string and empty shell payloads leave the store unchanged', async () => {
		const captured: CapturedHandler[] = [];
		const ctx = {
			shell: {
				hook: (_event: string, handler: CapturedHandler) => {
					captured.push(handler);
					return { dispose: async () => {} };
				},
			},
		} as never;
		await registerV2ShellHooks(ctx as V2PluginContext, []);
		expect(captured.length).toBe(1);
		const handler = captured[0];

		// Nothing recorded yet → stays undefined.
		handler?.({ command: 'x', cwd: '/x', timeout: 1, shell: 123, env: {} });
		expect(getObservedHostShell()).toBeUndefined();
		handler?.({ command: 'x', cwd: '/x', timeout: 1, shell: '', env: {} });
		expect(getObservedHostShell()).toBeUndefined();

		// A previously recorded value survives invalid payloads (the recorder
		// no-ops on non-string / blank input rather than clearing).
		recordObservedHostShell(CMD_EXE);
		handler?.({ command: 'x', cwd: '/x', timeout: 1, shell: 123, env: {} });
		handler?.({ command: 'x', cwd: '/x', timeout: 1, shell: '', env: {} });
		expect(getObservedHostShell()).toBe(CMD_EXE);
	});

	test('dispose() does NOT clear the observed store (observational, latest-wins; no per-registration teardown)', async () => {
		const captured: CapturedHandler[] = [];
		const registration = { dispose: async () => {} };
		const regs: V2Registration[] = [];
		const ctx = {
			shell: {
				hook: (_event: string, handler: CapturedHandler) => {
					captured.push(handler);
					return registration;
				},
			},
		} as never;
		await registerV2ShellHooks(ctx as V2PluginContext, regs);
		captured[0]?.({
			command: 'echo hi',
			cwd: '/x',
			timeout: 1000,
			shell: CMD_EXE,
			env: {},
		});
		expect(getObservedHostShell()).toBe(CMD_EXE);

		await regs[0]?.dispose();

		// The hook only records; the implementation wires NO per-registration
		// teardown, so the observation survives disposal BY DESIGN. This pins
		// the real contract instead of inventing one: the store is a
		// host-behavior probe (latest report wins until the next report or a
		// test reset), not a resource owned by the registration's lifetime.
		expect(getObservedHostShell()).toBe(CMD_EXE);
	});
});

describe('observed host shell gate/explain consumption (#3346)', () => {
	test('REGRESSION (plan-critic r3): nothing observed + POSIX $SHELL → win32 shell tool still uses the conservative platform interim; the environment is never seeded', async () => {
		const originalShell = process.env.SHELL;
		process.env.SHELL = '/usr/bin/bash';
		try {
			resetObservedHostShell();
			expect(getObservedHostShell()).toBeUndefined();

			// Five-arg form (no hostShell) — the resolver must not consult
			// $SHELL: no environment seed exists, so the #3326 platform-keyed
			// interim keeps cmd grammar for the shell tool on win32.
			expect(
				resolveWindowsWriteAuthority(
					'shell',
					COPY_OUTSIDE,
					'cmd',
					false,
					'win32',
				),
			).toBe('cmd');

			// Mirroring the real call site (tool-before.ts passes
			// getObservedHostShell() for the shell tool): an undefined report
			// falls through to the same platform interim — never wider.
			expect(
				resolveWindowsWriteAuthority(
					'shell',
					COPY_OUTSIDE,
					'cmd',
					false,
					'win32',
					getObservedHostShell(),
				),
			).toBe('cmd');
		} finally {
			if (originalShell === undefined) {
				delete process.env.SHELL;
			} else {
				process.env.SHELL = originalShell;
			}
		}
	});

	test('gate/explain parity after observation: a cmd.exe report keeps cmd grammar even on linux; a Git Bash report disables it', () => {
		// Windows-family host report is AUTHORITATIVE ACROSS PLATFORMS: the
		// injected 'linux' platform loses to the report, so the same
		// resolver verdict the gate and /swarm guardrail explain share stays
		// 'cmd' (an out-of-scope copy still detected).
		recordObservedHostShell(CMD_EXE);
		expect(getObservedHostShell()).toBe(CMD_EXE);
		expect(
			resolveWindowsWriteAuthority(
				'shell',
				COPY_OUTSIDE,
				'cmd',
				false,
				'linux',
				getObservedHostShell(),
			),
		).toBe('cmd');

		// POSIX-family host report: content-detected cmd grammar is NOT
		// inherited regardless of platform — null (POSIX reading owns shared
		// constructs, so the write scope resolves against POSIX semantics).
		recordObservedHostShell(GIT_BASH);
		expect(
			resolveWindowsWriteAuthority(
				'shell',
				COPY_OUTSIDE,
				'cmd',
				false,
				'linux',
				getObservedHostShell(),
			),
		).toBe(null);
	});

	test('hostShellGrammarFamily classifies separator-independently (basename, .exe-stripped, lowercase)', () => {
		expect(
			hostShellGrammarFamily('C:\\Program Files\\PowerShell\\7\\pwsh.exe'),
		).toBe('windows');
		expect(hostShellGrammarFamily(CMD_EXE)).toBe('windows');
		expect(hostShellGrammarFamily('/bin/zsh')).toBe('posix');
		expect(
			hostShellGrammarFamily('C:\\Program Files\\Git\\usr\\bin\\bash.exe'),
		).toBe('posix');
	});
});
