import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { _resetSandboxUnavailableWarningState } from '../../../src/hooks/guardrails/tool-before';
import { ensureAgentSession } from '../../../src/state';
import { installActiveScopeBinding } from '../../helpers/active-scope-binding';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const assessSandboxEnforcementMock = mock(async (requirements?: unknown) => ({
	capability: { identity: 'cap-1', mechanism: 'bubblewrap' },
	requirements: requirements ?? {
		mode: 'advisory',
		require_filesystem: false,
		require_network: false,
		require_process: false,
	},
	satisfied: true,
	missing: [],
	cacheKey: 'cap-1',
	supported: true,
	unsupported: [],
}));

const { createGuardrailsHooks, _internals: guardrailsInternals } = await import(
	'../../../src/hooks/guardrails'
);
const { resetSwarmState, swarmState } = await import('../../../src/state');
const originalGetSandboxExecutor = guardrailsInternals.getSandboxExecutor;
const originalAssessSandboxEnforcement =
	guardrailsInternals.assessSandboxEnforcement;

async function waitForFile(filePath: string, timeoutMs = 1_000): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if (fs.existsSync(filePath)) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

describe('guardrails sandbox advisory', () => {
	const originalDebug = process.env.OPENCODE_SWARM_DEBUG;
	beforeEach(() => {
		guardrailsInternals.assessSandboxEnforcement =
			assessSandboxEnforcementMock as unknown as typeof originalAssessSandboxEnforcement;
	});

	afterEach(() => {
		assessSandboxEnforcementMock.mockClear();
		assessSandboxEnforcementMock.mockImplementation(
			async (requirements?: unknown) => ({
				capability: { identity: 'cap-1', mechanism: 'bubblewrap' },
				requirements: requirements ?? {
					mode: 'advisory',
					require_filesystem: false,
					require_network: false,
					require_process: false,
				},
				satisfied: true,
				missing: [],
				cacheKey: 'cap-1',
				supported: true,
				unsupported: [],
			}),
		);
		if (originalDebug === undefined) {
			delete process.env.OPENCODE_SWARM_DEBUG;
		} else {
			process.env.OPENCODE_SWARM_DEBUG = originalDebug;
		}
		_resetSandboxUnavailableWarningState();
		resetSwarmState();
		guardrailsInternals.getSandboxExecutor = originalGetSandboxExecutor;
		guardrailsInternals.assessSandboxEnforcement =
			originalAssessSandboxEnforcement;
	});

	it('writes a sandbox skip audit entry when the executor is unavailable', async () => {
		const tempDir = canonicalMkdtemp('guardrails-sandbox-advisory-');

		process.env.OPENCODE_SWARM_DEBUG = '1';
		_resetSandboxUnavailableWarningState();
		guardrailsInternals.getSandboxExecutor = async () => ({
			isAvailable: () => false,
			mechanism: 'none',
		});

		try {
			const hooks = createGuardrailsHooks(tempDir, undefined, {
				enabled: true,
				max_tool_calls: 200,
				max_duration_minutes: 30,
				idle_timeout_minutes: 60,
				max_repetitions: 10,
				max_consecutive_errors: 5,
				warning_threshold: 0.75,
				shell_audit_log: true,
				profiles: undefined,
			});

			await hooks.toolBefore(
				{ tool: 'bash', sessionID: 'sandbox-session', callID: 'call-1' },
				{ args: { command: 'echo hi' } },
			);

			const auditPath = path.join(
				tempDir,
				'.swarm',
				'session',
				'shell-audit.jsonl',
			);
			await waitForFile(auditPath);
			expect(fs.existsSync(auditPath)).toBe(true);
			const contents = fs.readFileSync(auditPath, 'utf-8');
			expect(contents).toContain('"type":"sandbox_skip"');
			expect(contents).toContain('"skipReason":"executor not available"');
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it('default advisory mode preserves command bytes and warns only once when the executor is unavailable', async () => {
		const tempDir = canonicalMkdtemp('guardrails-sandbox-advisory-once-');
		process.env.OPENCODE_SWARM_DEBUG = '1';
		guardrailsInternals.getSandboxExecutor = async () => ({
			isAvailable: () => false,
			mechanism: 'none',
		});
		const warnSpy = mock(() => {});
		const originalConsoleWarn = console.warn;
		console.warn = warnSpy as typeof console.warn;

		try {
			const hooks = createGuardrailsHooks(tempDir, undefined, {
				enabled: true,
				max_tool_calls: 200,
				max_duration_minutes: 30,
				idle_timeout_minutes: 60,
				max_repetitions: 10,
				max_consecutive_errors: 5,
				warning_threshold: 0.75,
				shell_audit_log: true,
				profiles: undefined,
			});
			const first = { args: { command: 'echo hi && printf ok' } };
			const second = { args: { command: 'echo hi && printf ok' } };

			await hooks.toolBefore(
				{ tool: 'bash', sessionID: 'sandbox-once', callID: 'call-a' },
				first,
			);
			await hooks.toolBefore(
				{ tool: 'bash', sessionID: 'sandbox-once', callID: 'call-b' },
				second,
			);

			expect(first.args.command).toBe('echo hi && printf ok');
			expect(second.args.command).toBe('echo hi && printf ok');
			expect(warnSpy).toHaveBeenCalledTimes(1);
			expect(String(warnSpy.mock.calls[0]?.[0] ?? '')).toContain(
				'sandbox executor unavailable',
			);
		} finally {
			console.warn = originalConsoleWarn;
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it('required mode still records sandbox_skip before blocking on unavailable executor', async () => {
		const tempDir = canonicalMkdtemp('guardrails-sandbox-required-skip-');
		process.env.OPENCODE_SWARM_DEBUG = '1';
		guardrailsInternals.getSandboxExecutor = async () => ({
			isAvailable: () => false,
			mechanism: 'none',
		});

		try {
			const hooks = createGuardrailsHooks(tempDir, undefined, {
				enabled: true,
				max_tool_calls: 200,
				max_duration_minutes: 30,
				idle_timeout_minutes: 60,
				max_repetitions: 10,
				max_consecutive_errors: 5,
				warning_threshold: 0.75,
				shell_audit_log: true,
				profiles: undefined,
				sandbox: {
					mode: 'required',
					require_filesystem: true,
					require_network: false,
					require_process: false,
				},
			});

			await expect(
				hooks.toolBefore(
					{
						tool: 'bash',
						sessionID: 'sandbox-required-skip',
						callID: 'call-required',
					},
					{ args: { command: 'echo hi' } },
				),
			).rejects.toThrow(/Required sandbox policy unsatisfied/);

			const auditPath = path.join(
				tempDir,
				'.swarm',
				'session',
				'shell-audit.jsonl',
			);
			await waitForFile(auditPath);
			const contents = fs.readFileSync(auditPath, 'utf-8');
			expect(contents).toContain('"type":"sandbox_skip"');
			expect(contents).toContain('required sandbox executor unavailable');
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it('required mode passes only the exact configured dimensions to sandbox assessment', async () => {
		resetSwarmState();
		const tempDir = canonicalMkdtemp('guardrails-sandbox-required-');
		fs.mkdirSync(path.join(tempDir, '.swarm'), { recursive: true });
		fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
		ensureAgentSession('sandbox-required-session', 'coder', tempDir);
		swarmState.activeAgent.set('sandbox-required-session', 'coder');
		installActiveScopeBinding({
			directory: tempDir,
			childSessionId: 'sandbox-required-session',
			taskId: '1.1',
			files: ['src/'],
			parentSessionId: 'sandbox-parent',
			dispatchCallId: 'sandbox-required-call',
		});
		guardrailsInternals.getSandboxExecutor = async () => ({
			isAvailable: () => true,
			mechanism: 'bubblewrap',
			wrapCommand: () => 'wrapped-command',
			getEnvOverrides: () => ({}),
		});

		try {
			const hooks = createGuardrailsHooks(tempDir, undefined, {
				enabled: true,
				max_tool_calls: 200,
				max_duration_minutes: 30,
				idle_timeout_minutes: 60,
				max_repetitions: 10,
				max_consecutive_errors: 5,
				warning_threshold: 0.75,
				shell_audit_log: false,
				profiles: undefined,
				sandbox: {
					mode: 'required',
					require_filesystem: false,
					require_network: false,
					require_process: false,
					network_mode: 'off',
					network_allowlist: [],
					writable_roots: [],
				},
			});
			const output = { args: { command: 'echo hi' } };

			await hooks.toolBefore(
				{
					tool: 'bash',
					sessionID: 'sandbox-required-session',
					callID: 'sandbox-required-call',
				},
				output,
			);

			expect(output.args.command).toBe('wrapped-command');
			expect(assessSandboxEnforcementMock).toHaveBeenCalledWith({
				mode: 'required',
				require_filesystem: false,
				require_network: false,
				require_process: false,
				network_mode: 'off',
				network_allowlist: [],
				writable_roots: [],
			});
		} finally {
			resetSwarmState();
			try {
				fs.rmSync(tempDir, { recursive: true, force: true });
			} catch {}
		}
	});
});
