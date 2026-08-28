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
import {
	createFullAutoPermissionHook,
	_internals as permissionInternals,
} from '../../../src/hooks/full-auto-permission';
import { hashArgs } from '../../../src/hooks/guardrails/file-authority';
import {
	_resetSandboxWrapOutcomeState,
	readSandboxWrapOutcome,
	recordSandboxWrapOutcome,
} from '../../../src/sandbox/skip-state';
import { _internals as stateInternals, swarmState } from '../../../src/state';

let tmpDir: string;
let origClient: typeof stateInternals.swarmState.opencodeClient;
let origAssessSandboxEnforcement: typeof permissionInternals.assessSandboxEnforcement;

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
	origAssessSandboxEnforcement = permissionInternals.assessSandboxEnforcement;
	stateInternals.swarmState.opencodeClient = null;
	swarmState.activeAgent.set('sess-1', 'architect');
	_resetSandboxWrapOutcomeState();
});

afterEach(() => {
	stateInternals.swarmState.opencodeClient = origClient;
	permissionInternals.assessSandboxEnforcement = origAssessSandboxEnforcement;
	swarmState.activeAgent.delete('sess-1');
	swarmState.agentSessions.delete('sess-1');
	_resetSandboxWrapOutcomeState();
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

	test('regression F1: the run state mode overrides config mode — on strict enforces strict policy', async () => {
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

	test('regression: first-class toggle — enforces a running run even when config has enabled: false', async () => {
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

	test('allows exact paused recovery full-auto swarm_command', async () => {
		startFullAutoRun(tmpDir, 'sess-1', { enabled: true });
		const hook = createFullAutoPermissionHook({
			config: makeConfig(),
			directory: tmpDir,
		});
		const { pauseFullAutoRun } = await import('../../../src/full-auto/state');
		pauseFullAutoRun(
			tmpDir,
			'sess-1',
			'oversight infrastructure failure after 1 attempt(s): server error',
		);
		await expect(
			hook.toolBefore(fakeInput('swarm_command'), {
				args: { command: 'full-auto', args: ['retry-oversight'] },
			}),
		).resolves.toBeUndefined();
	});

	test('denies arbitrary paused swarm_command arguments', async () => {
		startFullAutoRun(tmpDir, 'sess-1', { enabled: true });
		const hook = createFullAutoPermissionHook({
			config: makeConfig(),
			directory: tmpDir,
		});
		const { pauseFullAutoRun } = await import('../../../src/full-auto/state');
		pauseFullAutoRun(tmpDir, 'sess-1', 'manual');
		await expect(
			hook.toolBefore(fakeInput('swarm_command'), {
				args: { command: 'full-auto', args: ['retry-oversight', 'extra'] },
			}),
		).rejects.toThrow(/FULL_AUTO_PAUSED/);
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

	test('strict shell denies when guardrails did not record a sandbox wrap outcome', async () => {
		permissionInternals.assessSandboxEnforcement = async () =>
			({
				capability: { identity: 'cap-1' },
				requirements: {
					mode: 'advisory',
					require_filesystem: false,
					require_network: false,
					require_process: false,
				},
				satisfied: true,
				missing: [],
				cacheKey: 'cap-1',
			}) as never;
		startFullAutoRun(tmpDir, 'sess-1', { enabled: true, mode: 'strict' });
		const hook = createFullAutoPermissionHook({
			config: makeConfig(),
			directory: tmpDir,
		});

		await expect(
			hook.toolBefore(fakeInput('bash', 'shell-1'), {
				args: { command: 'echo hi' },
			}),
		).rejects.toThrow(/sandbox_unverified/);
	});

	test('strict shell consumes and clears a mismatched sandbox wrap outcome', async () => {
		permissionInternals.assessSandboxEnforcement = async () =>
			({
				capability: { identity: 'cap-1' },
				requirements: {
					mode: 'advisory',
					require_filesystem: false,
					require_network: false,
					require_process: false,
				},
				satisfied: true,
				missing: [],
				cacheKey: 'cap-1',
			}) as never;
		recordSandboxWrapOutcome({
			sessionID: 'sess-1',
			callID: 'shell-2',
			originalCommandHash: 1,
			finalCommandHash: 2,
			wrapped: false,
			capabilityIdentity: 'cap-1',
			reason: 'no declared scope',
			originalCommand: 'echo hi',
			executorMechanism: 'none',
			capabilityMechanism: 'none',
			assessmentCacheKey: 'cap-1',
		});
		startFullAutoRun(tmpDir, 'sess-1', { enabled: true, mode: 'strict' });
		const hook = createFullAutoPermissionHook({
			config: makeConfig(),
			directory: tmpDir,
		});

		await expect(
			hook.toolBefore(fakeInput('bash', 'shell-2'), {
				args: { command: 'echo hi' },
			}),
		).rejects.toThrow(/sandbox_unverified/);
		expect(readSandboxWrapOutcome('sess-1', 'shell-2')).toBeNull();
	});

	test('strict shell accepts one correctly bound outcome and rejects replay', async () => {
		permissionInternals.assessSandboxEnforcement = async () =>
			({
				capability: { identity: 'cap-1', mechanism: 'bubblewrap' },
				requirements: {
					mode: 'advisory',
					require_filesystem: false,
					require_network: false,
					require_process: false,
					network_mode: 'off',
					network_allowlist: [],
					writable_roots: [],
				},
				policy: {
					network_mode: 'off',
					network_allowlist: [],
					writable_roots: [],
				},
				satisfied: true,
				missing: [],
				supported: true,
				unsupported: [],
				cacheKey: 'assessment-1',
			}) as never;
		const originalCommand = 'echo hi';
		const wrappedCommand = "bwrap -- bash -c 'echo hi'";
		recordSandboxWrapOutcome({
			sessionID: 'sess-1',
			callID: 'shell-ok',
			originalCommandHash: hashArgs({ command: originalCommand }),
			finalCommandHash: hashArgs({ command: wrappedCommand }),
			wrapped: true,
			capabilityIdentity: 'cap-1',
			assessmentCacheKey: 'assessment-1',
			reason: 'wrapped',
			originalCommand,
			executorMechanism: 'bubblewrap',
			capabilityMechanism: 'bubblewrap',
		});
		startFullAutoRun(tmpDir, 'sess-1', { enabled: true, mode: 'strict' });
		const hook = createFullAutoPermissionHook({
			config: makeConfig(),
			directory: tmpDir,
		});
		await hook.toolBefore(fakeInput('bash', 'shell-ok'), {
			args: { command: wrappedCommand },
		});
		expect(readSandboxWrapOutcome('sess-1', 'shell-ok')).toBeNull();
		await expect(
			hook.toolBefore(fakeInput('bash', 'shell-ok'), {
				args: { command: wrappedCommand },
			}),
		).rejects.toThrow(/sandbox_unverified/);
	});

	test('regression FB-008: strict shell accepts one verified PowerShell wrapper outcome after mechanism canonicalization', async () => {
		permissionInternals.assessSandboxEnforcement = async () =>
			({
				capability: {
					identity: 'cap-ps',
					mechanism: 'PowerShell wrapper',
				},
				requirements: { mode: 'advisory' },
				policy: {},
				satisfied: true,
				missing: [],
				supported: true,
				unsupported: [],
				cacheKey: 'assessment-ps',
			}) as never;
		const originalCommand = 'echo hi';
		const wrappedCommand = 'powershell-wrapper --command "echo hi"';
		recordSandboxWrapOutcome({
			sessionID: 'sess-1',
			callID: 'shell-ps',
			originalCommandHash: hashArgs({ command: originalCommand }),
			finalCommandHash: hashArgs({ command: wrappedCommand }),
			wrapped: true,
			capabilityIdentity: 'cap-ps',
			assessmentCacheKey: 'assessment-ps',
			reason: 'wrapped',
			originalCommand,
			executorMechanism: 'powershell-wrapper',
			capabilityMechanism: 'PowerShell wrapper',
		});
		startFullAutoRun(tmpDir, 'sess-1', { enabled: true, mode: 'strict' });
		const hook = createFullAutoPermissionHook({
			config: makeConfig(),
			directory: tmpDir,
		});

		await expect(
			hook.toolBefore(fakeInput('bash', 'shell-ps'), {
				args: { command: wrappedCommand },
			}),
		).resolves.toBeUndefined();
	});

	test('strict shell rejects an independently mismatched original command hash', async () => {
		permissionInternals.assessSandboxEnforcement = async () =>
			({
				capability: { identity: 'cap-1', mechanism: 'bubblewrap' },
				requirements: { mode: 'advisory' },
				policy: {},
				satisfied: true,
				missing: [],
				supported: true,
				unsupported: [],
				cacheKey: 'assessment-1',
			}) as never;
		const wrappedCommand = "bwrap -- bash -c 'echo hi'";
		recordSandboxWrapOutcome({
			sessionID: 'sess-1',
			callID: 'shell-original-mismatch',
			originalCommandHash: 123,
			finalCommandHash: hashArgs({ command: wrappedCommand }),
			wrapped: true,
			capabilityIdentity: 'cap-1',
			assessmentCacheKey: 'assessment-1',
			reason: 'wrapped',
			originalCommand: 'echo hi',
			executorMechanism: 'bubblewrap',
			capabilityMechanism: 'bubblewrap',
		});
		startFullAutoRun(tmpDir, 'sess-1', { enabled: true, mode: 'strict' });
		const hook = createFullAutoPermissionHook({
			config: makeConfig(),
			directory: tmpDir,
		});
		await expect(
			hook.toolBefore(fakeInput('bash', 'shell-original-mismatch'), {
				args: { command: wrappedCommand },
			}),
		).rejects.toThrow(/sandbox_unverified/);
	});
});
