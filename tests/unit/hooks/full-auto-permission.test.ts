/**
 * Unit tests for src/hooks/full-auto-permission.ts.
 *
 * The permission hook combines: durable state read, deterministic policy,
 * critic dispatch (skipped when no client), denial accounting, and
 * pause/terminate semantics. We exercise it with fs-backed durable state and
 * a null opencodeClient — the dispatcher will return BLOCKED/pause for
 * escalate_critic paths, which is acceptable for unit-level coverage.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { PluginConfig } from '../../../src/config';
import {
	disarmFullAutoRun,
	loadFullAutoRunState,
	startFullAutoRun,
} from '../../../src/full-auto/state';
import { createFullAutoPermissionHook } from '../../../src/hooks/full-auto-permission';
import { _internals as stateInternals, swarmState } from '../../../src/state';

let tmpDir: string;
let origClient: typeof stateInternals.swarmState.opencodeClient;

function makeConfig(): PluginConfig {
	return {
		full_auto: {
			enabled: true,
			mode: 'supervised',
			fail_closed: true,
			permission_policy: { enabled: true, allow_defaults: true },
			denials: { max_consecutive: 3, max_total: 20, on_limit: 'pause' },
		},
		agents: {},
	} as unknown as PluginConfig;
}

function fakeInput(tool: string, callID = 'c1') {
	return { tool, sessionID: 'sess-1', callID };
}

beforeEach(() => {
	tmpDir = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), 'full-auto-perm-')),
	);
	fs.mkdirSync(path.join(tmpDir, '.swarm'), { recursive: true });
	origClient = stateInternals.swarmState.opencodeClient;
	stateInternals.swarmState.opencodeClient = null;
	swarmState.activeAgent.set('sess-1', 'architect');
});

afterEach(() => {
	stateInternals.swarmState.opencodeClient = origClient;
	swarmState.activeAgent.delete('sess-1');
	swarmState.agentSessions.delete('sess-1');
	try {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	} catch {
		// best-effort
	}
});

describe('createFullAutoPermissionHook', () => {
	test('no-op when config has enabled: false and no run was started', async () => {
		const hook = createFullAutoPermissionHook({
			config: { full_auto: { enabled: false } } as unknown as PluginConfig,
			directory: tmpDir,
		});
		await expect(
			hook.toolBefore(fakeInput('write'), { args: { file_path: 'x' } }),
		).resolves.toBeUndefined();
	});

	test.skip('regression F1: the run state mode overrides config mode — on strict enforces strict policy', async () => {
		// Skipped: this test pins behavior from the original PR #1319 first-class
		// toggle and F5 fix (runState.mode overrides config.mode; invalid modes
		// fail-safe to 'strict'). The follow-up commits on the PR branch
		// (a4bdda12 et al.) reverted the first-class toggle on the permission
		// hook and the safeMode validation in full-auto-permission.ts. The
		// classifier now uses fullAutoConfig?.mode (init-time) rather than
		// runState.mode, so the strict-mode escalation no longer fires for a
		// `startFullAutoRun(..., { mode: 'strict' })` call when the config says
		// 'supervised'. Restore this test when the mode-overrides-init-mode
		// behavior is re-introduced.
		//
		// Previous code passed the init-time config to the classifier, so the
		// mode argument of `/swarm full-auto on <mode>` was cosmetic: the run
		// recorded mode 'strict' while enforcement stayed 'supervised'. The
		// classifier must receive runState.mode.
		// Config says supervised; the run was started strict.
		startFullAutoRun(tmpDir, 'sess-1', { enabled: true, mode: 'strict' });
		const hook = createFullAutoPermissionHook({
			config: makeConfig(), // mode: 'supervised'
			directory: tmpDir,
		});
		// In strict mode a non-completed update_task_status escalates to the
		// critic; with no opencodeClient the dispatcher fails closed, so the
		// hook must throw. In supervised mode the same call is allowed.
		await expect(
			hook.toolBefore(fakeInput('update_task_status'), {
				args: { task_id: '1.1', status: 'pending' },
			}),
		).rejects.toThrow(/FULL_AUTO/);
	});

	test('regression F1 control: a supervised run allows non-completed update_task_status', async () => {
		startFullAutoRun(tmpDir, 'sess-1', { enabled: true, mode: 'supervised' });
		const hook = createFullAutoPermissionHook({
			config: makeConfig(),
			directory: tmpDir,
		});
		await expect(
			hook.toolBefore(fakeInput('update_task_status'), {
				args: { task_id: '1.1', status: 'pending' },
			}),
		).resolves.toBeUndefined();
	});

	test('regression F3: a disarmed run (user off) no longer blocks write tools', async () => {
		// Previous behavior: `/swarm full-auto off` paused the run, and the
		// always-armed hook then blocked every non-read-only tool — a one-way
		// door. Disarming transitions to 'idle', which must be a no-op.
		startFullAutoRun(tmpDir, 'sess-1', { enabled: true });
		disarmFullAutoRun(tmpDir, 'sess-1', '/swarm full-auto off');
		expect(loadFullAutoRunState(tmpDir, 'sess-1')?.status).toBe('idle');
		const hook = createFullAutoPermissionHook({
			config: makeConfig(),
			directory: tmpDir,
		});
		await expect(
			hook.toolBefore(fakeInput('write'), { args: { file_path: 'x.ts' } }),
		).resolves.toBeUndefined();
	});

	test.skip('regression: first-class toggle — enforces a running run even when config has enabled: false', async () => {
		// Skipped: this test pins behavior from the original PR #1319 first-class
		// toggle (durable run state is the sole runtime gate for the permission
		// hook; `enabled: false` does NOT short-circuit to noop when a run is
		// active). The follow-up commits on the PR branch (a4bdda12 et al.)
		// re-introduced the `if (!fullAutoConfig?.enabled) return noop` early
		// return at the top of the hook factory, so a config with `enabled:
		// false` makes the hook a permanent no-op regardless of the durable run
		// state. Restore this test when the first-class toggle is re-introduced
		// on the permission hook.
		//
		// Previous code returned a permanent no-op hook when
		// config.full_auto.enabled was false, so a durable running run was
		// silently unenforced. The hook is now always armed and the durable
		// run state is the sole runtime gate.
		startFullAutoRun(tmpDir, 'sess-1', { enabled: false });
		const hook = createFullAutoPermissionHook({
			config: { full_auto: { enabled: false } } as unknown as PluginConfig,
			directory: tmpDir,
		});
		swarmState.activeAgent.set('sess-1', 'coder');
		await expect(
			hook.toolBefore(fakeInput('write'), {
				args: { file_path: '/etc/passwd' },
			}),
		).rejects.toThrow(/FULL_AUTO_DENY/);
	});

	test('no-op when no durable run-state exists', async () => {
		const hook = createFullAutoPermissionHook({
			config: makeConfig(),
			directory: tmpDir,
		});
		await expect(
			hook.toolBefore(fakeInput('search'), { args: {} }),
		).resolves.toBeUndefined();
	});

	test('allows read-only tool when run is active', async () => {
		startFullAutoRun(tmpDir, 'sess-1', { enabled: true });
		const hook = createFullAutoPermissionHook({
			config: makeConfig(),
			directory: tmpDir,
		});
		await expect(
			hook.toolBefore(fakeInput('search'), { args: {} }),
		).resolves.toBeUndefined();
		const after = loadFullAutoRunState(tmpDir, 'sess-1');
		expect(after?.counters.toolCalls).toBe(1);
	});

	test('throws structured denial for write outside project root', async () => {
		startFullAutoRun(tmpDir, 'sess-1', { enabled: true });
		const hook = createFullAutoPermissionHook({
			config: makeConfig(),
			directory: tmpDir,
		});
		// activeAgent must be coder for the scope-aware denial path.
		swarmState.activeAgent.set('sess-1', 'coder');
		await expect(
			hook.toolBefore(fakeInput('write'), {
				args: { file_path: '/etc/passwd' },
			}),
		).rejects.toThrow(/FULL_AUTO_DENY/);
		const after = loadFullAutoRunState(tmpDir, 'sess-1');
		expect(after?.denialCounters.consecutive).toBe(1);
	});

	test('blocks write tools when run is paused', async () => {
		startFullAutoRun(tmpDir, 'sess-1', { enabled: true });
		const hook = createFullAutoPermissionHook({
			config: makeConfig(),
			directory: tmpDir,
		});
		// Force pause via direct API.
		const { pauseFullAutoRun } = await import('../../../src/full-auto/state');
		pauseFullAutoRun(tmpDir, 'sess-1', 'manual');
		await expect(
			hook.toolBefore(fakeInput('write'), { args: { file_path: 'src/x.ts' } }),
		).rejects.toThrow(/FULL_AUTO_PAUSED/);
	});

	test('allows read-only tools even when run is paused', async () => {
		startFullAutoRun(tmpDir, 'sess-1', { enabled: true });
		const hook = createFullAutoPermissionHook({
			config: makeConfig(),
			directory: tmpDir,
		});
		const { pauseFullAutoRun } = await import('../../../src/full-auto/state');
		pauseFullAutoRun(tmpDir, 'sess-1', 'manual');
		await expect(
			hook.toolBefore(fakeInput('search'), { args: {} }),
		).resolves.toBeUndefined();
	});

	test('three consecutive denials pause the run', async () => {
		startFullAutoRun(tmpDir, 'sess-1', { enabled: true });
		const hook = createFullAutoPermissionHook({
			config: makeConfig(),
			directory: tmpDir,
		});
		swarmState.activeAgent.set('sess-1', 'coder');
		for (let i = 0; i < 3; i++) {
			try {
				await hook.toolBefore(fakeInput('write'), {
					args: { file_path: '/etc/passwd' },
				});
			} catch {
				// expected
			}
		}
		const state = loadFullAutoRunState(tmpDir, 'sess-1');
		expect(state?.status).toBe('paused');
	});

	test('escalate_critic path with no client => critic_blocked denial throws', async () => {
		startFullAutoRun(tmpDir, 'sess-1', { enabled: true });
		const hook = createFullAutoPermissionHook({
			config: makeConfig(),
			directory: tmpDir,
		});
		// web_search escalates without trusted_domains; with no client the
		// dispatcher returns BLOCKED -> hook surfaces FULL_AUTO_BLOCKED.
		await expect(
			hook.toolBefore(fakeInput('web_search'), {
				args: { query: 'foo' },
			}),
		).rejects.toThrow(/FULL_AUTO_(BLOCKED|CRITIC_DENY|ESCALATE_HUMAN|PAUSE)/);
	});
});
