/**
 * Tests for the F6b macOS-only env override wiring at applySandboxExecution
 * (issue #2236) and the F6a item 3 config gate (guardrails.sandbox_macos_enabled)
 * that reaches src/sandbox/executor.ts's _createMacOSExecutor().
 *
 * F6b: getEnvOverrides() was declared on every SandboxExecutor implementation
 * but had ZERO production callers. applySandboxExecution
 * (src/hooks/guardrails/tool-before.ts) now calls executor.getEnvOverrides()
 * and passes it through wrapCommand's 4th parameter, but ONLY when
 * executor.mechanism === 'sandbox-exec' — Windows and Linux stay unwired in
 * this PR by explicit user decision (F6c).
 *
 * F6a item 3: the resolved GuardrailsConfig's sandbox_macos_enabled flag
 * must reach setMacOSSandboxPolicy() before the first getSandboxExecutor()
 * call, so _createMacOSExecutor() gates on it correctly.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { GuardrailsConfigSchema } from '../../../src/config/schema';
import { _internals as guardrailsInternals } from '../../../src/hooks/guardrails';
import {
	_getMacOSSandboxPolicyForTest,
	setMacOSSandboxPolicy,
} from '../../../src/sandbox/executor';
import { ensureAgentSession } from '../../../src/state';
import { installActiveScopeBinding } from '../../helpers/active-scope-binding';
import { createSafeTestDir } from '../../helpers/safe-test-dir';

const originalGetSandboxExecutor = guardrailsInternals.getSandboxExecutor;
const originalAssessSandboxEnforcement =
	guardrailsInternals.assessSandboxEnforcement;

const { createGuardrailsHooks } = await import('../../../src/hooks/guardrails');
const { resetSwarmState, swarmState } = await import('../../../src/state');

let directory: string;
let cleanup: () => void;

const baseGuardrailsConfig = {
	enabled: true,
	max_tool_calls: 200,
	max_duration_minutes: 30,
	idle_timeout_minutes: 60,
	max_repetitions: 10,
	max_consecutive_errors: 5,
	warning_threshold: 0.75,
	shell_audit_log: false,
	profiles: undefined,
} as const;

describe('applySandboxExecution — F6b macOS-only env override wiring (#2236)', () => {
	beforeEach(() => {
		resetSwarmState();
		const created = createSafeTestDir('sandbox-env-wiring-');
		directory = created.dir;
		cleanup = created.cleanup;
		fs.mkdirSync(path.join(directory, '.swarm'), { recursive: true });
		fs.mkdirSync(path.join(directory, 'src'), { recursive: true });
		ensureAgentSession('sandbox-env-session', 'coder', directory);
		swarmState.activeAgent.set('sandbox-env-session', 'coder');
		installActiveScopeBinding({
			directory,
			childSessionId: 'sandbox-env-session',
			taskId: '1.1',
			files: ['src/'],
			parentSessionId: 'sandbox-env-parent',
			dispatchCallId: 'env-wrap-1',
		});
	});

	afterEach(() => {
		guardrailsInternals.getSandboxExecutor = originalGetSandboxExecutor;
		guardrailsInternals.assessSandboxEnforcement =
			originalAssessSandboxEnforcement;
		resetSwarmState();
		cleanup();
	});

	it('passes getEnvOverrides() through to wrapCommand for mechanism "sandbox-exec"', async () => {
		let capturedEnvOverrides: unknown;
		const envOverrides = {
			DYLD_INSERT_LIBRARIES: null,
			PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
		};
		guardrailsInternals.getSandboxExecutor = async () => ({
			isAvailable: () => true,
			mechanism: 'sandbox-exec',
			wrapCommand: (
				_cmd: string,
				_paths: string[],
				_tempDir: string | undefined,
				env: unknown,
			) => {
				capturedEnvOverrides = env;
				return 'wrapped-command';
			},
			getEnvOverrides: () => envOverrides,
		});
		guardrailsInternals.assessSandboxEnforcement = async () => ({
			allowed: true,
			capability: {
				platform: 'darwin',
				mechanism: 'sandbox-exec',
				status: 'enabled',
				strength: 'strong',
				identity:
					'darwin:sandbox-exec:enabled:strong:fs=enforced:net=enforced:proc=enforced',
				dimensions: {
					filesystem: 'enforced',
					network: 'enforced',
					process: 'enforced',
				},
			},
			reasons: [],
			cacheKey: 'darwin:sandbox-exec:test',
		});

		const hooks = createGuardrailsHooks(directory, { ...baseGuardrailsConfig });
		const args = { command: 'echo hi' };

		await hooks.toolBefore(
			{ tool: 'bash', sessionID: 'sandbox-env-session', callID: 'env-wrap-1' },
			{ args },
		);

		expect(args.command).toBe('wrapped-command');
		expect(capturedEnvOverrides).toEqual(envOverrides);
	});

	it('does NOT call getEnvOverrides() for a non-sandbox-exec mechanism (Bubblewrap) — F6c: Linux/Windows stay unwired', async () => {
		let getEnvOverridesCalled = false;
		let capturedEnvOverrides: unknown = 'not-set';
		guardrailsInternals.getSandboxExecutor = async () => ({
			isAvailable: () => true,
			mechanism: 'Bubblewrap',
			wrapCommand: (
				_cmd: string,
				_paths: string[],
				_tempDir: string | undefined,
				env: unknown,
			) => {
				capturedEnvOverrides = env;
				return 'wrapped-command';
			},
			getEnvOverrides: () => {
				getEnvOverridesCalled = true;
				return {};
			},
		});
		guardrailsInternals.assessSandboxEnforcement = async () => ({
			allowed: true,
			capability: {
				platform: 'linux',
				mechanism: 'Bubblewrap',
				status: 'enabled',
				strength: 'strong',
				identity:
					'linux:bubblewrap:enabled:strong:fs=enforced:net=enforced:proc=enforced',
				dimensions: {
					filesystem: 'enforced',
					network: 'enforced',
					process: 'enforced',
				},
			},
			reasons: [],
			cacheKey: 'linux:bubblewrap:test',
		});

		const hooks = createGuardrailsHooks(directory, { ...baseGuardrailsConfig });
		const args = { command: 'echo hi' };

		await hooks.toolBefore(
			{ tool: 'bash', sessionID: 'sandbox-env-session', callID: 'env-wrap-1' },
			{ args },
		);

		expect(args.command).toBe('wrapped-command');
		expect(getEnvOverridesCalled).toBe(false);
		expect(capturedEnvOverrides).toBeUndefined();
	});
});

describe('F6a item 3 — sandbox_macos_enabled config gate reaches setMacOSSandboxPolicy (#2236)', () => {
	beforeEach(() => {
		resetSwarmState();
		const created = createSafeTestDir('sandbox-policy-wiring-');
		directory = created.dir;
		cleanup = created.cleanup;
		fs.mkdirSync(path.join(directory, '.swarm'), { recursive: true });
	});

	afterEach(() => {
		resetSwarmState();
		cleanup();
		// Restore to the documented default so this file cannot leak the
		// policy into later test files sharing this bun:test process.
		setMacOSSandboxPolicy(false);
	});

	it('createGuardrailsHooks with sandbox_macos_enabled: true sets the policy to true', () => {
		setMacOSSandboxPolicy(false); // known starting state
		createGuardrailsHooks(directory, {
			...baseGuardrailsConfig,
			sandbox_macos_enabled: true,
		});
		expect(_getMacOSSandboxPolicyForTest()).toBe(true);
	});

	it('createGuardrailsHooks with sandbox_macos_enabled: false sets the policy to false', () => {
		setMacOSSandboxPolicy(true); // known starting state, opposite of expected
		createGuardrailsHooks(directory, {
			...baseGuardrailsConfig,
			sandbox_macos_enabled: false,
		});
		expect(_getMacOSSandboxPolicyForTest()).toBe(false);
	});

	it('createGuardrailsHooks with sandbox_macos_enabled omitted defaults the policy to false', () => {
		setMacOSSandboxPolicy(true); // known starting state, opposite of expected
		createGuardrailsHooks(directory, { ...baseGuardrailsConfig });
		expect(_getMacOSSandboxPolicyForTest()).toBe(false);
	});

	// The schema half of the same guarantee. `sandbox_macos_enabled` is
	// `.optional()`, NOT `.default(false)`: parsing must not invent a key the
	// user never wrote (that regressed the exhaustive round-trip fixtures in
	// tests/unit/config/guardrails-profile-loop-containment.test.ts). This
	// asserts the absent-key shape AND that the absent key still lands as
	// "disabled" at the consumer, so re-adding a Zod default fails here.
	it('GuardrailsConfigSchema leaves sandbox_macos_enabled absent when unset, and absent still means disabled', () => {
		const parsed = GuardrailsConfigSchema.parse({ enabled: true });

		expect(parsed.sandbox_macos_enabled).toBeUndefined();
		expect(Object.hasOwn(parsed, 'sandbox_macos_enabled')).toBe(false);

		setMacOSSandboxPolicy(true); // known starting state, opposite of expected
		createGuardrailsHooks(directory, {
			...baseGuardrailsConfig,
			sandbox_macos_enabled: parsed.sandbox_macos_enabled,
		});
		expect(_getMacOSSandboxPolicyForTest()).toBe(false);
	});

	it('GuardrailsConfigSchema still round-trips an explicit sandbox_macos_enabled: true', () => {
		expect(
			GuardrailsConfigSchema.parse({ sandbox_macos_enabled: true })
				.sandbox_macos_enabled,
		).toBe(true);
	});
});
