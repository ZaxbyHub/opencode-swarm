/**
 * Two sandbox defects seen in a swarm session:
 *
 * 1. The wrapped command is what the host stores as the agent's own tool
 *    input, so the coder copied the `/usr/bin/bwrap ...` form into its next
 *    call; the plugin wrapped it again and the inner bwrap failed with
 *    "No permissions to create new namespace". Such a command is now refused
 *    with the remedy before it runs.
 * 2. Only the writable scope was bound inside the sandbox. The session
 *    workspace is now passed as a read-only root.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { _internals as guardrailsInternals } from '../../../src/hooks/guardrails';
import type { SandboxPolicyOptions } from '../../../src/sandbox/executor';
import { ensureAgentSession } from '../../../src/state';
import { installActiveScopeBinding } from '../../helpers/active-scope-binding';
import { createSafeTestDir } from '../../helpers/safe-test-dir';

const originalGetSandboxExecutor = guardrailsInternals.getSandboxExecutor;
const originalAssessSandboxEnforcement =
	guardrailsInternals.assessSandboxEnforcement;

const { createGuardrailsHooks } = await import('../../../src/hooks/guardrails');
const { resetSwarmState, swarmState } = await import('../../../src/state');

const SESSION = 'nested-wrap-session';
let directory: string;
let cleanup: () => void;

function config() {
	return {
		enabled: true,
		max_tool_calls: 200,
		max_duration_minutes: 30,
		idle_timeout_minutes: 60,
		max_repetitions: 10,
		max_consecutive_errors: 5,
		warning_threshold: 0.75,
		shell_audit_log: false,
		profiles: undefined,
	};
}

function stubExecutor(
	onWrap: (command: string, policy?: SandboxPolicyOptions) => string,
	available = true,
	mechanism = 'bubblewrap',
) {
	guardrailsInternals.getSandboxExecutor = async () => ({
		isAvailable: () => available,
		mechanism,
		wrapCommand: (
			command: string,
			_scope: string[],
			_tmp?: string,
			_env?: Record<string, string | null>,
			policy?: SandboxPolicyOptions,
		) => onWrap(command, policy),
		getEnvOverrides: () => ({}),
	});
}

describe('guardrails sandbox: nested wrapper refusal and read-only workspace', () => {
	beforeEach(() => {
		guardrailsInternals.assessSandboxEnforcement = async () =>
			({
				satisfied: true,
				capability: {
					identity: 'linux:bubblewrap:test',
					mechanism: 'bubblewrap',
				},
				cacheKey: 'linux:bubblewrap:test',
			}) as Awaited<ReturnType<typeof originalAssessSandboxEnforcement>>;
		resetSwarmState();
		const created = createSafeTestDir('sandbox-nested-');
		directory = created.dir;
		cleanup = created.cleanup;
		fs.mkdirSync(path.join(directory, '.swarm'), { recursive: true });
		fs.mkdirSync(path.join(directory, 'tests'), { recursive: true });
		ensureAgentSession(SESSION, 'coder', directory);
		swarmState.activeAgent.set(SESSION, 'coder');
		installActiveScopeBinding({
			directory,
			childSessionId: SESSION,
			taskId: '1.1',
			files: ['tests/'],
			parentSessionId: 'nested-wrap-parent',
			dispatchCallId: 'wrapper-1',
		});
	});
	afterEach(() => {
		guardrailsInternals.getSandboxExecutor = originalGetSandboxExecutor;
		guardrailsInternals.assessSandboxEnforcement =
			originalAssessSandboxEnforcement;
		resetSwarmState();
		cleanup();
	});

	it.each([
		"/usr/bin/bwrap --unshare-user --die-with-parent --bind '/ws' '/ws' -- bash -c 'ls'",
		'bwrap --ro-bind /usr /usr -- ls',
		'exec /usr/local/bin/bwrap --dev /dev -- ls',
		'env /bin/bwrap -- ls',
	])('refuses to wrap a command that already invokes bwrap: %s', async (command) => {
		let wrapped = 0;
		stubExecutor(() => {
			wrapped++;
			return 'wrapped-command';
		});
		const hooks = createGuardrailsHooks(directory, config());
		const args = { command };
		await expect(
			hooks.toolBefore(
				{ tool: 'bash', sessionID: SESSION, callID: 'nested-1' },
				{ args },
			),
		).rejects.toThrow(/already invokes bwrap.*Re-issue the plain command/);
		expect(wrapped).toBe(0);
		expect(args.command).toBe(command);
	});

	it.each([
		'ls tests',
		'echo bwrap',
		'cat bwrap.txt',
		'node bwrap-tool.js',
	])('still wraps an ordinary command: %s', async (command) => {
		stubExecutor(() => 'wrapped-command');
		const hooks = createGuardrailsHooks(directory, config());
		const args = { command };
		await hooks.toolBefore(
			{ tool: 'bash', sessionID: SESSION, callID: 'plain-1' },
			{ args },
		);
		expect(args.command).toBe('wrapped-command');
	});

	it('does not refuse a bwrap command when no sandbox executor would wrap it', async () => {
		stubExecutor(() => 'never', false);
		const hooks = createGuardrailsHooks(directory, config());
		const args = { command: 'bwrap --ro-bind /usr /usr -- ls' };
		await hooks.toolBefore(
			{ tool: 'bash', sessionID: SESSION, callID: 'unsandboxed-1' },
			{ args },
		);
		expect(args.command).toBe('bwrap --ro-bind /usr /usr -- ls');
	});

	it('does not refuse a bwrap command when the call would not be wrapped (no declared scope)', async () => {
		stubExecutor(() => 'never');
		ensureAgentSession('nested-noscope', 'reviewer', directory);
		swarmState.activeAgent.set('nested-noscope', 'reviewer');
		const hooks = createGuardrailsHooks(directory, config());
		const args = { command: 'bwrap --ro-bind /usr /usr -- ls' };
		await hooks.toolBefore(
			{ tool: 'bash', sessionID: 'nested-noscope', callID: 'noscope-1' },
			{ args },
		);
		expect(args.command).toBe('bwrap --ro-bind /usr /usr -- ls');
	});

	it('does not apply the bwrap refusal to a non-Bubblewrap executor', async () => {
		stubExecutor(() => 'wrapped-command', true, 'sandbox-exec');
		guardrailsInternals.assessSandboxEnforcement = async () =>
			({
				satisfied: true,
				capability: {
					identity: 'darwin:sandbox-exec:test',
					mechanism: 'sandbox-exec',
				},
				cacheKey: 'darwin:sandbox-exec:test',
			}) as Awaited<ReturnType<typeof originalAssessSandboxEnforcement>>;
		const hooks = createGuardrailsHooks(directory, config());
		const args = { command: 'bwrap --ro-bind /usr /usr -- ls' };
		await hooks.toolBefore(
			{ tool: 'bash', sessionID: SESSION, callID: 'mac-1' },
			{ args },
		);
		expect(args.command).toBe('wrapped-command');
	});

	it('passes the session workspace as the read-only root of the wrap', async () => {
		let seen: SandboxPolicyOptions | undefined;
		stubExecutor((_c, policy) => {
			seen = policy;
			return 'wrapped-command';
		});
		const hooks = createGuardrailsHooks(directory, config());
		const args = { command: 'node tests/t.js' };
		await hooks.toolBefore(
			{ tool: 'bash', sessionID: SESSION, callID: 'ro-root-1' },
			{ args },
		);
		expect(args.command).toBe('wrapped-command');
		expect(seen?.readonly_roots).toEqual([fs.realpathSync(directory)]);
		expect(seen?.network_mode).toBe('off');
	});
});
